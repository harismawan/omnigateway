//! Batched long-window debits (spec "Writes": one script call per batch).
//!
//! Each debit is aggregated into its (bucket hash, bucket start) entry —
//! the start computed exactly as `BUCKETS_ADD` computes it, from the clock
//! at the debit — and every `debit_interval` the pending entries go to the
//! server as one [`crate::scripts::DEBIT_BATCH`] call (split only past
//! `debit_batch_keys` or the request-size bound). The applied state equals
//! the per-debit `BUCKETS_ADD` sequence: integer sums for requests and
//! tokens, and each cost added by its own `HINCRBYFLOAT` in order.
//!
//! Loss policy (TS `lostDebit`): a batch the server did not confirm, or a
//! debit refused by a full queue, is counted in
//! [`crate::Metrics::debit_buckets_lost`] and marks the coordinator's
//! lost-debit flag, so the next successful call drops every `omni:b:*` hash
//! and the next admissions reseed from the store (which has the rows).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use omni_coord::Counts;
use omni_coord::redis::key;
use omni_ratelimit::Window;
use redis::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::subject::{bucket_key, grain_ms};
use crate::{Inner, scripts};

/// Costs kept individually per entry; past it the newest are summed into
/// the last (the stored float may then differ from the per-debit sequence
/// in its last digits — far below any spend ceiling's resolution).
const MAX_COSTS_PER_ENTRY: usize = 256;

/// A bound on one call's arguments (bytes, roughly), under D2's 1 MiB
/// request cap with the script-source fallback beside it.
const MAX_CALL_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Default)]
struct Entry {
    grain_ms: f64,
    window_ms: f64,
    requests: f64,
    tokens: f64,
    costs: Vec<f64>,
}

#[derive(Default)]
struct Seeding {
    /// Seeds of this hash running in this process.
    running: usize,
    /// Whether one of them installed.
    installed: bool,
    /// Debits made while they ran: `(subject, window, now, delta)`.
    held: Vec<(String, Window, f64, Counts)>,
}

#[derive(Default)]
pub(crate) struct Debits {
    /// Keyed by (bucket hash name, bucket start).
    pending: Mutex<HashMap<(String, u64), Entry>>,
    /// One flush at a time, so batches apply in order.
    flushing: AsyncMutex<()>,
    /// Bucket hashes a local seed is installing, with the debits made
    /// meanwhile (see [`seeding`]).
    seeding: Mutex<HashMap<String, Seeding>>,
    stopped: AtomicBool,
}

/// Queues one debit of `subject`'s `window` stamped `now`.
pub(crate) fn push(inner: &Inner, subject: &str, window: Window, now: f64, delta: Counts) {
    let grain = grain_ms(window);
    let start = (now / grain).floor() * grain;
    let name = key("b", &bucket_key(subject, window));
    if let Some(seeding) = inner
        .debits
        .seeding
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_mut(&name)
    {
        seeding.held.push((subject.to_owned(), window, now, delta));
        return;
    }
    let mut pending = inner
        .debits
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let slot = (name, start.to_bits());
    if !pending.contains_key(&slot) && pending.len() >= inner.opts.debit_queue {
        drop(pending);
        lost(inner, 1, "debit queue full");
        return;
    }
    crate::bump(&inner.metrics.debits_queued);
    let e = pending.entry(slot).or_default();
    e.grain_ms = grain;
    e.window_ms = window.ms();
    e.requests += delta.requests;
    e.tokens += delta.tokens;
    if e.costs.len() < MAX_COSTS_PER_ENTRY {
        e.costs.push(delta.cost_usd);
    } else if let Some(last) = e.costs.last_mut() {
        *last += delta.cost_usd;
    }
}

