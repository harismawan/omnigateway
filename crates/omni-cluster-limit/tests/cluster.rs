//! Concurrency, seeding and the hot-path budget, on a real server.

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use common::*;
use omni_cluster_limit::{ClusterLimiter, ClusterLimiterOptions};
use serde_json::json;

fn opts(clock: &ManualClock) -> ClusterLimiterOptions {
    ClusterLimiterOptions {
        clock: clock.clock(),
        ..ClusterLimiterOptions::default()
    }
}

/// Many concurrent admissions on one key from two Rust processes (two
/// coordinators, two connections) never admit past a ceiling — and, the
/// script being atomic, admit exactly up to it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_admissions_across_two_clients_never_over_admit() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let (c1, c2) = (
        coord(&db.url, clock.clock()).await,
        coord(&db.url, clock.clock()).await,
    );
    let usage = MemUsage::new();
    let l1 = limiter(&c1, usage.clone(), clock.clock());
    let l2 = limiter(&c2, usage.clone(), clock.clock());

    for (raw, cap) in [
        (r#"{"concurrency":5}"#, 5),
        (r#"{"requests":{"1m":17}}"#, 17),
        (
            r#"{"concurrency":9,"requests":{"1m":7},"models":{"opus":{"concurrency":3}}}"#,
            3,
        ),
    ] {
        flush(&db.url).await;
        let lim = limits(raw);
        let mut tasks = Vec::new();
        for i in 0..120 {
            let l = if i % 2 == 0 { l1.clone() } else { l2.clone() };
            let lim = lim.clone();
            tasks.push(tokio::spawn(async move {
                l.admit("k", &lim, "opus", T0 + 5.0).await
            }));
        }
        let mut held = Vec::new();
        for t in tasks {
            if let Ok(a) = t.await.expect("task") {
                assert!(!a.local, "{raw}: served locally");
                held.push(a);
            }
        }
        assert_eq!(
            held.len(),
            cap,
            "{raw}: admitted {} of cap {cap}",
            held.len()
        );
        drop(held);
    }
    assert_eq!(l1.metrics().verdict_mismatches.load(Ordering::SeqCst), 0);
}

/// TS and Rust admitting on one key at once share one ceiling.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rust_and_ts_admitting_together_share_one_ceiling() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let ts = Ts::spawn(&db.url).await;
    ts.call("reset", json!(["k"])).await;
    let clock = ManualClock::at(T0);
    ts.call("clock", json!([T0])).await;
    let c = coord(&db.url, clock.clock()).await;
    let l = limiter(&c, MemUsage::new(), clock.clock());
    for (raw, cap) in [
        (r#"{"concurrency":4}"#, 4),
        (r#"{"requests":{"1m":11}}"#, 11),
    ] {
        flush(&db.url).await;
        let lim = limits(raw);
        let lim_json: serde_json::Value = serde_json::from_str(raw).expect("json");
        let mut rs = Vec::new();
        let mut tsr = Vec::new();
        for h in 0..40_u64 {
            let l = l.clone();
            let lim = lim.clone();
            rs.push(tokio::spawn(
                async move { l.admit("k", &lim, "m", T0).await },
            ));
            let ts = Arc::clone(&ts);
            let lj = lim_json.clone();
            tsr.push(tokio::spawn(async move {
                ts.call("admit", json!([1000 + h, "k", lj, "m"])).await
            }));
        }
        let mut admitted = 0;
        let mut held = Vec::new();
        for t in rs {
            if let Ok(a) = t.await.expect("task") {
                admitted += 1;
                held.push(a);
            }
        }
        for t in tsr {
            if t.await.expect("task").get("ok").is_some() {
                admitted += 1;
            }
        }
        // TS's per-step claims may refuse a request a concurrent claim was
        // about to give back (over-count, its documented direction); never
        // more than the ceiling.
        assert!(admitted <= cap, "{raw}: {admitted} admitted, cap {cap}");
        assert!(admitted >= 1, "{raw}: nothing admitted");
        for h in 0..40_u64 {
            ts.call("release", json!([1000 + h])).await;
        }
        drop(held);
    }
    ts.close().await;
}

/// `concurrency: 1`, back to back: the release at stream end is ordered
/// before the next admission, so the next request is never refused — even
/// with other traffic flooding the connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrency_one_back_to_back_is_never_refused() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let l = limiter(&c, MemUsage::new(), clock.clock());
    let lim = limits(r#"{"concurrency":1}"#);
    let noise = {
        let l = l.clone();
        let other = limits(r#"{"requests":{"1m":1000000}}"#);
        tokio::spawn(async move {
            loop {
                let mut all = Vec::new();
                for i in 0..16 {
                    let l = l.clone();
                    let o = other.clone();
                    all.push(tokio::spawn(async move {
                        l.admit(&format!("noise{i}"), &o, "m", T0).await.is_ok()
                    }));
                }
                for t in all {
                    assert!(t.await.expect("noise"));
                }
            }
        })
    };
    for round in 0..500 {
        let mut a = l
            .admit("one", &lim, "m", T0)
            .await
            .unwrap_or_else(|e| panic!("round {round}: {e:?}"));
        assert!(!a.local);
        a.release();
    }
    noise.abort();
    // And a second one while the first is held is refused (concurrency).
    let held = l.admit("one", &lim, "m", T0).await.expect("first");
    assert!(l.admit("one", &lim, "m", T0).await.is_err());
    drop(held);
    assert!(l.admit("one", &lim, "m", T0).await.is_ok());
}

/// Unseeded long windows: admitted at once (no store read on the request
/// path), a seed lands in the background under the seed lock, and the next
/// request is judged against it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unseeded_window_admits_and_its_seed_lands() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    for i in 0..3 {
        usage.row("k", "fast", T0 - f64::from(i + 1) * HOUR, 10.0, 0.5);
    }
    // A slow store: the admission must not wait for it.
    usage.delay_ms.store(800, Ordering::SeqCst);
    let l = limiter(&c, usage.clone(), clock.clock());
    let lim = limits(r#"{"requests":{"5h":3}}"#);
    let started = Instant::now();
    let a = l
        .admit("k", &lim, "fast", T0)
        .await
        .expect("admitted unseeded");
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "waited on the store"
    );
    assert_eq!(
        a.unseeded,
        vec![
            ("k".to_owned(), omni_ratelimit::Window::H5),
            ("k".to_owned(), omni_ratelimit::Window::W1)
        ]
    );
    drop(a);
    l.seeds_settled().await;
    let m = l.metrics();
    assert_eq!(m.seeds_installed.load(Ordering::SeqCst), 2);
    let mut conn = admin(&db.url).await;
    let seeded: bool = redis::cmd("HEXISTS")
        .arg("omni:b:lim:k:5h")
        .arg("seeded")
        .query_async(&mut conn)
        .await
        .expect("hexists");
    assert!(seeded);
    // Three rows in the window, ceiling three: refused now.
    let e = l
        .admit("k", &lim, "fast", T0 + 1.0)
        .await
        .expect_err("refused once seeded");
    // The exact reset: the oldest row plus five hours, read from Redis.
    assert!(
        (e.retry_after_ms - (5.0 * HOUR - 3.0 * HOUR - 1.0)).abs() < 1e-6,
        "{}",
        e.retry_after_ms
    );
    // Only the two seeds read the store (one consistent read per window).
    assert_eq!(usage.sums.load(Ordering::SeqCst), 2);
    assert_eq!(usage.calls(), 2);
}

/// The seed lock: a contender waits for the holder and finds its picture;
/// a lock that cannot be taken in time fails the seed (ruling R1 — no
/// tokenless install), leaving the window incomplete and asked again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn seed_lock_contention() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    usage.row("k", "fast", T0 - HOUR, 1.0, 0.0);
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            seed_lock_ms: 600,
            ..opts(&clock)
        },
    );
    let lim = limits(r#"{"requests":{"5h":10}}"#);
    let mut conn = admin(&db.url).await;
    // Another replica holds the 5h seed lock and installs while holding.
    let _: () = redis::cmd("SET")
        .arg("omni:lock:seed:lim:k:5h")
        .arg("other")
        .arg("PX")
        .arg(5_000)
        .query_async(&mut conn)
        .await
        .expect("set");
    let a = l.admit("k", &lim, "fast", T0).await.expect("admit");
    drop(a);
    sleep_ms(200).await;
    // The 1w seed was not contended and is in; the 5h one waits.
    assert_eq!(l.metrics().seeds_installed.load(Ordering::SeqCst), 1);
    // The holder installs a complete picture under its lock, then releases.
    let installed = install_5h(&c, "k", "other", "1:1:", T0 - 5.0 * HOUR).await;
    assert_eq!(installed, redis::Value::Int(1));
    let _: () = redis::cmd("DEL")
        .arg("omni:lock:seed:lim:k:5h")
        .query_async(&mut conn)
        .await
        .expect("del");
    l.seeds_settled().await;
    assert_eq!(
        l.metrics().seeds_already.load(Ordering::SeqCst),
        1,
        "found the holder's picture"
    );
    assert_eq!(
        usage.sums.load(Ordering::SeqCst),
        1,
        "only the 1w window read the store"
    );

    // A lock nobody releases: past the wait the seed fails — it no longer
    // seeds without its lock (ruling R1: such a seed's snapshot, installed
    // later, could miss a row whose debit was ignored meanwhile). The
    // window stays incomplete (admitted, not judged) and is asked again.
    flush(&db.url).await;
    let l2 = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            seed_lock_ms: 300,
            ..opts(&clock)
        },
    );
    let _: () = redis::cmd("SET")
        .arg("omni:lock:seed:lim:k:5h")
        .arg("stuck")
        .arg("PX")
        .arg(60_000)
        .query_async(&mut conn)
        .await
        .expect("set");
    let reads = usage.sums.load(Ordering::SeqCst);
    drop(l2.admit("k", &lim, "fast", T0).await.expect("admit"));
    l2.seeds_settled().await;
    assert_eq!(l2.metrics().seed_lock_unavailable.load(Ordering::SeqCst), 1);
    assert_eq!(l2.metrics().seed_failures.load(Ordering::SeqCst), 1);
    assert_eq!(
        l2.metrics().seeds_installed.load(Ordering::SeqCst),
        1,
        "1w only"
    );
    assert_eq!(
        usage.sums.load(Ordering::SeqCst),
        reads + 1,
        "the 5h seed read nothing"
    );
    let a = l2.admit("k", &lim, "fast", T0).await.expect("admit");
    assert_eq!(
        a.unseeded,
        vec![("k".to_owned(), omni_ratelimit::Window::H5)]
    );
    drop(a);
    let holder: String = redis::cmd("GET")
        .arg("omni:lock:seed:lim:k:5h")
        .query_async(&mut conn)
        .await
        .expect("get");
    assert_eq!(
        holder, "stuck",
        "another holder's lock is never released by us"
    );
}

