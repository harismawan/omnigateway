//! One batch on Postgres, written in one transaction, leaving exactly the
//! rows `packages/store/src/postgres` would have left after running the same
//! events one at a time (`usage.begin` / `route` / `append`, then
//! `credentials.updateHealth`).
//!
//! The shape is `batch.rs`'s, with Postgres's types and locks:
//!
//! - **`request_logs`.** The touched rows are read `FOR UPDATE`, the events
//!   are replayed in memory with the TS statement semantics, and every
//!   changed row is written by one `INSERT … SELECT FROM unnest(...)`
//!   upsert. Its `DO UPDATE` is allowed only for ids the batch read and
//!   locked: a row another writer inserted after the read is not
//!   overwritten, the statement reports fewer rows than it was given, and the
//!   batch fails as a [`StoreError::Conflict`], which the writer retries (the
//!   retry reads the new row).
//! - **Rollups.** Each completed row is folded into its `usage_daily` and
//!   `usage_rollup` rows in completion order, in memory, starting from the
//!   row as it stood (read `FOR UPDATE`), with `float8`/`bigint` arithmetic,
//!   so the value written is bit-for-bit the one TS's per-request
//!   `x = x + EXCLUDED.x` reaches. Written by one unnest upsert per table,
//!   under the same read-set guard: two replicas opening the same hour race
//!   on the insert, and the loser retries rather than overwriting.
//! - **Health.** The touched pairs are locked with the advisory lock
//!   `updateHealth` takes (`hashtext(credential|model)`), in a fixed order.
//!   A pair whose credential does not exist is what `updateHealth`'s foreign
//!   key throws on, as is a value its columns cannot hold; either event is
//!   skipped and counted (`health_refused`, per event), without aborting the
//!   batch, and without displacing a valid event before it.
//! - **Refused logs.** A log event with a value Postgres would refuse is
//!   left out (its row stays as it was) and reported in
//!   [`Outcome::refused`]; the task counts it refused and failed.
//!   Every transition is applied in order and the last measurement per pair
//!   after them, as on SQLite.

use super::batch::Outcome;
use super::events::{
    BreakerTransition, Completion, HealthMeasurement, LogEvent, PendingLog, RequestLog, WriteEvent,
};
use crate::error::StoreError;
use crate::rollup;
use deadpool_postgres::GenericClient;
use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};
use tokio_postgres::types::ToSql;

/// One `request_logs` row, typed as the Postgres schema holds it.
#[derive(Debug, Clone, PartialEq)]
struct Row {
    id: String,
    state: String,
    node_id: String,
    at: i64,
    api_key_id: Option<String>,
    requested_model: String,
    resolved_provider: Option<String>,
    resolved_model: Option<String>,
    credential_id: Option<String>,
    attempts: i32,
    status: i32,
    error_code: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    ttft_ms: Option<i64>,
    duration_ms: i64,
    cost_usd: f64,
    degradations: String,
    rtk_applied: bool,
    rtk_filter_hits: i64,
    rtk_original_code_units: i64,
    rtk_compressed_code_units: i64,
    rtk_estimated_tokens_saved: i64,
    rtk_filters: String,
}

const COLUMNS: &str = "id, state, node_id, at, api_key_id, requested_model, resolved_provider,
    resolved_model, credential_id, attempts, status, error_code, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, ttft_ms, duration_ms, cost_usd, degradations,
    rtk_applied, rtk_filter_hits, rtk_original_code_units, rtk_compressed_code_units,
    rtk_estimated_tokens_saved, rtk_filters";

fn json_strings(items: &[String]) -> String {
    let array = serde_json::Value::Array(
        items
            .iter()
            .map(|s| serde_json::Value::String(s.clone()))
            .collect(),
    );
    omni_ir::jsjson::to_string(&array)
}

/// An `INTEGER` column. TS binds the JS number and Postgres refuses one out
/// of range ("integer out of range"), failing that statement; the gateway
/// never produces one, so here it fails the batch with the column named.
fn int4(column: &str, v: i64) -> Result<i32, StoreError> {
    i32::try_from(v).map_err(|_| {
        StoreError::Corrupt(format!(
            "request_logs.{column}: {v} is out of INTEGER range"
        ))
    })
}

/// `usage.ts` `values(log, state, nodeId)`.
fn row_of(log: &RequestLog, state: &str, node_id: &str) -> Result<Row, StoreError> {
    Ok(Row {
        id: log.id.clone(),
        state: state.to_owned(),
        node_id: node_id.to_owned(),
        at: log.at,
        api_key_id: log.api_key_id.clone(),
        requested_model: log.requested_model.clone(),
        resolved_provider: log.resolved_provider.clone(),
        resolved_model: log.resolved_model.clone(),
        credential_id: log.credential_id.clone(),
        attempts: int4("attempts", log.attempts)?,
        status: int4("status", log.status)?,
        error_code: log.error_code.clone(),
        input_tokens: log.input_tokens,
        output_tokens: log.output_tokens,
        cache_read_tokens: log.cache_read_tokens,
        cache_write_tokens: log.cache_write_tokens,
        ttft_ms: log.ttft_ms,
        duration_ms: log.duration_ms,
        // Bound as the double it is: unlike SQLite, `float8` keeps a `-0`.
        cost_usd: log.cost_usd,
        degradations: json_strings(&log.degradations),
        rtk_applied: log.rtk_applied,
        rtk_filter_hits: log.rtk_filter_hits,
        rtk_original_code_units: log.rtk_original_code_units,
        rtk_compressed_code_units: log.rtk_compressed_code_units,
        rtk_estimated_tokens_saved: log.rtk_estimated_tokens_saved,
        rtk_filters: json_strings(&log.rtk_filters),
    })
}

