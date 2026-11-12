//! The immediate health path: breaker failures and state transitions written
//! one at a time through [`Store::update_health`], off the request task,
//! through a dedicated bounded queue, independent of the request-log batches.
//!
//! The spec's cluster design: "A failure or state transition is written to
//! Postgres immediately. That write uses the existing advisory-lock
//! transaction, off the request task, through a dedicated bounded queue. The
//! transition is then published on `routing`." This is that queue and that
//! write. Publishing is the caller's: every committed row goes to
//! [`HealthWriterConfig::commit_sink`] (the row the mutation proposed, which
//! is what was stored except that a fractional instant is stored rounded to
//! its BIGINT; the same row TS's `updateHealth` returns and its snapshot
//! patch uses), and the cluster integration forwards it to the `routing`
//! topic.
//!
//! **Why a mutation, not a row.** A replica proposing an absolute row
//! computed from its own snapshot would overwrite another replica's failure
//! landing in between. The request path sends the *change* (`recordFailure`,
//! a transition) as a closure; it is applied to the row the database holds
//! under the pair's lock, as TS's `updateHealth(…, apply)` does.
//!
//! **Bounds.** `send` is a `try_send`: a full queue drops the mutation and
//! counts it (the request is never held up), warned rate-limited from the
//! task. One mutation is applied at a time, in order (FIFO, so
//! non-commutative mutations land in send order).
//!
//! **Outcomes.** Every accepted mutation ends in exactly one of:
//! - `written`: committed;
//! - `refused`: the database refused its values (no such credential, a
//!   value its columns cannot hold); not retried;
//! - `failed`: a failure known to have rolled back (a lock or statement
//!   timeout or a lost connection before COMMIT; at COMMIT, only a
//!   serialization failure `40001` or deadlock `40P01` at severity ERROR),
//!   after the retries (`retried` counts the extra attempts), or a
//!   permanent error;
//! - `uncertain`: COMMIT's outcome is unknown: its answer was lost with
//!   the connection, or was any error not on the rollback allowlist
//!   (FATAL/PANIC, `40003` statement completion unknown, any other code;
//!   see `pg::health`). It may have committed, so it is **never
//!   re-applied** (a `+1` would count twice). The row is re-read once and
//!   reported to the sink as [`HealthCommitted::Uncertain`] with what that
//!   read saw. Frozen TS does not re-apply either: `updateHealth` has no
//!   retry loop and throws once. What happens to that throw depends on the
//!   `persistHealth` call site in `apps/gateway/src/dispatch/index.ts`:
//!   only the post-error-event write (821) catches and logs it; the success
//!   writes (750, 866) turn it into that attempt's failure; the half-open
//!   probe (586) and failure (940) writes propagate it out of `run()`. The
//!   writer matches the store-level rule (no re-application), not those
//!   call-site consequences, which belong to the gateway integration;
//! - `panicked`: the mutation closure panicked (an arithmetic overflow, say).
//!   Its transaction rolled back as it unwound; the next mutation proceeds;
//! - `abandoned`: still queued or in flight when the worker itself ended
//!   abnormally (reported only by a failed [`HealthWriter::close`]).
//!
//! **Close boundary.** [`HealthWriter::close`] marks the writer closing when
//! it is called (before its future is first polled), so a `send` that
//! starts after that is refused (`false`, counted `dropped`).
//!
//! Admission is settled before the counters are read. Each `send` registers
//! itself in flight *before* it looks at the closing flag, and leaves only
//! after it has accounted for its job (`enqueued` or `dropped`). Leaving is
//! a guard's drop, so it happens on an unwind too, and a rejected job is
//! dropped only after the sender has left: a destructor the closure's
//! captures run (it may be the last reference) cannot keep `close`
//! waiting, whether it panics or blocks. `close`
//! sets the flag, then waits (asynchronously) for the in-flight count to
//! reach zero, and only then stops and joins the worker. The two sides use
//! the store-then-load pattern on sequentially consistent atomics, so either
//! the sender sees the flag and refuses, or `close` sees the sender and
//! waits for it. A sender never waits for `close` or for the database. So a
//! send racing `close` is either refused or accepted, accounted, and
//! (normally) applied before `close` returns, and the final counters hold
//! `enqueued == written + refused + failed + uncertain + panicked`
//! (+ `abandoned` after an abnormal end).

