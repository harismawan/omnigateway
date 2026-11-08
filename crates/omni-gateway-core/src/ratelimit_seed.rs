//! The limiter's long-window seeding, ordered through the request-log writer.
//!
//! A seed is read on the writer's connection between batches, and its result
//! comes back on the same channel as the writer's committed completions, in
//! the order the writer produced them. [`RateLimiter::apply`] takes that
//! stream one event at a time; there is no interleaving to reconcile.
//!
//! Seeds are asked for in the background: a subject is admitted while its
//! seed is outstanding (spec ruling).

use crate::ratelimit::{MAX_STAMPS, RateLimiter, SeedJob, grain_ms, long_index};
use omni_ratelimit::Window;
use omni_store::writer::{Committed, SeedQuery, SeedRows, WriterHandle};
use std::sync::Arc;
use tokio::sync::mpsc;

/// The window a query's `tag` names.
fn window_of(tag: u8) -> Window {
    if tag == 1 { Window::W1 } else { Window::H5 }
}

impl RateLimiter {
    /// Row stamps retained across every subject and window: the only state
    /// that grows with traffic, bounded by the rows inside each window.
    pub fn held_debits(&self) -> usize {
        self.lock()
            .long
            .values()
            .flat_map(|w| w.iter())
            .map(|s| s.stamps.len())
            .sum()
    }

    /// Seeds asked for and not yet installed (or failed).
    pub fn seeds_pending(&self) -> usize {
        self.lock().seeding.len()
    }

    /// The queued seed jobs, removed from the queue (each stays marked as
    /// seeding until its result is applied, or until it cannot be sent).
    pub fn take_seed_jobs(&self) -> Vec<SeedJob> {
        self.lock().pending.drain(..).collect()
    }

    /// The writer query for a job.
    #[allow(clippy::cast_possible_truncation)]
    pub fn seed_query(job: &SeedJob) -> SeedQuery {
        SeedQuery {
            subject: job.subject.clone(),
            api_key_id: job.key_id.clone(),
            requested_model: job.model.clone(),
            since_ms: (job.now - job.window.ms()) as i64,
            grain_ms: grain_ms(job.window) as i64,
            tag: u8::from(long_index(job.window) == 1),
            now: job.now,
        }
    }

    /// Sends every queued job to the writer. A job the writer had no room
    /// for is unmarked, so the subject's next request asks again.
    pub fn send_seeds(&self, writer: &WriterHandle) -> usize {
        let jobs = self.take_seed_jobs();
        let mut sent = 0;
        for job in jobs {
            if writer.seed(Self::seed_query(&job)) {
                sent += 1;
            } else {
                self.lock()
                    .seeding
                    .remove(&(job.subject.clone(), long_index(job.window)));
            }
        }
        sent
    }

    /// Applies one event from the writer's commit stream, in order.
    #[allow(clippy::cast_precision_loss)]
    pub fn apply(&self, event: Committed) {
        match event {
            Committed::Completions(rows) => {
                for c in rows {
                    let Some(key) = c.api_key_id.as_deref() else {
                        continue;
                    };
                    self.debit(key, &c.requested_model, c.tokens, c.cost_usd, c.at, c.at);
                }
            }
            Committed::Seed { query, result } => self.install(&query, result),
        }
    }

    #[allow(clippy::cast_precision_loss)]
    fn install(&self, query: &SeedQuery, result: Result<SeedRows, String>) {
        let window = window_of(query.tag);
        let mut st = self.lock();
        st.seeding
            .remove(&(query.subject.clone(), long_index(window)));
        let rows = match result {
            Ok(rows) => rows,
            Err(e) => {
                drop(st);
                match &query.requested_model {
                    Some(model) => tracing::warn!(api_key_id = %query.api_key_id, model = %model,
                        reason = %e, "rate limit counters unavailable"),
                    None => tracing::warn!(api_key_id = %query.api_key_id,
                        reason = %e, "rate limit counters unavailable"),
                }
                return;
            }
        };
        let state = &mut st.long_of(&query.subject)[long_index(window)];
        if state.buckets.is_seeded() {
            return;
        }
        let buckets: Vec<(f64, omni_ratelimit::buckets::Counts)> = rows
            .buckets
            .into_iter()
            .map(|(start, c)| (start as f64, c))
            .collect();
        state.buckets.seed(query.now, &buckets);
        state.stamps = rows.stamps.into_iter().map(|s| s as f64).collect();
        while state.stamps.len() > MAX_STAMPS {
            state.stamps.pop_front();
        }
        state.trim(window, query.now);
    }

    /// The background tasks, both off the request path:
    ///
    /// - one sends queued seed jobs to the writer when woken;
    /// - one applies the writer's commit stream (`commits`, the receiver of
    ///   the `WriterConfig::commit_sink` sender) in order.
    ///
    /// Abort the handles to stop them.
    pub fn spawn_consumer(
        self: &Arc<Self>,
        writer: WriterHandle,
        mut commits: mpsc::Receiver<Committed>,
    ) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
        let asker = {
            let this = self.clone();
            tokio::spawn(async move {
                loop {
                    this.wake.notified().await;
                    this.send_seeds(&writer);
                }
            })
        };
        let applier = {
            let this = self.clone();
            tokio::spawn(async move {
                while let Some(event) = commits.recv().await {
                    this.apply(event);
                }
            })
        };
        (asker, applier)
    }
}

impl RateLimiter {
    /// Runs every queued seed against `store` right now, as the writer would
    /// between batches (one read transaction each), and applies the result.
    /// For a store no writer is writing to: tests, conformance pre-seeding.
    /// Blocking. Returns how many reads were made.
    pub fn seed_now(&self, store: &omni_store::SqliteStore) -> usize {
        let jobs = self.take_seed_jobs();
        let n = jobs.len();
        for job in jobs {
            let q = Self::seed_query(&job);
            let result = omni_store::usage::seed_rows(
                store.connection(),
                &q.api_key_id,
                q.since_ms,
                q.grain_ms,
                q.requested_model.as_deref(),
            )
            .map(|(buckets, stamps)| SeedRows { buckets, stamps })
            .map_err(|e| e.to_string());
            self.apply(Committed::Seed { query: q, result });
        }
        n
    }
}
