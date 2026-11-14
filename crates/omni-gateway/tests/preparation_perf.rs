mod common;

/// The product binary's allocator (`main.rs`). Without it a test binary
/// measures glibc malloc, which the gateway does not run on.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Same custom, non-streaming request and dispatch preparation at both commits.
#[tokio::test]
#[ignore = "manual bounded performance measurement"]
async fn custom_buffered_preparation_ns() {
    let f = common::fixture(&["c0"]);
    let h = common::harness(&f, vec![]);
    for round in 0..5 {
        let start = std::time::Instant::now();
        for _ in 0..200_000 {
            let d = omni_gateway::dispatch::dispatch(
                h.deps.clone(),
                omni_gateway::dispatch::Request {
                    request: common::chat("m1", false),
                    request_id: "perf".into(),
                    api_key_id: Some("k1".into()),
                    route_started_at: 1000,
                },
            );
            std::hint::black_box(&d);
            drop(d);
        }
        eprintln!(
            "round={round} ns/request={:.2}",
            start.elapsed().as_nanos() as f64 / 200_000.0
        );
    }
    h.writer.close().await.expect("close");
}

/// The part of the loop above that is not dispatch: building and releasing
/// the request. Subtract it to get dispatch preparation alone.
#[test]
#[ignore = "manual bounded performance measurement"]
fn request_construction_ns() {
    for round in 0..5 {
        let start = std::time::Instant::now();
        for _ in 0..200_000 {
            let r = common::chat("m1", false);
            std::hint::black_box(&r);
            drop(r);
        }
        eprintln!(
            "round={round} construction-ns/request={:.2}",
            start.elapsed().as_nanos() as f64 / 200_000.0
        );
    }
}
