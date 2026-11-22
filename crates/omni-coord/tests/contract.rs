//! Contract tests for `Coord`: the one suite every implementation
//! runs. Each test runs against `MemoryCoord`, and against `RedisCoord` on a
//! freshly flushed logical database when `OMNI_TEST_REDIS_URL` names a server
//! (skipped with a note otherwise).
//!
//! `make` receives a clock; the Redis implementation expires `kv`, leases and
//! locks against the server's clock, so those tests also sleep out real time.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{ManualClock, T0, fresh_db, redis_base, sleep_ms};
use futures_util::future::join_all;
use omni_coord::{
    Coord, CoordError, Counts, MemoryCoord, RedisCoord, RedisCoordOptions, WindowCounter, with_lock,
};

/// The coordinator, and the database lease it runs on (Redis only).
type Made = (Box<dyn Coord>, Option<common::Db>);

async fn memory(clock: &ManualClock) -> Option<Made> {
    Some((Box::new(MemoryCoord::new(clock.clock())), None))
}

async fn redis(clock: &ManualClock) -> Option<Made> {
    let Some(base) = redis_base() else {
        eprintln!("skipped: set OMNI_TEST_REDIS_URL to run the redis contract");
        return None;
    };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(
        &db.url,
        RedisCoordOptions {
            now: clock.clock(),
            ..RedisCoordOptions::default()
        },
    )
    .await
    .expect("connect");
    assert!(coord.healthy(), "redis contract needs a reachable server");
    Some((Box::new(coord), Some(db)))
}

macro_rules! contract {
    ($($name:ident),* $(,)?) => {
        mod memory_contract {
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                async fn $name() {
                    let clock = super::ManualClock::at(super::T0);
                    if let Some((coord, _db)) = super::memory(&clock).await {
                        super::$name(coord.as_ref(), &clock).await;
                    }
                }
            )*
        }
        mod redis_contract {
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                async fn $name() {
                    let clock = super::ManualClock::at(super::T0);
                    if let Some((coord, _db)) = super::redis(&clock).await {
                        super::$name(coord.as_ref(), &clock).await;
                    }
                }
            )*
        }
    };
}

contract!(
    window_claim_reports_what_was_held_before_it,
    window_ages_a_stamp_out_at_exactly_the_window,
    window_rollback_gives_back_exactly_one_stamp,
    concurrent_window_claims_see_each_other,
    gauge_counts_acquisitions_and_never_goes_negative,
    concurrent_gauge_acquisitions_see_each_other,
    gauge_snapshot_lists_every_held_key_under_a_prefix,
    mutex_serialises_holders_of_one_key,
    mutex_gives_up_after_wait,
    mutex_releases_on_error_and_on_panic,
    kv_holds_a_value_for_its_ttl_and_not_past_it,
    kv_del_and_del_prefix_remove_exactly_what_they_name,
    buckets_sum_live_buckets_and_drop_the_aged_edge,
    buckets_seed_replaces_and_is_then_added_to,
    lease_is_held_by_one_holder_until_it_lapses_or_is_released,
    pubsub_delivers_to_exact_and_pattern_subscribers,
    incr_is_monotonic_from_1,
    a_gauge_slot_lapses_at_its_ttl,
    a_named_gauge_slot_renews_stays_single_and_is_never_resurrected,
    a_blank_holder_is_refused,
    snapshot_honours_a_prefix_narrower_than_the_key_index,
    named_and_unnamed_slots_coexist_on_one_key,
    a_holder_whose_slot_lapsed_reacquires_beside_live_rivals,
    publish_sequenced_numbers_deliveries_in_one_step,
);

fn wc(used: f64, reset_at: f64) -> WindowCounter {
    WindowCounter { used, reset_at }
}

fn counts(requests: f64, tokens: f64, cost_usd: f64) -> Counts {
    Counts {
        requests,
        tokens,
        cost_usd,
    }
}

async fn window_claim_reports_what_was_held_before_it(c: &dyn Coord, _: &ManualClock) {
    let a = c.window_claim("k", 60_000.0, T0).await;
    let b = c.window_claim("k", 60_000.0, T0 + 1.0).await;
    assert_eq!(a.before, wc(0.0, T0));
    assert_eq!(a.stamp, T0);
    assert_eq!(b.before, wc(1.0, T0 + 60_000.0));
}

