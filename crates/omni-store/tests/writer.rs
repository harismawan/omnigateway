//! Contract tests for the batched writer: the same events leave the same
//! `request_logs`, `usage_daily`, `usage_rollup` and `credential_health` rows
//! as applying them one at a time, however they are batched.

mod common;

use omni_store::SqliteStore;
use omni_store::writer::{
    BarrierError, LogEvent, PendingLog, RequestLog, Writer, WriterConfig, WriterStats,
};
use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;

const NODE: &str = "node-a";
/// 2026-11-06T23:30:00Z: half an hour before midnight UTC, so the +60 offset
/// puts some of these requests on another day than UTC does.
const T0: i64 = 1_794_007_800_000;

#[test]
fn seed_latency_and_fifo_prefix() {
    current_thread().block_on(async {
        for interval in [20, 200] {
            let dir = tempfile::tempdir().expect("tempdir");
            let db = migrated(dir.path());
            let (tx, mut rx) = tokio::sync::mpsc::channel(128);
            let writer = Writer::spawn(
                &db,
                WriterConfig {
                    interval: Duration::from_millis(interval),
                    commit_sink: Some(tx),
                    ..config(0, 512)
                },
            )
            .expect("spawn");
            let handle = writer.handle();
            let started = std::time::Instant::now();
            for tag in 0..20 {
                assert!(handle.send(LogEvent::Finish(done(
                    &format!("seed-{tag}"),
                    T0,
                    Some("k"),
                    "m",
                    1
                ))));
                assert!(handle.seed(omni_store::writer::SeedQuery {
                    subject: "k".into(),
                    api_key_id: "k".into(),
                    requested_model: None,
                    since_ms: 0,
                    grain_ms: 60_000,
                    tag,
                    now: 0.0,
                    stamp_cap: 100,
                }));
                loop {
                    if let omni_store::writer::Committed::Seed { result, .. } =
                        rx.recv().await.expect("result")
                    {
                        let rows = result.expect("seed SQL");
                        assert_eq!(
                            rows.stamps.len(),
                            tag as usize + 1,
                            "seed must include preceding commit"
                        );
                        break;
                    }
                }
            }
            eprintln!(
                "seed phase interval={interval}ms subjects=20 elapsed={:?}",
                started.elapsed()
            );
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "seeds must not wait for ordinary batching"
            );
            writer.close().await.expect("close");
        }
    });
}

fn pending(id: &str, at: i64, key: Option<&str>, model: &str) -> LogEvent {
    LogEvent::Begin(PendingLog {
        id: id.into(),
        at,
        api_key_id: key.map(Into::into),
        requested_model: model.into(),
        resolved_provider: Some("anthropic".into()),
        resolved_model: Some(format!("{model}-upstream")),
        credential_id: Some("cred-1".into()),
    })
}

fn done(id: &str, at: i64, key: Option<&str>, model: &str, n: i64) -> RequestLog {
    let mut log = RequestLog::new(id, at, 200);
    log.api_key_id = key.map(Into::into);
    log.requested_model = model.into();
    log.resolved_provider = Some("anthropic".into());
    log.resolved_model = Some(format!("{model}-upstream"));
    log.credential_id = Some("cred-1".into());
    log.attempts = 1;
    log.input_tokens = 100 + n;
    log.output_tokens = 7 * n;
    log.cache_read_tokens = n % 3;
    log.cache_write_tokens = n % 5;
    log.ttft_ms = if n % 4 == 0 { None } else { Some(40 + n) };
    log.duration_ms = 900 + n;
    // Fractions whose sums depend on the order they are added in.
    #[allow(clippy::cast_precision_loss)]
    let cost = 0.1 + (n as f64) * 0.000_123_456_789;
    log.cost_usd = cost;
    log
}

fn config(offset: i64, max_batch: usize) -> WriterConfig {
    WriterConfig {
        node_id: NODE.into(),
        day_offset_minutes: offset,
        max_batch,
        ..WriterConfig::default()
    }
}

