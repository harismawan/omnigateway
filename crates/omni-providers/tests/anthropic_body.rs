use omni_providers::anthropic::{body::apply_system, cloak::ToolCloak};
#[test]
fn body_and_cloak_match_real_ts_bytes() {
    let run = std::process::Command::new("bun")
        .arg("tests/anthropic-body-reference.ts")
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
        let request = serde_json::from_value(row["request"].clone()).expect("IR");
        let cloak = ToolCloak::build(&request);
        assert_eq!(
            serde_json::to_value(&cloak.to_wire).expect("cloak"),
            row["cloak"]
        );
        let system = apply_system(
            row["system"].as_array().expect("system"),
            row["text"].as_str().expect("text"),
        );
        assert_eq!(serde_json::Value::Array(system.clone()), row["applied"]);
        let body = omni_ir::jsjson::to_string(
            &serde_json::json!({"messages":[{"text":"cch=00000;"}],"system":system}),
        );
        assert_eq!(
            omni_crypto::cch::sign_anthropic_body(&body),
            row["body"].as_str().expect("body")
        );
    }
}
