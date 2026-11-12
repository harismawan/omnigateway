//! Fix round 1 (review `d3-review.md`, rulings I1/I2, I3, I5): seeding is
//! one atomic install with a commit watermark, debits skip what a seed
//! counted on any replica, storage is bounded, shutdown resolves seeds and
//! held debits, and TS's per-debit float arithmetic is kept. RED evidence
//! for each (the reviewer's repros, on `18cbb555`):
//! `/tmp/opencode/d3-fix1/red-18cbb555.log`.

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use common::*;
use omni_cluster_limit::{ClusterLimiter, ClusterLimiterOptions};

fn opts(clock: &ManualClock) -> ClusterLimiterOptions {
    ClusterLimiterOptions {
        clock: clock.clock(),
        ..ClusterLimiterOptions::default()
    }
}

fn slow_flush(clock: &ManualClock) -> ClusterLimiterOptions {
    ClusterLimiterOptions {
        debit_interval: Duration::from_secs(3_600),
        ..opts(clock)
    }
}

async fn requests_5h(c: &omni_coord::RedisCoord, key: &str) -> f64 {
    c.remote()
        .buckets_sum(&format!("lim:{key}:5h"), 60_000.0, 5.0 * HOUR, T0)
        .await
        .expect("sum")
        .expect("seeded")
        .requests
}

/// I1 (the reviewer's repro): A holds a pending debit for a committed row;
/// the buckets are dropped (lost-debit reseed) and B — another replica —
/// seeds, reading that row; A flushes. The row counts once, and a
/// `requests/5h: 2` key is not refused with one completed row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pending_debit_is_not_counted_again_after_another_replicas_seed() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let (ca, cb) = (
        coord(&db.url, clock.clock()).await,
        coord(&db.url, clock.clock()).await,
    );
    let usage = MemUsage::new();
    let a = ClusterLimiter::new(Arc::clone(&ca), usage.clone(), slow_flush(&clock));
    let b = ClusterLimiter::new(Arc::clone(&cb), usage.clone(), slow_flush(&clock));
    let lim = limits(r#"{"requests":{"5h":2}}"#);
    drop(a.admit("k", &lim, "m", T0).await.expect("A admits"));
    a.seeds_settled().await;
    let commit = usage.row("k", "m", T0, 1.0, 0.0);
    a.debit("k", "m", 1.0, 0.0, T0, &commit);
    let mut conn = admin(&db.url).await;
    let _: () = redis::cmd("DEL")
        .arg("omni:b:lim:k:5h")
        .arg("omni:b:lim:k:1w")
        .query_async(&mut conn)
        .await
        .expect("del");
    assert_eq!(b.preseed_now("k", &lim, T0).await, 0);
    a.flush_debits().await;
    assert_eq!(requests_5h(&ca, "k").await, 1.0, "one row counted twice");
    assert_eq!(
        a.metrics().debit_runs_covered.load(Ordering::SeqCst),
        2,
        "5h and 1w skipped"
    );
    assert!(b.admit("k", &lim, "m", T0).await.is_ok());
    // A row committed after B's read is still added.
    let later = usage.row("k", "m", T0, 1.0, 0.0);
    a.debit("k", "m", 1.0, 0.0, T0, &later);
    a.flush_debits().await;
    assert_eq!(requests_5h(&ca, "k").await, 2.0);
}

