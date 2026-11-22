//! Contract tests for per-row snapshot degradation: one malformed
//! virtual model does not take the others down, and quota windows are read.

mod common;

use omni_store::{QuotaWindow, SqliteStore, WindowType};
use rusqlite::params;

fn store() -> (tempfile::TempDir, SqliteStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteStore::open(dir.path().join("omni.db"), 0).expect("open");
    (dir, store)
}

const GOOD: &str = r#"[{"provider":"custom","endpointId":"e","model":"m","tier":1,"weight":1,
  "costPerMTok":{"input":1,"output":2},"capabilities":{"tools":true,"images":true,"reasoning":true}}]"#;

#[test]
fn one_malformed_model_row_is_reported_and_the_others_are_read() {
    let (_dir, store) = store();
    let conn = store.connection();
    for (id, targets) in [
        ("a-good", GOOD),
        ("b-not-json", "{nope"),
        ("c-wrong-shape", r#"[{"provider":1}]"#),
        ("d-good", GOOD),
    ] {
        conn.execute(
            "INSERT INTO virtual_models (id, targets, strategy, is_alias) VALUES (?,?,?,0)",
            params![id, targets, "score"],
        )
        .expect("insert");
    }
    let key = omni_crypto::field::derive_key("snapshot-rows-test-key-0123");
    let snap = store
        .snapshot_reads(&key)
        .expect("snapshot survives bad rows");

    let ok: Vec<&str> = snap
        .models
        .iter()
        .filter_map(|m| m.as_ref().ok())
        .map(|m| m.id.as_str())
        .collect();
    assert_eq!(ok, ["a-good", "d-good"]);
    let bad: Vec<&str> = snap
        .models
        .iter()
        .filter_map(|m| m.as_ref().err())
        .map(|e| e.id.as_str())
        .collect();
    assert_eq!(bad, ["b-not-json", "c-wrong-shape"]);
    let reason = &snap.models[1].as_ref().expect_err("bad").reason;
    assert_eq!(
        reason,
        "unreadable row: virtual_models.targets of b-not-json: not valid JSON"
    );
}

#[test]
fn an_explicit_null_endpoint_id_is_kept_apart_from_an_absent_one() {
    let (_dir, store) = store();
    let with_null = GOOD.replace(r#""endpointId":"e""#, r#""endpointId":null"#);
    let absent = GOOD.replace(r#""endpointId":"e","#, "");
    for (id, targets) in [("null", with_null.as_str()), ("absent", absent.as_str())] {
        store
            .connection()
            .execute(
                "INSERT INTO virtual_models (id, targets) VALUES (?,?)",
                params![id, targets],
            )
            .expect("insert");
    }
    let models = store.list_models().expect("list");
    let target = |i: usize| models[i].as_ref().expect("readable").targets[0].clone();
    // Ordered by id: "absent" then "null".
    assert_eq!(target(0).endpoint_id, None);
    assert_eq!(target(1).endpoint_id, Some(serde_json::Value::Null));
    let json = serde_json::to_value(target(1)).expect("json");
    assert_eq!(json["endpointId"], serde_json::Value::Null);
}

#[test]
fn quota_windows_are_read_into_the_snapshot() {
    let (_dir, store) = store();
    let conn = store.connection();
    conn.execute(
        "INSERT INTO credentials (id, provider, label, auth_type, enabled, tier, weight,
            provider_data, created_at, updated_at)
         VALUES ('c1','anthropic','c1','oauth',1,1,1,'{}',0,0)",
        [],
    )
    .expect("credential");
    conn.execute(
        "INSERT INTO quota_windows (credential_id, window_type, starts_at, used, limit_value,
            resets_at, observed_at, window_ms) VALUES ('c1','fiveHour',10,40,100,2000,1500,10800000)",
        [],
    )
    .expect("quota 1");
    conn.execute(
        "INSERT INTO quota_windows (credential_id, window_type, starts_at, used)
         VALUES ('c1','weekly',20,7)",
        [],
    )
    .expect("quota 2");
    let key = omni_crypto::field::derive_key("snapshot-rows-test-key-0123");
    let mut quota = store.snapshot_reads(&key).expect("snapshot").quota;
    quota.sort_by(|a, b| a.starts_at.total_cmp(&b.starts_at));
    assert_eq!(
        quota,
        vec![
            QuotaWindow {
                text_spent: Some(false),
                credential_id: "c1".into(),
                window_type: WindowType::FiveHour,
                starts_at: 10.0,
                used: 40.0,
                limit: Some(100.0),
                resets_at: Some(2000.0),
                observed_at: 1500.0,
                window_ms: Some(10_800_000.0),
            },
            QuotaWindow {
                text_spent: Some(false),
                credential_id: "c1".into(),
                window_type: WindowType::Weekly,
                starts_at: 20.0,
                used: 7.0,
                limit: None,
                resets_at: None,
                observed_at: 0.0,
                window_ms: None,
            },
        ]
    );
}
