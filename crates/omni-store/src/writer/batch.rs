//! One batch, written in one transaction, leaving exactly the rows the TS
//! store would have left after running the same events one at a time.
//!
//! - **`request_logs`.** The rows the batch touches are read, the events are
//!   replayed against them in memory with the TS statement semantics (`begin`
//!   is a plain INSERT that fails on an existing id, `route` updates only a
//!   pending row, `append` is the `COMPLETE` claim), and each changed row is
//!   written once in one multi-row upsert.
//! - **Rollups.** Each completed row is read back as stored, as `complete`
//!   does, and folded into its `usage_daily` and `usage_rollup` rows in
//!   completion order, starting from what those rows held, with SQLite's
//!   arithmetic. Each rollup row is then written once.
//! - **Health.** The last row per (credential, model) wins, written with the
//!   `UPSERT_HEALTH` statement. A row the foreign key refuses is skipped, as
//!   the TS `updateHealth` throws and changes nothing.

use super::events::{
    BreakerTransition, Completion, HealthMeasurement, LogEvent, PendingLog, RequestLog, WriteEvent,
};
use super::num::Num;
use super::sql::{
    self, DAILY_COUNTERS, DAILY_KEY, HOURLY_COUNTERS, HOURLY_KEY, LOG_COLUMNS, UPSERT_HEALTH,
    Upsert,
};
use crate::error::StoreError;
use crate::{js, rollup};
use indexmap::IndexMap;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{
    Connection, ErrorCode, Row, Transaction, TransactionBehavior, params, params_from_iter,
};
use std::collections::HashMap;

/// What one batch did, for the writer's counters.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Outcome {
    /// Health rows the foreign key refused (no such credential).
    pub(crate) health_refused: u64,
    /// The rows this batch completed, as stored, in completion order: what
    /// the rate limiter is debited with once the batch has committed.
    pub(crate) completions: Vec<Completion>,
}

/// The stored completed row's figures as a [`Completion`].
fn completion(row: &[SqlValue]) -> Result<Completion, StoreError> {
    let get = |name: &str| column(row, name);
    let n = |name: &str| -> Result<f64, StoreError> {
        Ok(js::number(ValueRef::from(&get(name)?)).unwrap_or(0.0))
    };
    let text = |name: &str| -> Result<Option<String>, StoreError> {
        Ok(match get(name)? {
            SqlValue::Text(t) => Some(t),
            _ => None,
        })
    };
    Ok(Completion {
        id: text("id")?.unwrap_or_default(),
        api_key_id: text("api_key_id")?,
        requested_model: text("requested_model")?.unwrap_or_default(),
        tokens: n("input_tokens")?
            + n("output_tokens")?
            + n("cache_read_tokens")?
            + n("cache_write_tokens")?,
        cost_usd: n("cost_usd")?,
        at: n("at")?,
    })
}

// Positions in `LOG_COLUMNS`.
const STATE: usize = 1;
const NODE: usize = 2;
const AT: usize = 3;
const API_KEY: usize = 4;
const REQUESTED_MODEL: usize = 5;
const PROVIDER: usize = 6;
const RESOLVED_MODEL: usize = 7;
const CREDENTIAL: usize = 8;

type LogRow = Vec<SqlValue>;

fn text(s: &str) -> SqlValue {
    SqlValue::Text(s.to_owned())
}

fn opt_text(s: Option<&str>) -> SqlValue {
    s.map_or(SqlValue::Null, text)
}

fn json_strings(items: &[String]) -> SqlValue {
    let array = serde_json::Value::Array(
        items
            .iter()
            .map(|s| serde_json::Value::String(s.clone()))
            .collect(),
    );
    SqlValue::Text(omni_ir::jsjson::to_string(&array))
}

/// `usage.ts` `values(log, state, nodeId)`, bound as `bun:sqlite` binds it.
fn log_values(log: &RequestLog, state: &str, node_id: &str) -> LogRow {
    let int = SqlValue::Integer;
    vec![
        text(&log.id),
        text(state),
        text(node_id),
        int(log.at),
        opt_text(log.api_key_id.as_deref()),
        text(&log.requested_model),
        opt_text(log.resolved_provider.as_deref()),
        opt_text(log.resolved_model.as_deref()),
        opt_text(log.credential_id.as_deref()),
        int(log.attempts),
        int(log.status),
        opt_text(log.error_code.as_deref()),
        int(log.input_tokens),
        int(log.output_tokens),
        int(log.cache_read_tokens),
        int(log.cache_write_tokens),
        log.ttft_ms.map_or(SqlValue::Null, int),
        int(log.duration_ms),
        js::bind_number(log.cost_usd),
        json_strings(&log.degradations),
        int(i64::from(log.rtk_applied)),
        int(log.rtk_filter_hits),
        int(log.rtk_original_code_units),
        int(log.rtk_compressed_code_units),
        int(log.rtk_estimated_tokens_saved),
        json_strings(&log.rtk_filters),
    ]
}

