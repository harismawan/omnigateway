//! Batched long-window debits (spec "Writes": one script call per batch).
//!
//! A debit is queued into the entry of its (bucket hash, count-bucket
//! start) — the start computed exactly as `BUCKETS_ADD` computes it, from the
//! clock at the debit. An entry is an ordered list of *runs*: consecutive
//! debits from one commit (one writer transaction) share a run, and each
//! run keeps its rows — `(row at, tokens, cost)` — in debit order. Every
//! `debit_interval` the pending entries go to the server as
//! [`crate::scripts::DEBIT_BATCH`] calls, in arrival order (split only past
//! `debit_batch_keys` or the request-size bound).
//!
//! **TS's float arithmetic (ruling I5).** Every cost is applied by its own
//! `HINCRBYFLOAT`, in debit order, so the stored float is the one TS's
//! per-debit sequence writes. Requests and tokens are integer sums (exact).
//! An entry that would outgrow one call starts a new entry for the same
//! bucket after it, so order is kept across calls.
//!
//! **Seed safety (rulings I1/I2, R1).** Each row is skipped exactly when the
//! picture's seed counted it: its commit is visible to the seed's snapshot
//! **and** its `at` is inside the seed's row selection. Every other row is
//! added — a row committed after the read, and a row of an already-visible
//! commit that the seed's time filter excluded (a long stream started
//! before the window), even when one transaction holds both kinds. While a
//! seed holds the bucket's lock and the picture is incomplete, the script
//! answers *wait*: the entry is kept, ahead of newer ones, and retried once
//! the install lands. Otherwise an incomplete picture ignores the debit, as
//! TS's unseeded buckets do (the next seed reads the committed row; seeds
//! install only under their lock, so no seed can be in its read then).
//!
//! **Bounds and loss (I3, R3).** Pending storage is bounded by
//! `debit_queue` entries and `debit_bytes` estimated bytes (names, commits,
//! every row). A debit's charge is computed before anything is changed; one
//! that does not fit changes nothing. A debit that does not fit, a batch the
//! server did not confirm, and an entry still waiting after `debit_wait_max`
//! are *lost*: counted in [`crate::Metrics::debit_buckets_lost`], logged,
//! and the coordinator's lost-debit flag armed, so every `omni:b:*` key is
//! dropped on the next successful call and reseeded from the store, which
//! has the rows (TS's `lostDebit` policy).
//!
//! **Cancellation (R2).** A flush owns the entries it took through a guard:
//! if the flush is dropped (shutdown, or a cancelled `flush_debits`), the
//! entries not yet sent and those waiting on a seed are put back ahead of
//! newer ones, and those in the send that was in flight — which may or may
//! not have applied — are counted lost (reseed armed). Nothing is dropped
//! silently.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use omni_coord::Counts;
use omni_coord::redis::key;
use omni_ratelimit::Window;
use redis::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::subject::{bucket_key, grain_ms};
use crate::{Inner, scripts};

/// A bound on one call's arguments (bytes, roughly), under D2's 1 MiB
/// request cap with the script-source fallback beside it.
const MAX_CALL_BYTES: usize = 256 * 1024;

/// Byte estimate: fixed overheads, and per row (`at`, tokens, cost).
const ENTRY_OVERHEAD: usize = 128;
const RUN_OVERHEAD: usize = 64;
const ROW_BYTES: usize = 72;

/// (bucket hash, count-bucket start bits).
type Slot = (String, u64);

#[derive(Debug, Clone, Default)]
struct Run {
    /// The rows' commit id (`""`: unknown).
    commit: String,
    /// `(row at, tokens, cost)`, in debit order.
    rows: Vec<(f64, f64, f64)>,
}

impl Run {
    fn bytes(&self) -> usize {
        RUN_OVERHEAD + self.commit.len() + self.rows.len() * ROW_BYTES
    }
}

#[derive(Debug, Clone)]
struct Entry {
    slot: Slot,
    grain_ms: f64,
    window_ms: f64,
    runs: Vec<Run>,
    /// When the server first answered *wait* for this entry.
    waiting_since: Option<Instant>,
    bytes: usize,
}

