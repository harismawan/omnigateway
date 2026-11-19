//! Production seed source and real writer transaction identity, D3/D4 contract.
mod common;

use common::pg::{TestDb, base_url};
use omni_store::pg::{PgConfig, PgStore};
use omni_store::writer::{Committed, LogEvent, RequestLog, WriterConfig};

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
