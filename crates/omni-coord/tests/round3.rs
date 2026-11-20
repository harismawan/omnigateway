//! Fix round 3 regressions (review `d2-r2-review.md`: N1, N2 and minors),
//! against a real server or a TCP proxy the test controls.
//!
//! Serialised: some of these stall the shared server.

mod common;

use std::time::{Duration, Instant};

use common::{Proxy, WriteStall, fresh_db, host_port, redis_base, settle_startup_ping, sleep_ms};
use omni_coord::redis::{CoordScript, Fault};
use omni_coord::{RedisCoord, RedisCoordOptions};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn opts(command_timeout_ms: u64) -> RedisCoordOptions {
    RedisCoordOptions {
        command_timeout: Duration::from_millis(command_timeout_ms),
        fault_log_interval: Duration::ZERO,
        ..RedisCoordOptions::default()
    }
}

/// Waits for `cond`, failing the test past `limit` (well inside the
/// stall's 20 s safety timeout) instead of spinning on a regression.
async fn observe_within(limit: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !cond() {
        assert!(
            Instant::now() < deadline,
            "not observed within {limit:?}: {what}"
        );
        tokio::task::yield_now().await;
    }
}

// --- N1: no-response requests ------------------------------------------------

/// A `Cmd` flagged no-response must not escape the budget: it is either
/// refused, or kept charged until its reply. With the server stalled, a flood
/// of them never drops `outstanding` below what was accepted, never exceeds
/// capacity, and a release submitted after them still lands before the next
/// acquire.
///
/// The flood is of a *write* (`INCR`): `CLIENT PAUSE WRITE` holds writes and
/// scripts but answers reads such as `PING` at once, so a `PING` would let a
/// correct implementation that accepted the command, charged it and awaited
/// its reply finish during the "stall" and be misread as the bug. With a
/// held write, either outcome is judged correctly: refused (`Invalid`, what
/// D2 does), or accepted and still charged until its reply.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_response_commands_stay_charged_and_cannot_break_release_order() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(
        &db.url,
        RedisCoordOptions {
            queue_capacity: 64,
            release_reserve: 16,
            ..opts(3_000)
        },
    )
    .await
    .expect("connect");
    let remote = coord.remote().clone();
    assert_eq!(
        remote.gauge_acquire("lim", 0.0, 60_000, Some("a")).await,
        Ok(0)
    );

    let spinning = WriteStall::start(&db.url).await;
    let mut accepted = 0_usize;
    for _ in 0..200 {
        let mut write = redis::cmd("INCR");
        write.arg("held");
        write.set_no_response(true);
        let r = remote.clone();
        let before = remote.outstanding();
        // Not awaited to completion: submission is on the first poll.
        let mut call = tokio::spawn(async move { r.query(write).await });
        // Classified by what is observed, never by a timer: either the call
        // finishes (refused, or — the bug — answered during the stall), or
        // its charge shows in `outstanding` (accepted, waiting for its
        // reply). A refused call whose task was merely slow to be scheduled
        // used to be counted as accepted by a 2 ms timeout.
        let observe = Instant::now() + Duration::from_secs(2);
        loop {
            if call.is_finished() {
                match (&mut call).await {
                    Ok(Err(Fault::Saturated | Fault::Invalid)) => {}
                    Ok(other) => {
                        // Answered while the server is stalled: it never
                        // waited for its reply.
                        panic!("a no-response command completed during the stall: {other:?}");
                    }
                    Err(e) => panic!("{e}"),
                }
                break;
            }
            if remote.outstanding() > before {
                accepted += 1;
                break;
            }
            assert!(
                Instant::now() < observe,
                "a call neither finished nor was charged"
            );
            tokio::task::yield_now().await;
        }
        assert!(remote.outstanding() <= 64, "{}", remote.outstanding());
    }
    // A pipeline carrying a no-response command is refused the same way.
    let mut pipe = redis::pipe();
    pipe.cmd("INCR").arg("held");
    let mut quiet = redis::cmd("INCR");
    quiet.arg("held");
    quiet.set_no_response(true);
    pipe.add_command(quiet);
    assert_eq!(remote.pipeline(pipe).await, Err(Fault::Invalid));
    // Whatever was accepted is still charged.
    assert!(
        remote.outstanding() >= accepted.min(48),
        "{} < {accepted}",
        remote.outstanding()
    );
    assert_eq!(remote.gauge_release_detached("lim", 0.0, Some("a")), Ok(()));
    let after = {
        let r = remote.clone();
        tokio::spawn(async move {
            loop {
                match r.gauge_acquire("lim", 0.0, 60_000, Some("b")).await {
                    Err(Fault::Saturated) => sleep_ms(1).await,
                    other => return other,
                }
            }
        })
    };
    // The release and the acquire are both queued behind the stall; their
    // order on the wire is what is tested, so the stall ends only now.
    observe_within(Duration::from_secs(5), "release and acquire queued", || {
        remote.outstanding() >= accepted.min(48) + 2
    })
    .await;
    spinning.end().await;
    assert_eq!(after.await.expect("task"), Ok(0), "release was overtaken");
    coord.close();
}

