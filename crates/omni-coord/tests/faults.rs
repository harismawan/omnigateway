//! Outage and fault behaviour, against a real server: `apps/gateway/test/
//! coord/redis.test.ts`'s fail-open suite ported, plus dropped connections,
//! a lost script cache, and (with a disposable container named in
//! `OMNI_TEST_REDIS_DOCKER`) a stopped and a paused server.
//!
//! Several of these block the whole server with a spinning script, so every
//! test here takes one global lock: they run one at a time, and cargo runs
//! this binary apart from the contract binary.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use common::{admin, fresh_db, kill_clients_on_db, redis_base, sleep_ms};
use omni_coord::redis::Fault;
use omni_coord::{
    Coord, CoordError, Counts, RECONNECTED_TOPIC, RedisCoord, RedisCoordOptions, with_lock,
};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// --- captured logs ---------------------------------------------------------

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

static LOGS: LazyLock<Capture> = LazyLock::new(|| {
    let capture = Capture::default();
    let writer = capture.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    tracing::subscriber::set_global_default(subscriber).expect("one global subscriber");
    capture
});

fn logs_since(mark: usize) -> String {
    let all = LOGS.0.lock().unwrap_or_else(PoisonError::into_inner);
    String::from_utf8_lossy(&all[mark.min(all.len())..]).into_owned()
}

fn log_mark() -> usize {
    LOGS.0.lock().unwrap_or_else(PoisonError::into_inner).len()
}

fn opts(command_timeout_ms: u64) -> RedisCoordOptions {
    RedisCoordOptions {
        command_timeout: Duration::from_millis(command_timeout_ms),
        fault_log_interval: Duration::ZERO,
        ..RedisCoordOptions::default()
    }
}

/// A script that holds the server's one command thread for roughly half a
/// second: a server that accepted the socket and stopped answering. Counted,
/// not clock-driven (scripts see a frozen `TIME`).
fn spin(conn: &mut redis::aio::MultiplexedConnection) -> impl Future<Output = ()> + use<> {
    let mut conn = conn.clone();
    async move {
        let spun: redis::RedisResult<i64> = redis::cmd("EVAL")
            .arg("for i=1,200000000 do end return 1")
            .arg(0)
            .query_async(&mut conn)
            .await;
        assert_eq!(spun, Ok(1), "the spin script ran to completion");
    }
}

/// A blocker connection with no response timeout, so it waits the spin out.
async fn blocker(url: &str) -> redis::aio::MultiplexedConnection {
    redis::Client::open(url)
        .expect("url")
        .get_multiplexed_async_connection_with_config(
            &redis::AsyncConnectionConfig::new().set_response_timeout(None),
        )
        .await
        .expect("blocker")
}

async fn until<F, Fut>(limit: Duration, mut probe: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if probe().await {
            return true;
        }
        sleep_ms(25).await;
    }
    false
}

// --- the TS fail-open suite -----------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreachable_coordinator_serves_limits_from_memory_and_refuses_sessions() {
    let _serial = SERIAL.lock().await;
    let mark = log_mark();
    let coord = RedisCoord::connect("redis://127.0.0.1:1", opts(1_000))
        .await
        .expect("url parses");
    let started = Instant::now();
    assert_eq!(
        coord.window_claim("k", 60_000.0, 1.0).await.before.used,
        0.0
    );
    assert_eq!(
        coord.window_claim("k", 60_000.0, 2.0).await.before.used,
        1.0
    );
    assert_eq!(coord.gauge_acquire("g", 1_000, None).await, Ok(0));
    assert!(!coord.lease_acquire("job", "me", 1_000).await);
    let locked = with_lock(&coord, "m", 100, Duration::from_millis(10), || async { 1 }).await;
    assert_eq!(locked, Err(CoordError::LockUnavailable("m".to_owned())));
    assert_eq!(coord.kv_get("s").await, Err(CoordError::Unavailable));
    assert_eq!(
        coord.kv_set("s", "v", 1_000).await,
        Err(CoordError::Unavailable)
    );
    assert_eq!(
        CoordError::Unavailable.to_string(),
        "the coordinator is unreachable; try again shortly"
    );
    assert_eq!(coord.incr("n").await, 1);
    // A process is always its own audience.
    let seen = Arc::new(AtomicUsize::new(0));
    let s = Arc::clone(&seen);
    let _sub = coord.subscribe(
        "t",
        Arc::new(move |_, _| {
            s.fetch_add(1, Ordering::SeqCst);
        }),
    );
    coord.publish("t", "x").await;
    assert_eq!(seen.load(Ordering::SeqCst), 1);
    // Every one of those answered at once: no wait on a connect.
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "{:?}",
        started.elapsed()
    );
    // The explicit error type a caller can turn into local limiting.
    assert_eq!(
        coord.remote().window_claim("k", 60_000.0, 3.0).await,
        Err(Fault::NotConnected)
    );
    assert!(!coord.healthy());
    assert!(coord.faults() > 0);
    let logs = logs_since(mark);
    assert!(
        logs.contains("coordinator unreachable; serving from memory")
            && logs.contains("coord=\"redis\"")
            && logs.contains("coord_fallback=true"),
        "{logs}"
    );
    coord.close();
}

