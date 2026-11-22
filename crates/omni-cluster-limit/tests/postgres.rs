//! The seed/debit visibility contract against a real PostgreSQL (17):
//! concurrent writer transactions, and seed reads taken in one REPEATABLE
//! READ transaction (`pg_current_snapshot()` + the bucket and range
//! queries), exactly as D4's `UsageSource` must.
//!
//! Needs `OMNI_TEST_PG_URL` (a disposable database; the test creates its
//! own table) as well as `OMNI_TEST_REDIS_URL`. With
//! `OMNI_TEST_REQUIRE_REDIS=1`, a missing PG URL fails rather than skips.
//!
//! The table is `request_logs`' relevant columns; the queries are D1's
//! `sumBuckets` log query and the range query the report prescribes.

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use common::*;
use omni_cluster_limit::{ClusterLimiter, ClusterLimiterOptions, SeedRead, UsageSource};
use omni_coord::Counts;
use tokio_postgres::{Client, NoTls};

fn pg_url() -> Option<String> {
    match std::env::var("OMNI_TEST_PG_URL") {
        Ok(u) if !u.is_empty() => Some(u),
        _ => {
            assert!(
                std::env::var_os("OMNI_TEST_REQUIRE_REDIS").is_none(),
                "OMNI_TEST_REQUIRE_REDIS is set but OMNI_TEST_PG_URL is not"
            );
            eprintln!("skipped: OMNI_TEST_PG_URL not set");
            None
        }
    }
}

async fn client(url: &str) -> Client {
    let (c, conn) = tokio_postgres::connect(url, NoTls)
        .await
        .expect("pg connect");
    tokio::spawn(async move {
        let _ended = conn.await.is_err();
    });
    c
}

/// The seed read, as D4 must implement it: one REPEATABLE READ, read-only
/// transaction; the snapshot first, then the two queries.
struct PgUsage {
    url: String,
    table: String,
    reads: std::sync::atomic::AtomicUsize,
    /// Optional gate after the snapshot is taken (the transaction is open).
    gate: tokio::sync::Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Semaphore>)>>,
}

#[async_trait]
impl UsageSource for PgUsage {
    async fn seed_read(
        &self,
        key_id: &str,
        since_ms: f64,
        grain_ms: f64,
        model: Option<&str>,
    ) -> Result<SeedRead, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let mut c = client(&self.url).await;
        let tx = c
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await
            .map_err(|e| e.to_string())?;
        // The first statement fixes the transaction's snapshot.
        let snap: String = tx
            .query_one("SELECT pg_current_snapshot()::text", &[])
            .await
            .map_err(|e| e.to_string())?
            .get(0);
        let gate = self.gate.lock().await.clone();
        if let Some((entered, release)) = gate {
            entered.notify_one();
            release.acquire().await.map_err(|e| e.to_string())?.forget();
        }
        #[allow(clippy::cast_possible_truncation)]
        let (since, g) = (since_ms as i64, grain_ms as i64);
        let model_clause = if model.is_some() {
            "AND requested_model = $4"
        } else {
            ""
        };
        let sums = format!(
            "SELECT (at / $1) * $1 AS bucket, COUNT(*)::float8, COALESCE(SUM(tokens), 0)::float8, COALESCE(SUM(cost_usd), 0)
               FROM {t} WHERE api_key_id = $2 AND state = 'done' AND at >= $3 {model_clause}
              GROUP BY 1 ORDER BY 1",
            t = self.table
        );
        let ranges = format!(
            "SELECT (at / $1) * $1 AS bucket, MIN(at), MAX(at)
               FROM {t} WHERE api_key_id = $2 AND state = 'done' AND at >= $3 {model_clause}
              GROUP BY 1 ORDER BY 1",
            t = self.table
        );
        let m = model.unwrap_or("");
        let p: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = if model.is_some() {
            vec![&g, &key_id, &since, &m]
        } else {
            vec![&g, &key_id, &since]
        };
        let rows = tx.query(&sums, &p).await.map_err(|e| e.to_string())?;
        let rr = tx.query(&ranges, &p).await.map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        #[allow(clippy::cast_precision_loss)]
        Ok(SeedRead {
            rows: rows
                .iter()
                .map(|r| {
                    (
                        r.get::<_, i64>(0) as f64,
                        Counts {
                            requests: r.get(1),
                            tokens: r.get(2),
                            cost_usd: r.get(3),
                        },
                    )
                })
                .collect(),
            ranges: rr
                .iter()
                .map(|r| {
                    (
                        r.get::<_, i64>(0) as f64,
                        r.get::<_, i64>(1) as f64,
                        r.get::<_, i64>(2) as f64,
                    )
                })
                .collect(),
            snapshot: snap,
        })
    }
}