fn pending_log(p: &PendingLog) -> RequestLog {
    let mut log = RequestLog::new(p.id.clone(), p.at, 0);
    log.api_key_id.clone_from(&p.api_key_id);
    log.requested_model.clone_from(&p.requested_model);
    log.resolved_provider.clone_from(&p.resolved_provider);
    log.resolved_model.clone_from(&p.resolved_model);
    log.credential_id.clone_from(&p.credential_id);
    log
}

fn read_row(r: &tokio_postgres::Row) -> Result<Row, StoreError> {
    Ok(Row {
        id: r.try_get(0)?,
        state: r.try_get(1)?,
        node_id: r.try_get(2)?,
        at: r.try_get(3)?,
        api_key_id: r.try_get(4)?,
        requested_model: r.try_get(5)?,
        resolved_provider: r.try_get(6)?,
        resolved_model: r.try_get(7)?,
        credential_id: r.try_get(8)?,
        attempts: r.try_get(9)?,
        status: r.try_get(10)?,
        error_code: r.try_get(11)?,
        input_tokens: r.try_get(12)?,
        output_tokens: r.try_get(13)?,
        cache_read_tokens: r.try_get(14)?,
        cache_write_tokens: r.try_get(15)?,
        ttft_ms: r.try_get(16)?,
        duration_ms: r.try_get(17)?,
        cost_usd: r.try_get(18)?,
        degradations: r.try_get(19)?,
        rtk_applied: r.try_get(20)?,
        rtk_filter_hits: r.try_get(21)?,
        rtk_original_code_units: r.try_get(22)?,
        rtk_compressed_code_units: r.try_get(23)?,
        rtk_estimated_tokens_saved: r.try_get(24)?,
        rtk_filters: r.try_get(25)?,
    })
}

/// The batch's view of `request_logs`.
struct Logs {
    rows: HashMap<String, Option<Row>>,
    /// Ids that had a row when the batch read (and locked) them.
    existed: HashSet<String>,
    dirty: IndexMap<String, ()>,
    completed: Vec<String>,
    /// Completed ids whose request named an unencodable model (transient:
    /// from the completing event, not the row).
    model_unencodable: HashSet<String>,
}

impl Logs {
    async fn load(c: &impl GenericClient, events: &[WriteEvent]) -> Result<Self, StoreError> {
        let mut ids: IndexMap<&str, ()> = IndexMap::new();
        for e in events {
            if let WriteEvent::Log(l) = e {
                ids.insert(l.id(), ());
            }
        }
        let mut ids: Vec<&str> = ids.into_keys().collect();
        let mut rows: HashMap<String, Option<Row>> =
            ids.iter().map(|id| ((*id).to_owned(), None)).collect();
        let mut existed = HashSet::new();
        if !ids.is_empty() {
            // Locked in id order, so two writers over overlapping rows queue
            // rather than deadlock.
            ids.sort_unstable();
            let stmt = c
                .prepare_cached(&format!(
                    "SELECT {COLUMNS} FROM request_logs WHERE id = ANY($1) ORDER BY id FOR UPDATE"
                ))
                .await?;
            for r in c.query(&stmt, &[&ids]).await? {
                let row = read_row(&r)?;
                existed.insert(row.id.clone());
                rows.insert(row.id.clone(), Some(row));
            }
        }
        Ok(Self {
            rows,
            existed,
            dirty: IndexMap::new(),
            completed: Vec::new(),
            model_unencodable: HashSet::new(),
        })
    }

