//! `memoryCoord`: the single-process implementation — the maps one gateway
//! held before it had an interface to put them behind.
//!
//! Every method mutates synchronously and its future completes on the first
//! poll, which is what makes the visibility property hold without a lock
//! across an await. Two deliberate differences from TS, both inherited from
//! the reviewed `omni_ratelimit::window::SlidingWindow` port: a window ring
//! is bounded (beyond 65 536 distinct stamps it buckets by the second,
//! over-counting by at most one bucket), and a claim stamped before the
//! ring's newest stamp (a clock step backwards) reads fail-closed.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use omni_ratelimit::window::SlidingWindow;
use tokio::sync::Notify;

use crate::{
    BucketRow, Clock, Coord, CoordError, Counts, Handler, LockToken, Subscribers, Subscription,
    WindowClaim, WindowCounter, system_clock,
};

/// How often the drained-ring sweep may run (TS `SWEEP_INTERVAL_MS`).
const SWEEP_INTERVAL_MS: f64 = 1_000.0;

#[derive(Debug, Clone)]
struct Slot {
    expires_at: f64,
    holder: Option<String>,
}

/// A bucket start, ordered by `total_cmp` so it can key a map.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Start(f64);
impl Eq for Start {}
impl PartialOrd for Start {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Start {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

#[derive(Default)]
struct State {
    windows: HashMap<String, SlidingWindow>,
    last_sweep: Option<f64>,
    gauges: HashMap<String, Vec<Slot>>,
    values: HashMap<String, (String, f64)>,
    buckets: HashMap<String, BTreeMap<Start, Counts>>,
    leases: HashMap<String, (String, f64)>,
    counters: HashMap<String, u64>,
    /// Held mutexes: the holder's token, and who to wake on release.
    locks: HashMap<String, (String, Arc<Notify>)>,
}

/// The in-process coordinator (TS `memoryCoord`).
pub struct MemoryCoord {
    now: Clock,
    state: Mutex<State>,
    subscribers: Arc<Subscribers>,
}

impl std::fmt::Debug for MemoryCoord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryCoord").finish_non_exhaustive()
    }
}

impl Default for MemoryCoord {
    fn default() -> Self {
        Self::new(system_clock())
    }
}

fn blank(holder: Option<&str>) -> Result<(), CoordError> {
    if holder == Some("") {
        Err(CoordError::BlankHolder)
    } else {
        Ok(())
    }
}

fn bucket_of(grain_ms: f64, at: f64) -> f64 {
    (at / grain_ms).floor() * grain_ms
}

impl MemoryCoord {
    /// `memoryCoord({ now })`: `now` is what gauges, leases and `kv` expire
    /// against.
    pub fn new(now: Clock) -> Self {
        Self::with_subscribers(now, Arc::new(Subscribers::default()))
    }

    pub(crate) fn with_subscribers(now: Clock, subscribers: Arc<Subscribers>) -> Self {
        Self {
            now,
            state: Mutex::new(State::default()),
            subscribers,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Every critical section leaves the maps consistent.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Rings currently held: everything the window map can grow.
    pub fn live_windows(&self) -> usize {
        self.state().windows.len()
    }

    fn live_slots<'s>(st: &'s mut State, key: &str, at: f64) -> Option<&'s mut Vec<Slot>> {
        let held = st.gauges.get_mut(key)?;
        held.retain(|s| s.expires_at > at);
        if held.is_empty() {
            st.gauges.remove(key);
            return None;
        }
        st.gauges.get_mut(key)
    }

    /// Drops buckets outside the window. A key keeps its seeded status even
    /// when empty.
    fn trim_buckets(st: &mut State, key: &str, grain_ms: f64, window_ms: f64, now: f64) {
        if let Some(held) = st.buckets.get_mut(key) {
            let oldest = Start(bucket_of(grain_ms, now - window_ms));
            held.retain(|start, _| *start >= oldest);
        }
    }

    /// Drops drained rings, at most once per interval. A backward clock step
    /// reads as "sweep now", not "swept recently".
    fn sweep(st: &mut State, now: f64) {
        if let Some(last) = st.last_sweep {
            let since = now - last;
            if (0.0..SWEEP_INTERVAL_MS).contains(&since) {
                return;
            }
        }
        st.last_sweep = Some(now);
        st.windows.retain(|_, ring| {
            ring.count(now);
            !ring.is_empty()
        });
    }

    pub(crate) fn publish_now(&self, topic: &str, payload: &str) {
        self.subscribers.dispatch(topic, payload);
    }