use crate::backend::Store;
use crate::credentials::CredentialHealth;
use crate::error::StoreError;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

/// A change to one row's health, applied to what is stored.
pub type HealthMutation = Arc<dyn Fn(Option<CredentialHealth>) -> CredentialHealth + Send + Sync>;

/// What the commit sink hears, in this writer's order.
#[derive(Debug, Clone, PartialEq)]
pub enum HealthCommitted {
    /// Committed: the row the mutation proposed (see the module docs on
    /// rounding).
    Written { row: CredentialHealth },
    /// COMMIT's outcome is unknown and the mutation was not re-applied.
    /// `observed` is one later read of the row: an observation, not an
    /// acknowledgement. It may already include other replicas' writes, or
    /// precede the server finishing this COMMIT, so it never says whether
    /// this mutation landed.
    Uncertain {
        credential_id: String,
        model: String,
        observed: Observed,
    },
}

/// What the re-read after an uncertain commit saw.
#[derive(Debug, Clone, PartialEq)]
pub enum Observed {
    /// The row, as read then.
    Row(CredentialHealth),
    /// No row for the pair, as read then. Not a reset to closed.
    Absent,
    /// The re-read failed too; nothing is known.
    Unknown(String),
}

/// How the health path is bounded.
#[derive(Clone)]
pub struct HealthWriterConfig {
    /// Queue capacity, in mutations. Breaker decisions are rare next to
    /// requests (one per failure at most), so this is small. A count, not a
    /// byte bound: closures may capture anything.
    pub capacity: usize,
    /// Attempts per mutation on a failure known to have rolled back.
    pub max_attempts: u32,
    /// First retry delay; doubled for each later one.
    pub retry_base: Duration,
    /// Where outcomes go, in order (`try_send`: a full or closed sink drops
    /// the notification, counted in `sink_dropped`; the database is not
    /// affected and the `config_version` poll still sees the change).
    pub commit_sink: Option<mpsc::Sender<HealthCommitted>>,
    /// At most one dropped-mutation warning per this long.
    pub drop_warn_interval: Duration,
}

impl Default for HealthWriterConfig {
    fn default() -> Self {
        Self {
            capacity: 1024,
            max_attempts: 3,
            retry_base: Duration::from_millis(50),
            commit_sink: None,
            drop_warn_interval: Duration::from_secs(10),
        }
    }
}

impl std::fmt::Debug for HealthWriterConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HealthWriterConfig")
            .field("capacity", &self.capacity)
            .field("max_attempts", &self.max_attempts)
            .field("retry_base", &self.retry_base)
            .field("commit_sink", &self.commit_sink.is_some())
            .finish_non_exhaustive()
    }
}

/// What the health path has done so far. Once closed cleanly,
/// `enqueued == written + refused + failed + uncertain + panicked`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct HealthStats {
    /// Mutations accepted into the queue.
    pub enqueued: u64,
    /// Refused because the queue was full, closing or closed.
    pub dropped: u64,
    /// Committed.
    pub written: u64,
    /// Refused by the database for their values; not retried.
    pub refused: u64,
    /// Not committed: known rolled back, after the retries.
    pub failed: u64,
    /// COMMIT's outcome unknown: not re-applied, re-read and reported.
    pub uncertain: u64,
    /// The mutation closure panicked; rolled back.
    pub panicked: u64,
    /// Extra attempts after a known rollback (not mutations).
    pub retried: u64,
    /// Outcomes the commit sink had no room for (or was closed).
    pub sink_dropped: u64,
    /// Accepted but never resolved because the worker ended abnormally.
    pub abandoned: u64,
}

impl HealthStats {
    fn resolved(&self) -> u64 {
        self.written + self.refused + self.failed + self.uncertain + self.panicked
    }
}