/// Triggers record every write the writer's connection makes to the rollups.
fn count_touches(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE touches (tbl TEXT NOT NULL);
         CREATE TRIGGER t_ri AFTER INSERT ON usage_rollup BEGIN INSERT INTO touches VALUES ('rollup'); END;
         CREATE TRIGGER t_ru AFTER UPDATE ON usage_rollup BEGIN INSERT INTO touches VALUES ('rollup'); END;
         CREATE TRIGGER t_di AFTER INSERT ON usage_daily BEGIN INSERT INTO touches VALUES ('daily'); END;
         CREATE TRIGGER t_du AFTER UPDATE ON usage_daily BEGIN INSERT INTO touches VALUES ('daily'); END;",
    )
    .expect("triggers");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thousand_requests_touch_each_rollup_row_once_per_batch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("omni.db");
    let store = SqliteStore::open(&db, 0).expect("open");
    count_touches(store.connection());

    let writer = Writer::spawn(&db, config(0, 512)).expect("spawn");
    let handle = writer.handle();
    for n in 0..1000 {
        // One key, one model, one hour.
        let log = done(&format!("r{n}"), T0 + 1_000 + n, Some("key-1"), "sonnet", n);
        assert!(handle.send(LogEvent::Finish(log)), "channel full");
    }
    let stats = writer.close().await.expect("close");
    assert_eq!(stats.dropped, 0);
    assert!(
        (2..1000).contains(&stats.batches),
        "batched: {}",
        stats.batches
    );

    let conn = store.connection();
    let touches = |t: &str| -> u64 {
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM touches WHERE tbl = ?", [t], |r| {
                r.get(0)
            })
            .expect("count");
        u64::try_from(n).expect("count")
    };
    assert_eq!(touches("rollup"), stats.batches);
    assert_eq!(touches("daily"), stats.batches);
    let (requests, input): (i64, i64) = conn
        .query_row(
            "SELECT requests, input_tokens FROM usage_rollup WHERE api_key_id = 'key-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("rollup");
    assert_eq!(requests, 1000);
    assert_eq!(input, (0..1000).map(|n| 100 + n).sum::<i64>());
    let logged: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM request_logs WHERE state = 'done'",
            [],
            |r| r.get(0),
        )
        .expect("logs");
    assert_eq!(logged, 1000);
}

#[test]
fn a_full_channel_drops_and_counts_without_waiting() {
    // One thread: the writer task cannot run while this test fills the
    // channel, so exactly `capacity` events fit.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("omni.db");
        drop(SqliteStore::open(&db, 0).expect("open"));
        let cfg = WriterConfig {
            capacity: 4,
            ..config(0, 512)
        };
        let writer = Writer::spawn(&db, cfg).expect("spawn");
        let handle = writer.handle();
        let accepted = (0..10)
            .filter(|n| {
                handle.send(LogEvent::Finish(done(
                    &format!("r{n}"),
                    T0,
                    Some("k"),
                    "m",
                    *n,
                )))
            })
            .count();
        assert_eq!(accepted, 4);
        assert_eq!(handle.dropped(), 6);
        let stats = writer.close().await.expect("close");
        assert_eq!(stats.dropped, 6);
        // After close nothing is accepted, and that counts as dropped too.
        assert!(!handle.send(LogEvent::Finish(done("late", T0, None, "m", 0))));
        assert_eq!(handle.dropped(), 7);
        let conn = Connection::open(&db).expect("open");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM request_logs", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 4);
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_flushes_what_is_queued() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("omni.db");
    let store = SqliteStore::open(&db, 0).expect("open");
    let cfg = WriterConfig {
        // Nothing would be written for an hour but for the close.
        interval: Duration::from_secs(3600),
        ..config(0, 512)
    };
    let writer = Writer::spawn(&db, cfg).expect("spawn");
    let handle = writer.handle();
    assert!(handle.send(pending("p1", T0, Some("k"), "m")));
    assert!(handle.send(pending("p2", T0, Some("k"), "m")));
    assert!(handle.send(LogEvent::Finish(done("p2", T0, Some("k"), "m", 1))));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let count = |sql: &str| -> i64 {
        store
            .connection()
            .query_row(sql, [], |r| r.get(0))
            .expect("count")
    };
    assert_eq!(
        count("SELECT COUNT(*) FROM request_logs"),
        0,
        "still batching"
    );
    let stats = writer.close().await.expect("close");
    assert_eq!(stats.batches, 1);
    assert_eq!(
        count("SELECT COUNT(*) FROM request_logs WHERE state = 'pending'"),
        1
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM request_logs WHERE state = 'done'"),
        1
    );
    assert_eq!(count("SELECT requests FROM usage_rollup"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quiet_writer_still_writes_within_the_interval() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("omni.db");
    let store = SqliteStore::open(&db, 0).expect("open");
    let writer = Writer::spawn(&db, config(0, 512)).expect("spawn");
    assert!(writer.handle().send(pending("p1", T0, None, "m")));
    tokio::time::sleep(Duration::from_millis(600)).await;
    let n: i64 = store
        .connection()
        .query_row("SELECT COUNT(*) FROM request_logs", [], |r| r.get(0))
        .expect("count");
    assert_eq!(n, 1, "written by the 200 ms tick, before close");
    writer.close().await.expect("close");
}

/// Everything `tracing` emits on this thread while the guard lives.
struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl Captured {
    fn install() -> (Self, tracing::subscriber::DefaultGuard) {
        // With one dispatcher registered, tracing-core computes a callsite's
        // interest from `get_default` on whichever thread reaches it first;
        // a parallel test's writer on a thread with no subscriber caches
        // `never`, and this capture misses lines until the next `Dispatch`
        // rebuilds the cache (`rebuild_interest_cache` after `set_default`
        // would not help: registration can happen later, elsewhere). A global
        // WARN subscriber writing nowhere keeps every WARN callsite enabled.
        static GLOBAL: std::sync::Once = std::sync::Once::new();
        GLOBAL.call_once(|| {
            let sink = tracing_subscriber::fmt()
                .with_writer(std::io::sink)
                .with_max_level(tracing::Level::WARN)
                .finish();
            tracing::subscriber::set_global_default(sink).expect("one global subscriber");
        });
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&buf);
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || CaptureWriter(std::sync::Arc::clone(&sink)))
            .with_max_level(tracing::Level::WARN)
            .finish();
        (Self(buf), tracing::subscriber::set_default(subscriber))
    }

    fn lines(&self, needle: &str) -> Vec<String> {
        let text = String::from_utf8(self.0.lock().expect("lock").clone()).expect("utf8");
        text.lines()
            .filter(|l| l.contains(needle))
            .map(str::to_owned)
            .collect()
    }
}

