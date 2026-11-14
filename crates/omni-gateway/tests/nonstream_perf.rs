mod common;

use futures_util::StreamExt as _;
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// The benchmark upstream's reply to a one-chunk chat request, every time.
struct Replay(Vec<bytes::Bytes>);

impl HttpClient for Replay {
    fn send(
        &self,
        _req: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        let chunks = self.0.clone();
        Box::pin(async move {
            let mut headers = Headers::new();
            headers.append_received("content-type", "text/event-stream");
            Ok(HttpResponse {
                status: 200,
                headers,
                body: ResponseBody::from_chunks(chunks),
            })
        })
    }
}

/// The product binary's allocator (`main.rs`), so allocation costs match it.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Nanoseconds this thread has spent on a CPU (`/proc/thread-self/schedstat`).
fn thread_cpu_ns() -> u64 {
    std::fs::read_to_string("/proc/thread-self/schedstat")
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse().ok())
        .unwrap_or(0)
}

/// One Anthropic non-streaming request through the `custom` provider, end to
/// end in process: ingress, dispatch, send, decode, collect, render. No
/// sockets, no HTTP server and no completion row, so it bounds what the
/// request thread itself spends, at any commit this file compiles at.
#[tokio::test]
#[ignore = "manual bounded performance measurement"]
async fn custom_buffered_request_ns() {
    const BODY: &str = r#"{"model":"m1","max_tokens":1024,"stream":false,"messages":[{"role":"user","content":"Say something short."}]}"#;
    let requests: u32 = std::env::var("PERF_REQUESTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(50_000);
    let f = common::fixture(&["c0"]);
    let h = common::harness(&f, vec![]);
    let common::Harness { deps, writer, .. } = h;
    let frame = |v: &str| bytes::Bytes::from(format!("data: {v}\n\n"));
    let replay = Replay(vec![
        frame(
            r#"{"id":"chatcmpl-bench","object":"chat.completion.chunk","created":0,"model":"mock-c1-d0","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#,
        ),
        frame(
            r#"{"id":"chatcmpl-bench","object":"chat.completion.chunk","created":0,"model":"mock-c1-d0","choices":[{"index":0,"delta":{"content":"lorem ipsum "}}]}"#,
        ),
        frame(
            r#"{"id":"chatcmpl-bench","object":"chat.completion.chunk","created":0,"model":"mock-c1-d0","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        ),
        frame(
            r#"{"id":"chatcmpl-bench","object":"chat.completion.chunk","created":0,"model":"mock-c1-d0","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}"#,
        ),
        bytes::Bytes::from_static(b"data: [DONE]\n\n"),
    ]);
    let deps = Arc::new(omni_gateway::dispatch::Deps {
        http: Arc::new(replay),
        ..Arc::try_unwrap(deps).unwrap_or_else(|_| panic!("sole owner"))
    });
    let headers = omni_dialects::ingress::Headers::new();
    let mut n = 0u64;
    for round in 0..7 {
        let (start, cpu) = (std::time::Instant::now(), thread_cpu_ns());
        for _ in 0..requests {
            n += 1;
            let mut mint = || String::from("toolu_perf");
            let mut opts = omni_dialects::ingress::IngressOptions {
                new_tool_use_id: &mut mint,
            };
            let ingested = omni_dialects::ingress::ingest(
                omni_dialects::ingress::Surface::Anthropic,
                BODY,
                &headers,
                &mut opts,
            )
            .expect("ingest");
            let mut d = omni_gateway::dispatch::dispatch(
                deps.clone(),
                omni_gateway::dispatch::Request {
                    request: ingested.request,
                    request_id: format!("perf-{n}"),
                    api_key_id: Some("k1".into()),
                    route_started_at: 1000,
                },
            );
            let mut events = Vec::new();
            while let Some(event) = d.events.next().await {
                events.push(event.expect("event"));
            }
            assert!(events.len() >= 5, "{}", events.len());
            let collected = omni_ir::stream::try_collect(events).expect("collect");
            let rendered = omni_dialects::egress::anthropic::response(&collected, "perf");
            let body = omni_ir::jsjson::to_string(&rendered);
            assert!(body.contains("lorem ipsum "), "{body}");
            std::hint::black_box(body);
        }
        let (wall, cpu) = (start.elapsed().as_nanos(), thread_cpu_ns() - cpu);
        let per = f64::from(requests);
        eprintln!(
            "round={round} wall-ns/request={:.0} thread-cpu-ns/request={:.0}",
            wall as f64 / per,
            cpu as f64 / per
        );
    }
    drop(deps);
    writer.close().await.expect("close");
}
