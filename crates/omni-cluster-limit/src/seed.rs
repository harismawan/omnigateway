//! The background seeder: TS `seed` off the request path.
//!
//! A long window the admission script found unseeded is queued here (once:
//! a window queued or failed within `seed_retry` is not queued again). A
//! worker takes the existing `omni:lock:seed:<bucket>` mutex
//! (`SEED_LOCK_MS` TTL and wait), re-checks inside it (another replica may
//! have installed the picture), reads [`crate::UsageSource::sum_buckets`],
//! and runs `BUCKETS_SEED` — TS's `install`, step for step. A lock that
//! cannot be taken seeds anyway, as TS does (two seeds install the same
//! picture). Everything goes through `Remote`, never the memory fallback: a
//! seed that cannot reach the server fails and is retried later.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use omni_coord::{CoordError, with_lock};
use omni_ratelimit::Window;
use tokio::sync::{Notify, Semaphore};

use crate::subject::{Subject, bucket_key, grain_ms};
use crate::{Inner, bump};

/// Seeds run at once, across subjects.
const PARALLEL: usize = 4;

#[derive(Default)]
struct State {
    queue: VecDeque<(Subject, Window)>,
    /// Queued, running, or failed within `seed_retry`: not asked again.
    asked: HashMap<(String, Window), Instant>,
    running: usize,
}

pub(crate) struct Seeds {
    state: Mutex<State>,
    cap: usize,
    wake: Arc<Notify>,
    idle: Notify,
    stopped: AtomicBool,
}

