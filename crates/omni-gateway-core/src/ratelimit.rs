//! The API-key rate limiter, single mode: `ApiKeyRateLimiter` from
//! `apps/gateway/src/auth/rateLimit.ts` over `memoryCoord`, with the
//! arithmetic in `omni-ratelimit`.
//!
//! Everything a request asks is answered from memory under one short lock,
//! with no I/O:
//!
//! - `requests` at `1m` from an exact ring per subject;
//! - `concurrency` from a gauge raised at admission and lowered when the
//!   [`Admission`] is released or dropped (immediately; never batched);
//! - the long windows (`5h`, `1w`) from time buckets seeded from the store
//!   and debited by every completed request.
//!
//! Differences from TS, both deliberate:
//!
//! - **Seeding does not block** (spec ruling). A subject whose long window
//!   is unseeded is admitted against the limits it can check, and a seed is
//!   queued for the background seeder ([`RateLimiter::spawn_seeder`]). Until
//!   it lands, a key can overshoot that window by the requests admitted
//!   meanwhile. [`RateLimiter::preseed`] seeds every limited key at boot.
//! - **A refusal's exact reset is read from memory.** TS asks the store for
//!   the oldest retained row (`oldestSince`) on the refusal path. Here the
//!   seed also loads every retained row's `at`, debits append to it, and the
//!   refusal reads its head. Same answer, no store read before the 429 is
//!   written.
//!
//! The gauge has no TTL: a slot is freed by `Drop`, so the leak TS's TTL and
//! renewal exist to heal cannot happen.

use omni_ir::error::{ErrorCode, GatewayError};
use omni_ratelimit::buckets::{Buckets, Counts};
use omni_ratelimit::limits::{CountWindows, LimitConfig, LimitScope};
use omni_ratelimit::window::SlidingWindow;
use omni_ratelimit::{
    CounterSnapshot, Decision, HeadroomByDimension, Violation, Window, WindowCounter, combine_all,
    evaluate, last_to_clear, refused_headroom, retry_after_ms, with_reset,
};
use omni_store::SqliteStore;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

/// The long windows, in `LONG_WINDOWS` order.
const LONG: [Window; 2] = [Window::H5, Window::W1];

/// `GRAIN_MS`: a minute of five hours, an hour of a week.
fn grain_ms(window: Window) -> f64 {
    if window == Window::W1 {
        3_600_000.0
    } else {
        60_000.0
    }
}

fn long_index(window: Window) -> usize {
    usize::from(window == Window::W1)
}

/// How often drained rings are swept (`SWEEP_INTERVAL_MS`).
const SWEEP_INTERVAL_MS: f64 = 1_000.0;

/// Seeds waiting for the seeder. Beyond this a subject is simply asked
/// again at its next request.
const MAX_PENDING_SEEDS: usize = 4_096;

/// Retained row stamps per subject and window. Past it the oldest are
/// dropped, which can only make a refusal's reset later (the safe side).
const MAX_STAMPS: usize = 1 << 20;

/// `modelSubjectId`: `encodeURIComponent` keeps `/` and `:` out of the
/// model part, so no model name can spell another subject's key.
pub fn model_subject_id(key_id: &str, model: &str) -> String {
    let mut out = String::with_capacity(key_id.len() + 3 + model.len());
    out.push_str(key_id);
    out.push_str("/m/");
    for b in model.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(Debug, Clone)]
struct Subject {
    id: String,
    key_id: String,
    /// `None` for the key-wide subject, whose rows span every model.
    model: Option<String>,
    limits: LimitScope,
}

fn configured_count(w: Option<&CountWindows>, f: fn(&CountWindows) -> Option<Option<u64>>) -> bool {
    w.and_then(f).flatten().is_some()
}

fn any_request_limit(l: &LimitScope) -> bool {
    let r = l.requests.as_ref();
    configured_count(r, |w| w.one_minute)
        || configured_count(r, |w| w.five_hours)
        || configured_count(r, |w| w.one_week)
}