/// A writer transaction completing rows: inserts them and returns the
/// top-level commit id (`pg_current_xact_id()`), committed or left open.
async fn complete<'c>(
    c: &'c mut Client,
    table: &str,
    rows: &[(i64, f64, f64)],
    commit_now: bool,
) -> (String, Option<tokio_postgres::Transaction<'c>>) {
    let tx = c.transaction().await.expect("begin");
    for (at, tokens, cost) in rows {
        tx.execute(
            &format!("INSERT INTO {table} (api_key_id, requested_model, state, at, tokens, cost_usd) VALUES ('k', 'm', 'done', $1, $2, $3)"),
            &[at, tokens, cost],
        )
        .await
        .expect("insert");
    }
    let id: String = tx
        .query_one("SELECT pg_current_xact_id()::text", &[])
        .await
        .expect("xact id")
        .get(0);
    if commit_now {
        tx.commit().await.expect("commit");
        (id, None)
    } else {
        (id, Some(tx))
    }
}

async fn setup(url: &str, table: &str) {
    let c = client(url).await;
    c.batch_execute(&format!(
        "DROP TABLE IF EXISTS {table};
         CREATE TABLE {table} (
           api_key_id TEXT NOT NULL, requested_model TEXT NOT NULL,
           state TEXT NOT NULL, at BIGINT NOT NULL,
           tokens DOUBLE PRECISION NOT NULL, cost_usd DOUBLE PRECISION NOT NULL)"
    ))
    .await
    .expect("table");
}

async fn sum_5h(c: &omni_coord::RedisCoord) -> Counts {
    c.remote()
        .buckets_sum("lim:k/m/m:5h", 60_000.0, 5.0 * HOUR, T0)
        .await
        .expect("sum")
        .expect("seeded")
}

