//! Postgres migrations.
//!
//! The SQL lives in `crates/omni-store/migrations/postgres/` (`include_str!`),
//! byte-for-byte the files the TS store shipped, each run whole as one
//! simple-protocol batch inside its own transaction, recorded in the same
//! `migrations(id, applied_at)` ledger, under the same session advisory lock.
//! Installed databases record applied ids, so a shipped file is frozen: never
//! edit one, add the next.

use crate::error::StoreError;
use std::collections::HashSet;

/// `MIGRATION_LOCK` in `db.ts`. Changing it would let two versions of the
/// gateway migrate the same database at once.
pub const MIGRATION_LOCK: i64 = 7_140_641;

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub id: i32,
    pub sql: &'static str,
}

macro_rules! migration_sql {
    ($file:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/migrations/postgres/",
            $file
        ))
    };
}

const fn m(id: i32, sql: &'static str) -> Migration {
    Migration { id, sql }
}

/// `MIGRATIONS` in `db.ts`, in order.
pub const MIGRATIONS: [Migration; 8] = [
    m(1, migration_sql!("001_init.sql")),
    m(2, migration_sql!("002_health_measurements.sql")),
    m(3, migration_sql!("003_key_expiry.sql")),
    m(4, migration_sql!("004_log_keyset.sql")),
    m(5, migration_sql!("005_log_filter_indexes.sql")),
    m(6, migration_sql!("006_model_window_index.sql")),
    m(7, migration_sql!("007_key_guardrail.sql")),
    m(8, migration_sql!("008_key_smart_routing.sql")),
];

/// The newest migration this build knows.
pub const LATEST_MIGRATION: i32 = MIGRATIONS[MIGRATIONS.len() - 1].id;

/// `openPg`'s walk, on one connection: take the session advisory lock, then
/// read the applied set (after the lock, so a migrator that queued behind
/// another sees its rows), apply each missing migration in its own
/// transaction, and let the lock go. Ids this build does not know are left
/// alone.
///
/// On any error the caller must not reuse the connection: a failed unlock
/// would leave the session lock held, so the connection is closed instead.
pub(crate) async fn migrate(client: &tokio_postgres::Client) -> Result<(), StoreError> {
    client
        .execute("SELECT pg_advisory_lock($1)", &[&MIGRATION_LOCK])
        .await?;
    let walked = walk(client).await;
    let unlocked = client
        .execute("SELECT pg_advisory_unlock($1)", &[&MIGRATION_LOCK])
        .await;
    walked?;
    unlocked?;
    Ok(())
}

async fn walk(client: &tokio_postgres::Client) -> Result<(), StoreError> {
    client
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
        )
        .await?;
    let done: HashSet<i32> = client
        .query("SELECT id FROM migrations", &[])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    for m in &MIGRATIONS {
        if done.contains(&m.id) {
            continue;
        }
        apply(client, m)
            .await
            .map_err(|source| StoreError::Migration {
                id: i64::from(m.id),
                source: Box::new(source),
            })?;
    }
    Ok(())
}

async fn apply(client: &tokio_postgres::Client, m: &Migration) -> Result<(), StoreError> {
    client.batch_execute("BEGIN").await?;
    let result = async {
        client.batch_execute(m.sql).await?;
        client
            .execute(
                "INSERT INTO migrations (id, applied_at) VALUES ($1, $2)",
                &[&m.id, &now_ms()],
            )
            .await?;
        client.batch_execute("COMMIT").await?;
        Ok::<(), StoreError>(())
    }
    .await;
    if result.is_err() {
        // The statement error is the one worth reporting; a failed ROLLBACK
        // means the connection is gone, which closes the transaction anyway.
        client.batch_execute("ROLLBACK").await.ok();
    }
    result
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
