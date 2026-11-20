mod common;

async fn server_stream(
    f: &common::Fixture,
    deps: Arc<omni_gateway::dispatch::Deps>,
    body: String,
    mode: &str,
    gated: Arc<std::sync::atomic::AtomicBool>,
    closed: tokio::sync::oneshot::Receiver<()>,
) {
    omni_gateway::clock::init_request_ids().expect("boot request IDs");
    use omni_gateway::{admin_auth, admin_routes, server};
    use omni_gateway_core::{
        ratelimit::RateLimiter,
        snapshot::{MissConfig, MissResolver},
    };
    use std::{sync::Mutex, time::Duration};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let store = || omni_store::SqliteStore::open(&f.path, 0).expect("store");
    let now: admin_auth::Clock = Arc::new(|| 0);
    let app = Arc::new(server::App {
        quota: omni_control::quota_runtime::Quota::new(Arc::new(
            omni_gateway::quota::GatewayHost {
                completed: None,
                holder: None,
                refresh: deps.refresher.clone(),
                control: admin_routes::ControlStore::new(store()),
            },
        )),
        database_swap: tokio::sync::Mutex::new(()),
        quiesce: Arc::new(omni_gateway::quiesce::Quiesce::default()),
        lifecycle: omni_gateway::lifecycle::Lifecycle::default(),
        version: "0.0.0-dev".into(),
        cluster: false,
        redis: None,
        stop: tokio::sync::watch::channel(false).0,
        deadline_workers: server::DeadlineWorkers::new(),
        miss: MissResolver::new(
            deps.holder.clone(),
            Arc::new(Mutex::new(store())),
            MissConfig::default(),
        ),
        deps,
        limiter: RateLimiter::new(),
        node_id: "depth".into(),
        keepalive: Duration::from_secs(10),
        idle_timeout: Duration::from_secs(20),
        bench_endpoints: false,
        bench_flush_timeout: Duration::from_secs(1),
        metrics_token: None,
        static_root: None,
        admin: admin_auth::AdminAuth::new(
            store(),
            Arc::new(admin_auth::MemoryKv::new(now.clone())),
            now,
            admin_auth::SESSION_TTL_MS,
        ),
        base_url_https: false,
        control: admin_routes::ControlStore::new(store()),
        credential_key: common::key(),
        connect: Arc::new(omni_gateway::connect::ConnectFlows::default()),
        body_logging_allowed: false,
        day_offset_minutes: 0,
        reported_catalog_problems: Mutex::default(),
        stream: Default::default(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listen");
    let addr = listener.local_addr().expect("addr");
    let serving = app.clone();
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.expect("accept");
        let service = hyper::service::service_fn(move |req| server::handle(serving.clone(), req));
        omni_gateway::http1_builder(Duration::from_secs(20))
            .serve_connection(hyper_util::rt::TokioIo::new(socket), service)
            .await
    });
    let mut socket = tokio::net::TcpStream::connect(addr).await.expect("connect");
    // Anthropic downstream preserves native blocks, and handles tools from either provider.
    let buffered = mode.ends_with("buffered");
    let responses = mode.ends_with("responses");
    let body = if buffered {
        body
    } else {
        body.replace("\"stream\":false", "\"stream\":true")
    };
    // The messages route uses Anthropic ingress and egress; convert only the
    // fixture's tool definition to its native shape, retaining the deep schema.
    let body = if responses {
        body.replace(
            "\"stream\":true",
            "\"stream\":true,\"include\":[\"reasoning.encrypted_content\"]",
        )
        .replace(
            "\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]",
            "\"input\":\"hi\"",
        )
        .replace(
            "\"type\":\"function\",\"function\":{",
            "\"type\":\"function\",",
        )
        .replace("}}}],\"stream\"", "}}],\"stream\"")
    } else {
        body.replace(
            "\"type\":\"function\",\"function\":{\"name\":\"f\",\"parameters\":",
            "\"name\":\"f\",\"input_schema\":",
        )
        .replace("}}}],\"stream\"", "}}],\"stream\"")
    };
    let path = if responses {
        "/v1/responses"
    } else {
        "/v1/messages"
    };
    socket.write_all(format!("POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer sk-depth\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.expect("request");
    let mut wire = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let mut chunk = [0; 4096];
            let n = socket.read(&mut chunk).await.expect("response");
            if n == 0 {
                break;
            }
            wire.extend_from_slice(&chunk[..n]);
            if mode.ends_with("disconnect")
                && wire.windows(100).any(|w| w.iter().all(|b| *b == b'['))
            {
                break;
            }
        }
    })
    .await
    .expect("response deadline");
    if mode.ends_with("disconnect") {
        assert!(
            gated.load(std::sync::atomic::Ordering::SeqCst),
            "upstream terminators withheld"
        );
    }
    drop(socket);
    if mode.ends_with("disconnect") {
        tokio::time::timeout(Duration::from_secs(10), closed)
            .await
            .expect("upstream close deadline")
            .expect("upstream observed closure");
    }
    let result = tokio::time::timeout(Duration::from_secs(30), task)
        .await
        .expect("handler deadline")
        .expect("handler task");
    if !mode.ends_with("disconnect") {
        result.expect("normal HTTP completion");
    }
    app.deadline_workers.shutdown().await;
    let text = String::from_utf8(wire).expect("utf8");
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    if mode.ends_with("disconnect") {
        assert!(
            text.contains(&"[".repeat(100)),
            "received part of deep payload"
        );
        assert!(
            !text.contains("event: message_stop"),
            "disconnect before completion"
        );
    } else {
        // Remove HTTP chunk framing before checking the uninterrupted JSON payload.
        let mut rest = text.split_once("\r\n\r\n").expect("headers").1;
        let mut decoded = String::new();
        if text
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
        {
            loop {
                let (size, data) = rest.split_once("\r\n").expect("chunk header");
                let n = usize::from_str_radix(size, 16).expect("chunk size");
                if n == 0 {
                    break;
                }
                decoded.push_str(&data[..n]);
                rest = &data[n + 2..];
            }
        } else {
            decoded.push_str(rest);
        }
        assert!(
            decoded.contains(&format!("{}0{}", "[".repeat(39_980), "]".repeat(39_980))),
            "complete deep content"
        );
        if !buffered {
            assert!(
                decoded.contains(if responses {
                    "event: response.completed"
                } else {
                    "event: message_stop"
                }),
                "normal stream end"
            );
        }
        assert!(!decoded.contains("event: error"), "no in-stream error");
    }
}

