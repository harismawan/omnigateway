mod common;

use omni_providers::http::{Client, HttpClient, HttpError, HttpRequest, HttpResponse};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

// Origin-only wrapper from dispatch_depth.rs: real adapter, decoder and pool.
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
        req.url = format!("{}{}", self.origin, &path[path.find('/').expect("path")..]);
        Box::pin(self.client.send(req))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Complete,
    Truncated,
    Cancel,
    Delayed,
}

// The real HTTP ingress/egress fixture from dispatch_depth::server_stream.
async fn client_request(
    f: &common::Fixture,
    deps: Arc<omni_gateway::dispatch::Deps>,
    anthropic: bool,
    streaming: bool,
    cancel: bool,
    complete: bool,
) {
    use omni_gateway::{admin_auth, admin_routes, server};
    use omni_gateway_core::{
        ratelimit::RateLimiter,
        snapshot::{MissConfig, MissResolver},
    };
    use std::sync::Mutex;
    omni_gateway::clock::init_request_ids().expect("request ids");
    let store = || omni_store::SqliteStore::open(&f.path, 0).expect("store");
    let now: admin_auth::Clock = Arc::new(|| 0);
    let app = Arc::new(server::App {
        quiesce: Arc::new(omni_gateway::quiesce::Quiesce::default()),
        lifecycle: omni_gateway::lifecycle::Lifecycle::default(),
        version: "0.0.0-dev".into(),
        cluster: false,
        stop: tokio::sync::watch::channel(false).0,
        deadline_workers: server::DeadlineWorkers::new(),
        miss: MissResolver::new(
            deps.holder.clone(),
            Arc::new(Mutex::new(store())),
            MissConfig::default(),
        ),
        deps,
        limiter: RateLimiter::new(),
        node_id: "reuse".into(),
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
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let serving = app.clone();
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.expect("accept");
        let service = hyper::service::service_fn(move |req| server::handle(serving.clone(), req));
        omni_gateway::http1_builder(Duration::from_secs(20))
            .serve_connection(hyper_util::rt::TokioIo::new(socket), service)
            .await
    });
    let model = if anthropic { "claude-opus-5-5" } else { "m1" };
    let body = format!(
        r#"{{"model":"{model}","messages":[{{"role":"user","content":"hi"}}],"stream":{streaming}}}"#
    );
    let mut socket = tokio::net::TcpStream::connect(addr).await.expect("connect");
    socket.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer sk-reuse\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.expect("request");
    let mut wire = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let mut buf = [0; 8192];
            let n = socket.read(&mut buf).await.expect("response");
            if n == 0 {
                break;
            }
            wire.extend_from_slice(&buf[..n]);
            if cancel && String::from_utf8_lossy(&wire).contains("hello") {
                break;
            }
        }
    })
    .await
    .expect("client deadline");
    drop(socket);
    let result = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("handler deadline")
        .expect("handler task");
    if !cancel {
        result.expect("HTTP completion");
    }
    app.deadline_workers.shutdown().await;
    let text = String::from_utf8_lossy(&wire);
    if complete {
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.contains("hello"), "{text}");
        if streaming {
            assert!(text.contains("[DONE]"), "{text}");
        }
    }
    if cancel {
        assert!(text.contains("hello") && !text.contains("[DONE]"), "{text}");
    }
}

