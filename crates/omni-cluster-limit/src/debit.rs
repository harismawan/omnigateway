//! Batched long-window debits (spec "Writes": one script call per batch).
//!
//! A debit is queued into the entry of its (bucket hash, count-bucket
//! start) — the start computed exactly as `BUCKETS_ADD` computes it, from the
//! clock at the debit. An entry is an ordered list of *runs*: consecutive
//! debits from one commit (one writer batch) share a run. Every
//! `debit_interval` the pending entries go to the server as
//! [`crate::scripts::DEBIT_BATCH`] calls, in arrival order (split only past
//! `debit_batch_keys` or the request-size bound).
//!
//! **TS's float arithmetic (ruling I5).** Every cost is kept and the script
//! applies them one `HINCRBYFLOAT` each, in debit order, so the stored float
//! is the one TS's per-debit sequence writes. Requests and tokens are
//! integer sums (exact). An entry that would outgrow one call starts a new
//! entry for the same bucket after it, so order is kept across calls.
//!
//! **Seed safety (ruling I1/I2).** Each run carries its rows' commit id. The
//! script applies a run only to a *complete* picture whose seed did not see
//! that commit, so a row counted by a seed — on any replica — is never
//! counted again by its debit, and a row committed after the seed's read is
//! added. While a seed holds the bucket's lock and the picture is
//! incomplete, the script answers *wait*: the entry is kept, ahead of newer
//! ones, and retried once the install lands. Otherwise an incomplete
//! picture ignores the debit, as TS's unseeded buckets do (the next seed
//! reads the committed row).
//!
//! **Bounds and loss (I3).** Pending storage is bounded by `debit_queue`
//! entries and `debit_bytes` estimated bytes (names, commits, every cost and
//! range included). A debit that does not fit, a batch the server did not
//! confirm, and an entry still waiting after `debit_wait_max` are *lost*:
//! counted in [`crate::Metrics::debit_buckets_lost`], logged, and the
//! coordinator's lost-debit flag armed, so every `omni:b:*` key is dropped
//! on the next successful call and reseeded from the store, which has the
//! rows (TS's `lostDebit` policy).

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

/// Fixed overheads in the byte estimate.
const ENTRY_OVERHEAD: usize = 128;
const RUN_OVERHEAD: usize = 64;

/// (bucket hash, count-bucket start bits).
type Slot = (String, u64);

#[derive(Debug, Clone, Default)]
struct Run {
    /// The rows' commit id (`""`: unknown).
    commit: String,
    requests: f64,
    tokens: f64,
    /// Every cost, in debit order.
    costs: Vec<f64>,
    /// Per range-bucket start (bits): least and greatest row `at`.
    ranges: Vec<(u64, f64, f64)>,
}

