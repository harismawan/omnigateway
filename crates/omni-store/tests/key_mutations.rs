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
