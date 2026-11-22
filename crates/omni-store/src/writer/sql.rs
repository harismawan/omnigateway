//! The statements a batch runs, and the multi-row upsert helper.
//!
//! Column lists are the storage contract, in their fixed orders (the rows
//! are pinned by `tests/writer.rs`). The rollup upserts set
//! absolute values rather than adding: the batch has already folded each row
//! in memory, starting from what the row held, with SQLite's own arithmetic
//! (see `num.rs`).

use crate::error::StoreError;
use rusqlite::limits::Limit;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, Transaction, params_from_iter};

/// The `request_logs` columns, in their stored order.
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

/// `usage_daily`'s key, then the counters, in the upsert's bind order.
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

/// The credential-health upsert, identical to the one in `credentials.rs`.
pub(crate) const UPSERT_HEALTH: &str = "INSERT INTO credential_health
   (credential_id, model, breaker_state, consecutive_failures, opened_at,
    rate_limited_until)
 VALUES (?,?,?,?,?,?)
 ON CONFLICT (credential_id, model) DO UPDATE SET
   breaker_state = excluded.breaker_state,
   consecutive_failures = excluded.consecutive_failures,
   opened_at = excluded.opened_at,
   rate_limited_until = excluded.rate_limited_until";

/// The most `?` one statement may bind on this connection
/// (`SQLITE_LIMIT_VARIABLE_NUMBER`; 32766 for the bundled build).
pub(crate) fn max_variables(conn: &Connection) -> Result<usize, StoreError> {
    let n = conn.limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER)?;
    Ok(usize::try_from(n).unwrap_or(0).max(1))
}

/// Rows (or ids) per statement. A statement is prepared once per size and
/// cached; sizing each statement to its batch instead made one statement per
/// distinct batch size, each up to the 32 766-variable limit, and the cache of
/// those held ~25 MiB once batches grew. Powers of four keep a remainder to at
/// most three statements of each smaller size.
pub(crate) const CHUNK_SIZES: [usize; 5] = [256, 64, 16, 4, 1];

/// `items` cut into chunks of `sizes` (largest first, ending in 1): as many
/// of the largest as fit, then of the next, and so on.
pub(crate) fn fixed_chunks<'a, T>(items: &'a [T], sizes: &[usize]) -> Vec<&'a [T]> {
    let mut out = Vec::new();
    let mut rest = items;
    for &n in sizes {
        while rest.len() >= n {
            let (head, tail) = rest.split_at(n);
            out.push(head);
            rest = tail;
        }
    }
    out
}

/// The [`CHUNK_SIZES`] whose `IN (…)` lists fit the variable limit.
pub(crate) fn id_sizes(conn: &Connection) -> Result<Vec<usize>, StoreError> {
    let most = max_variables(conn)?;
    Ok(CHUNK_SIZES.iter().copied().filter(|n| *n <= most).collect())
}

/// One table's multi-row upsert: every non-key column is set to the row
/// given, which the batch has already computed in full.
pub(crate) struct Upsert {
    table: &'static str,
    columns: Vec<&'static str>,
    key_len: usize,
}

impl Upsert {
    pub(crate) fn new(table: &'static str, key: &[&'static str], rest: &[&'static str]) -> Self {
        let columns: Vec<_> = key.iter().chain(rest).copied().collect();
        Self {
            table,
            columns,
            key_len: key.len(),
        }
    }

    /// The row counts statements are built for, largest first, under the
    /// connection's variable limit.
    fn sizes(&self, conn: &Connection) -> Result<Vec<usize>, StoreError> {
        let most = (max_variables(conn)? / self.columns.len()).max(1);
        Ok(CHUNK_SIZES.iter().copied().filter(|n| *n <= most).collect())
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

    /// Writes `rows` (each `columns.len()` wide) in chunks of the fixed
    /// [`CHUNK_SIZES`], so every batch reuses the same few cached statements.
    pub(crate) fn run<R: AsRef<[SqlValue]>>(
        &self,
        tx: &Transaction<'_>,
        rows: &[R],
    ) -> Result<(), StoreError> {
        for chunk in fixed_chunks(rows, &self.sizes(tx)?) {
            let mut stmt = tx.prepare_cached(&self.sql(chunk.len()))?;
            stmt.execute(params_from_iter(chunk.iter().flat_map(AsRef::as_ref)))?;
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
        let conn = Connection::open_in_memory().expect("open");
        assert_eq!(max_variables(&conn).expect("limit"), 32766);
        assert_eq!(u.sizes(&conn).expect("sizes"), CHUNK_SIZES);
    }

    #[test]
    fn fixed_chunks_cover_every_item_once_in_order() {
        for n in [0, 1, 3, 4, 5, 255, 256, 257, 4095] {
            let items: Vec<usize> = (0..n).collect();
            let chunks = fixed_chunks(&items, &CHUNK_SIZES);
            assert!(chunks.iter().all(|c| CHUNK_SIZES.contains(&c.len())));
            assert_eq!(chunks.concat(), items);
        }
        let items = [0; 4095];
        let lens: Vec<usize> = fixed_chunks(&items, &CHUNK_SIZES)
            .iter()
            .map(|c| c.len())
            .collect();
        // 15 × 256 + 3 × 64 + 3 × 16 + 3 × 4 + 3 × 1.
        assert_eq!(lens.len(), 27);
    }
}
