//! Fix round 2 regressions (review `d2-r1-review.md`, R1–R5 and minors),
//! against a real server, a TCP proxy, or a fake server the test scripts.
//!
//! Serialised: some of these stall or flush the shared server.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use common::{Proxy, fake_server, fresh_db, host_port, read_request, redis_base, sleep_ms};
use omni_coord::redis::{Fault, Refused};
use omni_coord::{Coord, CoordError, RedisCoord, RedisCoordOptions};
use tokio::io::AsyncWriteExt;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn opts(command_timeout_ms: u64) -> RedisCoordOptions {
    RedisCoordOptions {
        command_timeout: Duration::from_millis(command_timeout_ms),
        fault_log_interval: Duration::ZERO,
        ..RedisCoordOptions::default()
    }
}

/// A server that stalls ~0.5 s on every connection.
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

// --- R1: hostile replies -----------------------------------------------------

/// What a hostile server managed to push before the client hung up.
#[derive(Default)]
struct Pushed {
    bytes: AtomicUsize,
    closed: std::sync::atomic::AtomicBool,
}

/// A server that answers the handshake normally, then answers the first
/// coordinator command with `hostile()` chunks — repeated until the client
/// closes the connection or 3 s pass — recording what it pushed.
async fn hostile_server(
    hostile: Arc<dyn Fn() -> Vec<Vec<u8>> + Send + Sync>,
    repeat: bool,
) -> (u16, Arc<Pushed>) {
    let pushed = Arc::new(Pushed::default());
    let seen = Arc::clone(&pushed);
    let (port, _task) = fake_server(move |r, mut w| {
        let hostile = Arc::clone(&hostile);
        let seen = Arc::clone(&seen);
        async move {
            let mut r = tokio::io::BufReader::new(r);
            let mut attacked = false;
            while let Some(req) = read_request(&mut r).await {
                let cmd = req
                    .first()
                    .map(|s| s.to_ascii_uppercase())
                    .unwrap_or_default();
                let reply: Vec<u8> = match cmd.as_str() {
                    "SCRIPT" => {
                        let sha = redis::Script::new(&req[2]).get_hash().to_owned();
                        format!("${}\r\n{sha}\r\n", sha.len()).into_bytes()
                    }
                    "PING" => b"+PONG\r\n".to_vec(),
                    "INCR" | "ECHO" => {
                        attacked = true;
                        let until = Instant::now() + Duration::from_secs(3);
                        'push: loop {
                            for chunk in hostile() {
                                match tokio::time::timeout(
                                    Duration::from_millis(200),
                                    w.write_all(&chunk),
                                )
                                .await
                                {
                                    Ok(Ok(())) => {
                                        seen.bytes.fetch_add(chunk.len(), Ordering::SeqCst);
                                    }
                                    Ok(Err(e)) if disconnected(&e) => {
                                        seen.closed.store(true, Ordering::SeqCst);
                                        return;
                                    }
                                    Ok(Err(e)) => panic!("writing hostile reply: {e}"),
                                    // Not draining: the client stopped reading
                                    // without closing. Keep trying until the end.
                                    Err(_) => {}
                                }
                                if Instant::now() > until {
                                    break 'push;
                                }
                            }
                            if !repeat {
                                break;
                            }
                        }
                        continue;
                    }
                    _ => b"+OK\r\n".to_vec(),
                };
                if let Err(e) = w.write_all(&reply).await {
                    // The startup PING can be buffered behind INCR. The
                    // reply then sees a reset instead of read_request seeing
                    // EOF. Only the socket we attacked can prove a hang-up.
                    if attacked && disconnected(&e) {
                        seen.closed.store(true, Ordering::SeqCst);
                    }
                    return;
                }
            }
            if attacked {
                seen.closed.store(true, Ordering::SeqCst);
            }
        }
    })
    .await;
    (port, pushed)
}

fn disconnected(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
    )
}

