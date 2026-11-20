//! The hot-path budget and per-admission cost, counted by the server.

mod common;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use common::*;

fn commandstats(info: &str) -> std::collections::HashMap<String, (u64, f64)> {
    let mut out = std::collections::HashMap::new();
    for line in info.lines() {
        let Some(rest) = line.strip_prefix("cmdstat_") else {
            continue;
        };
        let Some((name, fields)) = rest.split_once(':') else {
            continue;
        };
        let get = |k: &str| {
            fields
                .split(',')
                .find_map(|f| f.strip_prefix(k).and_then(|v| v.strip_prefix('=')))
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0)
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        out.insert(name.to_owned(), (get("calls") as u64, get("usec")));
    }
    out
}

async fn info(conn: &mut redis::aio::MultiplexedConnection, section: &str) -> String {
    redis::cmd("INFO")
        .arg(section)
        .query_async(conn)
        .await
        .expect("info")
}

fn cpu_s(info: &str) -> f64 {
    info.lines()
        .filter_map(|l| {
            l.strip_prefix("used_cpu_sys:")
                .or_else(|| l.strip_prefix("used_cpu_user:"))
        })
        .filter_map(|v| v.trim().parse::<f64>().ok())
        .sum()
}

/// The hot-path budget, counted by the server: an unlimited key makes no
/// call; a limited key exactly one `EVALSHA` (no other command, no store
/// read); load bookkeeping per request makes none. Also measures
/// per-admission latency and server CPU (reported, not gated: D4 gates).
///
/// Commandstats are server-wide: this binary holds this one test, and
/// cargo runs test binaries one at a time.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hot_path_budget_and_latency() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let clock = ManualClock::at(T0);
    let c = coord(&db.url, clock.clock()).await;
    let usage = MemUsage::new();
    let l = limiter(&c, usage.clone(), clock.clock());
    let full = limits(
        r#"{"concurrency":64,"requests":{"1m":1000000,"5h":1000000},"tokens":{"1w":1000000000},"models":{"m":{"spend":{"5h":100000}}}}"#,
    );
    l.preseed_now("k", &full, T0).await;
    let mut conn = admin(&db.url).await;
    let view = omni_cluster_limit::load::LoadView::new();
    let _: () = redis::cmd("CONFIG")
        .arg("RESETSTAT")
        .query_async(&mut conn)
        .await
        .expect("resetstat");
    for _ in 0..200 {
        drop(
            l.admit("free", &limits("{}"), "m", T0)
                .await
                .expect("unlimited"),
        );
        drop(view.acquire("cred::m"));
    }
    let stats = commandstats(&info(&mut conn, "commandstats").await);
    let others: u64 = stats
        .iter()
        .filter(|(k, _)| !matches!(k.as_str(), "info" | "config|resetstat" | "ping"))
        .map(|(_, v)| v.0)
        .sum();
    assert_eq!(
        others, 0,
        "unlimited keys / load slots touched the server: {stats:?}"
    );

    let n = 2_000_u32;
    let _: () = redis::cmd("CONFIG")
        .arg("RESETSTAT")
        .query_async(&mut conn)
        .await
        .expect("resetstat");
    let cpu0 = cpu_s(&info(&mut conn, "cpu").await);
    let mut lat = Vec::with_capacity(n as usize);
    let wall = Instant::now();
    for _ in 0..n {
        let t = Instant::now();
        let a = l.admit("k", &full, "m", T0).await.expect("admitted");
        lat.push(t.elapsed());
        assert!(a.unseeded.is_empty());
        drop(a);
    }
    let wall = wall.elapsed();
    let _pinged = c.remote().query(redis::cmd("PING")).await.is_ok();
    let cpu1 = cpu_s(&info(&mut conn, "cpu").await);
    let stats = commandstats(&info(&mut conn, "commandstats").await);
    let evalsha = stats.get("evalsha").map_or(0, |v| v.0);
    let eval = stats.get("eval").map_or(0, |v| v.0);
    // One EVALSHA per admission, one EVAL per release (detached, `EVAL` by
    // D2's design so a lost script cache cannot reorder it).
    assert_eq!(evalsha, u64::from(n), "{stats:?}");
    assert_eq!(eval, u64::from(n), "{stats:?}");
    assert_eq!(
        usage.sums.load(Ordering::SeqCst),
        4,
        "only the preseed (2 subjects x 2 windows) read the store"
    );
    assert_eq!(usage.calls(), 4, "nothing else read the store");
    lat.sort();
    let pct = |p: f64| {
        lat[(lat.len() - 1) * usize::try_from((p * 1000.0).round() as i64).unwrap_or(0) / 1000]
            .as_secs_f64()
            * 1e6
    };
    let usec = stats.get("evalsha").map_or(0.0, |v| v.1);
    eprintln!(
        "LATENCY admit (2 subjects, gauge, 5h+1w sums; debug client, sequential, loopback): p50 {:.0} us, p90 {:.0} us, p99 {:.0} us, max {:.0} us; {:.0} admits/s sequential",
        pct(0.5),
        pct(0.9),
        pct(0.99),
        pct(1.0),
        f64::from(n) / wall.as_secs_f64()
    );
    eprintln!(
        "SERVER admission script {:.1} us/call (commandstats), release EVAL {:.1} us/call; server CPU {:.1} us per admission+release (INFO cpu)",
        usec / f64::from(n),
        stats.get("eval").map_or(0.0, |v| v.1) / f64::from(n),
        (cpu1 - cpu0) * 1e6 / f64::from(n)
    );
}

