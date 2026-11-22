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

#[test]
fn unusual_quota_keeps_publication_and_js_comparisons() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
    store.connection().execute_batch("INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('c','custom','c','apiKey','{}',1,1); INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at) VALUES('c','preboot',0,'unknown',100,4102444800000,0)").expect("seed");
    let key = omni_crypto::field::derive_key("key");
    let boot = store.snapshot_reads(&key).expect("boot");
    assert!(!boot.quota[0].spent());
    store.connection().execute_batch("INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at) VALUES('c','live',0,'z','a',4102444800000,0); UPDATE credentials SET enabled=0 WHERE id='c'").expect("edit");
    let live = store.snapshot_reads(&key).expect("refresh");
    assert!(!live.credentials[0].enabled);
    assert!(live.quota.iter().any(|w| w.spent()));
}

#[test]
fn unaddressable_model_ids_do_not_abort_snapshot_publication() {
    let store = omni_store::SqliteStore::open(":memory:", 0).expect("store");
    store.connection().execute_batch("INSERT INTO virtual_models VALUES(NULL,'[]','score',1),(x'61','[]','score',1),('good','[]','score',1)").expect("seed");
    let key = omni_crypto::field::derive_key("key");
    let snapshot = store.snapshot_reads(&key).expect("boot");
    assert_eq!(snapshot.models.len(), 1);
    assert_eq!(snapshot.models[0].as_ref().expect("model").id, "good");
    store
        .connection()
        .execute_batch("INSERT INTO virtual_models VALUES('live','[]','score',1)")
        .expect("edit");
    assert_eq!(store.snapshot_reads(&key).expect("refresh").models.len(), 2);
}

#[test]
fn quota_identity_cells_do_not_freeze_boot_or_live_publication() {
    let store = omni_store::SqliteStore::open(":memory:", 0).expect("store");
    store.connection().execute_batch("PRAGMA foreign_keys=OFF; INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('c','custom','c','apiKey','{}',1,1); INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,observed_at) VALUES(x'63','daily',0,100,100,0)").expect("seed");
    let key = omni_crypto::field::derive_key("key");
    assert!(store.snapshot_reads(&key).expect("boot").quota.is_empty());
    store.connection().execute_batch("INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,observed_at) VALUES('c',x'78',0,100,100,0); UPDATE credentials SET enabled=0 WHERE id='c'").expect("live");
    let live = store.snapshot_reads(&key).expect("refresh");
    assert!(!live.credentials[0].enabled);
    assert_eq!(live.quota.len(), 1);
    assert!(live.quota[0].spent());
}
