//! Cluster rate limiting on Redis/Valkey — the spec's "Cluster design"
//! rate limiting and load publication, as a library over D2's
//! [`omni_coord::RedisCoord`].
//!
//! - **One round trip, only when needed.** A key with no limits makes no
//!   Redis call. A key with limits makes exactly one `EVALSHA` of
//!   [`scripts::ADMIT`]: per subject (key-wide, then the model's override)
//!   the `1m` window claim, the gauge acquire (only with a `concurrency`
//!   ceiling), and the 5h/1w bucket sums; on a refusal it rolls every claim
//!   back in the same step. The decision, headroom and `Retry-After` are
//!   computed here with `omni-ratelimit` from the figures the script
//!   returns, exactly as TS `ApiKeyRateLimiter` computes them from its
//!   per-step calls. A refusal on a long window takes its reset (TS
//!   `oldestSince` + window) from the row ranges the same script reads out
//!   of the bucket hash — no store read on the request path, refusals
//!   included (see [`scripts::ADMIT_SRC`] for exactness).
//! - **Concurrency release is immediate**, never batched:
//!   [`Admission::release`] (or drop) queues one detached `GAUGE_RELEASE`
//!   on D2's ordered queue, so a `concurrency: 1` key's next request on this
//!   process is judged after it. Slots are named and renewed (TS's 300 s TTL,
//!   100 s renewal, one-day cap).
//! - **Debits are batched** ([`ClusterLimiter::debit`]): queued per bucket
//!   with every cost in order and the row's commit id, applied as one
//!   [`scripts::DEBIT_BATCH`] call per batch with TS's per-debit float
//!   arithmetic. A row a seed already counted (on any replica) is skipped
//!   by its commit; see [`debit`](crate) docs. Storage is bounded; a debit
//!   lost to a bound or a fault is counted and arms the coordinator's
//!   lost-debit flag (TS's policy: every bucket hash is dropped on recovery
//!   and reseeded from the store).
//! - **Unseeded long windows admit** (the spec's one deliberate difference
//!   from TS): the request is judged against what could be checked, and a
//!   background seeder takes `omni:lock:seed:<bucket>`, reads
//!   [`UsageSource::seed_read`] (counts, row ranges and the read's commit
//!   snapshot, under a deadline) and installs all of it in one
//!   [`scripts::SEED_INSTALL`] call. Boot and new-key pre-seeding:
//!   [`ClusterLimiter::preseed`] / [`ClusterLimiter::preseed_now`].
//! - **Redis outage fails open** to a per-process limiter (D2's
//!   `MemoryCoord`, TS's `memoryCoord` semantics) with a rate-limited `warn`
//!   and [`Metrics::local_admissions`]; long windows are not enforced there.
//! - **Load publication** ([`load`]): this replica's in-flight counts per
//!   (credential, model), written every 100 ms in one script call with a
//!   TTL, and a 100 ms snapshot of every other live replica's.

pub mod judge;
pub mod load;
pub mod scripts;
pub mod subject;

mod debit;
mod local;
mod seed;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use omni_coord::redis::{Fault, Remote, gauge_index, key};
use omni_coord::{BucketRow, Clock, Counts, MemoryCoord, RedisCoord, WindowCounter};
use omni_ratelimit::limits::{LimitConfig, LimitScope};
use omni_ratelimit::{Decision, Dimension, HeadroomByDimension, Window, combine_all};
use redis::Value;

use judge::Observed;
pub use judge::RateLimitExceeded;
use subject::{LONG, Subject, any_long_limit, any_request_limit, bucket_key, requests_only};

/// TS `GAUGE_TTL_MS`.
pub const GAUGE_TTL_MS: u64 = 300_000;
/// TS `RENEW_INTERVAL_MS`.
pub const RENEW_INTERVAL: Duration = Duration::from_millis(100_000);
/// TS `MAX_RENEWED_MS`.
pub const MAX_RENEWED_MS: f64 = 86_400_000.0;
/// TS `SEED_LOCK_MS`: how long one seed may hold the lock, and how long a
/// second asker waits for it.
pub const SEED_LOCK_MS: u64 = 5_000;

