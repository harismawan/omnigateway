//! The batched writer on Postgres against the TS Postgres store: the same
//! events leave the same `request_logs`, `usage_daily`, `usage_rollup` and
//! `credential_health` rows, however the Rust side batches them; and the
//! writer's ordering, retry and failure accounting are the SQLite writer's.

mod common;

use common::pg::{TestDb, base_url, table_rows};
use common::{bun_required, bun_script, ts};
use omni_store::pg::{PgConfig, PgStore};
use omni_store::writer::{
    BreakerTransition, Committed, HealthMeasurement, LogEvent, PendingLog, RequestLog, RouteTarget,
    SeedQuery, WriteEvent, Writer, WriterConfig,
};
use omni_store::{BreakerState, CredentialHealth};
use std::time::Duration;

const NODE: &str = "node-a";
const TABLES: [&str; 4] = [
    "request_logs",
    "usage_daily",
    "usage_rollup",
    "credential_health",
];
/// 2026-11-06T23:30:00Z, half an hour before midnight UTC.
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
    #[allow(clippy::cast_precision_loss)]
    let cost = 0.1 + (n as f64) * 0.000_123_456_789;
    log.cost_usd = cost;
    log
}

#[allow(clippy::cast_precision_loss)]
fn transition(cred: &str, model: &str, state: BreakerState, failures: i64) -> WriteEvent {
    BreakerTransition(CredentialHealth {
        scalar: None,
        credential_id: cred.into(),
        model: model.into(),
        breaker_state: state,
        consecutive_failures: failures,
        opened_at: (failures > 0).then_some(T0 as f64 + failures as f64),
        // Fractional, as a fractional Retry-After makes it in TS; the BIGINT
        // column rounds it.
        rate_limited_until: (failures == 2).then_some(T0 as f64 + 60_000.5),
    })
    .into()
}

fn measure(cred: &str, model: &str, failures: i64, until: Option<f64>) -> WriteEvent {
    HealthMeasurement {
        credential_id: cred.into(),
        model: model.into(),
        consecutive_failures: failures,
        rate_limited_until: until,
    }
    .into()
}

#[allow(clippy::cast_precision_loss)]
fn health_sequence() -> Vec<WriteEvent> {
    use BreakerState::{Closed, HalfOpen, Open};
    vec![
        transition("cred-1", "sonnet", Open, 3),
        measure("cred-1", "sonnet", 4, Some(T0 as f64 + 5.0)),
        transition("cred-1", "sonnet", Closed, 0),
        transition("cred-2", "gpt-x", Closed, 0),
        transition("cred-2", "gpt-x", Open, 2),
        transition("cred-2", "gpt-x", HalfOpen, 2),
        measure("cred-2", "gpt-x", 1, None),
        // Half-to-even on the way into BIGINT: .5 and 1.5 land differently.
        measure("cred-2", "gpt-x", 5, Some(T0 as f64 + 9.5)),
        measure("cred-3", "opus", 7, Some(T0 as f64 + 1.0)),
        transition("cred-3", "opus", Open, 1),
        measure("cred-1", "haiku", 2, Some(T0 as f64 + 60_001.5)),
        measure("cred-3", "seeded", 9, None),
        transition("cred-ghost", "sonnet", Open, 3),
        // A valid measurement, then a transition Postgres refuses (failures
        // out of INTEGER range): TS keeps the measurement and rejects only
        // the transition, whatever the batch boundaries.
        measure("cred-1", "mixed", 2, None),
        BreakerTransition(CredentialHealth {
            scalar: None,
            credential_id: "cred-1".into(),
            model: "mixed".into(),
            breaker_state: Open,
            consecutive_failures: i64::from(i32::MAX) + 1,
            opened_at: Some(T0 as f64),
            rate_limited_until: None,
        })
        .into(),
    ]
}

