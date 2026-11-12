//! `postgresPlans.test.ts` for the Rust statements: the narrowed per-model
//! reads seek `idx_request_logs_key_model_at` (migration 6), with sequential
//! scans off so a small fixture plans as a large one would.

mod common;

use common::pg::{TestDb, base_url};
use omni_store::pg::usage::{BUCKETS_MODEL, STAMPS_MODEL, SUM_SINCE_MODEL};
use omni_store::pg::{PgConfig, PgStore};
use tokio_postgres::types::ToSql;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_narrowed_reads_seek_the_model_window_index() {
    let Some(base) = base_url("the_narrowed_reads_seek_the_model_window_index") else {
        return;
    };
    let db = TestDb::create(&base, "plans").await;
    drop(
        PgStore::open(PgConfig::new(&db.url), 0)
            .await
            .expect("open"),
    );
    let c = db.client().await;
    let def: String = c
        .query_one(
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_request_logs_key_model_at'",
            &[],
        )
        .await
        .expect("index")
        .get(0);
    assert!(def.contains("(api_key_id, requested_model, at)"), "{def}");
    c.batch_execute("SET enable_seqscan = off")
        .await
        .expect("set");
    let (k, m, z, g, cap) = ("k1", "opus", 0_i64, 60_000_i64, 10_i64);
    let cases: [(&str, Vec<&(dyn ToSql + Sync)>); 3] = [
        (SUM_SINCE_MODEL, vec![&k, &m, &z]),
        (BUCKETS_MODEL, vec![&g, &g, &k, &m, &z]),
        (STAMPS_MODEL, vec![&k, &m, &z, &cap]),
    ];
    for (sql, args) in cases {
        let plan: Vec<String> = c
            .query(&format!("EXPLAIN {sql}"), &args)
            .await
            .expect("explain")
            .iter()
            .map(|r| r.get(0))
            .collect();
        let plan = plan.join("\n");
        assert!(
            plan.contains("idx_request_logs_key_model_at"),
            "{sql}\n{plan}"
        );
        assert!(plan.contains("requested_model = "), "{plan}");
    }
}
