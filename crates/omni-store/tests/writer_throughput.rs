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

/// What a run committed: events per second of wall time, and the drops.
struct Run {
    per_s: f64,
    dropped: u64,
    batches: u64,
}

/// Offers `rate` requests/s for `secs` on a one-worker runtime with one
/// blocking thread, and closes the writer.
fn offer(rate: u64, secs: u64) -> Run {
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
                    uuid_like(n)
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
/// and shed; with 4096 and a 10 000-page checkpoint, ~75 k.
#[test]
#[cfg_attr(debug_assertions, ignore = "release builds only")]
fn the_writer_keeps_up_with_30k_requests_per_second_on_one_core() {
    let run = offer(30_000, 10);
    println!(
        "committed {:.0} events/s, dropped {}, batches {}",
        run.per_s, run.dropped, run.batches
    );
    assert_eq!(run.dropped, 0, "the writer shed at 30 k req/s");
}