/// Where the store's usage is read from: D1's `PgStore` plugs in here.
/// Called only by the background seeder — never on the request path,
/// admitted or refused — and always under `usage_timeout`.
#[async_trait]
pub trait UsageSource: Send + Sync {
    /// One consistent read of everything a seed installs (ruling I1/I2):
    ///
    /// - `rows`: TS `store.usage.sumBuckets(apiKeyId, sinceMs, grainMs,
    ///   model)`;
    /// - `ranges`: per grain bucket of each done row's own `at`, the least
    ///   and greatest `at` of the done rows at or after `since_ms`
    ///   (narrowed to `model` when given);
    /// - `snapshot`: which commits the read saw, as Postgres
    ///   `pg_current_snapshot()::text` (`xmin:xmax:xip,…`).
    ///
    /// All three must come from one store snapshot — on Postgres one
    /// `REPEATABLE READ` transaction: `SELECT pg_current_snapshot()::text`,
    /// then the `sumBuckets` query, then `SELECT (at / $g) * $g, MIN(at),
    /// MAX(at) FROM request_logs WHERE api_key_id = $1 [AND requested_model
    /// = $m] AND state = 'done' AND at >= $since GROUP BY 1`. Debits must
    /// then carry the commit id of the transaction that completed their row
    /// (`pg_current_xact_id()` in the writer's batch transaction).
    async fn seed_read(
        &self,
        key_id: &str,
        since_ms: f64,
        grain_ms: f64,
        model: Option<&str>,
    ) -> Result<SeedRead, String>;
}

/// What one seed read returns (see [`UsageSource::seed_read`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SeedRead {
    pub rows: Vec<BucketRow>,
    pub ranges: Vec<RowRange>,
    pub snapshot: String,
}

/// `(bucket start, least at, greatest at)` of the done rows in one bucket.
pub type RowRange = (f64, f64, f64);

/// TS `onRejected`: called once per refusal with its dimension and window.
pub type OnRejected = Arc<dyn Fn(Dimension, Option<Window>) + Send + Sync>;

/// Options; defaults are TS's constants and the spec's intervals.
#[derive(Clone)]
pub struct ClusterLimiterOptions {
    /// What gauge expiry is computed against (TS: the coordinator's `now`).
    pub clock: Clock,
    pub gauge_ttl_ms: u64,
    pub renew_interval: Duration,
    pub max_renewed_ms: f64,
    pub seed_lock_ms: u64,
    /// Distinct seeds waiting; beyond it a subject is asked again at its
    /// next request.
    pub seed_queue: usize,
    /// How long a failed (or still running) seed suppresses asking again.
    pub seed_retry: Duration,
    /// Pending debit entries (per bucket and start); past it a debit is
    /// lost: counted, logged, and the lost-debit reseed armed.
    pub debit_queue: usize,
    /// Pending debit storage, estimated bytes (names, commits, every cost
    /// and range); past it a debit is lost likewise.
    pub debit_bytes: usize,
    /// How long a debit may wait on another seed's install before it is
    /// lost (the seed lock's TTL bounds a live seed).
    pub debit_wait_max: Duration,
    /// Deadline on every [`UsageSource`] call.
    pub usage_timeout: Duration,
    /// How long [`ClusterLimiter::shutdown`] keeps flushing debits that wait
    /// on a seed before counting them lost.
    pub shutdown_drain: Duration,
    /// How often pending debits are flushed (the writer batch's 200 ms).
    pub debit_interval: Duration,
    /// Buckets per [`scripts::DEBIT_BATCH`] call (bounds one request).
    pub debit_batch_keys: usize,
    /// At most one fallback `warn` per interval.
    pub fault_log_interval: Duration,
    pub on_rejected: Option<OnRejected>,
}

impl Default for ClusterLimiterOptions {
    fn default() -> Self {
        Self {
            clock: omni_coord::system_clock(),
            gauge_ttl_ms: GAUGE_TTL_MS,
            renew_interval: RENEW_INTERVAL,
            max_renewed_ms: MAX_RENEWED_MS,
            seed_lock_ms: SEED_LOCK_MS,
            seed_queue: 4_096,
            seed_retry: Duration::from_millis(5_000),
            debit_queue: 65_536,
            debit_bytes: 32 * 1024 * 1024,
            debit_wait_max: Duration::from_millis(SEED_LOCK_MS * 2),
            usage_timeout: Duration::from_millis(SEED_LOCK_MS * 4 / 5),
            shutdown_drain: Duration::from_millis(1_000),
            debit_interval: Duration::from_millis(200),
            debit_batch_keys: 1_024,
            fault_log_interval: Duration::from_millis(30_000),
            on_rejected: None,
        }
    }
}

impl std::fmt::Debug for ClusterLimiterOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClusterLimiterOptions")
            .field("gauge_ttl_ms", &self.gauge_ttl_ms)
            .field("debit_interval", &self.debit_interval)
            .finish_non_exhaustive()
    }
}

