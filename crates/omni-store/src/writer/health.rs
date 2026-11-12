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
//! - `failed`: a failure known to have rolled back (lock or statement
//!   timeout, serialization failure or deadlock, a connection lost before
//!   COMMIT was sent, a COMMIT the server answered with an error), after
//!   the retries (`retried` counts the extra attempts), or a permanent error;
//! - `uncertain`: COMMIT was sent and its answer lost with the connection.
//!   It may have committed, so it is **never re-applied** (a `+1` would
//!   count twice). The row is re-read once and reported to the sink as
//!   [`HealthCommitted::Uncertain`] with what the database now holds. That is
//!   what frozen TS amounts to on the same fault: `updateHealth` throws,
//!   `persistHealth`'s callers log it, nothing re-applies the transition;
//! - `panicked`: the mutation closure panicked (an arithmetic overflow, say).
//!   Its transaction rolled back as it unwound; the next mutation proceeds;
//! - `abandoned`: still queued or in flight when the worker itself ended
//!   abnormally (reported only by a failed [`HealthWriter::close`]).
//!
//! **Close boundary.** [`HealthWriter::close`] marks the writer closing
//! before anything else, so a `send` that starts after `close` is called is
//! refused (`false`, counted `dropped`). A send racing the call may still be
//! accepted; anything accepted is applied before `close` returns.

use crate::backend::Store;
use crate::credentials::CredentialHealth;
use crate::error::StoreError;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
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
    /// `reconciled` is the row read back afterwards (`None` when there is
    /// none, or the re-read failed too); publish that, not a guess.
    Uncertain {
        credential_id: String,
        model: String,
        reconciled: Option<CredentialHealth>,
    },
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
    /// COMMIT sent, answer lost: not re-applied, re-read and reported.
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
    pub fn send(&self, credential_id: &str, model: &str, apply: HealthMutation) -> bool {
        if self.counters.closing.load(Ordering::SeqCst) {
            Counters::bump(&self.counters.dropped);
            return false;
        }
        let job = Job {
            credential_id: credential_id.to_owned(),
            model: model.to_owned(),
            apply,
        };
        let ok = self.tx.try_send(job).is_ok();
        Counters::bump(if ok {
            &self.counters.enqueued
        } else {
            &self.counters.dropped
        });
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

    /// Refuses new sends from here on, applies everything already accepted,
    /// and returns the final counters. `Err` when the worker ended
    /// abnormally (it panicked or was cancelled): the error carries the
    /// counters, with the accepted mutations it never resolved in
    /// `abandoned`.
    pub async fn close(self) -> Result<HealthStats, HealthWriterError> {
        let Self { handle, stop, task } = self;
        handle.counters.closing.store(true, Ordering::SeqCst);
        // An Err means the task already ended; the join says how.
        stop.send(()).ok();
        finish(task.await, &handle.counters)
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
                    let reconciled = store
                        .read_health(&job.credential_id, &job.model)
                        .await
                        .unwrap_or_else(|e| {
                            tracing::warn!(reason = %e, "health re-read after an uncertain commit failed");
                            None
                        });
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
                            reconciled,
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
