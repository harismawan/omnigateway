//! The batched writer against the TS store: the same events leave the same
//! `request_logs`, `usage_daily`, `usage_rollup` and `credential_health` rows,
//! however the Rust side happens to batch them.

mod common;

use common::{bun_available, bun_script, ts, typed_rows};
use omni_store::writer::{
    BreakerTransition, HealthMeasurement, LogEvent, PendingLog, RequestLog, RouteTarget,
    WriteEvent, Writer, WriterConfig,
};
use omni_store::{BreakerState, CredentialHealth, SqliteStore};
use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;

const NODE: &str = "node-a";
const TABLES: [&str; 4] = [
    "request_logs",
    "usage_daily",
    "usage_rollup",
    "credential_health",
];
/// 2026-11-06T23:30:00Z: half an hour before midnight UTC, so the +60 offset
/// puts some of these requests on another day than UTC does.
const T0: i64 = 1_794_007_800_000;

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

fn route(id: &str, provider: &str, model: &str, cred: &str) -> LogEvent {
    LogEvent::Route {
        id: id.into(),
        target: RouteTarget {
            provider: provider.into(),
            model: model.into(),
            credential_id: cred.into(),
        },
    }
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

/// The row a breaker transition persists.
fn transition(cred: &str, model: &str, state: BreakerState, failures: i64) -> WriteEvent {
    BreakerTransition(CredentialHealth {
        credential_id: cred.into(),
        model: model.into(),
        breaker_state: state,
        consecutive_failures: failures,
        opened_at: (failures > 0).then_some(T0 + failures),
        rate_limited_until: (failures == 2).then_some(T0 + 60_000),
    })
    .into()
}

fn measure(cred: &str, model: &str, failures: i64, until: Option<i64>) -> WriteEvent {
    HealthMeasurement {
        credential_id: cred.into(),
        model: model.into(),
        consecutive_failures: failures,
        rate_limited_until: until,
    }
    .into()
}

/// Transitions that must each be applied in order, measurements around them
/// that must not revert their state, and one row for a credential that does
/// not exist (the foreign key refuses it on both sides).
fn health_sequence() -> Vec<WriteEvent> {
    use BreakerState::{Closed, HalfOpen, Open};
    vec![
        // Open -> Closed for one pair: the final row is the Closed one.
        transition("cred-1", "sonnet", Open, 3),
        measure("cred-1", "sonnet", 4, Some(T0 + 5)),
        transition("cred-1", "sonnet", Closed, 0),
        // Closed -> Open -> HalfOpen, with a measurement after the last one:
        // it keeps HalfOpen and its `opened_at`, and sets the two counters.
        transition("cred-2", "gpt-x", Closed, 0),
        transition("cred-2", "gpt-x", Open, 2),
        transition("cred-2", "gpt-x", HalfOpen, 2),
        measure("cred-2", "gpt-x", 1, None),
        measure("cred-2", "gpt-x", 5, Some(T0 + 9)),
        // A measurement before a transition is overwritten by it.
        measure("cred-3", "opus", 7, Some(T0 + 1)),
        transition("cred-3", "opus", Open, 1),
        // A measurement on a pair with no row files a blank one.
        measure("cred-1", "haiku", 2, Some(T0 + 60_000)),
        // A measurement over a row that existed before the batch.
        measure("cred-3", "seeded", 9, None),
        transition("cred-ghost", "sonnet", Open, 3),
    ]
}

/// Every lifecycle the gateway produces, plus the out-of-order and repeated
/// ones the TS claim semantics have an answer for.
fn sequence() -> Vec<WriteEvent> {
    let k = Some("key-1");
    let mut ev: Vec<WriteEvent> = Vec::new();
    let mut push = |e: LogEvent| ev.push(e.into());

    // Plain: begin, finish.
    push(pending("r01", T0, k, "sonnet"));
    push(LogEvent::Finish(done("r01", T0, k, "sonnet", 1)));
    // Failover: begin, route, route, finish naming the last target.
    push(pending("r02", T0 + 1, k, "sonnet"));
    push(route("r02", "openai", "gpt-x", "cred-2"));
    push(route("r02", "codex", "gpt-y", "cred-3"));
    let mut l = done("r02", T0 + 1, k, "sonnet", 2);
    l.attempts = 3;
    l.resolved_provider = Some("codex".into());
    l.resolved_model = Some("gpt-y".into());
    l.credential_id = Some("cred-3".into());
    l.degradations = vec!["droppedThinking".into(), "q\"uo\\te\u{2028}é".into()];
    push(LogEvent::Finish(l));
    // Begun and still pending at the end.
    push(pending("r03", T0 + 2, k, "haiku"));
    push(route("r03", "openai", "gpt-z", "cred-2"));
    // Failed before dispatch: no begin at all.
    let mut l = RequestLog::new("r04", T0 + 3, 400);
    l.api_key_id = k.map(Into::into);
    l.requested_model = "sonnet".into();
    l.error_code = Some("INVALID_REQUEST".into());
    push(LogEvent::Finish(l));
    // Terminal catch: a blank log over a row that began keeps the row's key,
    // model and start time.
    push(pending("r05", T0 + 4, k, "opus"));
    let mut l = RequestLog::new("r05", T0 + 999_999, 502);
    l.error_code = Some("UPSTREAM".into());
    l.duration_ms = 1234;
    push(LogEvent::Finish(l));
    // Cancelled mid-stream.
    push(pending("r06", T0 + 5, k, "sonnet"));
    let mut l = done("r06", T0 + 5, k, "sonnet", 6);
    l.status = 499;
    l.error_code = Some("CANCELLED".into());
    push(LogEvent::Finish(l));
    // Finished twice: the second claim loses and counts nothing.
    push(pending("r07", T0 + 6, k, "sonnet"));
    push(LogEvent::Finish(done("r07", T0 + 6, k, "sonnet", 7)));
    push(LogEvent::Finish(done("r07", T0 + 6, k, "sonnet", 70)));
    // A route and a begin after the finish change nothing.
    push(route("r07", "openai", "late", "cred-9"));
    push(pending("r07", T0 + 6, k, "late"));
    // Begun twice: the second insert is refused.
    push(pending("r08", T0 + 7, k, "sonnet"));
    push(pending("r08", T0 + 7, Some("key-other"), "other"));
    push(LogEvent::Finish(done("r08", T0 + 7, k, "sonnet", 8)));
    // A route before any begin updates nothing; the begin then files it.
    push(route("r09", "openai", "early", "cred-2"));
    push(pending("r09", T0 + 8, k, "sonnet"));
    push(LogEvent::Finish(done("r09", T0 + 8, k, "sonnet", 9)));
    // Anonymous: a daily row, no hourly one.
    push(pending("r10", T0 + 9, None, "sonnet"));
    push(LogEvent::Finish(done("r10", T0 + 9, None, "sonnet", 10)));
    // RTK and a finish carrying another key than the begin.
    push(pending("r11", T0 + 10, k, "sonnet"));
    let mut l = done("r11", T0 + 10, Some("key-2"), "sonnet", 11);
    l.rtk_applied = true;
    l.rtk_filter_hits = 3;
    l.rtk_original_code_units = 9000;
    l.rtk_compressed_code_units = 4000;
    l.rtk_estimated_tokens_saved = 1250;
    l.rtk_filters = vec!["git-status".into(), "ls".into()];
    push(LogEvent::Finish(l));
    // Many into one key and hour, and across midnight at the +60 offset, so
    // the daily and hourly sums cross batch boundaries.
    for n in 0..40 {
        let id = format!("m{n:02}");
        let at = T0 + 1_000 + n * 60_000;
        push(pending(&id, at, k, "sonnet"));
        if n % 7 == 3 {
            push(route(&id, "openai", "gpt-x", "cred-2"));
        }
        let mut l = done(&id, at, k, "sonnet", n);
        if n % 9 == 0 {
            l.status = 529;
        }
        push(LogEvent::Finish(l));
    }
    ev.extend(health_sequence());
    ev
}

/// A migrated database holding the credentials health rows refer to, with
/// one usage row already present so the batch adds onto existing state.
fn prepare(path: &Path, offset: i64) {
    let store = SqliteStore::open(path, offset).expect("open");
    let conn = store.connection();
    for id in ["cred-1", "cred-2", "cred-3"] {
        conn.execute(
            "INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at)
             VALUES (?, 'anthropic', ?, 'apiKey', 1, 1)",
            [id, id],
        )
        .expect("credential");
    }
    conn.execute_batch(
        "INSERT INTO credential_health VALUES ('cred-3', 'seeded', 'open', 4, 1794000000000, NULL);
         INSERT INTO usage_rollup VALUES ('key-1', 498335, 5, 1, 2, 3, 4, 0.7);
         INSERT INTO usage_daily (day, provider, credential_id, requested_model, resolved_model,
                                  api_key_id, requests, cost_usd)
              VALUES (1793923200000, 'anthropic', 'cred-1', 'sonnet', 'sonnet-upstream',
                      'key-1', 2, 0.3);",
    )
    .expect("seed");
}

fn event_json(e: &WriteEvent) -> serde_json::Value {
    match e {
        WriteEvent::Log(l) => serde_json::to_value(l).expect("log json"),
        WriteEvent::BreakerTransition(BreakerTransition(h)) => {
            let mut v = serde_json::to_value(h).expect("health json");
            v.as_object_mut()
                .expect("object")
                .insert("type".into(), "breakerTransition".into());
            v
        }
        WriteEvent::HealthMeasurement(m) => serde_json::json!({
            "type": "healthMeasurement",
            "credentialId": m.credential_id,
            "model": m.model,
            "consecutiveFailures": m.consecutive_failures,
            "rateLimitedUntil": m.rate_limited_until,
        }),
    }
}

fn run_ts(dir: &Path, db: &Path, offset: i64, events: &[WriteEvent]) {
    let input = serde_json::json!({
        "db": db.display().to_string(),
        "nodeId": NODE,
        "dayOffsetMinutes": offset,
        "events": events.iter().map(event_json).collect::<Vec<_>>(),
    });
    let script = format!(
        "await import({:?});\n",
        ts("conformance/store/usage-writer.ts")
    );
    let out = bun_script(dir, &script, &input.to_string());
    assert!(out.contains("\"healthFailures\":1"), "ts driver: {out}");
}

fn config(offset: i64, max_batch: usize) -> WriterConfig {
    WriterConfig {
        node_id: NODE.into(),
        day_offset_minutes: offset,
        max_batch,
        ..WriterConfig::default()
    }
}

/// Sends `events` and closes. `max_batch` decides how they split.
async fn run_rust(db: &Path, cfg: WriterConfig, events: &[WriteEvent]) -> u64 {
    let writer = Writer::spawn(db, cfg).expect("spawn");
    let handle = writer.handle();
    for e in events {
        assert!(handle.send(e.clone()), "channel full");
        // Let the writer take what is there, so batches really do split.
        tokio::task::yield_now().await;
    }
    let stats = writer.close().await.expect("close");
    assert_eq!(stats.dropped, 0);
    assert_eq!(stats.failed, 0);
    assert_eq!(stats.health_refused, 1, "the ghost credential, as in TS");
    stats.batches
}

fn rows(db: &Path) -> Vec<(&'static str, Vec<Vec<String>>)> {
    let conn = Connection::open(db).expect("open");
    TABLES.iter().map(|t| (*t, typed_rows(&conn, t))).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rows_equal_what_the_ts_store_writes() {
    if !bun_available("rows_equal_what_the_ts_store_writes") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let events = sequence();
    for offset in [0, 60, -330] {
        let ts_db = dir.path().join(format!("ts{offset}.db"));
        prepare(&ts_db, offset);
        run_ts(dir.path(), &ts_db, offset, &events);
        let want = rows(&ts_db);
        assert!(
            want[2].1.len() >= 2 && want[1].1.len() >= 4,
            "fixture reaches several daily and hourly rows"
        );
        for max_batch in [1, 2, 3, 7, 512] {
            let rs_db = dir.path().join(format!("rs{offset}-{max_batch}.db"));
            prepare(&rs_db, offset);
            let batches = run_rust(&rs_db, config(offset, max_batch), &events).await;
            if max_batch == 1 {
                assert!(batches >= 100, "one event per batch: {batches}");
            }
            let got = rows(&rs_db);
            for ((table, w), (_, g)) in want.iter().zip(&got) {
                let only_rust: Vec<_> = g.iter().filter(|r| !w.contains(r)).collect();
                let only_ts: Vec<_> = w.iter().filter(|r| !g.contains(r)).collect();
                assert!(
                    g == w,
                    "{table} differs at offset {offset}, max_batch {max_batch}\n\
                     rust only: {only_rust:?}\nts only: {only_ts:?}"
                );
            }
        }
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
fn drops_warn_at_most_once_per_interval_with_the_count_since_the_last() {
    current_thread().block_on(async {
        let (log, _guard) = Captured::install();
        let dir = tempfile::tempdir().expect("tempdir");
        let db = migrated(dir.path());
        let cfg = WriterConfig {
            capacity: 1,
            drop_warn_interval: Duration::from_millis(50),
            ..config(0, 512)
        };
        let writer = Writer::spawn(&db, cfg).expect("spawn");
        let handle = writer.handle();
        let send = |n: i64| handle.send(LogEvent::Finish(done(&format!("r{n}"), T0, None, "m", n)));
        assert!(send(0));
        for n in 1..10 {
            assert!(!send(n));
        }
        let warned = log.lines("events dropped");
        assert_eq!(warned.len(), 1, "{warned:?}");
        assert!(warned[0].contains("dropped=1 "), "{warned:?}");
        // Blocking: the writer cannot drain meanwhile.
        std::thread::sleep(Duration::from_millis(60));
        assert!(!send(10));
        let warned = log.lines("events dropped");
        assert_eq!(warned.len(), 2, "{warned:?}");
        assert!(warned[1].contains("dropped=9 "), "{warned:?}");
        assert!(warned[1].contains("dropped_total=10"), "{warned:?}");
        assert_eq!(handle.dropped(), 10);
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
            errors[0].contains("ERROR") && errors[0].contains("events=3"),
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
