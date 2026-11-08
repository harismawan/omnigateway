//! Port of `apps/gateway/test/auth/rateLimit.test.ts` for single mode.
//!
//! Seeding is in the background here (spec ruling), so a test that asserts
//! on a long window first admits/prepares and runs the queued seeds, as the
//! conformance suite pre-seeds. Bursts are sequential: admission is
//! synchronous under one lock, so a concurrent burst is the same sequence.

use omni_gateway_core::ratelimit::{Admission, RateLimitExceeded, RateLimiter, model_subject_id};
use omni_ratelimit::Window;
use omni_store::limits::{LimitConfig, parse_limits};
use omni_store::{SqliteStore, rollup};
use rusqlite::params;
use std::sync::Arc;

const T0: f64 = 10_020_000.0;
const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 3_600_000.0;
const DAY: f64 = 86_400_000.0;
const WEEK: f64 = 7.0 * DAY;
const KEY: &str = "k1";

struct H {
    _dir: tempfile::TempDir,
    store: SqliteStore,
    limiter: Arc<RateLimiter>,
    limits: LimitConfig,
    clock: f64,
    rows: usize,
}

fn limits(json: &str) -> LimitConfig {
    parse_limits(json).expect("limits")
}

fn harness(json: &str) -> H {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteStore::open(dir.path().join("omni.db"), 0).expect("store");
    H {
        _dir: dir,
        store,
        limiter: RateLimiter::new(),
        limits: limits(json),
        clock: T0,
        rows: 0,
    }
}

impl H {
    fn at(&mut self, ms: f64) {
        self.clock = ms;
    }

    fn admit(&self, model: &str) -> Result<Admission, RateLimitExceeded> {
        self.limiter.admit(KEY, &self.limits, model, self.clock)
    }

    fn consume(&self, model: &str) -> Result<(), RateLimitExceeded> {
        self.limiter.consume(KEY, &self.limits, model, self.clock)
    }

    /// The background seed, run now. Returns the reads it made.
    fn seed(&self) -> usize {
        self.limiter.seed_now(&self.store)
    }

    /// Prepares and seeds a model's subjects, as boot pre-seeding does.
    fn preseed(&self, model: &str) {
        self.limiter.prepare(KEY, &self.limits, model, self.clock);
        self.seed();
    }

    /// One finished row, without telling the limiter.
    fn row(&mut self, at: f64, tokens: i64, cost: f64, model: &str) {
        self.rows += 1;
        let id = format!("r{}", self.rows);
        self.row_with_id(&id, at, tokens, cost, model);
    }

    fn row_with_id(&mut self, id: &str, at: f64, tokens: i64, cost: f64, model: &str) {
        let q = tokens / 4;
        self.store
            .connection()
            .execute(
                "INSERT INTO request_logs (id, at, api_key_id, requested_model, status, duration_ms,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
                 VALUES (?,?,?,?,200,1,?,?,?,?,?)",
                params![id, at as i64, KEY, model, q, q, q, tokens - 3 * q, cost],
            )
            .expect("row");
        rollup::rebuild_rollup(self.store.connection()).expect("rollup");
    }

    /// A finished request: its row committed, then its debit, as the
    /// writer delivers committed completions.
    fn complete(&mut self, tokens: i64, cost: f64, model: &str) {
        let at = self.clock;
        self.row(at, tokens, cost, model);
        #[allow(clippy::cast_precision_loss)]
        self.limiter.debit(KEY, model, tokens as f64, cost, at, at);
    }
}

fn denied(r: Result<Admission, RateLimitExceeded>) -> RateLimitExceeded {
    match r {
        Ok(_) => panic!("expected a refusal"),
        Err(e) => e,
    }
}

/// Asserts admission and keeps the slots.
fn admitted(r: Result<Admission, RateLimitExceeded>) -> Admission {
    r.expect("expected an admission")
}

/// Asserts admission and releases at once.
fn admits(r: Result<Admission, RateLimitExceeded>) {
    drop(admitted(r));
}