/// Every lifecycle the gateway produces (as `writer.rs`'s `sequence`), plus
/// the Postgres-specific edges: a `-0` and an integral cost, and anonymous
/// and keyed requests in the same hour.
fn sequence() -> Vec<WriteEvent> {
    let k = Some("key-1");
    let mut ev: Vec<WriteEvent> = Vec::new();
    let mut push = |e: LogEvent| ev.push(e.into());
    push(pending("r01", T0, k, "sonnet"));
    push(LogEvent::Finish(done("r01", T0, k, "sonnet", 1)));
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
    push(pending("r03", T0 + 2, k, "haiku"));
    push(route("r03", "openai", "gpt-z", "cred-2"));
    let mut l = RequestLog::new("r04", T0 + 3, 400);
    l.api_key_id = k.map(Into::into);
    l.requested_model = "sonnet".into();
    l.error_code = Some("INVALID_REQUEST".into());
    push(LogEvent::Finish(l));
    push(pending("r05", T0 + 4, k, "opus"));
    let mut l = RequestLog::new("r05", T0 + 999_999, 502);
    l.error_code = Some("UPSTREAM".into());
    l.duration_ms = 1234;
    push(LogEvent::Finish(l));
    push(pending("r06", T0 + 5, k, "sonnet"));
    let mut l = done("r06", T0 + 5, k, "sonnet", 6);
    l.status = 499;
    l.error_code = Some("CANCELLED".into());
    push(LogEvent::Finish(l));
    push(pending("r07", T0 + 6, k, "sonnet"));
    push(LogEvent::Finish(done("r07", T0 + 6, k, "sonnet", 7)));
    push(LogEvent::Finish(done("r07", T0 + 6, k, "sonnet", 70)));
    push(route("r07", "openai", "late", "cred-9"));
    push(pending("r07", T0 + 6, k, "late"));
    push(pending("r08", T0 + 7, k, "sonnet"));
    push(pending("r08", T0 + 7, Some("key-other"), "other"));
    push(LogEvent::Finish(done("r08", T0 + 7, k, "sonnet", 8)));
    push(route("r09", "openai", "early", "cred-2"));
    push(pending("r09", T0 + 8, k, "sonnet"));
    push(LogEvent::Finish(done("r09", T0 + 8, k, "sonnet", 9)));
    push(pending("r10", T0 + 9, None, "sonnet"));
    push(LogEvent::Finish(done("r10", T0 + 9, None, "sonnet", 10)));
    push(pending("r11", T0 + 10, k, "sonnet"));
    let mut l = done("r11", T0 + 10, Some("key-2"), "sonnet", 11);
    l.rtk_applied = true;
    l.rtk_filter_hits = 3;
    l.rtk_original_code_units = 9000;
    l.rtk_compressed_code_units = 4000;
    l.rtk_estimated_tokens_saved = 1250;
    l.rtk_filters = vec!["git-status".into(), "ls".into()];
    push(LogEvent::Finish(l));
    // `-0` survives in float8 on both sides; an integral cost too.
    let mut l = done("r12", T0 + 11, k, "sonnet", 12);
    l.cost_usd = -0.0;
    push(LogEvent::Finish(l));
    let mut l = done("r13", T0 + 12, k, "sonnet", 13);
    l.cost_usd = 2.0;
    push(LogEvent::Finish(l));
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

async fn prepare(db: &TestDb, offset: i64) -> PgStore {
    let store = PgStore::open(PgConfig::new(&db.url), offset)
        .await
        .expect("open");
    let c = db.client().await;
    c.batch_execute(
        "INSERT INTO credentials (id, provider, label, auth_type, created_at, updated_at)
           VALUES ('cred-1', 'anthropic', 'cred-1', 'apiKey', 1, 1),
                  ('cred-2', 'anthropic', 'cred-2', 'apiKey', 1, 1),
                  ('cred-3', 'anthropic', 'cred-3', 'apiKey', 1, 1);
         INSERT INTO credential_health VALUES ('cred-3', 'seeded', 'open', 4, 1794000000000, NULL);
         INSERT INTO usage_rollup VALUES ('key-1', 498335, 5, 1, 2, 3, 4, 0.7);
         INSERT INTO usage_daily (day, provider, credential_id, requested_model, resolved_model,
                                  api_key_id, requests, cost_usd)
              VALUES (1793923200000, 'anthropic', 'cred-1', 'sonnet', 'sonnet-upstream',
                      'key-1', 2, 0.3);",
    )
    .await
    .expect("seed");
    store
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
        WriteEvent::Seed(_) => unreachable!("no seeds in the TS sequence"),
    }
}

fn run_ts(dir: &std::path::Path, url: &str, offset: i64, events: &[WriteEvent]) {
    let input = serde_json::json!({
        "url": url,
        "nodeId": NODE,
        "dayOffsetMinutes": offset,
        "events": events.iter().map(event_json).collect::<Vec<_>>(),
    });
    let script = format!(
        "await import({:?});\n",
        ts("conformance/store/pg-usage-writer.ts")
    );
    let out = bun_script(dir, &script, &input.to_string());
    assert!(out.contains("\"healthFailures\":2"), "ts driver: {out}");
}