/// I1 with a barrier: B's seed is held between its store read and its
/// install (lock held, picture incomplete) while A commits a row after B's
/// snapshot and debits it — and another row before it. A's flush meanwhile
/// waits (kept, not ignored, not applied); after B installs, the row B saw
/// is skipped and the row it did not see is added. Exactly two.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn debits_racing_another_replicas_seed_count_exactly_once() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let (ca, cb) = (
        coord(&db.url, clock.clock()).await,
        coord(&db.url, clock.clock()).await,
    );
    let usage = MemUsage::new();
    let a = ClusterLimiter::new(Arc::clone(&ca), usage.clone(), slow_flush(&clock));
    let b = ClusterLimiter::new(Arc::clone(&cb), usage.clone(), slow_flush(&clock));
    let lim = limits(r#"{"requests":{"5h":10}}"#);
    a.record_override("k", &lim, "m");
    drop(
        a.admit("k", &lim, "m", T0)
            .await
            .expect("A admits (unseeded)"),
    );
    // A's own seed would race; settle it first, then drop the picture.
    a.seeds_settled().await;
    let mut conn = admin(&db.url).await;
    let _: () = redis::cmd("DEL")
        .arg("omni:b:lim:k:5h")
        .arg("omni:b:lim:k:5h:meta")
        .arg("omni:b:lim:k:1w")
        .arg("omni:b:lim:k:1w:meta")
        .query_async(&mut conn)
        .await
        .expect("del");
    let seen = usage.row("k", "m", T0, 1.0, 0.0);
    a.debit("k", "m", 1.0, 0.0, T0, &seen);
    let (entered, release) = usage.gate();
    let entered_now = entered.notified();
    let bseed = {
        let b = b.clone();
        let lim = lim.clone();
        tokio::spawn(async move { b.preseed_now("k", &lim, T0).await })
    };
    entered_now.await; // B has taken its snapshot and holds the lock
    let unseen = usage.row("k", "m", T0, 1.0, 0.0);
    a.debit("k", "m", 1.0, 0.0, T0, &unseen);
    a.flush_debits().await;
    assert!(a.metrics().debit_buckets_waiting.load(Ordering::SeqCst) >= 1);
    assert!(a.debits_pending().0 >= 1, "the waiting debit was dropped");
    release.add_permits(2); // 5h, then 1w
    assert_eq!(bseed.await.expect("task"), 0);
    a.flush_debits().await;
    assert_eq!(requests_5h(&ca, "k").await, 2.0);
    assert_eq!(a.debits_pending().0, 0);
}

/// I2 (the reviewer's repro): a counts hash without its companion — what
/// TS's `BUCKETS_SEED` alone leaves, or a lost companion — is never judged
/// as complete (TS's reset, not `now + window`), and a seed replaces it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn counts_without_their_metadata_are_never_a_complete_picture() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    usage.row("k", "m", T0 - 4.0 * HOUR, 1.0, 0.0);
    let l = ClusterLimiter::new(Arc::clone(&c), usage.clone(), opts(&clock));
    let lim = limits(r#"{"requests":{"5h":1}}"#);
    for (name, g, w) in [
        ("lim:k:5h", 60_000.0, 5.0 * HOUR),
        ("lim:k:1w", HOUR, 168.0 * HOUR),
    ] {
        let rows = vec![(
            ((T0 - 4.0 * HOUR) / g).floor() * g,
            omni_coord::Counts {
                requests: 1.0,
                tokens: 1.0,
                cost_usd: 0.0,
            },
        )];
        c.remote()
            .buckets_seed(name, g, w, T0, &rows)
            .await
            .expect("TS seed, counts only");
    }
    let a = l
        .admit("k", &lim, "m", T0)
        .await
        .expect("incomplete: not judged");
    assert_eq!(a.unseeded.len(), 2);
    drop(a);
    l.seeds_settled().await;
    let e = l.admit("k", &lim, "m", T0).await.expect_err("complete now");
    assert!(
        (e.retry_after_ms - HOUR).abs() < 1e-6,
        "{} vs TS {}",
        e.retry_after_ms,
        HOUR
    );
}

