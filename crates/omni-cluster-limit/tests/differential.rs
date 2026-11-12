//! Differential: the frozen TS `ApiKeyRateLimiter` over the frozen
//! `redisCoord` (in Bun) and the Rust combined path, on the same server,
//! from identical starting states (one logical database each, both flushed
//! per case), over a generated corpus of window, concurrency, token and
//! spend limits, model overrides, boundary times, releases, consumes and
//! debits. Every step must give the same decision — admitted or refused,
//! `retryAfterMs`, and the headroom the headers render — and every case must
//! leave the same Redis state.
//!
//! The one documented difference is avoided as the spec says: every subject
//! with a long window is pre-seeded before the first assertion (TS seeds
//! inside its first admission, blocking; Rust in the background).
//!
//! State comparison normalizes what is random by design (window members and
//! gauge holder names carry uuids; scores are compared) and leaves out two
//! structures TS writes that the combined path, per the spec, does not:
//! anonymous gauge slots for subjects with no `concurrency` ceiling (TS
//! raises the gauge for every subject; the spec acquires it "only if a
//! concurrency limit is set") and the `omni:gidx:*` snapshot index entries
//! those leave behind. Both are checked separately: every TS gauge key for
//! a subject without a ceiling is empty after its releases.

mod common;

use std::collections::VecDeque;
use std::sync::Arc;

use common::*;
use omni_cluster_limit::{Admission, ClusterLimiter};
use serde_json::{Value, json};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const LIMITS: &[&str] = &[
    r#"{"requests":{"1m":3}}"#,
    r#"{"requests":{"1m":5,"5h":4},"concurrency":2}"#,
    r#"{"tokens":{"5h":500,"1w":2000}}"#,
    r#"{"spend":{"5h":1.5}}"#,
    r#"{"requests":{"1m":2},"models":{"opus":{"requests":{"5h":3},"tokens":{"1w":400}}}}"#,
    r#"{"models":{"opus":{"concurrency":1,"spend":{"1w":2}}}}"#,
    r#"{"requests":{"1m":4,"1w":6},"tokens":{"5h":300},"models":{"opus":{"requests":{"1m":1}}}}"#,
    r#"{"concurrency":1}"#,
    r#"{"concurrency":2,"requests":{"1m":3},"models":{"opus":{"concurrency":1,"requests":{"1m":2}}}}"#,
    r#"{"spend":{"5h":0.75,"1w":3.25},"tokens":{"1m":100,"5h":250}}"#,
    r#"{"requests":{"1m":2,"5h":5,"1w":8},"spend":{"1w":1},"models":{"opus":{"tokens":{"5h":120},"concurrency":2}}}"#,
];

const STEPS: [f64; 7] = [1.0, 1_000.0, 30_000.0, 59_999.0, 60_000.0, 61_000.0, HOUR];

#[allow(clippy::cast_precision_loss)]
fn script(rng: &mut Rng) -> (Vec<Value>, Vec<Value>) {
    let mut history = Vec::new();
    for _ in 0..rng.below(7) {
        history.push(json!({
            "at": T0 - (rng.below(6 * 24) as f64) * HOUR - rng.below(3_600_000) as f64,
            "model": if rng.below(2) == 0 { "fast" } else { "opus" },
            "tokens": rng.below(200),
            "cost": (rng.below(100) as f64) / 100.0,
        }));
    }
    let mut steps = Vec::new();
    let mut clock = T0;
    for _ in 0..30 {
        match rng.below(11) {
            0..=3 => steps.push(json!({ "op": "admit", "model": if rng.below(3) == 0 { "opus" } else { "fast" } })),
            4..=5 => steps.push(json!({ "op": "complete", "tokens": rng.below(150), "cost": (rng.below(80) as f64) / 100.0 })),
            6 => steps.push(json!({ "op": "release" })),
            7 => steps.push(json!({ "op": "consume", "model": if rng.below(2) == 0 { "opus" } else { "fast" } })),
            _ => {
                clock += STEPS[usize::try_from(rng.below(STEPS.len() as u64)).unwrap_or(0)];
                steps.push(json!({ "op": "at", "ms": clock }));
            }
        }
    }
    (history, steps)
}

struct Case {
    limits: String,
    history: Vec<Value>,
    steps: Vec<Value>,
}

