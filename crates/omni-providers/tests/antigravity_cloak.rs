#[test]
fn cloak_matches_frozen_ts() {
    let out = std::process::Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_cloak-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).expect("rows");
    assert_eq!(rows.as_array().expect("array").len(), 132);
    for (i, row) in rows.as_array().expect("array").iter().enumerate() {
        let request = serde_json::from_value(row["request"].clone()).expect("request");
        let cloak = omni_providers::antigravity::cloak::ToolCloak::build(&request);
        assert_eq!(serde_json::json!(cloak.to_wire), row["toWire"], "row {i}");
        for lookup in row["lookups"].as_array().expect("lookups") {
            let name = lookup[0].as_str().expect("name");
            assert_eq!(
                cloak.name(name),
                lookup[1].as_str().expect("alias"),
                "row {i}"
            );
            assert_eq!(
                cloak.original(cloak.name(name)),
                lookup[2].as_str().expect("original"),
                "row {i}"
            );
        }
    }
}