fn config(offset: i64, max_batch: usize) -> WriterConfig {
    WriterConfig {
        node_id: NODE.into(),
        day_offset_minutes: offset,
        max_batch,
        ..WriterConfig::default()
    }
}

async fn run_rust(store: PgStore, cfg: WriterConfig, events: &[WriteEvent]) -> u64 {
    let writer = Writer::spawn_postgres(store, cfg).expect("spawn");
    let handle = writer.handle();
    for e in events {
        assert!(handle.send(e.clone()), "channel full");
        tokio::task::yield_now().await;
    }
    let stats = writer.close().await.expect("close");
    assert_eq!(stats.dropped, 0);
    assert_eq!(stats.failed, 0);
    assert_eq!(
        stats.health_refused, 2,
        "the ghost credential and the out-of-range transition, as in TS"
    );
    stats.batches
}

async fn rows(db: &TestDb) -> Vec<(&'static str, Vec<String>)> {
    let c = db.client().await;
    let mut out = Vec::new();
    for t in TABLES {
        out.push((t, table_rows(&c, t).await));
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rows_equal_what_the_ts_postgres_store_writes() {
    let Some(base) = base_url("rows_equal_what_the_ts_postgres_store_writes") else {
        return;
    };
    if !bun_required("rows_equal_what_the_ts_postgres_store_writes") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let events = sequence();
    for offset in [0, 60, -330] {
        let ts_db = TestDb::create(&base, &format!("wts{offset}")).await;
        drop(prepare(&ts_db, offset).await);
        run_ts(dir.path(), &ts_db.url, offset, &events);
        let want = rows(&ts_db).await;
        assert!(
            want[2].1.len() >= 2 && want[1].1.len() >= 4,
            "fixture reaches several daily and hourly rows"
        );
        for max_batch in [1, 3, 7, 512] {
            let rs_db = TestDb::create(&base, &format!("wrs{offset}_{max_batch}")).await;
            let store = prepare(&rs_db, offset).await;
            let batches = run_rust(store, config(offset, max_batch), &events).await;
            if max_batch == 1 {
                assert!(batches >= 100, "one event per batch: {batches}");
            }
            let got = rows(&rs_db).await;
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

/// TS appends to a row the Rust writer began, and the Rust writer completes
/// a row TS began: one replica of each on one database.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ts_and_rust_continue_each_others_rows() {
    let Some(base) = base_url("ts_and_rust_continue_each_others_rows") else {
        return;
    };
    if !bun_required("ts_and_rust_continue_each_others_rows") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let db = TestDb::create(&base, "mixed_rows").await;
    let store = prepare(&db, 0).await;
    let k = Some("key-1");
    // Rust begins a, TS begins b.
    run_rust_events(&store, &[pending("a", T0, k, "m").into()]).await;
    run_ts_events(dir.path(), &db.url, &[pending("b", T0 + 1, k, "m").into()]);
    // TS finishes a, Rust finishes b.
    run_ts_events(
        dir.path(),
        &db.url,
        &[LogEvent::Finish(done("a", T0, k, "m", 1)).into()],
    );
    run_rust_events(
        &store,
        &[LogEvent::Finish(done("b", T0 + 1, k, "m", 2)).into()],
    )
    .await;
    let c = db.client().await;
    let states: Vec<(String, String, i64)> = c
        .query(
            "SELECT id, state, input_tokens FROM request_logs ORDER BY id",
            &[],
        )
        .await
        .expect("rows")
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        states,
        vec![
            ("a".into(), "done".into(), 101),
            ("b".into(), "done".into(), 102)
        ]
    );
    let requests: i64 = c
        .query_one(
            "SELECT requests FROM usage_rollup WHERE api_key_id = 'key-1' AND hour = $1",
            &[&T0.div_euclid(3_600_000)],
        )
        .await
        .expect("rollup")
        .get(0);
    // `prepare` seeded this bucket with 5 requests.
    assert_eq!(
        requests,
        5 + 2,
        "each completion counted once, by whichever wrote it"
    );
}

async fn run_rust_events(store: &PgStore, events: &[WriteEvent]) {
    let writer = Writer::spawn_postgres(store.clone(), config(0, 512)).expect("spawn");
    for e in events {
        assert!(writer.handle().send(e.clone()));
    }
    let stats = writer.close().await.expect("close");
    assert_eq!(stats.failed, 0);
}

fn run_ts_events(dir: &std::path::Path, url: &str, events: &[WriteEvent]) {
    let input = serde_json::json!({
        "url": url,
        "nodeId": "node-ts",
        "dayOffsetMinutes": 0,
        "events": events.iter().map(event_json).collect::<Vec<_>>(),
    });
    let script = format!(
        "await import({:?});\n",
        ts("conformance/store/pg-usage-writer.ts")
    );
    bun_script(dir, &script, &input.to_string());
}

/// Two Rust writers (two replicas) on the same keys and hours at once:
/// every completion is counted exactly once, though their batches race on
/// the same rollup rows and on inserting them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_writers_racing_on_one_hour_count_everything_once() {
    let Some(base) = base_url("two_writers_racing_on_one_hour_count_everything_once") else {
        return;
    };
    let db = TestDb::create(&base, "race_writers").await;
    let store = prepare(&db, 0).await;
    let spawn = |node: &str| {
        Writer::spawn_postgres(
            store.clone(),
            WriterConfig {
                node_id: node.into(),
                max_batch: 64,
                interval: Duration::from_millis(5),
                ..WriterConfig::default()
            },
        )
        .expect("spawn")
    };
    let (a, b) = (spawn("a"), spawn("b"));
    let (ha, hb) = (a.handle(), b.handle());
    let n = 2_000_i64;
    for i in 0..n {
        let h = if i % 2 == 0 { &ha } else { &hb };
        // Two keys, one hour, every row new: the hourly and daily rows are
        // inserted by whichever batch gets there first.
        let key = if i % 3 == 0 { "key-1" } else { "key-2" };
        assert!(h.send(LogEvent::Finish(done(
            &format!("x{i}"),
            T0 + i,
            Some(key),
            "m",
            1
        ))));
        if i % 50 == 0 {
            tokio::task::yield_now().await;
        }
    }
    let (sa, sb) = (a.close().await.expect("a"), b.close().await.expect("b"));
    assert_eq!(sa.failed + sb.failed, 0, "{sa:?} {sb:?}");
    let c = db.client().await;
    let total: i64 = c
        .query_one(
            "SELECT SUM(requests)::bigint FROM usage_rollup WHERE hour = $1",
            &[&T0.div_euclid(3_600_000)],
        )
        .await
        .expect("sum")
        .get(0);
    let daily: i64 = c
        .query_one(
            "SELECT SUM(requests)::bigint FROM usage_daily WHERE requested_model = 'm'",
            &[],
        )
        .await
        .expect("sum")
        .get(0);
    let logs: i64 = c
        .query_one("SELECT COUNT(*) FROM request_logs", &[])
        .await
        .expect("count")
        .get(0);
    // `prepare` seeded key-1's bucket in this hour with 5 requests.
    assert_eq!((logs, total, daily), (n, n + 5, n));
}

/// A batch whose transaction fails for good is counted, reported, rolled
/// back whole, and fails `close` (the SQLite writer's semantics).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_batch_is_counted_rolled_back_and_fails_close() {
    let Some(base) = base_url("a_failed_batch_is_counted_rolled_back_and_fails_close") else {
        return;
    };
    let db = TestDb::create(&base, "failed_batch").await;
    let store = prepare(&db, 0).await;
    let c = db.client().await;
    c.batch_execute("DROP TABLE usage_rollup")
        .await
        .expect("drop");
    let writer = Writer::spawn_postgres(store, config(0, 512)).expect("spawn");
    let handle = writer.handle();
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
    let n: i64 = c
        .query_one("SELECT COUNT(*) FROM request_logs", &[])
        .await
        .expect("count")
        .get(0);
    assert_eq!(n, 0, "rolled back");
}

/// A row lock held by another session past the statement timeout is the
/// transient class: retried, then committed once the lock goes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_locked_row_is_retried_until_it_commits() {
    let Some(base) = base_url("a_locked_row_is_retried_until_it_commits") else {
        return;
    };
    let db = TestDb::create(&base, "locked_retry").await;
    drop(prepare(&db, 0).await);
    let mut cfg = PgConfig::new(&db.url);
    cfg.statement_timeout = Duration::from_millis(80);
    let store = PgStore::open(cfg, 0).await.expect("open");
    let mut holder = db.client().await;
    holder
        .batch_execute("INSERT INTO request_logs (id, state, at, requested_model, status, duration_ms) VALUES ('p1', 'pending', 1, 'm', 0, 0)")
        .await
        .expect("row");
    let tx = holder.transaction().await.expect("tx");
    tx.batch_execute("SELECT 1 FROM request_logs WHERE id = 'p1' FOR UPDATE")
        .await
        .expect("lock");
    let writer = Writer::spawn_postgres(store, config(0, 512)).expect("spawn");
    assert!(
        writer
            .handle()
            .send(LogEvent::Finish(done("p1", 1, Some("k"), "m", 1)))
    );
    // Attempts at ~0, ~100 and ~300 ms; release before the third.
    tokio::time::sleep(Duration::from_millis(250)).await;
    tx.rollback().await.expect("release");
    let stats = writer.close().await.expect("close after retry");
    assert_eq!((stats.batches, stats.failed), (1, 0));
    let state: String = holder
        .query_one("SELECT state FROM request_logs WHERE id = 'p1'", &[])
        .await
        .expect("row")
        .get(0);
    assert_eq!(state, "done");
}

