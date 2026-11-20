//! Production seed source and real writer transaction identity, D3/D4 contract.
mod common;

use common::pg::{TestDb, base_url};
use omni_store::pg::{PgConfig, PgStore};
use omni_store::writer::{Committed, LogEvent, RequestLog, WriterConfig};

#[tokio::test]
async fn snapshot_keeps_order_row_validation_and_query_failure() {
    let Some(base) = base_url("snapshot_keeps_order_row_validation_and_query_failure") else {
        return;
    };
    let db = TestDb::create(&base, "snapshot_contract").await;
    let pg = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let c = db.client().await;
    c.batch_execute(
        "INSERT INTO api_keys(id,label,prefix,hash,created_at,model_allowlist) VALUES
           ('old','old','a','a',1,NULL),('bad','bad','c','c',2,'{'),('new','new','b','b',3,NULL);
         INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES
           ('z','custom','z','apiKey','{}',1,1),('bad','custom','bad','apiKey','{',1,1),
           ('a','custom','a','apiKey','{}',1,1);
         INSERT INTO credential_health(credential_id,model,consecutive_failures) VALUES('a','m',2);
         INSERT INTO quota_windows(credential_id,window_type,starts_at,used) VALUES('a','5h',1,3);
         INSERT INTO virtual_models(id,targets) VALUES('z','[]'),('bad','{'),('a','[]');
         INSERT INTO settings(key,value) VALUES('settings','{\"quotaPollIntervalMs\":70000}');",
    ).await.expect("seed all snapshot inputs");
    let key = omni_crypto::field::derive_key("test-key");
    let assert_snapshot = |s: omni_store::SnapshotData| {
        assert_eq!(s.api_keys.len(), 3);
        assert_eq!(s.api_keys[0].as_ref().expect("newest key").id, "new");
        assert!(s.api_keys[1].is_err());
        assert_eq!(s.api_keys[2].as_ref().expect("oldest key").id, "old");
        assert_eq!(
            s.credentials
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "z"]
        );
        assert_eq!(s.health.len(), 1);
        assert_eq!(s.health[0].consecutive_failures, 2);
        assert_eq!(s.quota.len(), 1);
        assert!((s.quota[0].used - 3.0).abs() < f64::EPSILON);
        assert_eq!(s.models.len(), 3);
        assert_eq!(s.models[0].as_ref().expect("first model").id, "a");
        assert!(s.models[1].is_err());
        assert_eq!(s.models[2].as_ref().expect("last model").id, "z");
        assert!((s.settings.quota_poll_interval_ms - 70_000.0).abs() < f64::EPSILON);
    };
    assert_snapshot(pg.snapshot_reads(&key).await.expect("snapshot"));
    c.batch_execute("ALTER TABLE quota_windows RENAME TO quota_hidden")
        .await
        .expect("inject SQL failure");
    // A fresh pool also exercises parse/execute ordering on cold boot.
    let fresh = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("cold pool");
    let Err(omni_store::StoreError::Postgres(error)) = fresh.snapshot_reads(&key).await else {
        panic!("a query failure must fail the whole snapshot");
    };
    assert_eq!(
        error.code(),
        Some(&tokio_postgres::error::SqlState::UNDEFINED_TABLE)
    );
    c.batch_execute("ALTER TABLE quota_hidden RENAME TO quota_windows")
        .await
        .expect("restore table");
    assert_snapshot(
        pg.snapshot_reads(&key)
            .await
            .expect("recover after failure"),
    );
}

#[tokio::test]
async fn shared_password_rows_use_atomic_first_setup_and_backend_reads() {
    let Some(base) = base_url("shared_password_rows_use_atomic_first_setup_and_backend_reads")
    else {
        return;
    };
    let db = TestDb::create(&base, "passwords").await;
    let store =
        omni_store::Store::open(omni_store::StoreConfig::Postgres(PgConfig::new(&db.url)), 0)
            .await
            .expect("store");
    let other = store.clone();
    let (a, b) = tokio::join!(
        store.password_hash_set_if_absent("adminPasswordHash", "hash-a"),
        other.password_hash_set_if_absent("adminPasswordHash", "hash-b")
    );
    assert_ne!(a.expect("first setup"), b.expect("second setup"));
    let raw = store
        .password_hash("adminPasswordHash")
        .await
        .expect("read")
        .expect("set");
    assert!(raw == "hash-a" || raw == "hash-b");
    store
        .password_hash_set("viewerPasswordHash", Some("viewer"))
        .await
        .expect("viewer");
    assert_eq!(
        other
            .password_hash("viewerPasswordHash")
            .await
            .expect("crossread")
            .as_deref(),
        Some("viewer")
    );
    store
        .password_hash_set("viewerPasswordHash", None)
        .await
        .expect("unset");
    assert_eq!(
        other
            .password_hash("viewerPasswordHash")
            .await
            .expect("crossread"),
        None
    );
}

#[tokio::test]
async fn snapshot_isolates_existing_malformed_credential_regression() {
    let Some(base) = base_url("snapshot_isolates_existing_malformed_credential_regression") else {
        return;
    };
    let db = TestDb::create(&base, "credential_isolation").await;
    let pg = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    pg.client().await.expect("client").batch_execute(
        "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at)
         VALUES('bad','custom','bad','apiKey','{',1,1),('good','custom','good','apiKey','{}',1,1)"
    ).await.expect("seed");
    let key = omni_crypto::field::derive_key("test-key");
    assert!(
        pg.list_credentials(&key).await.is_err(),
        "operator list retains failure"
    );
    let snapshot = pg
        .snapshot_reads(&key)
        .await
        .expect("isolated routing snapshot");
    assert_eq!(snapshot.credentials.len(), 1);
    assert_eq!(snapshot.credentials[0].id, "good");
}