struct CaptureWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("lock").extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A current-thread runtime: the writer task runs on this thread (so the
/// captured subscriber sees its events) and only when the test yields.
fn current_thread() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

fn migrated(dir: &Path) -> std::path::PathBuf {
    let db = dir.join("omni.db");
    drop(SqliteStore::open(&db, 0).expect("open"));
    db
}

fn count(db: &Path, sql: &str) -> i64 {
    Connection::open(db)
        .expect("open")
        .query_row(sql, [], |r| r.get(0))
        .expect("count")
}

#[test]
fn drops_warn_from_the_writer_task_at_most_once_per_interval() {
    current_thread().block_on(async {
        let (log, _guard) = Captured::install();
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let cfg = WriterConfig {
            capacity: 1,
            drop_warn_interval: Duration::from_millis(300),
            ..config(0, 512)
        };
        let writer = Writer::spawn(&db, cfg).expect("spawn");
        let handle = writer.handle();
        let send = |n: i64| handle.send(LogEvent::Finish(done(&format!("r{n}"), T0, None, "m", n)));
        assert!(send(0));
        for n in 1..10 {
            assert!(!send(n));
        }
        // The request path itself never warns: the writer task has not run.
        assert_eq!(log.lines("events dropped").len(), 0);
        assert_eq!(handle.dropped(), 9);
        // The writer warns from its own tick (the first is at once), which
        // opens a 300 ms window.
        tokio::time::sleep(Duration::from_millis(80)).await;
        let warned = log.lines("events dropped");
        assert_eq!(warned.len(), 1, "{warned:?}");
        assert!(warned[0].contains("count=9 "), "{warned:?}");
        // More drops inside the interval wait for it to pass.
        for n in 10..13 {
            send(n);
        }
        let more = handle.dropped() - 9;
        assert!(more > 0, "the channel refilled");
        // ~130 ms: a tick at 150 is inside the window too.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(log.lines("events dropped").len(), 1, "rate-limited");
        // Past the window (the 300 ms tick), with the writer otherwise idle.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let warned = log.lines("events dropped");
        assert_eq!(warned.len(), 2, "{warned:?}");
        assert!(warned[1].contains(&format!("count={more} ")), "{warned:?}");
        assert!(
            warned[1].contains(&format!("rawCount={}", 9 + more)),
            "{warned:?}"
        );
        // Nothing new: no further warnings, however long the writer idles.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(log.lines("events dropped").len(), 2);
        writer.close().await.expect("close");
    });
}

#[test]
fn a_failed_batch_is_counted_reported_and_fails_close() {
    current_thread().block_on(async {
        let (log, _guard) = Captured::install();
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let writer = Writer::spawn(&db, config(0, 512)).expect("spawn");
        let handle = writer.handle();
        // Not transient: no amount of retrying brings the table back.
        Connection::open(&db)
            .expect("open")
            .execute_batch("DROP TABLE usage_rollup")
            .expect("drop");
        for n in 0..3 {
            assert!(handle.send(LogEvent::Finish(done(
                &format!("r{n}"),
                T0,
                Some("k"),
                "m",
                n
            ))));
        }
        let closed = writer.close().await;
        assert!(
            matches!(&closed, Err(e) if e.to_string().contains("3 queued events failed")),
            "{closed:?}"
        );
        let stats = handle.stats();
        assert_eq!((stats.failed, stats.dropped, stats.batches), (3, 0, 0));
        let errors = log.lines("failed to persist");
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(
            errors[0].contains("ERROR") && errors[0].contains("count=3"),
            "{errors:?}"
        );
        assert!(errors[0].contains("no such table"), "{errors:?}");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM request_logs"),
            0,
            "rolled back"
        );
    });
}

/// Holds the write lock from another connection for `hold`.
fn lock_for(db: &Path, hold: Duration) -> std::thread::JoinHandle<()> {
    let conn = Connection::open(db).expect("open");
    conn.execute_batch("BEGIN IMMEDIATE").expect("lock");
    std::thread::spawn(move || {
        std::thread::sleep(hold);
        conn.execute_batch("COMMIT").expect("unlock");
    })
}

