//! Fix round 2 (review `d3-r1-review.md`, ruling R1): rows a seed did not
//! count are added; shutdown and cancelled flushes lose nothing silently;
//! rejected debits retain nothing. The reviewer's repros, RED on `c1ec4e81`:
//! `/tmp/opencode/d3-fix2/red-c1ec4e81-final-tests.log`.

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use common::*;
use omni_cluster_limit::{ClusterLimiter, ClusterLimiterOptions};

fn slow(clock: &ManualClock) -> ClusterLimiterOptions {
    ClusterLimiterOptions {
        clock: clock.clock(),
        debit_interval: Duration::from_secs(3_600),
        ..ClusterLimiterOptions::default()
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

/// R1: a long stream started 6 h before it completes (row `at` = T−6h,
/// outside the 5h seed filter) in commit c. B reseeds after the commit (c
/// visible, row not counted). A flushes: TS's BUCKETS_ADD adds one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_visible_but_filtered_row_is_added() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let (ca, cb) = (
        coord(&db.url, clock.clock()).await,
        coord(&db.url, clock.clock()).await,
    );
    let usage = MemUsage::new();
    let a = ClusterLimiter::new(Arc::clone(&ca), usage.clone(), slow(&clock));
    let b = ClusterLimiter::new(Arc::clone(&cb), usage.clone(), slow(&clock));
    let lim = limits(r#"{"requests":{"5h":1}}"#);
    a.record_override("k", &lim, "m");
    drop(
        a.admit("k", &lim, "m", T0 - 6.0 * HOUR)
            .await
            .expect("admit"),
    );
    a.seeds_settled().await;
    let commit = usage.row("k", "m", T0 - 6.0 * HOUR, 1.0, 0.0);
    a.debit("k", "m", 1.0, 0.0, T0 - 6.0 * HOUR, &commit);
    let mut conn = admin(&db.url).await;
    let _: () = redis::cmd("DEL")
        .arg("omni:b:lim:k:5h")
        .arg("omni:b:lim:k:5h:meta")
        .arg("omni:b:lim:k:1w")
        .arg("omni:b:lim:k:1w:meta")
        .query_async(&mut conn)
        .await
        .expect("del");
    assert_eq!(b.preseed_now("k", &lim, T0).await, 0);
    a.flush_debits().await;
    assert_eq!(
        requests_5h(&ca, "k").await,
        1.0,
        "TS BUCKETS_ADD counts the completion"
    );
    assert!(
        b.admit("k", &lim, "m", T0).await.is_err(),
        "TS refuses the next request"
    );
}

/// R1 (tokenless fallback, the reviewer's interleaving): a seed that could
/// not take its lock must not read and install anyway. Another holder keeps
/// the 5h lock past the seed's wait; then the lock disappears and a later
/// row commits and is debited while the picture is incomplete with no lock
/// (TS: ignored). On `c1ec4e81` the lock-less seed had taken its snapshot
/// before that commit and then installed it with an empty token, so the
/// row was lost for the life of the picture. Now the seed takes no
/// snapshot without its lock: it fails, nothing is installed, and the next
/// seed (under its lock) reads the row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_tokenless_install_does_not_lose_a_later_row() {
    let Some(base) = redis_base() else { return };
    // Its lock wait is timed: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            seed_lock_ms: 200,
            ..slow(&clock)
        },
    );
    // Every subject seeds both long windows; only the 5h lock is held.
    let lim = limits(r#"{"models":{"m":{"requests":{"5h":10}}}}"#);
    l.record_override("k", &lim, "m");
    hold_lock_5h(&db.url, "k/m/m", "other").await;
    let reads0 = usage.sums.load(Ordering::SeqCst);
    // The 5h seed waits its 200 ms for the lock, then gives up; the 1w seed
    // (its own lock) installs.
    let failed = l.preseed_now("k", &lim, T0).await;
    assert_eq!(failed, 1, "the 5h seed without its lock succeeded");
    assert_eq!(
        usage.sums.load(Ordering::SeqCst),
        reads0 + 1,
        "only the 1w seed may read: the 5h seed without its lock read the store \
         (a snapshot it could install later)"
    );
    let mut conn = admin(&db.url).await;
    let _: () = redis::cmd("DEL")
        .arg("omni:lock:seed:lim:k/m/m:5h")
        .query_async(&mut conn)
        .await
        .expect("lock gone");
    // A later row: committed and debited while the picture is incomplete
    // and no lock is held — ignored (TS's unseeded buckets).
    let commit = usage.row("k", "m", T0, 1.0, 0.0);
    l.debit("k", "m", 1.0, 0.0, T0, &commit);
    l.flush_debits().await;
    assert_eq!(l.metrics().debit_buckets_unseeded.load(Ordering::SeqCst), 1);
    // Nothing was installed meanwhile; the next seed reads the row.
    let exists: bool = redis::cmd("EXISTS")
        .arg("omni:b:lim:k/m/m:5h:meta")
        .query_async(&mut conn)
        .await
        .expect("exists");
    assert!(!exists, "a picture was installed without its lock");
    assert_eq!(l.preseed_now("k", &lim, T0).await, 0);
    let n = c
        .remote()
        .buckets_sum("lim:k/m/m:5h", 60_000.0, 5.0 * HOUR, T0)
        .await
        .expect("sum")
        .expect("seeded")
        .requests;
    assert_eq!(n, 1.0, "the later row was lost or doubled");
    // And the install script itself refuses an empty token.
    let _: () = redis::cmd("DEL")
        .arg("omni:b:lim:k/m/m:5h")
        .arg("omni:b:lim:k/m/m:5h:meta")
        .query_async(&mut conn)
        .await
        .expect("del");
    assert_eq!(
        install_5h(&c, "k/m/m", "", "1:1:", T0 - 5.0 * HOUR).await,
        redis::Value::Int(-1),
        "SEED_INSTALL accepted an empty token"
    );
}

