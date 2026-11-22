//! Coordination between the processes serving one installation — the Rust
//! port of `packages/coord` (`Coord`, `memoryCoord`) and
//! `apps/gateway/src/coord/redis.ts` (`redisCoord`).
//!
//! Every counter that a single process would keep in a map lives behind
//! [`Coord`], so one gateway and a fleet of them run the same code: a fleet
//! hands in [`RedisCoord`] (Redis or Valkey), a single process hands in
//! [`MemoryCoord`].
//!
//! The one property every implementation holds (TS's contract): a claim is
//! visible to every concurrent claimant the instant the call is *issued*.
//!
//! **Issued means first polled.** A Rust `async fn` does nothing until its
//! future is polled: creating `coord.window_claim(..)` and dropping it, or
//! holding it unpolled, records nothing, and two futures are issued in the
//! order they are first polled, not the order they were created. Within that:
//! - `MemoryCoord` applies every call's effect on its first poll and
//!   completes there, except a contended `lock`, which takes the lock (its
//!   effect) only on a later poll, once the holder releases.
//! - `RedisCoord` submits a command to the connection's single ordered queue
//!   on its first poll, and the queue is written to the server in order;
//!   the server executes one connection's commands in order, each script
//!   atomically. Two exceptions: a call refused at submission (queue full,
//!   disconnected — answered from memory or as a fault) is not executed at
//!   all; and an `EVALSHA` answered `NOSCRIPT` is resubmitted as `EVAL`
//!   behind whatever other callers queued meanwhile, so its effect may land
//!   after theirs. A call's effect is ordered before the *same caller's*
//!   later calls, since the caller has not returned.
//! - The non-async release paths (`Coord::unlock_detached`,
//!   `redis::Remote::{gauge_release_detached, lock_release_detached,
//!   eval_detached}`) are queued when the call returns `Ok`, and are sent as
//!   `EVAL` (never `NOSCRIPT`): a release whose call has returned `Ok` is
//!   executed before any command first polled after it, on that connection.
//!   This is the guarantee a stream-end concurrency release relies on. A
//!   release that returns `Err(Refused)` is not executed (counted, logged,
//!   held until its TTL); one queued when its connection is retired is
//!   replayed on the next only if idempotent.
//! - Cancelling an awaited Redis call after its first poll does not
//!   withdraw the command; it may still execute.
//!
//! **Wire compatibility.** The Redis implementation keeps the key schema,
//! value formats and Lua scripts the TS gateway used, byte-for-byte (see
//! [`redis::scripts`], whose digests are pinned), so every process of one
//! installation against the same server shares windows, gauges, buckets,
//! leases, locks, sessions, OAuth pending state and the `omni:pubsub` channel.
//!
//! **Times** are milliseconds as `f64`, as in `omni-ratelimit` and TS, where
//! they reach Lua arithmetic. TTLs are `u64`: every one reaches a `PX` or
//! `PEXPIRE`, which Redis refuses fractional.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use async_trait::async_trait;

pub use omni_ratelimit::WindowCounter;
pub use omni_ratelimit::buckets::Counts;

pub mod memory;
pub mod redis;

pub use memory::MemoryCoord;
pub use redis::{Fault, RedisCoord, RedisCoordOptions, Remote};

/// The clock gauges, leases and `kv` (memory) expire against, in ms. Window
/// and bucket calls take `now` as a parameter instead, as in TS.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// The wall clock, in epoch milliseconds.
pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1_000.0)
            .floor()
    })
}

/// `WindowClaim`: the stamp recorded, and what the window held before it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowClaim {
    pub stamp: f64,
    pub before: WindowCounter,
}

/// One seeded bucket: its start and what it holds.
pub type BucketRow = (f64, Counts);

/// Errors a [`Coord`] call can return. Everything else falls open inside the
/// implementation (see [`RedisCoord`]).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CoordError {
    /// TS `LockUnavailable`: `waitMs` passed without the lock, or the lock
    /// could not be confirmed with the server.
    #[error("LOCK_UNAVAILABLE: {0}")]
    LockUnavailable(String),
    /// TS `GatewayError("OVERLOADED", …)` from `kv`: the coordinator is
    /// unreachable, and a session must not be verified against a fallback map
    /// a password change on another process cannot end.
    #[error("the coordinator is unreachable; try again shortly")]
    Unavailable,
    /// TS `TypeError`: `""` is the Redis "unnamed" sentinel on the wire, so it
    /// is refused as a holder name by every implementation.
    #[error("gauge holder must be a non-empty string")]
    BlankHolder,
}

