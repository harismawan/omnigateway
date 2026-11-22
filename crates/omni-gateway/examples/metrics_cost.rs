//! Per-request recording cost of the metrics registry (release build):
//! `cargo run --release -p omni-gateway --example metrics_cost`.
use omni_gateway::telemetry::Telemetry;
use omni_store::writer::RequestLog;

fn main() {
    let t = Telemetry::new(true, 5000.0, "bench");
    let mut log = RequestLog::new("req", 0, 200);
    log.resolved_provider = Some("custom".into());
    log.resolved_model = Some("bench-c1".into());
    log.requested_model = "bench-c1".into();
    log.api_key_id = Some("0b9a8c1e-1d0f-4a7b-9c55-2f3a1e9d7c42".into());
    log.duration_ms = 3;
    log.ttft_ms = Some(1);
    log.input_tokens = 64;
    log.output_tokens = 6;
    log.cost_usd = 0.000076;
    for _ in 0..10_000 {
        t.record(&log);
    }
    let n = 1_000_000u32;
    let start = std::time::Instant::now();
    for _ in 0..n {
        t.record(&log);
        t.http_head("custom", 1);
    }
    let per = start.elapsed() / n;
    println!("1 thread: record + http_head: {per:?} per request");
    let t = std::sync::Arc::new(t);
    let threads = 4u32;
    let start = std::time::Instant::now();
    std::thread::scope(|s| {
        for _ in 0..threads {
            let t = t.clone();
            let log = log.clone();
            s.spawn(move || {
                for _ in 0..n {
                    t.record(&log);
                    t.http_head("custom", 1);
                }
            });
        }
    });
    let per = start.elapsed() / n;
    println!("{threads} threads, one series set: {per:?} wall per request per thread");
}
