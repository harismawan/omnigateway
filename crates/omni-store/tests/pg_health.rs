//! Shared breaker health: the store's atomic read-modify-write
//! (`PgStore::update_health`)
//! and the immediate, bounded persistence path that carries failures and
//! breaker transitions to it independently of the request-log batches
//! (spec: "Breaker state transitions are not batched"; "A failure or state
//! transition is written to Postgres immediately … through a dedicated
//! bounded queue").

mod common;

use common::pg::{TestDb, base_url};
use omni_store::pg::{PgConfig, PgStore};
use omni_store::writer::{
    HealthCommitted, HealthStats, HealthWriter, HealthWriterConfig, LogEvent, RequestLog, Writer,
    WriterConfig,
};
use omni_store::{BreakerState, CredentialHealth, StoreError};
use std::sync::Arc;
use std::time::{Duration, Instant};

const T0: i64 = 1_794_007_800_000;

fn blank(cred: &str, model: &str) -> CredentialHealth {
    CredentialHealth {
        scalar: None,
        credential_id: cred.into(),
        model: model.into(),
        breaker_state: BreakerState::Closed,
        consecutive_failures: 0,
        opened_at: None,
        rate_limited_until: None,
    }
}

/// A failure record's shape: one more failure on whatever the row holds now,
/// opening the breaker at the threshold.
fn fail(threshold: i64) -> impl Fn(Option<CredentialHealth>) -> CredentialHealth + Send + Sync {
    move |current| {
        let mut h = current.unwrap_or_else(|| blank("c1", "m"));
        h.consecutive_failures += 1;
        if h.consecutive_failures >= threshold && h.breaker_state != BreakerState::Open {
            h.breaker_state = BreakerState::Open;
            #[allow(clippy::cast_precision_loss)]
            let opened = T0 as f64;
            h.opened_at = Some(opened);
        }
        h
    }
}

async fn store_with_credential(db: &TestDb) -> PgStore {
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    db.client()
        .await
        .batch_execute(
            "INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at)
               VALUES ('c1', 'anthropic', 'one', 'apiKey', 1, 1)",
        )
        .await
        .expect("credential");
    store
}

async fn health_row(db: &TestDb, model: &str) -> Option<(String, i32, Option<i64>)> {
    db.client()
        .await
        .query_opt(
            "SELECT breaker_state, consecutive_failures, opened_at FROM credential_health
              WHERE credential_id = 'c1' AND model = $1",
            &[&model],
        )
        .await
        .expect("health")
        .map(|r| (r.get(0), r.get(1), r.get(2)))
}

/// `update_health`: absent reads as `None`, the mutation sees the stored row,
/// the row written is the one returned, and a mutation the database refuses
/// (no such credential, a value its columns cannot hold) changes nothing
/// and says so.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_health_reads_applies_and_writes_in_one_transaction() {
    let Some(base) = base_url("update_health_reads_applies_and_writes_in_one_transaction") else {
        return;
    };
    let db = TestDb::create(&base, "health_rmw").await;
    let store = store_with_credential(&db).await;
    let seen = std::sync::Mutex::new(Vec::new());
    let first = store
        .update_health("c1", "m", &|current| {
            seen.lock().expect("lock").push(current.clone());
            fail(3)(current)
        })
        .await
        .expect("first");
    assert_eq!(first.consecutive_failures, 1);
    for _ in 0..2 {
        store
            .update_health("c1", "m", &|current| {
                seen.lock().expect("lock").push(current.clone());
                fail(3)(current)
            })
            .await
            .expect("again");
    }
    let seen = seen.into_inner().expect("seen");
    assert_eq!(seen[0], None, "an absent row reads as None");
    assert_eq!(
        seen[1].as_ref().map(|h| h.consecutive_failures),
        Some(1),
        "the stored row, not a snapshot"
    );
    assert_eq!(
        health_row(&db, "m").await,
        Some(("open".into(), 3, Some(T0)))
    );
    // The fractional instant a `Retry-After` makes is rounded by BIGINT: the
    // value binds as float8 and the column rounds it.
    let written = store
        .update_health("c1", "m", &|_| CredentialHealth {
            rate_limited_until: Some(1.5),
            ..blank("c1", "m")
        })
        .await
        .expect("fraction");
    assert_eq!(written.rate_limited_until, Some(1.5), "the row proposed");
    assert_eq!(
        store.list_health().await.expect("list")[0].rate_limited_until,
        Some(2.0),
        "the row stored"
    );

    for (what, proposed) in [
        ("ghost", blank("ghost", "m")),
        (
            "int4",
            CredentialHealth {
                consecutive_failures: i64::from(i32::MAX) + 1,
                ..blank("c1", "m")
            },
        ),
        (
            "nan",
            CredentialHealth {
                opened_at: Some(f64::NAN),
                ..blank("c1", "m")
            },
        ),
    ] {
        let cred = proposed.credential_id.clone();
        let err = store
            .update_health(&cred, "m", &move |_| proposed.clone())
            .await
            .expect_err(what);
        assert!(matches!(err, StoreError::Refused(_)), "{what}: {err}");
    }
    assert_eq!(
        health_row(&db, "m").await,
        Some(("closed".into(), 0, None)),
        "refusals left the row alone"
    );
}