/// Seeds are read after every event queued before them is committed, and
/// delivered in order with the completions.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_seed_reads_everything_committed_before_it() {
    let Some(base) = base_url("a_seed_reads_everything_committed_before_it") else {
        return;
    };
    let db = TestDb::create(&base, "seed_order").await;
    let store = prepare(&db, 0).await;
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let writer = Writer::spawn_postgres(
        store,
        WriterConfig {
            commit_sink: Some(tx),
            ..config(0, 512)
        },
    )
    .expect("spawn");
    let h = writer.handle();
    for n in 0..5 {
        assert!(h.send(LogEvent::Finish(done(
            &format!("s{n}"),
            T0 + n,
            Some("key-9"),
            "m",
            1
        ))));
    }
    assert!(h.seed(SeedQuery {
        subject: "key-9".into(),
        api_key_id: "key-9".into(),
        requested_model: None,
        since_ms: T0 - 3_600_000,
        grain_ms: 3_600_000,
        tag: 3,
        now: 0.0,
        stamp_cap: 3,
    }));
    writer.close().await.expect("close");
    let mut completions = 0;
    let mut seed = None;
    while let Ok(m) = rx.try_recv() {
        match m {
            Committed::Completions(c) => {
                assert!(seed.is_none(), "completions after the seed");
                completions += c.len();
            }
            Committed::Seed { result, .. } => seed = Some(result.expect("seed read")),
            Committed::Gap => panic!("gap"),
        }
    }
    assert_eq!(completions, 5);
    let seed = seed.expect("seed delivered");
    assert_eq!(seed.stamps, vec![T0 + 2, T0 + 3, T0 + 4]);
    let requests: f64 = seed.buckets.iter().map(|(_, c)| c.requests).sum();
    assert!((requests - 5.0).abs() < f64::EPSILON);
}

