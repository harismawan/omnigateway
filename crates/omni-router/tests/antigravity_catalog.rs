use omni_router::{Providers, Snapshot, resolve_model};
use serde_json::Value;
use std::process::Command;

#[test]
fn antigravity_catalog_and_resolution_match_frozen() {
    let output = Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_catalog-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun reference");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Vec<Value> = serde_json::from_slice(&output.stdout).expect("reference rows");
    assert_eq!(rows.len(), 57);
    let providers = Providers::builtin();
    assert_eq!(
        providers
            .get("antigravity")
            .expect("descriptor")
            .catalog
            .len(),
        18
    );
    let snapshot = Snapshot::new(
        vec![],
        vec![],
        vec![],
        vec![],
        omni_store::settings::Settings::from_json(omni_store::settings::default_settings_json()),
        0.0,
    );
    for row in rows {
        let resolved = resolve_model(row["name"].as_str().expect("name"), &snapshot, &providers)
            .expect("resolve");
        let actual = serde_json::to_value(resolved.as_ref()).expect("model JSON");
        let expected = &row["expected"];
        assert_eq!(actual["id"], expected["id"]);
        assert_eq!(
            actual["targets"][0]["provider"],
            expected["targets"][0]["provider"]
        );
        for key in ["model", "capabilities"] {
            assert_eq!(
                actual["targets"][0][key], expected["targets"][0][key],
                "{} {key}",
                row["name"]
            );
        }
        for key in ["contextWindow", "maxOutputTokens"] {
            assert_eq!(
                actual["targets"][0][key].as_f64(),
                expected["targets"][0][key].as_f64()
            );
        }
        for key in [
            "input",
            "output",
            "cacheRead",
            "cacheWrite5m",
            "cacheWrite1h",
        ] {
            assert_eq!(
                actual["targets"][0]["costPerMTok"][key].as_f64(),
                expected["targets"][0]["costPerMTok"][key].as_f64()
            );
        }
    }
    for id in ["kimi", "kilo", "grok", "muse", "qoder", "custom"] {
        assert!(
            providers
                .get(id)
                .expect("deferred descriptor")
                .catalog
                .is_empty()
        );
    }
}