#[test]
fn a_busy_database_is_retried_with_backoff() {
    current_thread().block_on(async {
        let (log, _guard) = Captured::install();
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let cfg = WriterConfig {
            busy_timeout: Duration::from_millis(30),
            ..config(0, 512)
        };
        let writer = Writer::spawn(&db, cfg).expect("spawn");
        let handle = writer.handle();
        // Attempts at ~0, ~130 and ~360 ms; the lock goes at 200.
        let locker = lock_for(&db, Duration::from_millis(200));
        assert!(handle.send(pending("p1", T0, None, "m")));
        let stats = writer.close().await.expect("close after retry");
        locker.join().expect("locker");
        assert_eq!((stats.batches, stats.failed), (1, 0));
        let retries = log.lines("busy database; retrying");
        assert_eq!(retries.len(), 2, "{retries:?}");
        assert!(retries[0].contains("attempt=1") && retries[1].contains("attempt=2"));
        assert_eq!(count(&db, "SELECT COUNT(*) FROM request_logs"), 1);
    });
}

#[test]
fn a_database_busy_past_the_retries_fails_the_batch() {
    current_thread().block_on(async {
        let (log, _guard) = Captured::install();
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let cfg = WriterConfig {
            busy_timeout: Duration::from_millis(10),
            ..config(0, 512)
        };
        let writer = Writer::spawn(&db, cfg).expect("spawn");
        let handle = writer.handle();
        let locker = lock_for(&db, Duration::from_millis(1500));
        assert!(handle.send(pending("p1", T0, None, "m")));
        assert!(writer.close().await.is_err());
        locker.join().expect("locker");
        assert_eq!(handle.stats().failed, 1);
        assert_eq!(log.lines("busy database; retrying").len(), 2);
        let errors = log.lines("failed to persist");
        assert!(
            errors.len() == 1 && errors[0].contains("attempts=3"),
            "{errors:?}"
        );
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn events_queued_behind_a_slow_write_go_out_with_the_next_write() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = migrated(dir.path());
    let writer = Writer::spawn(&db, config(0, 512)).expect("spawn");
    let handle = writer.handle();
    // The first batch closes at 200 ms and then waits on the lock until 600.
    let locker = lock_for(&db, Duration::from_millis(600));
    let start = std::time::Instant::now();
    assert!(handle.send(pending("a", T0, None, "m")));
    tokio::time::sleep(Duration::from_millis(250)).await;
    // Queued while the write is in flight: due at 450, past by the time the
    // write finishes.
    assert!(handle.send(pending("b", T0, None, "m")));
    let mut seen_a = None;
    let seen_b = loop {
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(3), "never written");
        let ids = |id: &str| {
            count(
                &db,
                &format!("SELECT COUNT(*) FROM request_logs WHERE id = '{id}'"),
            )
        };
        if seen_a.is_none() && ids("a") == 1 {
            seen_a = Some(elapsed);
        }
        if ids("b") == 1 {
            // `a` committed first; both may have landed between two polls.
            seen_a.get_or_insert(elapsed);
            break elapsed;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    locker.join().expect("locker");
    let seen_a = seen_a.expect("a before b");
    assert!(
        seen_a >= Duration::from_millis(590),
        "a waited for the lock: {seen_a:?}"
    );
    // Measured from dequeue, b would wait another full 200 ms interval.
    assert!(
        seen_b - seen_a < Duration::from_millis(120),
        "b went out with the next write: a at {seen_a:?}, b at {seen_b:?}"
    );
    let stats = writer.close().await.expect("close");
    assert_eq!(stats.batches, 2);
}

#[test]
fn close_keeps_the_drop_warning_interval_and_returns_the_full_total() {
    current_thread().block_on(async {
        let (log, _guard) = Captured::install();
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let cfg = WriterConfig {
            capacity: 1,
            drop_warn_interval: Duration::from_secs(10),
            ..config(0, 512)
        };
        let writer = Writer::spawn(&db, cfg).expect("spawn");
        let handle = writer.handle();
        let send = |n: i64| handle.send(LogEvent::Finish(done(&format!("r{n}"), T0, None, "m", n)));
        assert!(send(0));
        for n in 1..4 {
            assert!(!send(n));
        }
        // The writer's first look warns about those three.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let warned = log.lines("events dropped");
        assert_eq!(warned.len(), 1, "{warned:?}");
        assert!(warned[0].contains("count=3 "), "{warned:?}");
        // Refill the channel, drop more, and close at once: well inside the
        // 10 s interval, so no second warning — the total says it instead.
        let mut more = 0;
        for n in 4..20 {
            if !send(n) {
                more += 1;
            }
        }
        assert!(more > 0, "the channel refilled");
        let stats = writer.close().await.expect("close");
        let warned = log.lines("events dropped");
        assert_eq!(
            warned.len(),
            1,
            "no second warning inside the interval: {warned:?}"
        );
        assert_eq!(stats.dropped, 3 + more);
        assert_eq!(handle.dropped(), 3 + more);
    });
}

/// Close arrives while the first batch is between retries on a locked
/// database. `release_at` is when the other connection lets go.
async fn close_during_retry(release_at: Duration) -> (Result<WriterStats, String>, WriterStats) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = migrated(dir.path());
    let cfg = WriterConfig {
        busy_timeout: Duration::from_millis(10),
        interval: Duration::from_millis(1),
        ..config(0, 512)
    };
    let writer = Writer::spawn(&db, cfg).expect("spawn");
    let handle = writer.handle();
    let locker = lock_for(&db, release_at);
    assert!(handle.send(pending("p1", T0, None, "m")));
    // Attempts at ~1, ~110 and ~320 ms: close lands inside the first backoff
    // with nothing else queued.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let closed = writer.close().await.map_err(|e| e.to_string());
    locker.join().expect("locker");
    (closed, handle.stats())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_during_a_retry_that_fails_returns_err() {
    let (closed, stats) = close_during_retry(Duration::from_millis(1500)).await;
    assert!(
        matches!(&closed, Err(e) if e.contains("1 queued events failed")),
        "{closed:?}"
    );
    assert_eq!((stats.failed, stats.batches), (1, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_during_a_retry_that_succeeds_returns_ok() {
    let (closed, stats) = close_during_retry(Duration::from_millis(80)).await;
    let closed = closed.expect("close after the retry commits");
    assert_eq!((closed.failed, closed.batches, closed.written), (0, 1, 1));
    assert_eq!(stats, closed);
}

/// The WAL is copied back into the database by the writer's checkpointer, off
/// the batch path: a batch's commit never pays for a checkpoint, and the copy
/// happens between batches even when the WAL is far below the fallback
/// auto-checkpoint size.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_wal_is_checkpointed_in_the_background_between_batches() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = migrated(dir.path());
    let before = std::fs::metadata(&db).expect("db").len();
    let writer = Writer::spawn(&db, config(0, 512)).expect("spawn");
    let handle = writer.handle();
    for n in 0..3000 {
        let log = done(&format!("r{n}"), T0 + n, Some("key-1"), "sonnet", n);
        assert!(handle.send(LogEvent::Finish(log)), "channel full");
    }
    // Written within the 200 ms interval, then checkpointed shortly after.
    let mut grown = 0;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        grown = std::fs::metadata(&db).expect("db").len();
        if grown > before && count(&db, "SELECT COUNT(*) FROM request_logs") == 3000 {
            break;
        }
    }
    assert!(
        grown > before,
        "the database file still holds only the schema ({before} bytes): nothing was checkpointed"
    );
    let stats = writer.close().await.expect("close");
    assert_eq!(stats.dropped, 0);
}

/// A one-second stall of the database (on the bench host, an XFS log flush
/// under the WAL's fsync took up to ~950 ms) at 40 k events/s, the rate of
/// 20 k requests/s, is absorbed by the queue rather than shed: the default
/// capacity holds more than a second of events. Shedding stays for a real
/// outage, longer than that.
#[test]
fn the_default_queue_rides_out_a_one_second_stall_at_bench_rates() {
    current_thread().block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let writer = Writer::spawn(&db, WriterConfig::default()).expect("spawn");
        let handle = writer.handle();
        let locker = lock_for(&db, Duration::from_millis(1000));
        // 40 000 events (20 000 begun-and-finished requests) queued while the
        // writer is stuck behind the lock: this current-thread runtime only
        // lets it run between sends, and its batch waits on the lock.
        let mut refused = 0;
        for n in 0..20_000 {
            let id = format!("r{n}");
            if !handle.send(pending(&id, T0 + n, Some("key-1"), "sonnet")) {
                refused += 1;
            }
            if !handle.send(LogEvent::Finish(done(
                &id,
                T0 + n,
                Some("key-1"),
                "sonnet",
                n,
            ))) {
                refused += 1;
            }
        }
        assert_eq!(refused, 0, "events shed during a one-second stall");
        locker.join().expect("locker");
        let stats = writer.close().await.expect("close");
        assert_eq!(stats.dropped, 0);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM request_logs WHERE state = 'done'"
            ),
            20_000
        );
    });
}