async fn window_ages_a_stamp_out_at_exactly_the_window(c: &dyn Coord, _: &ManualClock) {
    c.window_claim("k", 60_000.0, T0).await;
    let later = c.window_claim("k", 60_000.0, T0 + 60_000.0).await;
    assert_eq!(later.before.used, 0.0);
}

async fn window_rollback_gives_back_exactly_one_stamp(c: &dyn Coord, _: &ManualClock) {
    let first = c.window_claim("k", 60_000.0, T0).await;
    c.window_claim("k", 60_000.0, T0 + 1.0).await;
    c.window_rollback("k", first.stamp).await;
    assert_eq!(
        c.window_claim("k", 60_000.0, T0 + 2.0).await.before.used,
        1.0
    );
    // A stamp already given back is silently nothing: exactly one goes.
    c.window_rollback("k", first.stamp).await;
    assert_eq!(
        c.window_claim("k", 60_000.0, T0 + 3.0).await.before.used,
        2.0
    );
}

/// The seam: ten claims issued without awaiting between them each see the
/// ones before.
async fn concurrent_window_claims_see_each_other(c: &dyn Coord, _: &ManualClock) {
    let claims = join_all((0..10).map(|_| c.window_claim("k", 60_000.0, T0))).await;
    let mut seen: Vec<f64> = claims.iter().map(|c| c.before.used).collect();
    seen.sort_by(f64::total_cmp);
    assert_eq!(seen, (0..10).map(f64::from).collect::<Vec<_>>());
}

async fn gauge_counts_acquisitions_and_never_goes_negative(c: &dyn Coord, _: &ManualClock) {
    assert_eq!(c.gauge_acquire("g", 1_000, None).await, Ok(0));
    assert_eq!(c.gauge_acquire("g", 1_000, None).await, Ok(1));
    assert_eq!(c.gauge_read("g").await, 2);
    for _ in 0..3 {
        c.gauge_release("g", None).await.expect("release");
    }
    assert_eq!(c.gauge_read("g").await, 0);
    assert_eq!(c.gauge_read("never").await, 0);
}

async fn concurrent_gauge_acquisitions_see_each_other(c: &dyn Coord, _: &ManualClock) {
    let before = join_all((0..10).map(|_| c.gauge_acquire("g", 1_000, None))).await;
    let mut before: Vec<u64> = before.into_iter().map(|r| r.expect("acquire")).collect();
    before.sort_unstable();
    assert_eq!(before, (0..10).collect::<Vec<u64>>());
}

async fn gauge_snapshot_lists_every_held_key_under_a_prefix(c: &dyn Coord, _: &ManualClock) {
    for key in ["load:a", "load:a", "load:b", "other:c"] {
        c.gauge_acquire(key, 1_000, None).await.expect("acquire");
    }
    c.gauge_release("load:b", None).await.expect("release");
    let snap = c.gauge_snapshot("load:").await;
    assert_eq!(
        snap.into_iter().collect::<Vec<_>>(),
        vec![("load:a".to_owned(), 2)]
    );
}

async fn mutex_serialises_holders_of_one_key(c: &dyn Coord, _: &ManualClock) {
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let (entered_tx, entered) = tokio::sync::oneshot::channel::<()>();
    let push = |s| order.lock().expect("order").push(s);
    let first = with_lock(c, "m", 1_000, Duration::from_secs(1), || async {
        push("first:in");
        entered_tx.send(()).expect("entered");
        held.await.expect("released");
        push("first:out");
    });
    let second = async {
        entered.await.expect("entered");
        with_lock(c, "m", 1_000, Duration::from_secs(1), || async {
            push("second:in");
        })
        .await
    };
    let releaser = async {
        // Let the second contend, then let the first finish.
        sleep_ms(30).await;
        release.send(()).expect("release");
    };
    let (a, b, ()) = tokio::join!(first, second, releaser);
    a.expect("first");
    b.expect("second");
    assert_eq!(
        *order.lock().expect("order"),
        vec!["first:in", "first:out", "second:in"]
    );
}

