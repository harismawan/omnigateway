#[test]
fn content_block_bytes_match_frozen_ts() {
    let run = std::process::Command::new("bun")
        .arg("tests/anthropic-block-reference.ts")
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
        let block = serde_json::from_value(row["block"].clone()).expect("IR");
        let actual = omni_providers::anthropic::wire::encode_block(&block, &Default::default())
            .expect("encode");
        assert_eq!(
            omni_ir::jsjson::to_string(&actual),
            omni_ir::jsjson::to_string(&row["wire"])
        );
    }
    let foreign=serde_json::from_value(serde_json::json!({"type":"providerNative","provider":"foreign","blockType":"document","data":{"secret":"hidden"}})).expect("IR");
    let err = omni_providers::anthropic::wire::encode_block(&foreign, &Default::default())
        .expect_err("foreign");
    assert_eq!(err.code, omni_ir::error::ErrorCode::Internal);
    assert!(!err.message.contains("hidden"));
}
