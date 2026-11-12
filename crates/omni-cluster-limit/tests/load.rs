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
        max_keys: 4_096,
    }
}

/// Two replicas: each sees the other's published counts within a tick or
/// two, plus its own exact local counts; nothing double-counts itself.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replicas_see_each_others_load() {
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