/// The reply side is bounded: a never-terminated header line, a huge
/// declared array of nils, and deep nesting each make the client hang up
/// after absorbing a bounded number of bytes (`max_reply_bytes` plus socket
/// buffers), within seconds, and the call fails within its deadline.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hostile_replies_are_bounded_and_the_connection_dropped() {
    let _serial = SERIAL.lock().await;
    type Gen = Arc<dyn Fn() -> Vec<Vec<u8>> + Send + Sync>;
    let cases: Vec<(&str, Gen, bool)> = vec![
        (
            "endless header line",
            Arc::new(|| {
                let mut v = vec![b"+".to_vec()];
                v.extend(std::iter::repeat_n(vec![b'a'; 64 * 1024], 64));
                v
            }),
            true,
        ),
        (
            "array of 67 million nils",
            Arc::new(|| {
                let mut v = vec![b"*67108864\r\n".to_vec()];
                v.extend(std::iter::repeat_n(b"$-1\r\n".repeat(16 * 1024), 64));
                v
            }),
            true,
        ),
        (
            "deep nesting",
            Arc::new(|| vec![b"*1\r\n".repeat(100_000)]),
            false,
        ),
    ];
    for (name, hostile, repeat) in cases {
        let (port, pushed) = hostile_server(hostile, repeat).await;
        let coord = RedisCoord::connect(
            &format!("redis://127.0.0.1:{port}"),
            RedisCoordOptions {
                max_reply_bytes: 1024 * 1024,
                ..opts(500)
            },
        )
        .await
        .expect("connect");
        let started = Instant::now();
        let got = coord.remote().incr("n").await;
        assert!(got.is_err(), "{name}: {got:?}");
        assert!(
            started.elapsed() < Duration::from_millis(1_500),
            "{name}: {:?}",
            started.elapsed()
        );
        let hung_up = Instant::now();
        while !pushed.closed.load(Ordering::SeqCst) {
            assert!(
                hung_up.elapsed() < Duration::from_secs(4),
                "{name}: client never closed the connection; absorbed {} bytes",
                pushed.bytes.load(Ordering::SeqCst)
            );
            sleep_ms(20).await;
        }
        let absorbed = pushed.bytes.load(Ordering::SeqCst);
        assert!(
            absorbed < 32 * 1024 * 1024,
            "{name}: absorbed {absorbed} bytes"
        );
        coord.close();
    }
}

/// Malformed lengths below -1 never yield a success the caller acts on, a
/// valid nested reply delivered one byte at a time is decoded, and a large
/// reply delivered in small fragments decodes in linear time (a decoder that
/// reparsed from the start on every fragment would take minutes here).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_lengths_fail_and_fragmented_replies_decode() {
    let _serial = SERIAL.lock().await;
    for bytes in [
        b"$-2\r\n".to_vec(),
        b"*-2\r\n".to_vec(),
        b"$-9223372036854775808\r\n".to_vec(),
    ] {
        let reply = bytes.clone();
        let (port, _) = hostile_server(Arc::new(move || vec![reply.clone()]), false).await;
        let coord = RedisCoord::connect(&format!("redis://127.0.0.1:{port}"), opts(500))
            .await
            .expect("connect");
        let got = coord.remote().query(redis::cmd("ECHO")).await;
        assert!(
            got.is_err(),
            "{:?}: {got:?}",
            String::from_utf8_lossy(&bytes)
        );
        coord.close();
    }
    let (port, _) = hostile_server(
        Arc::new(|| {
            b"*2\r\n*2\r\n:1\r\n$3\r\nabc\r\n:7\r\n"
                .iter()
                .map(|b| vec![*b])
                .collect()
        }),
        false,
    )
    .await;
    let coord = RedisCoord::connect(&format!("redis://127.0.0.1:{port}"), opts(1_000))
        .await
        .expect("connect");
    let out = coord.remote().query(redis::cmd("ECHO")).await;
    assert_eq!(
        out,
        Ok(redis::Value::Array(vec![
            redis::Value::Array(vec![
                redis::Value::Int(1),
                redis::Value::BulkString(b"abc".to_vec())
            ]),
            redis::Value::Int(7)
        ]))
    );
    coord.close();

    // 100 000 elements (~400 KB) in 7-byte fragments.
    let (port, _) = hostile_server(
        Arc::new(|| {
            let mut frame = b"*100000\r\n".to_vec();
            frame.extend(b":1\r\n".repeat(100_000));
            frame.chunks(7).map(<[u8]>::to_vec).collect()
        }),
        false,
    )
    .await;
    let coord = RedisCoord::connect(&format!("redis://127.0.0.1:{port}"), opts(5_000))
        .await
        .expect("connect");
    let started = Instant::now();
    let out = coord.remote().query(redis::cmd("ECHO")).await;
    assert!(
        matches!(&out, Ok(redis::Value::Array(v)) if v.len() == 100_000),
        "{:?}",
        out.map(|_| ())
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    coord.close();
}