/// The read-set guard, deterministically: another session inserts the very
/// rollup and log rows a batch read as absent, and commits while the batch's
/// upsert waits on them. The batch must not overwrite them (TS would have
/// added to the rollup and refused the duplicate begin); it fails as a
/// conflict, is retried, and the retry folds onto what the other committed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_another_writer_inserted_after_the_read_is_added_to_not_overwritten() {
    let Some(base) =
        base_url("a_row_another_writer_inserted_after_the_read_is_added_to_not_overwritten")
    else {
        return;
    };
    let db = TestDb::create(&base, "guard").await;
    let store = prepare(&db, 0).await;
    let hour = T0.div_euclid(3_600_000);
    let mut other = db.client().await;
    let other_pid: i32 = other
        .query_one("SELECT pg_backend_pid()", &[])
        .await
        .expect("pid")
        .get(0);
    let tx = other.transaction().await.expect("tx");
    tx.execute(
        "INSERT INTO usage_rollup VALUES ('key-race', $1, 10, 1, 1, 1, 1, 0.5)",
        &[&hour],
    )
    .await
    .expect("rollup");
    tx.batch_execute(
        "INSERT INTO request_logs (id, state, node_id, at, requested_model, status, duration_ms)
         VALUES ('z', 'done', 'other', 7, 'theirs', 200, 3)",
    )
    .await
    .expect("log");
    let writer = Writer::spawn_postgres(store, config(0, 512)).expect("spawn");
    let h = writer.handle();
    assert!(h.send(pending("z", T0, Some("key-race"), "ours")));
    assert!(h.send(LogEvent::Finish(done("y", T0, Some("key-race"), "m", 1))));
    // The batch read `z` as absent and its log upsert now waits on it.
    wait_for_blocked(&db, other_pid, "INSERT INTO request_logs").await;
    tx.commit().await.expect("commit");
    let stats = writer.close().await.expect("close");
    assert_eq!(stats.failed, 0);
    assert_eq!(stats.written, 2);
    let requests: i64 = other
        .query_one(
            "SELECT requests FROM usage_rollup WHERE api_key_id = 'key-race' AND hour = $1",
            &[&hour],
        )
        .await
        .expect("rollup")
        .get(0);
    assert_eq!(
        requests, 11,
        "added onto the committed row, not overwriting it"
    );
    let (state, model): (String, String) = other
        .query_one(
            "SELECT state, requested_model FROM request_logs WHERE id = 'z'",
            &[],
        )
        .await
        .map(|r| (r.get(0), r.get(1)))
        .expect("log");
    assert_eq!(
        (state.as_str(), model.as_str()),
        ("done", "theirs"),
        "the begin is refused, as TS's plain INSERT is"
    );
}