/// A held mutex, returned by [`Coord::lock`] and given back to
/// [`Coord::unlock`]. Prefer [`with_lock`]. A token that is dropped without
/// either is held until its TTL (Redis) or forever (memory, whose locks have
/// no TTL, as in TS).
#[derive(Debug, PartialEq, Eq)]
#[must_use = "a lock token that is never unlocked is held until its TTL"]
pub struct LockToken {
    pub(crate) name: String,
    pub(crate) token: String,
}

impl LockToken {
    /// The lock's name as the caller gave it (no namespace).
    pub fn name(&self) -> &str {
        &self.name
    }
}

/// A pub/sub handler: `(topic, payload)`. Called on the dispatching task, so
/// it must not block; it may subscribe or unsubscribe.
pub type Handler = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// The coordinator, method for method the TS `Coord` it was ported from. The
/// comments below are the contract.
#[async_trait]
pub trait Coord: Send + Sync {
    // --- window -------------------------------------------------------------

    /// Records one event at `now` and reports what the window held before it.
    /// Unconditional: the caller judges the ceiling.
    async fn window_claim(&self, key: &str, window_ms: f64, now: f64) -> WindowClaim;
    /// Gives back one stamp. Silent when it already aged out.
    async fn window_rollback(&self, key: &str, stamp: f64);

    // --- gauge --------------------------------------------------------------

    /// Raises the gauge; reports what it held before (excluding the caller's
    /// own named slot). A slot lapses after `ttl_ms` in every implementation.
    async fn gauge_acquire(
        &self,
        key: &str,
        ttl_ms: u64,
        holder: Option<&str>,
    ) -> Result<u64, CoordError>;
    /// Moves a named slot's expiry. Silent when the holder holds none — it is
    /// never resurrected.
    async fn gauge_renew(&self, key: &str, holder: &str, ttl_ms: u64) -> Result<(), CoordError>;
    /// Lowers the gauge, never below zero. Named: that slot; unnamed: the slot
    /// nearest its expiry.
    async fn gauge_release(&self, key: &str, holder: Option<&str>) -> Result<(), CoordError>;
    async fn gauge_read(&self, key: &str) -> u64;
    /// Every held key under `prefix` with its count; zero counts are absent.
    async fn gauge_snapshot(&self, prefix: &str) -> BTreeMap<String, u64>;

    // --- mutex --------------------------------------------------------------

    /// Takes `key`, or [`CoordError::LockUnavailable`] once `wait` has passed.
    /// `ttl_ms` bounds a holder that never unlocks (Redis; memory ignores it,
    /// as TS's does). Cancelling this future mid-acquire: Redis queues a
    /// token-safe release for the attempt, which frees the lock on the same
    /// connection; across a retirement the attempt's `SET` may land after it
    /// and hold the lock until `ttl_ms` (see [`with_lock`]).
    async fn lock(&self, key: &str, ttl_ms: u64, wait: Duration) -> Result<LockToken, CoordError>;
    /// Gives a lock back. Only the token's own holding is released: a lock
    /// that lapsed and was taken by another holder is left alone. The
    /// release is queued on the first poll, so cancelling the returned
    /// future afterwards still releases; awaiting it waits (bounded by the
    /// command deadline) for the server to have run it.
    async fn unlock(&self, token: LockToken);
    /// [`Coord::unlock`] from a synchronous context (a drop): the release is
    /// sent without being awaited.
    fn unlock_detached(&self, token: LockToken);

    // --- buckets ------------------------------------------------------------

    async fn buckets_add(&self, key: &str, grain_ms: f64, window_ms: f64, now: f64, delta: Counts);
    /// `None` for a key nothing has seeded — distinct from zero.
    async fn buckets_sum(
        &self,
        key: &str,
        grain_ms: f64,
        window_ms: f64,
        now: f64,
    ) -> Option<Counts>;
    /// Installs a starting picture, replacing whatever was there.
    async fn buckets_seed(
        &self,
        key: &str,
        grain_ms: f64,
        window_ms: f64,
        now: f64,
        rows: &[BucketRow],
    );

    // --- lease --------------------------------------------------------------

    /// Whether `holder_id` holds `name` afterwards. A lease that cannot be
    /// confirmed is not held.
    async fn lease_acquire(&self, name: &str, holder_id: &str, ttl_ms: u64) -> bool;
    async fn lease_release(&self, name: &str, holder_id: &str);

    // --- pubsub -------------------------------------------------------------

    async fn publish(&self, topic: &str, payload: &str);
    /// Publishes `<seq>:<payload>` with `seq` taken from `seq_key` in the same
    /// step. [`split_sequenced`] reads it back.
    async fn publish_sequenced(&self, topic: &str, payload: &str, seq_key: &str) -> u64;
    /// `pattern` may end in `*`, matching any suffix. Every publish reaches
    /// the publisher's own subscribers too.
    fn subscribe(&self, pattern: &str, handler: Handler) -> Subscription;

