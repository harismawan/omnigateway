//! Long-window accounting through the real request-log writer: debits are
//! delivered after commit, seeds are read on the writer's connection, both on
//! one ordered stream. Every completion is counted exactly once.

use omni_gateway_core::ratelimit::RateLimiter;
use omni_store::SqliteStore;
use omni_store::limits::{LimitConfig, parse_limits};
use omni_store::writer::{Committed, LogEvent, RequestLog, Writer, WriterConfig, WriterHandle};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

const T0: f64 = 1_794_000_000_000.0;
const KEY: &str = "k1";

struct H {
    _dir: tempfile::TempDir,
    store: SqliteStore,
    writer: Option<Writer>,
    handle: WriterHandle,
    commits: mpsc::Receiver<Committed>,
    limiter: Arc<RateLimiter>,
    limits: LimitConfig,
    n: usize,
}

fn harness(limits: &str, sink_capacity: usize, interval: Duration) -> H {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = SqliteStore::open(&path, 0).expect("store");
    let (tx, commits) = mpsc::channel(sink_capacity);
    let writer = Writer::spawn(
        &path,
        WriterConfig {
            commit_sink: Some(tx),
            interval,
            ..WriterConfig::default()
        },
    )
    .expect("writer");
    let handle = writer.handle();
    H {
        _dir: dir,
        store,
        writer: Some(writer),
        handle,
        commits,
        limiter: RateLimiter::new(),
        limits: parse_limits(limits).expect("limits"),
        n: 0,
    }
}

impl H {
    /// One completion queued to the writer (its debit comes only after commit).
    fn finish(&mut self, tokens: i64) {
        self.n += 1;
        let mut log = RequestLog::new(format!("req-{}", self.n), T0 as i64, 200);
        log.api_key_id = Some(KEY.into());
        log.requested_model = "fast".into();
        log.input_tokens = tokens;
        assert!(self.handle.send(LogEvent::Finish(log)));
    }

    /// Queues the limiter's seed requests on the writer (none when the
    /// windows are seeded or a seed is already outstanding).
    fn ask_seed(&self) -> usize {
        self.limiter.prepare(KEY, &self.limits, "fast", T0);
        self.limiter.send_seeds(&self.handle)
    }

    /// Applies every committed event the writer has produced so far.
    fn drain(&mut self) -> usize {
        let mut n = 0;
        while let Ok(e) = self.commits.try_recv() {
            self.limiter.apply(e);
            n += 1;
        }
        n
    }

    async fn settle(&mut self) {
        // Close flushes everything queued; the sink then holds the story.
        if let Some(w) = self.writer.take() {
            w.close().await.expect("close");
        }
        self.drain();
    }

    fn tokens_used(&self) -> f64 {
        self.limiter
            .admit(KEY, &self.limits, "fast", T0 + 1.0)
            .map(|a| a.headroom.tokens.map_or(-1.0, |t| t.used))
            .unwrap_or(-2.0)
    }

    fn rows(&self) -> i64 {
        self.store
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM request_logs WHERE state = 'done'",
                [],
                |r| r.get(0),
            )
            .expect("count")
    }
}

