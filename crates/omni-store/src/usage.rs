//! The rate limiter's seed reads, from `packages/store/src/sqlite/usage.ts`.
//!
//! Run by the limiter's background seeder, never on the request path.

use crate::error::StoreError;
use omni_ratelimit::buckets::Counts;
use rusqlite::{Connection, params};

const HOUR_MS: i64 = 3_600_000;

fn counts(r: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, Counts)> {
    let num = |i: usize| -> rusqlite::Result<f64> {
        Ok(match r.get_ref(i)? {
            #[allow(clippy::cast_precision_loss)]
            rusqlite::types::ValueRef::Integer(v) => v as f64,
            rusqlite::types::ValueRef::Real(v) => v,
            _ => 0.0,
        })
    };
    Ok((
        r.get(0)?,
        Counts {
            requests: num(1)?,
            tokens: num(2)?,
            cost_usd: num(3)?,
        },
    ))
}

/// `sumBuckets(apiKeyId, sinceMs, grainMs, requestedModel)`: one row per
/// bucket start. Key-wide at the hour grain it reads `usage_rollup`; every
/// other read groups `request_logs` (done rows only).
pub fn sum_buckets(
    conn: &Connection,
    api_key_id: &str,
    since_ms: i64,
    grain_ms: i64,
    requested_model: Option<&str>,
) -> Result<Vec<(i64, Counts)>, StoreError> {
    let hour_of = |at: i64| at.div_euclid(HOUR_MS);
    let rows = if let Some(model) = requested_model {
        let from = if grain_ms == HOUR_MS {
            hour_of(since_ms) * HOUR_MS
        } else {
            since_ms
        };
        let mut stmt = conn.prepare_cached(
            "SELECT (at / ?) * ? AS bucket, COUNT(*) AS requests,
                    COALESCE(SUM(input_tokens + output_tokens
                                 + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                    COALESCE(SUM(cost_usd), 0) AS cost_usd
               FROM request_logs
              WHERE api_key_id = ? AND requested_model = ? AND state = 'done' AND at >= ?
              GROUP BY bucket",
        )?;
        stmt.query_map(params![grain_ms, grain_ms, api_key_id, model, from], counts)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else if grain_ms == HOUR_MS {
        let mut stmt = conn.prepare_cached(
            "SELECT hour * 3600000 AS bucket, requests,
                    input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
                      AS tokens,
                    cost_usd
               FROM usage_rollup
              WHERE api_key_id = ? AND hour >= ?",
        )?;
        stmt.query_map(params![api_key_id, hour_of(since_ms)], counts)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare_cached(
            "SELECT (at / ?) * ? AS bucket, COUNT(*) AS requests,
                    COALESCE(SUM(input_tokens + output_tokens
                                 + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                    COALESCE(SUM(cost_usd), 0) AS cost_usd
               FROM request_logs
              WHERE api_key_id = ? AND state = 'done' AND at >= ?
              GROUP BY bucket",
        )?;
        stmt.query_map(params![grain_ms, grain_ms, api_key_id, since_ms], counts)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

/// Every done row's `at` and request id since `since_ms`, ascending by
/// `at`. The first `at` is `oldestSince`; the limiter keeps the stamps so a
/// refusal's exact reset is answered from memory, and the ids so a debit
/// racing the seed is counted exactly once.
pub fn done_rows(
    conn: &Connection,
    api_key_id: &str,
    since_ms: i64,
    requested_model: Option<&str>,
) -> Result<Vec<(i64, String)>, StoreError> {
    let row = |r: &rusqlite::Row<'_>| Ok((r.get(0)?, r.get(1)?));
    let out = if let Some(model) = requested_model {
        let mut stmt = conn.prepare_cached(
            "SELECT at, id FROM request_logs
              WHERE api_key_id = ? AND requested_model = ? AND state = 'done' AND at >= ?
              ORDER BY at",
        )?;
        stmt.query_map(params![api_key_id, model, since_ms], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        let mut stmt = conn.prepare_cached(
            "SELECT at, id FROM request_logs
              WHERE api_key_id = ? AND state = 'done' AND at >= ?
              ORDER BY at",
        )?;
        stmt.query_map(params![api_key_id, since_ms], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(out)
}

/// Bucket sums by start, and every retained done row's `at`.
pub type SeedRead = (Vec<(i64, Counts)>, Vec<i64>);

/// A long-window seed's two reads in one read transaction, so the bucket
/// sums and the stamps describe one WAL snapshot. The writer runs it on its
/// own connection between batches.
pub fn seed_rows(
    conn: &Connection,
    api_key_id: &str,
    since_ms: i64,
    grain_ms: i64,
    requested_model: Option<&str>,
) -> Result<SeedRead, StoreError> {
    let tx = conn.unchecked_transaction()?;
    let buckets = sum_buckets(&tx, api_key_id, since_ms, grain_ms, requested_model)?;
    let stamps = done_rows(&tx, api_key_id, since_ms, requested_model)?
        .into_iter()
        .map(|(at, _)| at)
        .collect();
    tx.commit()?;
    Ok((buckets, stamps))
}