impl Entry {
    fn recount(&self) -> usize {
        ENTRY_OVERHEAD + self.slot.0.len() + self.runs.iter().map(Run::bytes).sum::<usize>()
    }
}

#[derive(Default)]
struct Pending {
    /// In arrival order.
    entries: Vec<Entry>,
    /// The latest entry of each slot (index into `entries`).
    last: HashMap<Slot, usize>,
    bytes: usize,
}

impl Pending {
    fn take(&mut self) -> Vec<Entry> {
        self.last.clear();
        self.bytes = 0;
        std::mem::take(&mut self.entries)
    }

    fn reindex(&mut self) {
        self.last.clear();
        self.bytes = 0;
        for (i, e) in self.entries.iter().enumerate() {
            self.last.insert(e.slot.clone(), i);
            self.bytes += e.bytes;
        }
    }
}

#[derive(Default)]
pub(crate) struct Debits {
    pending: Mutex<Pending>,
    /// One flush at a time, so batches apply in order.
    flushing: AsyncMutex<()>,
    stopped: AtomicBool,
}

impl Debits {
    fn pending(&self) -> std::sync::MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Entries and estimated bytes pending.
    pub(crate) fn usage(&self) -> (usize, usize) {
        let p = self.pending();
        (p.entries.len(), p.bytes)
    }

    /// Every retained entry's bytes, recomputed from its contents.
    pub(crate) fn audit(&self) -> usize {
        self.pending().entries.iter().map(Entry::recount).sum()
    }
}

/// One debit, as queued.
pub(crate) struct Debit<'a> {
    pub subject: &'a str,
    pub window: Window,
    pub now: f64,
    pub row_at: f64,
    pub commit: &'a str,
    pub delta: Counts,
}

/// Queues one debit. Past the bounds it is lost (counted, reseed armed) and
/// nothing pending changes.
pub(crate) fn push(inner: &Inner, d: &Debit<'_>) {
    let grain = grain_ms(d.window);
    let start = (d.now / grain).floor() * grain;
    let slot = (key("b", &bucket_key(d.subject, d.window)), start.to_bits());
    let row = (d.row_at, d.delta.tokens, d.delta.cost_usd);
    let fits = {
        let mut p = inner.debits.pending();
        let opts = &inner.opts;
        // Into the slot's latest entry when it has room; else a new entry
        // after it (order across calls is arrival order).
        let at = p.last.get(&slot).copied().filter(|i| {
            p.entries[*i].bytes + RUN_OVERHEAD + ROW_BYTES + d.commit.len() <= MAX_CALL_BYTES / 2
        });
        if let Some(i) = at {
            // The charge first; mutate only if it fits.
            let same_run = p.entries[i]
                .runs
                .last()
                .is_some_and(|r| r.commit == d.commit);
            let charge = if same_run {
                ROW_BYTES
            } else {
                RUN_OVERHEAD + d.commit.len() + ROW_BYTES
            };
            if p.bytes + charge > opts.debit_bytes {
                false
            } else {
                let e = &mut p.entries[i];
                match e.runs.last_mut().filter(|_| same_run) {
                    Some(r) => r.rows.push(row),
                    None => e.runs.push(Run {
                        commit: d.commit.to_owned(),
                        rows: vec![row],
                    }),
                }
                e.bytes += charge;
                debug_assert_eq!(e.bytes, e.recount());
                p.bytes += charge;
                true
            }
        } else {
            let r = Run {
                commit: d.commit.to_owned(),
                rows: vec![row],
            };
            let bytes = ENTRY_OVERHEAD + slot.0.len() + r.bytes();
            if p.entries.len() >= opts.debit_queue || p.bytes + bytes > opts.debit_bytes {
                false
            } else {
                let i = p.entries.len();
                p.entries.push(Entry {
                    slot: slot.clone(),
                    grain_ms: grain,
                    window_ms: d.window.ms(),
                    runs: vec![r],
                    waiting_since: None,
                    bytes,
                });
                p.last.insert(slot, i);
                p.bytes += bytes;
                true
            }
        }
    };
    if fits {
        crate::bump(&inner.metrics.debits_queued);
    } else {
        lost(inner, 1, "debit queue full");
    }
}

