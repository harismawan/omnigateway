//! Day and hour bucketing, and the migration backfills, from
//! `packages/store/src/sqlite/rollup.ts`.
//!
//! The bucketing functions work in `f64` because the TS ones do: `at` is never
//! validated and may be fractional, and the result is persisted as a key, so
//! the arithmetic must be JavaScript's to the bit. `start_of_day_ms` is the
//! integer form for a writer that only ever holds integer instants.

use crate::error::StoreError;
use crate::js;
use indexmap::IndexMap;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, Row, params_from_iter};

pub const HOUR_MS: f64 = 3_600_000.0;
const DAY_MS: f64 = 86_400_000.0;
const DAY_MS_INT: i64 = 86_400_000;

/// `hourOf`: the `usage_rollup.hour` bucket an instant belongs to.
pub fn hour_of(at: f64) -> f64 {
    (at / HOUR_MS).floor()
}

/// `startOfDay`: the epoch of midnight at a fixed offset east of UTC
/// containing `at`. `Math.floor` keeps a fractional `at` on an integer key.
pub fn start_of_day(at: f64, offset_minutes: i64) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let offset_ms = offset_minutes as f64 * 60_000.0;
    ((at + offset_ms) / DAY_MS).floor() * DAY_MS - offset_ms
}

/// `startOfDay` for an integer instant. Equal to [`start_of_day`] for every
/// instant inside the safe-integer range.
pub fn start_of_day_ms(at: i64, offset_minutes: i64) -> i64 {
    let offset_ms = offset_minutes * 60_000;
    (at + offset_ms).div_euclid(DAY_MS_INT) * DAY_MS_INT - offset_ms
}

/// `hostDayOffsetMinutes`: the host's current offset in minutes east of UTC.
///
/// The process-wide default for a node that leaves `OMNI_DAY_OFFSET_MINUTES`
/// unset, read once at boot. Like `Date#getTimezoneOffset`, it honours `TZ`.
pub fn host_day_offset_minutes() -> i64 {
    use chrono::Offset as _;
    i64::from(chrono::Local::now().offset().fix().local_minus_utc()).div_euclid(60)
}

/// The tuple a `usage_daily` row is keyed by, with `""` where the log had null.
struct Key {
    day: f64,
    strings: [String; 5],
}

impl Key {
    fn read(row: &Row<'_>, day_offset_minutes: i64) -> Result<Self, StoreError> {
        let at = num(row, "at")?;
        Ok(Self {
            day: start_of_day(at, day_offset_minutes),
            strings: [
                text_or_empty(row, "resolved_provider")?,
                text_or_empty(row, "credential_id")?,
                text_or_empty(row, "requested_model")?,
                text_or_empty(row, "resolved_model")?,
                text_or_empty(row, "api_key_id")?,
            ],
        })
    }

    /// `key.join("\0")`, the grouping id. Built the same way so two tuples the
    /// TS walk would merge are merged here too.
    fn id(&self) -> String {
        let mut id = js::number_to_string(self.day);
        for s in &self.strings {
            id.push('\0');
            id.push_str(s);
        }
        id
    }

    /// Bound in column order: day, provider, credential, requested, resolved, key.
    fn bind(&self) -> impl Iterator<Item = SqlValue> + '_ {
        std::iter::once(js::bind_number(self.day))
            .chain(self.strings.iter().map(|s| SqlValue::Text(s.clone())))
    }
}

fn corrupt(column: &str, what: &str) -> StoreError {
    StoreError::Corrupt(format!(
        "request_logs.{column} holds {what}, which the TS backfill would not have counted as a number"
    ))
}

fn num(row: &Row<'_>, column: &str) -> Result<f64, StoreError> {
    js::number(row.get_ref(column)?).ok_or_else(|| corrupt(column, "a non-number"))
}

fn text_or_empty(row: &Row<'_>, column: &str) -> Result<String, StoreError> {
    match row.get_ref(column)? {
        ValueRef::Null => Ok(String::new()),
        ValueRef::Text(t) => Ok(String::from_utf8_lossy(t).into_owned()),
        // TEXT affinity stores a number as text, so this only arises for a
        // column without it; `String(n)` is what the JS join would see.
        ValueRef::Integer(v) => Ok(v.to_string()),
        ValueRef::Real(v) => Ok(js::number_to_string(v)),
        ValueRef::Blob(_) => Err(corrupt(column, "a blob")),
    }
}

#[derive(Default)]
struct Counters {
    requests: f64,
    errors: f64,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    cost_usd: f64,
    duration_ms_sum: f64,
}

/// `BACKFILL_UPSERT`: migration 2's upsert, without the two RTK columns that
/// migration 6 adds.
const BACKFILL_UPSERT: &str = "
  INSERT INTO usage_daily
    (day, provider, credential_id, requested_model, resolved_model, api_key_id,
     requests, errors, input_tokens, output_tokens, cache_read_tokens,
     cache_write_tokens, cost_usd, duration_ms_sum)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (day, provider, credential_id, requested_model, resolved_model, api_key_id)
  DO UPDATE SET
    requests           = requests + excluded.requests,
    errors             = errors + excluded.errors,
    input_tokens       = input_tokens + excluded.input_tokens,
    output_tokens      = output_tokens + excluded.output_tokens,
    cache_read_tokens  = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    cost_usd           = cost_usd + excluded.cost_usd,
    duration_ms_sum    = duration_ms_sum + excluded.duration_ms_sum";

