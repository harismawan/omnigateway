//! Contract tests for the Postgres migration walk: the eight files, the
//! ledger, the advisory lock, resumed from every partial state an older
//! build could have left a database in (each file applied as its own batch
//! with a ledger row).

mod common;

use common::pg::{TestDb, base_url};
use omni_store::pg::migrate::{LATEST_MIGRATION, MIGRATION_LOCK, MIGRATIONS};
use omni_store::pg::{PgConfig, PgStore};
use std::time::Duration;

async fn ledger(client: &tokio_postgres::Client) -> Vec<i32> {
    client
        .query("SELECT id FROM migrations ORDER BY id", &[])
        .await
        .expect("ledger")
        .iter()
        .map(|r| r.get(0))
        .collect()
}

async fn advisory_locks_held(client: &tokio_postgres::Client) -> i64 {
    client
        .query_one(
            // Advisory locks are per database, and other tests' databases
            // take the same key in parallel.
            "SELECT COUNT(*) FROM pg_locks
              WHERE locktype = 'advisory' AND objid = $1::bigint::oid
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
            &[&MIGRATION_LOCK],
        )
        .await
        .expect("pg_locks")
        .get(0)
}

/// What an older walk leaves after `upto` migrations: each file run as one
/// simple-protocol batch and a ledger row, in one transaction.
async fn legacy(db: &TestDb, upto: usize) {
    let client = db.client().await;
    client
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
        )
        .await
        .expect("ledger");
    for m in &MIGRATIONS[..upto] {
        client.batch_execute("BEGIN").await.expect("begin");
        client.batch_execute(m.sql).await.expect("legacy sql");
        client
            .execute(
                "INSERT INTO migrations (id, applied_at) VALUES ($1, $2)",
                &[&m.id, &0_i64],
            )
            .await
            .expect("ledger row");
        client.batch_execute("COMMIT").await.expect("commit");
    }
}

fn config(url: &str) -> PgConfig {
    PgConfig::new(url)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_database_gets_every_migration_verbatim() {
    let Some(base) = base_url("fresh_database_gets_every_migration_verbatim") else {
        return;
    };
    assert_eq!(MIGRATIONS.len(), 8);
    assert_eq!(LATEST_MIGRATION, 8);
    assert_eq!(MIGRATION_LOCK, 7_140_641);
    for (n, m) in MIGRATIONS.iter().enumerate() {
        assert_eq!(m.id, i32::try_from(n + 1).expect("id"));
    }
    let db = TestDb::create(&base, "fresh").await;
    let store = PgStore::open(config(&db.url), 0).await.expect("open");
    let c = db.client().await;
    assert_eq!(ledger(&c).await, (1..=8).collect::<Vec<_>>());
    assert_eq!(advisory_locks_held(&c).await, 0, "lock released");
    assert_eq!(store.config_version().await.expect("version"), 0);
    drop(store);
    // Reopening applies nothing and keeps the ledger.
    let applied: Vec<i64> = c
        .query("SELECT applied_at FROM migrations ORDER BY id", &[])
        .await
        .expect("applied_at")
        .iter()
        .map(|r| r.get(0))
        .collect();
    PgStore::open(config(&db.url), 0).await.expect("reopen");
    let again: Vec<i64> = c
        .query("SELECT applied_at FROM migrations ORDER BY id", &[])
        .await
        .expect("applied_at")
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(applied, again);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_migration_rolls_back_whole_and_releases_the_lock() {
    let Some(base) = base_url("a_failing_migration_rolls_back_whole_and_releases_the_lock") else {
        return;
    };
    let db = TestDb::create(&base, "broken").await;
    legacy(&db, 2).await;
    // 003 adds `api_keys.expires_at`; a column already there makes it fail.
    let c = db.client().await;
    c.batch_execute("ALTER TABLE api_keys ADD COLUMN expires_at TEXT")
        .await
        .expect("sabotage");
    let err = PgStore::open(config(&db.url), 0)
        .await
        .expect_err("003 must fail");
    assert!(err.to_string().contains("migration 3"), "{err}");
    assert_eq!(ledger(&c).await, vec![1, 2]);
    assert_eq!(advisory_locks_held(&c).await, 0, "lock released on failure");
    // Nothing of 003 or later landed.
    let has_guardrail: i64 = c
        .query_one(
            "SELECT COUNT(*) FROM information_schema.columns
              WHERE table_name = 'api_keys' AND column_name = 'guardrail_policy'",
            &[],
        )
        .await
        .expect("columns")
        .get(0);
    assert_eq!(has_guardrail, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_database_from_a_newer_build_keeps_its_unknown_migrations() {
    let Some(base) = base_url("a_database_from_a_newer_build_keeps_its_unknown_migrations") else {
        return;
    };
    let db = TestDb::create(&base, "newer").await;
    legacy(&db, 8).await;
    let c = db.client().await;
    c.execute(
        "INSERT INTO migrations (id, applied_at) VALUES (9, 123)",
        &[],
    )
    .await
    .expect("future row");
    PgStore::open(config(&db.url), 0).await.expect("open");
    assert_eq!(ledger(&c).await, (1..=9).collect::<Vec<_>>());
}

/// Two Rust migrators at once on an empty database: the advisory lock
/// serialises them, the second reads the ledger after the first committed,
/// and both succeed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_migrators_serialise_on_the_advisory_lock() {
    let Some(base) = base_url("two_migrators_serialise_on_the_advisory_lock") else {
        return;
    };
    for round in 0..3 {
        let db = TestDb::create(&base, &format!("race{round}")).await;
        let (a, b) = tokio::join!(
            PgStore::open(config(&db.url), 0),
            PgStore::open(config(&db.url), 0)
        );
        a.expect("first migrator");
        b.expect("second migrator");
        let c = db.client().await;
        assert_eq!(ledger(&c).await, (1..=8).collect::<Vec<_>>());
        assert_eq!(advisory_locks_held(&c).await, 0);
    }
}

/// The walk waits for whoever holds the lock, and starts once it is let go.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_walk_waits_for_a_held_lock() {
    let Some(base) = base_url("the_walk_waits_for_a_held_lock") else {
        return;
    };
    let db = TestDb::create(&base, "held").await;
    let holder = db.client().await;
    holder
        .execute("SELECT pg_advisory_lock($1)", &[&MIGRATION_LOCK])
        .await
        .expect("hold");
    let url = db.url.clone();
    let opening = tokio::spawn(async move { PgStore::open(config(&url), 0).await });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!opening.is_finished(), "must wait on the lock");
    let probe = db.client().await;
    let ledger_exists: bool = probe
        .query_one("SELECT to_regclass('migrations') IS NOT NULL", &[])
        .await
        .expect("probe")
        .get(0);
    assert!(!ledger_exists, "nothing ran before the lock was taken");
    holder
        .execute("SELECT pg_advisory_unlock($1)", &[&MIGRATION_LOCK])
        .await
        .expect("release");
    tokio::time::timeout(Duration::from_secs(10), opening)
        .await
        .expect("finishes once released")
        .expect("join")
        .expect("open");
    assert_eq!(ledger(&probe).await, (1..=8).collect::<Vec<_>>());
}