/// `newPendingRequestLog`: placeholders everywhere but the routing fields.
fn pending_log(p: &PendingLog) -> RequestLog {
    let mut log = RequestLog::new(p.id.clone(), p.at, 0);
    log.api_key_id.clone_from(&p.api_key_id);
    log.requested_model.clone_from(&p.requested_model);
    log.resolved_provider.clone_from(&p.resolved_provider);
    log.resolved_model.clone_from(&p.resolved_model);
    log.credential_id.clone_from(&p.credential_id);
    log
}

fn is_pending(row: &LogRow) -> bool {
    matches!(&row[STATE], SqlValue::Text(s) if s == "pending")
}

/// The batch's view of `request_logs`: the rows it touches, as they stand.
struct Logs {
    /// `None` for an id with no row.
    rows: HashMap<String, Option<LogRow>>,
    /// Ids whose row changed, in first-change order.
    dirty: IndexMap<String, ()>,
    /// Ids completed by this batch, in completion order.
    completed: Vec<String>,
}

impl Logs {
    fn load(tx: &Transaction<'_>, events: &[WriteEvent]) -> Result<Self, StoreError> {
        let mut ids: IndexMap<&str, ()> = IndexMap::new();
        for e in events {
            if let WriteEvent::Log(l) = e {
                ids.insert(l.id(), ());
            }
        }
        let ids: Vec<&str> = ids.into_keys().collect();
        let mut rows: HashMap<String, Option<LogRow>> =
            ids.iter().map(|id| ((*id).to_owned(), None)).collect();
        for chunk in ids.chunks(sql::max_variables(tx)?) {
            let mut stmt = tx.prepare_cached(&sql::select_logs(chunk.len()))?;
            let mut found = stmt.query(params_from_iter(chunk))?;
            while let Some(r) = found.next()? {
                let row = read_log_row(r)?;
                if let SqlValue::Text(id) = &row[0] {
                    rows.insert(id.clone(), Some(row));
                }
            }
        }
        Ok(Self {
            rows,
            dirty: IndexMap::new(),
            completed: Vec::new(),
        })
    }

    fn slot(&mut self, id: &str) -> &mut Option<LogRow> {
        self.rows.entry(id.to_owned()).or_default()
    }

    fn apply(&mut self, event: &LogEvent, node_id: &str) {
        match event {
            // A plain INSERT: an id that already has a row makes it throw, and
            // `beginLog` swallows that.
            LogEvent::Begin(p) => {
                let slot = self.slot(&p.id);
                if slot.is_none() {
                    *slot = Some(log_values(&pending_log(p), "pending", node_id));
                    self.dirty.insert(p.id.clone(), ());
                }
            }
            LogEvent::Route { id, target } => {
                if let Some(row) = self.slot(id).as_mut().filter(|r| is_pending(r)) {
                    row[PROVIDER] = text(&target.provider);
                    row[RESOLVED_MODEL] = text(&target.model);
                    row[CREDENTIAL] = text(&target.credential_id);
                    self.dirty.insert(id.clone(), ());
                }
            }
            LogEvent::Finish(log) => {
                let mut next = log_values(log, "done", node_id);
                let slot = self.slot(&log.id);
                match slot {
                    // The claim lost: someone already completed this row.
                    Some(old) if !is_pending(old) => return,
                    // `COMPLETE`'s DO UPDATE: `id`, `node_id` and `at` are
                    // not in its SET list, and two columns fall back.
                    Some(old) => {
                        next[NODE] = old[NODE].clone();
                        next[AT] = old[AT].clone();
                        if log.requested_model.is_empty() {
                            next[REQUESTED_MODEL] = old[REQUESTED_MODEL].clone();
                        }
                        if log.api_key_id.is_none() {
                            next[API_KEY] = old[API_KEY].clone();
                        }
                    }
                    None => {}
                }
                *slot = Some(next);
                self.dirty.insert(log.id.clone(), ());
                self.completed.push(log.id.clone());
            }
        }
    }