/// The contract: every committed row counted once — rows inside the
/// window by the seed or by their debit, long streams (`at` before the
/// window) by their debit at completion time. Then compared with what the
/// interleaving left.
#[allow(clippy::too_many_lines, clippy::cast_possible_truncation)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writers_and_seeds_count_every_row_once() {
    let Some(pg) = pg_url() else { return };
    let Some(base) = redis_base() else { return };
    let db = fresh_db(&base).await;
    let table = format!("d3_rows_{}", std::process::id());
    setup(&pg, &table).await;
    let clock = ManualClock::at(T0);
    let (ca, cb) = (
        coord(&db.url, clock.clock()).await,
        coord(&db.url, clock.clock()).await,
    );
    let usage = Arc::new(PgUsage {
        url: pg.clone(),
        table: table.clone(),
        reads: Default::default(),
        gate: tokio::sync::Mutex::new(None),
    });
    let opts = ClusterLimiterOptions {
        clock: clock.clock(),
        debit_interval: Duration::from_secs(3_600),
        ..ClusterLimiterOptions::default()
    };
    let a = ClusterLimiter::new(Arc::clone(&ca), usage.clone(), opts.clone());
    let b = ClusterLimiter::new(Arc::clone(&cb), usage.clone(), opts);
    let lim = limits(r#"{"models":{"m":{"requests":{"5h":1000}}}}"#);
    a.record_override("k", &lim, "m");
    let mut w1 = client(&pg).await;
    let mut w2 = client(&pg).await;
    let mut w3 = client(&pg).await;

    // 1. Committed before any seed: an in-window row and a long stream
    //    (started 6 h ago), one transaction. A debits both (pending).
    let (c1, _) = complete(
        &mut w1,
        &table,
        &[
            (T0 as i64 - 3_600_000, 1.0, 0.5),
            (T0 as i64 - 21_600_000, 2.0, 0.25),
        ],
        true,
    )
    .await;
    a.debit("k", "m", 1.0, 0.5, T0 - HOUR, &c1);
    a.debit("k", "m", 2.0, 0.25, T0 - 6.0 * HOUR, &c1);
    // 2. A transaction still open while B seeds (in the snapshot's xip).
    let (c2, open) = complete(&mut w2, &table, &[(T0 as i64 - 60_000, 4.0, 1.0)], false).await;
    // 3. B seeds, gated after its snapshot so a third writer commits
    //    during the read.
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    *usage.gate.lock().await = Some((Arc::clone(&entered), Arc::clone(&release)));
    let inside = entered.notified();
    let seed = {
        let b = b.clone();
        let lim = lim.clone();
        tokio::spawn(async move { b.preseed_now("k", &lim, T0).await })
    };
    tokio::time::timeout(Duration::from_secs(5), inside)
        .await
        .expect("seed read began");
    let (c3, _) = complete(&mut w3, &table, &[(T0 as i64 - 30_000, 8.0, 2.0)], true).await;
    a.debit("k", "m", 8.0, 2.0, T0 - 30_000.0, &c3);
    // While B holds the lock and the picture is incomplete, A's flush waits.
    a.flush_debits().await;
    assert!(
        a.debits_pending().0 > 0,
        "A's debits were not kept while B seeded"
    );
    // The open transaction commits only now (after B's snapshot).
    open.expect("open").commit().await.expect("commit c2");
    a.debit("k", "m", 4.0, 1.0, T0 - 60_000.0, &c2);
    *usage.gate.lock().await = None;
    release.add_permits(2);
    assert_eq!(seed.await.expect("seed"), 0, "B's seeds installed");
    assert_eq!(b.metrics().seeds_installed.load(Ordering::SeqCst), 2);
    a.flush_debits().await;
    assert_eq!(a.debits_pending().0, 0);

    // The expected picture: four rows, each once. In-window rows: c1's first (1 h),
    // c2 (1 min), c3 (30 s); c1's long stream counted at completion.
    let s = sum_5h(&ca).await;
    assert_eq!(
        (s.requests, s.tokens, s.cost_usd),
        (4.0, 15.0, 3.75),
        "counts after seed + debits (snapshot of B: c1 visible, c2 in progress, c3 after)"
    );
    // The week: every row is inside it (the long stream started 6 h ago);
    // B's 1w seed read c1's two rows, the debits added c2 and c3.
    let w = ca
        .remote()
        .buckets_sum("lim:k/m/m:1w", HOUR, 168.0 * HOUR, T0)
        .await
        .expect("sum")
        .expect("seeded");
    assert_eq!((w.requests, w.tokens, w.cost_usd), (4.0, 15.0, 3.75), "1w");
    let m = a.metrics();
    eprintln!(
        "rows covered {} applied {}; buckets applied {} unseeded {} waiting {} lost {}",
        m.debit_rows_covered.load(Ordering::SeqCst),
        m.debit_rows_applied.load(Ordering::SeqCst),
        m.debit_buckets_applied.load(Ordering::SeqCst),
        m.debit_buckets_unseeded.load(Ordering::SeqCst),
        m.debit_buckets_waiting.load(Ordering::SeqCst),
        m.debit_buckets_lost.load(Ordering::SeqCst),
    );
    // Per window, what happened to A's debits:
    // 5h — B's 5h seed held its lock during the first flush: the entry
    //   (c1's two rows, c3) waited. After the install: c1's in-window row
    //   covered (visible, `at >= since`); c1's long stream applied (visible
    //   but outside the selection — R1); c3 applied (committed after the
    //   snapshot); c2 applied (in progress at the snapshot: `xip`).
    // 1w — no 1w seed was running at the first flush and the picture was
    //   incomplete: that entry (c1, c3) was ignored, as unseeded
    //   buckets ignore adds; B's 1w seed, which took its snapshot after the
    //   gate was lifted (c1, c2, c3 all committed), read all four rows; c2's
    //   later 1w debit was then covered.
    assert_eq!(
        m.debit_rows_covered.load(Ordering::SeqCst),
        2,
        "covered rows"
    );
    assert_eq!(
        m.debit_rows_applied.load(Ordering::SeqCst),
        3,
        "applied rows"
    );
    assert_eq!(
        m.debit_buckets_unseeded.load(Ordering::SeqCst),
        1,
        "1w ignored"
    );
    assert!(
        m.debit_buckets_waiting.load(Ordering::SeqCst) >= 1,
        "5h waited"
    );
    assert_eq!(m.debit_buckets_lost.load(Ordering::SeqCst), 0);
    a.shutdown().await;
    b.shutdown().await;
    client(&pg)
        .await
        .batch_execute(&format!("DROP TABLE {table}"))
        .await
        .expect("drop");
}