/// Counters for `/metrics`. Monotonic since construction.
#[derive(Debug, Default)]
pub struct Metrics {
    /// Admissions and consumes answered by the combined script.
    pub redis_calls: AtomicU64,
    /// Answered by the per-process fallback because the server faulted.
    pub local_admissions: AtomicU64,
    pub refusals: AtomicU64,
    /// Subjects admitted with a long window unseeded.
    pub unseeded_admits: AtomicU64,
    pub seeds_queued: AtomicU64,
    pub seeds_installed: AtomicU64,
    /// The seed found the window already seeded (another replica won).
    pub seeds_already: AtomicU64,
    pub seed_failures: AtomicU64,
    /// The seed lock could not be taken; seeded anyway (TS).
    pub seed_lock_unavailable: AtomicU64,
    pub debits_queued: AtomicU64,
    /// Bucket entries that met a complete picture.
    pub debit_buckets_applied: AtomicU64,
    /// Debited rows added to a complete picture.
    pub debit_rows_applied: AtomicU64,
    /// Debited rows skipped because the picture's seed counted them.
    pub debit_rows_covered: AtomicU64,
    /// Bucket entries ignored by an incomplete picture (the seed reads the row).
    pub debit_buckets_unseeded: AtomicU64,
    /// Rows in those entries. Unlike bucket counts, this reconciles with queued rows.
    pub debit_rows_unseeded: AtomicU64,
    /// Bucket entries kept for another flush: a seed is installing.
    pub debit_buckets_waiting: AtomicU64,
    /// Bucket entries lost to a fault or a full queue (reseed armed).
    pub debit_buckets_lost: AtomicU64,
    pub debit_batches: AtomicU64,
    /// Concurrency releases the coordinator refused (held until TTL).
    pub releases_refused: AtomicU64,
    /// Script verdict and computed decision disagreed (must stay 0).
    pub verdict_mismatches: AtomicU64,
}

fn bump(c: &AtomicU64) {
    c.fetch_add(1, Ordering::Relaxed);
}

pub(crate) struct Inner {
    /// Held so the coordinator (whose drop closes its connections) lives as
    /// long as the limiter; everything goes through `remote`.
    _coord: Arc<RedisCoord>,
    pub(crate) remote: Remote,
    pub(crate) local: MemoryCoord,
    pub(crate) usage: Arc<dyn UsageSource>,
    pub(crate) opts: ClusterLimiterOptions,
    pub(crate) metrics: Metrics,
    /// TS `this.limits`: the limits last seen per subject, so a debit knows
    /// whether a long window is configured. Bounded by configured keys.
    limits: Mutex<HashMap<String, LimitScope>>,
    pub(crate) seeds: seed::Seeds,
    pub(crate) debits: debit::Debits,
    last_fallback_log: Mutex<Option<Instant>>,
    /// The seed worker and debit flusher, joined at shutdown.
    background: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Wakes the debit flusher to stop (cooperatively, between flushes).
    pub(crate) debits_stop: Arc<tokio::sync::Notify>,
}

impl std::fmt::Debug for Inner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Inner").finish_non_exhaustive()
    }
}

impl Inner {
    pub(crate) fn now(&self) -> f64 {
        (self.opts.clock)()
    }

    /// How often a contended seed lock is retried (TS `LOCK_POLL_MS`).
    pub(crate) fn coord_lock_poll(&self) -> Duration {
        Duration::from_millis(50)
    }

    fn fallback(&self, fault: &Fault) {
        bump(&self.metrics.local_admissions);
        let mut last = self
            .last_fallback_log
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let at = Instant::now();
        if last.is_some_and(|l| at.duration_since(l) < self.opts.fault_log_interval) {
            return;
        }
        *last = Some(at);
        tracing::warn!(
            coord = "redis",
            rate_limit_local = true,
            reason = fault.reason(),
            "rate limiter serving from local memory; coordinator unavailable"
        );
    }
}

/// The cluster limiter. Cheap to clone; one per process. Construct inside a
/// Tokio runtime: it spawns the seeder and the debit flusher.
#[derive(Clone)]
pub struct ClusterLimiter {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for ClusterLimiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClusterLimiter").finish_non_exhaustive()
    }
}

/// A slot this admission holds: its subject and holder name.
#[derive(Debug, Clone)]
struct Slot {
    subject: String,
    holder: String,
}

/// An admitted request. Its concurrency slots are released by
/// [`Admission::release`] or on drop — immediately, one detached
/// `GAUGE_RELEASE` per slot — and renewed meanwhile.
#[derive(Debug)]
#[must_use = "dropping the admission releases its concurrency slots"]
pub struct Admission {
    /// `Decision.headroom`: what the response headers render.
    pub headroom: HeadroomByDimension,
    /// Long windows that were unseeded and not judged (a seed is queued).
    pub unseeded: Vec<(String, Window)>,
    /// Answered by the per-process fallback (Redis unavailable).
    pub local: bool,
    held: Option<Held>,
}

#[derive(Debug)]
struct Held {
    inner: Arc<Inner>,
    slots: Vec<Slot>,
    local: bool,
    renewal: Option<tokio::task::JoinHandle<()>>,
}

impl Admission {
    fn unlimited() -> Self {
        Self {
            headroom: HeadroomByDimension::default(),
            unseeded: Vec::new(),
            local: false,
            held: None,
        }
    }

