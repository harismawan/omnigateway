#[test]
fn codec_matches_frozen_ts() {
    let output = std::process::Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_codec-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).expect("rows");
    let rows = rows.as_array().expect("array");
    assert_eq!(rows.len(), 108);
    for (i, row) in rows.iter().enumerate() {
        let request = serde_json::from_value(row["request"].clone()).expect("request");
        let mut credentials = omni_providers::codec::Credentials {
            access_token: row["token"].as_str().map(str::to_owned),
            api_key: None,
            provider_data: Default::default(),
        };
        if let Some(p) = row.get("project") {
            omni_ir::deep::insert(
                &mut credentials.provider_data,
                "projectId".into(),
                p.clone(),
            );
        }
        let input = omni_providers::codec::CodecInput {
            request: &request,
            model: "gemini-3.6-flash-high",
            credentials: &credentials,
            request_id: row["requestId"].as_str(),
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        };
        match omni_providers::antigravity::codec::AntigravityCodec.build_request(&input) {
            Ok(r) => {
                assert!(row.get("error").is_none(), "row {i}");
                assert_eq!(
                    serde_json::json!({"request":{"url":r.request.url,"method":r.request.method,"headers":r.request.headers,"body":r.request.body},"degradations":r.degradations,"cloakedTools":r.cloaked_tools}),
                    row["expected"],
                    "row {i}"
                );
                assert_eq!(r.decode_state.cloak.to_wire.len(), 1);
            }
            Err(e) => assert_eq!(
                serde_json::json!({"code":e.code.as_str(),"message":e.message}),
                row["error"],
                "row {i}"
            ),
        }
    }
    eprintln!("codec corpus: {} rows green", rows.len());
}