/// `backfillDaily`: seeds `usage_daily` from the logs already on disk.
/// Runs inside the migration's transaction. Returns the rows written.
pub fn backfill_daily(conn: &Connection, day_offset_minutes: i64) -> Result<usize, StoreError> {
    let mut groups: IndexMap<String, (Key, Counters)> = IndexMap::new();
    let mut stmt = conn.prepare(
        "SELECT at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
                status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                duration_ms, cost_usd
           FROM request_logs",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let key = Key::read(row, day_offset_minutes)?;
        let status = num(row, "status")?;
        let input = num(row, "input_tokens")?;
        let output = num(row, "output_tokens")?;
        let cache_read = num(row, "cache_read_tokens")?;
        let cache_write = num(row, "cache_write_tokens")?;
        let cost = num(row, "cost_usd")?;
        let duration = num(row, "duration_ms")?;
        let (_, c) = groups
            .entry(key.id())
            .or_insert_with(|| (key, Counters::default()));
        c.requests += 1.0;
        c.errors += if status >= 400.0 { 1.0 } else { 0.0 };
        c.input_tokens += input;
        c.output_tokens += output;
        c.cache_read_tokens += cache_read;
        c.cache_write_tokens += cache_write;
        c.cost_usd += cost;
        c.duration_ms_sum += duration;
    }
    let mut upsert = conn.prepare(BACKFILL_UPSERT)?;
    for (key, c) in groups.values() {
        let counters = [
            c.requests,
            c.errors,
            c.input_tokens,
            c.output_tokens,
            c.cache_read_tokens,
            c.cache_write_tokens,
            c.cost_usd,
            c.duration_ms_sum,
        ]
        .map(js::bind_number);
        upsert.execute(params_from_iter(key.bind().chain(counters)))?;
    }
    Ok(groups.len())
}

/// `backfillRtkUsage`: fills migration 6's two columns for the rows that
/// exist, without adding the usage counters a second time.
pub fn backfill_rtk_usage(conn: &Connection, day_offset_minutes: i64) -> Result<(), StoreError> {
    let mut groups: IndexMap<String, (Key, f64, f64)> = IndexMap::new();
    let mut stmt = conn.prepare(
        "SELECT at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
                rtk_applied, rtk_estimated_tokens_saved
           FROM request_logs
          WHERE state = 'done'",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let key = Key::read(row, day_offset_minutes)?;
        let saved = num(row, "rtk_estimated_tokens_saved")?;
        let applied = js::is_one(row.get_ref("rtk_applied")?);
        let (_, total_saved, total_applied) =
            groups.entry(key.id()).or_insert_with(|| (key, 0.0, 0.0));
        *total_saved += saved;
        *total_applied += if applied { 1.0 } else { 0.0 };
    }
    let mut update = conn.prepare(
        "UPDATE usage_daily
            SET rtk_saved_tokens = ?, rtk_applied_requests = ?
          WHERE day = ? AND provider = ? AND credential_id = ? AND requested_model = ?
            AND resolved_model = ? AND api_key_id = ?",
    )?;
    for (key, saved, applied) in groups.values() {
        let counters = [*saved, *applied].map(js::bind_number);
        update.execute(params_from_iter(counters.into_iter().chain(key.bind())))?;
    }
    Ok(())
}

/// `REBUILD`: every bucket `request_logs` says should exist.
const REBUILD: &str = "
  INSERT INTO usage_rollup
    (api_key_id, hour, requests, input_tokens, output_tokens,
     cache_read_tokens, cache_write_tokens, cost_usd)
  SELECT api_key_id,
         CAST(at / 3600000 AS INTEGER),
         COUNT(*),
         COALESCE(SUM(input_tokens), 0),
         COALESCE(SUM(output_tokens), 0),
         COALESCE(SUM(cache_read_tokens), 0),
         COALESCE(SUM(cache_write_tokens), 0),
         COALESCE(SUM(cost_usd), 0)
    FROM request_logs
   WHERE state = 'done' AND api_key_id IS NOT NULL
   GROUP BY api_key_id, CAST(at / 3600000 AS INTEGER)";

/// `rebuildRollup`: recomputes `usage_rollup` from `request_logs`, whole.
/// Runs inside the caller's transaction.
pub fn rebuild_rollup(conn: &Connection) -> Result<(), StoreError> {
    conn.execute("DELETE FROM usage_rollup", [])?;
    conn.execute(REBUILD, [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_and_float_day_math_agree() {
        for at in [0_i64, 1, -1, 86_399_999, 1_794_037_960_689, -86_400_001] {
            for offset in [0, 420, -330, 1440, -1440] {
                #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
                let float = start_of_day(at as f64, offset) as i64;
                assert_eq!(start_of_day_ms(at, offset), float, "{at} {offset}");
            }
        }
    }
}