    /// [`Self::apply`], where a log Postgres would refuse a value of (an
    /// `INTEGER` out of range) changes nothing, as TS's `begin`/`append`
    /// throws for that request alone. `false` when refused: the caller
    /// accounts for it as refused (and so failed), never as written.
    fn apply_logged(&mut self, event: &LogEvent, node_id: &str) -> bool {
        match self.apply(event, node_id) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    reason = %e,
                    "request log event refused; the row is left as it was"
                );
                false
            }
        }
    }

    fn slot(&mut self, id: &str) -> &mut Option<Row> {
        self.rows.entry(id.to_owned()).or_default()
    }

    fn apply(&mut self, event: &LogEvent, node_id: &str) -> Result<(), StoreError> {
        match event {
            // A plain INSERT: an id with a row makes it throw, and `beginLog`
            // swallows that.
            LogEvent::Begin(p) => {
                let row = row_of(&pending_log(p), "pending", node_id)?;
                let slot = self.slot(&p.id);
                if slot.is_none() {
                    *slot = Some(row);
                    self.dirty.insert(p.id.clone(), ());
                }
            }
            LogEvent::Route { id, target } => {
                if let Some(row) = self.slot(id).as_mut().filter(|r| r.state == "pending") {
                    row.resolved_provider = Some(target.provider.clone());
                    row.resolved_model = Some(target.model.clone());
                    row.credential_id = Some(target.credential_id.clone());
                    self.dirty.insert(id.clone(), ());
                }
            }
            LogEvent::Finish(log) => {
                let mut next = row_of(log, "done", node_id)?;
                let slot = self.slot(&log.id);
                match slot {
                    // `COMPLETE`'s `WHERE request_logs.state = 'pending'`.
                    Some(old) if old.state != "pending" => return Ok(()),
                    // Its DO UPDATE: `id`, `node_id` and `at` are not in the
                    // SET list, and two columns fall back.
                    Some(old) => {
                        next.node_id.clone_from(&old.node_id);
                        next.at = old.at;
                        if log.requested_model.is_empty() {
                            next.requested_model.clone_from(&old.requested_model);
                        }
                        if log.api_key_id.is_none() {
                            next.api_key_id.clone_from(&old.api_key_id);
                        }
                    }
                    None => {}
                }
                *slot = Some(next);
                self.dirty.insert(log.id.clone(), ());
                self.completed.push(log.id.clone());
                if log.model_unencodable {
                    self.model_unencodable.insert(log.id.clone());
                }
            }
        }
        Ok(())
    }

    async fn write(&self, c: &impl GenericClient) -> Result<(), StoreError> {
        let mut rows: Vec<&Row> = self
            .dirty
            .keys()
            .filter_map(|id| self.rows.get(id).and_then(Option::as_ref))
            .collect();
        if rows.is_empty() {
            return Ok(());
        }
        // Inserted in id order, as they were locked.
        rows.sort_unstable_by(|a, b| a.id.cmp(&b.id));
        macro_rules! col {
            ($f:ident) => {
                rows.iter().map(|r| r.$f.clone()).collect::<Vec<_>>()
            };
        }
        let existed: Vec<&str> = self.existed.iter().map(String::as_str).collect();
        let (id, state, node, at) = (col!(id), col!(state), col!(node_id), col!(at));
        let (key, requested, provider) = (
            col!(api_key_id),
            col!(requested_model),
            col!(resolved_provider),
        );
        let (resolved, credential, attempts, status, error) = (
            col!(resolved_model),
            col!(credential_id),
            col!(attempts),
            col!(status),
            col!(error_code),
        );
        let (input, output, cache_read, cache_write) = (
            col!(input_tokens),
            col!(output_tokens),
            col!(cache_read_tokens),
            col!(cache_write_tokens),
        );
        let (ttft, duration, cost, degradations) = (
            col!(ttft_ms),
            col!(duration_ms),
            col!(cost_usd),
            col!(degradations),
        );
        let (rtk_applied, rtk_hits, rtk_orig, rtk_comp, rtk_saved, rtk_filters) = (
            col!(rtk_applied),
            col!(rtk_filter_hits),
            col!(rtk_original_code_units),
            col!(rtk_compressed_code_units),
            col!(rtk_estimated_tokens_saved),
            col!(rtk_filters),
        );
        let params: [&(dyn ToSql + Sync); 27] = [
            &id,
            &state,
            &node,
            &at,
            &key,
            &requested,
            &provider,
            &resolved,
            &credential,
            &attempts,
            &status,
            &error,
            &input,
            &output,
            &cache_read,
            &cache_write,
            &ttft,
            &duration,
            &cost,
            &degradations,
            &rtk_applied,
            &rtk_hits,
            &rtk_orig,
            &rtk_comp,
            &rtk_saved,
            &rtk_filters,
            &existed,
        ];
        let stmt = c.prepare_cached(UPSERT_LOGS).await?;
        let written = c.execute(&stmt, &params).await?;
        if written != rows.len() as u64 {
            return Err(StoreError::Conflict(format!(
                "request_logs: {} of {} rows were inserted by another writer since the batch read them",
                rows.len() as u64 - written,
                rows.len()
            )));
        }
        Ok(())
    }

    fn completed_rows(&self) -> impl Iterator<Item = &Row> {
        self.completed
            .iter()
            .filter_map(|id| self.rows.get(id).and_then(Option::as_ref))
    }
}

/// The single `INSERT … SELECT FROM unnest(...)` for every changed row.
const UPSERT_LOGS: &str = "INSERT INTO request_logs (id, state, node_id, at, api_key_id,
    requested_model, resolved_provider, resolved_model, credential_id, attempts, status,
    error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ttft_ms,
    duration_ms, cost_usd, degradations, rtk_applied, rtk_filter_hits, rtk_original_code_units,
    rtk_compressed_code_units, rtk_estimated_tokens_saved, rtk_filters)
  SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[],
    $6::text[], $7::text[], $8::text[], $9::text[], $10::int4[], $11::int4[], $12::text[],
    $13::bigint[], $14::bigint[], $15::bigint[], $16::bigint[], $17::bigint[], $18::bigint[],
    $19::float8[], $20::text[], $21::bool[], $22::bigint[], $23::bigint[], $24::bigint[],
    $25::bigint[], $26::text[])
  ON CONFLICT (id) DO UPDATE SET
    state = EXCLUDED.state, node_id = EXCLUDED.node_id, at = EXCLUDED.at,
    api_key_id = EXCLUDED.api_key_id, requested_model = EXCLUDED.requested_model,
    resolved_provider = EXCLUDED.resolved_provider, resolved_model = EXCLUDED.resolved_model,
    credential_id = EXCLUDED.credential_id, attempts = EXCLUDED.attempts,
    status = EXCLUDED.status, error_code = EXCLUDED.error_code,
    input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens, ttft_ms = EXCLUDED.ttft_ms,
    duration_ms = EXCLUDED.duration_ms, cost_usd = EXCLUDED.cost_usd,
    degradations = EXCLUDED.degradations, rtk_applied = EXCLUDED.rtk_applied,
    rtk_filter_hits = EXCLUDED.rtk_filter_hits,
    rtk_original_code_units = EXCLUDED.rtk_original_code_units,
    rtk_compressed_code_units = EXCLUDED.rtk_compressed_code_units,
    rtk_estimated_tokens_saved = EXCLUDED.rtk_estimated_tokens_saved,
    rtk_filters = EXCLUDED.rtk_filters
  WHERE request_logs.id = ANY($27::text[])";