    fn next_counter(&self, key: &str) -> u64 {
        let mut st = self.state();
        let n = st.counters.entry(key.to_owned()).or_insert(0);
        *n += 1;
        *n
    }

    fn release_lock(&self, token: &LockToken) {
        let mut st = self.state();
        if st
            .locks
            .get(&token.name)
            .is_some_and(|(held, _)| *held == token.token)
            && let Some((_, notify)) = st.locks.remove(&token.name)
        {
            notify.notify_waiters();
        }
    }
}

#[async_trait]
impl Coord for MemoryCoord {
    async fn window_claim(&self, key: &str, window_ms: f64, now: f64) -> WindowClaim {
        let mut st = self.state();
        Self::sweep(&mut st, now);
        let ring = st
            .windows
            .entry(key.to_owned())
            .or_insert_with(|| SlidingWindow::new(window_ms));
        let used = ring.count(now);
        let before = WindowCounter {
            used: if used == usize::MAX {
                f64::INFINITY
            } else {
                used as f64
            },
            reset_at: ring.reset_at(now),
        };
        ring.record(now);
        WindowClaim { stamp: now, before }
    }

    async fn window_rollback(&self, key: &str, stamp: f64) {
        if let Some(ring) = self.state().windows.get_mut(key) {
            ring.forget(stamp);
        }
    }

    async fn gauge_acquire(
        &self,
        key: &str,
        ttl_ms: u64,
        holder: Option<&str>,
    ) -> Result<u64, CoordError> {
        blank(holder)?;
        let at = (self.now)();
        let expires_at = at + ttl_ms as f64;
        let mut st = self.state();
        Self::live_slots(&mut st, key, at);
        let held = st.gauges.entry(key.to_owned()).or_default();
        // Re-acquiring under the same name moves that slot rather than adding
        // one; `before` excludes the caller's own slot.
        if let Some(name) = holder
            && let Some(mine) = held.iter_mut().find(|s| s.holder.as_deref() == Some(name))
        {
            mine.expires_at = expires_at;
            return Ok(held.len() as u64 - 1);
        }
        let before = held.len() as u64;
        held.push(Slot {
            expires_at,
            holder: holder.map(str::to_owned),
        });
        Ok(before)
    }

    async fn gauge_renew(&self, key: &str, holder: &str, ttl_ms: u64) -> Result<(), CoordError> {
        blank(Some(holder))?;
        let at = (self.now)();
        let mut st = self.state();
        // Absent is not an error: a renewal racing its own release, or landing
        // after the slot lapsed, has nothing to move.
        if let Some(held) = Self::live_slots(&mut st, key, at)
            && let Some(mine) = held
                .iter_mut()
                .find(|s| s.holder.as_deref() == Some(holder))
        {
            mine.expires_at = at + ttl_ms as f64;
        }
        Ok(())
    }

    async fn gauge_release(&self, key: &str, holder: Option<&str>) -> Result<(), CoordError> {
        blank(holder)?;
        let at = (self.now)();
        let mut st = self.state();
        if let Some(held) = Self::live_slots(&mut st, key, at) {
            let index = match holder {
                // The slot nearest its own expiry goes.
                None => held
                    .iter()
                    .enumerate()
                    .min_by(|(_, x), (_, y)| x.expires_at.total_cmp(&y.expires_at))
                    .map(|(i, _)| i),
                Some(name) => held.iter().position(|s| s.holder.as_deref() == Some(name)),
            };
            if let Some(i) = index {
                held.remove(i);
            }
            if held.is_empty() {
                st.gauges.remove(key);
            }
        }
        Ok(())
    }

    async fn gauge_read(&self, key: &str) -> u64 {
        let at = (self.now)();
        let mut st = self.state();
        Self::live_slots(&mut st, key, at).map_or(0, |held| held.len() as u64)
    }

    async fn gauge_snapshot(&self, prefix: &str) -> BTreeMap<String, u64> {
        let at = (self.now)();
        let mut st = self.state();
        let keys: Vec<String> = st
            .gauges
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        let mut out = BTreeMap::new();
        for key in keys {
            if let Some(held) = Self::live_slots(&mut st, &key, at) {
                out.insert(key, held.len() as u64);
            }
        }
        out
    }

