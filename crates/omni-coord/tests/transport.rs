//! The command transport's ordering, boundedness and recovery guarantees
//! (D2 fix round 1, review items I1 and I2), against a real server and a TCP
//! proxy the test controls.
//!
//! Serialised: some of these stall or flush the shared server.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{Proxy, fresh_db, host_port, redis_base, sleep_ms};
use omni_coord::redis::scripts;
use omni_coord::redis::{Fault, Refused};
use omni_coord::{Coord, RedisCoord, RedisCoordOptions, with_lock};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn opts(command_timeout_ms: u64) -> RedisCoordOptions {
    RedisCoordOptions {
        command_timeout: Duration::from_millis(command_timeout_ms),
        fault_log_interval: Duration::ZERO,
        ..RedisCoordOptions::default()
    }
}

async fn script_flush(url: &str) {
    let mut conn = common::admin(url).await;
    let _: () = redis::cmd("SCRIPT")
        .arg("FLUSH")
        .query_async(&mut conn)
        .await
        .expect("script flush");
}

/// I1, cache-miss variant: the server lost its scripts; a detached release
/// is issued, then — after it returns — an acquire on a `concurrency: 1`
/// gauge. The acquire must see the slot already released, every time.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_detached_release_after_script_flush_lands_before_the_next_acquire() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(2_000))
        .await
        .expect("connect");
    let mut wrong = Vec::new();
    for round in 0..40 {
        let key = format!("lim:{round}");
        assert_eq!(
            coord
                .remote()
                .gauge_acquire(&key, 0.0, 60_000, Some("a"))
                .await,
            Ok(0)
        );
        script_flush(&db.url).await;
        coord
            .remote()
            .eval_detached(
                &scripts::GAUGE_RELEASE,
                &[omni_coord::redis::key("g", &key)],
                &["0".to_owned(), "a".to_owned()],
                true,
            )
            .expect("queued");
        let before = coord
            .remote()
            .gauge_acquire(&key, 0.0, 60_000, Some("b"))
            .await;
        if before != Ok(0) {
            wrong.push((round, before));
        }
    }
    assert!(wrong.is_empty(), "acquire overtook the release: {wrong:?}");
    coord.close();
}

/// I2: only the established command socket goes silent — open, nothing
/// forwarded — while new connections to the same endpoint work. Calls must
/// move to a fresh connection within a bounded time.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_blackholed_command_socket_is_retired_and_replaced() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let proxy = Proxy::start(&host_port(&base)).await;
    let url = format!("redis://127.0.0.1:{}/{}", proxy.port, db.index);
    let coord = RedisCoord::connect(
        &url,
        RedisCoordOptions {
            heartbeat: Duration::from_millis(100),
            ..opts(200)
        },
    )
    .await
    .expect("connect");
    assert_eq!(coord.remote().incr("n").await, Ok(1));
    let hellos = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let h = Arc::clone(&hellos);
    let _hello = coord.subscribe(
        omni_coord::RECONNECTED_TOPIC,
        Arc::new(move |_, _| {
            h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }),
    );
    let before = proxy.connections();
    assert!(before >= 2, "command + pub/sub through the proxy");
    proxy.freeze_existing();

    let started = Instant::now();
    let mut recovered = None;
    while started.elapsed() < Duration::from_secs(5) {
        if let Ok(n) = coord.remote().incr("n").await {
            recovered = Some((n, started.elapsed()));
            break;
        }
        sleep_ms(50).await;
    }
    let (n, took) = recovered.expect("calls recovered on a fresh connection");
    assert_eq!(n, 2, "the blackholed INCRs never reached the server");
    assert!(took < Duration::from_secs(2), "{took:?}");
    assert!(proxy.connections() > before);
    // The pub/sub connection was blackholed too; its heartbeat retires it
    // and it resubscribes on a fresh connection (`coord:reconnected`).
    let back = Instant::now();
    while hellos.load(std::sync::atomic::Ordering::SeqCst) == 0 || !coord.remote().listening() {
        assert!(
            back.elapsed() < Duration::from_secs(3),
            "pub/sub resubscribed"
        );
        sleep_ms(25).await;
    }
    let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let s = Arc::clone(&seen);
    let topic = common::unique("t");
    let _sub = coord.subscribe(
        &topic,
        Arc::new(move |_, p| s.lock().expect("s").push(p.to_owned())),
    );
    assert_eq!(coord.remote().publish(&topic, "x").await, Ok(()));
    sleep_ms(200).await;
    assert_eq!(*seen.lock().expect("s"), vec!["x"]);
    coord.close();
}