/// R2: shutdown while the flusher is awaiting its first send (writes held
/// with CLIENT PAUSE WRITE) must not silently drop the rest of the batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r2_shutdown_mid_flush_accounts_for_everything() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            clock: clock.clock(),
            debit_interval: Duration::from_millis(50),
            debit_batch_keys: 1,
            ..ClusterLimiterOptions::default()
        },
    );
    let lim = limits(r#"{"requests":{"5h":100}}"#);
    let keys = ["k0", "k1", "k2", "k3"];
    for k in keys {
        assert_eq!(l.preseed_now(k, &lim, T0).await, 0);
        drop(l.admit(k, &lim, "m", T0).await.expect("admit"));
    }
    let paused = Paused::start(&db.url, 10_000).await;
    for k in keys {
        let commit = usage.row(k, "m", T0, 1.0, 0.0);
        l.debit(k, "m", 1.0, 0.0, T0, &commit);
    }
    let batches = l.metrics().debit_batches.load(Ordering::SeqCst);
    let t = tokio::time::Instant::now();
    while l.metrics().debit_batches.load(Ordering::SeqCst) == batches {
        assert!(
            t.elapsed() < Duration::from_secs(3),
            "flusher never started"
        );
        tokio::task::yield_now().await;
    }
    let sd = {
        let l = l.clone();
        tokio::spawn(async move { l.shutdown().await })
    };
    sleep_ms(200).await;
    paused.end().await;
    sd.await.expect("shutdown");
    let mut counted = 0.0;
    for k in keys {
        counted += requests_5h(&c, k).await;
    }
    let lost = l.metrics().debit_buckets_lost.load(Ordering::SeqCst);
    // 4 keys × 2 windows = 8 entries; the flusher was stopped after the
    // send it was awaiting, the rest went back and the drain delivered
    // them. Every one applied, or (only the uncertain one) counted lost.
    assert!(
        counted == 4.0 || (counted >= 3.0 && lost > 0),
        "silently dropped: {counted} of 4 applied (5h), lost {lost}"
    );
    assert_eq!(l.debits_pending().0, 0);
}

