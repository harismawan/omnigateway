//! The health path's retry boundary: a mutation that definitely did not
//! commit (lock wait past the statement timeout) is retried, and one whose
//! COMMIT outcome is unknown (the acknowledgement lost with the connection)
//! is never applied a second time.

mod common;

use common::pg::{TestDb, base_url};
use common::proxy::{Fault, Proxy};
use omni_store::pg::{PgConfig, PgStore};
use omni_store::writer::{HealthCommitted, HealthWriter, HealthWriterConfig, Observed};
use omni_store::{BreakerState, CredentialHealth, Store, StoreError};
use std::sync::Arc;
use std::time::Duration;

fn plus_one(current: Option<CredentialHealth>) -> CredentialHealth {
    let mut h = current.unwrap_or(CredentialHealth {
        scalar: None,
        credential_id: "c1".into(),
        model: "m".into(),
        breaker_state: BreakerState::Closed,
        consecutive_failures: 0,
        opened_at: None,
        rate_limited_until: None,
    });
    h.consecutive_failures += 1;
    h
}

async fn seeded(db: &TestDb) {
    drop(
        PgStore::open(PgConfig::new(&db.url), 0)
            .await
            .expect("migrate"),
    );
    db.client()
        .await
        .batch_execute(
            "INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at)
               VALUES ('c1', 'anthropic', 'one', 'apiKey', 1, 1);
             INSERT INTO credential_health (credential_id, model, consecutive_failures)
               VALUES ('c1', 'm', 0);",
        )
        .await
        .expect("seed");
}

async fn failures(db: &TestDb) -> i32 {
    db.client()
        .await
        .query_one(
            "SELECT consecutive_failures FROM credential_health WHERE credential_id = 'c1' AND model = 'm'",
            &[],
        )
        .await
        .expect("row")
        .get(0)
}

fn upstream(base: &str) -> String {
    let rest = base.split_once('@').expect("credentials").1;
    rest.split('/').next().expect("host").to_owned()
}

/// One increment whose COMMIT reaches the server but whose acknowledgement
/// is lost with the connection: the row holds exactly one increment.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_commit_acknowledgement_is_not_applied_twice() {
    let Some(base) = base_url("a_lost_commit_acknowledgement_is_not_applied_twice") else {
        return;
    };
    let db = TestDb::create(&base, "lost_ack").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let store = PgStore::open(PgConfig::new(proxy.url(&db.url)), 0)
        .await
        .expect("open through the proxy");
    let health = HealthWriter::spawn(Store::Postgres(store), HealthWriterConfig::default());
    proxy.arm_commit_loss();
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while proxy.fired() == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the COMMIT ack was never lost"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _stats = health.close().await.expect("close");
    assert_eq!(proxy.fired(), 1);
    assert_eq!(
        failures(&db).await,
        1,
        "applied once, not re-applied after the lost ack"
    );
}

/// Close reports the uncertain mutation as such: not written, not failed,
/// and its reconciliation re-read is what the database holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_uncertain_commit_is_counted_and_reconciled_by_a_re_read() {
    let Some(base) = base_url("an_uncertain_commit_is_counted_and_reconciled_by_a_re_read") else {
        return;
    };
    let db = TestDb::create(&base, "uncertain").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let store = PgStore::open(PgConfig::new(proxy.url(&db.url)), 0)
        .await
        .expect("open through the proxy");
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    proxy.arm_commit_loss();
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    // A later mutation still goes through, once.
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    assert_eq!(
        (
            stats.enqueued,
            stats.written,
            stats.uncertain,
            stats.failed,
            stats.refused
        ),
        (2, 1, 1, 0, 0),
        "{stats:?}"
    );
    assert_eq!(failures(&db).await, 2, "each applied exactly once");
    let mut seen = Vec::new();
    while let Ok(m) = rx.try_recv() {
        seen.push(m);
    }
    assert_eq!(seen.len(), 2, "{seen:?}");
    match &seen[0] {
        HealthCommitted::Uncertain { observed, .. } => {
            let Observed::Row(row) = observed else {
                panic!("re-read after the lost ack: {observed:?}");
            };
            assert_eq!(
                row.consecutive_failures, 1,
                "the re-read observes the stored row (an observation, not an acknowledgement)"
            );
        }
        other => panic!("first is the uncertain one: {other:?}"),
    }
    match &seen[1] {
        HealthCommitted::Written { row } => assert_eq!(row.consecutive_failures, 2),
        other => panic!("{other:?}"),
    }
}

