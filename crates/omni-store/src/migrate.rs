//! Core migrations, shared byte-for-byte with `packages/store/src/sqlite/db.ts`.
//!
//! The SQL is the TS files themselves (`include_str!`), split the way TS splits
//! them, recorded in the same `migrations(id, applied_at)` ledger. A database
//! is therefore at the same migration id whichever build last opened it, and
//! either build continues from wherever the other stopped.

use crate::error::StoreError;
use crate::{js, rollup};
use rusqlite::Connection;
use std::collections::HashSet;

/// A data step run inside the migration's transaction, after its SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum After {
    /// `backfillDaily`.
    BackfillDaily,
    /// `backfillRtkUsage`.
    BackfillRtkUsage,
    /// `rebuildRollup`.
    RebuildRollup,
}

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub id: i64,
    pub sql: &'static str,
    pub after: Option<After>,
}

macro_rules! migration_sql {
    ($file:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/store/src/sqlite/migrations/",
            $file
        ))
    };
}

const fn m(id: i64, sql: &'static str, after: Option<After>) -> Migration {
    Migration { id, sql, after }
}

/// `MIGRATIONS` in `db.ts`, in order.
pub const MIGRATIONS: [Migration; 20] = [
    m(1, migration_sql!("001_init.sql"), None),
    m(
        2,
        migration_sql!("002_usage_daily.sql"),
        Some(After::BackfillDaily),
    ),
    m(3, migration_sql!("003_quota_snapshot.sql"), None),
    m(4, migration_sql!("004_request_state.sql"), None),
    m(5, migration_sql!("005_rtk_metrics.sql"), None),
    m(
        6,
        migration_sql!("006_rtk_usage.sql"),
        Some(After::BackfillRtkUsage),
    ),
    m(7, migration_sql!("007_quota_samples.sql"), None),
    m(8, migration_sql!("008_body_logging.sql"), None),
    m(9, migration_sql!("009_key_limits.sql"), None),
    m(
        10,
        migration_sql!("010_usage_rollup.sql"),
        Some(After::RebuildRollup),
    ),
    m(11, migration_sql!("011_plugin_migrations.sql"), None),
    m(12, migration_sql!("012_nodes.sql"), None),
    m(13, migration_sql!("013_health_measurements.sql"), None),
    m(14, migration_sql!("014_key_expiry.sql"), None),
    m(15, migration_sql!("015_log_keyset.sql"), None),
    m(16, migration_sql!("016_log_filter_indexes.sql"), None),
    m(17, migration_sql!("017_log_text_search.sql"), None),
    m(18, migration_sql!("018_model_window_index.sql"), None),
    m(19, migration_sql!("019_key_guardrail.sql"), None),
    m(20, migration_sql!("020_key_smart_routing.sql"), None),
];

/// The newest migration this build knows.
pub const LATEST_MIGRATION: i64 = MIGRATIONS[MIGRATIONS.len() - 1].id;

/// `statements` in `db.ts`: comment lines dropped, split on a semicolon that
/// ends a line, each piece trimmed, empties dropped.
///
/// A line-end split, not a SQL parser — the TS comment says why that is enough
/// for every file in `migrations/`. The trims are JavaScript's, not Rust's.
pub fn statements(sql: &str) -> Vec<String> {
    let kept: Vec<&str> = sql
        .split('\n')
        .filter(|line| !js::trim_start(line).starts_with("--"))
        .collect();
    let joined = kept.join("\n");

    // `.split(/;[ \t]*(?:\n|$)/)`: a `;`, then spaces or tabs, then a newline
    // (consumed) or the end of the input.
    let bytes = joined.as_bytes();
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b';' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j == bytes.len() {
                pieces.push(&joined[start..i]);
                start = j;
                break;
            }
            if bytes[j] == b'\n' {
                pieces.push(&joined[start..i]);
                start = j + 1;
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    pieces.push(&joined[start.min(joined.len())..]);
    pieces
        .into_iter()
        .map(|s| js::trim(s).to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Sets the connection pragmas `openDb` sets. `journal_mode` persists in the
/// file; the other three are per connection and must be set on every open.
pub fn apply_pragmas(conn: &Connection) -> Result<(), StoreError> {
    // `journal_mode` answers with the mode in force, so it is a query.
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    conn.execute_batch(
        "PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

/// Applies every migration the ledger does not record, each in its own
/// transaction with its data step, as `openDb` does. Ids in the ledger this
/// build does not know (a newer build's) are left alone.
pub fn migrate(conn: &mut Connection, day_offset_minutes: i64) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )?;
    let done: HashSet<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM migrations")?;
        let mut rows = stmt.query([])?;
        let mut done = HashSet::new();
        while let Some(row) = rows.next()? {
            // Bun's raw cells enter a JS Set: only Number cells can equal a
            // numeric migration ID. Comparing against our small exact IDs
            // avoids coercing TEXT, rounding fractional REALs, or rejecting
            // unknown cells. Unknown ledger rows are never changed.
            let number = match row.get_ref(0)? {
                rusqlite::types::ValueRef::Integer(n) => n as f64,
                rusqlite::types::ValueRef::Real(n) => n,
                _ => continue,
            };
            for migration in &MIGRATIONS {
                if number == migration.id as f64 {
                    done.insert(migration.id);
                }
            }
        }
        done
    };
    for m in &MIGRATIONS {
        if done.contains(&m.id) {
            continue;
        }
        apply(conn, m, day_offset_minutes).map_err(|source| StoreError::Migration {
            id: m.id,
            source: Box::new(source),
        })?;
    }
    Ok(())
}

fn apply(conn: &mut Connection, m: &Migration, day_offset_minutes: i64) -> Result<(), StoreError> {
    // One `execute` per statement, as TS runs one `run` per statement: a step
    // error must abort the transaction, never be skipped past.
    let tx = conn.transaction()?;
    for statement in statements(m.sql) {
        tx.execute_batch(&statement)?;
    }
    match m.after {
        None => {}
        Some(After::BackfillDaily) => {
            rollup::backfill_daily(&tx, day_offset_minutes)?;
        }
        Some(After::BackfillRtkUsage) => rollup::backfill_rtk_usage(&tx, day_offset_minutes)?,
        Some(After::RebuildRollup) => rollup::rebuild_rollup(&tx)?,
    }
    tx.execute(
        "INSERT INTO migrations (id, applied_at) VALUES (?, ?)",
        [m.id, now_ms()],
    )?;
    tx.commit()?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