/// A failing store: admissions still pass, the failure is counted and
/// logged, the window is not asked again before `seed_retry`, and once the
/// store is back the seed lands.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_seed_is_retried_later_and_never_blocks() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    usage.fail.store(true, Ordering::SeqCst);
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            seed_retry: Duration::from_millis(400),
            ..opts(&clock)
        },
    );
    let lim = limits(r#"{"tokens":{"5h":10}}"#);
    for _ in 0..5 {
        drop(l.admit("k", &lim, "m", T0).await.expect("admitted"));
        l.seeds_settled().await;
    }
    assert_eq!(
        l.metrics().seed_failures.load(Ordering::SeqCst),
        2,
        "one per window, not per request"
    );
    usage.fail.store(false, Ordering::SeqCst);
    sleep_ms(450).await;
    let a = l.admit("k", &lim, "m", T0).await.expect("admitted");
    assert_eq!(a.unseeded.len(), 2);
    drop(a);
    l.seeds_settled().await;
    assert_eq!(l.metrics().seeds_installed.load(Ordering::SeqCst), 2);
    assert!(
        l.admit("k", &lim, "m", T0)
            .await
            .expect("seeded")
            .unseeded
            .is_empty()
    );
}

/// "Row first, then the debit": a completion whose row is committed and
/// whose debit is still pending in the batch when a seed reads the store is
/// counted once (by the seed), never twice — the pending debit is flushed
/// to the still-unseeded hash, which ignores it, before the read.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pending_debit_is_not_double_counted_by_a_seed() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            debit_interval: Duration::from_secs(3_600),
            ..opts(&clock)
        },
    );
    let lim = limits(r#"{"requests":{"5h":100}}"#);
    // Admitted while unseeded; its seed is held up by a slow store.
    usage.delay_ms.store(300, Ordering::SeqCst);
    drop(l.admit("k", &lim, "m", T0).await.expect("admit"));
    // Meanwhile another request completes: row committed, debit pending.
    let c1 = usage.row("k", "m", T0, 7.0, 0.0);
    l.debit("k", "m", 7.0, 0.0, T0, &c1);
    l.seeds_settled().await;
    l.flush_debits().await;
    let sum = c
        .remote()
        .buckets_sum("lim:k:5h", 60_000.0, 5.0 * HOUR, T0)
        .await
        .expect("sum")
        .expect("seeded");
    assert_eq!(sum.requests, 1.0, "counted once: {sum:?}");
    assert_eq!(sum.tokens, 7.0);
}