/// D4 diagnostic, run in release during the coordinated benchmark window.
/// The full PG/Valkey CPU target is judged by the HTTP benchmark, not this
/// narrower measurement of dense Redis admission, release, and fleet load.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dense_windows_with_concurrent_fleet_load() {
    use omni_cluster_limit::load::{LoadOptions, LoadPublisher, LoadView};
    let Ok(url) = std::env::var("OMNI_TEST_D4_DENSE_REDIS_URL") else {
        return;
    };
    let _quiet = quiet().await;
    let key = uuid::Uuid::new_v4().to_string();
    // Exactly 301 occupied 5h minute buckets and 169 occupied 1w hour
    // buckets, including both partially covered edge buckets.
    let at = T0.div_euclid(HOUR) * HOUR + 30_000.0;
    let usage = MemUsage::new();
    for i in 0..=300 {
        usage.row(&key, "m", at - f64::from(i) * 60_000.0, 1.0, 0.125);
    }
    for i in 6..=168 {
        usage.row(&key, "m", at - f64::from(i) * HOUR, 1.0, 0.125);
    }
    let full = limits(
        r#"{"requests":{"5h":10000000,"1w":10000000},"tokens":{"5h":10000000,"1w":10000000},"spend":{"5h":10000000,"1w":10000000},"concurrency":64}"#,
    );
    let clock = omni_coord::system_clock();
    let (a, b) = tokio::join!(coord(&url, clock.clone()), coord(&url, clock.clone()));
    let (la, lb) = (
        limiter(&a, usage.clone(), clock.clone()),
        limiter(&b, usage.clone(), clock.clone()),
    );
    assert_eq!(la.preseed_now(&key, &full, at).await, 0);
    let mut conn = admin(&url).await;
    for (window, fields) in [("5h", 904_u64), ("1w", 508)] {
        let count: u64 = redis::cmd("HLEN")
            .arg(format!("omni:b:lim:{key}:{window}"))
            .query_async(&mut conn)
            .await
            .expect("seeded hash");
        assert_eq!(count, fields, "dense {window} fixture");
    }
    let (va, vb) = (LoadView::new(), LoadView::new());
    let (sa, sb) = (va.acquire("dense-a::m"), vb.acquire("dense-b::m"));
    let pa = LoadPublisher::spawn(
        a.remote().clone(),
        va.clone(),
        clock.clone(),
        LoadOptions::default(),
    );
    let pb = LoadPublisher::spawn(
        b.remote().clone(),
        vb.clone(),
        clock.clone(),
        LoadOptions::default(),
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while !va.remote().contains_key("dense-b::m") || !vb.remote().contains_key("dense-a::m") {
            sleep_ms(10).await;
        }
    })
    .await
    .expect("peers' load visible");
    let before = commandstats(&info(&mut conn, "commandstats").await);
    let cpu0 = cpu_s(&info(&mut conn, "cpu").await);
    let refreshes = || {
        va.metrics.refreshes.load(Ordering::Relaxed) + vb.metrics.refreshes.load(Ordering::Relaxed)
    };
    let ticks0 = refreshes();
    let start = Instant::now();
    let mut lat = futures_util::future::join_all((0..32).map(|i| {
        let (l, v) = if i % 2 == 0 { (&la, &va) } else { (&lb, &vb) };
        let (key, full) = (&key, &full);
        async move {
            let mut lat = Vec::new();
            while start.elapsed() < Duration::from_secs(3) {
                let t = Instant::now();
                let admission = l
                    .admit(key, full, "m", at)
                    .await
                    .expect("limited admission");
                assert!(admission.unseeded.is_empty());
                let slot = v.acquire("dense::m");
                lat.push(t.elapsed());
                drop((slot, admission));
            }
            lat
        }
    }))
    .await
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let elapsed = start.elapsed();
    let ticks = refreshes() - ticks0;
    drop((pa, pb, sa, sb));
    let (ping_a, ping_b) = tokio::join!(
        a.remote().query(redis::cmd("PING")),
        b.remote().query(redis::cmd("PING"))
    );
    assert!(ping_a.is_ok() && ping_b.is_ok());
    let cpu1 = cpu_s(&info(&mut conn, "cpu").await);
    let after = commandstats(&info(&mut conn, "commandstats").await);
    let (calls0, usec0) = before.get("evalsha").copied().unwrap_or_default();
    let (calls1, usec1) = after
        .get("evalsha")
        .copied()
        .expect("admission command stats");
    let n = lat.len();
    assert!(n >= 32 && ticks >= 2, "{n} admissions, {ticks} refreshes");
    assert_eq!(
        usage.calls(),
        2,
        "warm admissions must not return to storage"
    );
    for l in [&la, &lb] {
        assert_eq!(l.metrics().local_admissions.load(Ordering::Relaxed), 0);
        assert_eq!(l.metrics().verdict_mismatches.load(Ordering::Relaxed), 0);
    }
    assert_eq!(
        la.metrics().redis_calls.load(Ordering::Relaxed)
            + lb.metrics().redis_calls.load(Ordering::Relaxed),
        u64::try_from(n).expect("bounded sample")
    );
    lat.sort_unstable();
    let us = |percent: usize| lat[(n - 1) * percent / 100].as_secs_f64() * 1e6;
    let n = f64::from(u32::try_from(n).expect("bounded sample"));
    let evals = f64::from(u32::try_from(calls1 - calls0).expect("bounded sample"));
    eprintln!(
        "DENSE 301/169, 32 clients over two replicas, {ticks} load refreshes: {:.0} admits/s, p50 {:.1} us, p99 {:.1} us, EVALSHA {:.1} us/call incl. load, Valkey CPU {:.1} us/admission incl. releases+refreshes",
        n / elapsed.as_secs_f64(),
        us(50),
        us(99),
        (usec1 - usec0) / evals,
        (cpu1 - cpu0) * 1e6 / n
    );
    tokio::join!(la.shutdown(), lb.shutdown());
    tokio::join!(a.shutdown(), b.shutdown());
}
