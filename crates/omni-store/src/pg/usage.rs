//! The rate limiter's seed reads and the operator's sliding sum on Postgres,
//! from `packages/store/src/postgres/usage.ts` (`sumSince`, `sumBuckets`,
//! `NARROWED_SQL`), plus the boot sweep of `sweepPending`.
//!
//! Run by the limiter's seeder (through the writer, ordered after the
//! commits before it) and by operator commands, never on the request path.
//!
//! Sums arrive as `numeric` (a `SUM` of `BIGINT`) or `BIGINT`, and TS turns
//! each with `Number(string)`; they are cast to `float8` here, which is the
//! same correctly rounded decimal-to-double conversion.

use super::query_rows;
use crate::error::StoreError;
use crate::writer::RequestLog;
use deadpool_postgres::GenericClient;
use omni_ratelimit::buckets::Counts;

const HOUR_MS: i64 = 3_600_000;
/// `NODE_GRACE_MS`.
const NODE_GRACE_MS: i64 = 60_000;

/// Authoritative primary snapshot for distributed limiter seeds. Unlike the
/// operator rollup reader, every result uses the exact same completed-row set.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterSeedRead {
    pub snapshot: String,
    pub rows: Vec<(i64, Counts)>,
    pub ranges: Vec<(i64, i64, i64)>,
}

impl super::PgStore {
    /// Snapshot is fixed first. Integer `at` compared to a fractional boundary
    /// uses the mathematical ceiling, never a truncating timestamp conversion.
    pub async fn cluster_seed_read(
        &self,
        api_key_id: &str,
        since_ms: f64,
        grain_ms: i64,
        model: Option<&str>,
    ) -> Result<ClusterSeedRead, StoreError> {
        if !since_ms.is_finite() || since_ms.abs() > 9_007_199_254_740_991.0 || grain_ms <= 0 {
            return Err(StoreError::Writer(
                "invalid cluster seed boundary or grain".into(),
            ));
        }
        #[allow(clippy::cast_possible_truncation)]
        let since = since_ms.ceil() as i64;
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let snapshot = tx
            .query_one("SELECT pg_current_snapshot()::text", &[])
            .await?
            .try_get(0)?;
        // Counts and ranges share one GROUP BY over precisely the same rows.
        // Numeric floor also preserves negative timestamp bucket semantics.
        let rows = tx
            .query(
                "SELECT (floor(at::numeric / $1::bigint) * $1)::bigint,
                    COUNT(*)::float8,
                    COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens
                                 + cache_write_tokens), 0)::float8,
                    COALESCE(SUM(cost_usd), 0)::float8, MIN(at), MAX(at)
               FROM request_logs
              WHERE api_key_id = $2 AND state = 'done' AND at >= $3
                AND ($4::text IS NULL OR requested_model = $4)
              GROUP BY 1 ORDER BY 1",
                &[&grain_ms, &api_key_id, &since, &model],
            )
            .await?;
        let mut result = ClusterSeedRead {
            snapshot,
            rows: Vec::with_capacity(rows.len()),
            ranges: Vec::with_capacity(rows.len()),
        };
        for row in &rows {
            let bucket = row.try_get(0)?;
            result.rows.push((bucket, counts(row, 1)?));
            result
                .ranges
                .push((bucket, row.try_get(4)?, row.try_get(5)?));
        }
        tx.commit().await?;
        Ok(result)
    }
}

fn counts(r: &tokio_postgres::Row, from: usize) -> Result<Counts, StoreError> {
    Ok(Counts {
        requests: r.try_get(from)?,
        tokens: r.try_get(from + 1)?,
        cost_usd: r.try_get(from + 2)?,
    })
}

/// `NARROWED_SQL.sumSince`, its output cast.
pub const SUM_SINCE_MODEL: &str = "SELECT COUNT(*)::float8 AS requests,
        COALESCE(SUM(input_tokens + output_tokens
                     + cache_read_tokens + cache_write_tokens), 0)::float8 AS tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
   FROM request_logs
  WHERE api_key_id = $1 AND requested_model = $2 AND state = 'done' AND at >= $3";

const SUM_SINCE_WHOLE: &str = "SELECT COALESCE(SUM(requests), 0)::float8 AS requests,
        COALESCE(SUM(input_tokens + output_tokens
                     + cache_read_tokens + cache_write_tokens), 0)::float8 AS tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
   FROM usage_rollup
  WHERE api_key_id = $1 AND hour > $2";

