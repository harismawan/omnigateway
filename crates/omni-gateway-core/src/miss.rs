//! The snapshot-miss fallback (spec, "The request path" rule 1): a key not
//! in the snapshot is looked up with one store read, so a key created a
//! moment ago works before the next rebuild. Guarded so that invalid keys
//! cannot drive store reads:
//!
//! - **Negative cache.** A hash the store did not have is remembered for
//!   `negative_ttl`, or until the next snapshot rebuild, whichever is first
//!   (a rebuild picks up any key created since, so the entry is moot). It
//!   holds at most `negative_capacity` hashes; when full, expired and stale
//!   entries go first, then the oldest.
//! - **Coalescing.** Concurrent misses for the same hash share one read.
//! - **Budget.** At most `max_reads_in_flight` reads run at once. A miss
//!   that finds the budget spent is [`MissResult::Shed`] immediately, with no
//!   read: the caller answers it as an unknown key (401). A key so new it is
//!   shed is still served after the next rebuild (one refresh interval).
//! - Reads run in `spawn_blocking`, never on an async worker thread.

use crate::snapshot::SnapshotHolder;
use omni_store::{ApiKey, SqliteStore};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::sync::{Semaphore, watch};
use tokio::time::Instant;

#[derive(Debug, Clone, Copy)]
pub struct MissConfig {
    pub negative_ttl: Duration,
    pub negative_capacity: usize,
    pub max_reads_in_flight: usize,
}

impl Default for MissConfig {
    fn default() -> Self {
        Self {
            negative_ttl: Duration::from_secs(30),
            negative_capacity: 10_000,
            max_reads_in_flight: 4,
        }
    }
}

#[derive(Debug, Clone)]
pub enum MissResult {
    /// The store has it; it is now in the snapshot too.
    Found(Arc<ApiKey>),
    /// The store does not have it (read now, or remembered).
    Absent,
    /// Not read: the budget was spent. Answer as an unknown key.
    Shed,
    /// The read failed; answer as an unknown key and log.
    Failed,
}

type Shared = watch::Receiver<Option<MissResult>>;

#[derive(Default)]
struct Inner {
    /// hash → (expires at, snapshot generation when recorded).
    negative: HashMap<String, (Instant, u64)>,
    in_progress: HashMap<String, Shared>,
}

struct Core {
    holder: Arc<SnapshotHolder>,
    store: Arc<Mutex<SqliteStore>>,
    config: MissConfig,
    inner: Mutex<Inner>,
    budget: Arc<Semaphore>,
    reads: AtomicU64,
    in_flight: AtomicUsize,
    peak: AtomicUsize,
}

impl Core {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn remember_absent(&self, inner: &mut Inner, hash: &str, generation: u64) {
        if self.config.negative_capacity == 0 {
            return;
        }
        let now = Instant::now();
        if inner.negative.len() >= self.config.negative_capacity {
            let current = self.holder.generation();
            inner
                .negative
                .retain(|_, (exp, g)| *g == current && *exp > now);
        }
        while inner.negative.len() >= self.config.negative_capacity {
            let Some(oldest) = inner
                .negative
                .iter()
                .min_by_key(|(_, (exp, _))| *exp)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            inner.negative.remove(&oldest);
        }
        inner.negative.insert(
            hash.to_owned(),
            (now + self.config.negative_ttl, generation),
        );
    }

    /// Publishes a finished read: caches an absence recorded against the
    /// generation the read started in (a rebuild since makes it stale), and
    /// ends the coalescing entry.
    fn finish(&self, hash: &str, generation: u64, result: &MissResult) {
        let mut inner = self.lock();
        inner.in_progress.remove(hash);
        if matches!(result, MissResult::Absent) && generation == self.holder.generation() {
            self.remember_absent(&mut inner, hash, generation);
        }
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Resolves snapshot misses with a bounded negative cache, per-hash
/// coalescing and a global read budget. Share as `Arc<MissResolver>`.
pub struct MissResolver {
    core: Arc<Core>,
}

impl std::fmt::Debug for MissResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MissResolver")
            .field("config", &self.core.config)
            .finish_non_exhaustive()
    }
}