// --- rollups ----------------------------------------------------------------

/// A `usage_daily` key: day, provider, credential, requested, resolved, key.
type DailyKey = (i64, String, String, String, String, String);
/// A `usage_rollup` key: api key, hour.
type HourlyKey = (String, i64);
/// One completed row's contribution to both rollups.
type Rolled = (DailyKey, Daily, Option<(HourlyKey, Hourly)>);

/// `usage_daily`'s counters, in `DAILY_UPSERT` order; `cost_usd` is the
/// one `float8`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Daily {
    requests: i64,
    errors: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    rtk_saved_tokens: i64,
    rtk_applied_requests: i64,
    cost_usd: f64,
    duration_ms_sum: i64,
}

/// `usage_rollup`'s counters.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Hourly {
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    cost_usd: f64,
}

/// `bigint + bigint`, which Postgres refuses on overflow ("bigint out of
/// range"), failing TS's upsert and so its whole `append`.
fn add(table: &str, a: i64, b: i64) -> Result<i64, StoreError> {
    a.checked_add(b)
        .ok_or_else(|| StoreError::Corrupt(format!("{table}: bigint out of range")))
}

/// `float8 + float8`, which Postgres refuses when it overflows to infinity.
fn add_f(table: &str, a: f64, b: f64) -> Result<f64, StoreError> {
    let s = a + b;
    if s.is_infinite() && a.is_finite() && b.is_finite() {
        return Err(StoreError::Corrupt(format!(
            "{table}: value out of range: overflow"
        )));
    }
    Ok(s)
}

impl Daily {
    fn plus(self, o: Self) -> Result<Self, StoreError> {
        const T: &str = "usage_daily";
        Ok(Self {
            requests: add(T, self.requests, o.requests)?,
            errors: add(T, self.errors, o.errors)?,
            input_tokens: add(T, self.input_tokens, o.input_tokens)?,
            output_tokens: add(T, self.output_tokens, o.output_tokens)?,
            cache_read_tokens: add(T, self.cache_read_tokens, o.cache_read_tokens)?,
            cache_write_tokens: add(T, self.cache_write_tokens, o.cache_write_tokens)?,
            rtk_saved_tokens: add(T, self.rtk_saved_tokens, o.rtk_saved_tokens)?,
            rtk_applied_requests: add(T, self.rtk_applied_requests, o.rtk_applied_requests)?,
            cost_usd: add_f(T, self.cost_usd, o.cost_usd)?,
            duration_ms_sum: add(T, self.duration_ms_sum, o.duration_ms_sum)?,
        })
    }
}

impl Hourly {
    fn plus(self, o: Self) -> Result<Self, StoreError> {
        const T: &str = "usage_rollup";
        Ok(Self {
            requests: add(T, self.requests, o.requests)?,
            input_tokens: add(T, self.input_tokens, o.input_tokens)?,
            output_tokens: add(T, self.output_tokens, o.output_tokens)?,
            cache_read_tokens: add(T, self.cache_read_tokens, o.cache_read_tokens)?,
            cache_write_tokens: add(T, self.cache_write_tokens, o.cache_write_tokens)?,
            cost_usd: add_f(T, self.cost_usd, o.cost_usd)?,
        })
    }
}

/// One rollup table's touched rows: key → (existed before the batch,
/// counters so far).
struct Folded<K, V> {
    rows: IndexMap<K, (bool, V)>,
}

impl<K: std::hash::Hash + Eq + Clone, V: Copy + Default> Folded<K, V> {
    fn new() -> Self {
        Self {
            rows: IndexMap::new(),
        }
    }

    /// `x = x + EXCLUDED.x` once per request, against the row as it stood;
    /// a fresh row starts at the request's own values (the INSERT arm).
    fn fold(
        &mut self,
        key: K,
        add: V,
        plus: impl Fn(V, V) -> Result<V, StoreError>,
    ) -> Result<(), StoreError> {
        match self.rows.get_mut(&key) {
            Some((_, have)) => *have = plus(*have, add)?,
            None => {
                self.rows.insert(key, (false, add));
            }
        }
        Ok(())
    }
}