const SUM_SINCE_EDGE: &str = "SELECT COUNT(*)::float8 AS requests,
        COALESCE(SUM(input_tokens + output_tokens
                     + cache_read_tokens + cache_write_tokens), 0)::float8 AS tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
   FROM request_logs
  WHERE api_key_id = $1 AND state = 'done' AND at >= $2 AND at < $3";

/// `sumSince`: exact sliding window, rollup whole hours plus the partial edge.
pub async fn sum_since(
    c: &impl GenericClient,
    api_key_id: &str,
    since: i64,
    model: Option<&str>,
) -> Result<Counts, StoreError> {
    if let Some(model) = model {
        let rows = query_rows(c, SUM_SINCE_MODEL, &[&api_key_id, &model, &since]).await?;
        return rows.first().map_or(Ok(Counts::default()), |r| counts(r, 0));
    }
    let boundary = since.div_euclid(HOUR_MS);
    let whole = query_rows(c, SUM_SINCE_WHOLE, &[&api_key_id, &boundary]).await?;
    let edge = query_rows(
        c,
        SUM_SINCE_EDGE,
        &[&api_key_id, &since, &((boundary + 1) * HOUR_MS)],
    )
    .await?;
    let a = whole
        .first()
        .map_or(Ok(Counts::default()), |r| counts(r, 0))?;
    let b = edge
        .first()
        .map_or(Ok(Counts::default()), |r| counts(r, 0))?;
    Ok(Counts {
        requests: a.requests + b.requests,
        tokens: a.tokens + b.tokens,
        cost_usd: a.cost_usd + b.cost_usd,
    })
}

/// `NARROWED_SQL.sumBuckets`, its output cast.
pub const BUCKETS_MODEL: &str = "SELECT (at / $1) * $2 AS bucket, COUNT(*)::float8 AS requests,
        COALESCE(SUM(input_tokens + output_tokens
                     + cache_read_tokens + cache_write_tokens), 0)::float8 AS tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
   FROM request_logs
  WHERE api_key_id = $3 AND requested_model = $4 AND state = 'done' AND at >= $5
  GROUP BY 1";

const BUCKETS_ROLLUP: &str = "SELECT hour * 3600000 AS bucket, requests::float8 AS requests,
        (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)::float8
          AS tokens,
        cost_usd
   FROM usage_rollup
  WHERE api_key_id = $1 AND hour >= $2";

const BUCKETS_LOG: &str = "SELECT (at / $1) * $2 AS bucket, COUNT(*)::float8 AS requests,
        COALESCE(SUM(input_tokens + output_tokens
                     + cache_read_tokens + cache_write_tokens), 0)::float8 AS tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
   FROM request_logs
  WHERE api_key_id = $3 AND state = 'done' AND at >= $4
  GROUP BY 1";

/// `sumBuckets(apiKeyId, sinceMs, grainMs, requestedModel)`: one row per
/// bucket start. Key-wide at the hour grain it reads `usage_rollup`; every
/// other read groups `request_logs` (done rows only).
pub async fn sum_buckets(
    c: &impl GenericClient,
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
        query_rows(
            c,
            BUCKETS_MODEL,
            &[&grain_ms, &grain_ms, &api_key_id, &model, &from],
        )
        .await?
    } else if grain_ms == HOUR_MS {
        query_rows(c, BUCKETS_ROLLUP, &[&api_key_id, &hour_of(since_ms)]).await?
    } else {
        query_rows(
            c,
            BUCKETS_LOG,
            &[&grain_ms, &grain_ms, &api_key_id, &since_ms],
        )
        .await?
    };
    rows.iter()
        .map(|r| Ok((r.try_get(0)?, counts(r, 1)?)))
        .collect()
}

/// The newest `cap` done rows' `at` since `since_ms`, returned ascending.
/// The narrowed stamps read.
pub const STAMPS_MODEL: &str = "SELECT at FROM request_logs
  WHERE api_key_id = $1 AND requested_model = $2 AND state = 'done' AND at >= $3
  ORDER BY at DESC LIMIT $4";

pub async fn done_stamps(
    c: &impl GenericClient,
    api_key_id: &str,
    since_ms: i64,
    requested_model: Option<&str>,
    cap: usize,
) -> Result<Vec<i64>, StoreError> {
    let cap = i64::try_from(cap).unwrap_or(i64::MAX);
    let rows = if let Some(model) = requested_model {
        query_rows(c, STAMPS_MODEL, &[&api_key_id, &model, &since_ms, &cap]).await?
    } else {
        query_rows(
            c,
            "SELECT at FROM request_logs
              WHERE api_key_id = $1 AND state = 'done' AND at >= $2
              ORDER BY at DESC LIMIT $3",
            &[&api_key_id, &since_ms, &cap],
        )
        .await?
    };
    let mut out: Vec<i64> = rows
        .iter()
        .map(|r| r.try_get(0))
        .collect::<Result<_, _>>()?;
    out.reverse();
    Ok(out)
}

