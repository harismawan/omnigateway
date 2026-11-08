//! The limiter's background seeding: long-window buckets and row stamps
//! read from the store off the request path.

use crate::ratelimit::{MAX_STAMPS, RateLimiter, SeedJob, grain_ms, long_index};
use omni_ratelimit::buckets::Counts;
use omni_store::SqliteStore;
use std::sync::{Arc, Mutex};

impl RateLimiter {
    /// Seeds still queued or running.
    pub fn seeds_pending(&self) -> usize {
        self.lock().seeding.len()
    }

    /// Runs every queued seed against `store`. Blocking: the seeder calls
    /// it under `spawn_blocking`; tests and conformance call it directly.
    /// Returns how many reads were made.
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    pub fn seed_pending(&self, store: &SqliteStore) -> usize {
        let jobs: Vec<SeedJob> = self.lock().pending.drain(..).collect();
        let count = jobs.len();
        for job in jobs {
            let length = job.window.ms();
            let since = (job.now - length) as i64;
            let read = omni_store::usage::sum_buckets(
                store.connection(),
                &job.key_id,
                since,
                grain_ms(job.window) as i64,
                job.model.as_deref(),
            )
            .and_then(|rows| {
                let stamps = omni_store::usage::done_stamps(
                    store.connection(),
                    &job.key_id,
                    since,
                    job.model.as_deref(),
                )?;
                Ok((rows, stamps))
            });
            let mut st = self.lock();
            st.seeding
                .remove(&(job.subject.clone(), long_index(job.window)));
            match read {
                Ok((rows, stamps)) => {
                    let state = &mut st.long_of(&job.subject)[long_index(job.window)];
                    if state.buckets.is_seeded() {
                        continue;
                    }
                    let rows: Vec<(f64, Counts)> = rows
                        .into_iter()
                        .map(|(start, c)| (start as f64, c))
                        .collect();
                    state.buckets.seed(job.now, &rows);
                    state.stamps = stamps.into_iter().map(|s| s as f64).collect();
                    while state.stamps.len() > MAX_STAMPS {
                        state.stamps.pop_front();
                    }
                }
                Err(e) => {
                    drop(st);
                    match &job.model {
                        Some(model) => tracing::warn!(api_key_id = %job.key_id, model = %model,
                            reason = %e, "rate limit counters unavailable"),
                        None => tracing::warn!(api_key_id = %job.key_id,
                            reason = %e, "rate limit counters unavailable"),
                    }
                }
            }
        }
        count
    }

    /// The background seeder: owns its own store connection and runs queued
    /// seeds off the request path. Abort the handle to stop it.
    pub fn spawn_seeder(self: &Arc<Self>, store: SqliteStore) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            let store = Arc::new(Mutex::new(store));
            loop {
                this.wake.notified().await;
                let limiter = this.clone();
                let store = store.clone();
                let ran = tokio::task::spawn_blocking(move || {
                    let store = store
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    // Drain until empty: seeds queued during a read are run too.
                    while limiter.seed_pending(&store) > 0 {}
                })
                .await;
                if let Err(e) = ran {
                    tracing::error!(error = %e, "rate limit seeder failed");
                }
            }
        })
    }
}