async fn load_daily(
    c: &impl GenericClient,
    keys: &[DailyKey],
) -> Result<HashMap<DailyKey, Daily>, StoreError> {
    let mut sorted: Vec<&DailyKey> = keys.iter().collect();
    sorted.sort();
    sorted.dedup();
    let day: Vec<i64> = sorted.iter().map(|k| k.0).collect();
    let provider: Vec<&str> = sorted.iter().map(|k| k.1.as_str()).collect();
    let cred: Vec<&str> = sorted.iter().map(|k| k.2.as_str()).collect();
    let requested: Vec<&str> = sorted.iter().map(|k| k.3.as_str()).collect();
    let resolved: Vec<&str> = sorted.iter().map(|k| k.4.as_str()).collect();
    let key: Vec<&str> = sorted.iter().map(|k| k.5.as_str()).collect();
    let stmt = c
        .prepare_cached(
            "SELECT d.day, d.provider, d.credential_id, d.requested_model, d.resolved_model,
                    d.api_key_id, d.requests, d.errors, d.input_tokens, d.output_tokens,
                    d.cache_read_tokens, d.cache_write_tokens, d.rtk_saved_tokens,
                    d.rtk_applied_requests, d.cost_usd, d.duration_ms_sum
               FROM usage_daily d
               JOIN unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
                    AS k(day, provider, credential_id, requested_model, resolved_model, api_key_id)
                 ON (d.day, d.provider, d.credential_id, d.requested_model, d.resolved_model,
                     d.api_key_id)
                  = (k.day, k.provider, k.credential_id, k.requested_model, k.resolved_model,
                     k.api_key_id)
              ORDER BY 1, 2, 3, 4, 5, 6
                FOR UPDATE OF d",
        )
        .await?;
    let mut out = HashMap::new();
    for r in c
        .query(
            &stmt,
            &[&day, &provider, &cred, &requested, &resolved, &key],
        )
        .await?
    {
        out.insert(
            (
                r.try_get(0)?,
                r.try_get(1)?,
                r.try_get(2)?,
                r.try_get(3)?,
                r.try_get(4)?,
                r.try_get(5)?,
            ),
            Daily {
                requests: r.try_get(6)?,
                errors: r.try_get(7)?,
                input_tokens: r.try_get(8)?,
                output_tokens: r.try_get(9)?,
                cache_read_tokens: r.try_get(10)?,
                cache_write_tokens: r.try_get(11)?,
                rtk_saved_tokens: r.try_get(12)?,
                rtk_applied_requests: r.try_get(13)?,
                cost_usd: r.try_get(14)?,
                duration_ms_sum: r.try_get(15)?,
            },
        );
    }
    Ok(out)
}

async fn load_hourly(
    c: &impl GenericClient,
    keys: &[(String, i64)],
) -> Result<HashMap<(String, i64), Hourly>, StoreError> {
    let mut sorted: Vec<&(String, i64)> = keys.iter().collect();
    sorted.sort();
    sorted.dedup();
    let key: Vec<&str> = sorted.iter().map(|k| k.0.as_str()).collect();
    let hour: Vec<i64> = sorted.iter().map(|k| k.1).collect();
    let stmt = c
        .prepare_cached(
            "SELECT r.api_key_id, r.hour, r.requests, r.input_tokens, r.output_tokens,
                    r.cache_read_tokens, r.cache_write_tokens, r.cost_usd
               FROM usage_rollup r
               JOIN unnest($1::text[], $2::bigint[]) AS k(api_key_id, hour)
                 ON r.api_key_id = k.api_key_id AND r.hour = k.hour
              ORDER BY 1, 2
                FOR UPDATE OF r",
        )
        .await?;
    let mut out = HashMap::new();
    for r in c.query(&stmt, &[&key, &hour]).await? {
        out.insert(
            (r.try_get(0)?, r.try_get(1)?),
            Hourly {
                requests: r.try_get(2)?,
                input_tokens: r.try_get(3)?,
                output_tokens: r.try_get(4)?,
                cache_read_tokens: r.try_get(5)?,
                cache_write_tokens: r.try_get(6)?,
                cost_usd: r.try_get(7)?,
            },
        );
    }
    Ok(out)
}

const UPSERT_DAILY: &str = "INSERT INTO usage_daily (day, provider, credential_id,
    requested_model, resolved_model, api_key_id, requests, errors, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, rtk_saved_tokens, rtk_applied_requests, cost_usd,
    duration_ms_sum)
  SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[],
    $6::text[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[], $11::bigint[],
    $12::bigint[], $13::bigint[], $14::bigint[], $15::float8[], $16::bigint[])
  ON CONFLICT (day, provider, credential_id, requested_model, resolved_model, api_key_id)
  DO UPDATE SET
    requests = EXCLUDED.requests, errors = EXCLUDED.errors,
    input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens,
    rtk_saved_tokens = EXCLUDED.rtk_saved_tokens,
    rtk_applied_requests = EXCLUDED.rtk_applied_requests,
    cost_usd = EXCLUDED.cost_usd, duration_ms_sum = EXCLUDED.duration_ms_sum
  WHERE EXCLUDED.requests > usage_daily.requests
    AND usage_daily.requests = (SELECT k.requests FROM unnest($17::bigint[], $18::text[],
          $19::text[], $20::text[], $21::text[], $22::text[], $23::bigint[])
        AS k(day, provider, credential_id, requested_model, resolved_model, api_key_id, requests)
       WHERE (k.day, k.provider, k.credential_id, k.requested_model, k.resolved_model,
              k.api_key_id)
           = (usage_daily.day, usage_daily.provider, usage_daily.credential_id,
              usage_daily.requested_model, usage_daily.resolved_model, usage_daily.api_key_id))";