/// The fixed cases: boundary behaviour the generator may not reach.
fn fixed() -> Vec<Case> {
    let mut out = Vec::new();
    // A 1m ceiling exactly at the window edge.
    out.push(Case {
        limits: r#"{"requests":{"1m":2}}"#.into(),
        history: vec![],
        steps: serde_json::from_value(json!([
            {"op":"at","ms":T0 + 70_000.0},
            {"op":"admit","model":"fast"},{"op":"admit","model":"fast"},{"op":"admit","model":"fast"},
            {"op":"at","ms":T0 + 129_999.0},{"op":"admit","model":"fast"},
            {"op":"at","ms":T0 + 130_000.0},{"op":"admit","model":"fast"},{"op":"admit","model":"fast"},
            {"op":"at","ms":T0 + 130_001.0},{"op":"admit","model":"fast"}
        ]))
        .expect("steps"),
    });
    // concurrency: 1, back to back: release then admit never refuses.
    let mut steps = vec![json!({"op":"at","ms":T0 + 1.0})];
    for _ in 0..10 {
        steps.push(json!({"op":"admit","model":"fast"}));
        steps.push(json!({"op":"admit","model":"fast"}));
        steps.push(json!({"op":"release"}));
    }
    out.push(Case {
        limits: r#"{"concurrency":1}"#.into(),
        history: vec![],
        steps,
    });
    // A weekly request ceiling reached by history: the exact reset is the
    // oldest row plus a week; spend crossing exactly at the ceiling.
    out.push(Case {
        limits: r#"{"requests":{"1w":3},"spend":{"5h":1}}"#.into(),
        history: serde_json::from_value(json!([
            {"at": T0 - 5.0 * 24.0 * HOUR, "model":"fast","tokens":1,"cost":0.25},
            {"at": T0 - 2.0 * HOUR, "model":"fast","tokens":1,"cost":0.5},
        ]))
        .expect("history"),
        steps: serde_json::from_value(json!([
            {"op":"at","ms":T0 + 10.0},
            {"op":"admit","model":"fast"},
            {"op":"complete","tokens":5,"cost":0.25},
            {"op":"admit","model":"fast"},
            {"op":"consume","model":"fast"},
            {"op":"at","ms":T0 + 2.0 * 24.0 * HOUR + 1.0},
            {"op":"admit","model":"fast"}
        ]))
        .expect("steps"),
    });
    out
}