/// A health-lock wait past the statement timeout definitely rolled back, so
/// it is retried, and a retry commits once the lock goes. The lock is
/// released only after the writer is *seen* to have retried twice (its
/// counters, not a timer), and the retry budget leaves seconds of backoff
/// for that release to land, so no exact retry count depends on scheduling.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_statement_timeout_on_the_health_lock_is_retried_and_commits() {
    let Some(base) = base_url("a_statement_timeout_on_the_health_lock_is_retried_and_commits")
    else {
        return;
    };
    let db = TestDb::create(&base, "lock_timeout").await;
    seeded(&db).await;
    let mut cfg = PgConfig::new(&db.url);
    cfg.statement_timeout = Duration::from_millis(80);
    let store = PgStore::open(cfg, 0).await.expect("open");
    let mut holder = db.client().await;
    let lock = holder.transaction().await.expect("tx");
    lock.execute("SELECT pg_advisory_xact_lock(hashtext('c1|m'))", &[])
        .await
        .expect("hold the pair's lock");
    let max_attempts = 8;
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            max_attempts,
            // Backoff 20, 40, …, 1280 ms: about 2.5 s after the second retry.
            retry_base: Duration::from_millis(20),
            ..HealthWriterConfig::default()
        },
    );
    let h = health.handle();
    assert!(h.send("c1", "m", Arc::new(plus_one)));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while h.stats().retried < 2 {
        let s = h.stats();
        assert_eq!(
            (s.written, s.failed, s.uncertain),
            (0, 0, 0),
            "nothing lands or fails while the lock is held: {s:?}"
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "never retried twice: {s:?}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let before_release = h.stats();
    assert_eq!(
        failures(&db).await,
        0,
        "two timed-out attempts wrote nothing"
    );
    lock.rollback().await.expect("release");
    let stats = health.close().await.expect("close");
    assert_eq!(
        (stats.written, stats.failed, stats.uncertain),
        (1, 0, 0),
        "{stats:?}"
    );
    assert!(
        (2..max_attempts.into()).contains(&stats.retried)
            && stats.retried >= before_release.retried,
        "{before_release:?} then {stats:?}"
    );
    assert_eq!(failures(&db).await, 1, "applied once");
}

/// Past the retry budget, a definitely-rolled-back mutation fails and is
/// counted; nothing was written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_exhaustion_fails_the_mutation_and_writes_nothing() {
    let Some(base) = base_url("retry_exhaustion_fails_the_mutation_and_writes_nothing") else {
        return;
    };
    let db = TestDb::create(&base, "exhausted").await;
    seeded(&db).await;
    let mut cfg = PgConfig::new(&db.url);
    cfg.statement_timeout = Duration::from_millis(50);
    let store = PgStore::open(cfg, 0).await.expect("open");
    let mut holder = db.client().await;
    let lock = holder.transaction().await.expect("tx");
    lock.execute("SELECT pg_advisory_xact_lock(hashtext('c1|m'))", &[])
        .await
        .expect("hold");
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            retry_base: Duration::from_millis(10),
            ..HealthWriterConfig::default()
        },
    );
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    lock.rollback().await.expect("release");
    assert_eq!(
        (stats.written, stats.retried, stats.failed, stats.uncertain),
        (0, 2, 1, 0),
        "{stats:?}"
    );
    assert_eq!(failures(&db).await, 0);
}

/// COMMIT reaches the server and commits; the client is then told
/// `FATAL 57P01` (administrator shutdown) and the connection closes. A
/// SQLSTATE does not make this a rollback: it is uncertain, and the
/// increment lands once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fatal_shutdown_after_commit_is_uncertain_and_applied_once() {
    let Some(base) = base_url("a_fatal_shutdown_after_commit_is_uncertain_and_applied_once") else {
        return;
    };
    let db = TestDb::create(&base, "fatal_after_commit").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let store = PgStore::open(PgConfig::new(proxy.url(&db.url)), 0)
        .await
        .expect("open through the proxy");
    // The error the driver hands back, directly.
    proxy.arm(Fault::FatalAfterCommit);
    let err = store
        .update_health("c1", "m", &plus_one)
        .await
        .expect_err("the client never hears the commit");
    assert!(matches!(err, StoreError::UncertainCommit(_)), "{err:?}");
    assert_eq!(failures(&db).await, 1);
    // And through the writer: counted uncertain, never re-applied.
    let health = HealthWriter::spawn(Store::Postgres(store), HealthWriterConfig::default());
    proxy.arm(Fault::FatalAfterCommit);
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    assert_eq!(proxy.fired(), 2);
    assert_eq!(
        (stats.written, stats.uncertain, stats.retried, stats.failed),
        (0, 1, 0, 0),
        "{stats:?}"
    );
    assert_eq!(failures(&db).await, 2, "each applied once");
}