/// `flush` is a barrier: it returns once every event sequenced before it is
/// resolved, with that prefix's counts, even when the batch interval has not
/// come round: `committed + failed + dropped == watermark`, exactly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flush_returns_once_everything_before_it_is_committed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = migrated(dir.path());
    let cfg = WriterConfig {
        // Nothing would be written for an hour but for the barrier.
        interval: Duration::from_secs(3600),
        ..config(0, 512)
    };
    let writer = Writer::spawn(&db, cfg).expect("spawn");
    let handle = writer.handle();
    for n in 0..1500 {
        let id = format!("r{n}");
        assert!(handle.send(pending(&id, T0 + n, Some("key-1"), "sonnet")));
        assert!(handle.send(LogEvent::Finish(done(
            &id,
            T0 + n,
            Some("key-1"),
            "sonnet",
            n
        ))));
    }
    let b = tokio::time::timeout(Duration::from_secs(10), handle.flush())
        .await
        .expect("barrier within 10 s")
        .expect("barrier");
    assert_eq!(
        (b.watermark, b.committed, b.failed, b.dropped),
        (3000, 3000, 0, 0)
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM request_logs WHERE state = 'done'"
        ),
        1500,
        "every row is in the database when the barrier returns"
    );
    // A second barrier with nothing new returns the same prefix.
    let again = handle.flush().await.expect("barrier");
    assert_eq!(again, b);
    writer.close().await.expect("close");
}