#[allow(clippy::too_many_lines, clippy::too_many_arguments)]
async fn run_case(
    i: usize,
    case: &Case,
    ts: &Arc<Ts>,
    ts_db: &Db,
    rs_db: &Db,
    rs_coord: &Arc<omni_coord::RedisCoord>,
    clock: &ManualClock,
    counts: &mut (usize, usize),
) {
    flush(&ts_db.url).await;
    flush(&rs_db.url).await;
    let key = "k1";
    ts.call("reset", json!([key])).await;
    clock.set(T0);
    ts.call("clock", json!([T0])).await;
    for h in &case.history {
        ts.call(
            "row",
            json!([key, h["at"], h["model"], h["tokens"], h["cost"]]),
        )
        .await;
    }
    let limits_json: Value = serde_json::from_str(&case.limits).expect("json");
    let limits = limits(&case.limits);
    let usage: Arc<dyn omni_cluster_limit::UsageSource> = Arc::new(AgentUsage(Arc::clone(ts)));
    let rust: ClusterLimiter = common::limiter(rs_coord, usage, clock.clock());

    // Pre-seed (the documented difference): Rust seeds every long window
    // now; TS seeds inside these admissions. Then the same admissions on
    // both, released at once.
    assert_eq!(
        rust.preseed_now(key, &limits, T0).await,
        0,
        "case {i}: preseed"
    );
    let mut handle = 0_u64;
    for m in ["fast", "opus"] {
        handle += 1;
        let t = ts.call("admit", json!([handle, key, limits_json, m])).await;
        let r = rust.admit(key, &limits, m, T0).await;
        assert_eq!(
            js(&t),
            js(&outcome_json(&r, |a: &Admission| headroom_json(
                &a.headroom
            ))),
            "case {i}: pre-seed admission {m}"
        );
        assert!(
            r.as_ref().map_or(true, |a| a.unseeded.is_empty()),
            "case {i}: still unseeded"
        );
        ts.call("release", json!([handle])).await;
        drop(r);
    }

    let mut held: VecDeque<(u64, Option<Admission>)> = VecDeque::new();
    let mut last = "fast".to_owned();
    let mut now = T0;
    for (j, s) in case.steps.iter().enumerate() {
        let what = || format!("case {i} step {j} {s} limits {}", case.limits);
        match s["op"].as_str().expect("op") {
            "at" => {
                now = s["ms"].as_f64().expect("ms");
                clock.set(now);
                ts.call("clock", json!([now])).await;
            }
            "release" => {
                if let Some((h, a)) = held.pop_front() {
                    ts.call("release", json!([h])).await;
                    drop(a);
                }
            }
            "complete" => {
                let (t, c) = (
                    s["tokens"].as_f64().expect("t"),
                    s["cost"].as_f64().expect("c"),
                );
                ts.call("row", json!([key, now, last, t, c])).await;
                ts.call("debit", json!([key, last, t, c])).await;
                rust.debit(key, &last, t, c);
                rust.flush_debits().await;
            }
            op => {
                last = s["model"].as_str().expect("model").to_owned();
                if op == "consume" {
                    let t = ts.call("consume", json!([key, limits_json, last])).await;
                    let r = rust.consume(key, &limits, &last, now).await;
                    let r = outcome_json(&r, |()| json!({}));
                    count(&r, counts);
                    assert_eq!(js(&t), js(&r), "{}", what());
                } else {
                    handle += 1;
                    let t = ts
                        .call("admit", json!([handle, key, limits_json, last]))
                        .await;
                    let r = rust.admit(key, &limits, &last, now).await;
                    let rendered = outcome_json(&r, |a: &Admission| headroom_json(&a.headroom));
                    count(&rendered, counts);
                    assert_eq!(js(&t), js(&rendered), "{}", what());
                    if let Ok(a) = r {
                        assert!(a.unseeded.is_empty() && !a.local, "{}", what());
                        held.push_back((handle, Some(a)));
                    }
                }
            }
        }
    }
    // Mid-case state, slots still held: windows, gauges of ceilinged
    // subjects, buckets.
    compare_state(i, "held", ts_db, rs_db, rs_coord, ts).await;
    while let Some((h, a)) = held.pop_front() {
        ts.call("release", json!([h])).await;
        drop(a);
    }
    compare_state(i, "released", ts_db, rs_db, rs_coord, ts).await;
    let m = rust.metrics();
    assert_eq!(
        m.verdict_mismatches
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "case {i}: script verdict disagreed"
    );
    assert_eq!(
        m.local_admissions.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "case {i}: fell back to local"
    );
    assert_eq!(
        m.debit_buckets_lost
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "case {i}: debits lost"
    );
    rust.shutdown().await;
}

fn count(v: &Value, counts: &mut (usize, usize)) {
    if v.get("refused").is_some() {
        counts.0 += 1;
    } else {
        counts.1 += 1;
    }
}

/// Gauge keys of subjects TS raised anonymously (no ceiling): their slot
/// members are uuids, never a holder name we know — told apart by being
/// absent on the Rust side.
async fn compare_state(
    i: usize,
    when: &str,
    ts_db: &Db,
    rs_db: &Db,
    rs_coord: &Arc<omni_coord::RedisCoord>,
    ts: &Arc<Ts>,
) {
    // Everything queued (detached releases, TS's `void` calls) has run.
    ts.call("sync", json!([])).await;
    let _pinged = rs_coord.remote().query(redis::cmd("PING")).await.is_ok();
    let skip = |k: &str| k.starts_with("omni:gidx:") || k.starts_with("omni:lock:");
    let t = dump(&ts_db.url, &skip).await;
    let r = dump(&rs_db.url, &skip).await;
    for (k, v) in &t {
        if k.starts_with("omni:g:") && !r.contains_key(k) {
            // An anonymous TS slot (no ceiling on this subject): allowed
            // while held, never after release.
            assert_ne!(
                when, "released",
                "case {i}: TS gauge {k} left {v} after release"
            );
            continue;
        }
        assert_eq!(Some(v), r.get(k), "case {i} ({when}): key {k}");
    }
    for (k, v) in &r {
        assert!(
            t.contains_key(k),
            "case {i} ({when}): Rust-only key {k} = {v}"
        );
    }
}