/// R3 (the reviewer's repro): repeated rejected additions to one entry
/// must leave no retained, uncharged range. Each rejected debit carries a
/// distinct row-time bucket; afterwards the accounted bytes must equal what
/// a fresh accounting of the retained entries gives (`debits_audit`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r3_rejected_debits_retain_nothing() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        MemUsage::new(),
        ClusterLimiterOptions {
            debit_bytes: 1_000,
            ..slow(&clock)
        },
    );
    let lim = limits(r#"{"models":{"m":{"requests":{"5h":100}}}}"#);
    l.record_override("k", &lim, "m");
    l.record_override("f", &lim, "m");
    l.debit("k", "m", 1.0, 0.0, T0, "7");
    l.debit("k", "m", 1.0, 0.0, T0, "7");
    let mut i = 0;
    loop {
        let before = l.debits_pending();
        l.debit("f", "m", 1.0, 0.0, T0, &format!("{}", 100 + i));
        i += 1;
        if l.debits_pending() == before || i > 100 {
            break;
        }
    }
    let lost0 = l.metrics().debit_buckets_lost.load(Ordering::SeqCst);
    for j in 0..200 {
        l.debit("k", "m", 1.0, 0.0, T0 - f64::from(j + 1) * 120_000.0, "7");
    }
    let lost = l.metrics().debit_buckets_lost.load(Ordering::SeqCst) - lost0;
    assert!(lost > 0, "the cap was never reached");
    let (_, after) = l.debits_pending();
    let retained = l.debits_audit();
    assert_eq!(
        after, retained,
        "charged {after} bytes, retaining {retained}"
    );
    assert!(
        retained <= 1_000,
        "retained {retained} past the 1000-byte cap"
    );
}

/// Minor: shutdown between a job's reservation and its task leaves
/// seeds_settled() able to return.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn m_seeds_settled_returns_after_shutdown() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let (_e, _never) = usage.gate();
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            usage_timeout: Duration::from_secs(3_600),
            ..slow(&clock)
        },
    );
    // 6 seeds: 4 run (PARALLEL), 2 reserved waiting on the semaphore.
    for k in ["a", "b", "c"] {
        let lim = limits(r#"{"requests":{"5h":100}}"#);
        drop(l.admit(k, &lim, "m", T0).await.expect("admit"));
    }
    sleep_ms(300).await;
    l.shutdown().await;
    tokio::time::timeout(Duration::from_secs(3), l.seeds_settled())
        .await
        .expect("seeds_settled hung after shutdown");
}