// --- N2: the EVAL fallback is charged -------------------------------------

/// A script with a large source: the `EVAL` kept for a `NOSCRIPT` retry is
/// counted against the byte budget before the call is accepted. Calls whose
/// fallback would exceed `max_request_bytes` are refused up front; calls
/// that fit are charged for both forms, so `queue_bytes` bounds what is
/// retained while the server is stalled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_eval_fallback_is_validated_and_charged() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    // 2 MiB of Lua comment, then `return 1`: over the 1 MiB request cap.
    let huge: &'static str =
        Box::leak(format!("--{}\nreturn 1", "x".repeat(2 * 1024 * 1024)).into_boxed_str());
    let huge = CoordScript::new("HUGE", huge);
    // 600 KiB: under the request cap, so admitted, but charged in full.
    // Use a fresh digest even when a previous run populated the script cache.
    let big: &'static str = Box::leak(
        format!(
            "--{}{}\nreturn 1",
            common::unique("fallback"),
            "y".repeat(600 * 1024)
        )
        .into_boxed_str(),
    );
    let big = CoordScript::new("BIG", big);
    let coord = RedisCoord::connect(
        &db.url,
        RedisCoordOptions {
            queue_bytes: 4 * 1024 * 1024,
            release_reserve_bytes: 1024 * 1024,
            heartbeat: Duration::from_secs(60),
            ..opts(3_000)
        },
    )
    .await
    .expect("connect");
    let remote = coord.remote().clone();
    settle_startup_ping(&base, &db, &remote).await;

    // Hold writes before checking the refusal and throughout admission.
    let spinning = WriteStall::start(&db.url).await;
    assert_eq!(remote.eval(&huge, &[], &[]).await, Err(Fault::TooLarge));
    assert_eq!(remote.outstanding_bytes(), 0, "oversized EVAL was charged");

    // Submit BIG calls until the budget refuses one.
    let mut held = Vec::new();
    let refused = loop {
        let mut call = Box::pin(remote.eval(&big, &[], &[]));
        // Admission is synchronous on first poll. An accepted EVALSHA is
        // held by CLIENT PAUSE WRITE; an unrelated PING can change the
        // counters but cannot change this call's outcome.
        if let Poll::Ready(out) = call.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            break out;
        }
        held.push(call);
        assert!(
            held.len() < 50,
            "the byte budget never refused a retained fallback"
        );
    };
    assert_eq!(refused, Err(Fault::Saturated));
    assert!(!held.is_empty(), "the byte budget admitted no fallbacks");
    // Each accepted call is charged at least its fallback source.
    assert!(
        remote.outstanding_bytes() >= held.len() * 600 * 1024,
        "{}",
        remote.outstanding_bytes()
    );
    assert!(remote.outstanding_bytes() <= 3 * 1024 * 1024);
    assert!(
        held.len() <= 5,
        "{} calls retained 600 KiB each under a 3 MiB budget",
        held.len()
    );
    spinning.end().await;
    for h in held {
        // Not loaded at connect (not in `extra_scripts`): NOSCRIPT, then EVAL.
        assert_eq!(h.await, Ok(redis::Value::Int(1)));
    }
    assert_eq!(
        remote.outstanding_bytes(),
        0,
        "every charge refunded before returning from the retries"
    );
    coord.close();
}

// --- ordering: same key, immediate reacquire, filled channel ------------------

