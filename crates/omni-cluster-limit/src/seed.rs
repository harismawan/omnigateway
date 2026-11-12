//! The background seeder: TS `seed` off the request path, installed
//! atomically with its watermark (ruling I1/I2).
//!
//! A long window the admission script found incomplete is queued here
//! (once: a window queued, running, or failed within `seed_retry` is not
//! queued again). A worker:
//!
//! 1. takes TS's `omni:lock:seed:<bucket>` mutex (`SEED_LOCK_MS` TTL)
//!    under its own token, retrying for up to `SEED_LOCK_MS` (ruling R1:
//!    never a tokenless install — while no seed holds the lock, an
//!    incomplete picture ignores debits, and a picture read before such a
//!    debit's commit and installed after it would lose that row; a seed
//!    that cannot take the lock fails and is asked again);
//! 2. re-checks inside it — another replica may have installed a complete
//!    picture;
//! 3. reads [`crate::UsageSource::seed_read`] — counts, row ranges and the
//!    read's commit snapshot, from one consistent store snapshot — under
//!    `usage_timeout`, selecting rows with `at >= since` (`since = now −
//!    window`);
//! 4. installs all of it, with `since`, in one
//!    [`crate::scripts::SEED_INSTALL`] call, which refuses unless the lock
//!    is still this seed's.
//!
//! While the lock is held and the picture incomplete, debits for the bucket
//! wait (see [`crate::debit`]); once installed, a debited row the seed
//! counted (commit visible to its snapshot **and** `at >= since`) is
//! skipped — on every replica — and every other row is added.
//! Everything goes through `Remote`, never the memory fallback: a seed that
//! cannot reach the server fails and is retried later.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use omni_coord::redis::key;
use omni_ratelimit::Window;
use redis::Value;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinSet;

use crate::subject::{Subject, bucket_key, grain_ms};
use crate::{Inner, SeedRead, bump, scripts};

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
    /// Running seed tasks, owned so shutdown can cancel and join them.
    tasks: Mutex<JoinSet<()>>,
}

impl Seeds {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            state: Mutex::new(State::default()),
            cap,
            wake: Arc::new(Notify::new()),
            idle: Notify::new(),
            stopped: AtomicBool::new(false),
            tasks: Mutex::new(JoinSet::new()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn tasks(&self) -> std::sync::MutexGuard<'_, JoinSet<()>> {
        self.tasks.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Queues a seed of `subject`'s `window` unless one is queued, running or
/// recently failed, or the queue is full. Whether it was queued.
pub(crate) fn want(inner: &Inner, subject: &Subject, window: Window) -> bool {
    let seeds = &inner.seeds;
    if seeds.stopped.load(Ordering::SeqCst) {
        return false;
    }
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
    /// The lock lapsed before the install (the seed outran its TTL).
    LockLost,
    /// Another seed held the lock past the wait (it is seeding; this one
    /// is asked again later).
    LockBusy,
}

/// The seed lock under this seed's own token, released (token-safe,
/// detached, ordered on D2's queue) however the seed ends — success,
/// failure, or cancellation.
struct Lock<'a> {
    inner: &'a Inner,
    name: String,
    token: Option<String>,
}

impl Drop for Lock<'_> {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            // Counted and logged inside D2 on refusal; it lapses at its TTL.
            let _queued = self
                .inner
                .remote
                .lock_release_detached(&self.name, &token)
                .is_ok();
        }
    }
}

async fn lock<'a>(inner: &'a Inner, name: String) -> Option<Lock<'a>> {
    let token = uuid::Uuid::new_v4().to_string();
    let mut guard = Lock {
        inner,
        name,
        token: Some(token.clone()),
    };
    let deadline = tokio::time::Instant::now() + Duration::from_millis(inner.opts.seed_lock_ms);
    loop {
        match inner
            .remote
            .lock_try(&guard.name, &token, inner.opts.seed_lock_ms)
            .await
        {
            Ok(true) => return Some(guard),
            Ok(false) => {}
            // The SET may still land: the guard's release (queued after it)
            // undoes it.
            Err(_) => return None,
        }
        if tokio::time::Instant::now() >= deadline {
            // Not taken; nothing to release.
            guard.token = None;
            return None;
        }
        tokio::time::sleep(inner.coord_lock_poll()).await;
    }
}