/// What Postgres would refuse a value of fails only that event, as TS's
/// `begin`/`append`/`updateHealth` throws for that request alone and its
/// callers swallow it: an `INTEGER` status out of range, a non-finite
/// instant. The rest of the batch commits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_value_postgres_refuses_fails_only_its_own_event() {
    let Some(base) = base_url("a_value_postgres_refuses_fails_only_its_own_event") else {
        return;
    };
    let db = TestDb::create(&base, "refused_values").await;
    let store = prepare(&db, 0).await;
    let writer = Writer::spawn_postgres(store, config(0, 512)).expect("spawn");
    let h = writer.handle();
    let mut bad = done("bad", T0, Some("key-1"), "m", 1);
    bad.status = i64::from(i32::MAX) + 1;
    assert!(h.send(pending("bad", T0, Some("key-1"), "m")));
    assert!(h.send(LogEvent::Finish(bad)));
    assert!(h.send(LogEvent::Finish(done("good", T0, Some("key-1"), "m", 1))));
    assert!(h.send(measure("cred-1", "nan", 1, Some(f64::NAN))));
    assert!(h.send(measure("cred-1", "ok", 1, Some(1.5))));
    // Resolved by a barrier, so the close has nothing left to lose.
    let b = h.flush().await.expect("barrier");
    assert_eq!(
        (b.watermark, b.committed, b.failed, b.refused, b.dropped),
        (5, 4, 1, 1, 0),
        "the refused finish is failed (and refused), never committed"
    );
    let stats = writer.close().await.expect("close");
    assert_eq!((stats.failed, stats.refused, stats.batches), (1, 1, 1));
    assert_eq!(stats.written, 4, "the refused event is not written");
    assert_eq!(stats.health_refused, 1, "the NaN instant");
    let c = db.client().await;
    let rows: Vec<(String, String)> = c
        .query("SELECT id, state FROM request_logs ORDER BY id", &[])
        .await
        .expect("rows")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("bad".into(), "pending".into()),
            ("good".into(), "done".into())
        ],
        "the refused finish leaves its row pending, as a thrown COMPLETE does"
    );
    let until: Option<i64> = c
        .query_one(
            "SELECT rate_limited_until FROM credential_health WHERE model = 'ok'",
            &[],
        )
        .await
        .expect("health")
        .get(0);
    assert_eq!(until, Some(2), "1.5 rounds half to even into BIGINT");
}

/// The URL's own `options` survive the pool's `statement_timeout`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn url_options_are_kept_beside_the_statement_timeout() {
    let Some(base) = base_url("url_options_are_kept_beside_the_statement_timeout") else {
        return;
    };
    let db = TestDb::create(&base, "url_options").await;
    let sep = if db.url.contains('?') { '&' } else { '?' };
    let url = format!(
        "{}{sep}options=-c%20search_path%3Dpublic%2Cpg_catalog",
        db.url
    );
    let mut cfg = PgConfig::new(&url);
    cfg.statement_timeout = std::time::Duration::from_millis(1234);
    let store = PgStore::open(cfg, 0).await.expect("open");
    let c = store.client().await.expect("client");
    let row = c
        .query_one(
            "SELECT current_setting('statement_timeout'), current_setting('search_path')",
            &[],
        )
        .await
        .expect("settings");
    let (timeout, path): (String, String) = (row.get(0), row.get(1));
    assert_eq!(timeout, "1234ms");
    assert_eq!(path, "public,pg_catalog");
}

