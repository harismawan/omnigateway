//! Load-aware ranking across replicas (spec "Cluster design"): no
//! per-request Redis load operation.
//!
//! - [`LoadPublisher`] writes this replica's in-flight counts per
//!   (credential, model) health key every `interval` (100 ms) in one
//!   [`crate::scripts::LOAD_PUBLISH`] call: the replica's hash
//!   (`omni:load:r:<replica>`) is replaced whole and given a TTL, and the
//!   replica is listed in the index (`omni:load:idx`, scored by expiry). A
//!   replica that dies stops renewing, its hash expires and the next
//!   snapshot prunes it from the index, so a dead replica's load vanishes
//!   within `ttl`.
//! - The same tick refreshes the snapshot ([`crate::scripts::LOAD_SNAPSHOT`]):
//!   every *other* live replica's counts summed per key. [`LoadView::counts`]
//!   is that plus this process's own exact local counts, which is what
//!   ranking reads.
//!
//! Bounded: at most `min(max_keys, fleet_max_keys)` keys are published per
//! tick (the busiest first). The snapshot script reads at most
//! `max_replicas` pictures, each up to `fleet_max_keys` fields — every
//! publisher's bound, so a picture is read whole and the totals are exact —
//! and returns this reader's `max_keys` busiest totals: work and reply are
//! bounded at the server. `fleet_max_keys` must be the same on every
//! replica (it is the fleet's publisher bound, not a per-reader choice). A local copy older than `ttl` (refreshes failing — the
//! coordinator is down) is not read: ranking falls back to this process's
//! own counts rather than a picture that may hold dead replicas.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use omni_coord::Clock;
use omni_coord::redis::{Remote, key};
use redis::Value;

use crate::scripts;

/// Where a replica's hash lives (`omni:load:r:<replica>`).
pub fn replica_key(replica: &str) -> String {
    key("load", &format!("r:{replica}"))
}

/// The replica index.
pub fn index_key() -> String {
    key("load", "idx")
}

/// Where a replica builds its next picture before swapping it in.
pub fn staging_key(replica: &str) -> String {
    key("load", &format!("s:{replica}"))
}

#[derive(Debug, Clone)]
pub struct LoadOptions {
    /// This replica's identity (unique per process).
    pub replica: String,
    pub interval: Duration,
    /// How long a published picture outlives its last write.
    pub ttl: Duration,
    /// Most keys published per tick, and returned per snapshot.
    pub max_keys: usize,
    /// The fleet's publisher bound: no replica publishes more, and a
    /// snapshot reads each picture up to it. Same on every replica.
    pub fleet_max_keys: usize,
    /// Most replica pictures one snapshot reads.
    pub max_replicas: usize,
}

impl Default for LoadOptions {
    fn default() -> Self {
        Self {
            replica: omni_crypto::codex::random_uuid_v4(),
            interval: Duration::from_millis(100),
            ttl: Duration::from_millis(1_000),
            max_keys: 4_096,
            fleet_max_keys: 4_096,
            max_replicas: 256,
        }
    }
}

/// Counters for `/metrics`.
#[derive(Debug, Default)]
pub struct LoadMetrics {
    pub publishes: AtomicU64,
    pub publish_faults: AtomicU64,
    pub refreshes: AtomicU64,
    pub refresh_faults: AtomicU64,
    /// Keys left out of a publish by `max_keys`.
    pub truncated: AtomicU64,
}

/// The fleet's picture, when it was taken, and how long it may be read.
type Fleet = (Arc<HashMap<String, f64>>, Option<(Instant, Duration)>);

/// This process's in-flight counts, updated synchronously by the request
/// path (no I/O), and the fleet's picture, refreshed in the background.
#[derive(Debug, Default)]
pub struct LoadView {
    local: Mutex<HashMap<String, u64>>,
    remote: RwLock<Fleet>,
    pub metrics: LoadMetrics,
}

/// One in-flight slot; released on drop.
#[derive(Debug)]
#[must_use = "dropping the slot releases it"]
pub struct LoadSlot {
    view: Arc<LoadView>,
    key: String,
}

impl Drop for LoadSlot {
    fn drop(&mut self) {
        let mut local = self
            .view
            .local
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(n) = local.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                local.remove(&self.key);
            }
        }
    }
}

