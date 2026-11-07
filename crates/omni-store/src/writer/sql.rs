//! The statements a batch runs, and the multi-row upsert helper.
//!
//! Column lists are the TS ones (`usage.ts` `COLUMNS`, `rollup.ts` `UPSERT` and
//! `HOURLY_UPSERT`, `credentials.ts` `UPSERT_HEALTH`). The rollup upserts set
//! absolute values rather than adding: the batch has already folded each row
//! in memory, starting from what the row held, with SQLite's own arithmetic
//! (see `num.rs`).

use crate::error::StoreError;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Transaction, params_from_iter};

/// `usage.ts` `COLUMNS`, in its order.
pub(crate) const LOG_COLUMNS: [&str; 26] = [
    "id",
    "state",
    "node_id",
    "at",
    "api_key_id",
    "requested_model",
    "resolved_provider",
    "resolved_model",
    "credential_id",
    "attempts",
    "status",
    "error_code",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "ttft_ms",
    "duration_ms",
    "cost_usd",
    "degradations",
    "rtk_applied",
    "rtk_filter_hits",
    "rtk_original_code_units",
    "rtk_compressed_code_units",
    "rtk_estimated_tokens_saved",
    "rtk_filters",
];

/// `usage_daily`'s key, then the counters, as `rollup.ts` `UPSERT` binds them.
pub(crate) const DAILY_KEY: [&str; 6] = [
    "day",
    "provider",
    "credential_id",
    "requested_model",
    "resolved_model",
    "api_key_id",
];
pub(crate) const DAILY_COUNTERS: [&str; 10] = [
    "requests",
    "errors",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "rtk_saved_tokens",
    "rtk_applied_requests",
    "cost_usd",
    "duration_ms_sum",
];

pub(crate) const HOURLY_KEY: [&str; 2] = ["api_key_id", "hour"];
pub(crate) const HOURLY_COUNTERS: [&str; 6] = [
    "requests",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cost_usd",
];

/// `credentials.ts` `UPSERT_HEALTH`, verbatim in effect.
pub(crate) const UPSERT_HEALTH: &str = "INSERT INTO credential_health
   (credential_id, model, breaker_state, consecutive_failures, opened_at,
    rate_limited_until)
 VALUES (?,?,?,?,?,?)
 ON CONFLICT (credential_id, model) DO UPDATE SET
   breaker_state = excluded.breaker_state,
   consecutive_failures = excluded.consecutive_failures,
   opened_at = excluded.opened_at,
   rate_limited_until = excluded.rate_limited_until";

/// One table's multi-row upsert: every non-key column is set to the row
/// given, which the batch has already computed in full.
pub(crate) struct Upsert {
    table: &'static str,
    columns: Vec<&'static str>,
    key_len: usize,
    /// Rows per statement, keeping the bound variables well under SQLite's
    /// limit (32766).
    chunk: usize,
}

impl Upsert {
    pub(crate) fn new(table: &'static str, key: &[&'static str], rest: &[&'static str]) -> Self {
        let columns: Vec<_> = key.iter().chain(rest).copied().collect();
        let chunk = (8192 / columns.len()).max(1);
        Self {
            table,
            columns,
            key_len: key.len(),
            chunk,
        }
    }

    fn sql(&self, rows: usize) -> String {
        let one = format!("({})", vec!["?"; self.columns.len()].join(","));
        let set: Vec<String> = self.columns[self.key_len..]
            .iter()
            .map(|c| format!("{c} = excluded.{c}"))
            .collect();
        format!(
            "INSERT INTO {} ({}) VALUES {} ON CONFLICT ({}) DO UPDATE SET {}",
            self.table,
            self.columns.join(", "),
            vec![one; rows].join(","),
            self.columns[..self.key_len].join(", "),
            set.join(", ")
        )
    }

    /// Writes `rows` (each `columns.len()` wide), one statement per chunk.
    pub(crate) fn run(
        &self,
        tx: &Transaction<'_>,
        rows: &[Vec<SqlValue>],
    ) -> Result<(), StoreError> {
        for chunk in rows.chunks(self.chunk) {
            let mut stmt = tx.prepare_cached(&self.sql(chunk.len()))?;
            stmt.execute(params_from_iter(chunk.iter().flatten()))?;
        }
        Ok(())
    }
}

/// `SELECT <LOG_COLUMNS> FROM request_logs WHERE id IN (…)`, for `n` ids.
pub(crate) fn select_logs(n: usize) -> String {
    format!(
        "SELECT {} FROM request_logs WHERE id IN ({})",
        LOG_COLUMNS.join(", "),
        vec!["?"; n].join(",")
    )
}

/// The counters of one rollup row, by its whole key.
pub(crate) fn select_counters(table: &str, key: &[&str], counters: &[&str]) -> String {
    let filter: Vec<String> = key.iter().map(|c| format!("{c} = ?")).collect();
    format!(
        "SELECT {} FROM {table} WHERE {}",
        counters.join(", "),
        filter.join(" AND ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_sql_sets_every_non_key_column() {
        let u = Upsert::new("usage_rollup", &HOURLY_KEY, &HOURLY_COUNTERS);
        assert_eq!(
            u.sql(2),
            "INSERT INTO usage_rollup (api_key_id, hour, requests, input_tokens, output_tokens, \
             cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?),\
             (?,?,?,?,?,?,?,?) ON CONFLICT (api_key_id, hour) DO UPDATE SET \
             requests = excluded.requests, input_tokens = excluded.input_tokens, \
             output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens, \
             cache_write_tokens = excluded.cache_write_tokens, cost_usd = excluded.cost_usd"
        );
        assert_eq!(u.chunk, 1024);
    }
}