async fn write_daily(
    c: &impl GenericClient,
    folded: &Folded<DailyKey, Daily>,
    before: &HashMap<DailyKey, Daily>,
) -> Result<(), StoreError> {
    if folded.rows.is_empty() {
        return Ok(());
    }
    let rows: Vec<(&DailyKey, &Daily)> = folded.rows.iter().map(|(k, (_, v))| (k, v)).collect();
    macro_rules! k {
        ($i:tt) => {
            rows.iter().map(|(k, _)| k.$i.clone()).collect::<Vec<_>>()
        };
    }
    macro_rules! v {
        ($f:ident) => {
            rows.iter().map(|(_, v)| v.$f).collect::<Vec<_>>()
        };
    }
    let (day, provider, cred, requested, resolved, key) =
        (k!(0), k!(1), k!(2), k!(3), k!(4), k!(5));
    let (requests, errors, input, output) = (
        v!(requests),
        v!(errors),
        v!(input_tokens),
        v!(output_tokens),
    );
    let (cache_read, cache_write, rtk_saved, rtk_applied) = (
        v!(cache_read_tokens),
        v!(cache_write_tokens),
        v!(rtk_saved_tokens),
        v!(rtk_applied_requests),
    );
    let (cost, duration) = (v!(cost_usd), v!(duration_ms_sum));
    // The rows read before the batch, with the request count each held: the
    // DO UPDATE arm is allowed only on one of those, still at that count.
    let seen: Vec<(&DailyKey, i64)> = before.iter().map(|(k, v)| (k, v.requests)).collect();
    let s_day: Vec<i64> = seen.iter().map(|(k, _)| k.0).collect();
    let s_provider: Vec<&str> = seen.iter().map(|(k, _)| k.1.as_str()).collect();
    let s_cred: Vec<&str> = seen.iter().map(|(k, _)| k.2.as_str()).collect();
    let s_requested: Vec<&str> = seen.iter().map(|(k, _)| k.3.as_str()).collect();
    let s_resolved: Vec<&str> = seen.iter().map(|(k, _)| k.4.as_str()).collect();
    let s_key: Vec<&str> = seen.iter().map(|(k, _)| k.5.as_str()).collect();
    let s_requests: Vec<i64> = seen.iter().map(|(_, n)| *n).collect();
    let stmt = c.prepare_cached(UPSERT_DAILY).await?;
    let written = c
        .execute(
            &stmt,
            &[
                &day,
                &provider,
                &cred,
                &requested,
                &resolved,
                &key,
                &requests,
                &errors,
                &input,
                &output,
                &cache_read,
                &cache_write,
                &rtk_saved,
                &rtk_applied,
                &cost,
                &duration,
                &s_day,
                &s_provider,
                &s_cred,
                &s_requested,
                &s_resolved,
                &s_key,
                &s_requests,
            ],
        )
        .await?;
    if written != rows.len() as u64 {
        return Err(StoreError::Conflict(format!(
            "usage_daily: {} of {} rows were written by another writer since the batch read them",
            rows.len() as u64 - written,
            rows.len()
        )));
    }
    Ok(())
}

const UPSERT_HOURLY: &str = "INSERT INTO usage_rollup (api_key_id, hour, requests,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
  SELECT * FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[],
    $6::bigint[], $7::bigint[], $8::float8[])
  ON CONFLICT (api_key_id, hour) DO UPDATE SET
    requests = EXCLUDED.requests, input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens, cache_read_tokens = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens, cost_usd = EXCLUDED.cost_usd
  WHERE EXCLUDED.requests > usage_rollup.requests
    AND usage_rollup.requests = (SELECT k.requests
          FROM unnest($9::text[], $10::bigint[], $11::bigint[]) AS k(api_key_id, hour, requests)
         WHERE k.api_key_id = usage_rollup.api_key_id AND k.hour = usage_rollup.hour)";

async fn write_hourly(
    c: &impl GenericClient,
    folded: &Folded<(String, i64), Hourly>,
    before: &HashMap<(String, i64), Hourly>,
) -> Result<(), StoreError> {
    if folded.rows.is_empty() {
        return Ok(());
    }
    let rows: Vec<(&(String, i64), &Hourly)> =
        folded.rows.iter().map(|(k, (_, v))| (k, v)).collect();
    let key: Vec<&str> = rows.iter().map(|(k, _)| k.0.as_str()).collect();
    let hour: Vec<i64> = rows.iter().map(|(k, _)| k.1).collect();
    macro_rules! v {
        ($f:ident) => {
            rows.iter().map(|(_, v)| v.$f).collect::<Vec<_>>()
        };
    }
    let (requests, input, output) = (v!(requests), v!(input_tokens), v!(output_tokens));
    let (cache_read, cache_write, cost) =
        (v!(cache_read_tokens), v!(cache_write_tokens), v!(cost_usd));
    let s_key: Vec<&str> = before.keys().map(|k| k.0.as_str()).collect();
    let s_hour: Vec<i64> = before.keys().map(|k| k.1).collect();
    let s_requests: Vec<i64> = before.values().map(|v| v.requests).collect();
    let stmt = c.prepare_cached(UPSERT_HOURLY).await?;
    let written = c
        .execute(
            &stmt,
            &[
                &key,
                &hour,
                &requests,
                &input,
                &output,
                &cache_read,
                &cache_write,
                &cost,
                &s_key,
                &s_hour,
                &s_requests,
            ],
        )
        .await?;
    if written != rows.len() as u64 {
        return Err(StoreError::Conflict(format!(
            "usage_rollup: {} of {} rows were written by another writer since the batch read them",
            rows.len() as u64 - written,
            rows.len()
        )));
    }
    Ok(())
}