/// A barrier on a closed writer says so instead of hanging.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flush_on_a_closed_writer_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = migrated(dir.path());
    let writer = Writer::spawn(&db, config(0, 512)).expect("spawn");
    let handle = writer.handle();
    writer.close().await.expect("close");
    assert_eq!(handle.flush().await, Err(BarrierError::Closed));
}

/// Producers on other threads keep sending, and dropping on a small queue,
/// throughout a run of barriers: every barrier's answer is a coherent prefix,
/// `committed + failed + dropped == watermark` exactly, watermarks only grow,
/// and the last barrier after the producers stop accounts for every event.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_producers_see_coherent_barrier_prefixes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = migrated(dir.path());
    let cfg = WriterConfig {
        // Small, so producers drop while barriers are taken.
        capacity: 256,
        ..config(0, 512)
    };
    let writer = Writer::spawn(&db, cfg).expect("spawn");
    let handle = writer.handle();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let producers: Vec<_> = (0..4)
        .map(|p| {
            let h = handle.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut sent = 0u64;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let id = format!("p{p}-{sent}");
                    h.send(LogEvent::Finish(done(&id, T0, Some("key-1"), "sonnet", 1)));
                    sent += 1;
                }
                sent
            })
        })
        .collect();
    let mut last = 0;
    let mut barriers = 0;
    let mut saw_drops = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        match handle.flush().await {
            Ok(b) => {
                assert_eq!(
                    b.committed + b.failed + b.dropped,
                    b.watermark,
                    "incoherent prefix {b:?}"
                );
                assert!(b.watermark >= last, "watermark went back: {b:?}");
                last = b.watermark;
                saw_drops |= b.dropped > 0;
                barriers += 1;
            }
            // The small queue is often full: the barrier is refused, never
            // waits. Counted, and retried.
            Err(BarrierError::Full) => tokio::task::yield_now().await,
            Err(e) => panic!("barrier: {e:?}"),
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let sent: u64 = producers
        .into_iter()
        .map(|t| t.join().expect("producer"))
        .sum();
    let fin = loop {
        match handle.flush().await {
            Ok(b) => break b,
            Err(BarrierError::Full) => tokio::time::sleep(Duration::from_millis(5)).await,
            Err(e) => panic!("{e:?}"),
        }
    };
    assert_eq!(fin.watermark, sent, "every event sequenced once");
    assert_eq!(fin.committed + fin.failed + fin.dropped, sent);
    assert!(barriers >= 3, "{barriers} barriers answered");
    assert!(
        saw_drops,
        "producers were meant to drop on a 256-slot queue"
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM request_logs") as u64,
        fin.committed
    );
    writer.close().await.expect("close");
}

/// At most one barrier in flight: a second while one is pending is `Busy`;
/// a barrier never waits for queue room (`Full`); once the first is
/// answered, the next one is admitted.
#[test]
fn a_second_barrier_is_busy_and_a_full_queue_refuses_one() {
    current_thread().block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let cfg = WriterConfig {
            capacity: 4,
            busy_timeout: Duration::from_secs(5),
            ..config(0, 512)
        };
        let writer = Writer::spawn(&db, cfg).expect("spawn");
        let handle = writer.handle();
        // The writer's first batch waits on this lock for 300 ms.
        let locker = lock_for(&db, Duration::from_millis(300));
        assert!(handle.send(pending("a", T0, None, "m")));
        tokio::task::yield_now().await;
        let first = handle.flush();
        tokio::pin!(first);
        // Poll it once: admitted, now waiting for the writer.
        assert!(futures_poll_once(&mut first).await.is_none());
        assert_eq!(handle.flush().await, Err(BarrierError::Busy));
        // Fill the queue behind the stuck batch: a barrier is not let in.
        while handle.send(pending("x", T0, None, "m")) {}
        let first = first.await.expect("first barrier");
        assert_eq!(
            first.committed + first.failed + first.dropped,
            first.watermark
        );
        locker.join().expect("locker");
        // Busy is released with the answer; the queue drains; a new one fits.
        let next = loop {
            match handle.flush().await {
                Ok(b) => break b,
                Err(BarrierError::Full) => tokio::time::sleep(Duration::from_millis(5)).await,
                Err(e) => panic!("{e:?}"),
            }
        };
        assert_eq!(next.committed + next.failed + next.dropped, next.watermark);
        writer.close().await.expect("close");
    });
}

/// A full queue refuses a barrier at once.
#[test]
fn a_barrier_on_a_full_queue_is_refused_without_waiting() {
    current_thread().block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let writer = Writer::spawn(
            &db,
            WriterConfig {
                capacity: 2,
                ..config(0, 512)
            },
        )
        .expect("spawn");
        let handle = writer.handle();
        // Current-thread runtime: the writer cannot drain while we fill.
        while handle.send(pending("x", T0, None, "m")) {}
        let started = std::time::Instant::now();
        assert_eq!(handle.flush().await, Err(BarrierError::Full));
        assert!(started.elapsed() < Duration::from_millis(50));
        writer.close().await.expect("close");
    });
}

