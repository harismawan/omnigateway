//! A Postgres database the frozen TS store wrote is read by Rust, and one the
//! Rust store wrote is read by TS: keys, encrypted credentials, health,
//! quota, models, settings, usage sums and rollups, body envelopes, and the
//! NULL / numeric / BIGINT edge values in between.

mod common;

use common::pg::{TestDb, base_url};
use omni_store::pg::bodies::DetailState;
use omni_store::pg::{PgConfig, PgStore};
use omni_store::{AuthType, Secret};
use serde_json::{Value, json};

const SECRET: &str = "pg-cross-read-secret";
const T0: i64 = 1_794_007_800_000;

fn artifact(id: &str, at: i64) -> Value {
    json!({
        "schemaVersion": 1, "requestId": id, "at": at,
        "client": { "request": { "prompt": "hi ✓" }, "response": { "text": "ok" }, "truncated": true },
        "attempts": [{ "attempt": 1, "provider": "anthropic", "request": {}, "response": null,
                       "streamChunks": ["data: 1"], "truncated": false }],
        "error": null
    })
}

/// A body whose bytes were tampered with reads as corrupt on both sides,
/// and the state is recorded; one whose bytes are gone reads as missing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tampered_and_missing_bodies_read_as_corrupt_and_missing() {
    let Some(base) = base_url("tampered_and_missing_bodies_read_as_corrupt_and_missing") else {
        return;
    };
    let db = TestDb::create(&base, "bodies_bad").await;
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let key = omni_crypto::field::derive_key(SECRET);
    for id in ["req_ok", "req_flip", "req_gone", "req_big"] {
        store
            .put_body(&key, id, T0, &artifact(id, T0).to_string(), false)
            .await
            .expect("put");
    }
    let c = db.client().await;
    c.batch_execute(
        "UPDATE request_bodies SET bytes = set_byte(bytes, 30, get_byte(bytes, 30) # 1)
          WHERE request_id = 'req_flip';
         UPDATE request_bodies SET bytes = NULL WHERE request_id = 'req_gone';
         UPDATE request_bodies SET bytes = decode(repeat('00', 1048641), 'hex')
          WHERE request_id = 'req_big';",
    )
    .await
    .expect("tamper");
    let state = |id: &'static str| {
        let store = store.clone();
        let key = key.clone();
        async move {
            store
                .get_body(&key, id)
                .await
                .expect("read")
                .expect("row")
                .row
                .detail_state
        }
    };
    assert_eq!(state("req_ok").await, DetailState::Ready);
    assert_eq!(state("req_flip").await, DetailState::Corrupt);
    assert_eq!(state("req_gone").await, DetailState::Missing);
    assert_eq!(state("req_big").await, DetailState::Corrupt);
    let stored: Vec<(String, String)> = c
        .query(
            "SELECT request_id, detail_state FROM request_bodies ORDER BY request_id",
            &[],
        )
        .await
        .expect("rows")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(
        stored,
        vec![
            ("req_big".into(), "corrupt".into()),
            ("req_flip".into(), "corrupt".into()),
            ("req_gone".into(), "missing".into()),
            ("req_ok".into(), "ready".into()),
        ]
    );
    // Restoring the bytes recovers the state.
    c.batch_execute("UPDATE request_bodies SET bytes = (SELECT bytes FROM request_bodies WHERE request_id = 'req_ok'), sha256 = (SELECT sha256 FROM request_bodies WHERE request_id = 'req_ok') WHERE request_id = 'req_gone'")
        .await
        .expect("restore");
    assert_eq!(state("req_gone").await, DetailState::Ready);
    assert!(store.get_body(&key, "nope").await.expect("read").is_none());
}