/// A reachable coordinator that answers too slowly is the same fault as one
/// that is not there. The warm claims make the assertion unambiguous: Redis
/// holds two, the embedded memory coordinator none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_command_that_outruns_its_deadline_falls_back_like_an_outage() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let mark = log_mark();
    let mut block = blocker(&db.url).await;
    let coord = RedisCoord::connect(&db.url, opts(50))
        .await
        .expect("connect");
    coord.window_claim("stalled", 60_000.0, 1.0).await;
    assert_eq!(
        coord
            .window_claim("stalled", 60_000.0, 2.0)
            .await
            .before
            .used,
        1.0
    );
    assert!(coord.healthy());
    let faults_before = coord.faults();

    let spinning = tokio::spawn(spin(&mut block));
    sleep_ms(50).await;
    let started = Instant::now();
    assert_eq!(
        coord
            .window_claim("stalled", 60_000.0, 3.0)
            .await
            .before
            .used,
        0.0
    );
    assert!(started.elapsed() < Duration::from_millis(300));
    assert!(!coord.healthy());
    assert_eq!(coord.faults(), faults_before + 1);
    let logs = logs_since(mark);
    assert!(
        logs.contains("coordinator slow; serving from memory")
            && logs.contains("reason=\"command timed out\""),
        "{logs}"
    );

    spinning.await.expect("spin");
    coord.window_claim("stalled", 60_000.0, 4.0).await;
    assert!(coord.healthy());
    assert_eq!(coord.faults(), faults_before + 1);
    coord.close();
}

/// The deadline does not cancel the command. A `SET NX` that lands after its
/// deadline is a lock under a token nobody holds, so it is undone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lock_claim_that_outruns_its_deadline_is_released_not_stranded() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let mut block = blocker(&db.url).await;
    let slow = RedisCoord::connect(&db.url, opts(50))
        .await
        .expect("connect");
    slow.incr("warm").await;

    let spinning = tokio::spawn(spin(&mut block));
    sleep_ms(50).await;
    let refused = with_lock(&slow, "seed", 5_000, Duration::ZERO, || async { 1 }).await;
    assert_eq!(refused, Err(CoordError::LockUnavailable("seed".to_owned())));
    spinning.await.expect("spin");

    let contender = RedisCoord::connect(&db.url, opts(1_000))
        .await
        .expect("connect");
    let started = Instant::now();
    let got = with_lock(
        &contender,
        "seed",
        5_000,
        Duration::from_millis(500),
        || async { 1 },
    )
    .await;
    assert_eq!(got, Ok(1));
    assert!(started.elapsed() < Duration::from_millis(400));
    slow.close();
    contender.close();
}