impl Run {
    fn bytes(&self) -> usize {
        RUN_OVERHEAD + self.commit.len() + self.costs.len() * 24 + self.ranges.len() * 48
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

/// Queues one debit. Past the bounds it is lost (counted, reseed armed).
pub(crate) fn push(inner: &Inner, d: &Debit<'_>) {
    let grain = grain_ms(d.window);
    let start = (d.now / grain).floor() * grain;
    let range = ((d.row_at / grain).floor() * grain).to_bits();
    let slot = (key("b", &bucket_key(d.subject, d.window)), start.to_bits());
    let fits = {
        let mut p = inner.debits.pending();
        let opts = &inner.opts;
        // Into the slot's latest entry when it has room; else a new entry
        // after it (order across calls is arrival order).
        let at = p.last.get(&slot).copied().filter(|i| {
            p.entries[*i].bytes + RUN_OVERHEAD + 96 + d.commit.len() <= MAX_CALL_BYTES / 2
        });
        let added;
        if let Some(i) = at {
            let e = &mut p.entries[i];
            let before = e.bytes;
            match e.runs.last_mut().filter(|r| r.commit == d.commit) {
                Some(r) => {
                    r.requests += d.delta.requests;
                    r.tokens += d.delta.tokens;
                    r.costs.push(d.delta.cost_usd);
                    match r.ranges.iter_mut().find(|x| x.0 == range) {
                        Some(x) => {
                            x.1 = x.1.min(d.row_at);
                            x.2 = x.2.max(d.row_at);
                        }
                        None => r.ranges.push((range, d.row_at, d.row_at)),
                    }
                }
                None => e.runs.push(run(d, range)),
            }
            e.bytes =
                ENTRY_OVERHEAD + e.slot.0.len() + e.runs.iter().map(Run::bytes).sum::<usize>();
            added = e.bytes - before;
            if p.bytes + added > opts.debit_bytes {
                // Undo: drop what was just added (the last cost, and the
                // run or range it created).
                let e = &mut p.entries[i];
                undo_last(e, d);
                false
            } else {
                p.bytes += added;
                true
            }
        } else {
            let r = run(d, range);
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

fn run(d: &Debit<'_>, range: u64) -> Run {
    Run {
        commit: d.commit.to_owned(),
        requests: d.delta.requests,
        tokens: d.delta.tokens,
        costs: vec![d.delta.cost_usd],
        ranges: vec![(range, d.row_at, d.row_at)],
    }
}

/// Reverts the debit just merged into `e` (it did not fit). The range is
/// left widened: a wider range only makes a reset later (the safe side),
/// and the debit's loss arms a reseed that replaces it anyway.
fn undo_last(e: &mut Entry, d: &Debit<'_>) {
    let Some(r) = e.runs.last_mut() else { return };
    if r.costs.len() == 1 {
        e.runs.pop();
    } else {
        r.requests -= d.delta.requests;
        r.tokens -= d.delta.tokens;
        r.costs.pop();
    }
    e.bytes = ENTRY_OVERHEAD + e.slot.0.len() + e.runs.iter().map(Run::bytes).sum::<usize>();
}

fn lost(inner: &Inner, n: u64, why: &'static str) {
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

/// Applies every pending entry now. Entries a seed is waiting on are kept
/// ahead of newer ones (or, past `debit_wait_max`, lost).
pub(crate) async fn flush(inner: &Inner) {
    let _one = inner.debits.flushing.lock().await;
    let batch = inner.debits.pending().take();
    if batch.is_empty() {
        return;
    }
    let mut waiting: Vec<Entry> = Vec::new();
    let mut keys = Vec::new();
    let mut args = Vec::new();
    let mut sent: Vec<Entry> = Vec::new();
    let mut bytes = 0;
    for e in batch {
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
            args.push(crate::js(r.requests));
            args.push(crate::js(r.tokens));
            args.push(r.ranges.len().to_string());
            for (_, lo, hi) in &r.ranges {
                args.push(crate::js(*lo));
                args.push(crate::js(*hi));
            }
            // Every cost in order, zeros included: TS sends one
            // `HINCRBYFLOAT` per debit, and a zero one still creates the
            // field.
            args.push(r.costs.len().to_string());
            args.extend(r.costs.iter().copied().map(crate::js));
        }
        sent.push(e);
        if sent.len() >= inner.opts.debit_batch_keys || bytes >= MAX_CALL_BYTES {
            send(
                inner,
                std::mem::take(&mut keys),
                std::mem::take(&mut args),
                std::mem::take(&mut sent),
                &mut waiting,
            )
            .await;
            bytes = 0;
        }
    }
    if !sent.is_empty() {
        send(inner, keys, args, sent, &mut waiting).await;
    }
    if !waiting.is_empty() {
        requeue(inner, waiting);
    }
}

/// Puts entries a seed is waiting on back, ahead of everything queued since
/// (their debits came first). Past the bounds the oldest waiting are kept
/// and the rest lost.
fn requeue(inner: &Inner, waiting: Vec<Entry>) {
    let mut dropped = 0;
    {
        let mut p = inner.debits.pending();
        let newer = std::mem::take(&mut p.entries);
        let mut all: Vec<Entry> = Vec::with_capacity(waiting.len() + newer.len());
        let mut bytes = 0;
        for e in waiting {
            if all.len() < inner.opts.debit_queue && bytes + e.bytes <= inner.opts.debit_bytes {
                bytes += e.bytes;
                all.push(e);
            } else {
                dropped += 1;
            }
        }
        for e in newer {
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

async fn send(
    inner: &Inner,
    keys: Vec<String>,
    args: Vec<String>,
    sent: Vec<Entry>,
    waiting: &mut Vec<Entry>,
) {
    let n = sent.len() as u64;
    crate::bump(&inner.metrics.debit_batches);
    let out = match inner.remote.eval(&scripts::DEBIT_BATCH, &keys, &args).await {
        Ok(Value::Array(out)) if out.len() == sent.len() => out,
        // Not confirmed: it may or may not have applied. TS's policy for a
        // debit that did not reach the server: reseed on recovery (an
        // applied-and-unconfirmed batch is then simply re-read).
        _ => return lost(inner, n, "debit batch not confirmed"),
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
                    waiting.push(e);
                }
            }
            Value::Array(counts) => {
                let at = |i: usize| match counts.get(i) {
                    Some(Value::Int(x)) => u64::try_from(*x).unwrap_or(0),
                    _ => 0,
                };
                m.debit_runs_applied.fetch_add(at(0), Ordering::Relaxed);
                m.debit_runs_covered.fetch_add(at(1), Ordering::Relaxed);
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

async fn flusher(weak: Weak<Inner>, every: Duration) {
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let Some(inner) = weak.upgrade() else { return };
        if inner.debits.stopped.load(Ordering::SeqCst) {
            return;
        }
        flush(&inner).await;
    }
}

pub(crate) fn stop(inner: &Inner) {
    inner.debits.stopped.store(true, Ordering::SeqCst);
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