/// NULL, numeric and BIGINT edges as both readers see them: a hand-edited
/// row with an unreadable allowlist or targets, a key with NULL dates,
/// and the largest safe instant.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edge_rows_read_as_ts_reads_them() {
    let Some(base) = base_url("edge_rows_read_as_ts_reads_them") else {
        return;
    };
    let db = TestDb::create(&base, "edges").await;
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let c = db.client().await;
    c.batch_execute(
        "INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits, created_at, expires_at)
           VALUES ('a', 'a', 'p', 'ha', 'null', '{bad', 9007199254740991, NULL),
                  ('b', 'b', 'p', 'hb', '\"str\"', '{}', 1, 0);
         INSERT INTO virtual_models (id, targets) VALUES ('bad', 'not json'), ('ok', '[]');
         INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at, access_token)
           VALUES ('c', 'p', 'l', 'weird', 1, 1, 'enc:v1:00:00:00');
         INSERT INTO quota_windows (credential_id, window_type, starts_at)
           VALUES ('c', 'daily', -1);",
    )
    .await
    .expect("edges");
    let key = omni_crypto::field::derive_key(SECRET);
    let snap = store.snapshot_reads(&key).await.expect("snapshot");
    let a = snap
        .api_keys
        .iter()
        .flatten()
        .find(|k| k.id == "a")
        .expect("a");
    assert_eq!(a.created_at, 9_007_199_254_740_991);
    assert_eq!(a.model_allowlist, None, "JSON null is unrestricted");
    assert_eq!(a.limits, None, "unreadable limits mark the key");
    let b = snap
        .api_keys
        .iter()
        .flatten()
        .find(|k| k.id == "b")
        .expect("b");
    assert_eq!(b.model_allowlist, Some(vec![]), "a non-array denies all");
    assert!(!b.usable(1), "expires at 0");
    assert!(snap.models[0].is_err(), "bad targets fail only their row");
    assert!(snap.models[1].is_ok());
    assert_eq!(
        snap.credentials[0].auth_type,
        AuthType::Other("weird".into())
    );
    assert!(matches!(
        snap.credentials[0].secrets.access_token,
        Secret::Unreadable(_)
    ));
    assert_eq!(snap.quota[0].starts_at, -1.0);
    assert_eq!(snap.quota[0].used, 0.0);
    assert_eq!(snap.quota[0].limit, None);
    assert!(
        store
            .find_api_key_by_hash("ha")
            .await
            .expect("find")
            .is_some()
    );
    assert!(
        store
            .find_api_key_by_hash("zz")
            .await
            .expect("find")
            .is_none()
    );
}

/// Review A5 r1 (I2 on a live Postgres, minor 2): a key whose stored
/// allowlist `JSON.parse` refuses is that key's entry alone, carrying
/// `JSON.parse(stored)`'s own message: an empty column is `Unexpected EOF`,
/// not an empty request body's wording. Every other key still reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreadable_allowlist_is_isolated_with_json_parses_message() {
    let Some(base) = base_url("an_unreadable_allowlist_is_isolated_with_json_parses_message")
    else {
        return;
    };
    let db = TestDb::create(&base, "bad_allowlist").await;
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let c = db.client().await;
    c.batch_execute(
        "INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits, created_at)
           VALUES ('empty', 'e', 'p', 'h-empty', '', '{}', 3),
                  ('bad', 'b', 'p', 'h-bad', '{bad', '{}', 2),
                  ('good', 'g', 'p', 'h-good', '[\"m\"]', '{}', 1);",
    )
    .await
    .expect("rows");
    let key = omni_crypto::field::derive_key(SECRET);
    let snap = store.snapshot_reads(&key).await.expect("snapshot");
    let errors: Vec<(&str, &str, &str)> = snap
        .api_keys
        .iter()
        .filter_map(|e| e.as_ref().err())
        .map(|e| (e.id.as_str(), e.hash.as_str(), e.message.as_str()))
        .collect();
    assert_eq!(
        errors,
        [
            ("empty", "h-empty", "JSON Parse error: Unexpected EOF"),
            ("bad", "h-bad", "JSON Parse error: Expected '}'"),
        ]
    );
    let good: Vec<&str> = snap
        .api_keys
        .iter()
        .flatten()
        .map(|k| k.id.as_str())
        .collect();
    assert_eq!(good, ["good"], "the readable key is served beside them");
    assert!(
        store.list_api_keys().await.is_err(),
        "the admin listing still fails, as `keys.list()` throws"
    );
}