/// The connection goes before the COMMIT reaches the server, so the server
/// rolls the transaction back. The client cannot tell this from a lost
/// acknowledgement, so it is (conservatively) uncertain, and the reported
/// re-read shows nothing landed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_lost_before_commit_is_conservatively_uncertain() {
    let Some(base) = base_url("a_connection_lost_before_commit_is_conservatively_uncertain") else {
        return;
    };
    let db = TestDb::create(&base, "drop_before_commit").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let store = PgStore::open(PgConfig::new(proxy.url(&db.url)), 0)
        .await
        .expect("open through the proxy");
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    proxy.arm(Fault::DropBeforeCommit);
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    assert_eq!(proxy.fired(), 1);
    assert_eq!((stats.written, stats.uncertain), (0, 1), "{stats:?}");
    assert_eq!(failures(&db).await, 0, "rolled back by the server");
    match rx.try_recv().expect("an outcome") {
        HealthCommitted::Uncertain { observed, .. } => {
            assert_eq!(
                observed,
                Observed::Row(seed_row()),
                "an observation, not an acknowledgement"
            );
        }
        other => panic!("{other:?}"),
    }
}

/// When the re-read itself fails, the event says so rather than reading as
/// an absent row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_reconciliation_read_is_reported_as_unknown() {
    let Some(base) = base_url("a_failed_reconciliation_read_is_reported_as_unknown") else {
        return;
    };
    let db = TestDb::create(&base, "reread_fails").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let mut cfg = PgConfig::new(proxy.url(&db.url));
    cfg.max_connections = 1;
    cfg.wait_timeout = Duration::from_millis(200);
    cfg.connect_timeout = Duration::from_millis(200);
    let store = PgStore::open(cfg, 0).await.expect("open through the proxy");
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    proxy.refuse_after_fire();
    proxy.arm(Fault::LoseAck);
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    assert_eq!(stats.uncertain, 1, "{stats:?}");
    match rx.try_recv().expect("an outcome") {
        HealthCommitted::Uncertain { observed, .. } => {
            assert!(matches!(observed, Observed::Unknown(_)), "{observed:?}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(failures(&db).await, 1);
}

fn seed_row() -> CredentialHealth {
    CredentialHealth {
        scalar: None,
        credential_id: "c1".into(),
        model: "m".into(),
        breaker_state: BreakerState::Closed,
        consecutive_failures: 0,
        opened_at: None,
        rate_limited_until: None,
    }
}

/// A COMMIT the server itself rejects (a deferred constraint, checked at
/// COMMIT, severity ERROR, SQLSTATE 23514): positively not committed. The
/// rejected write is a refusal of its values, surfaced as an error from
/// `update_health`;
/// it is not counted uncertain, and the next mutation proceeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_commit_the_server_rejects_is_not_uncertain() {
    let Some(base) = base_url("a_commit_the_server_rejects_is_not_uncertain") else {
        return;
    };
    let db = TestDb::create(&base, "commit_rejected").await;
    seeded(&db).await;
    // Test-only: a deferred constraint trigger that rejects, at COMMIT, a
    // failure count of 7.
    db.client()
        .await
        .batch_execute(
            "CREATE FUNCTION reject_seven() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.consecutive_failures = 7 THEN
                 RAISE EXCEPTION 'seven is rejected at commit' USING ERRCODE = '23514';
               END IF;
               RETURN NULL;
             END $$;
             CREATE CONSTRAINT TRIGGER reject_seven AFTER INSERT OR UPDATE ON credential_health
               DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_seven();",
        )
        .await
        .expect("deferred trigger");
    let store = PgStore::open(PgConfig::new(&db.url), 0)
        .await
        .expect("open");
    let err = store
        .update_health("c1", "m", &|c| CredentialHealth {
            consecutive_failures: 7,
            ..c.expect("row")
        })
        .await
        .expect_err("rejected at commit");
    assert!(matches!(err, StoreError::Refused(_)), "{err:?}");
    let health = HealthWriter::spawn(Store::Postgres(store), HealthWriterConfig::default());
    assert!(health.handle().send(
        "c1",
        "m",
        Arc::new(|c: Option<CredentialHealth>| CredentialHealth {
            consecutive_failures: 7,
            ..c.expect("row")
        })
    ));
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    assert_eq!(
        (
            stats.written,
            stats.refused,
            stats.uncertain,
            stats.retried,
            stats.failed
        ),
        (1, 1, 0, 0, 0),
        "{stats:?}"
    );
    assert_eq!(failures(&db).await, 1);
}

/// A test-only deferred constraint trigger on `credential_health` that
/// raises `code` (severity ERROR) at COMMIT: on the first COMMIT only when
/// `first_only` (the count lives in a sequence, which a rollback does not
/// undo), otherwise on every one.
async fn fail_commit_with(db: &TestDb, code: &str, first_only: bool) {
    let when = if first_only {
        "nextval('commit_attempts') = 1"
    } else {
        "true"
    };
    db.client()
        .await
        .batch_execute(&format!(
            "CREATE SEQUENCE commit_attempts;
             CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF {when} THEN
                 RAISE EXCEPTION 'rejected at commit' USING ERRCODE = '{code}';
               END IF;
               RETURN NULL;
             END $$;
             CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT OR UPDATE ON credential_health
               DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit();"
        ))
        .await
        .expect("deferred trigger");
}

/// The two class-40 codes PostgreSQL documents for retrying a transaction
/// (serialization failure 40001, deadlock 40P01; docs §13.5),
/// raised at COMMIT with severity ERROR: the store returns a retryable
/// error, the writer retries, and the retry commits once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_class_40_rejection_at_commit_is_retried_and_lands_once() {
    let Some(base) = base_url("a_class_40_rejection_at_commit_is_retried_and_lands_once") else {
        return;
    };
    for code in ["40001", "40P01"] {
        let db = TestDb::create(&base, &format!("commit_{}", code.to_lowercase())).await;
        seeded(&db).await;
        fail_commit_with(&db, code, true).await;
        let store = PgStore::open(PgConfig::new(&db.url), 0)
            .await
            .expect("open");
        let health = HealthWriter::spawn(
            Store::Postgres(store),
            HealthWriterConfig {
                retry_base: Duration::from_millis(5),
                ..HealthWriterConfig::default()
            },
        );
        assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
        let stats = health.close().await.expect("close");
        assert_eq!(
            (stats.written, stats.retried, stats.uncertain, stats.failed),
            (1, 1, 0, 0),
            "{code}: {stats:?}"
        );
        assert_eq!(
            failures(&db).await,
            1,
            "{code}: the rejected commit rolled back; the retry landed once"
        );
    }
}

