//! The snapshot reads degrade per row where TS keeps serving: one malformed
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

/// A fractional health instant round-trips: Rust writes it as REAL (as
/// bun:sqlite binds a non-integral number), reads it back unchanged, and the
/// TS store reads the same row as the same numbers.
#[tokio::test(flavor = "multi_thread")]
async fn a_fractional_health_instant_round_trips_through_rust_and_ts() {
    use omni_store::writer::{BreakerTransition, HealthMeasurement, Writer, WriterConfig};
    use omni_store::{BreakerState, CredentialHealth};
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = SqliteStore::open(&path, 0).expect("open");
    store
        .connection()
        .execute(
            "INSERT INTO credentials (id, provider, label, auth_type, enabled, tier, weight,
                provider_data, created_at, updated_at)
             VALUES ('c1','custom','c1','apiKey',1,1,1,'{}',0,0)",
            [],
        )
        .expect("credential");
    let writer = Writer::spawn(&path, WriterConfig::default()).expect("writer");
    let h = writer.handle();
    h.send(BreakerTransition(CredentialHealth {
        scalar: None,
        credential_id: "c1".into(),
        model: "m1".into(),
        breaker_state: BreakerState::Open,
        consecutive_failures: 3,
        opened_at: Some(1000.0),
        rate_limited_until: Some(1000.4),
    }));
    h.send(HealthMeasurement {
        credential_id: "c1".into(),
        model: "m2".into(),
        consecutive_failures: 1,
        rate_limited_until: Some(2500.75),
    });
    writer.close().await.expect("close");

    let types: Vec<(String, String, String)> = store
        .connection()
        .prepare("SELECT model, typeof(opened_at), typeof(rate_limited_until) FROM credential_health ORDER BY model")
        .expect("prep")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("q")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(
        types,
        [
            ("m1".into(), "integer".into(), "real".into()),
            ("m2".into(), "null".into(), "real".into())
        ]
    );
    let mut rust = store.list_health().expect("health");
    rust.sort_by(|a, b| a.model.cmp(&b.model));
    assert_eq!(rust[0].rate_limited_until, Some(1000.4));
    assert_eq!(rust[1].rate_limited_until, Some(2500.75));

    if !common::bun_available("a_fractional_health_instant_round_trips_through_rust_and_ts") {
        return;
    }
    let script = format!(
        r#"
import {{ createStore }} from "{root}/packages/store/src/index.ts";
import {{ deriveKey }} from "{root}/packages/store/src/encryption.ts";
const store = await createStore({{ path: process.argv[2], encryptionKey: await deriveKey("health-rt-key-0123456"), dayOffsetMinutes: 0 }});
const rows = (await store.credentials.listHealth()).sort((a, b) => a.model.localeCompare(b.model));
store.close();
console.log(JSON.stringify(rows));
"#,
        root = common::repo_root().display()
    );
    let file = dir.path().join("health.ts");
    std::fs::write(&file, script).expect("script");
    let out = std::process::Command::new("bun")
        .arg(&file)
        .arg(&path)
        .output()
        .expect("bun");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ts: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    let rust_json = serde_json::to_value(&rust).expect("rust json");
    assert_eq!(
        omni_ir::jsjson::to_string(&rust_json),
        omni_ir::jsjson::to_string(&ts)
    );
}
