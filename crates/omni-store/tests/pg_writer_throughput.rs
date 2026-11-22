//! The Postgres writer's commit capacity on whatever server
//! `OMNI_TEST_DATABASE_URL` names. A measurement for the report, not a gate:
//! it asserts only that nothing failed. Run with
//! `cargo test -p omni-store --test pg_writer_throughput -- --ignored --nocapture`
//! (and `--release` for a number that means anything about production).
//!
//! The load is the bench's shape (`writer_throughput.rs`): two events per
//! request, a Begin then its Finish a millisecond later, one key, one model,
//! and request ids either random (v4, the legacy mint) or time-ordered (v7, as
//! the gateway mints). Offered as fast as the writer takes them: the
//! channel is sized to the whole run, so nothing is dropped and the figure
//! is what the writer committed per second of wall time.

mod common;

use common::pg::{TestDb, base_url};
use omni_store::pg::{PgConfig, PgStore};
use omni_store::writer::{LogEvent, PendingLog, RequestLog, Writer, WriterConfig};
use std::time::Instant;

fn begin(id: &str, at: i64) -> LogEvent {
    LogEvent::Begin(PendingLog {
        id: id.into(),
        at,
        api_key_id: Some("key_0123456789abcdef".into()),
        requested_model: "bench-c1".into(),
        resolved_provider: Some("custom".into()),
        resolved_model: Some("mock-c1-d0".into()),
        credential_id: Some("cred_0123456789abcdef".into()),
    })
}

fn finish(id: &str, at: i64) -> LogEvent {
    let mut log = RequestLog::new(id, at, 200);
    log.api_key_id = Some("key_0123456789abcdef".into());
    log.requested_model = "bench-c1".into();
    log.resolved_provider = Some("custom".into());
    log.resolved_model = Some("mock-c1-d0".into());
    log.credential_id = Some("cred_0123456789abcdef".into());
    log.attempts = 1;
    log.input_tokens = 12;
    log.output_tokens = 5;
    log.ttft_ms = Some(1);
    log.duration_ms = 1;
    log.cost_usd = 0.000_022;
    LogEvent::Finish(log)
}

fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn id(n: u64, v7: bool) -> String {
    let (a, b) = (mix(n), mix(n ^ 0x5555_5555_5555_5555));
    if v7 {
        let ms = 1_794_007_800_000 + n / 50;
        format!(
            "req_{:08x}-{:04x}-7{:03x}-{:012x}",
            ms >> 16,
            ms & 0xffff,
            n & 0xfff,
            b
        )
    } else {
        format!("req_{:016x}{:016x}", a, b)
    }
}

async fn run(base: &str, requests: u64, v7: bool, max_batch: usize) {
    let db = TestDb::create(base, &format!("tp_{v7}_{max_batch}")).await;
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let writer = Writer::spawn_postgres(
        store,
        WriterConfig {
            node_id: "bench".into(),
            capacity: usize::try_from(requests * 2 + 16).expect("capacity"),
            max_batch,
            ..WriterConfig::default()
        },
    )
    .expect("spawn");
    let h = writer.handle();
    let t0: i64 = 1_794_007_800_000;
    let started = Instant::now();
    let mut prev: Vec<String> = Vec::new();
    for chunk in 0..requests / 50 {
        let at = t0 + i64::try_from(chunk).expect("chunk");
        let ids: Vec<String> = (0..50).map(|i| id(chunk * 50 + i, v7)).collect();
        for i in &ids {
            assert!(h.send(begin(i, at)));
        }
        for i in &prev {
            assert!(h.send(finish(i, at - 1)));
        }
        prev = ids;
        if chunk % 20 == 0 {
            tokio::task::yield_now().await;
        }
    }
    for i in &prev {
        assert!(h.send(finish(i, t0)));
    }
    let stats = writer.close().await.expect("close");
    let secs = started.elapsed().as_secs_f64();
    assert_eq!((stats.failed, stats.dropped), (0, 0));
    #[allow(clippy::cast_precision_loss)]
    let per_s = stats.written as f64 / secs;
    println!(
        "pg writer ({} build): ids={} max_batch={max_batch} events={} batches={} \
         {:.0} events/s ({:.0} req/s) in {:.2}s",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        if v7 { "v7" } else { "v4" },
        stats.written,
        stats.batches,
        per_s,
        per_s / 2.0,
        secs
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "a measurement; run explicitly"]
async fn postgres_writer_throughput() {
    let Some(base) = base_url("postgres_writer_throughput") else {
        return;
    };
    for (v7, max_batch) in [(false, 4096), (true, 4096), (true, 512)] {
        run(&base, 100_000, v7, max_batch).await;
    }
}
