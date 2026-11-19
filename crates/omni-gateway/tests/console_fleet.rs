use omni_gateway::console::{Fleet, Query, Source};
use std::sync::Arc;

#[tokio::test]
async fn redis_fleet_reads_are_addressed_across_independent_connections() {
    let Ok(url) = std::env::var("OMNI_TEST_REDIS_URL") else {
        return;
    };
    let a_coord = Arc::new(
        omni_coord::redis::RedisCoord::connect(&url, Default::default())
            .await
            .expect("A"),
    );
    let b_coord = Arc::new(
        omni_coord::redis::RedisCoord::connect(&url, Default::default())
            .await
            .expect("B"),
    );
    let a = Fleet::new(a_coord.clone(), "fleet-a".into(), Source::None);
    let b = Fleet::new(b_coord.clone(), "fleet-b".into(), Source::None);
    assert_eq!(
        a.read("fleet-b", Query::from_query(""))
            .await
            .expect("remote none")["source"],
        "none"
    );
    a.stop();
    b.stop();
    a_coord.close();
    b_coord.close();
}

#[tokio::test]
async fn addressed_console_reads_remote_source_and_missing_node_times_out() {
    let coord = Arc::new(omni_coord::MemoryCoord::new(Arc::new(|| 1000.0)));
    let dir = tempfile::tempdir().expect("root");
    let file = dir.path().join("console.log");
    std::fs::write(&file, "2026-11-19T00:00:00Z INFO remote-console\n").expect("capture");
    let a = Fleet::new(coord.clone(), "a".into(), Source::None);
    let b = Fleet::new(coord, "b".into(), Source::File(file.display().to_string()));
    let remote = a
        .read("b", Query::from_query("lines=10"))
        .await
        .expect("remote");
    assert_eq!(remote["source"], "file");
    assert!(
        remote["lines"][0]["raw"]
            .as_str()
            .expect("line")
            .contains("remote-console")
    );
    assert_eq!(
        a.read("a", Query::from_query("")).await.expect("local")["source"],
        "none"
    );
    let all = a
        .read_all_with_timeout(
            &["a".into(), "b".into(), "missing".into()],
            Query::from_query("lines=1"),
            std::time::Duration::from_millis(20),
        )
        .await
        .expect("fleet read");
    assert_eq!(all["source"], "fleet");
    assert_eq!(all["lines"][0]["nodeId"], "b");
    assert_eq!(all["unreachable"], serde_json::json!(["missing"]));
    let error = a
        .read_with_timeout(
            "missing",
            Query::from_query(""),
            std::time::Duration::from_millis(20),
        )
        .await
        .expect_err("timeout not local fallback");
    assert_eq!(error.message, "that gateway process did not answer");
    a.stop();
    b.stop();
}