/// A refused log event is accounted for as such: counted `refused` (and
/// `failed`, since it is not persisted), never `written` or committed;
/// resolved as failed in a barrier; and when it is among the events a
/// close waits on, the close fails, as for any other unpersisted event.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_log_event_is_counted_failed_and_refused_not_written() {
    let Some(base) = base_url("a_refused_log_event_is_counted_failed_and_refused_not_written")
    else {
        return;
    };
    let db = TestDb::create(&base, "log_refused").await;
    let store = prepare(&db, 0).await;
    let refused = || {
        let mut l = done("bad", T0, Some("key-1"), "m", 1);
        l.status = i64::from(i32::MAX) + 1;
        LogEvent::Finish(l)
    };

    // Through a barrier.
    let writer = Writer::spawn_postgres(store.clone(), config(0, 512)).expect("spawn");
    let h = writer.handle();
    assert!(h.send(refused()));
    let b = h.flush().await.expect("barrier");
    assert_eq!(
        (b.watermark, b.committed, b.failed, b.refused, b.dropped),
        (1, 0, 1, 1, 0)
    );
    assert_eq!(b.committed + b.failed + b.dropped, b.watermark);
    let stats = writer.close().await.expect("nothing lost on close");
    assert_eq!(
        (
            stats.enqueued,
            stats.written,
            stats.failed,
            stats.refused,
            stats.batches
        ),
        (1, 0, 1, 1, 1)
    );

    // On close.
    let writer = Writer::spawn_postgres(store, config(0, 512)).expect("spawn");
    let h = writer.handle();
    assert!(h.send(refused()));
    assert!(h.send(LogEvent::Finish(done("good", T0, Some("key-1"), "m", 1))));
    let closed = writer.close().await;
    assert!(
        matches!(&closed, Err(e) if e.to_string().contains("1 queued events failed")),
        "{closed:?}"
    );
    let stats = h.stats();
    assert_eq!((stats.written, stats.failed, stats.refused), (1, 1, 1));
    let c = db.client().await;
    let rows: Vec<String> = c
        .query("SELECT id FROM request_logs ORDER BY id", &[])
        .await
        .expect("rows")
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(rows, ["good"], "isolation: the valid event still lands");
}

/// The hourly rollup's read-set guard on its own: another session inserts
/// the very `usage_rollup` row the batch read as absent and commits while
/// the batch's upsert waits on it. Nothing else conflicts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hourly_guard_adds_onto_a_row_inserted_after_the_read() {
    let Some(base) = base_url("the_hourly_guard_adds_onto_a_row_inserted_after_the_read") else {
        return;
    };
    let db = TestDb::create(&base, "guard_hourly").await;
    let store = prepare(&db, 0).await;
    let hour = T0.div_euclid(3_600_000);
    let mut other = db.client().await;
    let other_pid: i32 = other
        .query_one("SELECT pg_backend_pid()", &[])
        .await
        .expect("pid")
        .get(0);
    let tx = other.transaction().await.expect("tx");
    tx.execute(
        "INSERT INTO usage_rollup VALUES ('key-h', $1, 10, 1, 1, 1, 1, 0.5)",
        &[&hour],
    )
    .await
    .expect("rollup");
    let writer = Writer::spawn_postgres(store, config(0, 512)).expect("spawn");
    assert!(
        writer
            .handle()
            .send(LogEvent::Finish(done("h1", T0, Some("key-h"), "m", 1)))
    );
    // The batch read the hourly row as absent; its upsert waits on it.
    wait_for_blocked(&db, other_pid, "INSERT INTO usage_rollup").await;
    tx.commit().await.expect("commit");
    let stats = writer.close().await.expect("close");
    assert_eq!((stats.failed, stats.written), (0, 1));
    let (requests, input): (i64, i64) = other
        .query_one(
            "SELECT requests, input_tokens FROM usage_rollup WHERE api_key_id = 'key-h' AND hour = $1",
            &[&hour],
        )
        .await
        .map(|r| (r.get(0), r.get(1)))
        .expect("rollup");
    assert_eq!(
        (requests, input),
        (11, 1 + 101),
        "added onto, not overwritten"
    );
}