async fn mutex_gives_up_after_wait(c: &dyn Coord, _: &ManualClock) {
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let (entered_tx, entered) = tokio::sync::oneshot::channel::<()>();
    let first = with_lock(c, "m", 10_000, Duration::from_secs(10), || async {
        entered_tx.send(()).expect("entered");
        held.await.expect("released");
    });
    let contender = async {
        entered.await.expect("entered");
        let refused = with_lock(c, "m", 10_000, Duration::from_millis(20), || async { "x" }).await;
        assert_eq!(refused, Err(CoordError::LockUnavailable("m".to_owned())));
        assert!(
            refused
                .expect_err("refused")
                .to_string()
                .starts_with("LOCK_UNAVAILABLE")
        );
        release.send(()).expect("release");
    };
    let (out, ()) = tokio::join!(first, contender);
    out.expect("first");
    let again = with_lock(c, "m", 10_000, Duration::from_millis(20), || async { "x" }).await;
    assert_eq!(again, Ok("x"));
}

async fn mutex_releases_on_error_and_on_panic(c: &dyn Coord, _: &ManualClock) {
    let failed: Result<Result<(), &str>, CoordError> =
        with_lock(c, "m", 1_000, Duration::from_secs(1), || async {
            Err("boom")
        })
        .await;
    assert_eq!(failed, Ok(Err("boom")));
    assert_eq!(
        with_lock(c, "m", 1_000, Duration::from_millis(20), || async { 1 }).await,
        Ok(1)
    );
    // A body that panics, caught: the lock is released (detached) on unwind.
    let caught = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(with_lock(
        c,
        "m",
        5_000,
        Duration::from_secs(1),
        || async { panic!("body panicked") },
    )))
    .await;
    assert!(caught.is_err());
    // A cancelled holder (the future dropped mid-body) also releases.
    let cancelled = tokio::time::timeout(
        Duration::from_millis(20),
        with_lock(c, "m", 5_000, Duration::from_secs(1), || {
            std::future::pending::<()>()
        }),
    )
    .await;
    assert!(cancelled.is_err());
    assert_eq!(
        with_lock(c, "m", 5_000, Duration::from_millis(200), || async { 2 }).await,
        Ok(2)
    );
}

async fn kv_holds_a_value_for_its_ttl_and_not_past_it(c: &dyn Coord, clock: &ManualClock) {
    c.kv_set("s", "v", 200).await.expect("set");
    assert_eq!(c.kv_get("s").await, Ok(Some("v".to_owned())));
    clock.advance(100.0);
    sleep_ms(100).await;
    assert_eq!(c.kv_get("s").await, Ok(Some("v".to_owned())));
    clock.advance(100.0);
    sleep_ms(150).await;
    assert_eq!(c.kv_get("s").await, Ok(None));
}

async fn kv_del_and_del_prefix_remove_exactly_what_they_name(c: &dyn Coord, _: &ManualClock) {
    for (k, v) in [
        ("sess:admin:1", "a"),
        ("sess:admin:2", "b"),
        ("sess:viewer:1", "c"),
        ("other:1", "d"),
    ] {
        c.kv_set(k, v, 10_000).await.expect("set");
    }
    c.kv_del("sess:admin:1").await.expect("del");
    assert_eq!(c.kv_get("sess:admin:1").await, Ok(None));
    c.kv_del_prefix("sess:admin:").await.expect("del prefix");
    assert_eq!(c.kv_get("sess:admin:2").await, Ok(None));
    assert_eq!(c.kv_get("sess:viewer:1").await, Ok(Some("c".to_owned())));
    c.kv_del_prefix("sess:").await.expect("del prefix");
    assert_eq!(c.kv_get("sess:viewer:1").await, Ok(None));
    assert_eq!(c.kv_get("other:1").await, Ok(Some("d".to_owned())));
}

async fn buckets_sum_live_buckets_and_drop_the_aged_edge(c: &dyn Coord, _: &ManualClock) {
    let one = counts(1.0, 10.0, 0.5);
    let (g, w) = (60_000.0, 300_000.0);
    assert_eq!(c.buckets_sum("b", g, w, T0).await, None);
    // An unseeded key ignores adds and stays unseeded.
    c.buckets_add("b", g, w, T0, one).await;
    assert_eq!(c.buckets_sum("b", g, w, T0).await, None);
    c.buckets_seed("b", g, w, T0, &[]).await;
    c.buckets_add("b", g, w, T0, one).await;
    c.buckets_add("b", g, w, T0 + 30_000.0, one).await;
    c.buckets_add("b", g, w, T0 + 120_000.0, one).await;
    assert_eq!(
        c.buckets_sum("b", g, w, T0 + 120_000.0).await,
        Some(counts(3.0, 30.0, 1.5))
    );
    // The first bucket leaves once the window's oldest bucket start passes it.
    assert_eq!(
        c.buckets_sum("b", g, w, T0 + 360_000.0)
            .await
            .map(|s| s.requests),
        Some(1.0)
    );
}