/// A seed that does not install (its store read failed) must not lose the
/// debits made while it ran: here another replica seeds the hash meanwhile,
/// so a debit made during the failed seed must still be applied.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn debits_during_a_seed_that_does_not_install_are_kept() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    usage.fail.store(true, Ordering::SeqCst);
    usage.delay_ms.store(400, Ordering::SeqCst);
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            debit_interval: Duration::from_secs(3_600),
            ..opts(&clock)
        },
    );
    let lim = limits(r#"{"requests":{"5h":100}}"#);
    drop(l.admit("k", &lim, "m", T0).await.expect("admit"));
    sleep_ms(150).await; // the seed is now inside its (failing) store read
    // Another replica installs a complete picture (its read saw no rows),
    // then a request completes here.
    let other = MemUsage::new();
    let b = common::limiter(&c, other, clock.clock());
    assert_eq!(b.preseed_now("k", &lim, T0).await, 0);
    let c1 = usage.row("k", "m", T0, 3.0, 0.0);
    l.debit("k", "m", 3.0, 0.0, T0, &c1);
    l.seeds_settled().await;
    assert_eq!(l.metrics().seed_failures.load(Ordering::SeqCst), 2);
    l.flush_debits().await;
    let sum = c
        .remote()
        .buckets_sum("lim:k:5h", 60_000.0, 5.0 * HOUR, T0)
        .await
        .expect("sum")
        .expect("seeded");
    assert_eq!(
        sum.requests, 1.0,
        "the debit made during the failed seed was lost: {sum:?}"
    );
}