/// Two replicas each record failures on the same row at once, both starting
/// from the same closed row: every failure counts, because each mutation
/// reads the row under the lock rather than writing an absolute value
/// computed from a stale snapshot.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_failures_from_two_replicas_accumulate() {
    let Some(base) = base_url("concurrent_failures_from_two_replicas_accumulate") else {
        return;
    };
    let db = TestDb::create(&base, "health_race").await;
    let a = store_with_credential(&db).await;
    let b = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("replica b");
    // Through the immediate path on each replica, as the gateway will send.
    let spawn = |s: &PgStore| {
        HealthWriter::spawn(
            omni_store::Store::Postgres(s.clone()),
            HealthWriterConfig::default(),
        )
    };
    let (wa, wb) = (spawn(&a), spawn(&b));
    let n = 100;
    let (ha, hb) = (wa.handle(), wb.handle());
    let send = |h: omni_store::writer::HealthHandle| async move {
        for _ in 0..n {
            assert!(h.send("c1", "m", Arc::new(fail(1_000_000))));
            tokio::task::yield_now().await;
        }
    };
    tokio::join!(send(ha), send(hb));
    let (sa, sb) = (
        wa.close().await.expect("close a"),
        wb.close().await.expect("close b"),
    );
    assert_eq!((sa.written, sb.written), (n, n), "{sa:?} {sb:?}");
    assert_eq!(sa.failed + sb.failed + sa.refused + sb.refused, 0);
    let (_, failures, _) = health_row(&db, "m").await.expect("row");
    assert_eq!(i64::from(failures), 2 * i64::try_from(n).expect("n"));
}

/// A transition reaches the database (and the commit sink, for publishing)
/// at once while the request-log writer is stuck behind a locked row: the
/// two paths share nothing but the pool.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transition_lands_while_the_log_writer_is_blocked() {
    let Some(base) = base_url("a_transition_lands_while_the_log_writer_is_blocked") else {
        return;
    };
    let db = TestDb::create(&base, "health_blocked").await;
    let store = store_with_credential(&db).await;
    let mut holder = db.client().await;
    holder
        .batch_execute(
            "INSERT INTO request_logs (id, state, at, requested_model, status, duration_ms)
             VALUES ('stuck', 'pending', 1, 'm', 0, 0)",
        )
        .await
        .expect("row");
    let lock = holder.transaction().await.expect("tx");
    lock.batch_execute("SELECT 1 FROM request_logs WHERE id = 'stuck' FOR UPDATE")
        .await
        .expect("lock");

    let logs = Writer::spawn_postgres(store.clone(), WriterConfig::default()).expect("logs");
    let mut finish = RequestLog::new("stuck", 1, 200);
    finish.api_key_id = Some("k".into());
    assert!(logs.handle().send(LogEvent::Finish(finish)));
    // The log batch closes at 200 ms and then waits on the lock.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let health = HealthWriter::spawn(
        omni_store::Store::Postgres(store.clone()),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    let started = Instant::now();
    assert!(health.handle().send("c1", "m", Arc::new(fail(1))));
    let committed = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("committed while the log batch is blocked")
        .expect("sink open");
    let latency = started.elapsed();
    let HealthCommitted::Written { row } = committed else {
        panic!("written: {committed:?}");
    };
    assert_eq!(row.breaker_state, BreakerState::Open);
    assert_eq!(
        health_row(&db, "m").await,
        Some(("open".into(), 1, Some(T0))),
        "visible to another connection"
    );
    let state: String = db
        .client()
        .await
        .query_one("SELECT state FROM request_logs WHERE id = 'stuck'", &[])
        .await
        .expect("log")
        .get(0);
    assert_eq!(state, "pending", "the log batch is still blocked");
    assert!(latency < Duration::from_millis(500), "{latency:?}");
    println!("transition latency with the log writer blocked: {latency:?}");
    lock.rollback().await.expect("release");
    logs.close().await.expect("log close");
    let stats = health.close().await.expect("health close");
    assert_eq!((stats.written, stats.failed), (1, 0));
}

