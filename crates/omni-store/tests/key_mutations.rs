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

/// A5: the `/api` surface stores what `JSON.stringify` writes for a client's
/// JS strings, lone surrogate escapes included. `JSON.parse` reads them, so a
/// key, a model and the settings row carrying one stay readable: the key is
/// admitted (not marked unreadable), the model is routable, the settings
/// keep their other fields.
#[test]
fn lone_surrogate_escapes_in_stored_json_read_as_js_does() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("db");
    let store = omni_store::SqliteStore::open(&path, 0).expect("store");
    let c = store.connection();
    c.execute(
        r#"INSERT INTO api_keys(id,label,prefix,hash,created_at,limits,model_allowlist) VALUES('k','k','p','h',1,'{"models":{"\ud800":{"concurrency":1}}}','["\ud800","b"]')"#,
        [],
    )
    .expect("key");
    c.execute(
        r#"INSERT INTO virtual_models VALUES('m','[{"provider":"anthropic","model":"\udc00x","tier":1,"weight":1,"costPerMTok":{"input":0,"output":0},"capabilities":{"tools":true,"images":false,"reasoning":false}}]','score',0)"#,
        [],
    )
    .expect("model");
    c.execute(
        r#"INSERT INTO settings(key,value) VALUES('settings','{"maxAttempts":7,"x":"\ud800"}')"#,
        [],
    )
    .expect("settings");
    let key = keys::find_by_hash(c, "h").expect("read").expect("key");
    assert!(key.limits.is_some(), "limits read, not unreadable");
    assert_eq!(
        key.model_allowlist.as_deref(),
        Some(&["\u{fffd}".to_owned(), "b".to_owned()][..])
    );
    let models = omni_store::models::list(c).expect("models");
    assert!(models[0].is_ok(), "{models:?}");
    assert_eq!(
        omni_store::settings::get(c).expect("settings").json["maxAttempts"],
        7
    );
}
