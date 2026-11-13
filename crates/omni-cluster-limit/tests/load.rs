//! Load publication and snapshot across replicas.

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use common::*;
use omni_cluster_limit::load::{self, LoadOptions, LoadPublisher, LoadView};

fn opts(replica: &str) -> LoadOptions {
    LoadOptions {
        replica: replica.to_owned(),
        interval: Duration::from_millis(100),
        ttl: Duration::from_millis(600),
        ..LoadOptions::default()
    }
}

/// Two replicas: each sees the other's published counts within a tick or
/// two, plus its own exact local counts; nothing double-counts itself.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replicas_see_each_others_load() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = omni_coord::system_clock();
    let (ca, cb) = (
        coord(&db.url, clock.clock_clone()).await,
        coord(&db.url, clock.clock_clone()).await,
    );
    let (va, vb) = (LoadView::new(), LoadView::new());
    let _pa = LoadPublisher::spawn(
        ca.remote().clone(),
        Arc::clone(&va),
        clock.clock_clone(),
        opts("a"),
    );
    let _pb = LoadPublisher::spawn(
        cb.remote().clone(),
        Arc::clone(&vb),
        clock.clock_clone(),
        opts("b"),
    );
    let a1 = va.acquire("c1::m");
    let a2 = va.acquire("c1::m");
    let a3 = va.acquire("c2::m");
    let b1 = vb.acquire("c1::m");
    sleep_ms(350).await;
    let at_b = vb.counts();
    assert_eq!(at_b.get("c1::m"), Some(&3.0), "{at_b:?}");
    assert_eq!(at_b.get("c2::m"), Some(&1.0));
    let at_a = va.counts();
    assert_eq!(at_a.get("c1::m"), Some(&3.0), "{at_a:?}");
    assert_eq!(va.remote().get("c1::m"), Some(&1.0), "own picture excluded");
    drop((a1, a2, a3, b1));
    sleep_ms(350).await;
    assert!(vb.counts().is_empty(), "{:?}", vb.counts());
    assert!(va.counts().is_empty());
}

/// A replica that dies stops renewing: its picture expires with its TTL
/// and the next snapshot prunes it from the index.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dead_replicas_load_vanishes_after_its_ttl() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = omni_coord::system_clock();
    let c = coord(&db.url, clock.clock_clone()).await;
    let (va, vb) = (LoadView::new(), LoadView::new());
    let pa = LoadPublisher::spawn(
        c.remote().clone(),
        Arc::clone(&va),
        clock.clock_clone(),
        opts("dead"),
    );
    let _pb = LoadPublisher::spawn(
        c.remote().clone(),
        Arc::clone(&vb),
        clock.clock_clone(),
        opts("live"),
    );
    let _held = va.acquire("c::m");
    sleep_ms(300).await;
    assert_eq!(vb.counts().get("c::m"), Some(&1.0));
    drop(pa); // the process "dies": no more publishes, slot never released
    sleep_ms(1_000).await;
    assert!(vb.counts().is_empty(), "{:?}", vb.counts());
    let mut conn = admin(&db.url).await;
    let members: Vec<String> = redis::cmd("ZRANGE")
        .arg(load::index_key())
        .arg(0)
        .arg(-1)
        .query_async(&mut conn)
        .await
        .expect("zrange");
    assert_eq!(members, ["live"]);
    let exists: bool = redis::cmd("EXISTS")
        .arg(load::replica_key("dead"))
        .query_async(&mut conn)
        .await
        .expect("exists");
    assert!(!exists);
}

/// One publish is one script call, bounded by `max_keys` (busiest kept);
/// the snapshot is bounded the same way.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publishes_are_bounded() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = omni_coord::system_clock();
    let c = coord(&db.url, clock.clock_clone()).await;
    let v = LoadView::new();
    let mut held = Vec::new();
    for i in 0..50 {
        for _ in 0..=(i % 3) {
            held.push(v.acquire(&format!("c{i:02}::m")));
        }
    }
    let o = LoadOptions {
        max_keys: 10,
        ..opts("bounded")
    };
    load::publish(c.remote(), &v, &clock.clock_clone(), &o).await;
    assert_eq!(v.metrics.truncated.load(Ordering::SeqCst), 40);
    assert_eq!(v.metrics.publishes.load(Ordering::SeqCst), 1);
    let mut conn = admin(&db.url).await;
    let fields: std::collections::HashMap<String, u64> = redis::cmd("HGETALL")
        .arg(load::replica_key("bounded"))
        .query_async(&mut conn)
        .await
        .expect("hgetall");
    assert_eq!(fields.len(), 10);
    assert!(
        fields.values().all(|n| *n == 3),
        "busiest first: {fields:?}"
    );
    let pttl: i64 = redis::cmd("PTTL")
        .arg(load::replica_key("bounded"))
        .query_async(&mut conn)
        .await
        .expect("pttl");
    assert!(pttl > 0 && pttl <= 600, "{pttl}");
    let reader = LoadView::new();
    load::refresh(
        c.remote(),
        &reader,
        &clock.clock_clone(),
        &LoadOptions {
            max_keys: 4,
            ..opts("reader")
        },
    )
    .await;
    assert_eq!(reader.remote().len(), 4);
}