/// A spinning script: the server stops answering for ~0.5 s on every
/// connection, so everything queues behind it.
async fn spin(url: &str) -> tokio::task::JoinHandle<()> {
    let mut conn = redis::Client::open(url)
        .expect("url")
        .get_multiplexed_async_connection_with_config(
            &redis::AsyncConnectionConfig::new().set_response_timeout(None),
        )
        .await
        .expect("blocker");
    let task = tokio::spawn(async move {
        let spun: redis::RedisResult<i64> = redis::cmd("EVAL")
            .arg("for i=1,200000000 do end return 1")
            .arg(0)
            .query_async(&mut conn)
            .await;
        assert_eq!(spun, Ok(1));
    });
    sleep_ms(30).await;
    task
}

/// I1 saturation: with the queue full of admissions behind a stalled
/// server, an admission is refused at once (`Saturated`, not parked), a
/// release still queues in the reserve and is executed before an
/// admission submitted after it, and past the full capacity a release is
/// refused and counted rather than silently dropped.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn under_saturation_releases_stay_ordered_and_bounded() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = Arc::new(
        RedisCoord::connect(
            &db.url,
            RedisCoordOptions {
                queue_capacity: 64,
                release_reserve: 16,
                ..opts(3_000)
            },
        )
        .await
        .expect("connect"),
    );
    let remote = coord.remote().clone();
    assert_eq!(
        remote.gauge_acquire("lim", 0.0, 60_000, Some("a")).await,
        Ok(0)
    );

    let spinning = spin(&db.url).await;
    // 48 admissions fill the admission share of the queue.
    let mut held = Vec::new();
    for i in 0..48 {
        let r = remote.clone();
        held.push(tokio::spawn(
            async move { r.incr(&format!("fill{i}")).await },
        ));
    }
    while remote.outstanding() < 48 {
        sleep_ms(1).await;
    }
    assert_eq!(remote.incr("one-more").await, Err(Fault::Saturated));
    // The release goes into the reserve...
    assert_eq!(remote.gauge_release_detached("lim", 0.0, Some("a")), Ok(()));
    // ...and is ordered before an admission issued after it. The queue has
    // room again only once the server drains, so retry until it takes.
    let after = {
        let r = remote.clone();
        tokio::spawn(async move {
            loop {
                match r.gauge_acquire("lim", 0.0, 60_000, Some("b")).await {
                    Err(Fault::Saturated) => tokio::task::yield_now().await,
                    other => return other,
                }
            }
        })
    };
    // Fill the reserve; past full capacity a release is refused, counted.
    let dropped_before = remote.releases_dropped();
    let mut refused = 0;
    for i in 0..32 {
        if remote.lock_release_detached(&format!("x{i}"), "t") == Err(Refused::Full) {
            refused += 1;
        }
    }
    assert!(refused > 0, "capacity is a hard bound");
    assert_eq!(remote.releases_dropped(), dropped_before + refused);
    assert!(remote.outstanding() <= 64);

    spinning.await.expect("spin");
    for h in held {
        assert!(h.await.expect("task").is_ok());
    }
    assert_eq!(
        after.await.expect("task"),
        Ok(0),
        "release ran before the acquire"
    );
    coord.close();
}

/// I1, the same guarantee through `Coord`: `concurrency: 1` with a lost
/// script cache before every release.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrency_one_holds_across_script_flushes() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(2_000))
        .await
        .expect("connect");
    for round in 0..20 {
        let holder = format!("req-{round}");
        assert_eq!(
            coord.gauge_acquire("c1", 60_000, Some(&holder)).await,
            Ok(0),
            "round {round}"
        );
        script_flush(&db.url).await;
        assert_eq!(
            coord
                .remote()
                .gauge_release_detached("c1", 0.0, Some(&holder)),
            Ok(())
        );
    }
    assert_eq!(coord.remote().releases_dropped(), 0);
    coord.close();
}

/// I1 + I2, prolonged blackhole: releases issued while the command socket
/// is silently dead are bounded (refused past capacity, counted), the
/// idempotent ones survive the reconnect and run first on the new
/// connection, and no task or call outlives its deadline.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn releases_survive_a_prolonged_blackhole_in_order_and_bounded() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let proxy = Proxy::start(&host_port(&base)).await;
    let url = format!("redis://127.0.0.1:{}/{}", proxy.port, db.index);
    let coord = RedisCoord::connect(
        &url,
        RedisCoordOptions {
            heartbeat: Duration::from_millis(100),
            queue_capacity: 32,
            release_reserve: 8,
            ..opts(200)
        },
    )
    .await
    .expect("connect");
    let remote = coord.remote().clone();
    for i in 0..4 {
        assert_eq!(
            remote
                .gauge_acquire("g", 0.0, 60_000, Some(&format!("h{i}")))
                .await,
            Ok(i)
        );
    }
    // The established sockets go silent; new connections still work.
    proxy.freeze_existing();
    let started = Instant::now();
    for i in 0..4 {
        assert_eq!(
            remote.gauge_release_detached("g", 0.0, Some(&format!("h{i}"))),
            Ok(())
        );
    }
    // A flood far past capacity: bounded, every refusal counted.
    let mut refused = 0_u64;
    for i in 0..200 {
        if remote.lock_release_detached(&format!("l{i}"), "t").is_err() {
            refused += 1;
        }
    }
    assert!(refused > 0);
    assert!(remote.outstanding() <= 32);
    // Calls are bounded by the deadline meanwhile.
    let t = Instant::now();
    let probe = remote.incr("probe").await;
    assert!(t.elapsed() < Duration::from_millis(400), "{probe:?}");
    // Recovery on a fresh connection; the held releases ran first.
    let mut read = None;
    while started.elapsed() < Duration::from_secs(5) {
        if let Ok(n) = remote.gauge_read("g", 0.0).await {
            read = Some(n);
            break;
        }
        sleep_ms(50).await;
    }
    assert_eq!(
        read,
        Some(0),
        "all four releases landed after the reconnect"
    );
    assert!(remote.releases_dropped() >= refused);
    coord.close();
}