    /// Frees the concurrency slots now. Idempotent.
    pub fn release(&mut self) {
        let Some(held) = self.held.take() else { return };
        if let Some(task) = &held.renewal {
            task.abort();
        }
        let inner = &held.inner;
        for slot in &held.slots {
            if held.local {
                local::release(inner, &slot.subject, &slot.holder);
            } else if inner
                .remote
                .gauge_release_detached(&slot.subject, inner.now(), Some(&slot.holder))
                .is_err()
            {
                bump(&inner.metrics.releases_refused);
            }
        }
    }

    /// TS `renew`: moves every held slot's expiry out by the gauge TTL.
    pub async fn renew(&self) {
        if let Some(held) = &self.held {
            renew(&held.inner, &held.slots, held.local).await;
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.release();
    }
}

async fn renew(inner: &Inner, slots: &[Slot], local: bool) {
    for slot in slots {
        if local {
            local::renew(inner, &slot.subject, &slot.holder).await;
        } else {
            // A fault leaves the slot to its TTL, as TS's renewal does.
            let _renewed = inner
                .remote
                .gauge_renew(
                    &slot.subject,
                    inner.now(),
                    &slot.holder,
                    inner.opts.gauge_ttl_ms,
                )
                .await
                .is_ok();
        }
    }
}

fn spawn_renewal(
    inner: &Arc<Inner>,
    slots: &[Slot],
    local: bool,
    now: f64,
) -> Option<tokio::task::JoinHandle<()>> {
    if slots.is_empty() {
        return None;
    }
    let inner = Arc::clone(inner);
    let slots = slots.to_vec();
    let until = now + inner.opts.max_renewed_ms;
    Some(tokio::spawn(async move {
        let mut tick = tokio::time::interval(inner.opts.renew_interval);
        tick.tick().await;
        loop {
            tick.tick().await;
            if inner.now() >= until {
                return;
            }
            renew(&inner, &slots, local).await;
        }
    }))
}

/// Admit (dispatch: claims a gauge slot where a ceiling is set) or consume
/// (`count_tokens`: `requests` only, no slot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Admit,
    Consume,
}

/// One subject as the script is asked about it.
pub(crate) struct Ask {
    pub(crate) subject: Subject,
    /// What it is judged against (`requestsOnly` for consume).
    pub(crate) scope: LimitScope,
    pub(crate) holder: Option<String>,
}

fn js(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e21 {
        let n = if n == 0.0 { 0.0 } else { n };
        format!("{n:.0}")
    } else {
        n.to_string()
    }
}

fn ceiling_u(p: Option<Option<u64>>) -> String {
    p.flatten().map(|n| n.to_string()).unwrap_or_default()
}

fn ceiling_f(p: Option<Option<f64>>) -> String {
    p.flatten().map(js).unwrap_or_default()
}

fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Int(n) => Some(*n),
        Value::BulkString(b) => std::str::from_utf8(b).ok()?.parse().ok(),
        _ => None,
    }
}

fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::BulkString(b) => String::from_utf8(b.clone()).ok(),
        Value::SimpleString(s) => Some(s.clone()),
        Value::Int(n) => Some(n.to_string()),
        _ => None,
    }
}

/// JS `Number(s)` for what Lua `tostring` and Redis write.
fn num_of(v: &Value) -> Option<f64> {
    if let Value::Int(n) = v {
        #[allow(clippy::cast_precision_loss)]
        return Some(*n as f64);
    }
    let s = text_of(v)?;
    match s.as_str() {
        "inf" | "+inf" => Some(f64::INFINITY),
        "-inf" => Some(f64::NEG_INFINITY),
        "nan" | "-nan" => Some(f64::NAN),
        _ => s.trim().parse().ok(),
    }
}

fn bad_reply() -> Fault {
    Fault::Server("unexpected reply to RATE_LIMIT_ADMIT".to_owned())
}

