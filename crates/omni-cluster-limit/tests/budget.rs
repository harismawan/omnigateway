//! The hot-path budget and per-admission cost, counted by the server.

mod common;

use std::sync::atomic::Ordering;
use std::time::Instant;

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
    assert_eq!(
        usage.oldest.load(Ordering::SeqCst),
        4,
        "only the preseed read row ranges"
    );
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