impl Seeds {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            state: Mutex::new(State::default()),
            cap,
            wake: Arc::new(Notify::new()),
            idle: Notify::new(),
            stopped: AtomicBool::new(false),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Queues a seed of `subject`'s `window` unless one is queued, running or
/// recently failed, or the queue is full. Whether it was queued.
pub(crate) fn want(inner: &Inner, subject: &Subject, window: Window) -> bool {
    let seeds = &inner.seeds;
    {
        let mut st = seeds.state();
        let slot = (subject.id.clone(), window);
        if let Some(at) = st.asked.get(&slot)
            && at.elapsed() < inner.opts.seed_retry
        {
            return false;
        }
        if st.queue.len() >= seeds.cap {
            return false;
        }
        st.asked.insert(slot, Instant::now());
        st.queue.push_back((subject.clone(), window));
    }
    bump(&inner.metrics.seeds_queued);
    seeds.wake.notify_one();
    true
}

/// Why a seed did not install.
#[derive(Debug)]
pub(crate) enum SeedError {
    Store(String),
    Coord(String),
}

/// TS `seed(subject, window, now)`: under the lock (or without it when it
/// cannot be taken), re-check, read the store, install.
pub(crate) async fn run(
    inner: &Inner,
    subject: &Subject,
    window: Window,
    now: f64,
) -> Result<(), SeedError> {
    let wait = Duration::from_millis(inner.opts.seed_lock_ms);
    let lock = format!("seed:{}", bucket_key(&subject.id, window));
    let locked = with_lock(
        inner.coord.as_ref(),
        &lock,
        inner.opts.seed_lock_ms,
        wait,
        || install(inner, subject, window, now),
    )
    .await;
    let out = match locked {
        Ok(out) => out,
        Err(CoordError::LockUnavailable(_)) => {
            bump(&inner.metrics.seed_lock_unavailable);
            install(inner, subject, window, now).await
        }
        Err(e) => Err(SeedError::Coord(e.to_string())),
    };
    if let Err(e) = &out {
        bump(&inner.metrics.seed_failures);
        let reason = match e {
            SeedError::Store(r) | SeedError::Coord(r) => r.as_str(),
        };
        tracing::warn!(
            api_key_id = subject.key_id.as_str(),
            model = subject.model.as_deref().unwrap_or(""),
            window = window.as_str(),
            reason,
            "rate limit counters unavailable; seed failed"
        );
    }
    out
}

async fn install(
    inner: &Inner,
    subject: &Subject,
    window: Window,
    now: f64,
) -> Result<(), SeedError> {
    let name = bucket_key(&subject.id, window);
    let grain = grain_ms(window);
    let length = window.ms();
    let remote = &inner.remote;
    let coord_err = |f: omni_coord::Fault| SeedError::Coord(f.reason().to_owned());
    // Every debit this process has pending lands (ignored) before the read,
    // and any made until the seed is installed is ignored: TS's order.
    let seeding = crate::debit::seeding(inner, &name).await;
    if remote
        .buckets_sum(&name, grain, length, now)
        .await
        .map_err(coord_err)?
        .is_some()
    {
        bump(&inner.metrics.seeds_already);
        return Ok(());
    }
    let rows = inner
        .usage
        .sum_buckets(
            &subject.key_id,
            now - length,
            grain,
            subject.model.as_deref(),
        )
        .await
        .map_err(SeedError::Store)?;
    let ranges = inner
        .usage
        .row_ranges(
            &subject.key_id,
            now - length,
            grain,
            subject.model.as_deref(),
        )
        .await
        .map_err(SeedError::Store)?;
    remote
        .buckets_seed(&name, grain, length, now, &rows)
        .await
        .map_err(coord_err)?;
    // The row ranges beside the counts, in a second call after the seed
    // (BUCKETS_SEED stays TS's script). A debit landing between the two is
    // only widened by them: `ranges` writes min/max, never replaces.
    if !ranges.is_empty() {
        write_ranges(inner, &name, grain, &ranges)
            .await
            .map_err(coord_err)?;
    }
    seeding.installed();
    bump(&inner.metrics.seeds_installed);
    Ok(())
}

/// Merges seeded row ranges into the (now seeded) hash, min/max per range
/// bucket, in chunks that keep one call well under the request cap.
async fn write_ranges(
    inner: &Inner,
    name: &str,
    grain: f64,
    ranges: &[crate::RowRange],
) -> Result<(), omni_coord::Fault> {
    let key = [omni_coord::redis::key("b", name)];
    for chunk in ranges.chunks(2_048) {
        let mut args = Vec::with_capacity(1 + chunk.len() * 2);
        args.push(crate::js(grain));
        for (_, lo, hi) in chunk {
            args.push(crate::js(*lo));
            args.push(crate::js(*hi));
        }
        inner
            .remote
            .eval(&crate::scripts::RANGES_MERGE, &key, &args)
            .await?;
    }
    Ok(())
}

pub(crate) fn spawn(inner: &Arc<Inner>) {
    let weak = Arc::downgrade(inner);
    let wake = Arc::clone(&inner.seeds.wake);
    tokio::spawn(worker(weak, wake));
}

async fn worker(weak: Weak<Inner>, wake: Arc<Notify>) {
    let permits = Arc::new(Semaphore::new(PARALLEL));
    loop {
        // Woken by a queued seed, or every so often to notice the limiter
        // has gone.
        let _woken = tokio::time::timeout(Duration::from_millis(250), wake.notified()).await;
        loop {
            let Some(inner) = weak.upgrade() else { return };
            if inner.seeds.stopped.load(Ordering::SeqCst) {
                return;
            }
            let job = {
                let mut st = inner.seeds.state();
                let job = st.queue.pop_front();
                if job.is_some() {
                    st.running += 1;
                }
                job
            };
            let Some((subject, window)) = job else { break };
            let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
                return;
            };
            tokio::spawn(async move {
                let now = inner.now();
                let ok = run(&inner, &subject, window, now).await.is_ok();
                let mut st = inner.seeds.state();
                st.running -= 1;
                if ok {
                    // Installed: a later loss of the hash (an outage reseed)
                    // may ask again at once.
                    st.asked.remove(&(subject.id.clone(), window));
                }
                // A failure keeps its timestamp: not asked again before
                // `seed_retry`.
                let settled = st.running == 0 && st.queue.is_empty();
                drop(st);
                if settled {
                    inner.seeds.idle.notify_waiters();
                }
                drop(permit);
            });
        }
    }
}

pub(crate) async fn settled(inner: &Inner) {
    loop {
        let idle = inner.seeds.idle.notified();
        {
            let st = inner.seeds.state();
            if st.running == 0 && st.queue.is_empty() {
                return;
            }
        }
        // Bounded so a missed wakeup cannot hang a caller.
        let _woken = tokio::time::timeout(Duration::from_millis(50), idle).await;
    }
}

pub(crate) fn stop(inner: &Inner) {
    inner.seeds.stopped.store(true, Ordering::SeqCst);
    inner.seeds.wake.notify_one();
}