    // --- counters and kv ----------------------------------------------------

    /// A counter shared by every process, starting at 1.
    async fn incr(&self, key: &str) -> u64;

    async fn kv_set(&self, key: &str, value: &str, ttl_ms: u64) -> Result<(), CoordError>;
    /// A value at or past its TTL is never served.
    async fn kv_get(&self, key: &str) -> Result<Option<String>, CoordError>;
    async fn kv_del(&self, key: &str) -> Result<(), CoordError>;
    /// Every key under `prefix`. For ending sessions of one kind, not listing.
    async fn kv_del_prefix(&self, prefix: &str) -> Result<(), CoordError>;
}

/// TS `withLock`: runs `body` while holding `key`, releasing on success, on
/// error, and — detached — when the body panics or is cancelled.
///
/// Cancelled while acquiring: in memory nothing is held. On Redis a
/// token-safe release for the attempt is queued (see [`Coord::lock`]); on the
/// same connection it runs after the attempt's `SET`, so the lock is freed.
/// It is *not* guaranteed across a connection retirement: a `SET` written to
/// the retired socket may execute after the release sent on the new one, and
/// then holds the lock until `ttl_ms`. Likewise a release that cannot be
/// queued (queue full, closed) is counted and logged, and the lock lapses at
/// `ttl_ms`.
pub async fn with_lock<C, F, Fut, T>(
    coord: &C,
    key: &str,
    ttl_ms: u64,
    wait: Duration,
    body: F,
) -> Result<T, CoordError>
where
    C: Coord + ?Sized,
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    struct Held<'a, C: Coord + ?Sized> {
        coord: &'a C,
        token: Option<LockToken>,
    }
    impl<C: Coord + ?Sized> Drop for Held<'_, C> {
        fn drop(&mut self) {
            if let Some(token) = self.token.take() {
                self.coord.unlock_detached(token);
            }
        }
    }
    let token = coord.lock(key, ttl_ms, wait).await?;
    let mut held = Held {
        coord,
        token: Some(token),
    };
    let out = body().await;
    if let Some(token) = held.token.take() {
        coord.unlock(token).await;
    }
    Ok(out)
}

/// TS `splitSequenced`: the two halves of a `publish_sequenced` delivery, or
/// `None` for an ordinary one.
pub fn split_sequenced(payload: &str) -> Option<(u64, &str)> {
    let sep = payload.find(':')?;
    if sep == 0 {
        return None;
    }
    let head = &payload[..sep];
    // JS `Number()` + `isInteger` + `> 0`: digits only, no sign or fraction.
    // (`Number(" 5")` and `Number("5.0")` also pass in JS; no publisher
    // produces them.)
    if !head.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let seq: u64 = head.parse().ok()?;
    if seq == 0 {
        return None;
    }
    Some((seq, &payload[sep + 1..]))
}

/// The topic TS's `app.ts` publishes routing changes on:
/// `{"from": <nodeId>, "change": <RoutingChange>}`.
pub const ROUTING_TOPIC: &str = "routing";

/// A local-only topic dispatched once per usable shared-channel subscription,
/// with the publish path ready so fan-out state can be requested again.
pub const RECONNECTED_TOPIC: &str = "coord:reconnected";

/// The envelope of a `routing` message, as TS `app.ts` writes it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RoutingMessage {
    pub from: String,
    pub change: serde_json::Value,
}

// --- subscribers ---------------------------------------------------------

/// The local subscriber set. Shared between [`RedisCoord`] and its embedded
/// fallback so a publish served from memory still reaches this process.
#[derive(Default)]
pub(crate) struct Subscribers {
    next: AtomicU64,
    list: RwLock<Vec<(u64, String, Handler)>>,
}

impl Subscribers {
    pub(crate) fn add(self: &Arc<Self>, pattern: &str, handler: Handler) -> Subscription {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.list
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .push((id, pattern.to_owned(), handler));
        Subscription {
            id,
            owner: Some(Arc::downgrade(self)),
        }
    }

    fn remove(&self, id: u64) {
        self.list
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|(i, _, _)| *i != id);
    }

    /// Calls every matching handler. The list is copied first, so a handler
    /// may subscribe or unsubscribe without deadlocking.
    pub(crate) fn dispatch(&self, topic: &str, payload: &str) {
        let hits: Vec<Handler> = self
            .list
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(_, pattern, _)| topic_matches(pattern, topic))
            .map(|(_, _, h)| Arc::clone(h))
            .collect();
        for handler in hits {
            // One handler's panic must not cost the others their delivery or
            // kill the task dispatching (the pub/sub listener). Only reachable
            // in unwinding builds; release builds abort on panic.
            let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                handler(topic, payload);
            }));
            if ran.is_err() {
                tracing::error!(topic, "pubsub handler panicked; delivery skipped");
            }
        }
    }
}