/// Polls a future once; `Some` if it finished.
async fn futures_poll_once<F: std::future::Future + Unpin>(f: &mut F) -> Option<F::Output> {
    std::future::poll_fn(|cx| {
        std::task::Poll::Ready(match std::pin::Pin::new(&mut *f).poll(cx) {
            std::task::Poll::Ready(v) => Some(v),
            std::task::Poll::Pending => None,
        })
    })
    .await
}

/// `wal_autocheckpoint` is a trigger, not a bound: while another connection
/// holds a read transaction open, no checkpoint (the writer's backstop or its
/// checkpointer) may reuse the WAL frames that reader can see, so the WAL
/// grows past the trigger for as long as the reader stays. Once it ends, the
/// next checkpoint resets the WAL and new writes reuse it from the start.
/// This is SQLite's WAL design, independent of the driver.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pinned_reader_lets_the_wal_grow_past_the_trigger() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = migrated(dir.path());
    let wal = db.with_extension("db-wal");
    let cfg = WriterConfig {
        // A small trigger, to see the WAL pass it: 50 pages, ~200 KiB.
        wal_autocheckpoint: 50,
        checkpoint_every: Some(Duration::from_millis(10)),
        ..config(0, 512)
    };
    let writer = Writer::spawn(&db, cfg).expect("spawn");
    let handle = writer.handle();
    let reader = Connection::open(&db).expect("reader");
    reader.execute_batch("BEGIN").expect("begin");
    let _: i64 = reader
        .query_row("SELECT COUNT(*) FROM request_logs", [], |r| r.get(0))
        .expect("pin a snapshot");
    let batch = |from: i64| {
        for n in from..from + 2000 {
            let log = done(&format!("r{n}"), T0 + n, Some("key-1"), "sonnet", n);
            assert!(handle.send(LogEvent::Finish(log)));
        }
    };
    batch(0);
    handle.flush().await.expect("barrier");
    let pinned = std::fs::read(&wal).expect("wal");
    assert!(
        pinned.len() > 50 * 4096 * 4,
        "with a reader pinned the WAL grows past the 50-page trigger: {} bytes",
        pinned.len()
    );
    reader.execute_batch("COMMIT").expect("unpin");
    drop(reader);
    // Observe the periodic checkpoint without doing one ourselves. NOOP reports
    // the log and backfill frame counts without copying or resetting anything.
    let observer = Connection::open(&db).expect("checkpoint observer");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (busy, frames, backfilled): (i64, i64, i64) = observer
                .query_row("PRAGMA wal_checkpoint(NOOP)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .expect("read WAL backfill status");
            if busy == 0 && frames > 0 && frames == backfilled {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("checkpoint copied the pinned rows after the reader left");
    // A single write must restart the WAL; its header salt changes when SQLite
    // reuses the file. Comparing two full batches' file sizes is not evidence
    // of reuse: different batch boundaries and page splits can change the size.
    assert!(handle.send(LogEvent::Finish(done("probe", T0, None, "sonnet", 0))));
    handle.flush().await.expect("probe barrier");
    let reused = std::fs::read(&wal).expect("reused wal");
    assert_ne!(&pinned[16..24], &reused[16..24], "WAL salt did not change");
    assert!(reused.len() <= pinned.len(), "one write grew the WAL");
    batch(2000);
    handle.flush().await.expect("barrier");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM request_logs"), 4001);
    writer.close().await.expect("close");
}

/// A slot includes PG's optional shared queue credit.
#[test]
fn a_queue_slot_is_392_bytes() {
    assert_eq!(omni_store::writer::queue_slot_bytes(), 392);
}

/// A seed refused by a full queue is not an event: it never enters barrier
/// accounting (no sequence number, not in `dropped`); it is counted in
/// `seeds_refused`. A barrier after it is coherent.
#[test]
fn a_refused_seed_leaves_barrier_prefixes_coherent() {
    current_thread().block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let writer = Writer::spawn(
            &db,
            WriterConfig {
                capacity: 2,
                ..config(0, 512)
            },
        )
        .expect("spawn");
        let handle = writer.handle();
        // Current-thread runtime: nothing drains while the queue fills.
        assert!(handle.send(pending("a", T0, None, "m")));
        assert!(handle.send(pending("b", T0, None, "m")));
        let seed = omni_store::writer::SeedQuery {
            subject: "k".into(),
            api_key_id: "k".into(),
            requested_model: None,
            since_ms: 0,
            grain_ms: 60_000,
            tag: 0,
            now: 0.0,
            stamp_cap: 10,
        };
        assert!(!handle.seed(seed), "the queue is full");
        let stats = handle.stats();
        assert_eq!(stats.dropped, 0, "a refused seed is not a dropped event");
        assert_eq!(stats.seeds_refused, 1);
        // Let the writer drain, then take a barrier.
        let b = loop {
            match handle.flush().await {
                Ok(b) => break b,
                Err(BarrierError::Full) => tokio::time::sleep(Duration::from_millis(5)).await,
                Err(e) => panic!("{e:?}"),
            }
        };
        assert_eq!(
            (b.watermark, b.committed, b.failed, b.dropped),
            (2, 2, 0, 0),
            "{b:?}"
        );
        writer.close().await.expect("close");
    });
}