trait ClockClone {
    fn clock_clone(&self) -> omni_coord::Clock;
}
impl ClockClone for omni_coord::Clock {
    fn clock_clone(&self) -> omni_coord::Clock {
        Arc::clone(self)
    }
}

/// I4: the default maximum (4,096 keys) publishes, and replaces the previous
/// picture whole; a publication that fails part way leaves the previous
/// picture as it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_default_maximum_publishes_and_replaces_the_picture() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = omni_coord::system_clock();
    let c = coord(&db.url, clock.clock_clone()).await;
    let o = LoadOptions {
        replica: "big".into(),
        ..LoadOptions::default()
    };
    assert_eq!(o.max_keys, 4_096);
    let v = LoadView::new();
    let old: Vec<_> = (0..10).map(|i| v.acquire(&format!("old{i}"))).collect();
    load::publish(c.remote(), &v, &clock.clock_clone(), &o).await;
    drop(old);
    let held: Vec<_> = (0..o.max_keys)
        .map(|i| v.acquire(&format!("c{i:05}::m")))
        .collect();
    load::publish(c.remote(), &v, &clock.clock_clone(), &o).await;
    assert_eq!(v.metrics.publish_faults.load(Ordering::SeqCst), 0);
    let mut conn = admin(&db.url).await;
    let fields: std::collections::HashMap<String, u64> = redis::cmd("HGETALL")
        .arg(load::replica_key("big"))
        .query_async(&mut conn)
        .await
        .expect("hgetall");
    assert_eq!(fields.len(), o.max_keys);
    assert!(
        !fields.contains_key("old0"),
        "the old picture was merged, not replaced"
    );
    // A publication that fails part way through never leaves the replica
    // without a picture: Valkey does not roll back a failing script's
    // earlier writes, so the live hash is replaced only by `RENAME` of a
    // fully built staging hash, never deleted first. The failure is forced
    // after the build, at the index `ZADD` (the index key given the wrong
    // type): the picture must be the old one or the whole new one.
    drop(held);
    let _: () = redis::cmd("SET")
        .arg(load::index_key())
        .arg("not-a-zset")
        .query_async(&mut conn)
        .await
        .expect("break the index");
    let mut args: Vec<String> = vec!["1000".into(), "1".into(), "big".into()];
    for i in 0..1_500 {
        args.push(format!("n{i}"));
        args.push("1".into());
    }
    let bad = c
        .remote()
        .eval(
            &omni_cluster_limit::scripts::LOAD_PUBLISH,
            &[
                load::replica_key("big"),
                load::index_key(),
                load::staging_key("big"),
            ],
            &args,
        )
        .await;
    let _: () = redis::cmd("DEL")
        .arg(load::index_key())
        .query_async(&mut conn)
        .await
        .expect("restore the index");
    assert!(bad.is_err(), "the publication was meant to fail: {bad:?}");
    let n: usize = redis::cmd("HLEN")
        .arg(load::replica_key("big"))
        .query_async(&mut conn)
        .await
        .expect("hlen");
    assert!(
        n == o.max_keys || n == 1_500,
        "a failed publication left a partial picture: {n} fields"
    );
    // A refused publication (malformed) touches nothing.
    let bad = c
        .remote()
        .eval(
            &omni_cluster_limit::scripts::LOAD_PUBLISH,
            &[
                load::replica_key("big"),
                load::index_key(),
                load::staging_key("big"),
            ],
            &["1000".into(), "1".into(), "big".into(), "odd".into()],
        )
        .await;
    assert!(bad.is_err());
    let before = n;
    let n: usize = redis::cmd("HLEN")
        .arg(load::replica_key("big"))
        .query_async(&mut conn)
        .await
        .expect("hlen");
    assert_eq!(n, before, "a refused publication touched the picture");
    // Publish the full picture again for the reader below.
    let held: Vec<_> = (0..o.max_keys)
        .map(|i| v.acquire(&format!("c{i:05}::m")))
        .collect();
    load::publish(c.remote(), &v, &clock.clock_clone(), &o).await;
    // And a reader of the full-size picture works at the default bound.
    let reader = LoadView::new();
    load::refresh(
        c.remote(),
        &reader,
        &clock.clock_clone(),
        &LoadOptions {
            replica: "r".into(),
            ..LoadOptions::default()
        },
    )
    .await;
    assert_eq!(reader.remote().len(), o.max_keys);
    drop(held);
}