fn topic_matches(pattern: &str, topic: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => topic.starts_with(prefix),
        None => topic == pattern,
    }
}

/// A subscription; TS's returned unsubscribe function. Dropping it
/// unsubscribes, so hold it for as long as the handler should run.
#[must_use = "dropping a Subscription unsubscribes it"]
pub struct Subscription {
    id: u64,
    /// `None` once detached by [`Subscription::forever`].
    owner: Option<std::sync::Weak<Subscribers>>,
}

impl Subscription {
    pub fn unsubscribe(self) {}

    /// Keeps the handler for the life of the coordinator. Releases this
    /// handle's reference (nothing is leaked when the coordinator goes).
    pub fn forever(mut self) {
        self.owner = None;
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take().and_then(|o| o.upgrade()) {
            owner.remove(self.id);
        }
    }
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("id", &self.id)
            .finish()
    }
}

// --- numbers on the wire --------------------------------------------------

/// A number as JS `String(n)` writes it, for every value TS sends: integers
/// without a fraction, other finite values in shortest round-trip form.
///
/// Rust's `Display` for `f64` is also shortest round-trip and differs from
/// JS only in never using an exponent (`1e-7` is written `0.0000001`), which
/// Lua `tonumber` and `HINCRBYFLOAT` read identically.
pub(crate) fn js_number(n: f64) -> String {
    let mut out = String::new();
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e21 {
        // `-0` prints as `0` in JS.
        let n = if n == 0.0 { 0.0 } else { n };
        out.push_str(&format!("{n:.0}"));
    } else if n.is_nan() {
        out.push_str("NaN");
    } else if n.is_infinite() {
        out.push_str(if n > 0.0 { "Infinity" } else { "-Infinity" });
    } else {
        out.push_str(&n.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_matches_string_of_n() {
        assert_eq!(js_number(1_700_000_000_000.0), "1700000000000");
        assert_eq!(js_number(0.5), "0.5");
        assert_eq!(js_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(-3.0), "-3");
        assert_eq!(js_number(f64::INFINITY), "Infinity");
    }

    #[test]
    fn split_sequenced_reads_back_what_publish_sequenced_writes() {
        assert_eq!(split_sequenced("5:a:b"), Some((5, "a:b")));
        assert_eq!(split_sequenced("12:"), Some((12, "")));
        assert_eq!(split_sequenced(":x"), None);
        assert_eq!(split_sequenced("0:x"), None);
        assert_eq!(split_sequenced("-1:x"), None);
        assert_eq!(split_sequenced("1.5:x"), None);
        assert_eq!(split_sequenced("x:y"), None);
        assert_eq!(split_sequenced("plain"), None);
    }

    #[test]
    fn forever_keeps_the_handler_without_leaking_the_registry() {
        let subs = Arc::new(Subscribers::default());
        let hits = Arc::new(AtomicU64::new(0));
        let h = Arc::clone(&hits);
        subs.add(
            "t",
            Arc::new(move |_, _| {
                h.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .forever();
        subs.dispatch("t", "");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        // No handle holds a weak reference any more.
        assert_eq!(Arc::weak_count(&subs), 0);
        let dropped = subs.add("u", Arc::new(|_, _| {}));
        assert_eq!(Arc::weak_count(&subs), 1);
        drop(dropped);
        assert_eq!(Arc::weak_count(&subs), 0);
        assert_eq!(subs.list.read().expect("list").len(), 1);
    }

    #[test]
    fn a_panicking_handler_does_not_cost_the_others_their_delivery() {
        let subs = Arc::new(Subscribers::default());
        let hits = Arc::new(AtomicU64::new(0));
        let _bad = subs.add("t", Arc::new(|_, _| panic!("handler bug")));
        let h = Arc::clone(&hits);
        let _good = subs.add(
            "t",
            Arc::new(move |_, _| {
                h.fetch_add(1, Ordering::SeqCst);
            }),
        );
        subs.dispatch("t", "");
        subs.dispatch("t", "");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn topic_patterns_match_exact_or_prefix() {
        assert!(topic_matches("res", "res"));
        assert!(!topic_matches("res", "res2"));
        assert!(topic_matches("console:*", "console:node-a"));
        assert!(topic_matches("*", "anything"));
        assert!(!topic_matches("console:*", "other"));
    }
}