#[tokio::test]
async fn actual_writer_identity_and_exact_fractional_seed_set() {
    let Some(base) = base_url("actual_writer_identity_and_exact_fractional_seed_set") else {
        return;
    };
    let db = TestDb::create(&base, "cluster_seed").await;
    let pg = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let writer = omni_store::writer::Writer::spawn_postgres(
        pg.clone(),
        WriterConfig {
            commit_sink: Some(tx),
            ..WriterConfig::default()
        },
    )
    .expect("writer");
    let h = writer.handle();
    for (id, at, tokens, cost) in [("old", 1000, 2, 0.25), ("new", 1001, 7, 0.75)] {
        let mut row = RequestLog::new(id, at, 200);
        row.api_key_id = Some("key".into());
        row.requested_model = "model".into();
        row.input_tokens = tokens;
        row.cost_usd = cost;
        assert!(h.send(LogEvent::Finish(row)));
    }
    h.flush().await.expect("flush");
    let mut rows = Vec::new();
    while rows.len() < 2 {
        if let Some(Committed::Completions(batch)) = rx.recv().await {
            rows.extend(batch);
        }
    }
    for row in &rows {
        let xid = row.commit_id.as_ref().expect("actual PG transaction xid8");
        assert!(xid.parse::<u64>().expect("decimal xid8") > 0);
    }
    assert_eq!(
        rows[0].commit_id, rows[1].commit_id,
        "one batch transaction"
    );
    assert!(
        rows.iter()
            .any(|r| r.at == 1000.0 && r.tokens == 2.0 && r.cost_usd == 0.25)
    );
    assert!(
        rows.iter()
            .any(|r| r.at == 1001.0 && r.tokens == 7.0 && r.cost_usd == 0.75)
    );
    for model in [None, Some("model")] {
        let seed = pg
            .cluster_seed_read("key", 1000.25, 1000, model)
            .await
            .expect("seed");
        assert_eq!(seed.rows.len(), 1);
        assert_eq!(seed.rows[0].1.requests, 1.0);
        assert_eq!(seed.rows[0].1.tokens, 7.0);
        assert_eq!(seed.rows[0].1.cost_usd, 0.75);
        assert_eq!(seed.ranges, vec![(1000, 1001, 1001)]);
        assert!(seed.snapshot.contains(':'));
    }
    // Replaying a finished event does not invent another logical completion.
    let mut duplicate = RequestLog::new("new", 1001, 200);
    duplicate.api_key_id = Some("key".into());
    duplicate.requested_model = "model".into();
    duplicate.input_tokens = 99;
    assert!(h.send(LogEvent::Finish(duplicate)));
    h.flush().await.expect("duplicate barrier");
    assert!(
        rx.try_recv().is_err(),
        "no second completion for stored done row"
    );

    // Hold the row table so the seed fixes its snapshot before its grouped
    // read. The real writer can then finish a transaction absent from that
    // snapshot, independent of which waiter gets the table lock first.
    let mut gate = pg.client().await.expect("gate connection");
    let gate_tx = gate.transaction().await.expect("gate transaction");
    gate_tx
        .batch_execute("LOCK TABLE request_logs IN ACCESS EXCLUSIVE MODE")
        .await
        .expect("gate table");
    let seed_pg = pg.clone();
    let seed = tokio::spawn(async move {
        seed_pg
            .cluster_seed_read("key", 0.0, 1000, None)
            .await
            .expect("concurrent seed")
    });
    let observer = pg.client().await.expect("observer");
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let blocked: bool = observer.query_one(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                    AND wait_event_type = 'Lock' AND query LIKE 'SELECT (floor(at::numeric%')",
                &[],
            ).await.expect("observe blocked seed").get(0);
            if blocked {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("seed fixed snapshot and blocked on rows");
    let mut late = RequestLog::new("late", 1002, 200);
    late.api_key_id = Some("key".into());
    late.requested_model = "model".into();
    late.input_tokens = 11;
    assert!(h.send(LogEvent::Finish(late)));
    gate_tx.commit().await.expect("release table");
    h.flush().await.expect("concurrent writer committed");
    let early = seed.await.expect("seed task");
    assert_eq!(
        early.rows[0].1.tokens, 9.0,
        "snapshot excludes concurrent writer"
    );
    let committed = loop {
        if let Some(Committed::Completions(batch)) = rx.recv().await {
            break batch;
        }
    };
    assert_eq!(committed.len(), 1);
    let xid = committed[0].commit_id.as_ref().expect("late xid8");
    let visible: bool = observer
        .query_one(
            "SELECT pg_visible_in_snapshot($1::text::xid8, $2::text::pg_snapshot)",
            &[xid, &early.snapshot],
        )
        .await
        .expect("check actual writer visibility")
        .get(0);
    assert!(!visible);
    // A debit ignored before any picture exists is recovered by a later
    // primary snapshot, rather than by relying on replica availability.
    let later = pg
        .cluster_seed_read("key", 0.0, 1000, None)
        .await
        .expect("later primary snapshot");
    assert_eq!(later.rows[0].1.tokens, 20.0);
    assert_eq!(later.ranges, vec![(1000, 1000, 1002)]);
    writer.close().await.expect("drain");
}