/// I2: the install is one step — at no instant does a reader find counts
/// without metadata. Admissions hammer the key while seeds install over and
/// over; every refusal's reset is TS's (never `now + window`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_admission_ever_sees_a_half_installed_seed() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    usage.row("k", "m", T0 - 4.0 * HOUR, 1.0, 0.0);
    let l = ClusterLimiter::new(Arc::clone(&c), usage.clone(), opts(&clock));
    let lim = limits(r#"{"requests":{"5h":1}}"#);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hammer = {
        let (l, lim, stop) = (l.clone(), lim.clone(), Arc::clone(&stop));
        tokio::spawn(async move {
            let (mut refused, mut unseeded) = (0, 0);
            while !stop.load(Ordering::SeqCst) {
                match l.admit("k", &lim, "m", T0).await {
                    Err(e) => {
                        assert!(
                            (e.retry_after_ms - HOUR).abs() < 1e-6,
                            "{}",
                            e.retry_after_ms
                        );
                        refused += 1;
                    }
                    Ok(a) => {
                        // Admitted only while a window is incomplete (never
                        // judged half-installed): one row is in both
                        // windows, so a complete 5h always refuses.
                        assert!(
                            a.unseeded
                                .iter()
                                .any(|(_, w)| *w == omni_ratelimit::Window::H5),
                            "admitted against a complete 5h picture"
                        );
                        unseeded += 1;
                    }
                }
            }
            (refused, unseeded)
        })
    };
    let mut conn = admin(&db.url).await;
    for _ in 0..40 {
        let _: () = redis::cmd("DEL")
            .arg("omni:b:lim:k:5h")
            .arg("omni:b:lim:k:5h:meta")
            .arg("omni:b:lim:k:1w")
            .arg("omni:b:lim:k:1w:meta")
            .query_async(&mut conn)
            .await
            .expect("del");
        l.preseed_now("k", &lim, T0).await;
    }
    stop.store(true, Ordering::SeqCst);
    let (refused, unseeded) = hammer.await.expect("hammer");
    assert!(
        refused > 0 && unseeded > 0,
        "{refused} refused, {unseeded} unseeded"
    );
}

/// I2: a failed install leaves nothing a reader could judge, and the retry
/// installs. The install is refused as a whole (here: the lock was taken
/// over while the read ran, so the install answers "lock lost") — and
/// held debits are then queued again, not double counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_install_leaves_no_picture_and_the_retry_completes_it() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    usage.row("k", "m", T0 - HOUR, 1.0, 0.0);
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            seed_retry: Duration::from_millis(100),
            ..slow_flush(&clock)
        },
    );
    let lim = limits(r#"{"requests":{"5h":10}}"#);
    let (entered, release) = usage.gate();
    let first = entered.notified();
    drop(l.admit("k", &lim, "m", T0).await.expect("admit"));
    first.await;
    // While the seed reads, its lock is taken over by someone else.
    let mut conn = admin(&db.url).await;
    let _: () = redis::cmd("SET")
        .arg("omni:lock:seed:lim:k:5h")
        .arg("someone-else")
        .arg("PX")
        .arg(60_000)
        .query_async(&mut conn)
        .await
        .expect("steal");
    let commit = usage.row("k", "m", T0, 1.0, 0.0);
    l.debit("k", "m", 1.0, 0.0, T0, &commit);
    release.add_permits(2);
    l.seeds_settled().await;
    assert!(l.metrics().seed_failures.load(Ordering::SeqCst) >= 1);
    let exists: bool = redis::cmd("EXISTS")
        .arg("omni:b:lim:k:5h")
        .query_async(&mut conn)
        .await
        .expect("exists");
    assert!(!exists, "a failed install wrote counts");
    // The pending debit waits on the (stolen, held) lock and is kept.
    l.flush_debits().await;
    assert!(l.debits_pending().0 >= 1);
    let _: () = redis::cmd("DEL")
        .arg("omni:lock:seed:lim:k:5h")
        .query_async(&mut conn)
        .await
        .expect("unlock");
    *usage.gate.lock().expect("gate") = None;
    sleep_ms(150).await;
    drop(l.admit("k", &lim, "m", T0).await.expect("admit"));
    l.seeds_settled().await;
    l.flush_debits().await;
    // The seed read both rows; the debit (its commit seen) is skipped.
    assert_eq!(requests_5h(&c, "k").await, 2.0);
    assert_eq!(l.debits_pending().0, 0);
}

