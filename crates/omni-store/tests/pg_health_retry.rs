//! The health path's retry boundary: a mutation that definitely did not
//! commit (lock wait past the statement timeout) is retried, and one whose
//! COMMIT outcome is unknown (the acknowledgement lost with the connection)
//! is never applied a second time.

mod common;

use common::pg::{TestDb, base_url};
use common::proxy::Proxy;
use omni_store::pg::{PgConfig, PgStore};
use omni_store::writer::{HealthCommitted, HealthWriter, HealthWriterConfig};
use omni_store::{BreakerState, CredentialHealth, Store};
use std::sync::Arc;
use std::time::Duration;

fn plus_one(current: Option<CredentialHealth>) -> CredentialHealth {
    let mut h = current.unwrap_or(CredentialHealth {
        credential_id: "c1".into(),
        model: "m".into(),
        breaker_state: BreakerState::Closed,
        consecutive_failures: 0,
        opened_at: None,
        rate_limited_until: None,
    });
    h.consecutive_failures += 1;
    h
}

async fn seeded(db: &TestDb) {
    drop(
        PgStore::open(PgConfig::new(&db.url), 0)
            .await
            .expect("migrate"),
    );
    db.client()
        .await
        .batch_execute(
            "INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at)
               VALUES ('c1', 'anthropic', 'one', 'apiKey', 1, 1);
             INSERT INTO credential_health (credential_id, model, consecutive_failures)
               VALUES ('c1', 'm', 0);",
        )
        .await
        .expect("seed");
}

async fn failures(db: &TestDb) -> i32 {
    db.client()
        .await
        .query_one(
            "SELECT consecutive_failures FROM credential_health WHERE credential_id = 'c1' AND model = 'm'",
            &[],
        )
        .await
        .expect("row")
        .get(0)
}

fn upstream(base: &str) -> String {
    let rest = base.split_once('@').expect("credentials").1;
    rest.split('/').next().expect("host").to_owned()
}

/// One increment whose COMMIT reaches the server but whose acknowledgement
/// is lost with the connection: the row holds exactly one increment.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_commit_acknowledgement_is_not_applied_twice() {
    let Some(base) = base_url("a_lost_commit_acknowledgement_is_not_applied_twice") else {
        return;
    };
    let db = TestDb::create(&base, "lost_ack").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let store = PgStore::open(PgConfig::new(proxy.url(&db.url)), 0)
        .await
        .expect("open through the proxy");
    let health = HealthWriter::spawn(Store::Postgres(store), HealthWriterConfig::default());
    proxy.arm_commit_loss();
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while proxy.fired() == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the COMMIT ack was never lost"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _stats = health.close().await.expect("close");
    assert_eq!(proxy.fired(), 1);
    assert_eq!(
        failures(&db).await,
        1,
        "applied once, not re-applied after the lost ack"
    );
}

/// Close reports the uncertain mutation as such: not written, not failed,
/// and its reconciliation re-read is what the database holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_uncertain_commit_is_counted_and_reconciled_by_a_re_read() {
    let Some(base) = base_url("an_uncertain_commit_is_counted_and_reconciled_by_a_re_read") else {
        return;
    };
    let db = TestDb::create(&base, "uncertain").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let store = PgStore::open(PgConfig::new(proxy.url(&db.url)), 0)
        .await
        .expect("open through the proxy");
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    proxy.arm_commit_loss();
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    // A later mutation still goes through, once.
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    assert_eq!(
        (
            stats.enqueued,
            stats.written,
            stats.uncertain,
            stats.failed,
            stats.refused
        ),
        (2, 1, 1, 0, 0),
        "{stats:?}"
    );
    assert_eq!(failures(&db).await, 2, "each applied exactly once");
    let mut seen = Vec::new();
    while let Ok(m) = rx.try_recv() {
        seen.push(m);
    }
    assert_eq!(seen.len(), 2, "{seen:?}");
    match &seen[0] {
        HealthCommitted::Uncertain { reconciled, .. } => {
            let row = reconciled.as_ref().expect("re-read after the lost ack");
            assert_eq!(
                row.consecutive_failures, 1,
                "the re-read reports the stored row"
            );
        }
        other => panic!("first is the uncertain one: {other:?}"),
    }
    match &seen[1] {
        HealthCommitted::Written { row } => assert_eq!(row.consecutive_failures, 2),
        other => panic!("{other:?}"),
    }
}

/// A health-lock wait past the statement timeout definitely rolled back, so
/// it is retried, and the retry commits once the lock goes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_statement_timeout_on_the_health_lock_is_retried_and_commits() {
    let Some(base) = base_url("a_statement_timeout_on_the_health_lock_is_retried_and_commits")
    else {
        return;
    };
    let db = TestDb::create(&base, "lock_timeout").await;
    seeded(&db).await;
    let mut cfg = PgConfig::new(&db.url);
    cfg.statement_timeout = Duration::from_millis(80);
    let store = PgStore::open(cfg, 0).await.expect("open");
    let mut holder = db.client().await;
    let lock = holder.transaction().await.expect("tx");
    lock.execute("SELECT pg_advisory_xact_lock(hashtext('c1|m'))", &[])
        .await
        .expect("hold the pair's lock");
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            retry_base: Duration::from_millis(100),
            ..HealthWriterConfig::default()
        },
    );
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    // Attempt 1 times out at ~80 ms; attempt 2 at ~180 ms + 80; release
    // before attempt 3 (~460 ms).
    tokio::time::sleep(Duration::from_millis(330)).await;
    lock.rollback().await.expect("release");
    let stats = health.close().await.expect("close");
    assert_eq!(
        (stats.written, stats.retried, stats.failed, stats.uncertain),
        (1, 2, 0, 0),
        "{stats:?}"
    );
    assert_eq!(failures(&db).await, 1);
}

/// Past the retry budget, a definitely-rolled-back mutation fails and is
/// counted; nothing was written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_exhaustion_fails_the_mutation_and_writes_nothing() {
    let Some(base) = base_url("retry_exhaustion_fails_the_mutation_and_writes_nothing") else {
        return;
    };
    let db = TestDb::create(&base, "exhausted").await;
    seeded(&db).await;
    let mut cfg = PgConfig::new(&db.url);
    cfg.statement_timeout = Duration::from_millis(50);
    let store = PgStore::open(cfg, 0).await.expect("open");
    let mut holder = db.client().await;
    let lock = holder.transaction().await.expect("tx");
    lock.execute("SELECT pg_advisory_xact_lock(hashtext('c1|m'))", &[])
        .await
        .expect("hold");
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            retry_base: Duration::from_millis(10),
            ..HealthWriterConfig::default()
        },
    );
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    lock.rollback().await.expect("release");
    assert_eq!(
        (stats.written, stats.retried, stats.failed, stats.uncertain),
        (0, 2, 1, 0),
        "{stats:?}"
    );
    assert_eq!(failures(&db).await, 0);
}