/// Eight producer threads on a 64-slot queue, with barriers taken back to
/// back and every third one abandoned mid-wait (as a caller's timeout does):
/// every answered barrier is an exact prefix, and the final one accounts for
/// every event sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eight_producers_with_abandoned_barriers_keep_prefixes_exact() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = migrated(dir.path());
    let writer = Writer::spawn(
        &db,
        WriterConfig {
            capacity: 64,
            ..config(0, 512)
        },
    )
    .expect("spawn");
    let handle = writer.handle();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let producers: Vec<_> = (0..8)
        .map(|p| {
            let h = handle.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut sent = 0u64;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let id = format!("q{p}-{sent}");
                    h.send(LogEvent::Finish(done(&id, T0, Some("key-1"), "sonnet", 1)));
                    sent += 1;
                    // Bursts with gaps: the queue fills (drops) and drains
                    // (barriers get in), over and over.
                    if sent.is_multiple_of(256) {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
                sent
            })
        })
        .collect();
    let mut answered = 0;
    let mut last = 0;
    let mut n = 0u64;
    let until = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < until {
        n += 1;
        let r = if n.is_multiple_of(3) {
            // Abandoned after a moment, wherever it is.
            match tokio::time::timeout(Duration::from_micros(50), handle.flush()).await {
                Ok(r) => r,
                Err(_) => continue,
            }
        } else {
            handle.flush().await
        };
        match r {
            Ok(b) => {
                assert_eq!(b.committed + b.failed + b.dropped, b.watermark, "{b:?}");
                assert!(b.watermark >= last, "{b:?}");
                last = b.watermark;
                answered += 1;
            }
            Err(BarrierError::Full | BarrierError::Busy) => tokio::task::yield_now().await,
            Err(e) => panic!("{e:?}"),
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let sent: u64 = producers
        .into_iter()
        .map(|t| t.join().expect("producer"))
        .sum();
    let fin = loop {
        match handle.flush().await {
            Ok(b) => break b,
            Err(BarrierError::Full | BarrierError::Busy) => {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Err(e) => panic!("{e:?}"),
        }
    };
    assert_eq!(fin.watermark, sent, "{fin:?}");
    assert_eq!(fin.committed + fin.failed + fin.dropped, sent, "{fin:?}");
    assert!(fin.dropped > 0, "a 64-slot queue was meant to drop");
    assert!(answered >= 3, "{answered} answered");
    writer.close().await.expect("close");
}

/// A producer never waits on a barrier: with a barrier admitted and stuck
/// behind a locked database, `send` still returns at once.
#[test]
fn send_does_not_wait_while_a_barrier_is_pending() {
    current_thread().block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let writer = Writer::spawn(&db, config(0, 512)).expect("spawn");
        let handle = writer.handle();
        let locker = lock_for(&db, Duration::from_millis(500));
        assert!(handle.send(pending("a", T0, None, "m")));
        let barrier = handle.flush();
        tokio::pin!(barrier);
        assert!(futures_poll_once(&mut barrier).await.is_none());
        let started = std::time::Instant::now();
        for n in 0..10_000 {
            handle.send(pending(&format!("x{n}"), T0, None, "m"));
        }
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "{:?}",
            started.elapsed()
        );
        let b = barrier.await.expect("barrier");
        assert_eq!(b.committed + b.failed + b.dropped, b.watermark);
        locker.join().expect("locker");
        writer.close().await.expect("close");
    });
}

/// Review A5-R2: a completion carries whether its model subject is debited
/// from the request's own event. Two rows store the same U+FFFD name; only
/// the one whose request named an unencodable model is flagged.
#[test]
fn a_completion_carries_the_requests_model_identity_not_the_stored_name() {
    current_thread().block_on(async {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let writer = Writer::spawn(
            &db,
            WriterConfig {
                commit_sink: Some(tx),
                ..config(0, 512)
            },
        )
        .expect("spawn");
        let mut lone = done("lone", T0, Some("k"), "\u{fffd}", 1);
        lone.model_unencodable = true;
        let real = done("real", T0, Some("k"), "\u{fffd}", 1);
        assert!(writer.handle().send(LogEvent::Finish(lone)));
        assert!(writer.handle().send(LogEvent::Finish(real)));
        writer.close().await.expect("close");
        let mut seen = Vec::new();
        while let Ok(m) = rx.try_recv() {
            if let omni_store::writer::Committed::Completions(c) = m {
                seen.extend(
                    c.into_iter()
                        .map(|c| (c.id, c.requested_model, c.debit_model)),
                );
            }
        }
        assert_eq!(
            seen,
            [
                ("lone".to_owned(), "\u{fffd}".to_owned(), false),
                ("real".to_owned(), "\u{fffd}".to_owned(), true)
            ]
        );
    });
}