#[test]
fn a_token_ceiling_denies_at_the_limit_and_allows_below_it() {
    let mut under = harness(r#"{"tokens":{"5h":101}}"#);
    under.row(T0 - 1000.0, 100, 0.0, "fast");
    under.preseed("fast");
    admits(under.admit("fast"));

    let mut at = harness(r#"{"tokens":{"5h":100}}"#);
    at.row(T0 - 1000.0, 100, 0.0, "fast");
    at.preseed("fast");
    let e = denied(at.admit("fast"));
    assert_eq!(e.to_gateway_error().code.as_str(), "RATE_LIMIT");
    assert_eq!(e.to_gateway_error().message, "API key rate limit exceeded");
}

#[test]
fn a_spend_ceiling_denies_at_the_limit_and_allows_below_it() {
    let mut under = harness(r#"{"spend":{"1w":5.5}}"#);
    under.row(T0 - 1000.0, 0, 5.0, "fast");
    under.preseed("fast");
    admits(under.admit("fast"));
    let mut at = harness(r#"{"spend":{"1w":5}}"#);
    at.row(T0 - 1000.0, 0, 5.0, "fast");
    at.preseed("fast");
    denied(at.admit("fast"));
}

#[test]
fn a_concurrency_ceiling_denies_while_slots_are_held_and_frees_on_release_or_drop() {
    let h = harness(r#"{"concurrency":2}"#);
    let mut first = admitted(h.admit("fast"));
    let second = admitted(h.admit("fast"));
    assert_eq!(h.limiter.in_flight(KEY), 2);
    let e = denied(h.admit("fast"));
    assert_eq!(e.retry_after_ms, 0.0);
    first.release();
    first.release();
    assert_eq!(h.limiter.in_flight(KEY), 1);
    let third = admitted(h.admit("fast"));
    assert_eq!(h.limiter.in_flight(KEY), 2);
    drop(second);
    drop(third);
    drop(first);
    assert_eq!(h.limiter.in_flight(KEY), 0);
}

#[test]
fn a_burst_against_a_1m_ceiling_admits_exactly_the_ceiling_and_refusals_keep_nothing() {
    let h = harness(r#"{"requests":{"1m":3}}"#);
    let held: Vec<_> = (0..10).filter_map(|_| h.admit("fast").ok()).collect();
    assert_eq!(held.len(), 3);
    let h2 = harness(r#"{"requests":{"1m":100},"concurrency":2}"#);
    let held2: Vec<_> = (0..8).filter_map(|_| h2.admit("fast").ok()).collect();
    assert_eq!(held2.len(), 2);
    drop(held2);
    assert_eq!(h2.limiter.in_flight(KEY), 0);
    let next = admitted(h2.admit("fast"));
    assert_eq!(next.headroom.requests.map(|r| r.used), Some(2.0));
}

#[test]
fn a_burst_of_count_tokens_checks_consumes_exactly_the_ceiling() {
    let h = harness(r#"{"requests":{"1m":3}}"#);
    assert_eq!((0..10).filter(|_| h.consume("fast").is_ok()).count(), 3);
}

#[test]
fn a_long_window_counts_the_seeded_sum_plus_what_has_been_debited_since() {
    let mut h = harness(r#"{"tokens":{"5h":100}}"#);
    h.row(T0 - 1000.0, 40, 0.0, "fast");
    h.preseed("fast");
    admits(h.admit("fast"));
    h.limiter.debit(KEY, "fast", 60.0, 0.0, T0, T0);
    denied(h.admit("fast"));
}

#[test]
fn a_long_requests_ceiling_is_reached_because_every_debit_carries_its_request() {
    let mut h = harness(r#"{"requests":{"5h":3}}"#);
    h.preseed("fast");
    let mut n = 0;
    for i in 0..10 {
        h.at(T0 + f64::from(i) * 1_000.0);
        if let Ok(a) = h.admit("fast") {
            n += 1;
            h.complete(0, 0.0, "fast");
            drop(a);
        }
    }
    assert_eq!(n, 3);
}

#[test]
fn the_store_seeds_a_subject_once_and_is_not_asked_again_while_the_buckets_live() {
    let mut h = harness(r#"{"tokens":{"5h":1000000}}"#);
    h.row(T0 - 1000.0, 40, 0.0, "fast");
    admits(h.admit("fast"));
    assert_eq!(h.seed(), 2, "one read per long window");
    admits(h.admit("fast"));
    h.at(T0 + HOUR);
    admits(h.admit("fast"));
    assert_eq!(h.seed(), 0);
}

#[test]
fn a_trailing_bucket_counts_until_its_whole_grain_has_aged_out() {
    let mut h = harness(r#"{"tokens":{"5h":100}}"#);
    h.row(T0 - 5.0 * HOUR, 100, 0.0, "fast");
    h.preseed("fast");
    denied(h.admit("fast"));
    h.at(T0 + 59_999.0);
    denied(h.admit("fast"));
    h.at(T0 + 60_000.0);
    admits(h.admit("fast"));
}

#[test]
fn a_debit_before_the_seed_is_counted_once_by_the_seed() {
    let mut once = harness(r#"{"tokens":{"5h":100}}"#);
    once.row(T0 - 1000.0, 40, 0.0, "fast");
    once.limiter.prepare(KEY, &once.limits.clone(), "fast", T0);
    once.complete(60, 0.0, "fast");
    once.seed();
    denied(once.admit("fast"));

    let mut twice = harness(r#"{"tokens":{"5h":100}}"#);
    twice.row(T0 - 1000.0, 40, 0.0, "fast");
    twice
        .limiter
        .prepare(KEY, &twice.limits.clone(), "fast", T0);
    twice.complete(30, 0.0, "fast");
    twice.seed();
    admits(twice.admit("fast"));
}

/// The spec's one deliberate difference: an unseeded long window admits
/// while the seed is queued, and enforces once it lands. `1m` and
/// `concurrency` enforce throughout.
#[test]
fn an_unseeded_long_window_admits_while_seeding_and_enforces_once_seeded() {
    let mut h = harness(r#"{"tokens":{"5h":1},"concurrency":1}"#);
    h.row(T0 - 1000.0, 5000, 0.0, "fast");
    let first = admitted(h.admit("fast"));
    assert_eq!(h.limiter.seeds_pending(), 2);
    denied(h.admit("fast"));
    drop(first);
    assert_eq!(h.seed(), 2);
    assert_eq!(h.limiter.seeds_pending(), 0);
    let e = denied(h.admit("fast"));
    assert_eq!(e.violation.window, Some(Window::H5));
}

#[test]
fn a_failing_seed_read_serves_the_request_and_is_asked_again() {
    let mut h = harness(r#"{"tokens":{"5h":1}}"#);
    h.row(T0 - 1000.0, 5000, 0.0, "fast");
    h.store
        .connection()
        .execute_batch("ALTER TABLE request_logs RENAME TO request_logs_gone")
        .expect("break");
    admits(h.admit("fast"));
    h.seed();
    admits(h.admit("fast"));
    h.store
        .connection()
        .execute_batch("ALTER TABLE request_logs_gone RENAME TO request_logs")
        .expect("fix");
    h.seed();
    denied(h.admit("fast"));
}

#[test]
fn an_unlimited_key_allocates_nothing_and_queues_no_seed() {
    let h = harness("{}");
    let a = admitted(h.admit("fast"));
    assert!(a.headroom.is_empty());
    assert_eq!(h.limiter.in_flight(KEY), 0);
    assert_eq!(h.limiter.seeds_pending(), 0);
}

#[test]
fn count_tokens_consumes_requests_and_never_tokens_spend_or_a_slot() {
    let mut h =
        harness(r#"{"requests":{"1m":2},"tokens":{"5h":1},"spend":{"5h":0.01},"concurrency":1}"#);
    h.row(T0 - 1000.0, 5000, 40.0, "fast");
    h.preseed("fast");
    h.consume("fast").expect("1");
    h.consume("fast").expect("2");
    assert_eq!(h.limiter.in_flight(KEY), 0);
    assert!(h.consume("fast").is_err());
}

#[test]
fn the_model_subject_cannot_collide_with_another_keys_or_models() {
    assert_eq!(model_subject_id("k1", "opus"), "k1/m/opus");
    assert_eq!(model_subject_id("k1", "llama3:8b"), "k1/m/llama3%3A8b");
    assert_ne!(
        model_subject_id("k1", "a/m/b"),
        model_subject_id("k1/m/a", "b")
    );
    assert_eq!(model_subject_id("k", "é (x)"), "k/m/%C3%A9%20(x)");
}

#[test]
fn a_burst_against_a_models_ceilings_admits_exactly_the_ceiling() {
    let h = harness(r#"{"requests":{"1m":100},"models":{"opus":{"requests":{"1m":3}}}}"#);
    assert_eq!((0..10).filter(|_| h.admit("opus").is_ok()).count(), 3);
    assert_eq!((0..10).filter(|_| h.admit("fast").is_ok()).count(), 10);
    let next = admitted(h.admit("fast"));
    assert_eq!(next.headroom.requests.map(|r| r.used), Some(13.0));

    let c = harness(r#"{"concurrency":10,"models":{"opus":{"concurrency":3}}}"#);
    let held: Vec<_> = (0..8).filter_map(|_| c.admit("opus").ok()).collect();
    assert_eq!(held.len(), 3);
    assert_eq!(c.limiter.in_flight(&model_subject_id(KEY, "opus")), 3);
    assert_eq!(c.limiter.in_flight(KEY), 3);
}

#[test]
fn a_refusal_by_either_scope_rolls_back_the_other() {
    let h =
        harness(r#"{"requests":{"1m":100},"concurrency":10,"models":{"opus":{"concurrency":1}}}"#);
    let held = admitted(h.admit("opus"));
    for _ in 0..4 {
        denied(h.admit("opus"));
    }
    assert_eq!(h.limiter.in_flight(KEY), 1);
    let next = admitted(h.admit("fast"));
    assert_eq!(next.headroom.requests.map(|r| r.used), Some(1.0));
    drop((next, held));

    let k =
        harness(r#"{"concurrency":1,"models":{"opus":{"requests":{"1m":100},"concurrency":5}}}"#);
    let held = admitted(k.admit("fast"));
    for _ in 0..4 {
        denied(k.admit("opus"));
    }
    assert_eq!(k.limiter.in_flight(&model_subject_id(KEY, "opus")), 0);
    drop(held);
    let next = admitted(k.admit("opus"));
    assert_eq!(next.headroom.requests.map(|r| r.used), Some(0.0));
}

#[test]
fn an_override_on_a_key_with_no_key_wide_limits_claims_only_the_model() {
    let h = harness(r#"{"models":{"opus":{"concurrency":1}}}"#);
    assert!(admitted(h.admit("fast")).headroom.is_empty());
    assert_eq!(h.limiter.in_flight(KEY), 0);
    let held = admitted(h.admit("opus"));
    denied(h.admit("opus"));
    drop(held);
    admits(h.admit("opus"));
    // Not a prototype member either.
    assert!(admitted(h.admit("constructor")).headroom.is_empty());
}

#[test]
fn a_models_long_window_seeds_from_that_models_rows_and_takes_its_debits() {
    let mut h = harness(r#"{"tokens":{"5h":10000},"models":{"opus":{"tokens":{"5h":100}}}}"#);
    h.row(T0 - 2000.0, 5000, 0.0, "fast");
    h.row(T0 - 1000.0, 60, 0.0, "opus");
    h.preseed("opus");
    admits(h.admit("opus"));
    h.complete(50, 0.0, "opus");
    let refused = denied(h.admit("opus"));
    assert_eq!(refused.headroom.tokens.map(|t| t.limit), Some(100.0));
    let fast = admitted(h.admit("fast"));
    assert_eq!(fast.headroom.tokens.map(|t| t.used), Some(5110.0));
    h.complete(1000, 0.0, "fast");
    h.at(T0 + 1.0);
    let later = denied(h.admit("opus"));
    assert_eq!(later.headroom.tokens.map(|t| t.used), Some(110.0));
}

#[test]
fn a_recorded_override_takes_a_debit_this_process_never_admitted() {
    // The guardrail's classifier: its completion is debited by a limiter
    // that never admitted (or prepared) the model. Only `record_override`
    // tells it the subject has a long window; without it the debit is
    // skipped and the window under-counts.
    let h = harness(r#"{"models":{"judge":{"tokens":{"5h":40},"concurrency":5}}}"#);
    // The judge subject's buckets are installed directly from a seed job
    // planned elsewhere, so this limiter has no record of the override.
    let planner = RateLimiter::new();
    planner.prepare(KEY, &h.limits, "judge", T0);
    let classifier = RateLimiter::new();
    for job in planner.take_seed_jobs() {
        classifier.apply(omni_store::writer::Committed::Seed {
            query: RateLimiter::seed_query(&job),
            result: Ok(omni_store::writer::SeedRows {
                buckets: vec![],
                stamps: vec![],
            }),
        });
    }
    classifier.record_override(KEY, &h.limits, "judge");
    assert_eq!(classifier.in_flight(&model_subject_id(KEY, "judge")), 0);
    classifier.debit(KEY, "judge", 41.0, 0.0, T0, T0);
    let refused = match classifier.admit(KEY, &h.limits, "judge", T0) {
        Ok(_) => panic!("41 tokens debited against a 40 ceiling must refuse"),
        Err(e) => e,
    };
    assert_eq!(refused.headroom.tokens.map(|t| t.used), Some(41.0));
}

#[test]
fn count_tokens_charges_a_model_overrides_requests_and_nothing_else() {
    let mut h = harness(
        r#"{"models":{"opus":{"requests":{"1m":2},"tokens":{"5h":1},"spend":{"5h":0.01},"concurrency":1}}}"#,
    );
    h.row(T0 - 1000.0, 5000, 40.0, "opus");
    h.preseed("opus");
    h.consume("opus").expect("1");
    h.consume("opus").expect("2");
    assert_eq!(h.limiter.in_flight(&model_subject_id(KEY, "opus")), 0);
    assert!(h.consume("opus").is_err());
    h.consume("fast").expect("unlimited");
}

#[test]
fn count_tokens_refused_by_either_scope_gives_back_both_stamps() {
    let mut k = harness(r#"{"requests":{"1m":3},"models":{"opus":{"requests":{"1m":2}}}}"#);
    k.consume("fast").expect("f1");
    k.consume("fast").expect("f2");
    k.at(T0 + MINUTE / 2.0);
    k.consume("opus").expect("o1");
    assert!(k.consume("opus").is_err());
    k.at(T0 + MINUTE + 1.0);
    k.consume("opus").expect("o2");

    let m = harness(r#"{"requests":{"1m":3},"models":{"opus":{"requests":{"1m":1}}}}"#);
    m.consume("opus").expect("o1");
    for _ in 0..3 {
        assert!(m.consume("opus").is_err());
    }
    m.consume("fast").expect("f1");
    m.consume("fast").expect("f2");
}

// ---- the refusal's reset, read exactly from the retained rows

#[test]
fn a_refusals_reset_is_read_from_the_subject_that_refused() {
    let mut h = harness(r#"{"requests":{"5h":100},"models":{"opus":{"requests":{"5h":2}}}}"#);
    h.row(T0 - 4.0 * HOUR, 0, 0.0, "fast");
    h.row(T0 - HOUR, 0, 0.0, "opus");
    h.row(T0 - HOUR / 2.0, 0, 0.0, "opus");
    h.preseed("opus");
    let refused = denied(h.admit("opus"));
    assert_eq!(refused.retry_after_ms, 4.0 * HOUR);
    assert_eq!(
        refused.headroom.requests.map(|r| r.reset_at),
        Some(T0 + 4.0 * HOUR)
    );

    let mut k = harness(r#"{"requests":{"5h":2},"models":{"opus":{"requests":{"5h":100}}}}"#);
    k.row(T0 - 4.0 * HOUR, 0, 0.0, "fast");
    k.row(T0 - HOUR, 0, 0.0, "opus");
    k.preseed("opus");
    assert_eq!(denied(k.admit("opus")).retry_after_ms, HOUR);
}

#[test]
fn a_refusals_corrected_reset_leaves_the_other_scopes_same_named_window_alone() {
    let mut h = harness(r#"{"requests":{"5h":100},"models":{"opus":{"tokens":{"5h":10}}}}"#);
    h.row(T0 - 4.0 * HOUR, 0, 0.0, "fast");
    h.row(T0 - HOUR, 40, 0.0, "opus");
    h.preseed("opus");
    let refused = denied(h.admit("opus"));
    assert_eq!(
        refused.headroom.tokens.map(|t| t.reset_at),
        Some(T0 + 4.0 * HOUR)
    );
    assert_eq!(
        refused.headroom.requests.map(|r| r.reset_at),
        Some(T0 + 5.0 * HOUR)
    );
}

#[test]
fn a_refusal_by_both_scopes_waits_for_the_one_that_truly_clears_last() {
    let mut h = harness(r#"{"requests":{"1m":1},"models":{"opus":{"requests":{"5h":1}}}}"#);
    h.row(T0 - 5.0 * HOUR + 5_000.0, 0, 0.0, "opus");
    h.preseed("opus");
    admits(h.admit("fast"));
    h.at(T0 + 1_000.0);
    let refused = denied(h.admit("opus"));
    assert_eq!(refused.retry_after_ms, 59_000.0);
    assert_eq!(
        refused.headroom.requests.map(|r| r.reset_at),
        Some(T0 + 60_000.0)
    );

    let mut later = harness(r#"{"requests":{"1m":1},"models":{"opus":{"requests":{"5h":1}}}}"#);
    later.row(T0 - 4.0 * HOUR, 0, 0.0, "opus");
    later.preseed("opus");
    admits(later.admit("fast"));
    later.at(T0 + 1_000.0);
    assert_eq!(denied(later.admit("opus")).retry_after_ms, HOUR - 1_000.0);
}

#[test]
fn a_refusal_by_two_windows_of_one_scope_waits_for_the_one_that_truly_clears_last() {
    let mut h = harness(r#"{"requests":{"1m":1,"1w":2}}"#);
    h.row(T0 - WEEK + 10_000.0, 0, 0.0, "fast");
    h.preseed("fast");
    admits(h.admit("fast"));
    h.complete(0, 0.0, "fast");
    h.at(T0 + 1_000.0);
    assert_eq!(denied(h.admit("fast")).retry_after_ms, 59_000.0);
}

#[test]
fn every_violated_long_window_is_corrected_not_only_the_reported_one() {
    let mut h = harness(r#"{"requests":{"5h":1,"1w":2}}"#);
    h.row(T0 - WEEK + 10_000.0, 0, 0.0, "fast");
    h.row(T0 - 2.0 * HOUR, 0, 0.0, "fast");
    h.preseed("fast");
    let refused = denied(h.admit("fast"));
    assert_eq!(refused.retry_after_ms, 3.0 * HOUR);
    assert_eq!(
        refused.headroom.requests.map(|r| r.reset_at),
        Some(T0 + 3.0 * HOUR)
    );
}

#[test]
fn a_refusals_header_for_the_refused_dimension_names_the_refusing_window() {
    let mut h = harness(r#"{"requests":{"1m":1},"models":{"opus":{"requests":{"5h":2}}}}"#);
    h.row(T0 - 2.0 * HOUR, 0, 0.0, "opus");
    h.row(T0 - HOUR, 0, 0.0, "opus");
    h.preseed("opus");
    admits(h.admit("fast"));
    h.at(T0 + 1_000.0);
    let refused = denied(h.admit("opus"));
    assert_eq!(refused.retry_after_ms, 3.0 * HOUR - 1_000.0);
    let r = refused.headroom.requests.expect("requests");
    assert_eq!(
        (r.window, r.limit, r.used, r.remaining, r.reset_at),
        (Window::H5, 2.0, 2.0, 0.0, T0 + 3.0 * HOUR)
    );

    let mut one = harness(r#"{"requests":{"1m":1,"1w":2}}"#);
    one.row(T0 - 3.0 * DAY, 0, 0.0, "fast");
    one.preseed("fast");
    admits(one.admit("fast"));
    one.complete(0, 0.0, "fast");
    one.at(T0 + 1_000.0);
    let refused = denied(one.admit("fast"));
    assert_eq!(refused.retry_after_ms, 4.0 * DAY - 1_000.0);
    assert_eq!(
        refused.headroom.requests.map(|r| (r.window, r.reset_at)),
        Some((Window::W1, T0 + 4.0 * DAY))
    );
}

#[test]
fn a_refusals_reset_counts_rows_debited_after_the_seed() {
    let mut h = harness(r#"{"requests":{"5h":2}}"#);
    h.preseed("fast");
    h.at(T0 + HOUR);
    h.complete(0, 0.0, "fast");
    h.at(T0 + 2.0 * HOUR);
    h.complete(0, 0.0, "fast");
    h.at(T0 + 3.0 * HOUR);
    let refused = denied(h.admit("fast"));
    // The oldest debited row (T0 + 1h) ages out 5h later.
    assert_eq!(refused.retry_after_ms, 3.0 * HOUR);
}
