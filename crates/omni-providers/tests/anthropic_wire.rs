#[test]
fn request_assembly_matches_real_ts() {
    let run = std::process::Command::new("bun")
        .arg("tests/anthropic-wire-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("corpus");
    for (i, row) in rows.as_array().expect("rows").iter().enumerate() {
        let req = serde_json::from_value(row["request"].clone()).expect("IR");
        let oauth = row["oauth"].as_bool().expect("oauth");
        let cloak = if oauth {
            omni_providers::anthropic::cloak::ToolCloak::build(&req)
        } else {
            Default::default()
        };
        let (body, notes) = omni_providers::anthropic::wire::to_wire(
            &req,
            row["model"].as_str().expect("model"),
            oauth,
            &cloak,
            Some(100000.0),
        )
        .expect("wire");
        assert_eq!(
            omni_ir::jsjson::to_string(&body),
            row["body"].as_str().expect("body"),
            "case {i}"
        );
        assert_eq!(serde_json::json!(notes), row["degradations"], "notes {i}");
    }
}