/// Batched debits leave exactly what TS's per-debit `BUCKETS_ADD` calls
/// leave: many debits per (bucket, start), across minute and hour
/// boundaries, costs that do not sum exactly in binary, flushed rarely.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn batched_debits_equal_per_debit_calls() {
    let Some(base) = redis_base() else { return };
    let ts_db = fresh_db(&base).await;
    let rs_db = fresh_db(&base).await;
    let ts = Ts::spawn(&ts_db.url).await;
    let clock = ManualClock::at(T0);
    let rs_coord = coord(&rs_db.url, clock.clock()).await;
    let key = "kd";
    let raw =
        r#"{"tokens":{"5h":100000},"spend":{"1w":5000},"models":{"opus":{"spend":{"5h":900}}}}"#;
    let limits_json: Value = serde_json::from_str(raw).expect("json");
    let limits = limits(raw);
    ts.call("reset", json!([key])).await;
    ts.call("clock", json!([T0])).await;
    ts.call("row", json!([key, T0 - HOUR, "opus", 10, 0.1]))
        .await;
    let usage: Arc<dyn omni_cluster_limit::UsageSource> = Arc::new(AgentUsage(Arc::clone(&ts)));
    let rust = common::limiter(&rs_coord, usage, clock.clock());
    assert_eq!(rust.preseed_now(key, &limits, T0).await, 0);
    for (h, m) in [(1, "fast"), (2, "opus")] {
        ts.call("admit", json!([h, key, limits_json, m])).await;
        ts.call("release", json!([h])).await;
        drop(rust.admit(key, &limits, m, T0).await.expect("admitted"));
    }
    let mut rng = Rng(0x1234_5678_9abc_def1);
    let costs = [0.1, 0.2, 0.3, 0.7, 1e-7, 0.015, 1.0 / 3.0, 2.675, 0.0];
    let mut now = T0;
    for i in 0..400 {
        if rng.below(5) == 0 {
            #[allow(clippy::cast_precision_loss)]
            {
                now += [7_000.0, 59_999.0, 60_000.0, 1_800_000.0]
                    [usize::try_from(rng.below(4)).unwrap_or(0)];
            }
            clock.set(now);
            ts.call("clock", json!([now])).await;
        }
        let model = if rng.below(2) == 0 { "opus" } else { "fast" };
        let tokens = rng.below(5_000);
        let cost = costs[usize::try_from(rng.below(costs.len() as u64)).unwrap_or(0)];
        ts.call("debit", json!([key, model, tokens, cost])).await;
        #[allow(clippy::cast_precision_loss)]
        rust.debit(key, model, tokens as f64, cost);
        if i % 97 == 96 {
            rust.flush_debits().await;
        }
    }
    rust.flush_debits().await;
    let m = rust.metrics();
    assert!(
        m.debit_batches.load(std::sync::atomic::Ordering::SeqCst) <= 8,
        "batched"
    );
    assert_eq!(
        m.debit_buckets_lost
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    compare_state(0, "released", &ts_db, &rs_db, &rs_coord, &ts).await;
    rust.shutdown().await;
    ts.close().await;
    rs_coord.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn decisions_and_state_equal_the_frozen_ts_limiter() {
    let Some(base) = redis_base() else { return };
    let ts_db = fresh_db(&base).await;
    let rs_db = fresh_db(&base).await;
    let ts = Ts::spawn(&ts_db.url).await;
    let clock = ManualClock::at(T0);
    let rs_coord = coord(&rs_db.url, clock.clock()).await;

    let mut cases = fixed();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let n: usize = std::env::var("OMNI_D3_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(160);
    for k in 0..n {
        let (history, steps) = script(&mut rng);
        cases.push(Case {
            limits: LIMITS[k % LIMITS.len()].to_owned(),
            history,
            steps,
        });
    }
    let mut counts = (0, 0);
    for (i, case) in cases.iter().enumerate() {
        run_case(i, case, &ts, &ts_db, &rs_db, &rs_coord, &clock, &mut counts).await;
    }
    eprintln!(
        "differential: {} cases, {} refusals, {} admissions",
        cases.len(),
        counts.0,
        counts.1
    );
    assert!(
        counts.0 > 150 && counts.1 > 400,
        "corpus too thin: {counts:?}"
    );
    ts.close().await;
    rs_coord.shutdown().await;
}
