//! Redis outage: fail open to the per-process limiter, with a `warn` and a
//! metric, and recover. The stop/pause tests own a disposable container
//! (`OMNI_TEST_REDIS_DOCKER` / `OMNI_TEST_REDIS_DOCKER_URL`).

mod common;

use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use common::*;
use omni_cluster_limit::{ClusterLimiter, ClusterLimiterOptions};
use omni_coord::{RedisCoord, RedisCoordOptions};

#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);
impl Write for Logs {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl Logs {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap_or_else(PoisonError::into_inner)).into_owned()
    }
}

fn capture() -> (Logs, tracing::subscriber::DefaultGuard) {
    let logs = Logs::default();
    let w = logs.clone();
    let sub = tracing_subscriber::fmt()
        .with_writer(move || w.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .finish();
    (logs, tracing::subscriber::set_default(sub))
}

async fn quick_coord(url: &str, clock: omni_coord::Clock) -> Arc<RedisCoord> {
    Arc::new(
        RedisCoord::connect(
            url,
            RedisCoordOptions {
                now: clock,
                command_timeout: Duration::from_millis(300),
                connect_timeout: Duration::from_millis(300),
                connect_wait: Duration::from_millis(500),
                reconnect_max: Duration::from_millis(200),
                heartbeat: Duration::from_millis(200),
                extra_scripts: omni_cluster_limit::scripts::all(),
                ..RedisCoordOptions::default()
            },
        )
        .await
        .expect("connect"),
    )
}

fn lim(c: &Arc<RedisCoord>, clock: &ManualClock, usage: Arc<MemUsage>) -> ClusterLimiter {
    ClusterLimiter::new(
        Arc::clone(c),
        usage,
        ClusterLimiterOptions {
            clock: clock.clock(),
            fault_log_interval: Duration::from_millis(0),
            ..ClusterLimiterOptions::default()
        },
    )
}

/// Nothing listening: every admission is answered locally at once, with a
/// warn and the metric, and the local limiter still enforces `1m` and
/// `concurrency` per process (TS `memoryCoord` semantics); long windows are
/// not enforced and nothing reads the store.
#[tokio::test(flavor = "current_thread")]
async fn unreachable_fails_open_locally_and_enforces_minute_and_concurrency() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let (logs, _guard) = capture();
    let clock = ManualClock::at(T0);
    let c = quick_coord("redis://127.0.0.1:1", clock.clock()).await;
    let usage = MemUsage::new();
    let l = lim(&c, &clock, usage.clone());

    let started = Instant::now();
    let one = limits(r#"{"concurrency":1,"requests":{"5h":1}}"#);
    let mut a = l.admit("k", &one, "m", T0).await.expect("first, local");
    assert!(a.local);
    assert!(
        l.admit("k", &one, "m", T0).await.is_err(),
        "concurrency enforced locally"
    );
    a.release();
    let b = l.admit("k", &one, "m", T0).await.expect("after release");
    assert!(b.local);
    drop(b);
    // The 5h ceiling of 1 is not enforced locally: admitted again.
    drop(
        l.admit("k", &one, "m", T0)
            .await
            .expect("long windows not enforced"),
    );

    let minute = limits(r#"{"requests":{"1m":3}}"#);
    for _ in 0..3 {
        drop(
            l.admit("k2", &minute, "m", T0)
                .await
                .expect("under the minute"),
        );
    }
    let e = l
        .admit("k2", &minute, "m", T0 + 1.0)
        .await
        .expect_err("minute enforced locally");
    assert!(
        (e.retry_after_ms - 59_999.0).abs() < 1e-9,
        "{}",
        e.retry_after_ms
    );
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "never waits on a dead server"
    );

    let m = l.metrics();
    assert_eq!(
        m.local_admissions.load(Ordering::SeqCst),
        8,
        "3 + 1 + 4 (the refusals included)"
    );
    assert_eq!(m.redis_calls.load(Ordering::SeqCst), 0);
    assert_eq!(usage.sums.load(Ordering::SeqCst), 0);
    let text = logs.text();
    assert!(
        text.contains("rate limiter serving from local memory"),
        "{text}"
    );
    assert!(text.contains("rate_limit_local=true"), "{text}");
}

fn docker_target() -> Option<(String, String)> {
    let target = std::env::var("OMNI_TEST_REDIS_DOCKER")
        .ok()
        .zip(std::env::var("OMNI_TEST_REDIS_DOCKER_URL").ok());
    assert!(
        target.is_some() || std::env::var_os("OMNI_TEST_REQUIRE_REDIS").is_none(),
        "OMNI_TEST_REQUIRE_REDIS is set but OMNI_TEST_REDIS_DOCKER(_URL) is not"
    );
    target
}

async fn docker(args: &[&str]) {
    let status = tokio::process::Command::new("docker")
        .args(args)
        .stdout(std::process::Stdio::null())
        .status()
        .await
        .expect("docker");
    assert!(status.success(), "docker {args:?}");
}

static DOCKER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn wait_remote(l: &ClusterLimiter, key: &str, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let free = limits(r#"{"requests":{"1m":1000000}}"#);
    loop {
        let a = l.admit(key, &free, "m", T0).await.expect("admit");
        if !a.local {
            return;
        }
        assert!(Instant::now() < deadline, "{what}: never recovered");
        sleep_ms(50).await;
    }
}

/// Stopped mid-traffic, then started (empty: scripts and state gone):
/// admissions keep flowing locally, bounded; a debit made during the outage
/// is lost and counted, and on recovery every bucket hash is dropped (TS's
/// lost-debit policy) so the next admission reseeds from the store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_server_fails_open_and_recovers_with_a_reseed() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some((name, url)) = docker_target() else {
        return;
    };
    let _one = DOCKER.lock().await;
    flush(&url).await;
    let (logs, _guard) = capture();
    let clock = ManualClock::at(T0);
    let c = quick_coord(&url, clock.clock()).await;
    let usage = MemUsage::new();
    usage.row("k", "m", T0 - HOUR, 5.0, 0.1);
    let l = lim(&c, &clock, usage.clone());
    let lims = limits(r#"{"concurrency":2,"tokens":{"5h":1000}}"#);
    assert_eq!(l.preseed_now("k", &lims, T0).await, 0);
    let held = l.admit("k", &lims, "m", T0).await.expect("remote");
    assert!(!held.local && held.unseeded.is_empty());

    docker(&["stop", "-t", "0", &name]).await;
    let mut worst = Duration::ZERO;
    for _ in 0..10 {
        let t = Instant::now();
        let a = l.admit("k", &lims, "m", T0).await.expect("fails open");
        worst = worst.max(t.elapsed());
        assert!(a.local);
    }
    assert!(
        worst < Duration::from_millis(700),
        "bounded by the deadline: {worst:?}"
    );
    let c1 = usage.row("k", "m", T0, 50.0, 0.5);
    l.debit("k", "m", 50.0, 0.5, T0, &c1);
    l.flush_debits().await;
    assert_eq!(
        l.metrics().debit_buckets_lost.load(Ordering::SeqCst),
        2,
        "5h and 1w"
    );
    drop(held); // its release is refused or held for replay; TTL bounds it

    docker(&["start", &name]).await;
    wait_remote(&l, "probe", "after start").await;
    // The reseed sweep runs after the first success; give it a moment.
    sleep_ms(300).await;
    let a = l.admit("k", &lims, "m", T0).await.expect("remote again");
    assert!(!a.local);
    assert_eq!(
        a.unseeded.len(),
        2,
        "every bucket hash was dropped after the lost debit"
    );
    drop(a);
    l.seeds_settled().await;
    assert!(
        l.admit("k", &lims, "m", T0)
            .await
            .expect("seeded")
            .unseeded
            .is_empty()
    );
    let text = logs.text();
    assert!(
        text.contains("rate limiter serving from local memory"),
        "{text}"
    );
    assert!(text.contains("rate limit debits lost"), "{text}");
    c.shutdown().await;
}

/// Paused (accepts, never answers): each admission is bounded by the
/// command deadline and then served locally; the scripts written meanwhile
/// land on unpause, and the named slot each would have taken is given back
/// (the release queued behind it), so a `concurrency: 1` key is free again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paused_server_is_bounded_and_late_scripts_leave_no_slot() {
    // Timing-sensitive: no other test may pause writes meanwhile.
    let _quiet = quiet().await;
    let Some((name, url)) = docker_target() else {
        return;
    };
    let _one = DOCKER.lock().await;
    flush(&url).await;
    let clock = ManualClock::at(T0);
    let c = quick_coord(&url, clock.clock()).await;
    let l = lim(&c, &clock, MemUsage::new());
    let one = limits(r#"{"concurrency":1}"#);
    drop(l.admit("p", &one, "m", T0).await.expect("remote"));

    docker(&["pause", &name]).await;
    let t = Instant::now();
    let a = l
        .admit("p", &one, "m", T0)
        .await
        .expect("local while paused");
    assert!(a.local);
    assert!(
        t.elapsed() < Duration::from_millis(900),
        "{:?}",
        t.elapsed()
    );
    drop(a);
    docker(&["unpause", &name]).await;

    wait_remote(&l, "probe", "after unpause").await;
    sleep_ms(200).await;
    let mut conn = admin(&url).await;
    let live: i64 = redis::cmd("ZCOUNT")
        .arg("omni:g:p")
        .arg(T0)
        .arg("+inf")
        .query_async(&mut conn)
        .await
        .expect("zcount");
    assert_eq!(live, 0, "the late script's slot was given back");
    let a = l.admit("p", &one, "m", T0).await.expect("free again");
    assert!(!a.local);
    c.shutdown().await;
}