/// The script's keys and arguments for these subjects.
pub(crate) fn admit_call(
    asks: &[Ask],
    mode: Mode,
    now: f64,
    gauge_now: f64,
    ttl: u64,
) -> (Vec<String>, Vec<String>) {
    let mut keys = Vec::with_capacity(asks.len() * scripts::ADMIT_KEYS_PER_SUBJECT);
    let mut args =
        Vec::with_capacity(scripts::ADMIT_HEAD_ARGS + asks.len() * scripts::ADMIT_ARGS_PER_SUBJECT);
    args.extend([
        js(now),
        js(gauge_now),
        ttl.to_string(),
        js(Window::M1.ms()),
        if mode == Mode::Admit { "a" } else { "c" }.to_owned(),
        asks.len().to_string(),
        js(subject::grain_ms(Window::H5)),
        js(Window::H5.ms()),
        js(subject::grain_ms(Window::W1)),
        js(Window::W1.ms()),
    ]);
    for ask in asks {
        let id = &ask.subject.id;
        let (h5, w1) = (
            key("b", &bucket_key(id, Window::H5)),
            key("b", &bucket_key(id, Window::W1)),
        );
        // Script layout: `k+4`/`k+5` the 5h hash and its companion,
        // `k+6`/`k+7` the 1w ones.
        let (m5, m1) = (scripts::meta_key(&h5), scripts::meta_key(&w1));
        keys.extend([key("w", id), key("g", id), gauge_index(id), h5, m5, w1, m1]);
        let l = &ask.scope;
        let req = l.requests.as_ref();
        let tok = l.tokens.as_ref();
        let sp = l.spend.as_ref();
        args.extend([
            format!("{}-{}", js(now), uuid::Uuid::new_v4()),
            ask.holder.clone().unwrap_or_default(),
            ceiling_u(req.and_then(|w| w.one_minute)),
            // Judged only where the gauge was raised (admit) or read
            // (consume never judges it: its scope has no concurrency).
            ceiling_u(l.concurrency),
            if any_long_limit(l) { "1" } else { "0" }.to_owned(),
            ceiling_u(req.and_then(|w| w.five_hours)),
            ceiling_u(tok.and_then(|w| w.five_hours)),
            ceiling_f(sp.and_then(|w| w.five_hours)),
            ceiling_u(req.and_then(|w| w.one_week)),
            ceiling_u(tok.and_then(|w| w.one_week)),
            ceiling_f(sp.and_then(|w| w.one_week)),
        ]);
    }
    (keys, args)
}

/// The script's verdict, what each subject held before, and which of its
/// long windows were unseeded.
pub(crate) type Parsed = (bool, Vec<Observed>, Vec<[bool; 2]>);

/// The script's reply: its verdict, and what each subject held before.
pub(crate) fn parse_admit(reply: &Value, n: usize, now: f64) -> Result<Parsed, Fault> {
    let Value::Array(items) = reply else {
        return Err(bad_reply());
    };
    if items.len() != 1 + n * scripts::ADMIT_REPLY_PER_SUBJECT {
        return Err(bad_reply());
    }
    let verdict = int_of(&items[0]).ok_or_else(bad_reply)? == 1;
    let mut observed = Vec::with_capacity(n);
    let mut unseeded = Vec::with_capacity(n);
    for i in 0..n {
        let at = |j: usize| &items[1 + i * scripts::ADMIT_REPLY_PER_SUBJECT + j];
        #[allow(clippy::cast_precision_loss)]
        let used = int_of(at(0)).ok_or_else(bad_reply)? as f64;
        let reset_at = match text_of(at(1)) {
            Some(s) if s.is_empty() => now,
            Some(_) => num_of(at(1)).ok_or_else(bad_reply)? + Window::M1.ms(),
            None => now,
        };
        #[allow(clippy::cast_precision_loss)]
        let concurrency = int_of(at(2)).ok_or_else(bad_reply)?.max(0) as f64;
        let mut long = [None, None];
        let mut oldest = [None, None];
        let mut missing = [false, false];
        for w in 0..2 {
            let base = 3 + w * 5;
            match int_of(at(base)).ok_or_else(bad_reply)? {
                1 => {
                    long[w] = Some(Counts {
                        requests: num_of(at(base + 1)).ok_or_else(bad_reply)?,
                        tokens: num_of(at(base + 2)).ok_or_else(bad_reply)?,
                        cost_usd: num_of(at(base + 3)).ok_or_else(bad_reply)?,
                    });
                    oldest[w] = match text_of(at(base + 4)) {
                        Some(t) if t.is_empty() => None,
                        _ => Some(num_of(at(base + 4)).ok_or_else(bad_reply)?),
                    };
                }
                0 => missing[w] = true,
                _ => {}
            }
        }
        observed.push(Observed {
            before_1m: WindowCounter { used, reset_at },
            concurrency,
            long,
            oldest,
        });
        unseeded.push(missing);
    }
    Ok((verdict, observed, unseeded))
}

impl ClusterLimiter {
    /// Builds the limiter over D2's coordinator. The coordinator should have
    /// been connected with [`scripts::all`] in `extra_scripts` (otherwise the
    /// first call of each script is sent whole once).
    pub fn new(
        coord: Arc<RedisCoord>,
        usage: Arc<dyn UsageSource>,
        opts: ClusterLimiterOptions,
    ) -> Self {
        let remote = coord.remote().clone();
        let local = MemoryCoord::new(Arc::clone(&opts.clock));
        let inner = Arc::new(Inner {
            _coord: coord,
            remote,
            local,
            usage,
            seeds: seed::Seeds::new(opts.seed_queue),
            debits: debit::Debits::default(),
            opts,
            metrics: Metrics::default(),
            limits: Mutex::new(HashMap::new()),
            last_fallback_log: Mutex::new(None),
            background: Mutex::new(Vec::new()),
            debits_stop: Arc::new(tokio::sync::Notify::new()),
        });
        let tasks = vec![seed::spawn(&inner), debit::spawn(&inner)];
        *inner
            .background
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = tasks;
        Self { inner }
    }