/// Recovery drops every bucket hash only when a debit was lost to memory; a
/// slow claim that lost nothing must not cost the fleet a reseed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timed_out_claim_without_a_lost_debit_does_not_drop_the_fleets_buckets() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let mut block = blocker(&db.url).await;
    let a = RedisCoord::connect(&db.url, opts(50)).await.expect("a");
    let b = RedisCoord::connect(&db.url, opts(1_000)).await.expect("b");
    let delta = Counts {
        requests: 1.0,
        tokens: 1.0,
        cost_usd: 0.0,
    };
    a.buckets_seed("k", 1_000.0, 60_000.0, 10_000.0, &[(9_000.0, delta)])
        .await;
    let sum = b.buckets_sum("k", 1_000.0, 60_000.0, 10_000.0).await;
    assert_eq!(sum.map(|s| s.requests), Some(1.0));

    let spinning = tokio::spawn(spin(&mut block));
    sleep_ms(50).await;
    a.window_claim("w", 60_000.0, 1.0).await;
    assert!(!a.healthy());
    spinning.await.expect("spin");
    a.window_claim("w", 60_000.0, 2.0).await;
    assert!(a.healthy());
    sleep_ms(50).await;
    let sum = b.buckets_sum("k", 1_000.0, 60_000.0, 10_000.0).await;
    assert_eq!(sum.map(|s| s.requests), Some(1.0));

    // A debit that went to memory is lost there: the reseed is owed.
    let spinning = tokio::spawn(spin(&mut block));
    sleep_ms(50).await;
    a.buckets_add("k", 1_000.0, 60_000.0, 10_000.0, delta).await;
    assert!(!a.healthy());
    spinning.await.expect("spin");
    a.window_claim("w", 60_000.0, 3.0).await;
    sleep_ms(100).await;
    assert_eq!(b.buckets_sum("k", 1_000.0, 60_000.0, 10_000.0).await, None);
    a.close();
    b.close();
}

// --- connection loss and recovery -----------------------------------------

fn counter(
    coord: &RedisCoord,
    pattern: &str,
) -> (Arc<Mutex<Vec<String>>>, omni_coord::Subscription) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = Arc::clone(&seen);
    let sub = coord.subscribe(
        pattern,
        Arc::new(move |t, p| {
            s.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(format!("{t}={p}"));
        }),
    );
    (seen, sub)
}

fn take(seen: &Mutex<Vec<String>>) -> Vec<String> {
    std::mem::take(&mut *seen.lock().unwrap_or_else(PoisonError::into_inner))
}

/// A dropped TCP connection (both of them) is replaced, scripts are reloaded,
/// the channel is resubscribed exactly once — no frame delivered twice — and
/// `coord:reconnected` is dispatched locally so fan-out state can be re-asked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn killed_connections_reconnect_and_resubscribe_without_duplicates() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let mut killer = admin(&format!("{base}/0")).await;
    let a = RedisCoord::connect(&db.url, opts(500)).await.expect("a");
    let b = RedisCoord::connect(&db.url, opts(500)).await.expect("b");
    let t = common::unique("t");
    let (frames, _f) = counter(&a, &t);
    let (hellos, _h) = counter(&a, RECONNECTED_TOPIC);
    b.publish(&t, "before").await;
    assert!(
        until(Duration::from_secs(2), || async {
            !frames.lock().expect("f").is_empty()
        })
        .await
    );
    assert_eq!(take(&frames), vec![format!("{t}=before")]);

    assert!(kill_clients_on_db(&mut killer, db.index).await >= 4);
    // Calls during the gap are bounded and answered (from memory if need be).
    let started = Instant::now();
    a.window_claim("w", 60_000.0, 1.0).await;
    assert!(started.elapsed() < Duration::from_millis(700));

    assert!(
        until(Duration::from_secs(5), || async {
            a.remote().incr("probe").await.is_ok() && a.remote().listening()
        })
        .await,
        "a reconnected"
    );
    assert!(
        until(Duration::from_secs(5), || async {
            b.remote().incr("probe").await.is_ok() && b.remote().listening()
        })
        .await,
        "b reconnected"
    );
    assert!(
        until(Duration::from_secs(2), || async {
            !hellos.lock().expect("h").is_empty()
        })
        .await
    );
    assert_eq!(take(&hellos), vec!["coord:reconnected="]);
    take(&frames);
    assert_eq!(b.remote().publish(&t, "after").await, Ok(()));
    sleep_ms(200).await;
    assert_eq!(take(&frames), vec![format!("{t}=after")], "exactly once");
    assert!(a.healthy());
    a.close();
    b.close();
}

