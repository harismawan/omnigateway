//! The writer's commit capacity, in release builds only: a debug build's
//! number says nothing. Run with
//! `cargo test --release -p omni-store --test writer_throughput -- --nocapture`
//! on a quiet core (`taskset -c 7`).
//!
//! The gateway sends two events per request: a Begin when routing picks a
//! target, then a Finish when it is done. The load here is shaped like the
//! bench's: random `req_<uuid v4>` ids, one key, one model, `at` advancing
//! with the clock, each request finishing 1 ms after it began.

use omni_store::SqliteStore;
use omni_store::writer::{LogEvent, PendingLog, RequestLog, Writer, WriterConfig};
use std::time::{Duration, Instant};

const KEY: &str = "key_0123456789abcdef";
const CRED: &str = "cred_0123456789abcdef";

fn begin(id: &str, at: i64) -> LogEvent {
    LogEvent::Begin(PendingLog {
        id: id.into(),
        at,
        api_key_id: Some(KEY.into()),
        requested_model: "bench-c1".into(),
        resolved_provider: Some("custom".into()),
        resolved_model: Some("mock-c1-d0".into()),
        credential_id: Some(CRED.into()),
    })
}

fn finish(id: &str, at: i64) -> LogEvent {
    let mut log = RequestLog::new(id, at, 200);
    log.api_key_id = Some(KEY.into());
    log.requested_model = "bench-c1".into();
    log.resolved_provider = Some("custom".into());
    log.resolved_model = Some("mock-c1-d0".into());
    log.credential_id = Some(CRED.into());
    log.attempts = 1;
    log.input_tokens = 12;
    log.output_tokens = 5;
    log.ttft_ms = Some(1);
    log.duration_ms = 1;
    log.cost_usd = 0.000_022;
    LogEvent::Finish(log)
}

/// A random v4-shaped id from a counter (splitmix64), as `crypto.randomUUID`
/// spreads them over the key space.
fn uuid_like(n: u64) -> String {
    let mix = |mut z: u64| {
        z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    let (a, b) = (mix(n), mix(n ^ 0x5555_5555_5555_5555));
    format!(
        "req_{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        a >> 32,
        (a >> 16) & 0xffff,
        a & 0xfff,
        0x8000 | (b >> 48) & 0x3fff,
        b & 0xffff_ffff_ffff
    )
}

/// A UUIDv7-shaped id as the gateway mints them: the start's ms timestamp
/// in the top 48 bits, a per-ms counter in `rand_a`, random `rand_b`.
fn v7_like(n: u64, ms: u64) -> String {
    let b = uuid_like(n);
    // Keep v4's random tail (from its 4th group on), replace the head.
    format!(
        "req_{:08x}-{:04x}-7{:03x}-{}",
        ms >> 16,
        ms & 0xffff,
        n & 0xfff,
        &b[23..]
    )
}

/// Which request ids a run mints.
#[derive(Clone, Copy, Debug)]
enum Ids {
    /// `req_<uuid v4>`, as TS mints them.
    V4,
    /// `req_<uuid v7>`, as the Rust gateway mints them.
    V7,
}

/// What a run committed: events per second of wall time, and the drops.
struct Run {
    per_s: f64,
    dropped: u64,
    batches: u64,
}

/// Offers `rate` requests/s for `secs` on a one-worker runtime with one
/// blocking thread, and closes the writer.
fn offer(rate: u64, secs: u64, ids: Ids) -> Run {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("omni.db");
        drop(SqliteStore::open(&db, 0).expect("open"));
        let writer = Writer::spawn(&db, WriterConfig::default()).expect("spawn");
        let handle = writer.handle();
        let started = Instant::now();
        let t0: i64 = 1_794_007_800_000;
        let per_ms = rate / 1000;
        let mut prev: Vec<String> = Vec::new();
        let mut n = 0u64;
        for step in 0..secs * 1000 {
            // Each millisecond begins its share and finishes the last one's.
            let now = t0 + i64::try_from(step).expect("step");
            let ids: Vec<String> = (0..per_ms)
                .map(|_| {
                    n += 1;
                    match ids {
                        Ids::V4 => uuid_like(n),
                        Ids::V7 => v7_like(n, 1_794_007_800_000 + step),
                    }
                })
                .collect();
            for id in &ids {
                handle.send(begin(id, now));
            }
            for id in &prev {
                handle.send(finish(id, now - 1));
            }
            prev = ids;
            tokio::time::sleep_until((started + Duration::from_millis(step + 1)).into()).await;
        }
        for id in &prev {
            handle.send(finish(id, t0));
        }
        let stats = writer.close().await.expect("close");
        #[allow(clippy::cast_precision_loss)]
        let per_s = stats.written as f64 / started.elapsed().as_secs_f64();
        Run {
            per_s,
            dropped: stats.dropped,
            batches: stats.batches,
        }
    })
}