    pub fn metrics(&self) -> &Metrics {
        &self.inner.metrics
    }

    /// TS `admit`: judges a request that will be dispatched and claims its
    /// concurrency slots. `now` is the request's one clock reading.
    pub async fn admit(
        &self,
        key_id: &str,
        limits: &LimitConfig,
        model: &str,
        now: f64,
    ) -> Result<Admission, RateLimitExceeded> {
        let subjects = subject::subjects_of(key_id, limits, model);
        if subjects.is_empty() {
            return Ok(Admission::unlimited());
        }
        let asks: Vec<Ask> = subjects
            .into_iter()
            .map(|s| {
                let holder = s
                    .limits
                    .concurrency
                    .flatten()
                    .map(|_| uuid::Uuid::new_v4().to_string());
                Ask {
                    scope: s.limits.clone(),
                    subject: s,
                    holder,
                }
            })
            .collect();
        self.run(asks, Mode::Admit, now).await
    }

    /// TS `consume`: a `count_tokens` request, charged to `requests` only,
    /// holding no slot.
    pub async fn consume(
        &self,
        key_id: &str,
        limits: &LimitConfig,
        model: &str,
        now: f64,
    ) -> Result<(), RateLimitExceeded> {
        let asks: Vec<Ask> = subject::subjects_of(key_id, limits, model)
            .into_iter()
            .filter(|s| any_request_limit(&s.limits))
            .map(|s| Ask {
                scope: requests_only(&s.limits),
                subject: s,
                holder: None,
            })
            .collect();
        if asks.is_empty() {
            return Ok(());
        }
        self.run(asks, Mode::Consume, now).await.map(drop)
    }

    async fn run(
        &self,
        asks: Vec<Ask>,
        mode: Mode,
        now: f64,
    ) -> Result<Admission, RateLimitExceeded> {
        let inner = &self.inner;
        {
            let mut known = inner.limits.lock().unwrap_or_else(PoisonError::into_inner);
            for a in &asks {
                if known.get(&a.subject.id) != Some(&a.subject.limits) {
                    known.insert(a.subject.id.clone(), a.subject.limits.clone());
                }
            }
        }
        let gauge_now = inner.now();
        let (keys, args) = admit_call(&asks, mode, now, gauge_now, inner.opts.gauge_ttl_ms);
        // Armed before the script is submitted: if this future is dropped
        // (the caller cancelled) or the call faults, every named slot the
        // script may have taken is given back — a detached release ordered
        // after the script on the connection, replay-safe. Disarmed only
        // once the slots belong to an `Admission` (or the script refused,
        // having rolled them back itself).
        let mut cleanup = SlotCleanup {
            inner,
            slots: asks
                .iter()
                .filter_map(|a| a.holder.as_ref().map(|h| (a.subject.id.clone(), h.clone())))
                .collect(),
        };
        let reply = inner.remote.eval(&scripts::ADMIT, &keys, &args).await;
        let parsed = reply.and_then(|r| parse_admit(&r, asks.len(), now));
        let (verdict, observed, unseeded) = match parsed {
            Ok(p) => p,
            Err(fault) => {
                // A script that was written may still land after its
                // deadline (or have run partly, on a server error): the
                // cleanup gives back its slots. A late window claim stays —
                // an over-count, the direction the limiter permits. A call
                // refused before sending took nothing.
                let sent = matches!(
                    fault,
                    Fault::TimedOut | Fault::Connection(_) | Fault::Server(_)
                );
                if sent {
                    cleanup.release();
                }
                cleanup.slots.clear();
                inner.fallback(&fault);
                return local::run(&self.inner, asks, mode, now).await;
            }
        };
        if !verdict {
            // Refused: the script rolled its own claims back.
            cleanup.slots.clear();
        }
        bump(&inner.metrics.redis_calls);

        let scopes: Vec<LimitScope> = asks.iter().map(|a| a.scope.clone()).collect();
        let decisions = judge::decide(&scopes, &observed, now);
        let combined: Decision = combine_all(&decisions);

        // Seeds for every unseeded window this request wanted, admitted or
        // not: the next request should find them.
        let mut missing = Vec::new();
        for (a, m) in asks.iter().zip(&unseeded) {
            for (i, window) in LONG.into_iter().enumerate() {
                if m[i] {
                    missing.push((a.subject.id.clone(), window));
                    seed::want(inner, &a.subject, window);
                }
            }
        }

        if combined.violation.is_some() {
            if verdict {
                // Unreachable (the script tests the same predicate on the
                // same figures); give the claims back as TS's rollback would.
                bump(&inner.metrics.verdict_mismatches);
                tracing::error!("rate limit script admitted a refused request; rolling back");
                rollback_remote(inner, &asks, now).await;
            }
            bump(&inner.metrics.refusals);
            let refusal = judge::refusal(&decisions, &observed, now);
            if let Some(r) = refusal {
                if let Some(hook) = &inner.opts.on_rejected {
                    hook(r.violation.dimension, r.violation.window);
                }
                return Err(r);
            }
        } else if !verdict {
            // Unreachable likewise. The claims were rolled back; admit
            // without them (fails open) and say so.
            bump(&inner.metrics.verdict_mismatches);
            tracing::error!("rate limit script refused an admitted request; admitting");
        }

        if !missing.is_empty() {
            inner
                .metrics
                .unseeded_admits
                .fetch_add(missing.len() as u64, Ordering::Relaxed);
        }
        let slots: Vec<Slot> = if verdict {
            asks.iter()
                .filter_map(|a| {
                    a.holder.as_ref().map(|h| Slot {
                        subject: a.subject.id.clone(),
                        holder: h.clone(),
                    })
                })
                .collect()
        } else {
            Vec::new()
        };
        let renewal = spawn_renewal(&self.inner, &slots, false, now);
        // The slots now belong to the admission (released by it, or on drop).
        cleanup.slots.clear();
        Ok(Admission {
            headroom: combined.headroom,
            unseeded: missing,
            local: false,
            held: (!slots.is_empty()).then(|| Held {
                inner: Arc::clone(&self.inner),
                slots,
                local: false,
                renewal,
            }),
        })
    }

