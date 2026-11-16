//! Retention statements from the frozen SQLite maintenance repositories.
use crate::StoreError;
use rusqlite::{Connection, params};

pub fn heartbeat(c: &Connection, node: &str, now: i64) -> Result<(), StoreError> {
    c.execute(
        "INSERT OR REPLACE INTO nodes (id, seen_at) VALUES (?, ?)",
        params![node, now],
    )?;
    c.execute("DELETE FROM nodes WHERE seen_at < ?", [now - 86_400_000])?;
    Ok(())
}

pub fn prune(c: &Connection, horizon: f64) -> Result<usize, StoreError> {
    let tx = c.unchecked_transaction()?;
    let removed = tx.execute("DELETE FROM request_logs WHERE at < ?", [horizon])?;
    let boundary = (horizon / 3_600_000.0).floor();
    tx.execute("DELETE FROM usage_rollup WHERE hour <= ?", [boundary])?;
    tx.execute(
        "INSERT INTO usage_rollup
         (api_key_id, hour, requests, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd)
         SELECT api_key_id, ?, COUNT(*), COALESCE(SUM(input_tokens), 0),
          COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
          COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(cost_usd), 0)
         FROM request_logs WHERE state = 'done' AND api_key_id IS NOT NULL
          AND at >= ? AND at < ? GROUP BY api_key_id",
        params![
            boundary,
            boundary * 3_600_000.0,
            (boundary + 1.0) * 3_600_000.0
        ],
    )?;
    tx.commit()?;
    Ok(removed)
}

pub fn prune_daily(c: &Connection, horizon: f64) -> Result<usize, StoreError> {
    Ok(c.execute("DELETE FROM usage_daily WHERE day < ?", [horizon])?)
}

pub fn prune_quota_samples(c: &Connection, horizon: f64) -> Result<usize, StoreError> {
    Ok(c.execute("DELETE FROM quota_samples WHERE observed_at < ?", [horizon])?)
}