/// Release then *immediately* reacquire the same key under `concurrency: 1`,
/// while the server is stalled and other callers have queued ~9 MiB of
/// writes behind it — more than loopback socket buffers hold, so the
/// `redis` crate's driver is blocked on the socket and requests back up in
/// its channel. (The channel itself cannot fill: it has `queue_capacity + 1`
/// slots and at most `queue_capacity` ops are outstanding — the invariant
/// `Handoff` relies on, and which N1/N2 keep true.) Every reacquire must see
/// the release.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn release_then_immediate_reacquire_of_the_same_key_under_backpressure() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(
        &db.url,
        RedisCoordOptions {
            queue_capacity: 128,
            release_reserve: 32,
            queue_bytes: 32 * 1024 * 1024,
            ..opts(5_000)
        },
    )
    .await
    .expect("connect");
    let remote = coord.remote().clone();
    let mut wrong = Vec::new();
    for round in 0..20 {
        let key = "c1";
        let holder = format!("h{round}");
        assert_eq!(
            remote.gauge_acquire(key, 0.0, 60_000, Some(&holder)).await,
            Ok(0),
            "round {round}"
        );
        // Stall and fill: 90 admissions from other tasks queue behind it.
        let spinning = WriteStall::start(&db.url).await;
        let mut noise = Vec::new();
        for t in 0..90 {
            let r = remote.clone();
            noise.push(tokio::spawn(async move {
                let mut set = redis::cmd("SET");
                set.arg(format!("noise{t}")).arg(vec![b'z'; 100 * 1024]);
                r.query(set).await
            }));
        }
        observe_within(Duration::from_secs(5), "noise queued", || {
            remote.outstanding() >= 90
        })
        .await;
        assert!(remote.outstanding_bytes() > 8 * 1024 * 1024);
        // Release, then immediately reacquire the same key, same task.
        assert_eq!(
            remote.gauge_release_detached(key, 0.0, Some(&holder)),
            Ok(())
        );
        let next = format!("n{round}");
        let queued = remote.outstanding();
        let reacquire = {
            let r = remote.clone();
            let next = next.clone();
            tokio::spawn(async move {
                loop {
                    match r.gauge_acquire(key, 0.0, 60_000, Some(&next)).await {
                        Err(Fault::Saturated) => tokio::task::yield_now().await,
                        other => break other,
                    }
                }
            })
        };
        // Both queued behind the stall (the release charged when it was
        // accepted, the reacquire now): only then does the stall end.
        observe_within(Duration::from_secs(5), "reacquire queued", || {
            remote.outstanding() > queued
        })
        .await;
        spinning.end().await;
        let reacquire = reacquire.await.expect("reacquire");
        for n in noise {
            let _done = n.await.expect("noise").is_ok();
        }
        if reacquire != Ok(0) {
            wrong.push((round, reacquire));
        }
        // Leave the key empty for the next round.
        remote
            .gauge_release(key, 0.0, Some(&next))
            .await
            .expect("release");
    }
    assert!(
        wrong.is_empty(),
        "reacquire overtook the release: {wrong:?}"
    );
    assert_eq!(remote.releases_dropped(), 0);
    coord.close();
}

// --- minors -----------------------------------------------------------------

/// A call whose absolute deadline has already passed is not submitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_expired_deadline_submits_nothing() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let proxy = Proxy::start(&host_port(&base)).await;
    let url = format!("redis://127.0.0.1:{}/{}", proxy.port, db.index);
    // A zero command timeout: every call's deadline is already due.
    let coord = RedisCoord::connect(
        &url,
        RedisCoordOptions {
            command_timeout: Duration::ZERO,
            heartbeat: Duration::from_secs(60),
            ..opts(0)
        },
    )
    .await
    .expect("connect");
    let started = Instant::now();
    assert_eq!(coord.remote().incr("n").await, Err(Fault::TimedOut));
    assert!(started.elapsed() < Duration::from_millis(50));
    assert_eq!(coord.remote().outstanding(), 0, "nothing was queued");
    // Prove it on the server too.
    let mut admin = common::admin(&db.url).await;
    let n: Option<i64> = redis::cmd("GET")
        .arg("omni:seq:n")
        .query_async(&mut admin)
        .await
        .expect("get");
    sleep_ms(100).await;
    let n2: Option<i64> = redis::cmd("GET")
        .arg("omni:seq:n")
        .query_async(&mut admin)
        .await
        .expect("get");
    assert_eq!((n, n2), (None, None));
    coord.close();
}

/// A RESP3 URL is refused clearly at construction (this coordinator speaks
/// RESP2 on both connections), not left failing every handshake.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resp3_url_is_refused_clearly() {
    let _serial = SERIAL.lock().await;
    let err = RedisCoord::connect("redis://127.0.0.1:1/?protocol=resp3", opts(500))
        .await
        .expect_err("refused");
    assert!(err.to_string().contains("RESP3"), "{err}");
}

/// `.ignore_errors()` is the caller's explicit opt-in to per-command error
/// values; the coordinator honours it and the call is a success (not a
/// fault). Without it, any command's error fails the call and counts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pipeline_ignore_errors_is_an_explicit_opt_in() {
    let _serial = SERIAL.lock().await;
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let coord = RedisCoord::connect(&db.url, opts(1_000))
        .await
        .expect("connect");
    let mut admin = common::admin(&db.url).await;
    let _: () = redis::cmd("SET")
        .arg("str")
        .arg("x")
        .query_async(&mut admin)
        .await
        .expect("set");
    let faults = coord.faults();
    let mut pipe = redis::pipe();
    pipe.ignore_errors()
        .cmd("INCR")
        .arg("str")
        .cmd("INCR")
        .arg("ok");
    let out = coord.remote().pipeline(pipe).await.expect("opted in");
    assert!(
        matches!(
            out.as_slice(),
            [redis::Value::ServerError(_), redis::Value::Int(1)]
        ),
        "{out:?}"
    );
    assert_eq!(coord.faults(), faults);
    coord.close();
}
