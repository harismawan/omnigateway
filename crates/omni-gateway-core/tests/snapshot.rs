//! The gateway snapshot: built at boot, swapped atomically, rebuilt off the
//! request path when `PRAGMA data_version` moves.

use omni_gateway_core::snapshot::{AuthOutcome, SnapshotHolder};
use omni_store::{BreakerState, CredentialHealth, Secret, SqliteStore};
use rusqlite::{Connection, params};
use std::sync::Arc;
use std::time::Duration;

const ENC: &str = "snapshot-test-encryption-key";

const TARGETS: &str = r#"[{"provider":"custom","endpointId":"e","model":"up","tier":1,"weight":1,
  "costPerMTok":{"input":1,"output":2},"capabilities":{"tools":true,"images":true,"reasoning":true}}]"#;

fn seed(path: &std::path::Path) {
    let key = omni_crypto::field::derive_key(ENC);
    let c = Connection::open(path).expect("open");
    c.execute(
        "INSERT INTO credentials (id, provider, label, auth_type, enabled, tier, weight,
            provider_data, api_key, created_at, updated_at)
         VALUES ('c1','custom','up','apiKey',1,1,1,'{\"endpointId\":\"e\"}',?,0,0)",
        params![omni_crypto::field::encrypt(&key, "sk-upstream")],
    )
    .expect("credential");
    for (id, targets) in [("good", TARGETS), ("broken", "{not json")] {
        c.execute(
            "INSERT INTO virtual_models (id, targets) VALUES (?,?)",
            params![id, targets],
        )
        .expect("model");
    }
    key_row(&c, "k1", "sk-omni-one", None, r#"{"requests":{"1m":5}}"#);
}

fn key_row(c: &Connection, id: &str, raw: &str, revoked_at: Option<i64>, limits: &str) {
    c.execute(
        "INSERT INTO api_keys (id, label, prefix, hash, created_at, revoked_at, limits)
         VALUES (?,?,?,?,0,?,?)",
        params![
            id,
            id,
            omni_crypto::apikey::prefix(raw),
            omni_crypto::apikey::hash(raw),
            revoked_at,
            limits
        ],
    )
    .expect("key");
}

fn open() -> (tempfile::TempDir, std::path::PathBuf, SqliteStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = SqliteStore::open(&path, 0).expect("store");
    seed(&path);
    (dir, path, store)
}

#[test]
fn boot_builds_keys_by_hash_models_and_decrypted_secrets_and_drops_a_broken_model() {
    let (_dir, _path, store) = open();
    let holder =
        SnapshotHolder::build(&store, omni_crypto::field::derive_key(ENC), 1_000.0).expect("build");
    let snap = holder.load();

    assert_eq!(
        snap.routing.models.keys().cloned().collect::<Vec<_>>(),
        ["good"]
    );

    let cred = &snap.routing.credentials[0];
    assert_eq!(cred.secrets.api_key, Secret::Present("sk-upstream".into()));

    match snap.authenticate(Some("Bearer sk-omni-one"), 5) {
        AuthOutcome::Ok(k) => assert_eq!(k.id, "k1"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        snap.authenticate(Some("sk-omni-unknown"), 5),
        AuthOutcome::Miss
    ));
    assert!(matches!(
        snap.authenticate(None, 5),
        AuthOutcome::Refused(_)
    ));
    assert!(matches!(
        snap.authenticate(Some("   "), 5),
        AuthOutcome::Refused(_)
    ));
}

#[test]
fn a_revoked_key_and_unreadable_limits_are_refused_with_the_ts_errors() {
    let (_dir, path, store) = open();
    let c = Connection::open(&path).expect("open");
    key_row(&c, "rev", "sk-omni-revoked", Some(1), "{}");
    key_row(
        &c,
        "bad",
        "sk-omni-badlimits",
        None,
        r#"{"requests":{"9m":1}}"#,
    );
    let holder =
        SnapshotHolder::build(&store, omni_crypto::field::derive_key(ENC), 0.0).expect("build");
    let snap = holder.load();
    let err = |raw: &str| match snap.authenticate(Some(raw), 5) {
        AuthOutcome::Refused(e) => (e.code.as_str(), e.message),
        other => panic!("{other:?}"),
    };
    assert_eq!(err("sk-omni-revoked"), ("AUTH", "invalid API key".into()));
    assert_eq!(
        err("sk-omni-badlimits"),
        ("INTERNAL", "api key configuration is unusable".into())
    );
    assert_eq!(
        err(""),
        ("AUTH", "missing or malformed Authorization header".into())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_refresher_picks_up_another_connections_commit_within_a_poll() {
    let (_dir, path, store) = open();
    let holder = Arc::new(
        SnapshotHolder::build(&store, omni_crypto::field::derive_key(ENC), 0.0).expect("build"),
    );
    let refresher = holder
        .clone()
        .spawn_refresher(store, Duration::from_millis(50));
    let before = holder.load();
    assert!(matches!(
        before.authenticate(Some("sk-omni-two"), 0),
        AuthOutcome::Miss
    ));

    // Another process creates a key and fixes the broken model.
    let c = Connection::open(&path).expect("open");
    key_row(&c, "k2", "sk-omni-two", None, "{}");
    c.execute(
        "UPDATE virtual_models SET targets = ? WHERE id = 'broken'",
        params![TARGETS],
    )
    .expect("fix");

    let mut seen = false;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let now = holder.load();
        if matches!(now.authenticate(Some("sk-omni-two"), 0), AuthOutcome::Ok(_)) {
            assert!(now.routing.models.contains_key("broken"));
            seen = true;
            break;
        }
    }
    assert!(seen, "refresher never swapped in the new key");
    // The old snapshot a request already holds is untouched.
    assert!(matches!(
        before.authenticate(Some("sk-omni-two"), 0),
        AuthOutcome::Miss
    ));
    refresher.abort();
}

#[test]
fn a_health_patch_swaps_in_a_new_snapshot_without_a_store_read() {
    let (_dir, _path, store) = open();
    let holder =
        SnapshotHolder::build(&store, omni_crypto::field::derive_key(ENC), 0.0).expect("build");
    let before = holder.load();
    holder.patch_health(CredentialHealth {
        credential_id: "c1".into(),
        model: "up".into(),
        breaker_state: BreakerState::Open,
        consecutive_failures: 3,
        opened_at: Some(10.0),
        rate_limited_until: None,
    });
    let after = holder.load();
    assert!(before.routing.health_of("c1", "up").is_none());
    assert_eq!(
        after
            .routing
            .health_of("c1", "up")
            .map(|h| h.consecutive_failures),
        Some(3)
    );
}

#[test]
fn a_key_miss_falls_back_to_one_read_that_populates_the_snapshot() {
    let (_dir, path, store) = open();
    let holder =
        SnapshotHolder::build(&store, omni_crypto::field::derive_key(ENC), 0.0).expect("build");
    let c = Connection::open(&path).expect("open");
    key_row(&c, "k3", "sk-omni-three", None, "{}");
    let found = holder
        .lookup_miss(&store, &omni_crypto::apikey::hash("sk-omni-three"))
        .expect("read");
    assert_eq!(found.map(|k| k.id.clone()), Some("k3".to_owned()));
    assert!(matches!(
        holder.load().authenticate(Some("sk-omni-three"), 0),
        AuthOutcome::Ok(_)
    ));
}