pub(crate) fn lost(inner: &Inner, n: u64, why: &'static str) {
    if n == 0 {
        return;
    }
    inner
        .metrics
        .debit_buckets_lost
        .fetch_add(n, Ordering::Relaxed);
    inner.remote.note_lost_debit();
    tracing::warn!(
        coord = "redis",
        buckets = n,
        reason = why,
        "rate limit debits lost; buckets reseed from the store on recovery"
    );
}

/// `omni:lock:seed:<bucket>` for a full `omni:b:<bucket>` hash name — the
/// lock TS's `seed` takes (`withLock("seed:" + bucketKey)`).
pub(crate) fn lock_key(hash: &str) -> String {
    key(
        "lock",
        &format!("seed:{}", hash.strip_prefix("omni:b:").unwrap_or(hash)),
    )
}

/// What one flush has taken out of `pending`, until it is settled. Dropped
/// before settling (the flush was cancelled): unsent and waiting entries go
/// back ahead of newer ones; the in-flight send's entries are counted lost.
struct Owned<'a> {
    inner: &'a Inner,
    /// Not yet sent, in order.
    unsent: std::collections::VecDeque<Entry>,
    /// In the send now awaiting its reply.
    in_flight: Vec<Entry>,
    /// Answered *wait*: to be put back.
    waiting: Vec<Entry>,
}

impl Drop for Owned<'_> {
    fn drop(&mut self) {
        let uncertain = self.in_flight.len() as u64;
        self.in_flight.clear();
        lost(
            self.inner,
            uncertain,
            "debit batch cancelled before its reply",
        );
        let mut back: Vec<Entry> = std::mem::take(&mut self.waiting);
        back.extend(self.unsent.drain(..));
        if !back.is_empty() {
            requeue(self.inner, back);
        }
    }
}

/// Applies every pending entry now. Entries a seed is waiting on are kept
/// ahead of newer ones (or, past `debit_wait_max`, lost). Cancel-safe.
pub(crate) async fn flush(inner: &Inner) {
    flush_until(inner, false).await;
}

/// [`flush`], or — `yield_to_stop` — stopping after the send in flight once
/// a stop is asked for (the periodic flusher): what was not sent goes back
/// to `pending` for the shutdown drain.
async fn flush_until(inner: &Inner, yield_to_stop: bool) {
    let _one = inner.debits.flushing.lock().await;
    let mut own = Owned {
        inner,
        unsent: inner.debits.pending().take().into(),
        in_flight: Vec::new(),
        waiting: Vec::new(),
    };
    while !own.unsent.is_empty() {
        if yield_to_stop && inner.debits.stopped.load(Ordering::SeqCst) {
            break;
        }
        let mut keys = Vec::new();
        let mut args = Vec::new();
        let mut bytes = 0;
        while let Some(e) = own.unsent.front() {
            if !own.in_flight.is_empty()
                && (own.in_flight.len() >= inner.opts.debit_batch_keys || bytes >= MAX_CALL_BYTES)
            {
                break;
            }
            bytes += e.bytes;
            let (name, start) = &e.slot;
            keys.push(name.clone());
            keys.push(scripts::meta_key(name));
            keys.push(lock_key(name));
            args.push(crate::js(f64::from_bits(*start)));
            args.push(crate::js(e.grain_ms));
            args.push(crate::js(e.window_ms));
            args.push(e.runs.len().to_string());
            for r in &e.runs {
                args.push(r.commit.clone());
                args.push(r.rows.len().to_string());
                for (at, tokens, cost) in &r.rows {
                    // Every cost, zeros included: TS sends one
                    // `HINCRBYFLOAT` per debit, and a zero one still
                    // creates the field.
                    args.push(crate::js(*at));
                    args.push(crate::js(*tokens));
                    args.push(crate::js(*cost));
                }
            }
            if let Some(e) = own.unsent.pop_front() {
                own.in_flight.push(e);
            }
        }
        send(inner, &keys, &args, &mut own).await;
    }
    // Settled: the guard puts the waiting (and any unsent) entries back.
}