impl MissResolver {
    /// `store` is the connection the fallback reads use (its own, so a
    /// read never waits on the refresher's).
    pub fn new(
        holder: Arc<SnapshotHolder>,
        store: Arc<Mutex<SqliteStore>>,
        config: MissConfig,
    ) -> Self {
        Self {
            core: Arc::new(Core {
                holder,
                store,
                config,
                inner: Mutex::new(Inner::default()),
                budget: Arc::new(Semaphore::new(config.max_reads_in_flight)),
                reads: AtomicU64::new(0),
                in_flight: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
            }),
        }
    }

    /// Store reads made so far.
    pub fn reads(&self) -> u64 {
        self.core.reads.load(Ordering::Relaxed)
    }

    /// Reads running now.
    pub fn in_flight(&self) -> usize {
        self.core.in_flight.load(Ordering::Relaxed)
    }

    /// The most reads ever running at once.
    pub fn peak_in_flight(&self) -> usize {
        self.core.peak.load(Ordering::Relaxed)
    }

    /// Live negative entries.
    pub fn negative_len(&self) -> usize {
        let generation = self.core.holder.generation();
        let now = Instant::now();
        let mut inner = self.core.lock();
        inner
            .negative
            .retain(|_, (exp, g)| *g == generation && *exp > now);
        inner.negative.len()
    }

    /// Resolves a hash the snapshot missed.
    pub async fn resolve(&self, hash: &str) -> MissResult {
        let core = &self.core;
        let generation = core.holder.generation();
        let mut rx = {
            let mut inner = core.lock();
            if let Some((exp, g)) = inner.negative.get(hash) {
                if *g == generation && *exp > Instant::now() {
                    return MissResult::Absent;
                }
                inner.negative.remove(hash);
            }
            if let Some(rx) = inner.in_progress.get(hash) {
                rx.clone()
            } else {
                // A key the snapshot gained since the caller's miss.
                if let Some(k) = core.holder.load().keys_by_hash.get(hash) {
                    return MissResult::Found(k.clone());
                }
                let Ok(permit) = core.budget.clone().try_acquire_owned() else {
                    return MissResult::Shed;
                };
                let (tx, rx) = watch::channel(None);
                inner.in_progress.insert(hash.to_owned(), rx.clone());
                drop(inner);
                start_read(core.clone(), hash.to_owned(), generation, permit, tx);
                rx
            }
        };
        loop {
            if let Some(result) = rx.borrow_and_update().clone() {
                return result;
            }
            if rx.changed().await.is_err() {
                return MissResult::Failed;
            }
        }
    }
}

/// Starts one read. Its completion is a task of its own, so the result is
/// published (and the coalescing entry removed, the permit returned) even
/// if every waiter is cancelled. It does no request work: one bounded read.
fn start_read(
    core: Arc<Core>,
    hash: String,
    generation: u64,
    permit: tokio::sync::OwnedSemaphorePermit,
    tx: watch::Sender<Option<MissResult>>,
) {
    let now_in_flight = core.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
    core.peak.fetch_max(now_in_flight, Ordering::Relaxed);
    core.reads.fetch_add(1, Ordering::Relaxed);
    let holder = core.holder.clone();
    let store = core.store.clone();
    let read_hash = hash.clone();
    let read = tokio::task::spawn_blocking(move || {
        let store = store.lock().unwrap_or_else(PoisonError::into_inner);
        holder.lookup_miss(&store, &read_hash)
    });
    tokio::spawn(async move {
        let result = match read.await {
            Ok(Ok(Some(k))) => MissResult::Found(k),
            Ok(Ok(None)) => MissResult::Absent,
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "api key fallback read failed");
                MissResult::Failed
            }
            Err(e) => {
                tracing::warn!(error = %e, "api key fallback read task failed");
                MissResult::Failed
            }
        };
        core.finish(&hash, generation, &result);
        drop(permit);
        tx.send_replace(Some(result));
    });
}