/// And while every log batch fails for good: transitions are not rolled
/// back with them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transition_lands_while_log_batches_fail() {
    let Some(base) = base_url("a_transition_lands_while_log_batches_fail") else {
        return;
    };
    let db = TestDb::create(&base, "health_failing").await;
    let store = store_with_credential(&db).await;
    db.client()
        .await
        .batch_execute("DROP TABLE usage_rollup")
        .await
        .expect("break the log batches");
    let logs = Writer::spawn_postgres(
        store.clone(),
        WriterConfig {
            interval: Duration::from_millis(5),
            ..WriterConfig::default()
        },
    )
    .expect("logs");
    let health = HealthWriter::spawn(
        omni_store::Store::Postgres(store.clone()),
        HealthWriterConfig::default(),
    );
    for n in 0..5 {
        let mut l = RequestLog::new(format!("r{n}"), T0, 200);
        l.api_key_id = Some("k".into());
        assert!(logs.handle().send(LogEvent::Finish(l)));
        assert!(health.handle().send("c1", "m", Arc::new(fail(3))));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let hs = health.close().await.expect("health close");
    assert_eq!((hs.written, hs.failed), (5, 0));
    // Every log event resolved (failed) before the close, by a barrier, so
    // they are counted rather than failing the close. Without the barrier a
    // loaded host can leave some for the close, which then fails, correctly.
    let b = logs.handle().flush().await.expect("barrier");
    assert_eq!((b.watermark, b.committed, b.failed), (5, 0, 5));
    let ls = logs.close().await.expect("close");
    assert_eq!((ls.failed, ls.written), (5, 0), "every log batch failed");
    assert!(logs_failed(&db).await, "no log row landed");
    assert_eq!(
        health_row(&db, "m").await,
        Some(("open".into(), 5, Some(T0)))
    );
}

async fn logs_failed(db: &TestDb) -> bool {
    db.client()
        .await
        .query_one("SELECT COUNT(*) FROM request_logs", &[])
        .await
        .expect("count")
        .get::<_, i64>(0)
        == 0
}

/// Bounded: a full queue refuses without waiting and counts the drop; a
/// refused mutation is counted, not retried; close drains what is queued.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_health_queue_is_bounded_and_accounts_for_every_mutation() {
    let Some(base) = base_url("the_health_queue_is_bounded_and_accounts_for_every_mutation") else {
        return;
    };
    let db = TestDb::create(&base, "health_bounded").await;
    let store = store_with_credential(&db).await;
    // Hold the pair's advisory lock so the first mutation waits.
    let mut holder = db.client().await;
    let lock = holder.transaction().await.expect("tx");
    lock.execute("SELECT pg_advisory_xact_lock(hashtext('c1|m'))", &[])
        .await
        .expect("lock");
    let health = HealthWriter::spawn(
        omni_store::Store::Postgres(store),
        HealthWriterConfig {
            capacity: 2,
            ..HealthWriterConfig::default()
        },
    );
    let h = health.handle();
    assert!(h.send("c1", "m", Arc::new(fail(10))));
    tokio::time::sleep(Duration::from_millis(100)).await;
    // One in flight (blocked on the lock), two queued, the rest dropped.
    let started = Instant::now();
    let accepted = (0..5)
        .filter(|_| h.send("c1", "m", Arc::new(fail(10))))
        .count();
    assert!(
        started.elapsed() < Duration::from_millis(50),
        "send never waits"
    );
    assert_eq!(accepted, 2);
    assert!(h.send("ghost", "m", Arc::new(|_| blank("ghost", "m"))) || h.stats().dropped > 0);
    lock.rollback().await.expect("release");
    let stats = health.close().await.expect("health close");
    assert_eq!(stats.written, 3, "{stats:?}");
    assert!(stats.dropped >= 3, "{stats:?}");
    assert_eq!(stats.failed, 0);
    let (_, failures, _) = health_row(&db, "m").await.expect("row");
    assert_eq!(failures, 3);

    // A refusal is counted and not retried.
    let db2 = TestDb::create(&base, "health_refused").await;
    let store2 = store_with_credential(&db2).await;
    let health = HealthWriter::spawn(
        omni_store::Store::Postgres(store2),
        HealthWriterConfig::default(),
    );
    assert!(
        health
            .handle()
            .send("ghost", "m", Arc::new(|_| blank("ghost", "m")))
    );
    assert!(health.handle().send("c1", "m", Arc::new(fail(10))));
    let stats = health.close().await.expect("health close");
    assert_eq!(
        (stats.written, stats.refused, stats.failed, stats.dropped),
        (1, 1, 0, 0)
    );
}