/// I3 (the reviewer's repro): a hung store read cannot grow held debits
/// past the bound — overflow is counted lost and arms the reseed — and
/// `shutdown` returns promptly, cancelling the seed, releasing its lock and
/// accounting for every pending debit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hung_seed_is_bounded_and_shutdown_resolves_it() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let (entered, _never) = usage.gate();
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            debit_queue: 1,
            usage_timeout: Duration::from_secs(3_600),
            ..slow_flush(&clock)
        },
    );
    let lim = limits(r#"{"requests":{"5h":100}}"#);
    let inside = entered.notified();
    drop(l.admit("k", &lim, "m", T0).await.expect("admit"));
    inside.await;
    for i in 0..100 {
        let commit = usage.row("k", "m", T0 + f64::from(i), 1.0, 0.0);
        l.debit("k", "m", 1.0, 0.0, T0 + f64::from(i), &commit);
    }
    let m = l.metrics();
    let (entries, bytes) = l.debits_pending();
    assert!(entries <= 1 && bytes > 0, "{entries} entries");
    assert!(
        m.debit_buckets_lost.load(Ordering::SeqCst) >= 99,
        "{}",
        m.debit_buckets_lost.load(Ordering::SeqCst)
    );
    let t = Instant::now();
    tokio::time::timeout(Duration::from_secs(3), l.shutdown())
        .await
        .expect("shutdown returned");
    assert!(t.elapsed() < Duration::from_secs(3));
    assert_eq!(l.debits_pending().0, 0, "debits left unaccounted");
    let mut conn = admin(&db.url).await;
    sleep_ms(100).await;
    let held: bool = redis::cmd("EXISTS")
        .arg("omni:lock:seed:lim:k:5h")
        .query_async(&mut conn)
        .await
        .expect("exists");
    assert!(!held, "the cancelled seed kept its lock");
}

/// I3: shutdown with debits waiting on another replica's install keeps
/// them for `shutdown_drain`, delivers them if the install lands in time,
/// and otherwise counts them lost (reseed armed) — never drops them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_delivers_or_accounts_for_held_debits() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let lim = limits(r#"{"requests":{"5h":10}}"#);
    let mut conn = admin(&db.url).await;
    for (deliver, drain_ms) in [(true, 2_000_u64), (false, 200)] {
        flush(&db.url).await;
        let l = ClusterLimiter::new(
            Arc::clone(&c),
            usage.clone(),
            ClusterLimiterOptions {
                shutdown_drain: Duration::from_millis(drain_ms),
                ..slow_flush(&clock)
            },
        );
        l.record_override("k", &lim, "m");
        drop(l.admit("k", &lim, "m", T0).await.expect("admit"));
        l.seeds_settled().await;
        let _: () = redis::cmd("DEL")
            .arg("omni:b:lim:k:5h")
            .arg("omni:b:lim:k:5h:meta")
            .query_async(&mut conn)
            .await
            .expect("del");
        // Another replica is "installing": it holds the seed lock.
        let _: () = redis::cmd("SET")
            .arg("omni:lock:seed:lim:k:5h")
            .arg("other")
            .arg("PX")
            .arg(60_000)
            .query_async(&mut conn)
            .await
            .expect("lock");
        let commit = usage.row("k", "m", T0, 1.0, 0.0);
        l.debit("k", "m", 1.0, 0.0, T0, &commit);
        let lost_before = l.metrics().debit_buckets_lost.load(Ordering::SeqCst);
        let other = {
            let c = Arc::clone(&c);
            let usage = usage.clone();
            let lim = lim.clone();
            let clock = clock.clone();
            let url = db.url.clone();
            tokio::spawn(async move {
                sleep_ms(300).await;
                if deliver {
                    let mut conn = admin(&url).await;
                    let _: () = redis::cmd("DEL")
                        .arg("omni:lock:seed:lim:k:5h")
                        .query_async(&mut conn)
                        .await
                        .expect("unlock");
                    // An install whose snapshot predates the row.
                    let b = common::limiter(&c, Arc::new(Snapshot0(usage)), clock.clock());
                    b.preseed_now("k", &lim, T0).await;
                }
            })
        };
        l.shutdown().await;
        other.await.expect("other");
        let lost = l.metrics().debit_buckets_lost.load(Ordering::SeqCst) - lost_before;
        if deliver {
            assert_eq!(lost, 0, "delivered in time");
            assert_eq!(
                requests_5h(&c, "k").await,
                1.0,
                "the held debit landed once"
            );
        } else {
            assert!(lost >= 1, "a held debit vanished without being counted");
        }
        assert_eq!(l.debits_pending().0, 0);
        let _: () = redis::cmd("DEL")
            .arg("omni:lock:seed:lim:k:5h")
            .query_async(&mut conn)
            .await
            .expect("unlock");
    }
}

