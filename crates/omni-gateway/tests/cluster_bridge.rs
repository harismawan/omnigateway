use omni_cluster_limit::UsageSource;

#[tokio::test]
async fn completion_bridge_requires_postcommit_identity() {
    let row = omni_store::writer::Completion {
        id: "row".into(),
        api_key_id: Some("key".into()),
        requested_model: "model".into(),
        tokens: 7.0,
        cost_usd: 0.25,
        at: 1001.0,
        debit_model: true,
        commit_id: None,
    };
    assert!(omni_gateway::cluster::committed_debit(&row).is_none());
    let mut row = row;
    row.commit_id = Some("12345678901".into());
    let debit = omni_gateway::cluster::committed_debit(&row).expect("committed row");
    assert_eq!(debit.commit, "12345678901");
    assert_eq!(debit.at, 1001.0);
    assert_eq!(debit.tokens, 7.0);
    row.debit_model = false;
    assert_eq!(
        omni_gateway::cluster::committed_debit(&row)
            .expect("key debit")
            .model,
        None
    );
}
use omni_gateway::cluster::PgUsage;
use std::sync::Arc;

#[tokio::test]
async fn cutover_unlinks_discovered_bucket_and_companion_names_only() {
    let Ok(url) = std::env::var("OMNI_TEST_D4_SWEEP_REDIS_URL") else {
        return;
    };
    let coord = omni_coord::redis::RedisCoord::connect(&url, Default::default())
        .await
        .expect("disposable cutover coord");
    let remote = coord.remote();
    let now = 1_800_000_000_000.0;
    for name in ["d4:counts", "d4:counts:companion"] {
        remote
            .buckets_seed(name, 60_000.0, 18_000_000.0, now, &[])
            .await
            .expect("seed cutover fixtures");
    }
    remote
        .kv_set("d4:preserved", "value", 60_000)
        .await
        .expect("other namespace");
    let binary = env!("CARGO_BIN_EXE_omnigateway");
    let output = std::process::Command::new(binary)
        .arg("cluster-cutover-sweep")
        .env_clear()
        .env("OMNI_REDIS_URL", &url)
        .output()
        .expect("cutover command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    for name in ["d4:counts", "d4:counts:companion"] {
        assert!(
            remote
                .buckets_sum(name, 60_000.0, 18_000_000.0, now)
                .await
                .expect("read")
                .is_none(),
            "uncleared cutover key {name}"
        );
    }
    assert_eq!(
        remote
            .kv_get("d4:preserved")
            .await
            .expect("read KV")
            .as_deref(),
        Some("value")
    );
    coord.shutdown().await;
}