/// (a) committed before the seed: its debit arrives first and is ignored
/// (unseeded); the seed's aggregate counts it once.
#[tokio::test(flavor = "multi_thread")]
async fn a_completion_committed_before_the_seed_is_counted_once_by_the_seed() {
    let mut h = harness(r#"{"tokens":{"5h":1000000}}"#, 64, Duration::from_millis(5));
    // The admission records the limits and queues seeds, held back here.
    drop(h.limiter.admit(KEY, &h.limits, "fast", T0).expect("admit"));
    h.finish(40);
    // Commit and deliver the completion before the seed is asked.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(h.drain(), 1);
    assert_eq!(h.limiter.held_debits(), 0, "ignored while unseeded");
    // Now the seeds the admission queued go to the writer.
    assert_eq!(h.limiter.send_seeds(&h.handle), 2);
    h.settle().await;
    assert_eq!(h.tokens_used(), 40.0);
}

/// (b) committed after the seed: counted once, by its debit.
#[tokio::test(flavor = "multi_thread")]
async fn a_completion_committed_after_the_seed_is_counted_once_by_its_debit() {
    let mut h = harness(r#"{"tokens":{"5h":1000000}}"#, 64, Duration::from_millis(5));
    assert_eq!(h.ask_seed(), 2);
    h.finish(60);
    h.settle().await;
    assert_eq!(h.tokens_used(), 60.0);
}

/// (c) many completions around several seeds, applied as they come: the
/// window always equals the committed rows exactly.
#[tokio::test(flavor = "multi_thread")]
async fn interleaved_completions_and_seeds_total_the_row_count_exactly() {
    let mut h = harness(
        r#"{"requests":{"5h":1000000}}"#,
        4096,
        Duration::from_millis(2),
    );
    for round in 0..20 {
        for _ in 0..(round % 7 + 1) {
            h.finish(1);
        }
        if round % 5 == 0 {
            // Asks only when the previous seed has landed; the stream decides.
            let _ = h.ask_seed();
        }
        if round % 3 == 0 {
            tokio::time::sleep(Duration::from_millis(3)).await;
            h.drain();
        }
    }
    h.settle().await;
    let used = h
        .limiter
        .admit(KEY, &h.limits, "fast", T0 + 1.0)
        .expect("admit")
        .headroom
        .requests
        .map(|r| r.used);
    #[allow(clippy::cast_precision_loss)]
    let rows = h.rows() as f64;
    assert!(rows > 50.0);
    assert_eq!(used, Some(rows));
}

/// (d) the sink is full: the batch's debits are counted as dropped and
/// warned, never applied twice; the rows are in the DB for the next seed.
#[tokio::test(flavor = "multi_thread")]
async fn a_full_sink_drops_debits_counts_them_and_never_double_counts() {
    // Capacity 2: the two seed results fill it, so the batch committed
    // after them finds no room (nothing drains meanwhile).
    let mut h = harness(r#"{"tokens":{"5h":1000000}}"#, 2, Duration::from_millis(1));
    assert_eq!(h.ask_seed(), 2);
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.finish(10);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let writer = h.writer.take().expect("writer");
    let stats = writer.handle().stats();
    assert_eq!(stats.sink_dropped, 1);
    h.drain(); // the seed (empty) is applied; the dropped debit never comes
    writer.close().await.expect("close");
    h.drain();
    // Under-count by the dropped debit, never over.
    assert_eq!(h.tokens_used(), 0.0);
    // The next seed reads the row: a fresh limiter re-seeding counts it once.
    let fresh = RateLimiter::new();
    fresh.prepare(KEY, &h.limits, "fast", T0);
    fresh.seed_now(&h.store);
    let used = fresh
        .admit(KEY, &h.limits, "fast", T0 + 1.0)
        .expect("admit")
        .headroom
        .tokens
        .map(|t| t.used);
    assert_eq!(used, Some(10.0));
}

/// (e) state is bounded: no per-request bookkeeping is retained. A subject
/// holds its buckets and the in-window row stamps, nothing keyed by request.
#[tokio::test(flavor = "multi_thread")]
async fn completions_leave_no_per_request_state_behind_but_the_window_stamps() {
    let mut h = harness(
        r#"{"tokens":{"5h":1000000}}"#,
        4096,
        Duration::from_millis(2),
    );
    for _ in 0..200 {
        h.finish(1); // before any seed: ignored, nothing held
    }
    h.settle().await;
    assert_eq!(h.limiter.held_debits(), 0);
    assert_eq!(h.limiter.seeds_pending(), 0);
}

/// One batch holding completions on both sides of a seed: the writer splits
/// it there, so the ones before are in the aggregate (their debits ignored)
/// and the ones after are debited. Misplacing the seed counts some twice.
#[tokio::test(flavor = "multi_thread")]
async fn a_seed_inside_a_batch_splits_it_at_the_seed() {
    let mut h = harness(
        r#"{"tokens":{"5h":1000000}}"#,
        64,
        Duration::from_millis(300),
    );
    drop(h.limiter.admit(KEY, &h.limits, "fast", T0).expect("admit")); // queues the seeds
    for _ in 0..3 {
        h.finish(10);
    }
    assert_eq!(h.limiter.send_seeds(&h.handle), 2);
    for _ in 0..2 {
        h.finish(100);
    }
    h.settle().await;
    assert_eq!(h.tokens_used(), 230.0);
}