fn any_long_limit(l: &LimitScope) -> bool {
    let long = |w: Option<&CountWindows>| {
        configured_count(w, |w| w.five_hours) || configured_count(w, |w| w.one_week)
    };
    long(l.requests.as_ref())
        || long(l.tokens.as_ref())
        || l.spend
            .as_ref()
            .is_some_and(|s| s.five_hours.flatten().is_some() || s.one_week.flatten().is_some())
}

/// `subjectsOf`: key-wide first (when it limits anything), then the model's
/// override.
fn subjects_of(key_id: &str, limits: &LimitConfig, model: &str) -> Vec<Subject> {
    let mut out = Vec::new();
    if limits.base.sets_any_limit() {
        out.push(Subject {
            id: key_id.to_owned(),
            key_id: key_id.to_owned(),
            model: None,
            limits: limits.base.clone(),
        });
    }
    if let Some(o) = limits.model_override(model) {
        out.push(Subject {
            id: model_subject_id(key_id, model),
            key_id: key_id.to_owned(),
            model: Some(model.to_owned()),
            limits: o.clone(),
        });
    }
    out
}

/// `requestsOnly`: what `count_tokens` is judged against.
fn requests_only(l: &LimitScope) -> LimitScope {
    LimitScope {
        requests: l.requests.clone(),
        ..LimitScope::default()
    }
}

#[derive(Debug, Clone)]
struct LongState {
    buckets: Buckets,
    /// Every retained completed row's `at`, ascending. Valid once seeded.
    stamps: VecDeque<f64>,
}

impl LongState {
    fn new(window: Window) -> Self {
        Self {
            buckets: Buckets::new(grain_ms(window), window.ms()),
            stamps: VecDeque::new(),
        }
    }

    fn trim(&mut self, window: Window, now: f64) {
        let since = now - window.ms();
        while self.stamps.front().is_some_and(|s| *s < since) {
            self.stamps.pop_front();
        }
    }

    fn push_stamp(&mut self, at: f64) {
        // Rows complete roughly in order; insert keeps it sorted when not.
        let pos = self.stamps.partition_point(|s| *s <= at);
        self.stamps.insert(pos, at);
        while self.stamps.len() > MAX_STAMPS {
            self.stamps.pop_front();
        }
    }
}

/// One queued seed: a subject's long window to read from the store.
#[derive(Debug, Clone, PartialEq)]
pub struct SeedJob {
    pub subject: String,
    pub key_id: String,
    pub model: Option<String>,
    pub window: Window,
    /// The instant the window is read back from.
    pub now: f64,
}

#[derive(Default)]
struct State {
    /// The limits last seen per subject, so a debit knows whether a long
    /// window is configured. Bounded by configured keys and overrides.
    limits: HashMap<String, LimitScope>,
    rings: HashMap<String, SlidingWindow>,
    gauges: HashMap<String, u64>,
    long: HashMap<String, [LongState; 2]>,
    pending: VecDeque<SeedJob>,
    seeding: HashSet<(String, usize)>,
    last_sweep: f64,
}

impl State {
    fn sweep(&mut self, now: f64) {
        let since = now - self.last_sweep;
        if (0.0..SWEEP_INTERVAL_MS).contains(&since) {
            return;
        }
        self.last_sweep = now;
        self.rings.retain(|_, ring| {
            ring.count(now);
            !ring.is_empty()
        });
    }

    fn long_of(&mut self, subject: &str) -> &mut [LongState; 2] {
        self.long
            .entry(subject.to_owned())
            .or_insert_with(|| [LongState::new(Window::H5), LongState::new(Window::W1)])
    }

    /// Queues a seed unless one is already queued or running.
    fn want_seed(&mut self, s: &Subject, window: Window, now: f64) -> bool {
        let slot = (s.id.clone(), long_index(window));
        if self.seeding.contains(&slot) || self.pending.len() >= MAX_PENDING_SEEDS {
            return false;
        }
        self.seeding.insert(slot);
        self.pending.push_back(SeedJob {
            subject: s.id.clone(),
            key_id: s.key_id.clone(),
            model: s.model.clone(),
            window,
            now,
        });
        true
    }