/// R1: one writer transaction holding a row inside the seed's selection and
/// a long stream's row before it (mixed ages, one commit). The seed counted
/// the first only; flushing both debits must add exactly the second.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_one_commit_spanning_the_boundary_is_split_by_row() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let (ca, cb) = (
        coord(&db.url, clock.clock()).await,
        coord(&db.url, clock.clock()).await,
    );
    let usage = MemUsage::new();
    let a = ClusterLimiter::new(Arc::clone(&ca), usage.clone(), slow(&clock));
    let b = ClusterLimiter::new(Arc::clone(&cb), usage.clone(), slow(&clock));
    let lim = limits(r#"{"spend":{"5h":100}}"#);
    a.record_override("k", &lim, "m");
    drop(a.admit("k", &lim, "m", T0).await.expect("admit"));
    a.seeds_settled().await;
    // One commit: a request started 1 h ago and one started 6 h ago.
    let commit = usage.rows_in_one_commit(&[
        ("k", "m", T0 - HOUR, 3.0, 0.25),
        ("k", "m", T0 - 6.0 * HOUR, 5.0, 0.5),
    ]);
    a.debit("k", "m", 3.0, 0.25, T0 - HOUR, &commit);
    a.debit("k", "m", 5.0, 0.5, T0 - 6.0 * HOUR, &commit);
    let mut conn = admin(&db.url).await;
    let _: () = redis::cmd("DEL")
        .arg("omni:b:lim:k:5h")
        .arg("omni:b:lim:k:5h:meta")
        .arg("omni:b:lim:k:1w")
        .arg("omni:b:lim:k:1w:meta")
        .query_async(&mut conn)
        .await
        .expect("del");
    assert_eq!(b.preseed_now("k", &lim, T0).await, 0);
    a.flush_debits().await;
    let s5 = ca
        .remote()
        .buckets_sum("lim:k:5h", 60_000.0, 5.0 * HOUR, T0)
        .await
        .expect("sum")
        .expect("seeded");
    // Seed: the 1 h row (1 request, 3 tokens, 0.25). Debits: the 6 h row
    // added at T0's bucket (TS BUCKETS_ADD); the 1 h row skipped.
    assert_eq!((s5.requests, s5.tokens, s5.cost_usd), (2.0, 8.0, 0.75));
    // The 1w seed counted both rows; both debits are skipped there.
    let s1 = ca
        .remote()
        .buckets_sum("lim:k:1w", HOUR, 168.0 * HOUR, T0)
        .await
        .expect("sum")
        .expect("seeded");
    assert_eq!((s1.requests, s1.tokens, s1.cost_usd), (2.0, 8.0, 0.75));
    assert_eq!(a.metrics().debit_rows_applied.load(Ordering::SeqCst), 1);
    assert_eq!(a.metrics().debit_rows_covered.load(Ordering::SeqCst), 3);
}

/// R2: a cancelled `flush_debits` (writes held with CLIENT PAUSE WRITE, the
/// caller gives up) puts back what it had not sent and counts what was in
/// flight as lost; after the pause, a flush delivers the rest.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r2_a_cancelled_flush_puts_back_what_it_did_not_send() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let l = ClusterLimiter::new(
        Arc::clone(&c),
        usage.clone(),
        ClusterLimiterOptions {
            debit_batch_keys: 1,
            ..slow(&clock)
        },
    );
    let lim = limits(r#"{"requests":{"5h":100}}"#);
    let keys = ["k0", "k1", "k2", "k3"];
    for k in keys {
        assert_eq!(l.preseed_now(k, &lim, T0).await, 0);
        drop(l.admit(k, &lim, "m", T0).await.expect("admit"));
        let commit = usage.row(k, "m", T0, 1.0, 0.0);
        l.debit(k, "m", 1.0, 0.0, T0, &commit);
    }
    assert_eq!(l.debits_pending().0, 8);
    let paused = Paused::start(&db.url, 10_000).await;
    let cancelled = tokio::time::timeout(Duration::from_millis(200), l.flush_debits()).await;
    assert!(cancelled.is_err(), "the flush finished during the pause");
    let lost = l.metrics().debit_buckets_lost.load(Ordering::SeqCst);
    assert_eq!(
        lost, 1,
        "the one in-flight entry is uncertain: counted lost"
    );
    assert_eq!(l.debits_pending().0, 7, "unsent entries put back");
    paused.end().await;
    l.flush_debits().await;
    assert_eq!(
        l.debits_pending().0,
        0,
        "the put-back entries were delivered"
    );
    // The uncertain one armed TS's lost-debit reseed: the next successful
    // call dropped every bucket hash; a reseed rereads all four rows. Each
    // key then counts its one row exactly once.
    let _synced = c.remote().query(redis::cmd("PING")).await.is_ok();
    sleep_ms(100).await;
    for k in keys {
        assert_eq!(l.preseed_now(k, &lim, T0).await, 0);
        assert_eq!(requests_5h(&c, k).await, 1.0, "{k}");
    }
}