#[test]
fn operator_provider_data_rejects_deep_json_at_load() {
    let fixture = common::fixture(&["c0"]);
    let store = omni_store::SqliteStore::open(&fixture.path, 0).expect("store");
    let data = format!(
        "{{\"annotation\":{}0{}}}",
        "[".repeat(39_990),
        "]".repeat(39_990)
    );
    store
        .connection()
        .execute("UPDATE credentials SET provider_data=?", [&data])
        .expect("store text");
    let error = store
        .list_credentials(&common::key())
        .expect_err("stored deep data is refused when the row is loaded");
    // The lossless reader accepts the nesting; the typed `serde_json` read
    // behind it hits its recursion cap, and the row is reported as corrupt.
    assert!(
        error.to_string().contains("invalid provider data"),
        "{error}"
    );
}

use futures_util::StreamExt;
use omni_providers::http::{Client, HttpClient, HttpError, HttpRequest, HttpResponse};
use std::{future::Future, pin::Pin, sync::Arc};

// Only replace the origin; exercise the real codec, HTTP client and decoder.
struct Local {
    client: Client,
    origin: String,
}
impl HttpClient for Local {
    fn send(
        &self,
        mut req: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        let path = req.url.split_once("://").expect("scheme").1;
        let path = &path[path.find('/').expect("path")..];
        req.url = format!("{}{path}", self.origin);
        Box::pin(self.client.send(req))
    }
}

