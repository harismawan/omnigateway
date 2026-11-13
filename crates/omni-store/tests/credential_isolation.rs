#[test]
fn malformed_metadata_does_not_freeze_other_credentials() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
    store.connection().execute_batch("INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('bad','custom','bad','apiKey','{',1,1),('good','custom','good','apiKey','{}',1,1)").expect("seed");
    let key = omni_crypto::field::derive_key("test-key");
    assert!(omni_store::credentials::list(store.connection(), &key).is_err());
    let snapshot = store.snapshot_reads(&key).expect("snapshot");
    assert_eq!(snapshot.credentials.len(), 1);
    assert_eq!(snapshot.credentials[0].id, "good");
    store
        .connection()
        .execute("UPDATE credentials SET enabled=0 WHERE id='good'", [])
        .expect("disable");
    assert!(!store.snapshot_reads(&key).expect("refresh").credentials[0].enabled);
}

#[test]
fn unusual_health_never_blocks_other_snapshot_changes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
    store.connection().execute_batch("INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('c','custom','c','apiKey','{}',1,1); INSERT INTO credential_health VALUES('c','bad','closed',1.5,2.25,3.5); INSERT INTO credential_health VALUES('c','good','closed',0,NULL,NULL)").expect("seed");
    let key = omni_crypto::field::derive_key("key");
    assert_eq!(store.snapshot_reads(&key).expect("boot").health.len(), 1);
    store.connection().execute_batch("UPDATE credential_health SET consecutive_failures='text' WHERE model='bad'; UPDATE credentials SET enabled=0 WHERE id='c'").expect("edit");
    let snapshot = store.snapshot_reads(&key).expect("refresh");
    assert_eq!(snapshot.health.len(), 1);
    assert_eq!(snapshot.health[0].model, "good");
    assert!(!snapshot.credentials[0].enabled);
}
