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
fn unusual_health_arithmetic_and_raw_cells_survive_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
    store.connection().execute_batch("INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('c','custom','c','apiKey','{}',1,1); INSERT INTO credential_health VALUES('c','m','open',1.5,NULL,'unknown')").expect("seed");
    for (cell, number, score) in [
        ("1.5", 1.5, 0.4),
        ("-2", -2.0, -1.0),
        ("1e100", 1e100, 1e-100),
        ("'1x'", f64::NAN, f64::NAN),
    ] {
        store
            .connection()
            .execute_batch(&format!(
                "UPDATE credential_health SET consecutive_failures={cell}"
            ))
            .expect("edit");
        let h = omni_store::credentials::read_health(store.connection(), "c", "m")
            .expect("read")
            .expect("row");
        assert!(h.failure_number() == number || h.failure_number().is_nan() && number.is_nan());
        assert!(h.health_score() == score || h.health_score().is_nan() && score.is_nan());
        assert!(h.rate_limited_until.expect("present").is_nan());
    }
    omni_store::credentials::update_health(store.connection(), "c", "m", &|h| {
        let mut h = h.expect("row");
        h.increment_failures();
        h
    })
    .expect("write");
    let cells: (String, String) = store
        .connection()
        .query_row(
            "SELECT consecutive_failures,rate_limited_until FROM credential_health",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("raw");
    assert_eq!(cells, ("1x1".into(), "unknown".into()));
}

#[test]
fn unusual_health_never_blocks_other_snapshot_changes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
    store.connection().execute_batch("INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('c','custom','c','apiKey','{}',1,1); INSERT INTO credential_health VALUES('c','bad','closed',1.5,2.25,3.5); INSERT INTO credential_health VALUES('c','good','closed',0,NULL,NULL)").expect("seed");
    let key = omni_crypto::field::derive_key("key");
    let boot = store.snapshot_reads(&key).expect("boot");
    assert_eq!(boot.health.len(), 2);
    assert_eq!(boot.health[0].failure_number(), 1.5);
    assert_eq!(boot.health[0].rate_limited_until, Some(3.5));
    store.connection().execute_batch("UPDATE credential_health SET consecutive_failures='text' WHERE model='bad'; UPDATE credentials SET enabled=0 WHERE id='c'").expect("edit");
    let snapshot = store.snapshot_reads(&key).expect("refresh");
    assert_eq!(snapshot.health.len(), 2);
    assert!(snapshot.health[0].failure_number().is_nan());
    assert_eq!(snapshot.health[0].rate_limited_until, Some(3.5));
    assert!(!snapshot.credentials[0].enabled);
}