/// The daily rollup's guard on its own, likewise.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_daily_guard_adds_onto_a_row_inserted_after_the_read() {
    let Some(base) = base_url("the_daily_guard_adds_onto_a_row_inserted_after_the_read") else {
        return;
    };
    let db = TestDb::create(&base, "guard_daily").await;
    let store = prepare(&db, 0).await;
    let day = omni_store::rollup::start_of_day_ms(T0, 0);
    let mut other = db.client().await;
    let other_pid: i32 = other
        .query_one("SELECT pg_backend_pid()", &[])
        .await
        .expect("pid")
        .get(0);
    let tx = other.transaction().await.expect("tx");
    tx.execute(
        "INSERT INTO usage_daily (day, provider, credential_id, requested_model, resolved_model,
                                  api_key_id, requests, input_tokens)
         VALUES ($1, 'anthropic', 'cred-1', 'm', 'm-upstream', '', 10, 1)",
        &[&day],
    )
    .await
    .expect("daily");
    let writer = Writer::spawn_postgres(store, config(0, 512)).expect("spawn");
    // Anonymous, so no hourly row is involved at all.
    assert!(
        writer
            .handle()
            .send(LogEvent::Finish(done("d1", T0, None, "m", 1)))
    );
    // The batch read the daily row as absent; its upsert waits on it.
    wait_for_blocked(&db, other_pid, "INSERT INTO usage_daily").await;
    tx.commit().await.expect("commit");
    let stats = writer.close().await.expect("close");
    assert_eq!((stats.failed, stats.written), (0, 1));
    let (requests, input): (i64, i64) = other
        .query_one(
            "SELECT requests, input_tokens FROM usage_daily WHERE day = $1 AND api_key_id = ''",
            &[&day],
        )
        .await
        .map(|r| (r.get(0), r.get(1)))
        .expect("daily");
    assert_eq!(
        (requests, input),
        (11, 1 + 101),
        "added onto, not overwritten"
    );
}

/// Waits (with a deadline) until a backend other than `holder_pid` is
/// blocked on a lock `holder_pid` holds, running a statement that starts
/// with `prefix`: the writer's upsert has read the row as absent and is now
/// waiting on the uncommitted conflicting insert. Proves the race happened
/// rather than assuming a sleep was long enough.
async fn wait_for_blocked(db: &TestDb, holder_pid: i32, prefix: &str) {
    let probe = db.client().await;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let n: i64 = probe
            .query_one(
                "SELECT COUNT(*) FROM pg_stat_activity
                  WHERE $1 = ANY(pg_blocking_pids(pid))
                    AND wait_event_type = 'Lock'
                    AND ltrim(query) LIKE $2 || '%'",
                &[&holder_pid, &prefix],
            )
            .await
            .expect("pg_stat_activity")
            .get(0);
        if n > 0 {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no backend blocked behind {holder_pid} on `{prefix}…` within 10 s"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Review A5-R2 on Postgres: the completion's `debit_model` comes from the
/// request's event, not from the stored (replacement-character) name.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completion_carries_the_requests_model_identity_not_the_stored_name() {
    let Some(base) = base_url("a_completion_carries_the_requests_model_identity") else {
        return;
    };
    let db = TestDb::create(&base, "model_identity").await;
    let store = prepare(&db, 0).await;
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let writer = Writer::spawn_postgres(
        store,
        WriterConfig {
            commit_sink: Some(tx),
            ..config(0, 512)
        },
    )
    .expect("spawn");
    let mut lone = done("lone", T0, Some("k"), "\u{fffd}", 1);
    lone.model_unencodable = true;
    assert!(writer.handle().send(LogEvent::Finish(lone)));
    assert!(
        writer
            .handle()
            .send(LogEvent::Finish(done("real", T0, Some("k"), "\u{fffd}", 1)))
    );
    writer.close().await.expect("close");
    let mut seen = Vec::new();
    while let Ok(m) = rx.try_recv() {
        if let Committed::Completions(c) = m {
            seen.extend(c.into_iter().map(|c| (c.id, c.debit_model)));
        }
    }
    assert_eq!(
        seen,
        [("lone".to_owned(), false), ("real".to_owned(), true)]
    );
}
