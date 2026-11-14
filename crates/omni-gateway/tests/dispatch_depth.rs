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
        req.url = format!("{}/v1/messages", self.origin);
        Box::pin(self.client.send(req))
    }
}

#[test]
fn deep_requests_through_dispatch_and_http() {
    const CHILD: &str = "OMNI_DISPATCH_DEPTH_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args([
                "--exact",
                "deep_requests_through_dispatch_and_http",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .status()
            .expect("child");
        assert!(status.success(), "dispatch depth child: {status}");
        return;
    }
    std::thread::Builder::new().stack_size(2 * 1024 * 1024).spawn(|| {
        tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime").block_on(async {
            for anthropic in [false, true] {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listen");
                let origin = format!("http://{}", listener.local_addr().expect("addr"));
                let stub = std::thread::spawn(move || {
                    use std::io::{Read, Write};
                    let (mut socket, _) = listener.accept().expect("accept");
                    socket.set_read_timeout(Some(std::time::Duration::from_secs(20))).expect("timeout");
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
                    assert!(wire.windows(1000).any(|w| w.iter().all(|b| *b == b'[')), "deep payload reached HTTP");
                    let body = if anthropic {
                        "event: message_start\ndata: {\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":1}}}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {}\n\n"
                    } else {
                        "data: {\"id\":\"m\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
                    };
                    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("response");
                });
                let fixture = common::fixture(&["c0"]);
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
                while let Some(event) = d.events.next().await { events.push(event.expect("event")); }
                assert!(events.iter().any(|e| matches!(e, omni_ir::stream::StreamEvent::End { .. })));
                let collected = omni_ir::stream::try_collect(events).expect("collect");
                let rendered = omni_dialects::egress::anthropic::response(&collected, "deep");
                assert!(!omni_ir::jsjson::to_string(&rendered).is_empty());
                drop((rendered, collected, d, deps));
                h.writer.close().await.expect("close");
                stub.join().expect("stub");
                eprintln!("deep dispatch ingest/codec/HTTP/release passed: {}", if anthropic { "anthropic" } else { "custom" });
            }
        });
    }).expect("worker").join().expect("join");
}