/// A store whose seed reads saw nothing: no rows, a snapshot taken before
/// every commit (so every debit is added after it).
struct Snapshot0(#[allow(dead_code)] Arc<MemUsage>);

#[async_trait::async_trait]
impl omni_cluster_limit::UsageSource for Snapshot0 {
    async fn seed_read(
        &self,
        _key_id: &str,
        _since_ms: f64,
        _grain_ms: f64,
        _model: Option<&str>,
    ) -> Result<omni_cluster_limit::SeedRead, String> {
        Ok(omni_cluster_limit::SeedRead {
            snapshot: "1:1:".to_owned(),
            ..Default::default()
        })
    }
}

/// I3: every store read has a deadline: a hung read fails the seed (and
/// releases its lock) instead of holding a worker forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hung_store_read_times_out() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let (_entered, _never) = usage.gate();
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            usage_timeout: Duration::from_millis(300),
            ..opts(&clock)
        },
    );
    let lim = limits(r#"{"requests":{"5h":100}}"#);
    drop(l.admit("k", &lim, "m", T0).await.expect("admit"));
    tokio::time::timeout(Duration::from_secs(3), l.seeds_settled())
        .await
        .expect("seeds settled");
    assert_eq!(l.metrics().seed_failures.load(Ordering::SeqCst), 2);
    let mut conn = admin(&db.url).await;
    let held: bool = redis::cmd("EXISTS")
        .arg("omni:lock:seed:lim:k:5h")
        .query_async(&mut conn)
        .await
        .expect("exists");
    assert!(!held);
    l.shutdown().await;
}

/// I5 (the reviewer's repro, against frozen TS): 10,000 debits of 0.1 in
/// one entry. TS's 10,000 `HINCRBYFLOAT`s store `999.99999999999991296`,
/// read back as `1000`, so a `spend/5h` ceiling of `1000.0000000001`
/// admits; the bucket hashes must be byte-identical.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ten_thousand_costs_in_one_entry_equal_ts() {
    let Some(base) = redis_base() else { return };
    let ts_db = fresh_db(&base).await;
    let rs_db = fresh_db(&base).await;
    let ts = Ts::spawn(&ts_db.url).await;
    let clock = ManualClock::at(T0);
    let rs = coord(&rs_db.url, clock.clock()).await;
    let raw = r#"{"spend":{"5h":1000.0000000001}}"#;
    let lim_json: serde_json::Value = serde_json::from_str(raw).expect("json");
    let lim = limits(raw);
    ts.call("reset", serde_json::json!(["k"])).await;
    ts.call("clock", serde_json::json!([T0])).await;
    let usage: Arc<dyn omni_cluster_limit::UsageSource> = Arc::new(AgentUsage(Arc::clone(&ts)));
    let l = ClusterLimiter::new(Arc::clone(&rs), usage, slow_flush(&clock));
    assert_eq!(l.preseed_now("k", &lim, T0).await, 0);
    ts.call("admit", serde_json::json!([1, "k", lim_json, "m"]))
        .await;
    ts.call("release", serde_json::json!([1])).await;
    drop(l.admit("k", &lim, "m", T0).await.expect("admit"));
    for _ in 0..10_000 {
        ts.call("debitNoSync", serde_json::json!(["k", "m", 0, 0.1]))
            .await;
        l.debit("k", "m", 0.0, 0.1, T0, "");
    }
    ts.call("sync", serde_json::json!([])).await;
    l.flush_debits().await;
    let field = format!("{}:c", ((T0 / 60_000.0).floor() * 60_000.0) as i64);
    let get = |url: String| {
        let field = field.clone();
        async move {
            let mut conn = admin(&url).await;
            let v: String = redis::cmd("HGET")
                .arg("omni:b:lim:k:5h")
                .arg(&field)
                .query_async(&mut conn)
                .await
                .expect("hget");
            v
        }
    };
    let (t, r) = (get(ts_db.url.clone()).await, get(rs_db.url.clone()).await);
    assert_eq!(t, "999.99999999999991296", "TS's own value");
    assert_eq!(r, t, "Rust's stored float differs from TS's");
    let tdec = ts
        .call("admit", serde_json::json!([2, "k", lim_json, "m"]))
        .await;
    assert!(tdec.get("ok").is_some(), "TS admits: {tdec}");
    assert!(
        l.admit("k", &lim, "m", T0).await.is_ok(),
        "Rust refused where TS admits"
    );
    l.shutdown().await;
    ts.close().await;
}