// Persistent request parser follows server.rs. TCP isolates body lifecycle;
// that fixture has no TLS setup.
async fn run(anthropic: bool, streaming: bool, mode: Mode) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let count = Arc::new(AtomicUsize::new(0));
    let accepted = count.clone();
    let finish = Arc::new(tokio::sync::Semaphore::new(0));
    let finish_upstream = finish.clone();
    let upstream = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        while let Ok((mut socket, _)) = listener.accept().await {
            let first = accepted.fetch_add(1, Ordering::SeqCst) == 0;
            let finish = finish_upstream.clone();
            tasks.spawn(async move {
                let prefix = if anthropic {
                    "event: message_start\ndata: {\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5-5\"}}\n\nevent: content_block_start\ndata: {\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n"
                } else { "data: {\"id\":\"m\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"}}]}\n\n" };
                let end = if anthropic {
                    "event: content_block_stop\ndata: {\"index\":0}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"}}\n\nevent: message_stop\ndata: {}\n\n"
                } else { "data: [DONE]\n\n" };
                loop {
                    let mut wire = Vec::new();
                    loop {
                        let mut buf = [0; 8192];
                        let Ok(n) = socket.read(&mut buf).await else { return };
                        if n == 0 { return; }
                        wire.extend_from_slice(&buf[..n]);
                        if let Some(end) = wire.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&wire[..end]);
                            let len: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|s| s.trim().parse().expect("length"))).expect("content length");
                            if wire.len() >= end + 4 + len { break; }
                        }
                    }
                    let body = format!("{prefix}{end}");
                    let response = if mode == Mode::Delayed {
                        format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n", body.len())
                    } else {
                        let payload = if first && matches!(mode, Mode::Truncated | Mode::Cancel) { prefix } else { &body };
                        format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{payload}", body.len())
                    };
                    if socket.write_all(response.as_bytes()).await.is_err() { return; }
                    if first && mode == Mode::Truncated { return; }
                    if first && mode == Mode::Cancel {
                        let mut byte = [0];
                        assert_eq!(socket.read(&mut byte).await.unwrap_or(0), 0);
                        return;
                    }
                    if mode == Mode::Delayed {
                        finish.acquire().await.expect("finish signal").forget();
                        if socket.write_all(b"0\r\n\r\n").await.is_err() { return; }
                    }
                }
            });
        }
    });
    let f = common::fixture(&["c0"]);
    rusqlite::Connection::open(&f.path)
        .expect("db")
        .execute(
            "INSERT INTO api_keys (id,label,prefix,hash,created_at) VALUES ('reuse','reuse',?,?,0)",
            rusqlite::params![
                omni_crypto::apikey::prefix("sk-reuse"),
                omni_crypto::apikey::hash("sk-reuse")
            ],
        )
        .expect("api key");
    if anthropic {
        rusqlite::Connection::open(&f.path)
            .expect("db")
            .execute(
                "UPDATE credentials SET provider='anthropic',provider_data='{}'",
                [],
            )
            .expect("provider");
    }
    let mut h = common::harness(&f, vec![]);
    let local = Arc::new(Local {
        client: Client::new(),
        origin,
    });
    Arc::get_mut(&mut h.deps).expect("unique").http = local.clone();
    let n = if matches!(mode, Mode::Cancel | Mode::Truncated) {
        2
    } else {
        20
    };
    for i in 0..n {
        client_request(
            &f,
            h.deps.clone(),
            anthropic,
            streaming,
            mode == Mode::Cancel && i == 0,
            i > 0 || matches!(mode, Mode::Complete | Mode::Delayed),
        )
        .await;
        if mode == Mode::Delayed {
            finish.add_permits(1);
            tokio::time::timeout(Duration::from_secs(5), async {
                while local.client.idle_connections() == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("completed framing must return to pool");
        }
    }
    let observed = count.load(Ordering::SeqCst);
    eprintln!("anthropic={anthropic} streaming={streaming}: {observed} sockets / {n} requests");
    h.writer.close().await.expect("close writer");
    upstream.abort();
    // Exactly one: a single origin, sequential requests, complete body framing.
    assert_eq!(
        observed,
        if matches!(mode, Mode::Cancel | Mode::Truncated) {
            2
        } else {
            1
        }
    );
}

#[tokio::test]
async fn anthropic_stream_reuses() {
    run(true, true, Mode::Complete).await;
}
#[tokio::test]
async fn anthropic_buffered_reuses() {
    run(true, false, Mode::Complete).await;
}
#[tokio::test]
async fn custom_stream_reuses() {
    run(false, true, Mode::Complete).await;
}
#[tokio::test]
async fn custom_buffered_reuses() {
    run(false, false, Mode::Complete).await;
}
#[tokio::test]
async fn truncated_responses_are_not_reused() {
    for a in [false, true] {
        for s in [false, true] {
            run(a, s, Mode::Truncated).await;
        }
    }
}
#[tokio::test]
async fn client_disconnects_are_not_reused() {
    for a in [false, true] {
        run(a, true, Mode::Cancel).await;
    }
}
#[tokio::test]
async fn delayed_chunked_terminator_reuses() {
    run(true, true, Mode::Delayed).await;
}

mod responses_probe {
    use super::*;
    use omni_ir::{
        request::ChatRequest,
        stream::{Delta, StreamEvent},
    };
    use omni_providers::{
        adapter::{AdapterRequest, send},
        codec::Credentials,
        custom::CustomCodec,
    };
    use serde_json::json;
    use tokio::net::TcpStream;

    async fn read_request(s: &mut TcpStream) -> bool {
        let mut b = Vec::new();
        loop {
            let mut x = [0; 8192];
            let Ok(n) = s.read(&mut x).await else {
                return false;
            };
            if n == 0 {
                return false;
            }
            b.extend_from_slice(&x[..n]);
            if let Some(e) = b.windows(4).position(|v| v == b"\r\n\r\n") {
                let h = String::from_utf8_lossy(&b[..e]).to_lowercase();
                let l: usize = h
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .expect("length")
                    .trim()
                    .parse()
                    .expect("number");
                if b.len() >= e + 4 + l {
                    return true;
                }
            }
        }
    }
    async fn one(client: &Client, creds: &Credentials) -> String {
        let req: ChatRequest =
            serde_json::from_value(json!({"model":"m","messages":[],"stream":true}))
                .expect("request");
        let mut r = send(
            &CustomCodec,
            "custom",
            AdapterRequest::new(&req, "m", creds),
            client,
        )
        .await
        .expect("send");
        let mut text = String::new();
        while let Some(e) = r.events.next().await {
            match &e.expect("event") {
                StreamEvent::BlockDelta {
                    delta: Delta::Text { text: t },
                    ..
                } => text.push_str(t),
                StreamEvent::End { .. } => return text,
                _ => {}
            }
        }
        panic!("no End")
    }
    async fn run(waves: usize, width: usize) {
        tokio::time::timeout(Duration::from_secs(30), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("addr");
            let count = Arc::new(AtomicUsize::new(0));
            let accepted = count.clone();
            let requests = Arc::new(AtomicUsize::new(0));
            let barrier = Arc::new(tokio::sync::Barrier::new(width));
            let upstream = tokio::spawn(async move {
                let mut tasks = tokio::task::JoinSet::new();
                while let Ok((mut s, _)) = listener.accept().await {
                    accepted.fetch_add(1, Ordering::SeqCst);
                    let requests = requests.clone(); let barrier = barrier.clone();
                    tasks.spawn(async move {
                        while read_request(&mut s).await {
                            let i = requests.fetch_add(1, Ordering::SeqCst);
                            barrier.wait().await;
                            let body = format!("event: response.output_text.delta\ndata: {{\"output_index\":0,\"delta\":\"own{i}\"}}\n\nevent: response.completed\ndata: {{\"response\":{{\"status\":\"completed\"}}}}\n\n");
                            if s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.is_err() { return; }
                        }
                    });
                }
            });
            let cr = Credentials { access_token: None, api_key: Some("key-one".into()), provider_data: json!({"origin":format!("http://{addr}"),"protocol":"responses"}).as_object().expect("credentials").clone() };
            let c = Arc::new(Client::new());
            for wave in 0..waves {
                let mut tasks = tokio::task::JoinSet::new();
                for _ in 0..width {
                    let c = c.clone(); let cr = cr.clone();
                    tasks.spawn(async move { one(&c,&cr).await });
                }
                let mut texts = std::collections::HashSet::new();
                while let Some(r) = tasks.join_next().await { texts.insert(r.expect("task")); }
                for i in wave*width..(wave+1)*width { assert!(texts.contains(&format!("own{i}"))); }
                assert_eq!(count.load(Ordering::SeqCst),width);
            }
            upstream.abort();
        }).await.expect("deadline");
    }
    #[tokio::test]
    async fn responses_reuse() {
        run(20, 1).await;
    }
    #[tokio::test]
    async fn concurrent_reuse() {
        run(5, 32).await;
    }

    #[tokio::test]
    async fn drain_forged_response_isolation() {
        isolation("forged").await;
    }
    #[tokio::test]
    async fn never_terminator_next_request_isolated() {
        isolation("never").await;
    }
    #[tokio::test]
    async fn drain_eof_completed_client_unaffected() {
        isolation("eof").await;
    }
    async fn isolation(mode: &'static str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("addr");
            let (finish, release) = tokio::sync::oneshot::channel();
            let (closed, observe_closed) = tokio::sync::oneshot::channel();
            let upstream = tokio::spawn(async move {
                let (mut first, _) = listener.accept().await.expect("first");
                assert!(read_request(&mut first).await);
                let body = |text: &str| format!("event: response.output_text.delta\ndata: {{\"output_index\":0,\"delta\":\"{text}\"}}\n\nevent: response.completed\ndata: {{\"response\":{{\"status\":\"completed\"}}}}\n\n");
                let own = body("own0");
                first.write_all(format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{own}\r\n",own.len()).as_bytes()).await.expect("first body");
                release.await.expect("client completed");
                if mode == "forged" {
                    first.write_all(b"0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nPOISON").await.expect("forged response");
                }
                if mode == "eof" { first.shutdown().await.expect("upstream EOF"); }
                let mut byte = [0];
                assert_eq!(first.read(&mut byte).await.unwrap_or(0),0);
                closed.send(()).expect("closed signal");
                let (mut second, _) = listener.accept().await.expect("second");
                assert!(read_request(&mut second).await);
                let own = body("own1");
                second.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{own}",own.len()).as_bytes()).await.expect("own response");
            });
            let mut cr = Credentials { access_token: None, api_key: Some("key-one".into()), provider_data: json!({"origin":format!("http://{addr}"),"protocol":"responses"}).as_object().expect("credentials").clone() };
            let c = Client::new();
            assert_eq!(one(&c,&cr).await,"own0");
            finish.send(()).expect("finish");
            observe_closed.await.expect("first closed");
            cr.api_key = Some("key-two".into());
            assert_eq!(one(&c,&cr).await,"own1");
            upstream.await.expect("upstream");
        }).await.expect("deadline");
    }
}