/// [`HealthWriter::close`] when the worker did not finish normally.
#[derive(Debug, thiserror::Error)]
#[error("health writer ended abnormally ({reason}); {} accepted mutations abandoned", .stats.abandoned)]
pub struct HealthWriterError {
    pub reason: String,
    /// The final counters, `abandoned` included.
    pub stats: HealthStats,
}

#[derive(Debug, Default)]
struct Counters {
    closing: AtomicBool,
    /// Senders between registering and accounting for their job.
    in_flight: AtomicU64,
    /// Woken when `in_flight` drops to zero.
    settled: Notify,
    #[cfg(test)]
    hooks: hooks::Hooks,
    enqueued: AtomicU64,
    dropped: AtomicU64,
    written: AtomicU64,
    refused: AtomicU64,
    failed: AtomicU64,
    uncertain: AtomicU64,
    panicked: AtomicU64,
    retried: AtomicU64,
    sink_dropped: AtomicU64,
}

impl Counters {
    fn snapshot(&self) -> HealthStats {
        let l = |a: &AtomicU64| a.load(Ordering::SeqCst);
        HealthStats {
            enqueued: l(&self.enqueued),
            dropped: l(&self.dropped),
            written: l(&self.written),
            refused: l(&self.refused),
            failed: l(&self.failed),
            uncertain: l(&self.uncertain),
            panicked: l(&self.panicked),
            retried: l(&self.retried),
            sink_dropped: l(&self.sink_dropped),
            abandoned: 0,
        }
    }

    fn bump(a: &AtomicU64) {
        a.fetch_add(1, Ordering::SeqCst);
    }
}

/// One sender's registration in `in_flight`, released on drop, so an unwind
/// out of `send` cannot leave `close` waiting for a sender that is gone.
struct Admission<'a>(&'a Counters);

impl<'a> Admission<'a> {
    fn enter(c: &'a Counters) -> Self {
        c.in_flight.fetch_add(1, Ordering::SeqCst);
        Self(c)
    }
}

impl Drop for Admission<'_> {
    fn drop(&mut self) {
        if self.0.in_flight.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.settled.notify_waiters();
        }
    }
}

struct Job {
    credential_id: String,
    model: String,
    apply: HealthMutation,
}

/// The request path's side: cheap to clone, and [`Self::send`] never waits.
#[derive(Clone)]
pub struct HealthHandle {
    tx: mpsc::Sender<Job>,
    counters: Arc<Counters>,
}

impl std::fmt::Debug for HealthHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HealthHandle")
            .field("stats", &self.counters.snapshot())
            .finish()
    }
}

impl HealthHandle {
    /// Queues `apply` for (`credential_id`, `model`). `false`: dropped (queue
    /// full, writer closing or closed), counted. Nothing here but a flag
    /// check and a `try_send`.
    ///
    /// A rejected `apply` is dropped last, after the rejection is counted
    /// and the admission released: dropping it may run a destructor of
    /// whatever the closure captured (it may hold the last reference), and
    /// such a destructor, panicking or blocking, must not hold up `close`.
    pub fn send(&self, credential_id: &str, model: &str, apply: HealthMutation) -> bool {
        let c = &*self.counters;
        // Register first, then look at the flag (see the module docs): a
        // `close` that set the flag before this load is refused below; one
        // that sets it after waits for this send to leave.
        let admission = Admission::enter(c);
        let rejected = if c.closing.load(Ordering::SeqCst) {
            Some(apply)
        } else {
            let job = Job {
                credential_id: credential_id.to_owned(),
                model: model.to_owned(),
                apply,
            };
            match self.tx.try_send(job) {
                Ok(()) => {
                    #[cfg(test)]
                    c.hooks.after_publish();
                    None
                }
                // Keep only the closure; the job's strings drop here.
                Err(e) => Some(e.into_inner().apply),
            }
        };
        let ok = rejected.is_none();
        Counters::bump(if ok { &c.enqueued } else { &c.dropped });
        drop(admission);
        drop(rejected);
        ok
    }

    pub fn stats(&self) -> HealthStats {
        self.counters.snapshot()
    }
}