// --- R2: pipelines are charged by command count and bytes ---------------------

/// A pipeline costs its length and its bytes. One far past the per-request
/// bounds is refused outright; one within them but past what admissions may
/// use is `Saturated`; and a release queued behind a large pipeline still
/// lands before an admission issued after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pipelines_are_charged_by_commands_and_bytes() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(
        &db.url,
        RedisCoordOptions {
            queue_capacity: 256,
            release_reserve: 32,
            ..opts(3_000)
        },
    )
    .await
    .expect("connect");
    let remote = coord.remote().clone();

    // A 200 000-PING pipeline: never admitted, and nothing is retained.
    let mut huge = redis::pipe();
    for _ in 0..200_000 {
        huge.cmd("PING");
    }
    let refused = remote.pipeline(huge).await;
    assert!(
        matches!(refused, Err(Fault::TooLarge | Fault::Saturated)),
        "{refused:?}"
    );
    assert_eq!(remote.outstanding(), 0);

    // One huge argument: refused by the byte bound.
    let mut big = redis::cmd("SET");
    big.arg("k").arg(vec![b'x'; 64 * 1024 * 1024]);
    assert_eq!(remote.query(big).await, Err(Fault::TooLarge));

    // Within bounds: a 200-command pipeline behind a stalled server uses 200
    // of the 224 admissions may take; a 30-command one no longer fits.
    assert_eq!(
        remote.gauge_acquire("lim", 0.0, 60_000, Some("a")).await,
        Ok(0)
    );
    let spinning = spin(&db.url).await;
    let mut p200 = redis::pipe();
    for i in 0..200 {
        p200.cmd("INCR").arg(format!("n{i}"));
    }
    let first = {
        let r = remote.clone();
        tokio::spawn(async move { r.pipeline(p200).await })
    };
    while remote.outstanding() < 200 {
        sleep_ms(1).await;
    }
    let mut p30 = redis::pipe();
    for _ in 0..30 {
        p30.cmd("PING");
    }
    assert_eq!(remote.pipeline(p30).await, Err(Fault::Saturated));
    // The release goes into the reserve and lands before the next acquire.
    assert_eq!(remote.gauge_release_detached("lim", 0.0, Some("a")), Ok(()));
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
    spinning.await.expect("spin");
    assert_eq!(first.await.expect("task").map(|v| v.len()), Ok(200));
    assert_eq!(after.await.expect("task"), Ok(0));
    coord.close();
}

// --- R3: blank named holder; executed-but-reply-lost replay -----------------

/// `gauge_release_detached(Some(""))` is the anonymous sentinel on the wire:
/// refused at the boundary, never queued as replay-safe.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_blank_named_holder_is_refused_by_the_detached_release() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(1_000))
        .await
        .expect("connect");
    let remote = coord.remote();
    remote
        .gauge_acquire("g", 0.0, 60_000, Some("a"))
        .await
        .expect("a");
    remote
        .gauge_acquire("g", 0.0, 60_000, Some("b"))
        .await
        .expect("b");
    let dropped = remote.releases_dropped();
    assert_eq!(
        remote.gauge_release_detached("g", 0.0, Some("")),
        Err(Refused::Invalid)
    );
    assert_eq!(remote.releases_dropped(), dropped + 1);
    assert_eq!(remote.gauge_read("g", 0.0).await, Ok(2));
    coord.close();
}

/// Executed but the reply lost (only the server→client direction is
/// dropped): a named release is replayed on the next connection — harmless,
/// one slot goes; an anonymous one is not replayed — exactly one slot goes,
/// never two.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_executed_release_whose_reply_is_lost_is_replayed_only_if_idempotent() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    for named in [true, false] {
        common::flush(&db.url).await;
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
        let remote = coord.remote().clone();
        for h in ["a", "b", "c"] {
            remote
                .gauge_acquire("g", 0.0, 60_000, Some(h))
                .await
                .expect("acquire");
        }
        proxy.drop_replies_existing();
        let holder = if named { Some("a") } else { None };
        assert_eq!(remote.gauge_release_detached("g", 0.0, holder), Ok(()));
        // It executes (requests still flow); its reply never arrives; the
        // connection is retired and a fresh one takes over.
        let started = Instant::now();
        let mut read = None;
        while started.elapsed() < Duration::from_secs(5) {
            if let Ok(n) = remote.gauge_read("g", 0.0).await {
                read = Some(n);
                break;
            }
            sleep_ms(50).await;
        }
        sleep_ms(300).await;
        let read = remote.gauge_read("g", 0.0).await.ok().or(read);
        assert_eq!(read, Some(2), "named={named}: exactly one slot released");
        if !named {
            assert!(
                remote.releases_dropped() >= 1,
                "the uncertain anonymous release is counted"
            );
        }
        coord.close();
    }
}