    /// `counters`: the ring and gauge as they stand before this request,
    /// and each seeded long window's sums. An unseeded window is left out
    /// (read as nothing used) and a seed is queued.
    fn counters(
        &mut self,
        s: &Subject,
        limits: &LimitScope,
        now: f64,
        queued: &mut bool,
    ) -> CounterSnapshot {
        let ring = self
            .rings
            .entry(s.id.clone())
            .or_insert_with(|| SlidingWindow::new(Window::M1.ms()));
        #[allow(clippy::cast_precision_loss)]
        let before = WindowCounter {
            used: ring.count(now) as f64,
            reset_at: ring.reset_at(now),
        };
        let mut snapshot = CounterSnapshot::default();
        snapshot.requests.set(Window::M1, before);
        #[allow(clippy::cast_precision_loss)]
        {
            snapshot.concurrency = self.gauges.get(&s.id).copied().unwrap_or(0) as f64;
        }
        if !any_long_limit(limits) {
            return snapshot;
        }
        for window in LONG {
            let state = &mut self.long_of(&s.id)[long_index(window)];
            match state.buckets.sum(now) {
                Some(sums) => {
                    // The far end of the window; corrected on a refusal.
                    let reset_at = now + window.ms();
                    snapshot.requests.set(
                        window,
                        WindowCounter {
                            used: sums.requests,
                            reset_at,
                        },
                    );
                    snapshot.tokens.set(
                        window,
                        WindowCounter {
                            used: sums.tokens,
                            reset_at,
                        },
                    );
                    snapshot.spend.set(
                        window,
                        WindowCounter {
                            used: sums.cost_usd,
                            reset_at,
                        },
                    );
                }
                None => *queued |= self.want_seed(s, window, now),
            }
        }
        snapshot
    }

    /// `exactReset`: when a long window truly frees a slot, from the
    /// retained row stamps. `None` keeps the overstated figure.
    fn exact_reset(&mut self, subject: &str, window: Window, now: f64) -> Option<f64> {
        if window == Window::M1 {
            return None;
        }
        let state = &mut self.long.get_mut(subject)?[long_index(window)];
        if !state.buckets.is_seeded() {
            return None;
        }
        state.trim(window, now);
        state.stamps.front().map(|oldest| oldest + window.ms())
    }

    /// `correct`: one subject's decision with each violated long window's
    /// true reset, headroom moved with it.
    fn correct(&mut self, subject: &Subject, scope: &Decision, now: f64) -> Decision {
        if scope.violations.is_empty() {
            return scope.clone();
        }
        let mut exact: Vec<(Window, f64)> = Vec::new();
        for v in &scope.violations {
            let Some(window) = v.window else { continue };
            if exact.iter().any(|(w, _)| *w == window) {
                continue;
            }
            if let Some(reset) = self.exact_reset(&subject.id, window, now) {
                exact.push((window, reset));
            }
        }
        let violations: Vec<Violation> = scope
            .violations
            .iter()
            .map(|v| {
                let reset = v
                    .window
                    .and_then(|w| exact.iter().find(|(e, _)| *e == w).map(|(_, r)| *r));
                reset.map_or(*v, |reset_at| Violation { reset_at, ..*v })
            })
            .collect();
        let mut headroom = scope.headroom;
        for (window, reset) in &exact {
            headroom = with_reset(&headroom, *window, *reset);
        }
        Decision {
            allowed: scope.allowed,
            violation: last_to_clear(&violations),
            violations,
            headroom,
        }
    }