/// The running health path. [`Self::close`] drains what is queued.
pub struct HealthWriter {
    handle: HealthHandle,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl std::fmt::Debug for HealthWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HealthWriter")
            .field("handle", &self.handle)
            .finish_non_exhaustive()
    }
}

impl HealthWriter {
    /// Starts the task on the current Tokio runtime.
    pub fn spawn(store: Store, config: HealthWriterConfig) -> Self {
        let (tx, rx) = mpsc::channel(config.capacity.max(1));
        let (stop, stopped) = oneshot::channel();
        let counters = Arc::new(Counters::default());
        let task = tokio::spawn(run(store, rx, stopped, config, Arc::clone(&counters)));
        Self {
            handle: HealthHandle { tx, counters },
            stop,
            task,
        }
    }

    pub fn handle(&self) -> HealthHandle {
        self.handle.clone()
    }

    /// Refuses new sends from the call on (the flag is set here, not when
    /// the returned future is first polled), waits for sends already in
    /// flight to account for themselves, applies everything accepted, and
    /// returns the final counters. `Err` when the worker ended abnormally
    /// (it panicked or was cancelled): the error carries the counters, with
    /// the accepted mutations it never resolved in `abandoned`.
    pub fn close(
        self,
    ) -> impl std::future::Future<Output = Result<HealthStats, HealthWriterError>> + Send {
        let Self { handle, stop, task } = self;
        handle.counters.closing.store(true, Ordering::SeqCst);
        async move {
            let c = &handle.counters;
            loop {
                let settled = c.settled.notified();
                tokio::pin!(settled);
                // Registered before the check, so a sender leaving between
                // the check and the await still wakes it.
                settled.as_mut().enable();
                if c.in_flight.load(Ordering::SeqCst) == 0 {
                    break;
                }
                settled.await;
            }
            // Every accepted job is now queued and counted. An Err means the
            // task already ended; the join says how.
            stop.send(()).ok();
            finish(task.await, c)
        }
    }
}

/// The close's verdict from the worker's join.
fn finish(
    joined: Result<(), tokio::task::JoinError>,
    counters: &Counters,
) -> Result<HealthStats, HealthWriterError> {
    let mut stats = counters.snapshot();
    match joined {
        Ok(()) => Ok(stats),
        Err(e) => {
            stats.abandoned = stats.enqueued.saturating_sub(stats.resolved());
            tracing::error!(
                reason = %e,
                count = stats.abandoned,
                "health writer ended abnormally; accepted breaker mutations abandoned"
            );
            Err(HealthWriterError {
                reason: e.to_string(),
                stats,
            })
        }
    }
}

/// One mutation through `update_health`, which isolates a panic in the
/// closure as `StoreError::Panicked` on both backends: this mutation's
/// outcome, not the worker's end.
async fn attempt(store: &Store, job: &Job) -> Result<CredentialHealth, StoreError> {
    store
        .update_health(&job.credential_id, &job.model, Arc::clone(&job.apply))
        .await
}

/// The text a panic payload carries.
pub(crate) fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".to_owned())
}

fn notify(config: &HealthWriterConfig, counters: &Counters, m: HealthCommitted) {
    if let Some(sink) = &config.commit_sink
        && sink.try_send(m).is_err()
    {
        Counters::bump(&counters.sink_dropped);
    }
}

