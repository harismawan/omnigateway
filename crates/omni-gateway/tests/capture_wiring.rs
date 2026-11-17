#![allow(clippy::unwrap_used)]
use std::sync::Arc;
mod common;

use omni_gateway::body_capture::Collector;
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};

struct Script;

// A scripted HTTP peer emits a complete terminal stream but withholds EOF.
// Dispatch completion (or dropping dispatch) must close it, not await its tail.
#[tokio::test]
async fn dispatch_termination_releases_held_capture_and_writer() {
    use futures_util::StreamExt;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for mode in ["delayed-tail", "nonclosing", "shutdown", "abandon"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let common::Reply::Http(_, _, chunks) = common::sse_ok(1) else {
                unreachable!()
            };
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            socket.write_all(chunks.concat().as_bytes()).await.unwrap();
            let mut byte = [0];
            if mode == "delayed-tail" {
                tokio::select! {
                    _ = socket.read(&mut byte) => {},
                    () = tokio::time::sleep(Duration::from_secs(1)) => {
                        socket.write_all(b"TAIL_AFTER_TERMINAL\n\n").await.ok();
                    }
                }
            } else {
                assert_eq!(socket.read(&mut byte).await.unwrap(), 0);
            }
        });
        let f = common::fixture(&["c0"]);
        let h = common::harness(&f, vec![]);
        struct Redirect(std::net::SocketAddr, omni_providers::http::Client);
        impl HttpClient for Redirect {
            fn send(
                &self,
                mut req: HttpRequest,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
            > {
                req.url = format!("http://{}/", self.0);
                Box::pin(self.1.send(req))
            }
        }
        let collector = Collector::new(true);
        let deps = h.deps.with_http(collector.wrap(Arc::new(Redirect(
            addr,
            omni_providers::http::Client::new(),
        ))));
        let mut d = omni_gateway::dispatch::dispatch(
            deps,
            omni_gateway::dispatch::Request {
                request: common::chat("m1", true),
                request_id: mode.into(),
                api_key_id: None,
                route_started_at: 0,
            },
        );
        if mode == "abandon" {
            d.events.next().await.unwrap().unwrap();
            drop(d);
        } else {
            while d.events.next().await.is_some() {}
            drop(d);
        }
        tokio::time::timeout(Duration::from_millis(500), collector.settle())
            .await
            .expect("capture persists without provider EOF");
        let artifact = collector.artifact(mode, 0, None);
        let text = omni_ir::jsjson::stringify(&artifact).unwrap();
        assert!(text.contains("\"truncated\":true"), "{mode}: {text}");
        assert!(!text.contains("TAIL_AFTER_TERMINAL"));
        tokio::time::timeout(Duration::from_millis(500), h.writer.close())
            .await
            .expect("shutdown bounded by dispatch termination")
            .unwrap();
        tokio::time::timeout(Duration::from_millis(500), peer)
            .await
            .expect("socket released")
            .unwrap();
    }
}
impl HttpClient for Script {
    fn send(
        &self,
        _: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
    > {
        Box::pin(async {
            Ok(HttpResponse {
                status: 200,
                headers: Headers::new(),
                body: ResponseBody::from_chunks(vec!["data: hello\n\n".into(), "tail".into()]),
            })
        })
    }
}

// Real HTTP ingress, scripted provider transport, actual encrypted repository.
#[tokio::test]
async fn surfaces_gates_oversize_and_persistence_isolation() {
    use omni_gateway::{admin_auth, admin_routes, server};
    use omni_gateway_core::{
        ratelimit::RateLimiter,
        snapshot::{MissConfig, MissResolver},
    };
    use std::{sync::Mutex, time::Duration};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    omni_gateway::clock::init_request_ids().unwrap();
    for surface in ["chat/completions", "messages", "responses"] {
        for (allowed, enabled, opt_out, stream, broken, oversize) in [
            (false, true, false, false, false, false),
            (true, false, false, false, false, false),
            (true, true, true, false, false, false),
            (true, true, false, false, false, false),
            (true, true, false, true, false, false),
            (true, true, false, false, true, false),
            (true, true, false, true, false, true),
        ] {
            let f = common::fixture(&["c0"]);
            common::set_setting(
                &f.path,
                "bodyLoggingEnabled",
                if enabled { "true" } else { "false" },
            );
            let c = rusqlite::Connection::open(&f.path).unwrap();
            c.execute("INSERT INTO api_keys (id,label,prefix,hash,created_at,body_logging_opt_out) VALUES ('capture','capture','sk',?,0,?)", rusqlite::params![omni_crypto::apikey::hash("sk-capture"), opt_out]).unwrap();
            if broken {
                std::fs::write(f.dir.path().join("request_bodies"), "not a directory").unwrap();
            }
            let reply = if oversize {
                let common::Reply::Http(status, headers, mut chunks) = common::sse_ok(1) else {
                    unreachable!()
                };
                chunks.push(format!(": {}\n\n", "x".repeat(600_000)));
                common::Reply::Http(status, headers, chunks)
            } else {
                common::sse_ok(1)
            };
            let common::Reply::Http(_, _, ref chunks) = reply else {
                unreachable!()
            };
            let oracle_chunks: Vec<Vec<u8>> =
                chunks.iter().map(|s| s.as_bytes().to_vec()).collect();
            let h = common::harness(&f, vec![reply]);
            let store = || omni_store::SqliteStore::open(&f.path, 0).unwrap();
            let clock: admin_auth::Clock = Arc::new(|| 0);
            let app = Arc::new(server::App {
                deadline_workers: server::DeadlineWorkers::new(),
                miss: MissResolver::new(
                    h.deps.holder.clone(),
                    Arc::new(Mutex::new(store())),
                    MissConfig::default(),
                ),
                deps: h.deps.clone(),
                limiter: RateLimiter::new(),
                node_id: "capture".into(),
                keepalive: Duration::from_secs(10),
                idle_timeout: Duration::from_secs(20),
                bench_endpoints: false,
                bench_flush_timeout: Duration::from_secs(2),
                metrics_token: None,
                static_root: None,
                admin: admin_auth::AdminAuth::new(
                    store(),
                    Arc::new(admin_auth::MemoryKv::new(clock.clone())),
                    clock,
                    admin_auth::SESSION_TTL_MS,
                ),
                base_url_https: false,
                control: admin_routes::ControlStore::new(store()),
                credential_key: common::key(),
                connect: Arc::new(omni_gateway::connect::ConnectFlows::default()),
                body_logging_allowed: allowed,
                day_offset_minutes: 0,
                reported_catalog_problems: Mutex::default(),
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let task = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let service =
                    hyper::service::service_fn(move |req| server::handle(app.clone(), req));
                omni_gateway::http1_builder(Duration::from_secs(20))
                    .serve_connection(hyper_util::rt::TokioIo::new(socket), service)
                    .await
                    .unwrap();
            });
            let body = if surface == "responses" {
                format!(r#"{{"model":"m1","input":"hi","stream":{stream}}}"#)
            } else {
                format!(
                    r#"{{"model":"m1","max_tokens":10,"messages":[{{"role":"user","content":"hi"}}],"stream":{stream}}}"#
                )
            };
            let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
            socket.write_all(format!("POST /v1/{surface} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer sk-capture\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            let mut wire = Vec::new();
            socket.read_to_end(&mut wire).await.unwrap();
            task.await.unwrap();
            assert!(
                wire.starts_with(b"HTTP/1.1 200"),
                "{}",
                String::from_utf8_lossy(&wire)
            );
            h.writer.close().await.unwrap();
            let expected = allowed && enabled && !opt_out && !broken;
            let id: String = c
                .query_row("SELECT id FROM request_logs", [], |r| r.get(0))
                .unwrap();
            let artifact = store().get_body(&common::key(), &id).unwrap();
            assert_eq!(artifact.is_some(), expected, "{surface} {stream} {broken}");
            if let Some(artifact) = artifact {
                let text = omni_ir::jsjson::stringify(&artifact.artifact.unwrap()).unwrap();
                let actual: serde_json::Value = serde_json::from_str(&text).unwrap();
                let sent = h.script.seen.lock().unwrap()[0].clone();
                let cases = serde_json::json!([{"captureFrames":false,"client":body,"response":actual["client"]["response"].to_string(),"attempts":[{"provider":sent.provider,"request":sent.body,"mode":"stream","chunks":oracle_chunks}]}]);
                let expected = reference(&cases);
                let mut expected =
                    omni_ir::jsjson::parse_js(expected[0].as_str().unwrap()).unwrap();
                if let omni_ir::jsjson::JsValue::Object(ref mut fields) = expected {
                    for (key, value) in fields {
                        match String::from_utf16_lossy(key).as_str() {
                            "requestId" => {
                                *value =
                                    omni_ir::jsjson::JsValue::String(id.encode_utf16().collect())
                            }
                            "at" => {
                                *value =
                                    omni_ir::jsjson::parse_js(&actual["at"].to_string()).unwrap()
                            }
                            _ => {}
                        }
                    }
                }
                let (_, _, expected, _) = omni_store::bodies::prepare_put(&expected).unwrap();
                assert_eq!(text, expected, "persisted frozen collector {surface}");
                assert!(text.contains("\"request\":{\"model\":\"m1\""), "{text}");
                assert!(text.contains("\"provider\":\"custom\""), "{text}");
                assert!(text.contains("hi"));
                if oversize {
                    assert!(text.contains("\"truncated\":true"));
                }
            }
        }
    }
}

#[tokio::test]
async fn abandoned_adapter_branch_is_drained_before_settle() {
    let collector = Collector::new(true);
    let http = collector.wrap_for(Arc::new(Script), "parent".into());
    // A screened request's classifier finishes first but must not abort the
    // parent transport, just as its calls are excluded from the artifact.
    drop(http.dispatch_scope("classifier"));
    let mut response = http
        .send(HttpRequest {
            provider: "custom".into(),
            url: "http://localhost/".into(),
            method: "POST".into(),
            headers: vec![],
            body: "{}".into(),
            body_encoding: None,
            request_id: Some("parent".into()),
        })
        .await
        .unwrap();
    response.body.start_stream();
    drop(response);
    collector.settle().await;
    let artifact = collector.artifact("req_test", 0, None);
    let text = omni_ir::jsjson::stringify(&artifact).unwrap();
    assert!(text.contains("data: hello\\n\\ntail"), "{text}");
}

#[tokio::test]
async fn auth_retry_captures_actual_cloaked_calls_not_refresh() {
    use futures_util::StreamExt;
    let f = common::fixture(&["c0"]);
    let c = rusqlite::Connection::open(&f.path).unwrap();
    c.execute("UPDATE credentials SET provider='anthropic',provider_data='{}',auth_type='oauth',access_token=?,refresh_token=?", rusqlite::params![omni_crypto::field::encrypt(&common::key(), "old"), omni_crypto::field::encrypt(&common::key(), "refresh")]).unwrap();
    let h = common::harness(
        &f,
        vec![
            common::status(401, "{}"),
            common::status(200, r#"{"access_token":"rotated"}"#),
            common::status(401, "{}"),
        ],
    );
    let collector = Collector::new(false);
    let deps = h.deps.with_http(collector.wrap(h.deps.http.clone()));
    let mut chat = common::chat("claude-opus-5-5", true);
    chat.tools = Some(vec![]);
    let mut d = omni_gateway::dispatch::dispatch(
        deps,
        omni_gateway::dispatch::Request {
            request: chat,
            request_id: "req_retry".into(),
            api_key_id: None,
            route_started_at: 0,
        },
    );
    while d.events.next().await.is_some() {}
    collector.settle().await;
    let artifact = collector.artifact("req_1", 123, None);
    let seen = h.script.seen.lock().unwrap().clone();
    let calls: Vec<_> = seen
        .iter()
        .filter(|r| r.url.contains("/v1/messages"))
        .collect();
    assert_eq!(calls.len(), 2);
    let cases = serde_json::json!([{"captureFrames":false,"client":"null","response":"null","attempts":calls.iter().map(|r| serde_json::json!({"provider":r.provider,"request":r.body,"mode":"text","text":"{}"})).collect::<Vec<_>>()}]);
    let expected = reference(&cases);
    assert_eq!(
        omni_ir::jsjson::stringify(&artifact).unwrap(),
        expected[0].as_str().unwrap()
    );
    drop(seen);
    h.writer.close().await.unwrap();
}

fn reference(input: &serde_json::Value) -> serde_json::Value {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut child = Command::new("bun")
        .args([
            "--no-env-file",
            "conformance/store/body-capture-reference.ts",
        ])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(input).unwrap().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    serde_json::from_slice(&out.stdout).unwrap()
}
