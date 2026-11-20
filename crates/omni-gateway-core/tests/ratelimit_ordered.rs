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

#[tokio::test]
async fn original_limiter_recovers_gap_and_counts_later_commits_once() {
    let mut h = harness(r#"{"tokens":{"5h":1000000}}"#, 2, Duration::from_millis(2));
    h.limiter.prepare(KEY, &h.limits, "fast", T0);
    h.limiter.seed_now(&h.store);
    for _ in 0..2 {
        h.sink
            .try_send(Committed::Completions(Vec::new()))
            .expect("fill");
    }
    h.finish(10);
    tokio::time::timeout(Duration::from_secs(2), h.handle.flush())
        .await
        .expect("writer never waits on sink")
        .expect("flush");
    assert_eq!(h.handle.stats().sink_dropped, 1);
    h.drain();
    // A later completion is queued after the pending Gap; applying both leaves
    // windows invalidated until an ordered seed includes both committed rows.
    h.finish(20);
    h.handle.flush().await.expect("flush");
    h.drain();
    assert_eq!(h.ask_seed(), 2);
    h.handle.flush().await.expect("seed flush");
    h.drain();
    assert_eq!(h.tokens_used(), 30.0);
    h.finish(7);
    h.handle.flush().await.expect("later flush");
    h.drain();
    assert_eq!(h.tokens_used(), 37.0);
    assert_eq!(h.rows(), 3);
    h.settle().await;
}

#[tokio::test]
async fn commit_crossing_minute_uses_application_time_not_row_time() {
    let mut h = harness(r#"{"requests":{"5h":1}}"#, 64, Duration::from_millis(5));
    let minute = (T0 / 60_000.0).floor() * 60_000.0;
    h.limiter.prepare(KEY, &h.limits, "fast", minute + 59_999.0);
    h.limiter.seed_now(&h.store);
    h.limiter.apply_at(
        Committed::Completions(vec![omni_store::writer::Completion {
            commit_id: None,
            id: "boundary".into(),
            api_key_id: Some(KEY.into()),
            requested_model: "fast".into(),
            tokens: 0.0,
            cost_usd: 0.0,
            at: minute + 59_999.0,
            debit_model: true,
        }]),
        minute + 60_001.0,
    );
    assert!(
        h.limiter
            .admit(KEY, &h.limits, "fast", minute + 18_000_000.0 + 60_000.0)
            .is_err(),
        "completion bucket must remain until its own expiration"
    );
    h.settle().await;
}

struct H {
    /// A clone of the writer's sink sender, so a test can fill the sink.
    sink: mpsc::Sender<Committed>,
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
    harness_with(limits, sink_capacity, interval, Duration::ZERO)
}

fn harness_with(limits: &str, sink_capacity: usize, interval: Duration, seed_delay: Duration) -> H {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = SqliteStore::open(&path, 0).expect("store");
    let (tx, commits) = mpsc::channel(sink_capacity);
    let sink = tx.clone();
    let writer = Writer::spawn(
        &path,
        WriterConfig {
            commit_sink: Some(tx),
            interval,
            seed_delay,
            ..WriterConfig::default()
        },
    )
    .expect("writer");
    let handle = writer.handle();
    H {
        sink,
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
            self.limiter.apply_at(e, T0);
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

/// (c) A genuinely slow seed: while its read is held (150 ms), completions
/// keep arriving and queue behind it; a live consumer applies the stream as
/// it comes. The window equals the committed rows exactly.
#[tokio::test(flavor = "multi_thread")]
async fn completions_around_a_slow_seed_total_the_row_count_exactly() {
    let mut h = harness_with(
        r#"{"requests":{"5h":1000000}}"#,
        4096,
        Duration::from_millis(2),
        Duration::from_millis(150),
    );
    let limiter = h.limiter.clone();
    let mut commits = std::mem::replace(&mut h.commits, mpsc::channel(1).1);
    let consumer = tokio::spawn(async move {
        while let Some(e) = commits.recv().await {
            limiter.apply_at(e, T0);
        }
    });
    drop(h.limiter.admit(KEY, &h.limits, "fast", T0).expect("admit"));
    // Before the seed: committed and delivered while unseeded (ignored).
    for _ in 0..7 {
        h.finish(1);
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    // Delivered and ignored: nothing held before the seed lands.
    assert_eq!(h.limiter.held_debits(), 0);
    assert_eq!(h.limiter.send_seeds(&h.handle), 2);
    // While the seed is held: these queue and commit after the read.
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(250) {
        h.finish(1);
        tokio::time::sleep(Duration::from_millis(7)).await;
    }
    h.writer
        .take()
        .expect("writer")
        .close()
        .await
        .expect("close");
    drop(std::mem::replace(&mut h.sink, mpsc::channel(1).0));
    tokio::time::timeout(Duration::from_secs(2), consumer)
        .await
        .expect("consumer ended")
        .expect("consumer");
    assert_eq!(h.limiter.seeds_pending(), 0);
    let used = h
        .limiter
        .admit(KEY, &h.limits, "fast", T0 + 1.0)
        .expect("admit")
        .headroom
        .requests
        .map(|r| r.used);
    #[allow(clippy::cast_precision_loss)]
    let rows = h.rows() as f64;
    assert!(rows > 30.0, "{rows}");
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

/// (e) State is bounded and released: register limits, seed, debit, go
/// idle. Per-subject state is the two windows' buckets and in-window row
/// stamps (capped); once the rows age out of the window the stamps are
/// gone, and no seed marker or per-request record remains.
#[tokio::test(flavor = "multi_thread")]
async fn an_idle_subject_releases_its_per_request_state() {
    let mut h = harness(
        r#"{"tokens":{"5h":1000000}}"#,
        4096,
        Duration::from_millis(2),
    );
    assert_eq!(h.ask_seed(), 2);
    tokio::time::sleep(Duration::from_millis(30)).await;
    h.drain();
    assert_eq!(h.limiter.seeds_pending(), 0);
    for _ in 0..50 {
        h.finish(1);
    }
    h.settle().await;
    // Each debit holds one stamp per long window while in the window.
    assert_eq!(h.limiter.held_debits(), 100);
    // A week and a minute later (idle), the 1w window still holds them...
    let five_h = 5.0 * 3_600_000.0;
    drop(
        h.limiter
            .admit(KEY, &h.limits, "fast", T0 + five_h + 60_000.0)
            .expect("admit"),
    );
    assert_eq!(h.limiter.held_debits(), 50, "5h window released its stamps");
    let week = 7.0 * 24.0 * 3_600_000.0;
    drop(
        h.limiter
            .admit(KEY, &h.limits, "fast", T0 + week + 3_600_000.0)
            .expect("admit"),
    );
    assert_eq!(h.limiter.held_debits(), 0, "1w window released its stamps");
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

/// (Round 3, 1a) A full, undrained sink never stalls persistence: with
/// capacity 1 and two seeds queued, later writes still commit on time and
/// close() completes; the seed result that found no room is counted.
#[tokio::test(flavor = "multi_thread")]
async fn a_full_sink_never_stalls_persistence() {
    let mut h = harness(
        r#"{"tokens":{"5h":1000000},"models":{"m2":{"tokens":{"5h":5}}}}"#,
        1,
        Duration::from_millis(5),
    );
    // Two seeds (both windows of one subject), receiver alive, never drained.
    assert_eq!(h.ask_seed(), 2);
    tokio::time::sleep(Duration::from_millis(50)).await;
    for _ in 0..5 {
        h.finish(1);
    }
    // Committed within normal batch timing despite the full sink.
    let started = std::time::Instant::now();
    while h.rows() < 5 {
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "writes stalled behind a full sink"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let stats = h.handle.stats();
    assert_eq!(stats.seeds_dropped, 1, "{stats:?}");
    let writer = h.writer.take().expect("writer");
    tokio::time::timeout(Duration::from_secs(2), writer.close())
        .await
        .expect("close() completed")
        .expect("close ok");
}

/// (Round 3, 1b) A dropped seed result behaves as a failed seed: the window
/// stays unseeded and ignores debits; after the retry timeout a new seed is
/// asked and installs exactly the committed total.
#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_seed_result_is_retried_and_installs_the_exact_total() {
    let mut h = harness(
        r#"{"requests":{"5h":1000000}}"#,
        2,
        Duration::from_millis(2),
    );
    drop(h.limiter.admit(KEY, &h.limits, "fast", T0).expect("admit")); // queues seeds
    // Fill both slots ourselves, so both seed results find the sink full.
    for _ in 0..2 {
        h.sink
            .try_send(Committed::Completions(Vec::new()))
            .expect("slot");
    }
    h.finish(1);
    assert_eq!(h.limiter.send_seeds(&h.handle), 2);
    let started = std::time::Instant::now();
    while h.handle.stats().seeds_dropped < 2 {
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "seeds not dropped"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        h.limiter.seeds_pending(),
        2,
        "still marked, not yet timed out"
    );

    // From here a live consumer applies the stream as it comes.
    let limiter = h.limiter.clone();
    let mut commits = std::mem::replace(&mut h.commits, mpsc::channel(1).1);
    let (seen_tx, mut seen) = mpsc::unbounded_channel();
    let consumer = tokio::spawn(async move {
        while let Some(e) = commits.recv().await {
            let seed = matches!(e, Committed::Seed { .. });
            limiter.apply_at(e, T0);
            if seed {
                seen_tx.send(()).ok();
            }
        }
    });
    for _ in 0..3 {
        h.finish(1);
    }
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(h.limiter.held_debits(), 0, "unseeded windows ignore debits");
    // The completion gap invalidates outstanding seeds, allowing immediate
    // recovery rather than waiting for the ordinary dropped-seed timeout.
    h.limiter.prepare(KEY, &h.limits, "fast", T0 + 1.0);
    assert_eq!(h.limiter.send_seeds(&h.handle), 2);
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(2), seen.recv())
            .await
            .expect("seed result applied");
    }
    for _ in 0..2 {
        h.finish(1);
    }
    h.writer
        .take()
        .expect("writer")
        .close()
        .await
        .expect("close");
    // Our clone of the sender is the last one: drop it so the stream ends.
    drop(std::mem::replace(&mut h.sink, mpsc::channel(1).0));
    tokio::time::timeout(Duration::from_secs(2), consumer)
        .await
        .expect("consumer ended")
        .expect("consumer");
    assert_eq!(h.limiter.seeds_pending(), 0);
    assert_eq!(h.handle.stats().seeds_dropped, 2, "the retry was delivered");
    let used = h
        .limiter
        .admit(KEY, &h.limits, "fast", T0 + 1.0)
        .expect("admit")
        .headroom
        .requests
        .map(|r| r.used);
    #[allow(clippy::cast_precision_loss)]
    let rows = h.rows() as f64;
    assert_eq!(rows, 6.0);
    assert_eq!(used, Some(rows));
}