/// Boot and new-key pre-seeding: every subject with a long window, the
/// key-wide one and each override, seeded before traffic.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn preseed_covers_every_subject() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let l = limiter(&c, MemUsage::new(), clock.clock());
    let lim = limits(
        r#"{"requests":{"1w":5},"models":{"a/b":{"spend":{"5h":1}},"c":{"concurrency":1}}}"#,
    );
    assert_eq!(l.preseed("k", &lim), 4);
    assert_eq!(l.preseed("k", &lim), 0, "queued once");
    l.seeds_settled().await;
    let mut conn = admin(&db.url).await;
    let mut keys: Vec<String> = redis::cmd("KEYS")
        .arg("omni:b:*")
        .query_async(&mut conn)
        .await
        .expect("keys");
    keys.sort();
    assert_eq!(
        keys,
        [
            "omni:b:lim:k/m/a%2Fb:1w",
            "omni:b:lim:k/m/a%2Fb:1w:meta",
            "omni:b:lim:k/m/a%2Fb:5h",
            "omni:b:lim:k/m/a%2Fb:5h:meta",
            "omni:b:lim:k:1w",
            "omni:b:lim:k:1w:meta",
            "omni:b:lim:k:5h",
            "omni:b:lim:k:5h:meta"
        ]
    );
    assert!(
        l.admit("k", &lim, "a/b", T0)
            .await
            .expect("ok")
            .unseeded
            .is_empty()
    );
}

/// A slot held past its TTL is renewed (TS `RENEW_INTERVAL_MS`), so a long
/// request keeps its `concurrency: 1` ceiling; once released the key is
/// free, and renewal never resurrects a released slot.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_long_request_keeps_its_slot_by_renewal() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = omni_coord::system_clock();
    let c = coord(&db.url, Arc::clone(&clock)).await;
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        MemUsage::new(),
        ClusterLimiterOptions {
            clock: Arc::clone(&clock),
            gauge_ttl_ms: 400,
            renew_interval: Duration::from_millis(100),
            ..ClusterLimiterOptions::default()
        },
    );
    let one = limits(r#"{"concurrency":1}"#);
    let mut held = l.admit("r", &one, "m", clock()).await.expect("first");
    sleep_ms(1_200).await;
    assert!(
        l.admit("r", &one, "m", clock()).await.is_err(),
        "slot lapsed while held"
    );
    held.release();
    sleep_ms(250).await;
    let again = l
        .admit("r", &one, "m", clock())
        .await
        .expect("free after release");
    drop(again);
}

/// The refusal path never reads the store: a 5h/1w refusal's exact reset
/// comes from Redis-held data inside the one admission call (ruling on D3).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refusals_make_zero_store_calls() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    // Oldest in-window rows: key-wide 3 h ago (fast), the opus override's 2 h ago.
    usage.row("k", "fast", T0 - 3.0 * HOUR, 10.0, 0.5);
    usage.row("k", "opus", T0 - 2.0 * HOUR, 10.0, 0.5);
    usage.row("k", "opus", T0 - HOUR, 10.0, 0.5);
    let l = limiter(&c, usage.clone(), clock.clock());
    let lim = limits(r#"{"requests":{"5h":3,"1w":3},"models":{"opus":{"requests":{"1w":2}}}}"#);
    assert_eq!(l.preseed_now("k", &lim, T0).await, 0);
    let reads = usage.calls();
    for _ in 0..20 {
        let e = l.admit("k", &lim, "opus", T0).await.expect_err("refused");
        // The override's 1w clears last: its oldest row (2 h ago) + 1 w.
        assert!(
            (e.retry_after_ms - (168.0 * HOUR - 2.0 * HOUR)).abs() < 1e-6,
            "{}",
            e.retry_after_ms
        );
        // Key-wide only: its oldest row (3 h ago) + 1 w.
        let e = l.consume("k", &lim, "fast", T0).await.expect_err("refused");
        assert!(
            (e.retry_after_ms - (168.0 * HOUR - 3.0 * HOUR)).abs() < 1e-6,
            "{}",
            e.retry_after_ms
        );
    }
    assert_eq!(usage.calls(), reads, "the refusal path read the store");
}