/// A long-window seed's two reads in one repeatable-read snapshot, so the
/// bucket sums and the stamps describe the same committed state.
pub async fn seed_rows(
    client: &mut super::PgClient,
    api_key_id: &str,
    since_ms: i64,
    grain_ms: i64,
    requested_model: Option<&str>,
    stamp_cap: usize,
) -> Result<crate::usage::SeedRead, StoreError> {
    let tx = client
        .build_transaction()
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await?;
    let buckets = sum_buckets(&tx, api_key_id, since_ms, grain_ms, requested_model).await?;
    let stamps = done_stamps(&tx, api_key_id, since_ms, requested_model, stamp_cap).await?;
    tx.commit().await?;
    Ok((buckets, stamps))
}

impl super::PgStore {
    /// `sumSince` on a pooled connection.
    pub async fn sum_since(
        &self,
        api_key_id: &str,
        since: i64,
        model: Option<&str>,
    ) -> Result<Counts, StoreError> {
        sum_since(&self.client().await?, api_key_id, since, model).await
    }

    /// `seed_rows` on a pooled connection.
    pub async fn seed_rows(
        &self,
        api_key_id: &str,
        since_ms: i64,
        grain_ms: i64,
        requested_model: Option<&str>,
        stamp_cap: usize,
    ) -> Result<crate::usage::SeedRead, StoreError> {
        let mut c = self.client().await?;
        seed_rows(
            &mut c,
            api_key_id,
            since_ms,
            grain_ms,
            requested_model,
            stamp_cap,
        )
        .await
    }
}

/// `heartbeat` (`maintenance.ts`) then `sweepPending`'s read (`usage.ts`).
pub(crate) async fn sweep_pending(
    c: &impl GenericClient,
    node_id: &str,
    now: i64,
) -> Result<Vec<RequestLog>, StoreError> {
    query_rows(
        c,
        "INSERT INTO nodes (id, seen_at) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at",
        &[&node_id, &now],
    )
    .await?;
    query_rows(
        c,
        "DELETE FROM nodes WHERE seen_at < $1",
        &[&(now - 86_400_000)],
    )
    .await?;
    pending_interruptions(c, node_id, now).await
}

pub(crate) async fn pending_interruptions(
    c: &impl GenericClient,
    node_id: &str,
    now: i64,
) -> Result<Vec<RequestLog>, StoreError> {
    let rows = query_rows(
        c,
        "SELECT id, at, api_key_id, requested_model, resolved_provider, resolved_model,
                credential_id, attempts, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, ttft_ms, cost_usd, degradations,
                rtk_applied, rtk_filter_hits, rtk_original_code_units,
                rtk_compressed_code_units, rtk_estimated_tokens_saved, rtk_filters
           FROM request_logs
          WHERE state = 'pending'
            AND (node_id = $1 OR node_id NOT IN (SELECT id FROM nodes WHERE seen_at > $2))",
        &[&node_id, &(now - NODE_GRACE_MS)],
    )
    .await?;
    rows.iter()
        .map(|r| {
            let mut log = RequestLog::new(r.try_get::<_, String>(0)?, r.try_get(1)?, 499);
            log.api_key_id = r.try_get(2)?;
            log.requested_model = r.try_get(3)?;
            log.resolved_provider = r.try_get(4)?;
            log.resolved_model = r.try_get(5)?;
            log.credential_id = r.try_get(6)?;
            log.attempts = i64::from(r.try_get::<_, i32>(7)?);
            log.input_tokens = r.try_get(8)?;
            log.output_tokens = r.try_get(9)?;
            log.cache_read_tokens = r.try_get(10)?;
            log.cache_write_tokens = r.try_get(11)?;
            log.ttft_ms = r.try_get(12)?;
            log.cost_usd = r.try_get(13)?;
            let degradations: String = r.try_get(14)?;
            log.degradations = serde_json::from_str(&degradations).unwrap_or_default();
            log.rtk_applied = r.try_get(15)?;
            log.rtk_filter_hits = r.try_get(16)?;
            log.rtk_original_code_units = r.try_get(17)?;
            log.rtk_compressed_code_units = r.try_get(18)?;
            log.rtk_estimated_tokens_saved = r.try_get(19)?;
            log.rtk_filters = crate::maintenance::rtk_filters(&r.try_get::<_, String>(20)?);
            log.error_code = Some("interrupted".into());
            log.duration_ms = 0;
            Ok(log)
        })
        .collect()
}
