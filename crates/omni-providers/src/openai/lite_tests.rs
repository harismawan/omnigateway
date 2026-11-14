#![allow(clippy::unwrap_used)]
use super::lite::{LiteArgs, to_lite};
#[test]
fn lite_matches_frozen_ts() {
    let output = std::process::Command::new("bun")
        .arg("tests/openai-lite-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 24);
    for (i, row) in rows.as_array().unwrap().iter().enumerate() {
        let args: LiteArgs = serde_json::from_value(row["args"].clone()).unwrap();
        let turns: Vec<Option<usize>> = serde_json::from_value(row["turns"].clone()).unwrap();
        let tools: Vec<Vec<usize>> = serde_json::from_value(row["toolIndices"].clone()).unwrap();
        let result = to_lite(&args, &turns, &tools);
        let expected = omni_ir::jsjson::to_string(&row["result"]);
        assert_eq!(
            omni_ir::jsjson::to_string(&result.0),
            expected,
            "lite row {i}"
        );
    }
}