/// TS `seed(subject, window, now)`, atomic and watermarked.
pub(crate) async fn run(
    inner: &Inner,
    subject: &Subject,
    window: Window,
    now: f64,
) -> Result<(), SeedError> {
    let bucket = bucket_key(&subject.id, window);
    let held = lock(inner, format!("seed:{bucket}")).await;
    let out = match held.as_ref().and_then(|l| l.token.clone()) {
        Some(token) => install(inner, subject, window, now, &token).await,
        None => {
            bump(&inner.metrics.seed_lock_unavailable);
            Err(SeedError::LockBusy)
        }
    };
    drop(held);
    if let Err(e) = &out {
        bump(&inner.metrics.seed_failures);
        let reason = match e {
            SeedError::Store(r) | SeedError::Coord(r) => r.as_str(),
            SeedError::LockLost => "seed lock lapsed before install",
            SeedError::LockBusy => "seed lock held elsewhere past the wait",
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

async fn complete(inner: &Inner, hash: &str) -> Result<bool, omni_coord::Fault> {
    let mut pipe = redis::pipe();
    pipe.cmd("HEXISTS").arg(hash).arg("seeded");
    pipe.cmd("HEXISTS").arg(scripts::meta_key(hash)).arg("snap");
    let out = inner.remote.pipeline(pipe).await?;
    Ok(out.iter().all(|v| matches!(v, Value::Int(1))))
}

async fn install(
    inner: &Inner,
    subject: &Subject,
    window: Window,
    now: f64,
    token: &str,
) -> Result<(), SeedError> {
    let bucket = bucket_key(&subject.id, window);
    let hash = key("b", &bucket);
    let grain = grain_ms(window);
    let length = window.ms();
    let coord_err = |f: omni_coord::Fault| SeedError::Coord(f.reason().to_owned());
    if complete(inner, &hash).await.map_err(coord_err)? {
        bump(&inner.metrics.seeds_already);
        return Ok(());
    }
    let read = inner.usage.seed_read(
        &subject.key_id,
        now - length,
        grain,
        subject.model.as_deref(),
    );
    let read: SeedRead = match tokio::time::timeout(inner.opts.usage_timeout, read).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(SeedError::Store(e)),
        Err(_) => return Err(SeedError::Store("store read timed out".to_owned())),
    };
    let args = install_args(token, length, now, grain, &read)?;
    debug_assert_eq!(args[4], crate::js(now - length));
    let keys = [
        hash.clone(),
        scripts::meta_key(&hash),
        crate::debit::lock_key(&hash),
    ];
    match inner
        .remote
        .eval(&scripts::SEED_INSTALL, &keys, &args)
        .await
        .map_err(coord_err)?
    {
        Value::Int(1) => {
            bump(&inner.metrics.seeds_installed);
            Ok(())
        }
        Value::Int(0) => {
            bump(&inner.metrics.seeds_already);
            Ok(())
        }
        Value::Int(-1) => Err(SeedError::LockLost),
        _ => Err(SeedError::Coord(
            "unexpected reply to SEED_INSTALL".to_owned(),
        )),
    }
}

/// `SEED_INSTALL`'s arguments: TS's `BUCKETS_SEED` fields (`seeded 1`, then
/// per in-window bucket `<b>:r`, `<b>:t`, `<b>:c`, in the rows' order,
/// bucket starts floored and aged rows dropped exactly as TS's `seed`
/// builds them), then the in-window row ranges.
fn install_args(
    token: &str,
    length: f64,
    now: f64,
    grain: f64,
    read: &SeedRead,
) -> Result<Vec<String>, SeedError> {
    if !valid_snapshot(&read.snapshot) {
        return Err(SeedError::Store(format!(
            "seed snapshot is not xmin:xmax:xip ({} chars)",
            read.snapshot.len()
        )));
    }
    let oldest = ((now - length) / grain).floor() * grain;
    let mut fields = vec!["seeded".to_owned(), "1".to_owned()];
    for (start, c) in &read.rows {
        let b = (start / grain).floor() * grain;
        if b < oldest {
            continue;
        }
        let b = crate::js(b);
        fields.extend([
            format!("{b}:r"),
            crate::js(c.requests),
            format!("{b}:t"),
            crate::js(c.tokens),
            format!("{b}:c"),
            crate::js(c.cost_usd),
        ]);
    }
    let mut args = vec![
        token.to_owned(),
        crate::js(length * 2.0),
        read.snapshot.clone(),
        crate::js(grain),
        // The row selection the read used: `at >= since`.
        crate::js(now - length),
        (fields.len() / 2).to_string(),
    ];
    args.extend(fields);
    for (_, lo, hi) in &read.ranges {
        if *hi < now - length {
            continue;
        }
        args.push(crate::js(*lo));
        args.push(crate::js(*hi));
    }
    Ok(args)
}

/// Postgres `pg_snapshot` text: `xmin:xmax:xip,…`, decimal ids.
fn valid_snapshot(s: &str) -> bool {
    let mut parts = s.splitn(3, ':');
    let digits =
        |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let (a, b) = (parts.next(), parts.next());
    let rest = parts.next();
    digits(a)
        && digits(b)
        && rest.is_some_and(|r| r.is_empty() || r.split(',').all(|x| digits(Some(x))))
}

pub(crate) fn spawn(inner: &Arc<Inner>) -> tokio::task::JoinHandle<()> {
    let weak = Arc::downgrade(inner);
    let wake = Arc::clone(&inner.seeds.wake);
    tokio::spawn(worker(weak, wake))
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
            // The reservation's completion guard exists from here on: if
            // the worker is cancelled while waiting for a permit, dropping
            // it settles `running` (so `seeds_settled` cannot hang).
            let mut done = Done {
                inner: Arc::clone(&inner),
                slot: (subject.id.clone(), window),
                ok: false,
            };
            drop(inner);
            let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
                return;
            };
            let me = Arc::clone(&done.inner);
            let mut tasks = me.seeds.tasks();
            // Reap finished tasks so the set stays bounded by `PARALLEL`.
            while tasks.try_join_next().is_some() {}
            let run_on = Arc::clone(&me);
            tasks.spawn(async move {
                let now = run_on.now();
                done.ok = run(&run_on, &subject, window, now).await.is_ok();
                drop(done);
                drop(permit);
            });
        }
    }
}

