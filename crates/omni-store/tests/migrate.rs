//! Migrations: the ledger, the pragmas, the statement splitter, and parity with
//! `openDb` from every partial state TS could have left a database in.

mod common;

use omni_store::SqliteStore;
use omni_store::migrate::{LATEST_MIGRATION, MIGRATIONS};
use rusqlite::Connection;
fn ledger(conn: &Connection) -> Vec<i64> {
    let mut stmt = conn
        .prepare("SELECT id FROM migrations ORDER BY id")
        .expect("prepare");
    stmt.query_map([], |r| r.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

#[test]
fn fresh_database_gets_every_migration_and_the_ts_pragmas() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("fresh.db");
    let store = SqliteStore::open(&path, 0).expect("open");
    let conn = store.connection();
    assert_eq!(ledger(conn), (1..=20).collect::<Vec<i64>>());
    assert_eq!(LATEST_MIGRATION, 20);
    assert_eq!(MIGRATIONS.len(), 20);

    let journal: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .expect("journal_mode");
    assert_eq!(journal, "wal");
    let sync: i64 = conn
        .query_row("PRAGMA synchronous", [], |r| r.get(0))
        .expect("synchronous");
    assert_eq!(sync, 1, "NORMAL");
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .expect("foreign_keys");
    assert_eq!(fk, 1);
    let busy: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
        .expect("busy_timeout");
    assert_eq!(busy, 5000);

    // Reopening applies nothing new and keeps the ledger.
    drop(store);
    let again = SqliteStore::open(&path, 0).expect("reopen");
    assert_eq!(ledger(again.connection()), (1..=20).collect::<Vec<i64>>());
}

#[test]
fn a_failing_statement_rolls_back_its_whole_migration() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("broken.db");
    {
        // A database at migration 8 whose api_keys already has `limits`: 009's
        // ADD COLUMN fails, and the migration must not be recorded.
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .expect("ledger");
        for m in &MIGRATIONS[..8] {
            conn.execute_batch(m.sql).expect("legacy sql");
            conn.execute("INSERT INTO migrations VALUES (?, 0)", [m.id])
                .expect("ledger row");
        }
        conn.execute_batch("ALTER TABLE api_keys ADD COLUMN limits TEXT")
            .expect("sabotage");
    }
    let err = SqliteStore::open(&path, 0).expect_err("009 must fail");
    assert!(err.to_string().contains("migration 9"), "{err}");
    let conn = Connection::open(&path).expect("open");
    assert_eq!(ledger(&conn), (1..=8).collect::<Vec<i64>>());
    let has_rate: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('api_keys') WHERE name = 'rate_limit_per_min'",
            [],
            |r| r.get(0),
        )
        .expect("table_info");
    assert_eq!(has_rate, 1, "009's UPDATE and DROP rolled back with it");
}

#[test]
fn a_database_from_a_newer_build_keeps_its_unknown_migrations() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("newer.db");
    SqliteStore::open(&path, 0).expect("open");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute("INSERT INTO migrations VALUES (21, 0)", [])
            .expect("future row");
    }
    let store = SqliteStore::open(&path, 0).expect("reopen");
    assert_eq!(ledger(store.connection()), (1..=21).collect::<Vec<i64>>());
}