async fn run(
    store: Store,
    mut rx: mpsc::Receiver<Job>,
    mut stop: oneshot::Receiver<()>,
    config: HealthWriterConfig,
    counters: Arc<Counters>,
) {
    let mut warned: Option<(Instant, u64)> = None;
    let mut stopping = false;
    loop {
        let job = tokio::select! {
            biased;
            _ = &mut stop, if !stopping => {
                // Refuse new mutations; `recv` still yields the queued ones.
                stopping = true;
                rx.close();
                continue;
            }
            job = rx.recv() => job,
        };
        let Some(job) = job else { break };
        #[cfg(test)]
        counters.hooks.on_job();
        let dropped = counters.dropped.load(Ordering::SeqCst);
        if dropped > warned.map_or(0, |w| w.1)
            && warned.is_none_or(|w| w.0.elapsed() >= config.drop_warn_interval)
        {
            tracing::warn!(
                count = dropped - warned.map_or(0, |w| w.1),
                rawCount = dropped,
                "health writer is full; breaker mutations dropped"
            );
            warned = Some((Instant::now(), dropped));
        }
        let mut n = 1;
        loop {
            match attempt(&store, &job).await {
                Ok(row) => {
                    Counters::bump(&counters.written);
                    notify(&config, &counters, HealthCommitted::Written { row });
                    break;
                }
                Err(StoreError::Refused(reason)) => {
                    Counters::bump(&counters.refused);
                    tracing::warn!(
                        credentialId = %job.credential_id,
                        reason = %reason,
                        "breaker health write refused"
                    );
                    break;
                }
                Err(StoreError::UncertainCommit(reason)) => {
                    // Never re-applied: it may have committed.
                    Counters::bump(&counters.uncertain);
                    let observed = match store.read_health(&job.credential_id, &job.model).await {
                        Ok(Some(row)) => Observed::Row(row),
                        Ok(None) => Observed::Absent,
                        Err(e) => {
                            tracing::warn!(reason = %e, "health re-read after an uncertain commit failed");
                            Observed::Unknown(e.to_string())
                        }
                    };
                    tracing::error!(
                        credentialId = %job.credential_id,
                        reason = %reason,
                        "breaker health commit outcome unknown; not re-applied, row re-read"
                    );
                    notify(
                        &config,
                        &counters,
                        HealthCommitted::Uncertain {
                            credential_id: job.credential_id.clone(),
                            model: job.model.clone(),
                            observed,
                        },
                    );
                    break;
                }
                Err(StoreError::Panicked(reason)) => {
                    Counters::bump(&counters.panicked);
                    tracing::error!(
                        credentialId = %job.credential_id,
                        reason = %reason,
                        "breaker health mutation panicked; rolled back"
                    );
                    break;
                }
                Err(e) if super::task::transient(&e) && n < config.max_attempts => {
                    Counters::bump(&counters.retried);
                    sleep(config.retry_base * 2u32.pow(n - 1)).await;
                    n += 1;
                }
                Err(e) => {
                    Counters::bump(&counters.failed);
                    tracing::error!(
                        credentialId = %job.credential_id,
                        attempts = n,
                        reason = %e,
                        "breaker health write failed"
                    );
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A worker that ended abnormally makes `close` fail, with the accepted
    /// mutations it never resolved counted as abandoned.
    #[tokio::test]
    async fn an_abnormal_worker_end_fails_close_and_counts_abandoned_work() {
        let c = Counters::default();
        for _ in 0..5 {
            Counters::bump(&c.enqueued);
        }
        Counters::bump(&c.written);
        Counters::bump(&c.panicked);
        let joined = tokio::spawn(async { panic!("worker bug") }).await;
        let err = finish(joined, &c).expect_err("abnormal end");
        assert_eq!(err.stats.abandoned, 3);
        assert!(err.reason.contains("panicked"), "{}", err.reason);
        assert!(
            err.to_string().contains("3 accepted mutations abandoned"),
            "{err}"
        );
        let ok = finish(Ok(()), &c).expect("normal end");
        assert_eq!(ok.abandoned, 0);
    }
}

#[cfg(test)]
mod hooks {
    //! Test-only seams: pause a sender between publishing its job and
    //! accounting for it, and end the worker abnormally on its next job.
    use std::sync::{Arc, Condvar, Mutex};

    #[derive(Debug, Default)]
    pub(super) struct Pause {
        state: Mutex<(bool, bool)>, // (parked, released)
        cv: Condvar,
    }

    impl Pause {
        pub(super) fn wait_until_parked(&self) {
            let mut s = self.state.lock().expect("pause");
            while !s.0 {
                s = self.cv.wait(s).expect("pause");
            }
        }

        pub(super) fn release(&self) {
            self.state.lock().expect("pause").1 = true;
            self.cv.notify_all();
        }

        /// Parks the calling thread until [`Self::release`].
        pub(super) fn park_here(&self) {
            self.park();
        }

        fn park(&self) {
            let mut s = self.state.lock().expect("pause");
            s.0 = true;
            self.cv.notify_all();
            while !s.1 {
                s = self.cv.wait(s).expect("pause");
            }
        }
    }

    #[derive(Debug, Default)]
    pub(super) struct Hooks {
        pause: Mutex<Option<Arc<Pause>>>,
        kill: std::sync::atomic::AtomicBool,
    }

    impl Hooks {
        pub(super) fn pause_next_send(&self) -> Arc<Pause> {
            let p = Arc::new(Pause::default());
            *self.pause.lock().expect("hooks") = Some(Arc::clone(&p));
            p
        }

        pub(super) fn kill_worker_on_next_job(&self) {
            self.kill.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        pub(super) fn after_publish(&self) {
            let p = self.pause.lock().expect("hooks").take();
            if let Some(p) = p {
                p.park();
            }
        }

        pub(super) fn on_job(&self) {
            if self.kill.swap(false, std::sync::atomic::Ordering::SeqCst) {
                panic!("health worker killed by a test hook");
            }
        }
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;

    /// A migrated SQLite store with no credentials: a mutation on `ghost`
    /// is refused by the foreign key, deterministically.
    async fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("omni.db");
        let store = Store::open(crate::StoreConfig::Sqlite { path }, 0)
            .await
            .expect("open");
        (dir, store)
    }

    fn ghost() -> HealthMutation {
        Arc::new(|_| CredentialHealth {
            credential_id: "ghost".into(),
            model: "m".into(),
            breaker_state: crate::BreakerState::Closed,
            consecutive_failures: 1,
            opened_at: None,
            rate_limited_until: None,
        })
    }

    /// Polls `close`'s future directly, several times, while a sender is
    /// parked between publishing and accounting: each poll must be
    /// `Pending`. Polling it here (not spawning it and sleeping) proves the
    /// future reached its wait, whatever the scheduler does.
    async fn assert_pending_while_parked<F: std::future::Future>(mut close: std::pin::Pin<&mut F>) {
        for i in 0..5 {
            let polled = std::future::poll_fn(|cx| {
                std::task::Poll::Ready(close.as_mut().poll(cx).is_pending())
            })
            .await;
            assert!(polled, "close waits for the paused sender (poll {i})");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The window the review names: a sender has published its job but not
    /// yet accounted for it when `close` runs. `close` waits for that
    /// sender, so the final counters are exact. Normal close.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn close_waits_for_a_sender_paused_between_publish_and_accounting() {
        let (_dir, store) = store().await;
        let writer = HealthWriter::spawn(store, HealthWriterConfig::default());
        let h = writer.handle();
        let paused = h.counters.hooks.pause_next_send();
        let sender = std::thread::spawn(move || h.send("ghost", "m", ghost()));
        let p = Arc::clone(&paused);
        tokio::task::spawn_blocking(move || p.wait_until_parked())
            .await
            .expect("parked");
        // The job is queued; the sender has not counted it yet.
        let mut closing = Box::pin(writer.close());
        assert_pending_while_parked(closing.as_mut()).await;
        paused.release();
        assert!(sender.join().expect("sender"), "the send was accepted");
        let stats = closing.await.expect("close");
        assert_eq!((stats.enqueued, stats.refused), (1, 1), "{stats:?}");
        assert_eq!(stats.enqueued, stats.resolved(), "{stats:?}");
    }

    /// The same window, with the worker ending abnormally on that job: the
    /// accepted, unresolved job is counted abandoned.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn abnormal_close_counts_a_job_published_by_a_paused_sender_as_abandoned() {
        let (_dir, store) = store().await;
        let writer = HealthWriter::spawn(store, HealthWriterConfig::default());
        let h = writer.handle();
        h.counters.hooks.kill_worker_on_next_job();
        let paused = h.counters.hooks.pause_next_send();
        let sender = std::thread::spawn(move || h.send("ghost", "m", ghost()));
        let p = Arc::clone(&paused);
        tokio::task::spawn_blocking(move || p.wait_until_parked())
            .await
            .expect("parked");
        let mut closing = Box::pin(writer.close());
        assert_pending_while_parked(closing.as_mut()).await;
        paused.release();
        assert!(sender.join().expect("sender"));
        let err = closing.await.expect_err("the worker died");
        assert_eq!(
            (
                err.stats.enqueued,
                err.stats.abandoned,
                err.stats.resolved()
            ),
            (1, 1, 0),
            "{:?}",
            err.stats
        );
    }

    /// A send that starts after `close` is called (its future not yet
    /// polled) is refused.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_send_after_close_is_called_is_refused_before_the_future_is_polled() {
        let (_dir, store) = store().await;
        let writer = HealthWriter::spawn(store, HealthWriterConfig::default());
        let h = writer.handle();
        let closing = writer.close();
        assert!(!h.send("ghost", "m", ghost()));
        let stats = closing.await.expect("close");
        assert_eq!((stats.enqueued, stats.dropped), (0, 1));
    }

    /// Panics when dropped: a value a mutation closure captures.
    struct Bomb;

    impl Drop for Bomb {
        fn drop(&mut self) {
            panic!("a captured value's destructor panicked");
        }
    }

    /// A send the full queue rejects owns the only reference to a closure
    /// whose captured value panics on drop. That panic reaches the producer
    /// (caught here), but only after the rejection is counted and the
    /// admission released: `close` still completes, and the counters add up.
    #[tokio::test(flavor = "current_thread")]
    async fn a_panicking_destructor_in_a_rejected_send_does_not_strand_close() {
        let (_dir, store) = store().await;
        let writer = HealthWriter::spawn(
            store,
            HealthWriterConfig {
                capacity: 1,
                ..HealthWriterConfig::default()
            },
        );
        let h = writer.handle();
        // Current-thread runtime, no yield since the spawn: the worker has
        // not run, so this fills the queue.
        assert!(h.send("ghost", "m", ghost()));
        let bomb = Bomb;
        let rejected: HealthMutation = Arc::new(move |c| {
            let _held = &bomb;
            ghost()(c)
        });
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.send("ghost", "m", rejected)
        }));
        let payload = caught.expect_err("the destructor's panic reaches the producer");
        assert!(
            panic_message(payload).contains("destructor panicked"),
            "the Bomb's panic"
        );
        let stats = tokio::time::timeout(Duration::from_secs(5), writer.close())
            .await
            .expect("close is not stranded by the rejected send")
            .expect("close");
        assert_eq!(h.counters.in_flight.load(Ordering::SeqCst), 0);
        assert_eq!(
            (
                stats.enqueued,
                stats.dropped,
                stats.refused,
                stats.resolved()
            ),
            (1, 1, 1, 1),
            "{stats:?}"
        );
    }

    /// Blocks in its destructor until released, saying when it got there.
    struct Stall(Arc<hooks::Pause>);

    impl Drop for Stall {
        fn drop(&mut self) {
            self.0.park_here();
        }
    }

    /// A rejected send whose closure's captured value *blocks* in its
    /// destructor: the rejection is already counted and the admission
    /// released when that destructor runs, so `close` completes while the
    /// sender is still stuck in it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_blocking_destructor_in_a_rejected_send_does_not_hold_close() {
        let (_dir, store) = store().await;
        let writer = HealthWriter::spawn(store, HealthWriterConfig::default());
        let h = writer.handle();
        let closing = writer.close();
        let stall = Arc::new(hooks::Pause::default());
        let held = Stall(Arc::clone(&stall));
        let rejected: HealthMutation = Arc::new(move |c| {
            let _held = &held;
            ghost()(c)
        });
        let sender = std::thread::spawn(move || h.send("ghost", "m", rejected));
        let s = Arc::clone(&stall);
        tokio::task::spawn_blocking(move || s.wait_until_parked())
            .await
            .expect("the destructor is running");
        let stats = tokio::time::timeout(Duration::from_secs(5), closing)
            .await
            .expect("close does not wait for the rejected job's destructor")
            .expect("close");
        assert_eq!((stats.enqueued, stats.dropped), (0, 1), "{stats:?}");
        stall.release();
        assert!(!sender.join().expect("sender"), "refused");
    }
}