    fn write(&self, tx: &Transaction<'_>) -> Result<(), StoreError> {
        let rows: Vec<LogRow> = self
            .dirty
            .keys()
            .filter_map(|id| self.rows.get(id).cloned().flatten())
            .collect();
        Upsert::new("request_logs", &LOG_COLUMNS[..1], &LOG_COLUMNS[1..]).run(tx, &rows)
    }

    /// The completed rows as stored, in completion order: what `complete`
    /// reads back with `SELECT *` before rolling up. A completed row is never
    /// changed again within the batch, so reading them all after the write is
    /// reading each at its completion.
    fn stored_completed(&self, tx: &Transaction<'_>) -> Result<Vec<LogRow>, StoreError> {
        let order: HashMap<&str, usize> = self
            .completed
            .iter()
            .enumerate()
            .map(|(n, id)| (id.as_str(), n))
            .collect();
        let mut stored: Vec<(usize, LogRow)> = Vec::with_capacity(order.len());
        for chunk in self.completed.chunks(sql::max_variables(tx)?) {
            let mut stmt = tx.prepare_cached(&sql::select_logs(chunk.len()))?;
            let mut found = stmt.query(params_from_iter(chunk))?;
            while let Some(r) = found.next()? {
                let row = read_log_row(r)?;
                if let SqlValue::Text(id) = &row[0]
                    && let Some(n) = order.get(id.as_str())
                {
                    stored.push((*n, row));
                }
            }
        }
        stored.sort_by_key(|(n, _)| *n);
        Ok(stored.into_iter().map(|(_, row)| row).collect())
    }
}

fn read_log_row(r: &Row<'_>) -> Result<LogRow, StoreError> {
    Ok((0..LOG_COLUMNS.len())
        .map(|i| r.get::<_, SqlValue>(i))
        .collect::<Result<_, _>>()?)
}

/// A key cell, normalized the way the primary key compares it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum KeyCell {
    Null,
    Int(i64),
    Real(u64),
    Text(String),
    Blob(Vec<u8>),
}

impl KeyCell {
    fn of(v: &SqlValue) -> Self {
        match v {
            SqlValue::Null => Self::Null,
            SqlValue::Integer(i) => Self::Int(*i),
            SqlValue::Real(r) => Self::Real(r.to_bits()),
            SqlValue::Text(t) => Self::Text(t.clone()),
            SqlValue::Blob(b) => Self::Blob(b.clone()),
        }
    }
}

/// A rollup row's bound key and its counters so far (`None`: no row yet).
type Folded = (Vec<SqlValue>, Option<Vec<Num>>);

/// One rollup table's rows touched by the batch, folded in memory.
struct Rollup {
    table: &'static str,
    key: &'static [&'static str],
    counters: &'static [&'static str],
    /// By normalized key, in first-touch order.
    rows: IndexMap<Vec<KeyCell>, Folded>,
    /// Columns whose affinity is REAL (`cost_usd`); the rest are INTEGER.
    real: Vec<bool>,
}