/// Settles a seed's bookkeeping however it ends (also when cancelled).
struct Done {
    inner: Arc<Inner>,
    slot: (String, Window),
    ok: bool,
}

impl Drop for Done {
    fn drop(&mut self) {
        let mut st = self.inner.seeds.state();
        st.running -= 1;
        if self.ok {
            // Installed: a later loss of the hash (an outage reseed) may ask
            // again at once. A failure keeps its timestamp: not asked again
            // before `seed_retry`.
            st.asked.remove(&self.slot);
        }
        let settled = st.running == 0 && st.queue.is_empty();
        drop(st);
        if settled {
            self.inner.seeds.idle.notify_waiters();
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

/// Tells the worker to start nothing more.
pub(crate) fn stopping(inner: &Inner) {
    inner.seeds.stopped.store(true, Ordering::SeqCst);
    inner.seeds.wake.notify_one();
}

/// Drops queued seeds and cancels running ones (each releases its lock as
/// it is dropped), waiting until they have ended. Call once the worker has
/// stopped (or been joined).
pub(crate) async fn stop(inner: &Inner) {
    stopping(inner);
    inner.seeds.state().queue.clear();
    let mut tasks = std::mem::take(&mut *inner.seeds.tasks());
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_are_postgres_pg_snapshot_text() {
        assert!(valid_snapshot("739:739:"));
        assert!(valid_snapshot("5:9:6,7"));
        assert!(!valid_snapshot("5:9"));
        assert!(!valid_snapshot("5:9:6,,7"));
        assert!(!valid_snapshot("a:9:"));
        assert!(!valid_snapshot(""));
    }
}