/// 30 k req/s is 60 k events/s. With 512-event batches and SQLite's default
/// checkpoint the writer committed ~45-48 k events/s here on a quiet core
/// with v4 ids and shed; with 4096 and a 10 000-page checkpoint, ~59 k.
#[test]
#[cfg_attr(debug_assertions, ignore = "release builds only")]
fn the_writer_keeps_up_with_30k_requests_per_second_on_one_core() {
    let run = offer(30_000, 10, Ids::V4);
    println!(
        "v4 ids: committed {:.0} events/s, dropped {}, batches {}",
        run.per_s, run.dropped, run.batches
    );
    assert_eq!(run.dropped, 0, "the writer shed at 30 k req/s");
}

/// The gateway's own ids (v7) at 60 k req/s, 120 k events/s: more than its
/// best 4-core rate on the bench rig. v4 ids shed here (the second half of
/// this test shows it), v7 ids must not.
#[test]
#[cfg_attr(debug_assertions, ignore = "release builds only")]
fn time_ordered_ids_keep_up_with_60k_requests_per_second_on_one_core() {
    let v7 = offer(60_000, 10, Ids::V7);
    let v4 = offer(60_000, 10, Ids::V4);
    println!(
        "60k req/s offered: v7 committed {:.0} events/s, dropped {}; v4 committed {:.0} events/s, dropped {}",
        v7.per_s, v7.dropped, v4.per_s, v4.dropped
    );
    assert_eq!(v7.dropped, 0, "v7 ids shed at 60 k req/s");
    assert!(v4.dropped > 0, "the v4 baseline is expected to shed here");
}

/// Eight producer threads sending into the writer at the gateway's full
/// event rate (`XFLOOD=1`: as fast as they can) on the gateway's cores:
/// sends per second, the slowest send, and how many took over 100 µs. For contention between
/// producers, and between producers and barriers; prints, asserts nothing
/// but that it ran. `cargo test --release -p omni-store --test
/// writer_throughput eight -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement, run by hand"]
fn eight_producers_send_rate() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("omni.db");
        drop(SqliteStore::open(&db, 0).expect("open"));
        let writer = Writer::spawn(&db, WriterConfig::default()).expect("spawn");
        let handle = writer.handle();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let barriers = std::env::var_os("XBARRIERS").is_some();
        let producers: Vec<_> = (0..8_u64)
            .map(|p| {
                let h = handle.clone();
                let stop = stop.clone();
                std::thread::spawn(move || {
                    let mut n = 0u64;
                    let mut worst = Duration::ZERO;
                    let mut slow = 0u64;
                    let t0 = Instant::now();
                    // ~8 k sends/s each, 64 k in all: the gateway's event rate
                    // at full throughput (2 per request at ~32 k req/s), so
                    // the queue drains and only contention is measured.
                    let pace = Duration::from_micros(125);
                    let mut next = Instant::now();
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        let id = uuid_like(p << 40 | n);
                        if std::env::var_os("XFLOOD").is_none() {
                            next += pace;
                            while Instant::now() < next {
                                std::hint::spin_loop();
                            }
                        }
                        let t = Instant::now();
                        h.send(begin(&id, 1_794_007_800_000));
                        let took = t.elapsed();
                        worst = worst.max(took);
                        if took > Duration::from_micros(100) {
                            slow += 1;
                        }
                        n += 1;
                    }
                    (n, t0.elapsed(), worst, slow)
                })
            })
            .collect();
        let until = Instant::now() + Duration::from_secs(5);
        let mut taken = 0;
        while Instant::now() < until {
            if barriers {
                if handle.flush().await.is_ok() {
                    taken += 1;
                }
            } else {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let mut total = 0;
        let mut worst = Duration::ZERO;
        let mut slow = 0;
        let mut secs = 0.0;
        for t in producers {
            let (n, e, w, sl) = t.join().expect("producer");
            total += n;
            worst = worst.max(w);
            slow += sl;
            secs = e.as_secs_f64();
        }
        let st = handle.stats();
        #[allow(clippy::cast_precision_loss)]
        let rate = total as f64 / secs;
        println!(
            "8 producers: {rate:.0} sends/s, worst send {worst:?}, sends over 100 us {slow}, dropped {}, barriers {taken}",
            st.dropped
        );
        writer.close().await.ok();
    });
}