/// Any other class-40 code at COMMIT, even at severity ERROR, is not on the
/// retry allowlist: 40000 (generic transaction rollback) and 40002 carry no
/// documented retry contract, so the outcome is treated as unknown. The
/// store says `UncertainCommit`; the writer counts it uncertain, does not
/// re-apply it, and reports the re-read. (Here the server did roll back,
/// so the row is unchanged: conservatism costs one lost increment, never a
/// double one.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn other_class_40_codes_at_commit_are_uncertain_and_not_retried() {
    let Some(base) = base_url("other_class_40_codes_at_commit_are_uncertain_and_not_retried")
    else {
        return;
    };
    for code in ["40000", "40002"] {
        let db = TestDb::create(&base, &format!("commit_{code}")).await;
        seeded(&db).await;
        fail_commit_with(&db, code, false).await;
        let store = PgStore::open(PgConfig::new(&db.url), 0)
            .await
            .expect("open");
        let err = store
            .update_health("c1", "m", &plus_one)
            .await
            .expect_err("rejected at commit");
        assert!(
            matches!(err, StoreError::UncertainCommit(_)),
            "{code}: {err:?}"
        );
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let health = HealthWriter::spawn(
            Store::Postgres(store),
            HealthWriterConfig {
                retry_base: Duration::from_millis(5),
                commit_sink: Some(tx),
                ..HealthWriterConfig::default()
            },
        );
        assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
        let stats = health.close().await.expect("close");
        assert_eq!(
            (
                stats.written,
                stats.uncertain,
                stats.retried,
                stats.failed,
                stats.refused
            ),
            (0, 1, 0, 0, 0),
            "{code}: {stats:?}"
        );
        assert_eq!(failures(&db).await, 0, "{code}: never re-applied");
        match rx.try_recv().expect("an outcome") {
            HealthCommitted::Uncertain { observed, .. } => {
                assert_eq!(observed, Observed::Row(seed_row()), "{code}");
            }
            other => panic!("{code}: {other:?}"),
        }
    }
}

