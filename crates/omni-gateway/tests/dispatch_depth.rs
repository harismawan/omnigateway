mod common;

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
        .expect_err("ordinary serde recursion cap rejects stored deep data");
    assert!(
        error.to_string().contains("recursion limit exceeded"),
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

#[test]
fn deep_requests_through_dispatch_and_http() {
    run_case("deep_requests_through_dispatch_and_http", false, "request");
    run_case("deep_requests_through_dispatch_and_http", true, "request");
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
case!(anthropic_deep_response_buffered, true, "response");
case!(custom_deep_retry, false, "retry");
case!(anthropic_deep_retry, true, "retry");
case!(custom_deep_error, false, "error");
case!(anthropic_deep_error, true, "error");
case!(custom_deep_cancel, false, "cancel");
case!(anthropic_deep_cancel, true, "cancel");

fn run_case(name: &'static str, anthropic: bool, mode: &'static str) {
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
                    let path = if anthropic { "/v1/messages" } else { "/v1/chat/completions" };
                    assert!(wire.starts_with(format!("POST {path} HTTP/1.1\r\n").as_bytes()), "codec destination");
                    assert!(wire.split(|b| *b != b'[').any(|w| w.len() == 39_980), "full deep payload reached HTTP");
                    if mode == "error" || (mode == "retry" && attempt == 0) {
                        let status = if mode == "error" { 400 } else { 503 };
                        write!(socket, "HTTP/1.1 {status} Error\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{{\"error\":\"fixture failed\"}}").expect("error response");
                        continue;
                    }
                    let body = if anthropic {
                        "event: message_start\ndata: {\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":1}}}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {}\n\n"
                    } else {
                        "data: {\"id\":\"m\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
                    };
                    let body = if mode == "response" || mode == "cancel" {
                        let nested = format!("{}0{}", "[".repeat(39_980), "]".repeat(39_980));
                        let args = serde_json::to_string(&nested).expect("argument string");
                        if anthropic {
                            format!("event: message_start\ndata: {{\"message\":{{\"id\":\"m\",\"model\":\"claude-opus-5-5\",\"usage\":{{\"input_tokens\":1}}}}}}\n\nevent: content_block_start\ndata: {{\"index\":0,\"content_block\":{{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"f\",\"input\":{{}}}}}}\n\nevent: content_block_delta\ndata: {{\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":{args}}}}}\n\nevent: content_block_stop\ndata: {{\"index\":0}}\n\nevent: message_delta\ndata: {{\"delta\":{{\"stop_reason\":\"tool_use\"}}}}\n\nevent: message_stop\ndata: {{}}\n\n")
                        } else {
                            format!("data: {{\"id\":\"m\",\"choices\":[{{\"index\":0,\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"t\",\"type\":\"function\",\"function\":{{\"name\":\"f\",\"arguments\":{args}}}}}]}},\"finish_reason\":null}}]}}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n")
                        }
                    } else { body.to_owned() };
                    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("response");
                    }
                });
                let fixture = common::fixture(if mode == "retry" { &["c0", "c1"] } else { &["c0"] });
                if anthropic {
                    rusqlite::Connection::open(&fixture.path).expect("db").execute("UPDATE credentials SET provider='anthropic',provider_data='{}'", []).expect("provider");
                }
                let h = common::harness(&fixture, vec![]);
                let deps = Arc::new(omni_gateway::dispatch::Deps {
                    http: Arc::new(Local { client: Client::new(), origin }),
                    ..Arc::try_unwrap(h.deps).unwrap_or_else(|_| panic!("sole deps"))
                });
                let model = if anthropic { "claude-opus-5-5" } else { "m1" };
                // An arbitrary schema annotation, preserved by both codecs.
                let nested = format!("{}0{}", "[".repeat(39_980), "]".repeat(39_980));
                let body = format!(r#"{{"model":"{model}","messages":[{{"role":"user","content":"hi"}}],"tools":[{{"type":"function","function":{{"name":"f","parameters":{{"type":"object","x-deep":{nested}}}}}}}],"stream":false}}"#);
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
                if mode == "response" { assert!(encoded.contains(&"[".repeat(39_980))); }
                drop(rendered);
                drop(collected);
                }
                drop((d, deps));
                h.writer.close().await.expect("close");
                stub.join().expect("stub");
                eprintln!("deep dispatch ingest/codec/HTTP/release passed: {}", if anthropic { "anthropic" } else { "custom" });
            }
        });
    }).expect("worker").join().expect("join");
}
