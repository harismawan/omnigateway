//! The limiter's background seeding: long-window buckets and row stamps
//! read from the store off the request path.

use crate::ratelimit::{MAX_STAMPS, RateLimiter, SeedJob, grain_ms, long_index};
use omni_ratelimit::buckets::Counts;
use omni_store::{SqliteStore, StoreError};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};

/// A completion debited before its window was seeded.
#[derive(Debug, Clone)]
pub(crate) struct PendingDebit {
    pub(crate) request_id: String,
    pub(crate) row_at: f64,
    pub(crate) now: f64,
    pub(crate) delta: Counts,
}

/// Pending debits held per subject and window. Past it the oldest go
/// (warned), which can only under-count by that many requests.
pub(crate) const MAX_PENDING_DEBITS: usize = 65_536;

/// How long after a seed is installed a debit is still checked against
/// the ids the seed read. A debit is sent beside its log row's `Finish`
/// (the row reaches the store up to one writer batch later), so a row the
/// seed read normally has its debit already pending; this covers a caller
/// that debits after the row is written.
pub(crate) const SEEDED_IDS_GRACE_MS: f64 = 10_000.0;

/// What a seed read from the store: bucket sums, and every retained done
/// row's `(at, request id)`.
#[derive(Debug, Clone)]
pub struct SeedRead {
    pub buckets: Vec<(i64, Counts)>,
    pub rows: Vec<(i64, String)>,
}

impl RateLimiter {
    /// Seeds still queued or running.
    pub fn seeds_pending(&self) -> usize {
        self.lock().seeding.len()
    }

    /// Runs every queued seed against `store`. Blocking: the seeder calls
    /// it under `spawn_blocking`; tests and conformance call it directly.
    /// Returns how many reads were made.
    pub fn seed_pending(&self, store: &SqliteStore) -> usize {
        let jobs = self.take_seed_jobs();
        let count = jobs.len();
        for job in jobs {
            let read = self.read_seed(store, &job);
            self.install_seed(&job, read);
        }
        count
    }

    /// Phase 1: the queued seeds, removed from the queue (still marked as
    /// seeding until installed).
    pub fn take_seed_jobs(&self) -> Vec<SeedJob> {
        self.lock().pending.drain(..).collect()
    }

    /// Phase 2: the store read, without the limiter lock. Debits that land
    /// meanwhile are held as pending (the window is not seeded yet).
    #[allow(clippy::cast_possible_truncation)]
    pub fn read_seed(&self, store: &SqliteStore, job: &SeedJob) -> Result<SeedRead, StoreError> {
        let since = (job.now - job.window.ms()) as i64;
        let buckets = omni_store::usage::sum_buckets(
            store.connection(),
            &job.key_id,
            since,
            grain_ms(job.window) as i64,
            job.model.as_deref(),
        )?;
        let rows = omni_store::usage::done_rows(
            store.connection(),
            &job.key_id,
            since,
            job.model.as_deref(),
        )?;
        Ok(SeedRead { buckets, rows })
    }

    /// Phase 3: installs the read and reconciles the pending debits by
    /// request id. A debit whose row the read included is already in the
    /// aggregate and is dropped; every other pending debit is added (its
    /// row was not yet written, or was written after the read). The ids
    /// the read saw are kept briefly, so a debit for one of them that
    /// arrives after the install is not added twice either.
    ///
    /// The bucket aggregate and the id list come from two statements on
    /// one connection with no write between them on that connection; a row
    /// committed between the two is in the ids but not the aggregate. Such
    /// a row's debit is then dropped at reconcile: a single completion can
    /// be under-counted in that microsecond window, never double-counted.
    #[allow(clippy::cast_precision_loss)]
    pub fn install_seed(&self, job: &SeedJob, read: Result<SeedRead, StoreError>) {
        let mut st = self.lock();
        st.seeding
            .remove(&(job.subject.clone(), long_index(job.window)));
        let read = match read {
            Ok(r) => r,
            Err(e) => {
                drop(st);
                match &job.model {
                    Some(model) => tracing::warn!(api_key_id = %job.key_id, model = %model,
                        reason = %e, "rate limit counters unavailable"),
                    None => tracing::warn!(api_key_id = %job.key_id,
                        reason = %e, "rate limit counters unavailable"),
                }
                return;
            }
        };
        let state = &mut st.long_of(&job.subject)[long_index(job.window)];
        if state.buckets.is_seeded() {
            return;
        }
        let rows: Vec<(f64, Counts)> = read
            .buckets
            .into_iter()
            .map(|(start, c)| (start as f64, c))
            .collect();
        state.buckets.seed(job.now, &rows);
        let mut ids: HashSet<String> = HashSet::with_capacity(read.rows.len());
        let mut stamps = VecDeque::with_capacity(read.rows.len());
        for (at, id) in read.rows {
            stamps.push_back(at as f64);
            ids.insert(id);
        }
        state.stamps = stamps;
        while state.stamps.len() > MAX_STAMPS {
            state.stamps.pop_front();
        }
        let mut latest = job.now;
        for debit in std::mem::take(&mut state.pending) {
            latest = latest.max(debit.now);
            if ids.remove(&debit.request_id) {
                continue;
            }
            state.buckets.add(debit.now, debit.delta);
            state.push_stamp(debit.row_at);
        }
        state.trim(job.window, latest);
        state.seeded_ids = ids;
        state.seeded_ids_until = latest + SEEDED_IDS_GRACE_MS;
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