async fn buckets_seed_replaces_and_is_then_added_to(c: &dyn Coord, _: &ManualClock) {
    let one = counts(1.0, 1.0, 1.0);
    let (g, w) = (60_000.0, 300_000.0);
    c.buckets_seed("b", g, w, T0, &[]).await;
    c.buckets_add("b", g, w, T0, one).await;
    c.buckets_seed(
        "b",
        g,
        w,
        T0,
        &[
            (T0 - 120_000.0, counts(5.0, 5.0, 5.0)),
            (T0 - 900_000.0, counts(99.0, 99.0, 99.0)),
        ],
    )
    .await;
    c.buckets_add("b", g, w, T0, one).await;
    assert_eq!(
        c.buckets_sum("b", g, w, T0).await.map(|s| s.requests),
        Some(6.0)
    );
}

async fn lease_is_held_by_one_holder_until_it_lapses_or_is_released(
    c: &dyn Coord,
    clock: &ManualClock,
) {
    assert!(c.lease_acquire("job", "a", 1_000).await);
    assert!(!c.lease_acquire("job", "b", 1_000).await);
    // The holder may renew.
    assert!(c.lease_acquire("job", "a", 1_000).await);
    // A non-holder's release is nothing.
    c.lease_release("job", "b").await;
    assert!(!c.lease_acquire("job", "b", 1_000).await);
    c.lease_release("job", "a").await;
    assert!(c.lease_acquire("job", "b", 50).await);
    clock.advance(51.0);
    sleep_ms(51).await;
    assert!(c.lease_acquire("job", "a", 1_000).await);
}

/// Logical databases do not isolate pub/sub, so every topic here is unique
/// to the test run (`common::unique`).
async fn pubsub_delivers_to_exact_and_pattern_subscribers(c: &dyn Coord, _: &ManualClock) {
    let res = common::unique("res");
    let console = common::unique("console");
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let s1 = Arc::clone(&seen);
    let off_exact = c.subscribe(
        &res,
        Arc::new(move |t, p| s1.lock().expect("seen").push(format!("exact:{t}:{p}"))),
    );
    let s2 = Arc::clone(&seen);
    let off_pattern = c.subscribe(
        &format!("{console}:*"),
        Arc::new(move |t, p| s2.lock().expect("seen").push(format!("pattern:{t}:{p}"))),
    );
    c.publish(&res, "1").await;
    c.publish(&format!("{console}:node-a"), "2").await;
    c.publish(&common::unique("other"), "3").await;
    sleep_ms(50).await;
    off_exact.unsubscribe();
    c.publish(&res, "4").await;
    sleep_ms(50).await;
    drop(off_pattern);
    let mut got = seen.lock().expect("seen").clone();
    got.sort();
    let mut want = vec![
        format!("exact:{res}:1"),
        format!("pattern:{console}:node-a:2"),
    ];
    want.sort();
    assert_eq!(got, want);
}

async fn incr_is_monotonic_from_1(c: &dyn Coord, _: &ManualClock) {
    assert_eq!(c.incr("seq").await, 1);
    assert_eq!(c.incr("seq").await, 2);
    assert_eq!(c.incr("other").await, 1);
}

async fn a_gauge_slot_lapses_at_its_ttl(c: &dyn Coord, clock: &ManualClock) {
    assert_eq!(c.gauge_acquire("g", 50, None).await, Ok(0));
    assert_eq!(c.gauge_read("g").await, 1);
    clock.advance(60.0);
    sleep_ms(60).await;
    assert_eq!(c.gauge_read("g").await, 0);
    assert_eq!(c.gauge_acquire("g", 50, None).await, Ok(0));
}