// --- R4: server error replies are faults ----------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn server_error_replies_count_as_faults_on_remote_and_coord() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(1_000))
        .await
        .expect("connect");
    let mut admin = common::admin(&db.url).await;
    let _: () = redis::cmd("SET")
        .arg("omni:seq:n")
        .arg("not a number")
        .query_async(&mut admin)
        .await
        .expect("set");
    // Direct Remote.
    assert_eq!(coord.remote().incr("ok").await, Ok(1));
    assert!(coord.healthy());
    let faults = coord.faults();
    assert!(matches!(
        coord.remote().incr("n").await,
        Err(Fault::Server(_))
    ));
    assert_eq!(coord.faults(), faults + 1);
    assert!(!coord.healthy());
    // Through Coord: answered from memory, and still a fault.
    assert_eq!(coord.remote().incr("ok").await, Ok(2));
    let faults = coord.faults();
    assert_eq!(coord.incr("n").await, 1);
    assert_eq!(coord.faults(), faults + 1);
    assert!(!coord.healthy());
    // A pipeline with one failing command.
    assert_eq!(coord.remote().incr("ok").await, Ok(3));
    let faults = coord.faults();
    let mut pipe = redis::pipe();
    pipe.cmd("INCR")
        .arg("omni:seq:ok")
        .cmd("INCR")
        .arg("omni:seq:n");
    assert!(matches!(
        coord.remote().pipeline(pipe).await,
        Err(Fault::Server(_))
    ));
    assert_eq!(coord.faults(), faults + 1);
    assert!(!coord.healthy());
    // NOSCRIPT is still retried once, and that is a success.
    let _: () = redis::cmd("SCRIPT")
        .arg("FLUSH")
        .query_async(&mut admin)
        .await
        .expect("flush");
    let faults = coord.faults();
    assert!(coord.remote().gauge_read("g", 0.0).await.is_ok());
    assert_eq!(coord.faults(), faults);
    assert!(coord.healthy());
    coord.close();
}

// --- R5: one deadline for the whole prefix delete -----------------------------

/// A server whose every `SCAN` page takes 300 ms and never ends (cursor
/// never returns to 0): `kv_del_prefix` with a 1 s command deadline gives up
/// within about that, not after any number of pages.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kv_del_prefix_is_bounded_by_one_deadline() {
    let _serial = SERIAL.lock().await;
    let pages = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&pages);
    let (port, _task) = fake_server(move |r, mut w| {
        let seen = Arc::clone(&seen);
        async move {
            let mut r = tokio::io::BufReader::new(r);
            while let Some(req) = read_request(&mut r).await {
                let cmd = req
                    .first()
                    .map(|s| s.to_ascii_uppercase())
                    .unwrap_or_default();
                let reply = match cmd.as_str() {
                    "SCRIPT" => {
                        let sha = redis::Script::new(&req[2]).get_hash().to_owned();
                        format!("${}\r\n{sha}\r\n", sha.len())
                    }
                    "SCAN" => {
                        seen.fetch_add(1, Ordering::SeqCst);
                        sleep_ms(300).await;
                        "*2\r\n$1\r\n7\r\n*1\r\n$12\r\nomni:kv:s:k1\r\n".to_owned()
                    }
                    "PING" => "+PONG\r\n".to_owned(),
                    _ => "+OK\r\n".to_owned(),
                };
                if w.write_all(reply.as_bytes()).await.is_err() {
                    return;
                }
            }
        }
    })
    .await;
    let coord = RedisCoord::connect(&format!("redis://127.0.0.1:{port}"), opts(1_000))
        .await
        .expect("connect");
    let started = Instant::now();
    assert_eq!(
        coord.kv_del_prefix("s:").await,
        Err(CoordError::Unavailable)
    );
    let took = started.elapsed();
    assert!(took < Duration::from_millis(1_400), "{took:?}");
    assert!(pages.load(Ordering::SeqCst) <= 5);
    coord.close();
}