    /// TS `debit`: one completed request against the long windows of every
    /// subject this process admitted (or [`Self::record_override`]d) with a
    /// long window. Batched; applied within `debit_interval`, or by
    /// [`Self::flush_debits`]. Call it once the request's row is committed.
    /// `row_at` is the row's `at` (TS `startedAt`): it places the row in the
    /// row ranges a refusal's reset is read from; the counts are stamped
    /// with the clock now, as TS's `buckets.add(…, now)`. `commit` is the
    /// commit id of the store transaction that completed the row (on
    /// Postgres the writer batch's `pg_current_xact_id()`): a seed whose
    /// read saw that commit already counted the row, and the debit is then
    /// skipped (ruling I1). `""` (unknown) is never skipped.
    pub fn debit(
        &self,
        key_id: &str,
        requested_model: &str,
        tokens: f64,
        cost_usd: f64,
        row_at: f64,
        commit: &str,
    ) {
        self.debit_selected(
            key_id,
            Some(requested_model),
            tokens,
            cost_usd,
            row_at,
            commit,
        );
    }

    /// A completion whose model cannot be encoded charges the key only.
    /// Never substitute its lossy stored spelling as an override subject.
    pub fn debit_selected(
        &self,
        key_id: &str,
        requested_model: Option<&str>,
        tokens: f64,
        cost_usd: f64,
        row_at: f64,
        commit: &str,
    ) {
        let delta = Counts {
            requests: 1.0,
            tokens,
            cost_usd,
        };
        let subjects = std::iter::once(key_id.to_owned())
            .chain(requested_model.map(|model| subject::model_subject_id(key_id, model)));
        let mut wanted = Vec::with_capacity(2);
        {
            let known = self
                .inner
                .limits
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            for s in subjects {
                if known.get(&s).is_some_and(any_long_limit) {
                    wanted.push(s);
                }
            }
        }
        if wanted.is_empty() {
            return;
        }
        let now = self.inner.now();
        for s in wanted {
            for window in LONG {
                debit::push(
                    &self.inner,
                    &debit::Debit {
                        subject: &s,
                        window,
                        now,
                        row_at,
                        commit,
                        delta,
                    },
                );
            }
        }
    }

    /// TS `recordOverride`: an override's limits, for a completion this
    /// process debits without admitting (the guardrail's classifier).
    pub fn record_override(&self, key_id: &str, limits: &LimitConfig, model: &str) {
        if let Some(o) = limits.model_override(model) {
            self.inner
                .limits
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(subject::model_subject_id(key_id, model), o.clone());
        }
    }

    /// A recovered request may have been admitted by a different process.
    /// Register its configured scopes without making an admission or seeding.
    pub fn record_recovered_limits(&self, key_id: &str, limits: &LimitConfig, model: Option<&str>) {
        let mut known = self
            .inner
            .limits
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for subject in subject::subjects_of(key_id, limits, model.unwrap_or_default()) {
            if (model.is_some() || subject.model.is_none()) && any_long_limit(&subject.limits) {
                known.insert(subject.id, subject.limits);
            }
        }
    }

    /// Applies every pending debit now (and waits for it). Cancel-safe:
    /// dropped mid-way, it puts back what it had not sent and counts what
    /// was in flight as lost (reseed armed).
    pub async fn flush_debits(&self) {
        debit::flush(&self.inner).await;
    }