async fn a_named_gauge_slot_renews_stays_single_and_is_never_resurrected(
    c: &dyn Coord,
    clock: &ManualClock,
) {
    assert_eq!(c.gauge_acquire("g", 100, Some("a")).await, Ok(0));
    // Same name: moves the expiry, never adds a slot, not its own rival.
    assert_eq!(c.gauge_acquire("g", 100, Some("a")).await, Ok(0));
    assert_eq!(c.gauge_read("g").await, 1);
    // Renewed twice inside the TTL, read past the ORIGINAL expiry.
    for _ in 0..2 {
        clock.advance(60.0);
        sleep_ms(60).await;
        c.gauge_renew("g", "a", 100).await.expect("renew");
    }
    assert_eq!(c.gauge_read("g").await, 1);
    assert_eq!(c.gauge_acquire("g", 100, Some("b")).await, Ok(1));
    c.gauge_release("g", Some("a")).await.expect("release");
    assert_eq!(c.gauge_read("g").await, 1);
    // Renewing the released name adds nothing back.
    c.gauge_renew("g", "a", 100).await.expect("renew");
    assert_eq!(c.gauge_read("g").await, 1);
    c.gauge_release("g", Some("b")).await.expect("release");
    assert_eq!(c.gauge_read("g").await, 0);
}

async fn a_blank_holder_is_refused(c: &dyn Coord, _: &ManualClock) {
    assert_eq!(
        c.gauge_acquire("g", 1_000, Some("")).await,
        Err(CoordError::BlankHolder)
    );
    assert_eq!(
        c.gauge_renew("g", "", 1_000).await,
        Err(CoordError::BlankHolder)
    );
    assert_eq!(
        c.gauge_release("g", Some("")).await,
        Err(CoordError::BlankHolder)
    );
    assert_eq!(c.gauge_read("g").await, 0);
}

async fn snapshot_honours_a_prefix_narrower_than_the_key_index(c: &dyn Coord, _: &ManualClock) {
    c.gauge_acquire("load:a", 1_000, None).await.expect("a");
    c.gauge_acquire("load:b", 1_000, None).await.expect("b");
    let narrow: Vec<_> = c.gauge_snapshot("load:a").await.into_iter().collect();
    assert_eq!(narrow, vec![("load:a".to_owned(), 1)]);
    let wide: Vec<_> = c.gauge_snapshot("load:").await.into_iter().collect();
    assert_eq!(
        wide,
        vec![("load:a".to_owned(), 1), ("load:b".to_owned(), 1)]
    );
}

async fn named_and_unnamed_slots_coexist_on_one_key(c: &dyn Coord, clock: &ManualClock) {
    c.gauge_acquire("g", 50, None).await.expect("unnamed");
    c.gauge_acquire("g", 10_000, Some("mine"))
        .await
        .expect("named");
    assert_eq!(c.gauge_read("g").await, 2);
    // The unnamed release takes the slot nearest its expiry.
    c.gauge_release("g", None).await.expect("release");
    assert_eq!(c.gauge_read("g").await, 1);
    clock.advance(60.0);
    sleep_ms(60).await;
    c.gauge_renew("g", "mine", 10_000).await.expect("renew");
    assert_eq!(c.gauge_read("g").await, 1);
    c.gauge_release("g", Some("mine")).await.expect("release");
    assert_eq!(c.gauge_read("g").await, 0);
}

async fn a_holder_whose_slot_lapsed_reacquires_beside_live_rivals(
    c: &dyn Coord,
    clock: &ManualClock,
) {
    c.gauge_acquire("g", 10_000, Some("rival"))
        .await
        .expect("rival");
    c.gauge_acquire("g", 50, Some("mine")).await.expect("mine");
    assert_eq!(c.gauge_read("g").await, 2);
    clock.advance(60.0);
    sleep_ms(60).await;
    assert_eq!(c.gauge_read("g").await, 1);
    assert_eq!(c.gauge_acquire("g", 10_000, Some("mine")).await, Ok(1));
    assert_eq!(c.gauge_read("g").await, 2);
}

async fn publish_sequenced_numbers_deliveries_in_one_step(c: &dyn Coord, _: &ManualClock) {
    let topic = common::unique("s");
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let s = Arc::clone(&seen);
    let off = c.subscribe(
        &topic,
        Arc::new(move |_, p| s.lock().expect("seen").push(p.to_owned())),
    );
    assert_eq!(c.publish_sequenced(&topic, "a", "seq:s").await, 1);
    assert_eq!(c.publish_sequenced(&topic, "b", "seq:s").await, 2);
    sleep_ms(50).await;
    drop(off);
    assert_eq!(*seen.lock().expect("seen"), vec!["1:a", "2:b"]);
}
