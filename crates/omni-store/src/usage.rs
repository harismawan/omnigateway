//! The rate limiter's seed reads, from `packages/store/src/sqlite/usage.ts`.
//!
//! Run by the limiter's background seeder, never on the request path.

use crate::error::StoreError;
use omni_ratelimit::buckets::Counts;
use rusqlite::{Connection, params};

const HOUR_MS: i64 = 3_600_000;

/// Exact sliding-window operator read: rollup whole hours plus the partial edge.
pub fn sum_since(
    conn: &Connection,
    id: &str,
    since: i64,
    model: Option<&str>,
) -> Result<Counts, StoreError> {
    let read = |r: &rusqlite::Row<'_>| counts(r).map(|(_, c)| c);
    if let Some(model) = model {
        return Ok(conn.query_row("SELECT 0, COUNT(*), COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0), COALESCE(SUM(cost_usd),0) FROM request_logs WHERE api_key_id=? AND requested_model=? AND state='done' AND at>=?", params![id, model, since], read)?);
    }
    let boundary = since.div_euclid(HOUR_MS);
    let whole = conn.query_row("SELECT 0, COALESCE(SUM(requests),0), COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0), COALESCE(SUM(cost_usd),0) FROM usage_rollup WHERE api_key_id=? AND hour>?", params![id,boundary], read)?;
    let edge = conn.query_row("SELECT 0, COUNT(*), COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0), COALESCE(SUM(cost_usd),0) FROM request_logs WHERE api_key_id=? AND state='done' AND at>=? AND at<?", params![id,since,(boundary+1)*HOUR_MS], read)?;
    Ok(Counts {
        requests: whole.requests + edge.requests,
        tokens: whole.tokens + edge.tokens,
        cost_usd: whole.cost_usd + edge.cost_usd,
    })
}

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

/// The newest `cap` done rows' `at` since `since_ms`, returned ascending.
/// Truncation can delay resets until the omitted history expires, even after
/// the live population drops below the cap. Aggregate sums are not capped.
pub fn done_stamps(
    conn: &Connection,
    api_key_id: &str,
    since_ms: i64,
    requested_model: Option<&str>,
    cap: usize,
) -> Result<Vec<i64>, StoreError> {
    let cap = i64::try_from(cap).unwrap_or(i64::MAX);
    let mut out = if let Some(model) = requested_model {
        let mut stmt = conn.prepare_cached(
            "SELECT at FROM request_logs
              WHERE api_key_id = ? AND requested_model = ? AND state = 'done' AND at >= ?
              ORDER BY at DESC LIMIT ?",
        )?;
        stmt.query_map(params![api_key_id, model, since_ms, cap], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()?
    } else {
        let mut stmt = conn.prepare_cached(
            "SELECT at FROM request_logs
              WHERE api_key_id = ? AND state = 'done' AND at >= ?
              ORDER BY at DESC LIMIT ?",
        )?;
        stmt.query_map(params![api_key_id, since_ms, cap], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()?
    };
    out.reverse();
    Ok(out)
}

/// Bucket sums by start (one row per grain), and newest capped stamps ascending.
pub type SeedRead = (Vec<(i64, Counts)>, Vec<i64>);

/// A long-window seed's two reads in one read transaction, so the bucket
/// sums and the stamps describe one WAL snapshot. The writer runs it on its
/// own connection between batches. The payload is O(buckets + `stamp_cap`):
/// bucket sums are aggregated per grain in SQL (`sumBuckets`), and stamps
/// are limited in the query.
pub fn seed_rows(
    conn: &Connection,
    api_key_id: &str,
    since_ms: i64,
    grain_ms: i64,
    requested_model: Option<&str>,
    stamp_cap: usize,
) -> Result<SeedRead, StoreError> {
    let tx = conn.unchecked_transaction()?;
    let buckets = sum_buckets(&tx, api_key_id, since_ms, grain_ms, requested_model)?;
    let stamps = done_stamps(&tx, api_key_id, since_ms, requested_model, stamp_cap)?;
    tx.commit()?;
    Ok((buckets, stamps))
}

/// `NODE_GRACE_MS`.
const NODE_GRACE_MS: i64 = 60_000;

/// `heartbeat` then `sweepPending`'s read (`maintenance.ts`, `usage.ts`):
/// this node's liveness row, day-old ones forgotten, and every pending row
/// of this node or of a node with no live heartbeat, as the 499
/// `interrupted` completions (zero duration) the boot sweep sends through
/// the writer. The same statements `omni-gateway`'s boot runs today.
pub fn sweep_pending(
    conn: &Connection,
    node_id: &str,
    now: i64,
) -> Result<Vec<crate::writer::RequestLog>, StoreError> {
    conn.execute(
        "INSERT OR REPLACE INTO nodes (id, seen_at) VALUES (?, ?)",
        params![node_id, now],
    )?;
    conn.execute(
        "DELETE FROM nodes WHERE seen_at < ?",
        params![now - 86_400_000],
    )?;
    pending_interruptions(conn, node_id, now)
}

/// The hourly sweep does not write a heartbeat: liveness has its own timer.
pub fn pending_interruptions(
    conn: &Connection,
    node_id: &str,
    now: i64,
) -> Result<Vec<crate::writer::RequestLog>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT id, at, api_key_id, requested_model, resolved_provider, resolved_model,
                credential_id, attempts, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, ttft_ms, cost_usd, degradations
           FROM request_logs
          WHERE state = 'pending'
            AND (node_id = ? OR node_id NOT IN (SELECT id FROM nodes WHERE seen_at > ?))",
    )?;
    let rows = stmt.query_map(params![node_id, now - NODE_GRACE_MS], |r| {
        let mut log = crate::writer::RequestLog::new(r.get::<_, String>(0)?, r.get(1)?, 499);
        log.api_key_id = r.get(2)?;
        log.requested_model = r.get(3)?;
        log.resolved_provider = r.get(4)?;
        log.resolved_model = r.get(5)?;
        log.credential_id = r.get(6)?;
        log.attempts = r.get(7)?;
        log.input_tokens = r.get(8)?;
        log.output_tokens = r.get(9)?;
        log.cache_read_tokens = r.get(10)?;
        log.cache_write_tokens = r.get(11)?;
        log.ttft_ms = r.get(12)?;
        log.cost_usd = r.get(13)?;
        let degradations: String = r.get(14)?;
        log.degradations = serde_json::from_str(&degradations).unwrap_or_default();
        log.error_code = Some("interrupted".into());
        log.duration_ms = 0;
        Ok(log)
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