    /// Judges every subject; on a refusal, corrects and builds the error.
    fn judge(
        &mut self,
        subjects: &[Subject],
        scope: fn(&LimitScope) -> LimitScope,
        now: f64,
        queued: &mut bool,
    ) -> Result<Decision, RateLimitExceeded> {
        let mut decisions = Vec::with_capacity(subjects.len());
        for s in subjects {
            let limits = scope(&s.limits);
            let counters = self.counters(s, &limits, now, queued);
            decisions.push(evaluate(&limits, &counters, now));
        }
        let decision = combine_all(&decisions);
        if decision.violation.is_none() {
            return Ok(decision);
        }
        let corrected: Vec<Decision> = subjects
            .iter()
            .zip(&decisions)
            .map(|(s, d)| self.correct(s, d, now))
            .collect();
        let decision = combine_all(&corrected);
        let Some(violation) = decision.violation else {
            // Correcting a reset never removes a violation.
            return Ok(decision);
        };
        Err(RateLimitExceeded {
            retry_after_ms: retry_after_ms(Some(&violation), now),
            headroom: Box::new(refused_headroom(&decision, &violation)),
            violation: Box::new(violation),
        })
    }
}

/// `RateLimitExceeded`: the refusal, with the headroom its headers render.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimitExceeded {
    pub retry_after_ms: f64,
    /// Boxed: a refusal is the rare path, and keeps `Result` small.
    pub headroom: Box<HeadroomByDimension>,
    /// The one reported; `dimension`/`window` are the metric labels.
    pub violation: Box<Violation>,
}

impl RateLimitExceeded {
    /// The `GatewayError` TS throws: `RATE_LIMIT`, its fixed message, and
    /// the wait.
    pub fn to_gateway_error(&self) -> GatewayError {
        GatewayError::new(ErrorCode::RateLimit, "API key rate limit exceeded")
            .with_retry_after_ms(Some(self.retry_after_ms))
    }
}

impl std::fmt::Display for RateLimitExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("API key rate limit exceeded")
    }
}

impl std::error::Error for RateLimitExceeded {}

/// An admitted request's place in the counters. Its concurrency slots are
/// freed by [`Admission::release`] or on drop, whichever comes first.
#[derive(Debug)]
#[must_use = "dropping the admission frees its concurrency slots"]
pub struct Admission {
    /// `Decision.headroom`: what each window held before this request. The
    /// response headers render `after_this_request` of it.
    pub headroom: HeadroomByDimension,
    slots: Option<(Arc<RateLimiter>, Vec<String>)>,
}

impl Admission {
    fn unlimited() -> Self {
        Self {
            headroom: HeadroomByDimension::default(),
            slots: None,
        }
    }

    /// Frees the gauge slots. Idempotent.
    pub fn release(&mut self) {
        if let Some((limiter, subjects)) = self.slots.take() {
            let mut st = limiter.lock();
            for s in subjects {
                if let Some(n) = st.gauges.get_mut(&s) {
                    *n = n.saturating_sub(1);
                    if *n == 0 {
                        st.gauges.remove(&s);
                    }
                }
            }
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.release();
    }
}

/// The limiter. Share it as `Arc<RateLimiter>`.
#[derive(Default)]
pub struct RateLimiter {
    state: Mutex<State>,
    wake: tokio::sync::Notify,
}

impl std::fmt::Debug for RateLimiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RateLimiter").finish_non_exhaustive()
    }
}