/// Puts entries back ahead of everything queued since (their debits came
/// first). Past the bounds the earliest are kept and the rest lost.
fn requeue(inner: &Inner, back: Vec<Entry>) {
    let mut dropped = 0;
    {
        let mut p = inner.debits.pending();
        let newer = std::mem::take(&mut p.entries);
        let mut all: Vec<Entry> = Vec::with_capacity(back.len() + newer.len());
        let mut bytes = 0;
        for e in back.into_iter().chain(newer) {
            if all.len() < inner.opts.debit_queue && bytes + e.bytes <= inner.opts.debit_bytes {
                bytes += e.bytes;
                all.push(e);
            } else {
                dropped += 1;
            }
        }
        p.entries = all;
        p.reindex();
    }
    lost(inner, dropped, "debit queue full while waiting on a seed");
}

async fn send(inner: &Inner, keys: &[String], args: &[String], own: &mut Owned<'_>) {
    crate::bump(&inner.metrics.debit_batches);
    let reply = inner.remote.eval(&scripts::DEBIT_BATCH, keys, args).await;
    let sent = std::mem::take(&mut own.in_flight);
    let out = match reply {
        Ok(Value::Array(out)) if out.len() == sent.len() => out,
        // Not confirmed: it may or may not have applied. TS's policy for a
        // debit that did not reach the server: reseed on recovery (an
        // applied-and-unconfirmed batch is then simply re-read).
        _ => return lost(inner, sent.len() as u64, "debit batch not confirmed"),
    };
    let m = &inner.metrics;
    let mut expired = 0;
    for (mut e, v) in sent.into_iter().zip(out) {
        match v {
            Value::Int(2) => {
                let since = *e.waiting_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= inner.opts.debit_wait_max {
                    expired += 1;
                } else {
                    crate::bump(&m.debit_buckets_waiting);
                    own.waiting.push(e);
                }
            }
            Value::Array(counts) => {
                let at = |i: usize| match counts.get(i) {
                    Some(Value::Int(x)) => u64::try_from(*x).unwrap_or(0),
                    _ => 0,
                };
                m.debit_rows_applied.fetch_add(at(0), Ordering::Relaxed);
                m.debit_rows_covered.fetch_add(at(1), Ordering::Relaxed);
                crate::bump(&m.debit_buckets_applied);
            }
            _ => crate::bump(&m.debit_buckets_unseeded),
        }
    }
    lost(inner, expired, "debit waited past its bound on a seed");
}

pub(crate) fn spawn(inner: &Arc<Inner>) -> tokio::task::JoinHandle<()> {
    let weak = Arc::downgrade(inner);
    let every = inner.opts.debit_interval;
    tokio::spawn(flusher(weak, every))
}

/// The periodic flusher. Stopped cooperatively: it finishes the send it is
/// awaiting (bounded by the command deadline), puts back what it had not
/// sent, and returns.
async fn flusher(weak: Weak<Inner>, every: Duration) {
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let stop = {
            let Some(inner) = weak.upgrade() else { return };
            Arc::clone(&inner.debits_stop)
        };
        tokio::select! {
            _ = tick.tick() => {}
            () = stop.notified() => return,
        }
        let Some(inner) = weak.upgrade() else { return };
        if inner.debits.stopped.load(Ordering::SeqCst) {
            return;
        }
        flush_until(&inner, true).await;
    }
}

/// Asks the flusher to stop once its current flush (if any) is done.
pub(crate) fn stop(inner: &Inner) {
    inner.debits.stopped.store(true, Ordering::SeqCst);
    inner.debits_stop.notify_one();
}

/// Shutdown: flushes until nothing is pending, keeping entries a seed is
/// waiting on until `deadline`; whatever is left then is lost (counted,
/// reseed armed) — never silently dropped.
pub(crate) async fn drain(inner: &Inner, deadline: tokio::time::Instant) {
    loop {
        flush(inner).await;
        if inner.debits.usage().0 == 0 {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            let n = inner.debits.pending().take().len();
            lost(inner, n as u64, "debits pending at shutdown");
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