/// COMMIT reaches the server and commits; the client is then told
/// `ERROR 40003` (statement completion unknown) and the connection closes.
/// That code says, in so many words, that the outcome is unknown: it is
/// uncertain, never retried, the increment lands once, and the sink hears
/// `Uncertain`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completion_unknown_after_commit_is_uncertain_and_applied_once() {
    let Some(base) = base_url("completion_unknown_after_commit_is_uncertain_and_applied_once")
    else {
        return;
    };
    let db = TestDb::create(&base, "unknown_after_commit").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let store = PgStore::open(PgConfig::new(proxy.url(&db.url)), 0)
        .await
        .expect("open through the proxy");
    proxy.arm(Fault::CompletionUnknownAfterCommit);
    let err = store
        .update_health("c1", "m", &plus_one)
        .await
        .expect_err("the client never hears the commit");
    assert!(matches!(err, StoreError::UncertainCommit(_)), "{err:?}");
    assert_eq!(failures(&db).await, 1);
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    proxy.arm(Fault::CompletionUnknownAfterCommit);
    assert!(health.handle().send("c1", "m", Arc::new(plus_one)));
    let stats = health.close().await.expect("close");
    assert_eq!(proxy.fired(), 2);
    assert_eq!(
        (stats.written, stats.uncertain, stats.retried, stats.failed),
        (0, 1, 0, 0),
        "{stats:?}"
    );
    assert_eq!(failures(&db).await, 2, "each applied once");
    match rx.try_recv().expect("an outcome") {
        HealthCommitted::Uncertain { observed, .. } => {
            let Observed::Row(row) = observed else {
                panic!("{observed:?}");
            };
            assert_eq!(row.consecutive_failures, 2);
        }
        other => panic!("{other:?}"),
    }
}

/// The pair has no row yet and the connection goes before COMMIT reaches
/// the server: the server rolls back, and the reported re-read is `Absent`
/// (not a reset to closed, not a read failure).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_uncertain_first_write_observes_an_absent_row() {
    let Some(base) = base_url("an_uncertain_first_write_observes_an_absent_row") else {
        return;
    };
    let db = TestDb::create(&base, "absent_after_drop").await;
    seeded(&db).await;
    let proxy = Proxy::start(upstream(&base)).await;
    let store = PgStore::open(PgConfig::new(proxy.url(&db.url)), 0)
        .await
        .expect("open through the proxy");
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let health = HealthWriter::spawn(
        Store::Postgres(store),
        HealthWriterConfig {
            commit_sink: Some(tx),
            ..HealthWriterConfig::default()
        },
    );
    proxy.arm(Fault::DropBeforeCommit);
    assert!(health.handle().send(
        "c1",
        "fresh",
        Arc::new(|c: Option<CredentialHealth>| {
            assert!(c.is_none(), "the pair starts absent");
            CredentialHealth {
                model: "fresh".into(),
                ..plus_one(None)
            }
        })
    ));
    let stats = health.close().await.expect("close");
    assert_eq!(proxy.fired(), 1);
    assert_eq!(
        (stats.written, stats.uncertain, stats.panicked),
        (0, 1, 0),
        "{stats:?}"
    );
    let rows: i64 = db
        .client()
        .await
        .query_one(
            "SELECT count(*) FROM credential_health WHERE model = 'fresh'",
            &[],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(rows, 0, "rolled back by the server");
    match rx.try_recv().expect("an outcome") {
        HealthCommitted::Uncertain {
            credential_id,
            model,
            observed,
        } => {
            assert_eq!((credential_id.as_str(), model.as_str()), ("c1", "fresh"));
            assert_eq!(observed, Observed::Absent);
        }
        other => panic!("{other:?}"),
    }
}