/// Minor: an admission cancelled after its script was written leaves no
/// named concurrency slot (the cleanup guard gives it back).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_admission_after_write_leaves_no_slot() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let l = ClusterLimiter::new(Arc::clone(&c), MemUsage::new(), opts(&clock));
    let one = limits(r#"{"concurrency":1}"#);
    // Prime the connection (scripts loaded) before pausing writes.
    drop(l.admit("warm", &one, "m", T0).await.expect("warm"));
    let mut conn = admin(&db.url).await;
    let _: () = redis::cmd("CLIENT")
        .arg("PAUSE")
        .arg(10_000)
        .arg("WRITE")
        .query_async(&mut conn)
        .await
        .expect("pause");
    let cancelled =
        tokio::time::timeout(Duration::from_millis(150), l.admit("p", &one, "m", T0)).await;
    assert!(cancelled.is_err(), "admission finished during the pause");
    let _: () = redis::cmd("CLIENT")
        .arg("UNPAUSE")
        .query_async(&mut conn)
        .await
        .expect("unpause");
    // The script and then its cleanup run, in order.
    let _pinged = c.remote().query(redis::cmd("PING")).await.is_ok();
    let live: i64 = redis::cmd("ZCARD")
        .arg("omni:g:p")
        .query_async(&mut conn)
        .await
        .expect("zcard");
    assert_eq!(live, 0, "the cancelled admission's slot is held");
    assert!(l.admit("p", &one, "m", T0).await.is_ok());
}

/// The commit test the debit script applies is Postgres
/// `pg_visible_in_snapshot` exactly. Expected values recorded from
/// PostgreSQL 17.11 (`/tmp/opencode/d3-fix1/pg-visible.log`) for the
/// snapshot `5:9:6,7`: 4 t, 5 t, 6 f, 7 f, 8 t, 9 f, 10 f — plus an unknown
/// commit (`''`), which is never skipped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_snapshot_test_is_pg_visible_in_snapshot() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let keys = [
        "omni:b:lim:k:5h".to_owned(),
        "omni:b:lim:k:5h:meta".to_owned(),
        "omni:lock:seed:lim:k:5h".to_owned(),
    ];
    let installed = c
        .remote()
        .eval(
            &omni_cluster_limit::scripts::SEED_INSTALL,
            &keys,
            &[
                String::new(),
                "36000000".into(),
                "5:9:6,7".into(),
                "60000".into(),
                "1".into(),
                "seeded".into(),
                "1".into(),
            ],
        )
        .await
        .expect("install");
    assert_eq!(installed, redis::Value::Int(1));
    for (commit, visible) in [
        ("4", true),
        ("5", true),
        ("6", false),
        ("7", false),
        ("8", true),
        ("9", false),
        ("10", false),
        ("", false),
    ] {
        let args: Vec<String> = [
            "1700000000000",
            "60000",
            "18000000",
            "1",
            commit,
            "1",
            "0",
            "1",
            "1700000000000",
            "1700000000000",
            "1",
            "0",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let out = c
            .remote()
            .eval(&omni_cluster_limit::scripts::DEBIT_BATCH, &keys, &args)
            .await
            .expect("debit");
        let expected = if visible { [0, 1] } else { [1, 0] };
        assert_eq!(
            out,
            redis::Value::Array(vec![redis::Value::Array(vec![
                redis::Value::Int(expected[0]),
                redis::Value::Int(expected[1])
            ])]),
            "commit {commit:?}"
        );
    }
}
