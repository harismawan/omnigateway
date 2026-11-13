use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
#[test]
fn frozen_ts_codec_wire_bytes() {
    let run = std::process::Command::new("bun")
        .arg("tests/anthropic-codec-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("corpus");
    for row in rows.as_array().expect("rows") {
        let req = serde_json::from_value(row["request"].clone()).expect("IR");
        let credentials = Credentials {
            access_token: row["credentials"]["accessToken"]
                .as_str()
                .map(str::to_owned),
            api_key: row["credentials"]["apiKey"].as_str().map(str::to_owned),
            ..Default::default()
        };
        let result = omni_providers::anthropic::codec::AnthropicCodec
            .build_request(&CodecInput {
                request: &req,
                model: row["model"].as_str().expect("model"),
                credentials: &credentials,
                request_id: None,
                auto_cache_enabled: None,
                max_output_tokens: None,
                request_started_at: None,
            })
            .expect("codec");
        assert_eq!(
            result.request.body,
            row["wire"]["body"].as_str().expect("body")
        );
        assert_eq!(
            serde_json::json!(result.request.headers),
            row["wire"]["headers"]
        );
        assert_eq!(serde_json::json!(result.degradations), row["degradations"]);
        assert_eq!(serde_json::json!(result.cloaked_tools), row["cloakedTools"]);
    }
}