/// An idle coordinator whose connection died is reconnected by its
/// heartbeat, so the first call after the drop is served by the server, not
/// by memory.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_dropped_connection_is_replaced_before_the_next_call() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let mut killer = admin(&format!("{base}/0")).await;
    let coord = RedisCoord::connect(
        &db.url,
        RedisCoordOptions {
            heartbeat: Duration::from_millis(100),
            ..opts(500)
        },
    )
    .await
    .expect("connect");
    coord.window_claim("w", 60_000.0, 1.0).await;
    assert!(kill_clients_on_db(&mut killer, db.index).await >= 2);
    // Two heartbeats and a reconnect.
    sleep_ms(600).await;
    let faults = coord.faults();
    let claim = coord.remote().window_claim("w", 60_000.0, 2.0).await;
    assert_eq!(claim.map(|c| c.before.used), Ok(1.0));
    assert_eq!(coord.faults(), faults, "the call itself met no fault");
    coord.close();
}

/// A server that lost its script cache (restart, `SCRIPT FLUSH`) answers
/// `NOSCRIPT`; the script is sent whole and the call succeeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_script_cache_is_answered_by_sending_the_script_whole() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let mut conn = admin(&db.url).await;
    let coord = RedisCoord::connect(&db.url, opts(1_000))
        .await
        .expect("connect");
    coord.window_claim("k", 60_000.0, 1.0).await;
    let faults = coord.faults();
    let _: () = redis::cmd("SCRIPT")
        .arg("FLUSH")
        .query_async(&mut conn)
        .await
        .expect("flush scripts");
    let claim = coord.remote().window_claim("k", 60_000.0, 2.0).await;
    assert_eq!(claim.map(|c| c.before.used), Ok(1.0));
    // Detached (EVALSHA-only first) sends also recover.
    let token = coord.lock("l", 5_000, Duration::ZERO).await.expect("lock");
    let _: () = redis::cmd("SCRIPT")
        .arg("FLUSH")
        .query_async(&mut conn)
        .await
        .expect("flush scripts");
    coord.unlock_detached(token);
    assert!(
        until(Duration::from_secs(1), || async {
            coord.lock("l", 5_000, Duration::ZERO).await.is_ok()
        })
        .await
    );
    assert_eq!(coord.faults(), faults);
    coord.close();
}

// --- a stopped and a paused server (disposable container) -----------------

/// The disposable container the stop/pause tests own. With
/// `OMNI_TEST_REQUIRE_REDIS=1` its absence fails rather than skips.
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

/// The container's server, emptied: a run must not read an earlier run's
/// keys (a fixed key in a 60 s window otherwise accumulates across runs).
async fn docker_server() -> Option<(String, String)> {
    let (name, url) = docker_target()?;
    let mut conn = admin(&url).await;
    let _: () = redis::cmd("FLUSHALL")
        .query_async(&mut conn)
        .await
        .expect("flushall");
    Some((name, url))
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

/// Stopped mid-operation: every primitive answers within the deadline the
/// documented way; on restart (empty script cache) both connections come
/// back without a call having to wait for them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_server_fails_open_and_a_restarted_one_is_rejoined() {
    let _serial = SERIAL.lock().await;
    let Some((name, url)) = docker_server().await else {
        eprintln!("skipped: set OMNI_TEST_REDIS_DOCKER(+_URL) to a disposable container");
        return;
    };
    let a = RedisCoord::connect(&url, opts(300)).await.expect("a");
    let b = RedisCoord::connect(&url, opts(300)).await.expect("b");
    assert!(a.healthy() && a.remote().listening());
    let t = common::unique("t");
    let (frames, _f) = counter(&a, &t);
    let (hellos, _h) = counter(&a, RECONNECTED_TOPIC);
    take(&hellos);
    a.kv_set("sess:x", "v", 60_000).await.expect("kv set");

    docker(&["stop", "-t", "0", &name]).await;
    let started = Instant::now();
    a.window_claim("w", 60_000.0, 1.0).await;
    assert_eq!(a.gauge_acquire("g", 1_000, None).await, Ok(0));
    assert!(!a.lease_acquire("job", "a", 1_000).await);
    assert_eq!(a.kv_get("sess:x").await, Err(CoordError::Unavailable));
    let locked = a.lock("l", 1_000, Duration::from_millis(100)).await;
    assert_eq!(locked, Err(CoordError::LockUnavailable("l".to_owned())));
    a.buckets_add("b", 1_000.0, 60_000.0, 1.0, Counts::default())
        .await;
    // Seven calls, each bounded by the 300 ms deadline at worst.
    assert!(
        started.elapsed() < Duration::from_millis(7 * 350),
        "{:?}",
        started.elapsed()
    );
    assert!(!a.healthy());

    docker(&["start", &name]).await;
    assert!(
        until(Duration::from_secs(10), || async {
            a.remote().incr("probe").await.is_ok()
                && b.remote().incr("probe").await.is_ok()
                && a.remote().listening()
                && b.remote().listening()
        })
        .await,
        "rejoined"
    );
    // Fresh server: scripts were reloaded at reconnect, and EVALSHA works.
    let claim = a.remote().window_claim("w2", 60_000.0, 5.0).await;
    assert_eq!(claim.map(|c| c.before.used), Ok(0.0));
    assert!(
        until(Duration::from_secs(2), || async {
            !hellos.lock().expect("h").is_empty()
        })
        .await
    );
    take(&frames);
    assert_eq!(b.remote().publish(&t, "back").await, Ok(()));
    assert!(
        until(Duration::from_secs(2), || async {
            !frames.lock().expect("f").is_empty()
        })
        .await
    );
    sleep_ms(100).await;
    assert_eq!(take(&frames), vec![format!("{t}=back")]);
    assert!(a.healthy());
    a.close();
    b.close();
}