impl RateLimiter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic under the lock leaves counters that are still numbers;
        // keep serving rather than poison every request after it.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn after(&self, queued: bool) {
        if queued {
            self.wake.notify_one();
        }
    }

    /// `admit`: judges a request that will be dispatched and claims its
    /// slots. `model` is the requested model after `[1m]` normalization;
    /// `now` is the request's one clock reading.
    pub fn admit(
        self: &Arc<Self>,
        key_id: &str,
        limits: &LimitConfig,
        model: &str,
        now: f64,
    ) -> Result<Admission, RateLimitExceeded> {
        let subjects = subjects_of(key_id, limits, model);
        if subjects.is_empty() {
            return Ok(Admission::unlimited());
        }
        let mut queued = false;
        let result = {
            let mut st = self.lock();
            st.sweep(now);
            for s in &subjects {
                st.limits.insert(s.id.clone(), s.limits.clone());
            }
            let decision = st.judge(&subjects, LimitScope::clone, now, &mut queued);
            if decision.is_ok() {
                for s in &subjects {
                    if let Some(ring) = st.rings.get_mut(&s.id) {
                        ring.record(now);
                    }
                    *st.gauges.entry(s.id.clone()).or_insert(0) += 1;
                }
            }
            decision
        };
        self.after(queued);
        let decision = result?;
        Ok(Admission {
            headroom: decision.headroom,
            slots: Some((self.clone(), subjects.into_iter().map(|s| s.id).collect())),
        })
    }

    /// `consume`: a `count_tokens` request, charged to `requests` only, and
    /// holding no concurrency slot.
    pub fn consume(
        &self,
        key_id: &str,
        limits: &LimitConfig,
        model: &str,
        now: f64,
    ) -> Result<(), RateLimitExceeded> {
        let subjects: Vec<Subject> = subjects_of(key_id, limits, model)
            .into_iter()
            .filter(|s| any_request_limit(&s.limits))
            .collect();
        if subjects.is_empty() {
            return Ok(());
        }
        let mut queued = false;
        let result = {
            let mut st = self.lock();
            st.sweep(now);
            for s in &subjects {
                st.limits.insert(s.id.clone(), s.limits.clone());
            }
            let decision = st.judge(&subjects, requests_only, now, &mut queued);
            if decision.is_ok() {
                for s in &subjects {
                    if let Some(ring) = st.rings.get_mut(&s.id) {
                        ring.record(now);
                    }
                }
            }
            decision
        };
        self.after(queued);
        result.map(|_| ())
    }

    /// `debit`: one completed request against the long windows, beside the
    /// writer's `Finish`. `row_at` is the log row's `at`; `now` stamps the
    /// bucket. A subject not yet seeded ignores it: the seed reads the row.
    pub fn debit(
        &self,
        key_id: &str,
        requested_model: &str,
        tokens: f64,
        cost_usd: f64,
        row_at: f64,
        now: f64,
    ) {
        let delta = Counts {
            requests: 1.0,
            tokens,
            cost_usd,
        };
        let mut st = self.lock();
        for subject in [key_id.to_owned(), model_subject_id(key_id, requested_model)] {
            let Some(limits) = st.limits.get(&subject) else {
                continue;
            };
            if !any_long_limit(limits) {
                continue;
            }
            for window in LONG {
                let state = &mut st.long_of(&subject)[long_index(window)];
                if state.buckets.is_seeded() {
                    state.buckets.add(now, delta);
                    state.push_stamp(row_at);
                    state.trim(window, now);
                }
            }
        }
    }

    /// `recordOverride`: a model's override limits, for a completion this
    /// process debits without admitting (the guardrail's classifier).
    pub fn record_override(&self, key_id: &str, limits: &LimitConfig, model: &str) {
        if let Some(o) = limits.model_override(model) {
            self.lock()
                .limits
                .insert(model_subject_id(key_id, model), o.clone());
        }
    }

    /// In-flight requests for a subject: a key id, or [`model_subject_id`].
    pub fn in_flight(&self, subject: &str) -> u64 {
        self.lock().gauges.get(subject).copied().unwrap_or(0)
    }

    /// Queues seeds for the subjects a request for `model` would be judged
    /// against, exactly as `admit` would; judges nothing and claims nothing.
    pub fn prepare(&self, key_id: &str, limits: &LimitConfig, model: &str, now: f64) {
        let mut queued = false;
        {
            let mut st = self.lock();
            for s in subjects_of(key_id, limits, model) {
                st.limits.insert(s.id.clone(), s.limits.clone());
                if any_long_limit(&s.limits) {
                    for window in LONG {
                        if !st.long_of(&s.id)[long_index(window)].buckets.is_seeded() {
                            queued |= st.want_seed(&s, window, now);
                        }
                    }
                }
            }
        }
        self.after(queued);
    }

    /// Pre-seeds a key at boot, or when it first enters the snapshot: the
    /// key-wide subject and every model override with a long window.
    pub fn preseed(&self, key_id: &str, limits: &LimitConfig, now: f64) {
        self.prepare(key_id, limits, "", now);
        for model in limits.models.iter().flat_map(|m| m.keys()) {
            self.prepare(key_id, limits, model, now);
        }
    }

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
