use omni_store::{
    SqliteStore,
    keys::{self, KeyEdit},
};

#[test]
fn mutation_is_visible_to_other_connection_and_auth_reader() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("db");
    let writer = SqliteStore::open(&path, 0).expect("writer");
    let reader = SqliteStore::open(&path, 0).expect("reader");
    let raw = "sk-omni-test-only";
    let hash = omni_crypto::apikey::hash(raw);
    writer.connection().execute("INSERT INTO api_keys (id,label,prefix,hash,limits,created_at) VALUES ('k','label','sk-omni-test',?,'{}',1)", [&hash]).expect("seed");
    let version = || {
        reader
            .connection()
            .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
            .expect("version")
    };
    let before = version();
    keys::edit(writer.connection(), "k", KeyEdit::Models(Some("[]"))).expect("models");
    assert_ne!(before, version());
    let key = keys::find_by_hash(reader.connection(), &hash)
        .expect("read")
        .expect("key");
    assert_eq!(key.model_allowlist, Some(vec![]));
    assert!(key.usable(100));
    let before = version();
    keys::edit(writer.connection(), "k", KeyEdit::Expiry(Some(100))).expect("expiry");
    assert_ne!(before, version());
    let key = keys::find_by_hash(reader.connection(), &hash)
        .expect("read")
        .expect("key");
    assert!(key.usable(99));
    assert!(!key.usable(100));
    keys::edit(writer.connection(), "k", KeyEdit::Expiry(None)).expect("never");
    assert!(
        keys::find_by_hash(reader.connection(), &hash)
            .expect("read")
            .expect("key")
            .usable(100)
    );
    keys::edit(writer.connection(), "k", KeyEdit::Revoke(100)).expect("revoke");
    let key = keys::find_by_hash(reader.connection(), &hash)
        .expect("read")
        .expect("key");
    assert!(!key.usable(100));
    assert_eq!(key.hash, hash);
}

#[test]
fn minted_secret_roundtrips_only_as_hash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteStore::open(dir.path().join("db"), 0).expect("store");
    let raw = omni_crypto::apikey::generate();
    let hash = omni_crypto::apikey::hash(&raw);
    let key = keys::ApiKey {
        id: "minted".into(),
        label: "mint".into(),
        prefix: omni_crypto::apikey::prefix(&raw),
        hash: hash.clone(),
        model_allowlist: None,
        limits: Some(Default::default()),
        body_logging_opt_out: true,
        created_at: 100,
        revoked_at: None,
        expires_at: Some(200),
        guardrail_policy: None,
        smart_routing: false,
    };
    keys::create(store.connection(), &key).expect("create");
    let found = keys::find_by_hash(store.connection(), &hash)
        .expect("lookup")
        .expect("key");
    assert!(found.usable(199));
    assert!(!found.usable(200));
    assert_eq!(found, key);
    assert_ne!(found.hash, raw);
    keys::edit(
        store.connection(),
        "minted",
        KeyEdit::Limits("{\"concurrency\":2}"),
    )
    .expect("limits");
    assert_eq!(
        keys::find_by_hash(store.connection(), &hash)
            .expect("lookup")
            .expect("key")
            .limits
            .expect("limits")
            .to_json()["concurrency"],
        2
    );
}