/// `rollupLog` and `rollupHour` for one stored row, as TS binds them.
fn roll_up(row: &Row, day_offset_minutes: i64) -> Result<Rolled, StoreError> {
    let day = rollup::start_of_day_ms(row.at, day_offset_minutes);
    let key = (
        day,
        row.resolved_provider.clone().unwrap_or_default(),
        row.credential_id.clone().unwrap_or_default(),
        row.requested_model.clone(),
        row.resolved_model.clone().unwrap_or_default(),
        row.api_key_id.clone().unwrap_or_default(),
    );
    let daily = Daily {
        requests: 1,
        errors: i64::from(row.status >= 400),
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_write_tokens: row.cache_write_tokens,
        rtk_saved_tokens: row.rtk_estimated_tokens_saved,
        rtk_applied_requests: i64::from(row.rtk_applied),
        cost_usd: row.cost_usd,
        duration_ms_sum: row.duration_ms,
    };
    let hourly = row.api_key_id.as_ref().map(|k| {
        (
            (k.clone(), row.at.div_euclid(3_600_000)),
            Hourly {
                requests: 1,
                input_tokens: row.input_tokens,
                output_tokens: row.output_tokens,
                cache_read_tokens: row.cache_read_tokens,
                cache_write_tokens: row.cache_write_tokens,
                cost_usd: row.cost_usd,
            },
        )
    });
    Ok((key, daily, hourly))
}

fn completion(row: &Row, debit_model: bool) -> Completion {
    #[allow(clippy::cast_precision_loss)]
    let n = |v: i64| v as f64;
    Completion {
        id: row.id.clone(),
        api_key_id: row.api_key_id.clone(),
        requested_model: row.requested_model.clone(),
        tokens: n(row.input_tokens)
            + n(row.output_tokens)
            + n(row.cache_read_tokens)
            + n(row.cache_write_tokens),
        cost_usd: row.cost_usd,
        at: n(row.at),
        debit_model,
    }
}

// --- health -----------------------------------------------------------------

/// `UPSERT_HEALTH` with the instants bound as TS binds a JS number into a
/// `BIGINT` column: as `float8`, which Postgres rounds (half to even).
const UPSERT_HEALTH: &str = "INSERT INTO credential_health
   (credential_id, model, breaker_state, consecutive_failures, opened_at, rate_limited_until)
 VALUES ($1, $2, $3, $4, $5::float8::bigint, $6::float8::bigint)
 ON CONFLICT (credential_id, model) DO UPDATE SET
   breaker_state = EXCLUDED.breaker_state,
   consecutive_failures = EXCLUDED.consecutive_failures,
   opened_at = EXCLUDED.opened_at,
   rate_limited_until = EXCLUDED.rate_limited_until";

/// A measurement: the two measured columns only; a fresh row is
/// `blankHealth`'s.
const UPSERT_MEASUREMENT: &str = "INSERT INTO credential_health
   (credential_id, model, breaker_state, consecutive_failures, opened_at, rate_limited_until)
 VALUES ($1, $2, 'closed', $3, NULL, $4::float8::bigint)
 ON CONFLICT (credential_id, model) DO UPDATE SET
   consecutive_failures = EXCLUDED.consecutive_failures,
   rate_limited_until = EXCLUDED.rate_limited_until";

/// A JS number bound into a `BIGINT` column: refused (as `updateHealth`
/// throws) when it is not finite or rounds outside `int8`.
fn instant_ok(v: Option<f64>) -> bool {
    v.is_none_or(|v| {
        v.is_finite()
            && v.round_ties_even() >= -9.223_372_036_854_775e18
            && v.round_ties_even() < 9.223_372_036_854_775e18
    })
}

/// The row a health write would bind, or `None` where Postgres would refuse
/// it (and TS's `updateHealth` throw, changing nothing).
fn health_ok(failures: i64, opened: Option<f64>, until: Option<f64>) -> Option<i32> {
    let failures = i32::try_from(failures).ok()?;
    (instant_ok(opened) && instant_ok(until)).then_some(failures)
}

