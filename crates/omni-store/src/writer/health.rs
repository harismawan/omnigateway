//! The immediate health path: breaker failures and state transitions written
//! one at a time through [`Store::update_health`], off the request task,
//! through a dedicated bounded queue, independent of the request-log batches.
//!
//! The spec's cluster design: "A failure or state transition is written to
//! Postgres immediately. That write uses the existing advisory-lock
//! transaction, off the request task, through a dedicated bounded queue. The
//! transition is then published on `routing`." This is that queue and that
//! write. Publishing is the caller's: every committed row goes to
//! [`HealthWriterConfig::commit_sink`] (the row as written, which is also
//! what a local snapshot patch wants), and the cluster integration forwards
//! it to the `routing` topic.
//!
//! **Why a mutation, not a row.** A replica proposing an absolute row
//! computed from its own snapshot would overwrite another replica's failure
//! landing in between. The request path sends the *change* (`recordFailure`,
//! a transition) as a closure; it is applied to the row the database holds
//! under the pair's lock, as TS's `updateHealth(…, apply)` does.
//!
//! **Bounds.** `send` is a `try_send`: a full queue drops the mutation and
//! counts it (the request is never held up), warned rate-limited from the
//! task. One mutation is applied at a time, in order; a transient failure
//! (lock or statement timeout, pool wait, a dropped connection) is retried
//! with backoff, a refusal (`StoreError::Refused`: no such credential, a
//! value its columns cannot hold) is counted and not retried.

use crate::backend::Store;
use crate::credentials::CredentialHealth;
use crate::error::StoreError;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

/// A change to one row's health, applied to what is stored.
pub type HealthMutation = Arc<dyn Fn(Option<CredentialHealth>) -> CredentialHealth + Send + Sync>;

/// A committed health row, for the commit sink (and so `routing`).
#[derive(Debug, Clone, PartialEq)]
pub struct HealthCommitted {
    pub row: CredentialHealth,
}

/// How the health path is bounded.
#[derive(Clone)]
pub struct HealthWriterConfig {
    /// Queue capacity, in mutations. Breaker decisions are rare next to
    /// requests (one per failure at most), so this is small.
    pub capacity: usize,
    /// Attempts per mutation on a transient failure.
    pub max_attempts: u32,
    /// First retry delay; doubled for each later one.
    pub retry_base: Duration,
    /// Where each committed row goes, in commit order (`try_send`: a full
    /// sink drops the notification, counted in `sink_dropped`; the row is
    /// committed regardless and the `config_version` poll still sees it).
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

/// What the health path has done so far.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct HealthStats {
    /// Mutations accepted into the queue.
    pub enqueued: u64,
    /// Refused because the queue was full or closed.
    pub dropped: u64,
    /// Committed.
    pub written: u64,
    /// Refused by the database for their values; not retried.
    pub refused: u64,
    /// Not committed after the retries (or a permanent error).
    pub failed: u64,
    /// Committed rows the commit sink had no room for.
    pub sink_dropped: u64,
}

#[derive(Debug, Default)]
struct Counters {
    enqueued: AtomicU64,
    dropped: AtomicU64,
    written: AtomicU64,
    refused: AtomicU64,
    failed: AtomicU64,
    sink_dropped: AtomicU64,
}

impl Counters {
    fn snapshot(&self) -> HealthStats {
        HealthStats {
            enqueued: self.enqueued.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            written: self.written.load(Ordering::Relaxed),
            refused: self.refused.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            sink_dropped: self.sink_dropped.load(Ordering::Relaxed),
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
    /// full or closed), counted. Nothing here but a `try_send`.
    pub fn send(&self, credential_id: &str, model: &str, apply: HealthMutation) -> bool {
        let job = Job {
            credential_id: credential_id.to_owned(),
            model: model.to_owned(),
            apply,
        };
        let ok = self.tx.try_send(job).is_ok();
        let c = if ok {
            &self.counters.enqueued
        } else {
            &self.counters.dropped
        };
        c.fetch_add(1, Ordering::Relaxed);
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

    /// Stops accepting (later sends are dropped and counted), applies
    /// everything already queued, and returns the final counters.
    pub async fn close(self) -> HealthStats {
        let Self { handle, stop, task } = self;
        // An Err means the task already ended.
        stop.send(()).ok();
        task.await.ok();
        handle.counters.snapshot()
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
        let dropped = counters.dropped.load(Ordering::Relaxed);
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
        let mut attempt = 1;
        loop {
            match store
                .update_health(&job.credential_id, &job.model, Arc::clone(&job.apply))
                .await
            {
                Ok(row) => {
                    counters.written.fetch_add(1, Ordering::Relaxed);
                    if let Some(sink) = &config.commit_sink
                        && sink.try_send(HealthCommitted { row }).is_err()
                    {
                        counters.sink_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                    break;
                }
                Err(StoreError::Refused(reason)) => {
                    counters.refused.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(
                        credentialId = %job.credential_id,
                        reason = %reason,
                        "breaker health write refused"
                    );
                    break;
                }
                Err(e) if super::task::transient(&e) && attempt < config.max_attempts => {
                    sleep(config.retry_base * 2u32.pow(attempt - 1)).await;
                    attempt += 1;
                }
                Err(e) => {
                    counters.failed.fetch_add(1, Ordering::Relaxed);
                    tracing::error!(
                        credentialId = %job.credential_id,
                        attempts = attempt,
                        reason = %e,
                        "breaker health write failed"
                    );
                    break;
                }
            }
        }
    }
}
