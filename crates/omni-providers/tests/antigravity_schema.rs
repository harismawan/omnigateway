#[test]
fn schema_matches_frozen_wire() {
    let output = std::process::Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_schema-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).expect("rows");
    assert_eq!(rows.as_array().expect("array").len(), 582);
    for (i, row) in rows.as_array().expect("array").iter().enumerate() {
        let (schema, notes) = omni_providers::antigravity::schema::prune(&row["schema"]);
        let body = serde_json::json!({"name":"tool","parameters":schema});
        assert_eq!(
            omni_ir::jsjson::to_string(&body),
            row["expected"].as_str().expect("expected"),
            "row {i}"
        );
        assert_eq!(serde_json::json!(notes), row["notes"], "row {i}");
    }
}

#[test]
fn schema_depth_matches_frozen_on_small_stack() {
    let output = std::process::Command::new("bun")
        .args([
            "--no-env-file",
            "tests/antigravity_schema-reference.ts",
            "--depth",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: serde_json::Value = serde_json::from_slice(&output.stdout).expect("oracle");
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            let mut node = serde_json::json!({"type":"string"});
            for _ in 0..40_000 {
                let mut map = serde_json::Map::new();
                omni_ir::deep::insert(&mut map, "items".into(), node);
                node = serde_json::Value::Object(map);
            }
            let (schema, notes) = omni_providers::antigravity::schema::prune(&node);
            assert_eq!(schema, expected["schema"]);
            assert_eq!(serde_json::json!(notes), expected["notes"]);
            omni_ir::deep::drop(node);
        })
        .expect("spawn")
        .join()
        .expect("thread");
}
