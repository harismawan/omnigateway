#[test]
fn token_fields_match_frozen_ts_without_utf16_loss() {
    let run = std::process::Command::new("bun")
        .arg("tests/anthropic-token-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("rows");
    for row in rows.as_array().expect("array") {
        let result = omni_providers::anthropic::oauth::token_result(
            200,
            row["body"].as_str().expect("body"),
            Some("old"),
            1000.0,
        )
        .expect("tokens");
        assert_eq!(serde_json::json!(result.access_token), row["access"]);
        for (field, expected) in [
            (&result.refresh_token, &row["refresh"]),
            (&result.account_email, &row["email"]),
        ] {
            assert_eq!(
                omni_ir::jsjson::stringify(
                    field.as_ref().unwrap_or(&omni_ir::jsjson::JsValue::Null)
                )
                .expect("json"),
                expected.as_str().expect("json string")
            );
        }
    }
}
