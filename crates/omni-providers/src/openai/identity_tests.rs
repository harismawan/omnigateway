#![allow(clippy::unwrap_used)]
use super::identity::*;
use omni_crypto::codex;
use serde_json::json;

#[test]
fn secrets_generate_and_preserve() {
    let a = ensure_secrets(&serde_json::Value::Null);
    let b = ensure_secrets(&serde_json::Value::Null);
    let uuid = a.installation_id.as_deref().unwrap();
    assert!(is_uuid(uuid));
    assert_eq!(uuid.as_bytes()[14], b'4');
    assert!(b"89ab".contains(&uuid.as_bytes()[19]));
    assert_eq!(a.id_salt.as_deref().unwrap().len(), 64);
    assert_ne!(a.installation_id, b.installation_id);
    assert_ne!(a.id_salt, b.id_salt);
    let data = serde_json::to_value(a).unwrap();
    let kept = ensure_with(
        &data,
        || panic!("UUID reminted"),
        || panic!("salt reminted"),
    );
    assert_eq!(serde_json::to_value(kept).unwrap(), data);
}

#[test]
fn identity_matches_frozen_ts() {
    let output = std::process::Command::new("bun")
        .arg("tests/openai-identity-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    for (i, row) in rows["secrets"].as_array().unwrap().iter().enumerate() {
        let stored = secrets_from(&row["data"]);
        assert_eq!(
            serde_json::to_value(&stored).unwrap(),
            row["read"],
            "read {i}"
        );
        let ensured = ensure_with(
            &row["data"],
            || "01234567-89ab-4cde-8fab-0123456789ab".into(),
            || "07".repeat(32),
        );
        assert_eq!(
            serde_json::to_value(ensured).unwrap(),
            row["ensured"],
            "backfill {i}"
        );
    }
    for (i, row) in rows["hashes"].as_array().unwrap().iter().enumerate() {
        let seed = row["seed"].as_str().unwrap();
        let ts = row["timestamp"].as_f64().unwrap();
        let salt = row["salt"].as_str();
        let got = json!({"seed": seed, "timestamp": ts, "keyed": codex::keyed(salt, seed),
            "v4": codex::uuid_v4_from(seed), "v7": codex::uuid_v7_from(seed, ts),
            "thread": codex::thread_id_from(seed), "prefix": codex::prefix_namespace(seed),
            "instant": codex::thread_instant(seed, ts), "valid": is_uuid(seed)});
        assert_eq!(
            got["instant"].as_f64(),
            row["instant"].as_f64(),
            "instant {i}"
        );
        for key in ["keyed", "v4", "v7", "thread", "prefix", "valid"] {
            assert_eq!(got[key], row[key], "hash {i} {key}");
        }
    }
}