/// Minor: the snapshot is bounded at the server — it returns the
/// `max_keys` busiest totals across replicas, not discovery order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_snapshot_returns_the_busiest_keys_bounded_at_the_server() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = omni_coord::system_clock();
    let c = coord(&db.url, clock.clock_clone()).await;
    let mut held = Vec::new();
    let mut views = Vec::new();
    for r in 0..20 {
        let v = LoadView::new();
        for k in 0..50 {
            for _ in 0..=((r * 50 + k) % 7) {
                held.push(v.acquire(&format!("r{r}k{k}")));
            }
        }
        load::publish(
            c.remote(),
            &v,
            &clock.clock_clone(),
            &LoadOptions {
                replica: format!("r{r}"),
                ..LoadOptions::default()
            },
        )
        .await;
        views.push(v);
    }
    let reader = LoadView::new();
    let o = LoadOptions {
        replica: "reader".into(),
        max_keys: 50,
        ..LoadOptions::default()
    };
    load::refresh(c.remote(), &reader, &clock.clock_clone(), &o).await;
    let got = reader.remote();
    assert_eq!(got.len(), 50);
    assert!(got.values().all(|n| *n == 7.0), "not the busiest");
    // At most `max_replicas` pictures are read.
    let few = LoadOptions {
        max_replicas: 2,
        max_keys: 4_096,
        ..o
    };
    load::refresh(c.remote(), &reader, &clock.clock_clone(), &few).await;
    assert_eq!(reader.remote().len(), 100, "two replicas' 50 keys each");
    drop(held);
}

/// Minor: while refreshes fail (the coordinator is down), the last fleet
/// picture is read only until it is `ttl` old; then ranking sees this
/// process's own counts alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_fleet_picture_ages_out_during_an_outage() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = omni_coord::system_clock();
    let c = coord(&db.url, clock.clock_clone()).await;
    let dead = coord("redis://127.0.0.1:1", clock.clock_clone()).await;
    let o = |r: &str| LoadOptions {
        replica: r.into(),
        ttl: Duration::from_millis(400),
        ..LoadOptions::default()
    };
    let (va, vb) = (LoadView::new(), LoadView::new());
    let _theirs = vb.acquire("c::m");
    let _mine = va.acquire("mine::m");
    load::publish(c.remote(), &vb, &clock.clock_clone(), &o("b")).await;
    load::refresh(c.remote(), &va, &clock.clock_clone(), &o("a")).await;
    assert_eq!(va.counts().get("c::m"), Some(&1.0));
    sleep_ms(200).await;
    load::refresh(dead.remote(), &va, &clock.clock_clone(), &o("a")).await;
    assert_eq!(va.counts().get("c::m"), Some(&1.0), "still within its TTL");
    sleep_ms(300).await;
    load::refresh(dead.remote(), &va, &clock.clock_clone(), &o("a")).await;
    let now = va.counts();
    assert_eq!(
        now.get("c::m"),
        None,
        "a picture older than its TTL was read"
    );
    assert_eq!(now.get("mine::m"), Some(&1.0));
    assert!(va.metrics.refresh_faults.load(Ordering::SeqCst) >= 2);
}

/// Minor (r1 review): a reader whose `max_keys` is below the publishers'
/// still gets the fleet's busiest keys — each picture is read whole (up to
/// the fleet's publisher bound), not its first `max_keys` fields.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_small_reader_gets_the_busiest_of_large_pictures() {
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = omni_coord::system_clock();
    let c = coord(&db.url, clock.clock_clone()).await;
    let v = LoadView::new();
    let mut held = Vec::new();
    for i in 0..300 {
        held.push(v.acquire(&format!("k{i:03}")));
    }
    for _ in 0..4 {
        held.push(v.acquire("k123"));
    }
    load::publish(c.remote(), &v, &clock.clock_clone(), &opts("big")).await;
    let reader = LoadView::new();
    for want in [1, 5] {
        let o = LoadOptions {
            max_keys: want,
            ..opts("reader")
        };
        load::refresh(c.remote(), &reader, &clock.clock_clone(), &o).await;
        let got = reader.remote();
        assert_eq!(got.len(), want);
        assert_eq!(got.get("k123"), Some(&5.0), "busiest key missing: {got:?}");
    }
    drop(held);
}