/// The same primitive on SQLite, through the backend facade.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_health_on_sqlite_reads_applies_and_writes_atomically() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = omni_store::Store::open(omni_store::StoreConfig::Sqlite { path: path.clone() }, 0)
        .await
        .expect("open");
    rusqlite::Connection::open(&path)
        .expect("conn")
        .execute(
            "INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at)
             VALUES ('c1', 'anthropic', 'one', 'apiKey', 1, 1)",
            [],
        )
        .expect("credential");
    let health = HealthWriter::spawn(store.clone(), HealthWriterConfig::default());
    for _ in 0..4 {
        assert!(health.handle().send("c1", "m", Arc::new(fail(3))));
    }
    assert!(
        health
            .handle()
            .send("ghost", "m", Arc::new(|_| blank("ghost", "m")))
    );
    let stats = health.close().await.expect("health close");
    assert_eq!((stats.written, stats.refused), (4, 1));
    let rows = store.list_health().await.expect("health");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].consecutive_failures, 4);
    assert_eq!(rows[0].breaker_state, BreakerState::Open);
}

fn plus(n: i64) -> omni_store::writer::HealthMutation {
    Arc::new(move |current| {
        let mut h = current.unwrap_or_else(|| blank("c1", "m"));
        h.consecutive_failures += n;
        h
    })
}

fn times(n: i64) -> omni_store::writer::HealthMutation {
    Arc::new(move |current| {
        let mut h = current.unwrap_or_else(|| blank("c1", "m"));
        h.consecutive_failures *= n;
        h
    })
}