/// Paused (the socket is open, nothing answers): every call is bounded by
/// the deadline, then the same connection serves again after unpause.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paused_server_is_bounded_by_the_deadline_and_recovers() {
    let _serial = SERIAL.lock().await;
    let Some((name, url)) = docker_server().await else {
        return;
    };
    let quick = || RedisCoordOptions {
        heartbeat: Duration::from_millis(100),
        ..opts(200)
    };
    let a = RedisCoord::connect(&url, quick()).await.expect("a");
    let b = RedisCoord::connect(&url, quick()).await.expect("b");
    let t = common::unique("t");
    let (frames, _f) = counter(&a, &t);
    let (hellos, _h) = counter(&a, RECONNECTED_TOPIC);
    a.window_claim("p", 60_000.0, 1.0).await;
    assert!(a.healthy() && a.remote().listening());
    take(&hellos);
    docker(&["pause", &name]).await;
    let started = Instant::now();
    assert_eq!(a.window_claim("p", 60_000.0, 2.0).await.before.used, 0.0);
    assert_eq!(a.kv_get("x").await, Err(CoordError::Unavailable));
    assert!(!a.lease_acquire("job", "a", 1_000).await);
    assert_eq!(a.remote().incr("n").await, Err(Fault::TimedOut));
    assert!(
        started.elapsed() < Duration::from_millis(4 * 260),
        "{:?}",
        started.elapsed()
    );
    assert!(!a.healthy());
    // The pub/sub heartbeat notices the silent server and stops claiming to
    // listen, so a publish goes through memory (still reaching this process).
    assert!(until(Duration::from_secs(2), || async { !a.remote().listening() }).await);
    a.publish(&t, "local").await;
    assert_eq!(take(&frames), vec![format!("{t}=local")]);
    docker(&["unpause", &name]).await;
    assert!(
        until(Duration::from_secs(5), || async {
            a.remote().incr("n").await.is_ok()
                && b.remote().incr("n").await.is_ok()
                && a.remote().listening()
                && b.remote().listening()
        })
        .await,
        "recovered"
    );
    assert!(a.healthy());
    // Resubscribed: a frame from the other process arrives, once.
    assert!(
        until(Duration::from_secs(2), || async {
            !hellos.lock().expect("h").is_empty()
        })
        .await
    );
    assert_eq!(b.remote().publish(&t, "shared").await, Ok(()));
    assert!(
        until(Duration::from_secs(2), || async {
            !frames.lock().expect("f").is_empty()
        })
        .await
    );
    sleep_ms(100).await;
    assert_eq!(take(&frames), vec![format!("{t}=shared")]);
    // The claim sent into the pause was answered from memory; on the server
    // it lands late (1 before the pause + it = 2, an over-count: the
    // permitted direction) unless its connection was retired first, which
    // may discard it. Never more than was sent, never less than before.
    let claim = a.remote().window_claim("p", 60_000.0, 3.0).await;
    let used = claim.map(|c| c.before.used);
    assert!(matches!(used, Ok(1.0 | 2.0)), "{used:?}");
    a.close();
    b.close();
}