fn lost(inner: &Inner, n: u64, why: &'static str) {
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

/// Marks `bucket` (a `bucket_key`) as being seeded by this process and
/// applies every debit already pending first, so none of them can land
/// after the seed: a pending debit's row is committed, so the seed's store
/// read counts it, and applied now it meets the unseeded hash and is
/// ignored — TS's order ("row first, then the debit"; an unseeded key
/// ignores adds). Without this a debit batched across a seed's read is
/// counted twice.
///
/// Debits made while the seed runs are held. If a seed installs they are
/// dropped: in TS such a debit either meets the unseeded hash (ignored) or
/// is erased by `BUCKETS_SEED`'s `DEL`, its row read by the seed or not
/// (TS's own race, kept). If none installs (the store read failed, or
/// another replica's picture was already there) they are queued as usual.
pub(crate) async fn seeding<'a>(inner: &'a Inner, bucket: &str) -> SeedingGuard<'a> {
    let name = key("b", bucket);
    inner
        .debits
        .seeding
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(name.clone())
        .or_default()
        .running += 1;
    let guard = SeedingGuard { inner, name };
    flush(inner).await;
    guard
}

pub(crate) struct SeedingGuard<'a> {
    inner: &'a Inner,
    name: String,
}

impl SeedingGuard<'_> {
    /// The seed installed its picture.
    pub(crate) fn installed(&self) {
        if let Some(s) = self
            .inner
            .debits
            .seeding
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(&self.name)
        {
            s.installed = true;
        }
    }
}

impl Drop for SeedingGuard<'_> {
    fn drop(&mut self) {
        let done = {
            let mut seeding = self
                .inner
                .debits
                .seeding
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let Some(s) = seeding.get_mut(&self.name) else {
                return;
            };
            s.running -= 1;
            if s.running > 0 {
                return;
            }
            seeding.remove(&self.name)
        };
        let Some(done) = done else { return };
        if done.installed {
            self.inner
                .metrics
                .debit_buckets_unseeded
                .fetch_add(done.held.len() as u64, Ordering::Relaxed);
            return;
        }
        for (subject, window, now, delta) in done.held {
            push(self.inner, &subject, window, now, delta);
        }
    }
}

/// Applies every pending entry now.
pub(crate) async fn flush(inner: &Inner) {
    let _one = inner.debits.flushing.lock().await;
    let batch: Vec<((String, u64), Entry)> = {
        let mut pending = inner
            .debits
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if pending.is_empty() {
            return;
        }
        pending.drain().collect()
    };
    let mut keys = Vec::new();
    let mut args = Vec::new();
    let mut bytes = 0;
    for ((name, start), e) in batch {
        bytes += name.len() + 64 + e.costs.len() * 24;
        keys.push(name);
        args.push(crate::js(f64::from_bits(start)));
        args.push(crate::js(e.grain_ms));
        args.push(crate::js(e.window_ms));
        args.push(crate::js(e.requests));
        args.push(crate::js(e.tokens));
        // Every cost in order, zeros included: TS sends one `HINCRBYFLOAT`
        // per debit, and a zero one still creates the field.
        args.push(e.costs.len().to_string());
        args.extend(e.costs.iter().copied().map(crate::js));
        if keys.len() >= inner.opts.debit_batch_keys || bytes >= MAX_CALL_BYTES {
            send(inner, std::mem::take(&mut keys), std::mem::take(&mut args)).await;
            bytes = 0;
        }
    }
    if !keys.is_empty() {
        send(inner, keys, args).await;
    }
}

async fn send(inner: &Inner, keys: Vec<String>, args: Vec<String>) {
    let n = keys.len() as u64;
    crate::bump(&inner.metrics.debit_batches);
    match inner.remote.eval(&scripts::DEBIT_BATCH, &keys, &args).await {
        Ok(Value::Array(out)) => {
            let applied = out.iter().filter(|v| matches!(v, Value::Int(1))).count() as u64;
            inner
                .metrics
                .debit_buckets_applied
                .fetch_add(applied, Ordering::Relaxed);
            inner
                .metrics
                .debit_buckets_unseeded
                .fetch_add(n.saturating_sub(applied), Ordering::Relaxed);
        }
        // Not confirmed: it may or may not have applied. TS's policy for a
        // debit that did not reach the server: reseed on recovery (an
        // applied-and-unconfirmed batch is then simply re-read).
        Ok(_) | Err(_) => lost(inner, n, "debit batch not confirmed"),
    }
}

pub(crate) fn spawn(inner: &Arc<Inner>) {
    let weak = Arc::downgrade(inner);
    let every = inner.opts.debit_interval;
    tokio::spawn(flusher(weak, every));
}

async fn flusher(weak: Weak<Inner>, every: std::time::Duration) {
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
