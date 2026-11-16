//! Retention statements from the frozen SQLite maintenance repositories.
use crate::StoreError;
use rusqlite::{Connection, params};

/// Frozen config preserves raw log retention, but validates body retention.
/// Array/object ToPrimitive is deliberately outside this scalar compatibility surface.
pub fn horizons(raw: Option<&str>, now: i64) -> Result<(f64, f64), StoreError> {
    let parsed = raw.and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let map = parsed.as_ref().and_then(serde_json::Value::as_object);
    let log = map.and_then(|m| m.get("logRetentionDays"));
    if matches!(
        log,
        Some(serde_json::Value::Array(_) | serde_json::Value::Object(_))
    ) {
        return Err(StoreError::Refused(
            "maintenance object/array retention requires ToPrimitive; stopped".into(),
        ));
    }
    let days = log.map_or(30.0, |v| omni_ir::js::to_number(Some(v)));
    let body = map
        .and_then(|m| m.get("bodyRetentionDays"))
        .and_then(serde_json::Value::as_f64)
        .filter(|v| v.fract() == 0.0 && (1.0..=3650.0).contains(v))
        .unwrap_or(1.0);
    // f64::min ignores NaN; JS Math.min propagates it.
    let minimum = if days.is_nan() {
        f64::NAN
    } else {
        body.min(days)
    };
    Ok((
        now as f64 - days * 86_400_000.0,
        now as f64 - minimum * 86_400_000.0,
    ))
}

/// Bun SQL infers bigint from the timestamp column. Its number text must be a
/// PostgreSQL bigint literal: fractions, NaN, infinities and overflow are refused,
/// not rounded or mapped to NULL as SQLite does with NaN.
pub fn pg_horizon(horizon: f64) -> Result<i64, StoreError> {
    if !horizon.is_finite()
        || horizon.fract() != 0.0
        || !(-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&horizon)
    {
        return Err(StoreError::Refused(
            "invalid input syntax or range for bigint maintenance horizon".into(),
        ));
    }
    Ok(horizon as i64)
}

pub(crate) fn rtk_filters(raw: &str) -> Vec<String> {
    let values: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap_or_default();
    values
        .into_iter()
        .filter_map(|v| {
            v.as_str()
                .filter(|s| {
                    matches!(
                        *s,
                        "git-diff"
                            | "git-status"
                            | "git-log"
                            | "grep"
                            | "path-list"
                            | "numbered-read"
                            | "build-output"
                            | "test-output"
                            | "deduplicate-log"
                            | "smart-truncate"
                            | "lint-output"
                            | "package-output"
                            | "tree-output"
                            | "git-operation"
                            | "docker-build"
                    )
                })
                .map(str::to_owned)
        })
        .collect()
}

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

#[cfg(test)]
mod tests {
    #[test]
    fn pg_timestamp_parameters_refuse_non_bigint_numbers() {
        for v in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.5, 1e30] {
            assert!(super::pg_horizon(v).is_err());
        }
        assert_eq!(super::pg_horizon(-1.0).expect("integer"), -1);
    }
}