macro_rules! case {
    ($name:ident, $anthropic:expr, $mode:literal) => {
        #[test]
        fn $name() {
            run_case(stringify!($name), $anthropic, $mode);
        }
    };
}
case!(custom_deep_response_buffered, false, "response");
case!(custom_deep_request_success, false, "request");
case!(anthropic_deep_request_success, true, "request");
case!(
    anthropic_native_server_buffered,
    true,
    "native_stream_buffered"
);
case!(
    anthropic_native_server_responses,
    true,
    "native_stream_responses"
);
case!(anthropic_deep_response_buffered, true, "response");
case!(custom_deep_retry, false, "retry");
case!(anthropic_deep_retry, true, "retry");
case!(custom_deep_error, false, "error");
case!(anthropic_deep_error, true, "error");
case!(custom_deep_cancel, false, "cancel");
case!(anthropic_deep_cancel, true, "cancel");
case!(custom_deep_server_stream, false, "stream");
case!(anthropic_deep_server_stream, true, "stream");
case!(custom_deep_server_disconnect, false, "stream_disconnect");
case!(anthropic_deep_server_disconnect, true, "stream_disconnect");
case!(anthropic_native_buffered, true, "native");
case!(anthropic_native_server_stream, true, "native_stream");
case!(
    anthropic_native_server_disconnect,
    true,
    "native_stream_disconnect"
);

case!(openai_deep_request_success, false, "request");
case!(openai_deep_response_buffered, false, "response");
case!(openai_deep_retry, false, "retry");
case!(openai_deep_error, false, "error");
case!(openai_deep_cancel, false, "cancel");
case!(
    openai_native_server_responses,
    false,
    "native_stream_responses"
);