#[tokio::test]
async fn actual_writer_seed_and_ignored_before_seed_recover_without_double_debit() {
    let (Ok(pg_url), Ok(redis_url)) = (
        std::env::var("OMNI_TEST_DATABASE_URL"),
        std::env::var("OMNI_TEST_REDIS_URL"),
    ) else {
        assert_ne!(std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(), Ok("1"));
        return;
    };
    let pg = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(pg_url), 0)
        .await
        .expect("primary");
    let coord = Arc::new(
        omni_coord::redis::RedisCoord::connect(&redis_url, Default::default())
            .await
            .expect("coord"),
    );
    let now = 1_800_000_000_000.0;
    let limiter = omni_cluster_limit::ClusterLimiter::new(
        coord.clone(),
        Arc::new(PgUsage::new(pg.clone())),
        omni_cluster_limit::ClusterLimiterOptions {
            clock: Arc::new(move || now),
            ..Default::default()
        },
    );
    let key = format!("d4-writer-{}", std::process::id());
    let runtime = omni_gateway_core::ratelimit::RateLimiter::with_cluster(limiter.clone());
    let concurrency = omni_ratelimit::limits::parse_limits(r#"{"concurrency":1}"#).expect("limits");
    let mut admitted = runtime
        .admit_selected(&key, &concurrency, "model", now)
        .await
        .expect("admitted");
    assert!(
        runtime
            .admit_selected(&key, &concurrency, "model", now)
            .await
            .is_err()
    );
    admitted.release();
    let next = runtime
        .admit_selected(&key, &concurrency, "model", now)
        .await
        .expect("immediate release");
    drop(next);
    let model_limits = omni_ratelimit::limits::parse_limits(
        r#"{"models":{"model":{"tokens":{"5h":1000,"1w":1000}}}}"#,
    )
    .expect("limits");
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let writer = omni_store::writer::Writer::spawn_postgres(
        pg.clone(),
        omni_store::writer::WriterConfig {
            commit_sink: Some(tx),
            ..Default::default()
        },
    )
    .expect("writer");
    let h = writer.handle();
    // Register a limited subject, without allowing a background seed to race
    // this test's explicitly ordered ignored-before-seed debit.
    limiter.record_override(&key, &model_limits, "model");
    let mut row = omni_store::writer::RequestLog::new(format!("{key}-row"), 1_799_999_999_999, 200);
    row.api_key_id = Some(key.clone());
    row.requested_model = "model".into();
    row.input_tokens = 7;
    row.cost_usd = 0.25;
    assert!(h.send(omni_store::writer::LogEvent::Finish(row)));
    h.flush().await.expect("postcommit barrier");
    let row = loop {
        if let Some(omni_store::writer::Committed::Completions(mut rows)) = rx.recv().await {
            break rows.remove(0);
        }
    };
    let debit = omni_gateway::cluster::committed_debit(&row).expect("committed");
    runtime.apply(omni_store::writer::Committed::Completions(vec![
        row.clone(),
    ]));
    limiter.flush_debits().await;
    limiter.preseed_now(&key, &model_limits, now).await;
    let bucket = format!("lim:{key}/m/model:5h");
    let count = coord
        .remote()
        .buckets_sum(&bucket, 60_000.0, 18_000_000.0, now)
        .await
        .expect("read")
        .expect("seeded");
    assert_eq!(count.tokens, 7.0, "primary seed recovers ignored debit");
    // Same actual writer identity is covered by this seed's exact row picture.
    limiter.debit(
        debit.key,
        "model",
        debit.tokens,
        debit.cost_usd,
        debit.at,
        debit.commit,
    );
    limiter.flush_debits().await;
    let count = coord
        .remote()
        .buckets_sum(&bucket, 60_000.0, 18_000_000.0, now)
        .await
        .expect("read")
        .expect("seeded");
    assert_eq!(count.tokens, 7.0, "covered debit does not double-count");
    let key_limits =
        omni_ratelimit::limits::parse_limits(r#"{"tokens":{"5h":1000}}"#).expect("limits");
    limiter.preseed_now(&key, &key_limits, now).await;
    drop(
        runtime
            .admit_selected(&key, &key_limits, "model", now)
            .await
            .expect("register key-wide limits"),
    );
    // An unencodable model must debit only the key, even when its lossy
    // stored spelling matches a known model override.
    let mut log =
        omni_store::writer::RequestLog::new(format!("{key}-key-only"), 1_800_000_000_000, 400);
    log.api_key_id = Some(key.clone());
    log.requested_model = "model".into();
    log.input_tokens = 7;
    log.model_unencodable = true;
    assert!(h.send(omni_store::writer::LogEvent::Finish(log)));
    h.flush().await.expect("postcommit barrier");
    let key_only = loop {
        match rx.recv().await.expect("writer completion sink") {
            omni_store::writer::Committed::Completions(mut rows) => break rows.remove(0),
            omni_store::writer::Committed::Gap => panic!("writer completion gap"),
            _ => {}
        }
    };
    assert!(!key_only.debit_model);
    runtime.apply(omni_store::writer::Committed::Completions(vec![key_only]));
    limiter.flush_debits().await;
    let model_count = coord
        .remote()
        .buckets_sum(&bucket, 60_000.0, 18_000_000.0, now)
        .await
        .expect("read")
        .expect("seeded");
    assert_eq!(
        model_count.tokens, 7.0,
        "key-only completion never charges a model"
    );
    let key_count = coord
        .remote()
        .buckets_sum(&format!("lim:{key}:5h"), 60_000.0, 18_000_000.0, now)
        .await
        .expect("read")
        .expect("seeded");
    assert_eq!(key_count.tokens, 14.0);
    writer.close().await.expect("writer drain before limiter");
    limiter.shutdown().await;
    coord.close();
}

#[tokio::test]
async fn primary_usage_adapter_preserves_fractional_boundary() {
    let Ok(url) = std::env::var("OMNI_TEST_DATABASE_URL") else {
        assert_ne!(std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(), Ok("1"));
        return;
    };
    let pg = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(url), 0)
        .await
        .expect("primary");
    let source = PgUsage::new(pg);
    let seed = source
        .seed_read("not-present", 1000.25, 1000.0, None)
        .await
        .expect("seed");
    assert!(seed.rows.is_empty());
    assert!(seed.ranges.is_empty());
    assert!(seed.snapshot.contains(':'));
}