    async fn lock(&self, key: &str, _ttl_ms: u64, wait: Duration) -> Result<LockToken, CoordError> {
        // One deadline for the whole wait. Contenders race; no fairness (TS
        // "ponytail" note).
        let deadline = tokio::time::Instant::now() + wait;
        let token = uuid::Uuid::new_v4().to_string();
        loop {
            let notify = {
                let mut st = self.state();
                match st.locks.get(key) {
                    None => {
                        st.locks
                            .insert(key.to_owned(), (token.clone(), Arc::new(Notify::new())));
                        return Ok(LockToken {
                            name: key.to_owned(),
                            token,
                        });
                    }
                    Some((_, notify)) => Arc::clone(notify),
                }
            };
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // Re-check after enabling, so a release between the read above and
            // the enable is not missed.
            if !self.state().locks.contains_key(key) {
                continue;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(CoordError::LockUnavailable(key.to_owned()));
            }
        }
    }

    async fn unlock(&self, token: LockToken) {
        self.release_lock(&token);
    }

    fn unlock_detached(&self, token: LockToken) {
        self.release_lock(&token);
    }

    async fn buckets_add(&self, key: &str, grain_ms: f64, window_ms: f64, now: f64, delta: Counts) {
        let mut st = self.state();
        Self::trim_buckets(&mut st, key, grain_ms, window_ms, now);
        // An unseeded key stays unseeded: the row behind this debit is in the
        // store the seed reads.
        if let Some(held) = st.buckets.get_mut(key) {
            held.entry(Start(bucket_of(grain_ms, now)))
                .or_default()
                .add(delta);
        }
    }

    async fn buckets_sum(
        &self,
        key: &str,
        grain_ms: f64,
        window_ms: f64,
        now: f64,
    ) -> Option<Counts> {
        let mut st = self.state();
        Self::trim_buckets(&mut st, key, grain_ms, window_ms, now);
        let held = st.buckets.get(key)?;
        let mut total = Counts::default();
        for counts in held.values() {
            total.add(*counts);
        }
        Some(total)
    }

    async fn buckets_seed(
        &self,
        key: &str,
        grain_ms: f64,
        window_ms: f64,
        now: f64,
        rows: &[BucketRow],
    ) {
        let mut st = self.state();
        let mut held = BTreeMap::new();
        for (start, counts) in rows {
            // TS `Map.set`: a later row for the same bucket replaces.
            held.insert(Start(bucket_of(grain_ms, *start)), *counts);
        }
        st.buckets.insert(key.to_owned(), held);
        Self::trim_buckets(&mut st, key, grain_ms, window_ms, now);
    }

    async fn lease_acquire(&self, name: &str, holder_id: &str, ttl_ms: u64) -> bool {
        let at = (self.now)();
        let mut st = self.state();
        if let Some((holder, expires_at)) = st.leases.get(name)
            && holder != holder_id
            && *expires_at > at
        {
            return false;
        }
        st.leases
            .insert(name.to_owned(), (holder_id.to_owned(), at + ttl_ms as f64));
        true
    }

    async fn lease_release(&self, name: &str, holder_id: &str) {
        let mut st = self.state();
        if st.leases.get(name).is_some_and(|(h, _)| h == holder_id) {
            st.leases.remove(name);
        }
    }

    async fn publish(&self, topic: &str, payload: &str) {
        self.publish_now(topic, payload);
    }

    async fn publish_sequenced(&self, topic: &str, payload: &str, seq_key: &str) -> u64 {
        let seq = self.next_counter(seq_key);
        self.publish_now(topic, &format!("{seq}:{payload}"));
        seq
    }

    fn subscribe(&self, pattern: &str, handler: Handler) -> Subscription {
        self.subscribers.add(pattern, handler)
    }

    async fn incr(&self, key: &str) -> u64 {
        self.next_counter(key)
    }

    async fn kv_set(&self, key: &str, value: &str, ttl_ms: u64) -> Result<(), CoordError> {
        let expires_at = (self.now)() + ttl_ms as f64;
        self.state()
            .values
            .insert(key.to_owned(), (value.to_owned(), expires_at));
        Ok(())
    }

    async fn kv_get(&self, key: &str) -> Result<Option<String>, CoordError> {
        let at = (self.now)();
        let mut st = self.state();
        match st.values.get(key) {
            None => Ok(None),
            Some((_, expires_at)) if *expires_at <= at => {
                st.values.remove(key);
                Ok(None)
            }
            Some((value, _)) => Ok(Some(value.clone())),
        }
    }

    async fn kv_del(&self, key: &str) -> Result<(), CoordError> {
        self.state().values.remove(key);
        Ok(())
    }

    async fn kv_del_prefix(&self, prefix: &str) -> Result<(), CoordError> {
        self.state().values.retain(|k, _| !k.starts_with(prefix));
        Ok(())
    }
}