/// A mutation that panics, and one whose checked arithmetic overflows, roll
/// back, are counted `panicked`, and the next mutation goes through on the
/// same writer (and so the same pooled connections).
async fn panics_then_valid(store: omni_store::Store) -> HealthStats {
    let health = HealthWriter::spawn(store, HealthWriterConfig::default());
    let h = health.handle();
    assert!(h.send("c1", "m", plus(1)));
    assert!(h.send("c1", "m", Arc::new(|_| panic!("mutation bug"))));
    assert!(h.send(
        "c1",
        "m",
        Arc::new(|current: Option<CredentialHealth>| {
            let mut h = current.unwrap_or_else(|| blank("c1", "m"));
            // Arithmetic that overflows panics in every profile (`checked_add`
            // then `expect`), not only where overflow checks are on.
            let big = std::hint::black_box(i64::MAX);
            h.consecutive_failures = h
                .consecutive_failures
                .checked_add(big)
                .expect("failure count overflow");
            h
        })
    ));
    assert!(h.send("c1", "m", plus(1)));
    health
        .close()
        .await
        .expect("the worker survives a mutation panic")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_panicking_mutation_rolls_back_and_the_next_one_lands_on_postgres() {
    let Some(base) = base_url("a_panicking_mutation_rolls_back_and_the_next_one_lands_on_postgres")
    else {
        return;
    };
    let db = TestDb::create(&base, "health_panic").await;
    let mut cfg = PgConfig::new(&db.url);
    // One connection: the valid mutation after the panics reuses it.
    cfg.max_connections = 1;
    drop(store_with_credential(&db).await);
    let store = PgStore::open(cfg, 0).await.expect("open");
    let stats = panics_then_valid(omni_store::Store::Postgres(store.clone())).await;
    assert_eq!(
        (
            stats.enqueued,
            stats.written,
            stats.panicked,
            stats.failed,
            stats.abandoned
        ),
        (4, 2, 2, 0, 0),
        "{stats:?}"
    );
    assert_eq!(health_row(&db, "m").await.map(|r| r.1), Some(2));
    // The pair's advisory lock went with the rolled-back transaction: a
    // direct update on another connection does not wait.
    let other = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("other");
    tokio::time::timeout(
        Duration::from_secs(2),
        other.update_health("c1", "m", &|c| {
            let mut h = c.expect("row");
            h.consecutive_failures += 1;
            h
        }),
    )
    .await
    .expect("lock free")
    .expect("update");
    // And the direct call surfaces a panic as an error, not an unwind or a
    // held lock: the next call on the same one-connection pool proceeds.
    let facade = omni_store::Store::Postgres(store.clone());
    let err = facade
        .update_health("c1", "m", Arc::new(|_| panic!("direct")))
        .await
        .expect_err("panicked");
    assert!(
        matches!(err, StoreError::Panicked(ref m) if m.contains("direct")),
        "{err}"
    );
    tokio::time::timeout(
        Duration::from_secs(2),
        facade.update_health("c1", "m", plus(1)),
    )
    .await
    .expect("no held lock or stuck connection")
    .expect("update");
    assert_eq!(health_row(&db, "m").await.map(|r| r.1), Some(4));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_panicking_mutation_rolls_back_and_the_next_one_lands_on_sqlite() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = omni_store::Store::open(omni_store::StoreConfig::Sqlite { path: path.clone() }, 0)
        .await
        .expect("open");
    rusqlite::Connection::open(&path)
        .expect("conn")
        .execute(
            "INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at)
             VALUES ('c1', 'anthropic', 'one', 'apiKey', 1, 1)",
            [],
        )
        .expect("credential");
    // The facade directly: a panic is an error, and the same Store (the same
    // connection) takes the next transaction.
    let err = store
        .update_health("c1", "m", Arc::new(|_| panic!("direct")))
        .await
        .expect_err("panicked");
    assert!(
        matches!(err, StoreError::Panicked(ref m) if m.contains("direct")),
        "{err}"
    );
    store
        .update_health("c1", "m", plus(1))
        .await
        .expect("the connection is not left inside a transaction");
    // Another connection can write at once: the write lock was released.
    let other = rusqlite::Connection::open(&path).expect("other");
    other
        .busy_timeout(Duration::from_millis(10))
        .expect("timeout");
    other
        .execute(
            "UPDATE credential_health SET consecutive_failures = consecutive_failures",
            [],
        )
        .expect("write lock free");
    drop(other);
    let stats = panics_then_valid(store.clone()).await;
    assert_eq!(
        (
            stats.enqueued,
            stats.written,
            stats.panicked,
            stats.failed,
            stats.abandoned
        ),
        (4, 2, 2, 0, 0),
        "{stats:?}"
    );
    assert_eq!(
        store.list_health().await.expect("health")[0].consecutive_failures,
        3
    );
}

/// FIFO with non-commutative mutations: (+1, ×3, +2, ×2) from 0 is 10 only
/// in send order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_commutative_mutations_apply_in_send_order() {
    let Some(base) = base_url("non_commutative_mutations_apply_in_send_order") else {
        return;
    };
    let db = TestDb::create(&base, "health_fifo").await;
    let store = store_with_credential(&db).await;
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let health = HealthWriter::spawn(
        omni_store::Store::Postgres(store),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    let h = health.handle();
    for m in [plus(1), times(3), plus(2), times(2)] {
        assert!(h.send("c1", "m", m));
    }
    health.close().await.expect("close");
    assert_eq!(health_row(&db, "m").await.map(|r| r.1), Some(10));
    let mut seen = Vec::new();
    while let Ok(HealthCommitted::Written { row }) = rx.try_recv() {
        seen.push(row.consecutive_failures);
    }
    assert_eq!(seen, [1, 3, 5, 10], "the sink hears them in commit order");
}

/// A full sink and a closed sink each count the notification as dropped;
/// the commits themselves are unaffected.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_and_closed_sinks_count_dropped_notifications_only() {
    let Some(base) = base_url("full_and_closed_sinks_count_dropped_notifications_only") else {
        return;
    };
    let db = TestDb::create(&base, "health_sinks").await;
    let store = store_with_credential(&db).await;
    // Full: room for one.
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let health = HealthWriter::spawn(
        omni_store::Store::Postgres(store.clone()),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    for _ in 0..3 {
        assert!(health.handle().send("c1", "m", plus(1)));
    }
    let stats = health.close().await.expect("close");
    assert_eq!((stats.written, stats.sink_dropped), (3, 2), "{stats:?}");
    assert!(matches!(rx.try_recv(), Ok(HealthCommitted::Written { .. })));
    // Closed: the receiver is gone.
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    drop(rx);
    let health = HealthWriter::spawn(
        omni_store::Store::Postgres(store),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    for _ in 0..2 {
        assert!(health.handle().send("c1", "m", plus(1)));
    }
    let stats = health.close().await.expect("close");
    assert_eq!((stats.written, stats.sink_dropped), (2, 2), "{stats:?}");
    assert_eq!(health_row(&db, "m").await.map(|r| r.1), Some(5));
}

/// Sends racing `close` from another task: each is either refused (counted
/// dropped) or accepted and applied before `close` returns; none is lost.
/// A send after `close` was called is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sends_during_close_are_refused_or_applied_never_lost() {
    let Some(base) = base_url("sends_during_close_are_refused_or_applied_never_lost") else {
        return;
    };
    let db = TestDb::create(&base, "health_close").await;
    let store = store_with_credential(&db).await;
    let health = HealthWriter::spawn(
        omni_store::Store::Postgres(store),
        HealthWriterConfig::default(),
    );
    let h = health.handle();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sender = {
        let (h, stop) = (h.clone(), Arc::clone(&stop));
        tokio::spawn(async move {
            let (mut ok, mut refused) = (0_u64, 0_u64);
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                if h.send("c1", "m", plus(1)) {
                    ok += 1;
                } else {
                    refused += 1;
                }
                tokio::task::yield_now().await;
            }
            (ok, refused)
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let stats = health.close().await.expect("close");
    // After close was called, every send is refused.
    assert!(!h.send("c1", "m", plus(1)));
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let (ok, refused) = sender.await.expect("sender");
    assert!(ok > 0, "some sends landed before the close");
    assert!(refused > 0, "some sends raced the close and were refused");
    assert_eq!(stats.enqueued, ok, "{stats:?}");
    assert_eq!(
        stats.written, ok,
        "every accepted send applied before close returned"
    );
    assert_eq!(
        h.stats().dropped,
        refused + 1,
        "refused sends (and the one after close) are counted"
    );
    assert_eq!(
        health_row(&db, "m").await.map(|r| i64::from(r.1)),
        Some(i64::try_from(ok).expect("ok"))
    );
}

/// A SQLite COMMIT that fails (here a deferred foreign key, checked only at
/// COMMIT) is rolled back by the transaction guard: the connection is left
/// out of any transaction and the next call on the same `Store` proceeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_sqlite_commit_rolls_back_and_the_next_call_proceeds() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = omni_store::Store::open(omni_store::StoreConfig::Sqlite { path: path.clone() }, 0)
        .await
        .expect("open");
    let conn = rusqlite::Connection::open(&path).expect("conn");
    conn.execute(
        "INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at)
         VALUES ('c1', 'anthropic', 'one', 'apiKey', 1, 1)",
        [],
    )
    .expect("credential");
    // Test-only: a deferred foreign key, so a violating row is refused at
    // COMMIT rather than at the INSERT.
    conn.execute_batch(
        "CREATE TABLE commit_guard (credential_id TEXT REFERENCES credentials (id)
                                      DEFERRABLE INITIALLY DEFERRED);
         CREATE TRIGGER commit_guard AFTER INSERT ON credential_health
           WHEN NEW.consecutive_failures = 7
           BEGIN INSERT INTO commit_guard VALUES ('nobody'); END;",
    )
    .expect("deferred guard");
    drop(conn);
    let err = store
        .update_health(
            "c1",
            "m",
            Arc::new(|_| CredentialHealth {
                consecutive_failures: 7,
                ..blank("c1", "m")
            }),
        )
        .await
        .expect_err("refused at COMMIT");
    // The deferred check fires at COMMIT, not at the INSERT: rusqlite
    // reports SQLITE_CONSTRAINT_FOREIGNKEY from the COMMIT statement.
    assert!(
        matches!(&err, StoreError::Sqlite(rusqlite::Error::SqliteFailure(e, _))
            if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
        "{err:?}"
    );
    store
        .update_health("c1", "m", plus(1))
        .await
        .expect("the connection is not left inside a transaction");
    let rows = store.list_health().await.expect("health");
    assert_eq!(
        rows[0].consecutive_failures, 1,
        "the refused row never landed"
    );
}