impl Rollup {
    fn new(
        table: &'static str,
        key: &'static [&'static str],
        counters: &'static [&'static str],
    ) -> Self {
        Self {
            table,
            key,
            counters,
            rows: IndexMap::new(),
            real: counters.iter().map(|c| *c == "cost_usd").collect(),
        }
    }

    /// `x = x + excluded.x` for every counter, as the TS upsert does once per
    /// request, against the row as it stood.
    fn add(
        &mut self,
        tx: &Transaction<'_>,
        key: Vec<SqlValue>,
        add: &[Num],
    ) -> Result<(), StoreError> {
        // The key columns are INTEGER (`day`, `hour`) or TEXT; a REAL day or
        // hour that is integral lands as the integer it equals.
        let key: Vec<SqlValue> = key
            .into_iter()
            .map(|v| match v {
                SqlValue::Real(r) => Num::Real(r).integer_affinity().value(),
                other => other,
            })
            .collect();
        let id: Vec<KeyCell> = key.iter().map(KeyCell::of).collect();
        if !self.rows.contains_key(&id) {
            let current = self.read(tx, &key)?;
            self.rows.insert(id.clone(), (key, current));
        }
        let real = &self.real;
        let Some((_, current)) = self.rows.get_mut(&id) else {
            return Ok(());
        };
        let affinity = |n: usize, v: Num| {
            if real[n] {
                v.real_affinity()
            } else {
                v.integer_affinity()
            }
        };
        let next = match current.take() {
            None => add
                .iter()
                .enumerate()
                .map(|(n, v)| affinity(n, *v))
                .collect(),
            Some(row) => row
                .iter()
                .zip(add)
                .enumerate()
                .map(|(n, (have, v))| affinity(n, have.add(affinity(n, *v))))
                .collect(),
        };
        *current = Some(next);
        Ok(())
    }

    fn read(&self, tx: &Transaction<'_>, key: &[SqlValue]) -> Result<Option<Vec<Num>>, StoreError> {
        let mut stmt =
            tx.prepare_cached(&sql::select_counters(self.table, self.key, self.counters))?;
        let mut rows = stmt.query(params_from_iter(key))?;
        let Some(r) = rows.next()? else {
            return Ok(None);
        };
        let mut out = Vec::with_capacity(self.counters.len());
        for (n, c) in self.counters.iter().enumerate() {
            out.push(Num::read(r.get_ref(n)?, &format!("{}.{c}", self.table))?);
        }
        Ok(Some(out))
    }

    fn write(&self, tx: &Transaction<'_>) -> Result<(), StoreError> {
        let rows: Vec<Vec<SqlValue>> = self
            .rows
            .values()
            .filter_map(|(key, row)| {
                row.as_ref().map(|r| {
                    key.iter()
                        .cloned()
                        .chain(r.iter().map(|n| n.value()))
                        .collect()
                })
            })
            .collect();
        Upsert::new(self.table, self.key, self.counters).run(tx, &rows)
    }
}

/// A stored cell as the JS value `toLog` hands the rollup, bound back.
fn cell_number(v: &SqlValue, column: &str) -> Result<Num, StoreError> {
    let n = js::number(ValueRef::from(v))
        .ok_or_else(|| StoreError::Corrupt(format!("request_logs.{column} is not a number")))?;
    Ok(Num::bound(n))
}

/// `log.x ?? ""` for a key column.
fn or_empty(v: &SqlValue) -> SqlValue {
    match v {
        SqlValue::Null => SqlValue::Text(String::new()),
        other => other.clone(),
    }
}

fn column(row: &[SqlValue], name: &str) -> Result<SqlValue, StoreError> {
    LOG_COLUMNS
        .iter()
        .position(|c| *c == name)
        .and_then(|i| row.get(i).cloned())
        .ok_or_else(|| StoreError::Corrupt(format!("request_logs has no {name}")))
}

/// `rollupLog` and `rollupHour` for one stored row.
fn roll_up(
    tx: &Transaction<'_>,
    daily: &mut Rollup,
    hourly: &mut Rollup,
    row: &[SqlValue],
    day_offset_minutes: i64,
) -> Result<(), StoreError> {
    let get = |name: &str| column(row, name);
    let num = |name: &str| -> Result<Num, StoreError> { cell_number(&get(name)?, name) };
    let at = js::number(ValueRef::from(&get("at")?))
        .ok_or_else(|| StoreError::Corrupt("request_logs.at is not a number".into()))?;
    let status = js::number(ValueRef::from(&get("status")?)).unwrap_or(f64::NAN);
    let flag = |b: bool| Num::Int(i64::from(b));
    let rtk_applied = js::is_one(ValueRef::from(&get("rtk_applied")?));

    let day_key = vec![
        js::bind_number(rollup::start_of_day(at, day_offset_minutes)),
        or_empty(&get("resolved_provider")?),
        or_empty(&get("credential_id")?),
        get("requested_model")?,
        or_empty(&get("resolved_model")?),
        or_empty(&get("api_key_id")?),
    ];
    let day_counters = [
        Num::Int(1),
        flag(status >= 400.0),
        num("input_tokens")?,
        num("output_tokens")?,
        num("cache_read_tokens")?,
        num("cache_write_tokens")?,
        num("rtk_estimated_tokens_saved")?,
        flag(rtk_applied),
        num("cost_usd")?,
        num("duration_ms")?,
    ];
    daily.add(tx, day_key, &day_counters)?;

    let api_key = get("api_key_id")?;
    if api_key != SqlValue::Null {
        let hour_counters = [
            Num::Int(1),
            num("input_tokens")?,
            num("output_tokens")?,
            num("cache_read_tokens")?,
            num("cache_write_tokens")?,
            num("cost_usd")?,
        ];
        let hour_key = vec![api_key, js::bind_number(rollup::hour_of(at))];
        hourly.add(tx, hour_key, &hour_counters)?;
    }
    Ok(())
}

