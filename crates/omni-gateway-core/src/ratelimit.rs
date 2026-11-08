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
//!   and debited by every completed request once its row is committed.
//!
//! **Ordering, not bookkeeping** (TS `rateLimit.ts`: "row first, then the
//! debit"). The request-log writer is the only writer of `request_logs`.
//! After each batch commits it delivers that batch's completions, and it
//! runs every seed read on its own connection between batches, sending the
//! result on the same ordered channel ([`RateLimiter::spawn_consumer`]). So a
//! row committed before a seed's read is in its aggregate, and that row's
//! debit was delivered (and ignored, the window being unseeded) before the
//! seed; a row committed after it is debited after the seed is installed.
//! The accepted cost: a long-window debit lags its completion by up to one
//! writer batch (~200 ms), as TS's debit follows its row's write.
//!
//! Differences from TS, both deliberate:
//!
//! - **Seeding does not block** (spec ruling). A subject whose long window
//!   is unseeded is admitted against the limits it can check, and a seed is
//!   asked of the request-log writer ([`RateLimiter::spawn_consumer`]). Until
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

use crate::buckets::Buckets;
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ratelimit::buckets::Counts;
use omni_ratelimit::limits::{CountWindows, LimitConfig, LimitScope};
use omni_ratelimit::window::SlidingWindow;
use omni_ratelimit::{CounterSnapshot, HeadroomByDimension, Violation, Window, WindowCounter};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

/// The long windows, in `LONG_WINDOWS` order.
const LONG: [Window; 2] = [Window::H5, Window::W1];

/// `GRAIN_MS`: a minute of five hours, an hour of a week.
pub(crate) fn grain_ms(window: Window) -> f64 {
    if window == Window::W1 {
        3_600_000.0
    } else {
        60_000.0
    }
}

pub(crate) fn long_index(window: Window) -> usize {
    usize::from(window == Window::W1)
}

/// How often drained rings are swept (`SWEEP_INTERVAL_MS`).
const SWEEP_INTERVAL_MS: f64 = 1_000.0;

/// How long a seed may be outstanding before it counts as failed and is
/// asked again. Generous next to a normal round trip (one writer batch plus a
/// read): a seed result dropped by a full sink is retried after it.
pub const SEED_TIMEOUT_MS: f64 = 5_000.0;

/// Seeds waiting for the seeder. Beyond this a subject is simply asked
/// again at its next request.
const MAX_PENDING_SEEDS: usize = 4_096;

/// Retained row stamps per subject and window. Past it the oldest are
/// dropped, which can only make a refusal's reset later (the safe side).
pub(crate) const MAX_STAMPS: usize = 1 << 20;

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
pub(crate) struct Subject {
    pub(crate) id: String,
    pub(crate) key_id: String,
    /// `None` for the key-wide subject, whose rows span every model.
    pub(crate) model: Option<String>,
    pub(crate) limits: LimitScope,
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
pub(crate) struct LongState {
    pub(crate) buckets: Buckets,
    /// Every retained completed row's `at`, ascending. Valid once seeded.
    pub(crate) stamps: VecDeque<f64>,
}

impl LongState {
    pub(crate) fn new(window: Window) -> Self {
        Self {
            buckets: Buckets::new(grain_ms(window), window.ms()),
            stamps: VecDeque::new(),
        }
    }

    pub(crate) fn trim(&mut self, window: Window, now: f64) {
        let since = now - window.ms();
        while self.stamps.front().is_some_and(|s| *s < since) {
            self.stamps.pop_front();
        }
    }

    pub(crate) fn push_stamp(&mut self, at: f64) {
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
pub(crate) struct State {
    /// The limits last seen per subject, so a debit knows whether a long
    /// window is configured. Bounded by configured keys and overrides.
    limits: HashMap<String, LimitScope>,
    rings: HashMap<String, SlidingWindow>,
    gauges: HashMap<String, u64>,
    pub(crate) long: HashMap<String, [LongState; 2]>,
    pub(crate) pending: VecDeque<SeedJob>,
    /// Seeds asked for and not yet installed, with when they were asked.
    /// One older than [`SEED_TIMEOUT_MS`] is treated as failed (its result
    /// was dropped by a full sink, or the writer never ran it) and may be
    /// asked again.
    pub(crate) seeding: HashMap<(String, usize), f64>,
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

    pub(crate) fn long_of(&mut self, subject: &str) -> &mut [LongState; 2] {
        self.long
            .entry(subject.to_owned())
            .or_insert_with(|| [LongState::new(Window::H5), LongState::new(Window::W1)])
    }

    /// Queues a seed unless one is already queued or in flight and not yet
    /// timed out.
    fn want_seed(&mut self, s: &Subject, window: Window, now: f64) -> bool {
        let slot = (s.id.clone(), long_index(window));
        if self.pending.len() >= MAX_PENDING_SEEDS {
            return false;
        }
        if let Some(asked) = self.seeding.get(&slot)
            && now - *asked < SEED_TIMEOUT_MS
        {
            return false;
        }
        self.seeding.insert(slot, now);
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
    pub(crate) fn counters(
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
            // Stamps age out with the window they describe, read or not.
            state.trim(window, now);
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
    pub(crate) wake: tokio::sync::Notify,
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

    pub(crate) fn lock(&self) -> MutexGuard<'_, State> {
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

    /// `debit`: one completed request against the long windows. Call it
    /// only once the row is committed, in commit order: the writer delivers
    /// committed completions to [`Self::apply`], which calls this. `row_at`
    /// is the row's `at`; `now` stamps the bucket.
    ///
    /// A window not yet seeded ignores it, exactly as TS's buckets do: the
    /// seed that follows reads the row instead ("row first, then the
    /// debit"). Because seeds are read on the writer's connection and
    /// delivered on the same ordered path, a row is counted either by the
    /// seed or by its debit, never both and never neither.
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
}