fn run_case(name: &'static str, anthropic: bool, mode: &'static str) {
    let openai = name.starts_with("openai_");
    const CHILD: &str = "OMNI_DISPATCH_DEPTH_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", name, "--nocapture"])
            .env(CHILD, "1")
            .status()
            .expect("child");
        assert!(status.success(), "dispatch depth child: {status}");
        return;
    }
    std::thread::Builder::new().stack_size(2 * 1024 * 1024).spawn(move || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime").block_on(async {
            {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listen");
                let origin = format!("http://{}", listener.local_addr().expect("addr"));
                let gated = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let stub_gate = gated.clone();
                let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
                let mut closed_tx = Some(closed_tx);
                let stub = std::thread::spawn(move || {
                    use std::io::{Read, Write};
                    listener.set_nonblocking(true).expect("nonblocking");
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
                    for attempt in 0..if mode == "retry" { 2 } else { 1 } {
                    let (mut socket, _) = loop {
                        match listener.accept() {
                            Ok(pair) => break pair,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(std::time::Instant::now() < deadline, "accept deadline");
                                std::thread::sleep(std::time::Duration::from_millis(5));
                            }
                            Err(e) => panic!("accept: {e}"),
                        }
                    };
                    socket.set_read_timeout(Some(std::time::Duration::from_secs(20))).expect("timeout");
                    socket.set_write_timeout(Some(std::time::Duration::from_secs(20))).expect("write timeout");
                    let mut wire = Vec::new();
                    let mut buffer = [0; 8192];
                    loop {
                        let n = socket.read(&mut buffer).expect("read");
                        assert_ne!(n, 0);
                        wire.extend_from_slice(&buffer[..n]);
                        if let Some(end) = wire.windows(4).position(|w| w == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&wire[..end]);
                            let size: usize = header.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().expect("length"))).expect("content length");
                            if wire.len() >= end + 4 + size { break; }
                        }
                    }
                    let path = if openai { "/v1/responses" } else if anthropic { "/v1/messages" } else { "/v1/chat/completions" };
                    assert!(wire.starts_with(format!("POST {path} HTTP/1.1\r\n").as_bytes()), "codec destination");
                    assert!(wire.split(|b| *b != b'[').any(|w| w.len() == 39_980), "full deep payload reached HTTP");
                    if mode == "error" || (mode == "retry" && attempt == 0) {
                        let status = if mode == "error" { 400 } else { 503 };
                        write!(socket, "HTTP/1.1 {status} Error\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{{\"error\":\"fixture failed\"}}").expect("error response");
                        continue;
                    }
                    let body = if openai {
                        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"model\":\"gpt-5\"}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
                    } else if anthropic {
                        "event: message_start\ndata: {\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":1}}}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {}\n\n"
                    } else {
                        "data: {\"id\":\"m\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
                    };
                    let body = if mode.starts_with("native") {
                        let nested = format!("{}0{}", "[".repeat(39_980), "]".repeat(39_980));
                        if openai {
                            format!("event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"id\":\"r\",\"model\":\"gpt-5\"}}}}\n\nevent: response.output_item.added\ndata: {{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{{\"type\":\"reasoning\"}}}}\n\nevent: response.output_item.done\ndata: {{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{{\"type\":\"reasoning\",\"encrypted_content\":\"fixture\",\"deep\":{nested}}}}}\n\nevent: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"status\":\"completed\"}}}}\n\n")
                        } else {
                        format!("event: message_start\ndata: {{\"message\":{{\"id\":\"m\",\"model\":\"claude-opus-5-5\"}}}}\n\nevent: content_block_start\ndata: {{\"index\":0,\"content_block\":{{\"type\":\"web_search_tool_result\",\"content\":{nested}}}}}\n\nevent: content_block_stop\ndata: {{\"index\":0}}\n\nevent: message_delta\ndata: {{\"delta\":{{\"stop_reason\":\"end_turn\"}}}}\n\nevent: message_stop\ndata: {{}}\n\n")
                        }
                    } else if mode == "response" || mode == "cancel" || mode.starts_with("stream") {
                        let nested = format!("{}0{}", "[".repeat(39_980), "]".repeat(39_980));
                        let args = serde_json::to_string(&nested).expect("argument string");
                        if openai {
                            format!("event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"id\":\"r\",\"model\":\"gpt-5\"}}}}\n\nevent: response.output_item.added\ndata: {{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{{\"type\":\"function_call\",\"call_id\":\"t\",\"name\":\"f\"}}}}\n\nevent: response.function_call_arguments.delta\ndata: {{\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":{args}}}\n\nevent: response.output_item.done\ndata: {{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{{\"type\":\"function_call\"}}}}\n\nevent: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"status\":\"completed\"}}}}\n\n")
                        } else if anthropic {
                            format!("event: message_start\ndata: {{\"message\":{{\"id\":\"m\",\"model\":\"claude-opus-5-5\",\"usage\":{{\"input_tokens\":1}}}}}}\n\nevent: content_block_start\ndata: {{\"index\":0,\"content_block\":{{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"f\",\"input\":{{}}}}}}\n\nevent: content_block_delta\ndata: {{\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":{args}}}}}\n\nevent: content_block_stop\ndata: {{\"index\":0}}\n\nevent: message_delta\ndata: {{\"delta\":{{\"stop_reason\":\"tool_use\"}}}}\n\nevent: message_stop\ndata: {{}}\n\n")
                        } else {
                            format!("data: {{\"id\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"t\",\"type\":\"function\",\"function\":{{\"name\":\"f\",\"arguments\":{args}}}}}]}},\"finish_reason\":null}}]}}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n")
                        }
                    } else { body.to_owned() };
                    if mode.ends_with("disconnect") {
                        let end = if anthropic { body.find("event: content_block_stop").expect("stop") } else { body.find("\n\n").expect("first record") + 2 };
                        stub_gate.store(true, std::sync::atomic::Ordering::SeqCst);
                        // Native starts alone are precommit-buffered. A text delta
                        // commits the attempt while its deep request remains live.
                        let commit = if mode.starts_with("native") { "event: content_block_start\ndata: {\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"committed\"}}\n\n" } else { "" };
                        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}{commit}", body.len() + commit.len(), &body[..end]).expect("gated prefix");
                        // Keep the terminators withheld until the gateway closes upstream.
                        let mut byte = [0];
                        match socket.read(&mut byte) {
                            Ok(0) => {},
                            Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted) => {},
                            other => panic!("upstream must close while gated: {other:?}"),
                        }
                        closed_tx.take().expect("one close").send(()).expect("observer");
                    } else {
                        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("response");
                    }
                    }
                });
                let fixture = common::fixture(if mode == "retry" { &["c0", "c1"] } else { &["c0"] });
                if anthropic {
                    rusqlite::Connection::open(&fixture.path).expect("db").execute("UPDATE credentials SET provider='anthropic',provider_data='{}'", []).expect("provider");
                }
                if openai {
                    rusqlite::Connection::open(&fixture.path).expect("db").execute("UPDATE credentials SET provider='openai',provider_data='{}'", []).expect("provider");
                }
                if mode.contains("stream") {
                    rusqlite::Connection::open(&fixture.path).expect("db").execute(
                        "INSERT INTO api_keys (id,label,prefix,hash,created_at) VALUES ('depth','depth',?,?,0)",
                        rusqlite::params![omni_crypto::apikey::prefix("sk-depth"), omni_crypto::apikey::hash("sk-depth")],
                    ).expect("api key");
                }
                let h = common::harness(&fixture, vec![]);
                let deps = Arc::new(omni_gateway::dispatch::Deps {
                    http: Arc::new(Local { client: Client::new(), origin }),
                    ..Arc::try_unwrap(h.deps).unwrap_or_else(|_| panic!("sole deps"))
                });
                let model = if openai { "gpt-5" } else if anthropic { "claude-opus-5-5" } else { "m1" };
                // An arbitrary schema annotation, preserved by both codecs.
                let nested = format!("{}0{}", "[".repeat(39_980), "]".repeat(39_980));
                let body = format!(r#"{{"model":"{model}","messages":[{{"role":"user","content":"hi"}}],"tools":[{{"type":"function","function":{{"name":"f","parameters":{{"type":"object","x-deep":{nested}}}}}}}],"stream":false}}"#);
                if mode.contains("stream") {
                    server_stream(&fixture, deps.clone(), body, mode, gated, closed_rx).await;
                    drop(deps);
                    h.writer.close().await.expect("close");
                    stub.join().expect("stub");
                    return;
                }
                let mut mint = || "toolu_test".to_owned();
                let request = omni_dialects::ingress::ingest(omni_dialects::ingress::Surface::OpenAi, &body, &omni_dialects::ingress::Headers::new(), &mut omni_dialects::ingress::IngressOptions { new_tool_use_id: &mut mint }).expect("ingest").request;
                let mut d = omni_gateway::dispatch::dispatch(deps.clone(), omni_gateway::dispatch::Request { request, request_id: "deep".into(), api_key_id: Some("k1".into()), route_started_at: 0 });
                let mut events = Vec::new();
                if mode == "error" {
                    let mut failed = false;
                    while let Some(event) = d.events.next().await {
                        assert!(matches!(event.expect("normal error event"), omni_ir::stream::StreamEvent::Error { code: omni_ir::error::ErrorCode::BadRequest, .. }));
                        failed = true;
                    }
                    assert!(failed);
                } else if mode == "cancel" {
                    let mut partial = false;
                    while let Some(event) = d.events.next().await {
                        let event = event.expect("event");
                        if matches!(event, omni_ir::stream::StreamEvent::BlockDelta { .. }) { partial = true; break; }
                    }
                    assert!(partial, "cancel only after partial decode");
                } else {
                while let Some(event) = d.events.next().await { events.push(event.expect("event")); }
                assert!(events.iter().any(|e| matches!(e, omni_ir::stream::StreamEvent::End { .. })));
                let collected = omni_ir::stream::try_collect(events).expect("collect");
                let rendered = omni_dialects::egress::anthropic::response(&collected, "deep");
                let encoded = omni_ir::jsjson::to_string(&rendered);
                assert!(!encoded.is_empty());
                if mode == "response" || mode == "native" { assert!(encoded.contains(&"[".repeat(39_980))); }
                drop(rendered);
                drop(collected);
                }
                drop((d, deps));
                h.writer.close().await.expect("close");
                stub.join().expect("stub");
                eprintln!("deep dispatch ingest/codec/HTTP/release passed: {}", if openai { "openai" } else if anthropic { "anthropic" } else { "custom" });
            }
        });
    }).expect("worker").join().expect("join");
}