async fn write_health(c: &impl GenericClient, events: &[WriteEvent]) -> Result<u64, StoreError> {
    let mut pairs: Vec<(&str, &str)> = Vec::new();
    for e in events {
        match e {
            WriteEvent::BreakerTransition(BreakerTransition(h)) => {
                pairs.push((&h.credential_id, &h.model));
            }
            WriteEvent::HealthMeasurement(m) => pairs.push((&m.credential_id, &m.model)),
            WriteEvent::Log(_) | WriteEvent::Seed(_) => {}
        }
    }
    if pairs.is_empty() {
        return Ok(0);
    }
    // `updateHealth`'s advisory lock per pair, taken in one fixed order.
    let mut locks: Vec<String> = pairs.iter().map(|(c, m)| format!("{c}|{m}")).collect();
    locks.sort_unstable();
    locks.dedup();
    let stmt = c
        .prepare_cached(
            "SELECT pg_advisory_xact_lock(hashtext(k)) FROM unnest($1::text[]) AS k ORDER BY k",
        )
        .await?;
    c.execute(&stmt, &[&locks]).await?;
    // The foreign key, checked up front: a missing credential is what
    // `updateHealth` throws on, and on Postgres a refused statement would
    // abort the whole batch. `FOR KEY SHARE` keeps the credential from going
    // away before commit, as the foreign key itself would.
    let mut ids: Vec<&str> = pairs.iter().map(|(c, _)| *c).collect();
    ids.sort_unstable();
    ids.dedup();
    let stmt = c
        .prepare_cached("SELECT id FROM credentials WHERE id = ANY($1) ORDER BY id FOR KEY SHARE")
        .await?;
    let known: HashSet<String> = c
        .query(&stmt, &[&ids])
        .await?
        .iter()
        .map(|r| r.try_get(0))
        .collect::<Result<_, _>>()?;

    // Each event is validated where it stands, as TS's sequential
    // `updateHealth` calls each throw (or not) on their own: a refused event
    // never displaces one that would have landed before it.
    let mut measured: IndexMap<(&str, &str), (&HealthMeasurement, i32)> = IndexMap::new();
    let mut refused = 0;
    let transition = c.prepare_cached(UPSERT_HEALTH).await?;
    for e in events {
        match e {
            WriteEvent::BreakerTransition(BreakerTransition(h)) => {
                let Some(failures) =
                    health_ok(h.consecutive_failures, h.opened_at, h.rate_limited_until)
                        .filter(|_| h.scalar.is_none() && known.contains(&h.credential_id))
                else {
                    // Refused: the measurement before it still stands.
                    refused += 1;
                    continue;
                };
                // Only a transition that lands overwrites what came before.
                measured.shift_remove(&(h.credential_id.as_str(), h.model.as_str()));
                c.execute(
                    &transition,
                    &[
                        &h.credential_id,
                        &h.model,
                        &h.breaker_state.as_str(),
                        &failures,
                        &h.opened_at,
                        &h.rate_limited_until,
                    ],
                )
                .await?;
            }
            WriteEvent::HealthMeasurement(m) => {
                match health_ok(m.consecutive_failures, None, m.rate_limited_until)
                    .filter(|_| known.contains(&m.credential_id))
                {
                    Some(failures) => {
                        measured.insert((&m.credential_id, &m.model), (m, failures));
                    }
                    // Refused: the measurement before it still stands.
                    None => refused += 1,
                }
            }
            WriteEvent::Log(_) | WriteEvent::Seed(_) => {}
        }
    }
    let measurement = c.prepare_cached(UPSERT_MEASUREMENT).await?;
    for (m, failures) in measured.values() {
        c.execute(
            &measurement,
            &[&m.credential_id, &m.model, &failures, &m.rate_limited_until],
        )
        .await?;
    }
    Ok(refused)
}

/// Writes `events` in one transaction. On error nothing of the batch lands.
pub(crate) async fn write(
    client: &mut crate::pg::PgClient,
    events: &[WriteEvent],
    node_id: &str,
    day_offset_minutes: i64,
) -> Result<Outcome, StoreError> {
    let tx = client.transaction().await?;
    let mut logs = Logs::load(&tx, events).await?;
    let mut refused = Vec::new();
    let mut log_notifications = 0;
    let mut finish_notifications = 0;
    for (i, e) in events.iter().enumerate() {
        if let WriteEvent::Log(l) = e {
            let publishes = !matches!(l, LogEvent::Begin(p) if logs.rows.get(&p.id).is_some_and(Option::is_some));
            if !logs.apply_logged(l, node_id) {
                refused.push(i);
            } else if publishes {
                log_notifications += 1;
                finish_notifications += usize::from(matches!(l, LogEvent::Finish(_)));
            }
        }
    }
    logs.write(&tx).await?;

    let mut rolled = Vec::new();
    let mut completions = Vec::new();
    for row in logs.completed_rows() {
        rolled.push(roll_up(row, day_offset_minutes)?);
        completions.push(completion(row, !logs.model_unencodable.contains(&row.id)));
    }
    let daily_keys: Vec<DailyKey> = rolled.iter().map(|(k, _, _)| k.clone()).collect();
    let hourly_keys: Vec<(String, i64)> = rolled
        .iter()
        .filter_map(|(_, _, h)| h.as_ref().map(|(k, _)| k.clone()))
        .collect();
    // Lock order, the same in every writer (and TS's `append`):
    // `request_logs`, then `usage_daily` read and written, then
    // `usage_rollup` read and written, then health. Within a table rows
    // are locked and written in key order, so two replicas over the same
    // rows queue rather than deadlock.
    let daily_before = if daily_keys.is_empty() {
        HashMap::new()
    } else {
        load_daily(&tx, &daily_keys).await?
    };
    let mut daily: Folded<DailyKey, Daily> = Folded::new();
    for (k, v) in &daily_before {
        daily.rows.insert(k.clone(), (true, *v));
    }
    for (dk, dv, _) in &rolled {
        daily.fold(dk.clone(), *dv, Daily::plus)?;
    }
    daily.rows.sort_unstable_keys();
    write_daily(&tx, &daily, &daily_before).await?;

    let hourly_before = if hourly_keys.is_empty() {
        HashMap::new()
    } else {
        load_hourly(&tx, &hourly_keys).await?
    };
    let mut hourly: Folded<HourlyKey, Hourly> = Folded::new();
    for (k, v) in &hourly_before {
        hourly.rows.insert(k.clone(), (true, *v));
    }
    for (_, _, h) in rolled {
        if let Some((hk, hv)) = h {
            hourly.fold(hk, hv, Hourly::plus)?;
        }
    }
    hourly.rows.sort_unstable_keys();
    write_hourly(&tx, &hourly, &hourly_before).await?;

    let health_refused = write_health(&tx, events).await?;
    tx.commit().await?;
    Ok(Outcome {
        log_notifications,
        finish_notifications,
        health_refused,
        completions,
        refused,
    })
}
