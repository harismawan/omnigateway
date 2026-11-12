//! `memoryCoord`: the single-process implementation — the maps one gateway
//! held before it had an interface to put them behind.
//!
//! Every method mutates synchronously and its future completes on the first
//! poll, which is what makes the visibility property hold without a lock
//! across an await.
//!
//! Windows are TS's `SlidingWindow` exactly: one stamp per claim in arrival
//! order, aged out as a prefix (`stamp <= now - window`), `used` the count
//! that survives, `resetAt` the oldest survivor plus the window, rollback
//! removing one stamp equal to the one given, scanning from the newest and
//! stopping at the first smaller one. A backdated claim (stamped before
//! later ones) is a finite count and its rollback removes it, as in TS.
//!
//! The one bound TS does not have: a key holds at most
//! [`WINDOW_KEY_CAP`] live stamps. Past it a claim is still answered with
//! the true count before it, but is not stored — the count then reads
//! *lower* than the claims made, so the cap fails open (admits) rather than
//! refusing; the ring catches up as stamps age out. A rollback of a claim
//! that was not stored finds nothing, as for an aged-out one.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use std::collections::VecDeque;
use tokio::sync::Notify;

use crate::{
    BucketRow, Clock, Coord, CoordError, Counts, Handler, LockToken, Subscribers, Subscription,
    WindowClaim, WindowCounter, system_clock,
};

/// How often the drained-ring sweep may run (TS `SWEEP_INTERVAL_MS`).
const SWEEP_INTERVAL_MS: f64 = 1_000.0;

/// The most live stamps one window key holds (see the module comment): a
/// memory bound of about 1 MiB per key under a flood, far above any limit a
/// key is configured with (a ceiling is judged on `used`, which is exact up
/// to here).
pub const WINDOW_KEY_CAP: usize = 131_072;

/// TS `SlidingWindow`: stamps in arrival order.
#[derive(Debug)]
struct Ring {
    window_ms: f64,
    stamps: VecDeque<f64>,
}

impl Ring {
    fn new(window_ms: f64) -> Self {
        Self {
            window_ms,
            stamps: VecDeque::new(),
        }
    }

    /// Drops the aged prefix — stopping at the first live stamp, so a live
    /// stamp ahead of an aged backdated one keeps it, as in TS — and
    /// reports what is left.
    fn count(&mut self, now: f64) -> usize {
        let cutoff = now - self.window_ms;
        while self.stamps.front().is_some_and(|s| *s <= cutoff) {
            self.stamps.pop_front();
        }
        if self.stamps.capacity() > 64 && self.stamps.capacity() > 4 * self.stamps.len() {
            self.stamps.shrink_to(self.stamps.len() * 2);
        }
        self.stamps.len()
    }

    /// Records unless the key is at its cap; whether it was stored.
    fn record(&mut self, now: f64) -> bool {
        if self.stamps.len() >= WINDOW_KEY_CAP {
            return false;
        }
        self.stamps.push_back(now);
        true
    }

    /// TS `forget`: from the newest, stop at the first stamp below `at`.
    fn forget(&mut self, at: f64) {
        for index in (0..self.stamps.len()).rev() {
            let stamp = self.stamps[index];
            if stamp < at {
                return;
            }
            if stamp == at {
                self.stamps.remove(index);
                return;
            }
        }
    }

    /// The oldest stamp held plus the window; `now` when empty.
    fn reset_at(&self, now: f64) -> f64 {
        self.stamps.front().map_or(now, |s| s + self.window_ms)
    }
}

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
    windows: HashMap<String, Ring>,
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
    /// Runs between a waiter reading the holder and arming its wakeup: the
    /// race window the I3 test drives.
    #[cfg(test)]
    lock_wait_hook: Mutex<Option<Box<dyn FnMut() + Send>>>,
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
            #[cfg(test)]
            lock_wait_hook: Mutex::new(None),
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
        st.windows.retain(|_, ring| ring.count(now) > 0);
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
            .or_insert_with(|| Ring::new(window_ms));
        let before = WindowCounter {
            used: ring.count(now) as f64,
            reset_at: ring.reset_at(now),
        };
        if !ring.record(now) {
            tracing::debug!(key, "window key at its cap; claim counted but not stored");
        }
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
            #[cfg(test)]
            if let Some(hook) = self
                .lock_wait_hook
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_mut()
            {
                hook();
            }
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // Re-check after enabling: the holder this waiter read must still
            // be the holder, by identity. A release in between (key gone) or
            // a release and a new holder (a different `Notify`, whose release
            // would never wake this one) both mean read again.
            let current = self
                .state()
                .locks
                .get(key)
                .is_some_and(|(_, n)| Arc::ptr_eq(n, &notify));
            if !current {
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    /// I3: a waiter reads holder A, then — before it arms its wakeup — A
    /// releases and C acquires. The waiter must notice it is not waiting on
    /// the current holder and acquire once C releases, not sleep out its
    /// whole wait on A's retired notification.
    #[tokio::test]
    async fn a_waiter_follows_a_replacement_holder() {
        let coord = Arc::new(MemoryCoord::new(system_clock()));
        let a = coord
            .lock("m", 1_000, Duration::ZERO)
            .now_or_never()
            .expect("free lock is immediate")
            .expect("a holds");
        let c_token: Arc<Mutex<Option<LockToken>>> = Arc::default();
        let mut a = Some(a);
        let (hook_coord, slot) = (Arc::downgrade(&coord), Arc::clone(&c_token));
        *coord.lock_wait_hook.lock().expect("hook") = Some(Box::new(move || {
            let (Some(coord), Some(a)) = (hook_coord.upgrade(), a.take()) else {
                return;
            };
            coord.release_lock(&a);
            let c = coord
                .lock("m", 1_000, Duration::ZERO)
                .now_or_never()
                .expect("immediate")
                .expect("c holds");
            *slot.lock().expect("slot") = Some(c);
        }));
        let waiter = {
            let coord = Arc::clone(&coord);
            tokio::spawn(async move { coord.lock("m", 1_000, Duration::from_secs(2)).await })
        };
        while c_token.lock().expect("slot").is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let c = c_token.lock().expect("slot").take().expect("c");
        let started = tokio::time::Instant::now();
        coord.unlock(c).await;
        let got = waiter.await.expect("waiter task");
        assert!(got.is_ok(), "{got:?}");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "{:?}",
            started.elapsed()
        );
    }
}