impl LoadView {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Claims one in-flight slot for `health_key`. No I/O.
    pub fn acquire(self: &Arc<Self>, health_key: &str) -> LoadSlot {
        *self
            .local
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(health_key.to_owned())
            .or_insert(0) += 1;
        LoadSlot {
            view: Arc::clone(self),
            key: health_key.to_owned(),
        }
    }

    /// This process's counts.
    pub fn local(&self) -> HashMap<String, u64> {
        self.local
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Every other live replica's counts, as last refreshed — empty once
    /// that refresh is older than the publication TTL (a replica that died
    /// meanwhile must not be read as busy).
    pub fn remote(&self) -> Arc<HashMap<String, f64>> {
        let g = self.remote.read().unwrap_or_else(PoisonError::into_inner);
        match g.1 {
            Some((at, ttl)) if at.elapsed() < ttl => Arc::clone(&g.0),
            _ => Arc::default(),
        }
    }

    /// What ranking reads: this process's exact counts plus the fleet's.
    #[allow(clippy::cast_precision_loss)]
    pub fn counts(&self) -> HashMap<String, f64> {
        let mut out: HashMap<String, f64> = self.remote().as_ref().clone();
        for (k, n) in self.local() {
            *out.entry(k).or_insert(0.0) += n as f64;
        }
        out
    }
}

/// The background task: publish, then refresh, every `interval`.
#[derive(Debug)]
pub struct LoadPublisher {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for LoadPublisher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl LoadPublisher {
    pub fn spawn(remote: Remote, view: Arc<LoadView>, clock: Clock, opts: LoadOptions) -> Self {
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(opts.interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                tick_once(&remote, &view, &clock, &opts).await;
            }
        });
        Self { task }
    }
}

/// One publish and one refresh. Public for tests and for a final publish
/// at shutdown.
pub async fn tick_once(remote: &Remote, view: &LoadView, clock: &Clock, opts: &LoadOptions) {
    publish(remote, view, clock, opts).await;
    refresh(remote, view, clock, opts).await;
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub async fn publish(remote: &Remote, view: &LoadView, clock: &Clock, opts: &LoadOptions) {
    let mut counts: Vec<(String, u64)> = view.local().into_iter().collect();
    let cap = opts.max_keys.min(opts.fleet_max_keys);
    if counts.len() > cap {
        counts.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        view.metrics
            .truncated
            .fetch_add((counts.len() - cap) as u64, Ordering::Relaxed);
        counts.truncate(cap);
    }
    let ttl = opts.ttl.as_millis() as u64;
    let expires = (clock)() + opts.ttl.as_secs_f64() * 1_000.0;
    let mut args = Vec::with_capacity(3 + counts.len() * 2);
    args.push(ttl.to_string());
    args.push(crate::js(expires.floor()));
    args.push(opts.replica.clone());
    for (k, n) in counts {
        args.push(k);
        args.push(n.to_string());
    }
    let keys = [
        replica_key(&opts.replica),
        index_key(),
        staging_key(&opts.replica),
    ];
    match remote.eval(&scripts::LOAD_PUBLISH, &keys, &args).await {
        Ok(_) => view.metrics.publishes.fetch_add(1, Ordering::Relaxed),
        Err(_) => view.metrics.publish_faults.fetch_add(1, Ordering::Relaxed),
    };
}

pub async fn refresh(remote: &Remote, view: &LoadView, clock: &Clock, opts: &LoadOptions) {
    let args = [
        crate::js(((clock)()).floor()),
        opts.replica.clone(),
        replica_key(""),
        opts.max_keys.to_string(),
        opts.max_replicas.to_string(),
        opts.fleet_max_keys.to_string(),
    ];
    let taken = Instant::now();
    let out = remote
        .eval(&scripts::LOAD_SNAPSHOT, &[index_key()], &args)
        .await;
    let Ok(Value::Array(flat)) = out else {
        // A fault keeps the last picture, read only until it is `ttl` old
        // (see `remote`).
        view.metrics.refresh_faults.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let mut map = HashMap::with_capacity(flat.len() / 2);
    for pair in flat.as_chunks::<2>().0 {
        if map.len() >= opts.max_keys {
            break;
        }
        let (Some(k), Some(n)) = (crate::text_of(&pair[0]), crate::num_of(&pair[1])) else {
            continue;
        };
        map.insert(k, n);
    }
    *view.remote.write().unwrap_or_else(PoisonError::into_inner) =
        (Arc::new(map), Some((taken, opts.ttl)));
    view.metrics.refreshes.fetch_add(1, Ordering::Relaxed);
}