    /// Delivery loss before the debit queue needs the same recovery sweep as
    /// loss inside it; a later seed must not trust incomplete counts.
    pub fn note_completion_gap(&self) {
        self.inner.remote.note_lost_debit();
    }

    /// Queues seeds for every subject of this key with a long window (the
    /// key-wide one and each override): at boot, and when a key enters the
    /// snapshot. Returns how many were queued.
    pub fn preseed(&self, key_id: &str, limits: &LimitConfig) -> usize {
        let mut n = 0;
        for s in preseed_subjects(key_id, limits) {
            for window in LONG {
                n += usize::from(seed::want(&self.inner, &s, window));
            }
        }
        n
    }

    /// Seeds every long window of this key now, at `now`, and waits.
    /// Counts the windows that could not be seeded (left to the background).
    pub async fn preseed_now(&self, key_id: &str, limits: &LimitConfig, now: f64) -> usize {
        let mut failed = 0;
        for s in preseed_subjects(key_id, limits) {
            for window in LONG {
                if seed::run(&self.inner, &s, window, now).await.is_err() {
                    failed += 1;
                }
            }
        }
        failed
    }

    /// Waits until no seed is queued or running. For tests and boot.
    pub async fn seeds_settled(&self) {
        seed::settled(&self.inner).await;
    }

    /// Debit entries and estimated bytes pending.
    pub fn debits_pending(&self) -> (usize, usize) {
        self.inner.debits.usage()
    }

    /// The estimated bytes of every retained pending entry, recomputed from
    /// scratch (what `debits_pending().1` must equal). For tests.
    #[doc(hidden)]
    pub fn debits_audit(&self) -> usize {
        self.inner.debits.audit()
    }

    /// Stops cleanly (I3, R2): stops the seeder and cancels running seeds
    /// (releasing their locks) and waits for them; lets the flusher finish
    /// the flush it is in and joins it; then flushes every pending debit,
    /// keeping those another replica's seed is installing for at most
    /// `shutdown_drain`. Anything still pending then is counted lost
    /// (reseed armed) — never silently dropped. Idempotent.
    pub async fn shutdown(&self) {
        let inner = &self.inner;
        // The worker first (so it cannot start a seed after the running ones
        // are collected), then the running seeds, then the flusher.
        seed::stopping(inner);
        debit::stop(inner);
        let tasks = std::mem::take(
            &mut *inner
                .background
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        );
        // [seed worker, debit flusher]. The worker is cancelled (it holds
        // no work: reserved jobs carry their own completion guard). The
        // flusher is joined, not cancelled: it ends after the flush it is in
        // (R2) — and were it cancelled, its flush would put back what it had
        // not sent and count what was in flight as lost.
        let mut tasks = tasks.into_iter();
        if let Some(worker) = tasks.next() {
            worker.abort();
            let _ended = worker.await.is_err();
        }
        for t in tasks {
            let _ended = t.await.is_err();
        }
        seed::stop(inner).await;
        let deadline = tokio::time::Instant::now() + inner.opts.shutdown_drain;
        debit::drain(inner, deadline).await;
    }
}

fn preseed_subjects(key_id: &str, limits: &LimitConfig) -> Vec<Subject> {
    let mut out: Vec<Subject> = Vec::new();
    let models = std::iter::once("").chain(
        limits
            .models
            .iter()
            .flat_map(|m| m.keys().map(String::as_str)),
    );
    for model in models {
        for s in subject::subjects_of(key_id, limits, model) {
            if any_long_limit(&s.limits) && !out.iter().any(|o| o.id == s.id) {
                out.push(s);
            }
        }
    }
    out
}

/// Gives back named gauge slots unless disarmed (`slots` cleared): a
/// cancelled or faulted admission must not hold a `concurrency` slot until
/// its TTL.
struct SlotCleanup<'a> {
    inner: &'a Inner,
    slots: Vec<(String, String)>,
}

impl SlotCleanup<'_> {
    fn release(&mut self) {
        for (subject, holder) in self.slots.drain(..) {
            if self
                .inner
                .remote
                .gauge_release_detached(&subject, self.inner.now(), Some(&holder))
                .is_err()
            {
                bump(&self.inner.metrics.releases_refused);
            }
        }
    }
}

impl Drop for SlotCleanup<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

/// TS `rollback` for every claim, through the per-step scripts.
async fn rollback_remote(inner: &Inner, asks: &[Ask], now: f64) {
    for a in asks {
        let _rolled = inner
            .remote
            .window_rollback(&a.subject.id, now)
            .await
            .is_ok();
        if let Some(h) = &a.holder {
            let _released = inner
                .remote
                .gauge_release(&a.subject.id, inner.now(), Some(h))
                .await
                .is_ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_numbers_are_string_of_n() {
        assert_eq!(js(1_700_000_000_000.0), "1700000000000");
        assert_eq!(js(1.5), "1.5");
        assert_eq!(js(-0.0), "0");
    }
}