// --- M1: pipeline .ignore() ---------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pipeline_ignore_is_preserved() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(1_000))
        .await
        .expect("connect");
    let mut pipe = redis::pipe();
    pipe.cmd("SET")
        .arg("k")
        .arg("v")
        .ignore()
        .cmd("GET")
        .arg("k");
    assert_eq!(
        coord.remote().pipeline(pipe).await,
        Ok(vec![redis::Value::BulkString(b"v".to_vec())])
    );
    coord.close();
}

// --- M4: the drain deadline runs from close() -----------------------------------

/// The drain bound is measured from `close()`, even when the link task is
/// slow to observe it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_drain_deadline_is_measured_from_close() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let proxy = Proxy::start(&host_port(&base)).await;
    let url = format!("redis://127.0.0.1:{}/{}", proxy.port, db.index);
    let coord = RedisCoord::connect(
        &url,
        RedisCoordOptions {
            drain_timeout: Duration::from_millis(300),
            ..opts(5_000)
        },
    )
    .await
    .expect("connect");
    coord
        .remote()
        .gauge_acquire("g", 0.0, 60_000, Some("a"))
        .await
        .expect("a");
    proxy.freeze_existing();
    assert_eq!(
        coord.remote().gauge_release_detached("g", 0.0, Some("a")),
        Ok(())
    );
    let closed = Instant::now();
    coord.close();
    // Starve nothing; just wait for the drain to stop.
    coord.shutdown().await;
    let took = closed.elapsed();
    assert!(took < Duration::from_millis(450), "{took:?}");
    assert!(coord.remote().releases_dropped() >= 1);
}

// --- ordering through the redis-rs connection -----------------------------------

/// The ordered-queue guarantee, with redis-rs carrying the wire: across many
/// concurrent submitters, every detached release is executed before every
/// admission submitted after it returned. Each round: hold a named slot,
/// release it detached, and immediately acquire under `concurrency: 1` from
/// the same task — while 16 other tasks flood the connection with commands.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn releases_precede_later_admissions_under_concurrent_load() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(3_000))
        .await
        .expect("connect");
    let remote = coord.remote().clone();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut noise = Vec::new();
    for t in 0..16 {
        let r = remote.clone();
        let stop = Arc::clone(&stop);
        noise.push(tokio::spawn(async move {
            let mut n = 0_u64;
            while !stop.load(Ordering::SeqCst) {
                let got = r.incr(&format!("noise{t}")).await;
                assert!(matches!(got, Ok(_) | Err(Fault::Saturated)), "{got:?}");
                n += 1;
            }
            n
        }));
    }
    let mut wrong = Vec::new();
    for round in 0..500 {
        let key = format!("c1:{}", round % 7);
        let holder = format!("h{round}");
        let got = remote.gauge_acquire(&key, 0.0, 60_000, Some(&holder)).await;
        if got != Ok(0) {
            wrong.push((round, "acquire", got));
            continue;
        }
        assert_eq!(
            remote.gauge_release_detached(&key, 0.0, Some(&holder)),
            Ok(())
        );
    }
    stop.store(true, Ordering::SeqCst);
    let mut total = 0;
    for n in noise {
        total += n.await.expect("noise");
    }
    assert!(wrong.is_empty(), "admission overtook a release: {wrong:?}");
    assert!(
        total > 1_000,
        "the connection was actually contended ({total})"
    );
    assert_eq!(remote.releases_dropped(), 0);
    coord.close();
}

/// R5, the finishing case: slow pages that do end, under the deadline, are
/// all deleted; the deadline is the operation's, not per page.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kv_del_prefix_finishes_within_one_deadline_over_many_pages() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(2_000))
        .await
        .expect("connect");
    for i in 0..5_000 {
        coord
            .kv_set(&format!("sess:admin:{i}"), "v", 60_000)
            .await
            .expect("set");
    }
    coord.kv_set("other:1", "v", 60_000).await.expect("set");
    coord.kv_del_prefix("sess:").await.expect("del prefix");
    assert_eq!(coord.kv_get("sess:admin:4999").await, Ok(None));
    assert_eq!(coord.kv_get("other:1").await, Ok(Some("v".to_owned())));
    coord.close();
}