/// Close with releases pending behind a stalled server: they are written
/// and confirmed within `drain_timeout`; past it, what is left is counted.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_drains_pending_releases_within_its_deadline() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(
        &db.url,
        RedisCoordOptions {
            drain_timeout: Duration::from_millis(1_500),
            ..opts(3_000)
        },
    )
    .await
    .expect("connect");
    assert_eq!(coord.gauge_acquire("g", 60_000, Some("a")).await, Ok(0));
    let spinning = spin(&db.url).await;
    assert_eq!(
        coord.remote().gauge_release_detached("g", 0.0, Some("a")),
        Ok(())
    );
    let started = Instant::now();
    coord.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_millis(1_700),
        "{:?}",
        started.elapsed()
    );
    // Admissions are refused once closing; releases too, counted.
    assert_eq!(coord.remote().incr("x").await, Err(Fault::NotConnected));
    let dropped = coord.remote().releases_dropped();
    assert_eq!(
        coord.remote().lock_release_detached("l", "t"),
        Err(Refused::Closed)
    );
    assert_eq!(coord.remote().releases_dropped(), dropped + 1);
    spinning.await.expect("spin");
    let check = RedisCoord::connect(&db.url, opts(1_000))
        .await
        .expect("check");
    assert_eq!(
        check.gauge_read("g").await,
        0,
        "the release was drained before close returned"
    );
    check.close();

    // A drain that cannot finish (blackholed) stops at its deadline and
    // counts what it could not confirm.
    let proxy = Proxy::start(&host_port(&base)).await;
    let url = format!("redis://127.0.0.1:{}/{}", proxy.port, db.index);
    let stuck = RedisCoord::connect(
        &url,
        RedisCoordOptions {
            drain_timeout: Duration::from_millis(300),
            ..opts(5_000)
        },
    )
    .await
    .expect("connect");
    assert_eq!(stuck.gauge_acquire("g2", 60_000, Some("a")).await, Ok(0));
    proxy.freeze_existing();
    assert_eq!(
        stuck.remote().gauge_release_detached("g2", 0.0, Some("a")),
        Ok(())
    );
    let started = Instant::now();
    stuck.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_millis(600),
        "{:?}",
        started.elapsed()
    );
    assert!(stuck.remote().releases_dropped() >= 1);
}

/// Cancellation while acquiring a Redis lock: the attempt's token is
/// released (compare-and-delete), so a cancelled acquirer whose `SET` landed
/// does not strand the lock. Cancellation during `unlock` still releases.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_lock_acquire_and_unlock_do_not_strand_the_lock() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(3_000))
        .await
        .expect("connect");
    let other = RedisCoord::connect(&db.url, opts(3_000))
        .await
        .expect("other");

    // The SET is queued behind a stalled server; cancel the acquirer.
    let spinning = spin(&db.url).await;
    let cancelled = tokio::time::timeout(
        Duration::from_millis(50),
        coord.lock("m", 30_000, Duration::ZERO),
    )
    .await;
    assert!(cancelled.is_err(), "cancelled mid-acquire");
    spinning.await.expect("spin");
    // The SET landed when the server came back, and the cleanup after it.
    let got = with_lock(&other, "m", 30_000, Duration::from_millis(500), || async {
        1
    })
    .await;
    assert_eq!(got, Ok(1));

    // Cancelled unlock: the release was queued synchronously, so the lock
    // is free even though the future never finished.
    let token = coord.lock("n", 30_000, Duration::ZERO).await.expect("held");
    let spinning = spin(&db.url).await;
    let unlock = tokio::time::timeout(Duration::from_millis(20), coord.unlock(token)).await;
    assert!(unlock.is_err(), "cancelled mid-unlock");
    spinning.await.expect("spin");
    let got = with_lock(&other, "n", 30_000, Duration::from_millis(500), || async {
        2
    })
    .await;
    assert_eq!(got, Ok(2));
    assert_eq!(
        other
            .lock("n", 30_000, Duration::ZERO)
            .await
            .map(|t| t.name().to_owned()),
        Ok("n".to_owned())
    );
    coord.close();
    other.close();
}