/// `UPSERT_HEALTH` for a measurement: the two measured columns only. The
/// inserted row's state is `blankHealth`'s.
const UPSERT_MEASUREMENT: &str = "INSERT INTO credential_health
   (credential_id, model, breaker_state, consecutive_failures, opened_at,
    rate_limited_until)
 VALUES (?, ?, 'closed', ?, NULL, ?)
 ON CONFLICT (credential_id, model) DO UPDATE SET
   consecutive_failures = excluded.consecutive_failures,
   rate_limited_until = excluded.rate_limited_until";

/// Applies one health statement; a foreign-key refusal (no such credential)
/// is what `updateHealth` throws on and writes nothing for, so it undoes only
/// itself and is counted.
fn health_statement(
    tx: &Transaction<'_>,
    sql: &str,
    params: impl rusqlite::Params,
    refused: &mut u64,
) -> Result<(), StoreError> {
    match tx.prepare_cached(sql)?.execute(params) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == ErrorCode::ConstraintViolation => {
            *refused += 1;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

/// Every transition in order, then the last measurement per pair that no later
/// transition overwrote (a transition sets every column, so an earlier
/// measurement can only ever be overwritten by it). The row left is the row
/// applying all of them one by one leaves.
fn write_health(tx: &Transaction<'_>, events: &[WriteEvent]) -> Result<u64, StoreError> {
    let mut measured: IndexMap<(&str, &str), &HealthMeasurement> = IndexMap::new();
    let mut refused = 0;
    for e in events {
        match e {
            WriteEvent::BreakerTransition(BreakerTransition(h)) => {
                measured.shift_remove(&(h.credential_id.as_str(), h.model.as_str()));
                health_statement(
                    tx,
                    UPSERT_HEALTH,
                    params![
                        h.credential_id,
                        h.model,
                        h.breaker_state.as_str(),
                        h.consecutive_failures,
                        h.opened_at.map(js::bind_number),
                        h.rate_limited_until.map(js::bind_number),
                    ],
                    &mut refused,
                )?;
            }
            WriteEvent::HealthMeasurement(m) => {
                measured.insert((&m.credential_id, &m.model), m);
            }
            WriteEvent::Log(_) | WriteEvent::Seed(_) => {}
        }
    }
    for m in measured.values() {
        health_statement(
            tx,
            UPSERT_MEASUREMENT,
            params![
                m.credential_id,
                m.model,
                m.consecutive_failures,
                m.rate_limited_until.map(js::bind_number)
            ],
            &mut refused,
        )?;
    }
    Ok(refused)
}

/// Writes `events` in one transaction. On error nothing of the batch lands.
pub(crate) fn write(
    conn: &mut Connection,
    events: &[WriteEvent],
    node_id: &str,
    day_offset_minutes: i64,
) -> Result<Outcome, StoreError> {
    // IMMEDIATE: the batch reads rows and then writes what it computed from
    // them, so it takes the write lock first (waiting out `busy_timeout`)
    // rather than read a snapshot another connection could commit past.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut logs = Logs::load(&tx, events)?;
    for e in events {
        if let WriteEvent::Log(l) = e {
            logs.apply(l, node_id);
        }
    }
    logs.write(&tx)?;

    let mut daily = Rollup::new("usage_daily", &DAILY_KEY, &DAILY_COUNTERS);
    let mut hourly = Rollup::new("usage_rollup", &HOURLY_KEY, &HOURLY_COUNTERS);
    let mut completions = Vec::new();
    for row in logs.stored_completed(&tx)? {
        roll_up(&tx, &mut daily, &mut hourly, &row, day_offset_minutes)?;
        completions.push(completion(&row)?);
    }
    daily.write(&tx)?;
    hourly.write(&tx)?;

    let health_refused = write_health(&tx, events)?;
    tx.commit()?;
    Ok(Outcome {
        health_refused,
        completions,
    })
}

#[cfg(test)]
#[path = "batch_tests.rs"]
mod tests;
