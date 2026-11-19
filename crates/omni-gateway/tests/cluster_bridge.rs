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
    limiter.debit(
        debit.key,
        debit.model.expect("model"),
        debit.tokens,
        debit.cost_usd,
        debit.at,
        debit.commit,
    );
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
