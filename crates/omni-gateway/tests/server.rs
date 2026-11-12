//! The server end to end, in process: a real listener, a real local SSE
//! upstream, every route, exactly-one-row logging, 499 on hang-up,
//! keepalives, the body limit and graceful shutdown.

mod common;

use std::time::Duration;

use common::*;
use omni_gateway::{Options, start};
use omni_gateway_core::config::{LogLevel, load_config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A chat-completions SSE upstream: `mock-c<n>-d<ms>` streams n deltas
/// `ms` apart, as `bench-gateway-upstream.ts` does.
async fn upstream() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = l.local_addr().expect("addr").port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = Vec::new();
                loop {
                    let mut chunk = [0u8; 8192];
                    let Ok(n) = s.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let len: usize = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if buf.len() < end + 4 + len {
                        continue;
                    }
                    let body = &text[end + 4..end + 4 + len];
                    let model = body
                        .split("\"model\":\"")
                        .nth(1)
                        .and_then(|r| r.split('"').next())
                        .unwrap_or("")
                        .to_owned();
                    let parts: Vec<&str> = model.trim_start_matches("mock-c").split("-d").collect();
                    let chunks: usize = parts.first().and_then(|c| c.parse().ok()).unwrap_or(1);
                    let delay: u64 = parts.get(1).and_then(|c| c.parse().ok()).unwrap_or(0);
                    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
                    if s.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    let send = |d: String| format!("{:x}\r\n{d}\r\n", d.len());
                    let frame = |c: &str| {
                        format!(
                            "data: {{\"id\":\"x\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"{model}\",\"choices\":[{c}]}}\n\n"
                        )
                    };
                    let mut out = send(frame(
                        "{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}",
                    ));
                    for _ in 0..chunks {
                        out.push_str(&send(frame(
                            "{\"index\":0,\"delta\":{\"content\":\"lorem ipsum \"}}",
                        )));
                        if delay > 0 {
                            if s.write_all(out.as_bytes()).await.is_err() {
                                return;
                            }
                            out.clear();
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                    }
                    out.push_str(&send(frame(
                        "{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}",
                    )));
                    out.push_str(&send(format!(
                        "data: {{\"id\":\"x\",\"model\":\"{model}\",\"choices\":[],\"usage\":{{\"prompt_tokens\":64,\"completion_tokens\":{}}}}}\n\n",
                        chunks * 2
                    )));
                    out.push_str(&send("data: [DONE]\n\n".into()));
                    out.push_str("0\r\n\r\n");
                    if s.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                    buf.drain(..end + 4 + len);
                }
            });
        }
    });
    port
}

struct Gw {
    f: Fixture,
    base: String,
    running: Option<omni_gateway::Running>,
    key: String,
}

const KEY: &str = "sk-omni-test-key-plain";

fn add_key(path: &std::path::Path, id: &str, raw: &str, extra: &str, value: &str) {
    let c = rusqlite::Connection::open(path).expect("open");
    c.execute(
        &format!("INSERT INTO api_keys (id, label, prefix, hash, created_at{extra}) VALUES (?,?,?,?,0{value})"),
        rusqlite::params![id, id, omni_crypto::apikey::prefix(raw), omni_crypto::apikey::hash(raw)],
    )
    .expect("key");
}

async fn boot_with(models: &[(&str, &str)], keepalive: Duration) -> Gw {
    boot_opts(
        models,
        Options {
            keepalive,
            stop_deadline: Duration::from_secs(5),
            ..Options::default()
        },
    )
    .await
}

async fn boot_opts(models: &[(&str, &str)], options: Options) -> Gw {
    let port = upstream().await;
    let f = fixture(&["c0"]);
    let c = rusqlite::Connection::open(&f.path).expect("open");
    c.execute(
        "UPDATE credentials SET provider_data=? WHERE id='c0'",
        rusqlite::params![format!(
            "{{\"endpointId\":\"e0\",\"origin\":\"http://127.0.0.1:{port}\",\"protocol\":\"chat_completions\"}}"
        )],
    )
    .expect("origin");
    for (id, up) in models {
        c.execute(
            "INSERT OR REPLACE INTO virtual_models (id, targets, strategy) VALUES (?, ?, 'priority')",
            rusqlite::params![id, format!(
                "[{{\"provider\":\"custom\",\"endpointId\":\"e0\",\"model\":\"{up}\",\"tier\":1,\"weight\":1,\
                 \"costPerMTok\":{{\"input\":1,\"output\":2}},\"capabilities\":{{\"tools\":true,\"images\":true,\"reasoning\":true}}}}]"
            )],
        )
        .expect("model");
    }
    drop(c);
    add_key(&f.path, "kp", KEY, "", "");
    let env: std::collections::HashMap<String, String> = [
        ("OMNI_ENCRYPTION_KEY", ENC),
        ("OMNI_DB_PATH", f.path.to_str().expect("path")),
        ("OMNI_PORT", "1"),
        ("OMNI_DAY_OFFSET_MINUTES", "0"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    assert_eq!(config.log_level, LogLevel::Info);
    let running = start(config, options).await.expect("start");
    Gw {
        f,
        base: format!("127.0.0.1:{}", running.addr.port()),
        running: Some(running),
        key: KEY.into(),
    }
}

async fn boot() -> Gw {
    boot_with(
        &[("m1", "mock-c3-d0"), ("slow", "mock-c40-d50")],
        Duration::from_secs(10),
    )
    .await
}

#[tokio::test]
async fn nonreading_client_deadline_releases_upstream_and_concurrency() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut request = [0; 8192];
        assert!(socket.read(&mut request).await.expect("request") > 0);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .expect("head");
        let record = format!(
            "data: {}\n\n",
            serde_json::json!({"choices":[{"delta":{"content":"x".repeat(16384)}}]})
        );
        let frame = format!("{:x}\r\n{record}\r\n", record.len());
        let mut total = 0;
        loop {
            match tokio::time::timeout(
                Duration::from_millis(100),
                socket.write_all(frame.as_bytes()),
            )
            .await
            {
                Ok(Ok(())) => total += frame.len(),
                Err(_) => break,
                Ok(Err(e)) => panic!("closed before observed backpressure: {e}"),
            }
        }
        assert!(total > 1024 * 1024, "actually filled network buffers");
        blocked_tx.send(total).expect("blocked signal");
        let mut b = [0];
        let closed = tokio::time::timeout(Duration::from_secs(8), socket.read(&mut b))
            .await
            .expect("deadline closed upstream");
        assert!(matches!(closed, Ok(0) | Err(_)));
        closed_tx.send(()).expect("closure signal");
        let (mut next, _) = listener.accept().await.expect("later request admitted");
        assert!(next.read(&mut request).await.expect("next request") > 0);
        next.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\ndata: [DONE]\n\n")
            .await
            .expect("answer");
    });
    let f = fixture(&["c0"]);
    let db = rusqlite::Connection::open(&f.path).expect("db");
    db.execute("UPDATE credentials SET provider_data=?",[format!(r#"{{"endpointId":"e0","origin":"http://127.0.0.1:{port}","protocol":"chat_completions"}}"#)]).expect("origin");
    set_setting(&f.path, "requestDeadlineMs", "3000");
    add_key(&f.path, "kp", KEY, ",limits", ",'{\"concurrency\":1}'");
    let env = [
        ("OMNI_ENCRYPTION_KEY".into(), ENC.into()),
        ("OMNI_DB_PATH".into(), f.path.to_str().expect("path").into()),
        ("OMNI_PORT".into(), "1".into()),
    ]
    .into_iter()
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(config, Options::default()).await.expect("start");
    let base = format!("127.0.0.1:{}", running.addr.port());
    let socket = tokio::net::TcpSocket::new_v4().expect("socket");
    socket
        .set_recv_buffer_size(1024)
        .expect("small receive window");
    let mut client = socket
        .connect(base.parse().expect("address"))
        .await
        .expect("connect");
    let body = r#"{"model":"m1","messages":[{"role":"user","content":"hi"}],"stream":true}"#;
    client.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\nauthorization: Bearer {KEY}\r\ncontent-length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.expect("request");
    tokio::time::timeout(Duration::from_secs(2), blocked_rx)
        .await
        .expect("backpressure before deadline")
        .expect("blocked");
    let headers = [("authorization", format!("Bearer {KEY}"))];
    let auth = [(headers[0].0, headers[0].1.as_str())];
    let (status, _, _) = call(&base, "POST", "/v1/chat/completions", &auth, body).await;
    assert_eq!(status, 429, "concurrency held before deadline");
    closed_rx
        .await
        .expect("upstream closure with client still unread");
    let (status, _, response) = call(&base, "POST", "/v1/chat/completions", &auth, body).await;
    assert_eq!(status, 200, "admission/load released: {response}");
    upstream.await.expect("upstream");
    drop(client);
    running.shutdown();
    running.wait().await.expect("shutdown joins owned pump");
}

#[tokio::test]
async fn exhausted_persisted_budget_rejects_first_request_after_boot() {
    let f = fixture(&["c0"]);
    add_key(&f.path, "kp", KEY, ",limits", ",'{\"tokens\":{\"5h\":1}}'");
    let db = rusqlite::Connection::open(&f.path).expect("db");
    db.execute("INSERT INTO request_logs (id,at,api_key_id,requested_model,status,duration_ms,input_tokens,state) VALUES ('old',?,'kp','m1',200,0,10,'done')",[omni_gateway::clock::now_ms()]).expect("persisted usage");
    let env = [
        ("OMNI_ENCRYPTION_KEY".into(), ENC.into()),
        ("OMNI_DB_PATH".into(), f.path.to_str().expect("path").into()),
        ("OMNI_PORT".into(), "1".into()),
    ]
    .into_iter()
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let began = std::time::Instant::now();
    let running = start(
        config,
        Options {
            seed_delay: Duration::from_millis(100),
            ..Options::default()
        },
    )
    .await
    .expect("start");
    assert!(
        began.elapsed() >= Duration::from_millis(200),
        "both long windows installed before readiness"
    );
    let (status, _, body) = call(
        &format!("127.0.0.1:{}", running.addr.port()),
        "POST",
        "/v1/chat/completions",
        &[("authorization", &format!("Bearer {KEY}"))],
        r#"{"model":"m1","messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(status, 429, "first request: {body}");
    running.shutdown();
    running.wait().await.expect("shutdown");
}

#[tokio::test]
async fn failed_boot_is_bounded_and_same_database_restarts_cleanly() {
    let f = fixture(&["c0"]);
    add_key(&f.path, "kp", KEY, ",limits", ",'{\"tokens\":{\"5h\":1}}'");
    let env = [
        ("OMNI_ENCRYPTION_KEY".into(), ENC.into()),
        ("OMNI_DB_PATH".into(), f.path.to_str().expect("path").into()),
        ("OMNI_PORT".into(), "1".into()),
    ]
    .into_iter()
    .collect();
    let make_config = || {
        let mut c = load_config(&env, || 0).expect("config");
        c.port = 0;
        c
    };
    let error = tokio::time::timeout(
        Duration::from_secs(2),
        start(
            make_config(),
            Options {
                seed_delay: Duration::from_millis(100),
                boot_seed_timeout: Duration::from_millis(10),
                ..Options::default()
            },
        ),
    )
    .await
    .expect("bounded startup")
    .expect_err("timeout");
    assert!(error.contains("seed installation timed out"));
    let occupied = TcpListener::bind("127.0.0.1:0").await.expect("occupy");
    let mut config = make_config();
    config.port = occupied.local_addr().expect("addr").port();
    let error = start(config, Options::default())
        .await
        .expect_err("occupied port");
    assert!(error.contains("listen on"));
    drop(occupied);
    let running = start(make_config(), Options::default())
        .await
        .expect("restart after failed starts");
    running.shutdown();
    running.wait().await.expect("clean stop");
}

#[tokio::test]
async fn retained_output_overflow_closes_upstream_and_releases_admission() {
    for streaming in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = tokio::spawn(async move {
            for round in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept");
                let mut buf = Vec::new();
                loop {
                    let mut piece = [0; 8192];
                    let n = socket.read(&mut piece).await.expect("read");
                    assert!(n > 0);
                    buf.extend_from_slice(&piece[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.expect("head");
                let record = format!(
                    "data: {}\n\n",
                    serde_json::json!({"id":"c","model":"m","choices":[{"delta":{"content":"x".repeat(1024)}}]})
                );
                let frame = format!("{:x}\r\n{record}\r\n", record.len());
                // Below-limit second request verifies admission was released.
                let count = if round == 0 { 8193 } else { 8191 };
                for _ in 0..count {
                    if socket.write_all(frame.as_bytes()).await.is_err() {
                        break;
                    }
                }
                if round == 1 {
                    let done = "data: [DONE]\n\n";
                    socket
                        .write_all(format!("{:x}\r\n{done}\r\n0\r\n\r\n", done.len()).as_bytes())
                        .await
                        .expect("terminal");
                } else {
                    let mut byte = [0];
                    let closed =
                        tokio::time::timeout(Duration::from_secs(10), socket.read(&mut byte))
                            .await
                            .expect("overflow cancels upstream");
                    assert!(matches!(closed, Ok(0) | Err(_)));
                }
            }
        });
        let f = fixture(&["c0"]);
        let c = rusqlite::Connection::open(&f.path).expect("db");
        c.execute("UPDATE credentials SET provider_data=?",[format!(r#"{{"endpointId":"e0","origin":"http://127.0.0.1:{port}","protocol":"chat_completions"}}"#)]).expect("origin");
        add_key(&f.path, "kp", KEY, ",limits", ",'{\"concurrency\":1}'");
        let env = [
            ("OMNI_ENCRYPTION_KEY".to_owned(), ENC.to_owned()),
            ("OMNI_DB_PATH".into(), f.path.to_str().expect("path").into()),
            ("OMNI_PORT".into(), "1".into()),
        ]
        .into_iter()
        .collect();
        let mut config = load_config(&env, || 0).expect("config");
        config.port = 0;
        let running = start(config, Options::default()).await.expect("start");
        let base = format!("127.0.0.1:{}", running.addr.port());
        let (path, body) = if streaming {
            (
                "/v1/responses",
                r#"{"model":"m1","input":"hi","stream":true}"#,
            )
        } else {
            (
                "/v1/chat/completions",
                r#"{"model":"m1","messages":[{"role":"user","content":"hi"}],"stream":false}"#,
            )
        };
        for round in 0..2 {
            let (status, _, body) = tokio::time::timeout(
                Duration::from_secs(30),
                call(
                    &base,
                    "POST",
                    path,
                    &[("authorization", &format!("Bearer {KEY}"))],
                    body,
                ),
            )
            .await
            .expect("bounded call");
            if round == 0 {
                if streaming {
                    assert_eq!(status, 200);
                    assert!(!body.contains("response.completed"));
                } else {
                    assert_eq!(status, 502);
                    assert!(body.contains("retained response budget"));
                }
            } else {
                assert_eq!(status, 200, "admission released: {body}");
                if streaming {
                    assert!(body.contains("response.completed"));
                }
            }
        }
        server.await.expect("server");
        running.shutdown();
        running.wait().await.expect("stop");
    }
}

/// One raw HTTP/1.1 exchange; returns (status, lowercased headers, body).
async fn call(
    base: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, Vec<(String, String)>, String) {
    let mut s = TcpStream::connect(base).await.expect("connect");
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).await.expect("write");
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.expect("read");
    let text = String::from_utf8_lossy(&out).to_string();
    let (head, rest) = text.split_once("\r\n\r\n").expect("head");
    let mut lines = head.lines();
    let status: u16 = lines
        .next()
        .expect("status")
        .split(' ')
        .nth(1)
        .expect("code")
        .parse()
        .expect("num");
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(": "))
        .map(|(k, v)| (k.to_lowercase(), v.to_owned()))
        .collect();
    let chunked = headers
        .iter()
        .any(|(k, v)| k == "transfer-encoding" && v == "chunked");
    let body = if chunked {
        dechunk(rest)
    } else {
        rest.to_owned()
    };
    (status, headers, body)
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = s.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.push_str(&rest[..n]);
        s = &rest[n + 2..];
    }
    out
}

fn bearer(g: &Gw) -> String {
    format!("Bearer {}", g.key)
}

async fn stop(mut g: Gw) -> Fixture {
    let r = g.running.take().expect("running");
    r.shutdown();
    r.wait().await.expect("clean shutdown");
    g.f
}

fn logs(f: &Fixture) -> Vec<Vec<String>> {
    rows(
        &f.path,
        "SELECT requested_model, status, error_code, state, attempts, input_tokens, output_tokens FROM request_logs ORDER BY at, id",
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_streaming_request_files_exactly_one_completed_row() {
    let g = boot().await;
    let auth = bearer(&g);
    let (status, headers, body) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        r#"{"model":"m1","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(status, 200);
    assert!(headers.contains(&(
        "content-type".into(),
        "text/event-stream; charset=utf-8".into()
    )));
    assert_eq!(body.matches("lorem ipsum").count(), 3);
    assert!(body.ends_with("event: message\ndata: [DONE]\n\n"));
    let f = stop(g).await;
    assert_eq!(logs(&f), [["m1", "200", "null", "done", "1", "64", "6"]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_dialect_answers_buffered_and_streamed() {
    let g = boot().await;
    let auth = bearer(&g);
    for (path, body) in [
        (
            "/v1/messages",
            r#"{"model":"m1","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}"#,
        ),
        (
            "/v1/messages",
            r#"{"model":"m1","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        ),
        (
            "/v1/chat/completions",
            r#"{"model":"m1","messages":[{"role":"user","content":"hi"}]}"#,
        ),
        ("/v1/responses", r#"{"model":"m1","input":"hi"}"#),
        (
            "/v1/responses",
            r#"{"model":"m1","stream":true,"input":"hi"}"#,
        ),
    ] {
        let (status, _, text) =
            call(&g.base, "POST", path, &[("authorization", &auth)], body).await;
        assert_eq!(status, 200, "{path} {body}: {text}");
        assert!(text.contains("lorem ipsum"), "{path}: {text}");
    }
    let f = stop(g).await;
    assert_eq!(logs(&f).len(), 5);
    assert!(logs(&f).iter().all(|r| r[1] == "200" && r[3] == "done"));
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_failures_answer_in_the_dialect_and_file_a_row() {
    let g = boot().await;
    let (s, _, b) = call(&g.base, "POST", "/v1/messages", &[], "{}").await;
    assert_eq!(s, 401);
    assert_eq!(
        b,
        r#"{"type":"error","error":{"type":"authentication_error","message":"missing or malformed Authorization header"}}"#
    );
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", "Bearer sk-omni-nope")],
        "{}",
    )
    .await;
    assert_eq!(s, 401);
    assert!(b.contains("invalid API key"), "{b}");
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", "Bearer a"), ("x-api-key", "b")],
        "{}",
    )
    .await;
    assert_eq!((s, b.contains("conflicting API key headers")), (401, true));
    let f = stop(g).await;
    assert_eq!(
        rows(
            &f.path,
            "SELECT status, error_code, api_key_id FROM request_logs"
        )
        .len(),
        3
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unparsable_body_is_ts_s_500_with_jsc_s_message() {
    let g = boot().await;
    let auth = bearer(&g);
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", &auth)],
        "{bad",
    )
    .await;
    assert_eq!(s, 500);
    assert_eq!(
        b,
        r#"{"type":"error","error":{"type":"api_error","message":"JSON Parse error: Expected '}'"}}"#
    );
    let f = stop(g).await;
    assert_eq!(
        rows(&f.path, "SELECT status, error_code FROM request_logs"),
        [["500", "INTERNAL"]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_over_the_limit_is_the_dialect_s_invalid_request() {
    let g = boot().await;
    let auth = bearer(&g);
    let big = format!(
        "{{\"model\":\"m1\",\"x\":\"{}\"}}",
        "a".repeat(omni_gateway::server::BODY_LIMIT)
    );
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        &big,
    )
    .await;
    assert_eq!(s, 400);
    assert!(b.contains("\"type\":\"invalid_request_error\""), "{b}");
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn health_models_count_tokens_and_the_404s() {
    let g = boot().await;
    let auth = bearer(&g);
    let (s, h, b) = call(&g.base, "GET", "/health", &[], "").await;
    assert_eq!(s, 200);
    assert!(h.contains(&(
        "content-type".into(),
        "application/json;charset=utf-8".into()
    )));
    assert!(b.starts_with("{\"ok\":true,\"mode\":\"single\",\"nodeId\":\""));
    let (s, _, b) = call(&g.base, "GET", "/v1/models", &[("x-api-key", &g.key)], "").await;
    assert_eq!(s, 200);
    assert!(
        b.starts_with("{\"object\":\"list\",\"data\":[{\"id\":\"m1\""),
        "{b}"
    );
    assert!(
        b.ends_with("\"has_more\":false,\"first_id\":\"m1\",\"last_id\":\"slow\"}"),
        "{b}"
    );
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages/count_tokens",
        &[("authorization", &auth)],
        r#"{"model":"m1","messages":[{"role":"user","content":"hi there"}]}"#,
    )
    .await;
    assert_eq!((s, b.as_str()), (200, "{\"input_tokens\":10}"));
    let (s, _, b) = call(&g.base, "GET", "/nope", &[], "").await;
    assert_eq!(
        (s, b.as_str()),
        (
            404,
            r#"{"error":{"code":"NOT_FOUND","message":"no route for /nope"}}"#
        )
    );
    let (s, _, b) = call(&g.base, "POST", "/v1/nope", &[], "").await;
    assert_eq!((s, b.as_str()), (404, "NOT_FOUND"));
    let f = stop(g).await;
    // count_tokens and models write no row.
    assert!(rows(&f.path, "SELECT id FROM request_logs").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_hangs_up_mid_stream_files_one_499_row() {
    let g = boot().await;
    let auth = bearer(&g);
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let body = r#"{"model":"slow","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let req = format!(
        "POST /v1/messages HTTP/1.1\r\nhost: x\r\nauthorization: {auth}\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.expect("write");
    let mut got = Vec::new();
    while !String::from_utf8_lossy(&got).contains("lorem ipsum") {
        let mut chunk = [0u8; 4096];
        let n = s.read(&mut chunk).await.expect("read");
        assert!(n > 0);
        got.extend_from_slice(&chunk[..n]);
    }
    drop(s);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let f = stop(g).await;
    let r = rows(
        &f.path,
        "SELECT status, error_code, state, attempts, credential_id FROM request_logs",
    );
    assert_eq!(r, [["499", "interrupted", "done", "1", "c0"]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_stream_carries_keepalive_comments() {
    let g = boot_with(&[("slow", "mock-c3-d300")], Duration::from_millis(100)).await;
    let auth = bearer(&g);
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        r#"{"model":"slow","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(s, 200);
    assert!(b.contains(": keepalive\n\n"), "{b}");
    assert!(b.ends_with("data: [DONE]\n\n"));
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_lets_an_open_stream_finish_and_flushes_its_row() {
    let g = boot_with(&[("slow", "mock-c5-d100")], Duration::from_secs(10)).await;
    let auth = bearer(&g);
    let base = g.base.clone();
    let client = tokio::spawn(async move {
        call(
            &base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", &auth)],
            r#"{"model":"slow","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let f = stop(g).await;
    let (s, _, b) = client.await.expect("client");
    assert_eq!(s, 200);
    assert!(b.ends_with("data: [DONE]\n\n"));
    assert_eq!(logs(&f), [["slow", "200", "null", "done", "1", "64", "10"]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_concurrency_limited_key_is_refused_with_retry_after_and_headers() {
    let g = boot_with(&[("slow", "mock-c3-d200")], Duration::from_secs(10)).await;
    add_key(
        &g.f.path,
        "kl",
        "sk-omni-limited",
        ", limits",
        r#", '{"concurrency":1,"requests":{"1m":100}}'"#,
    );
    // The refresher picks the new key up within one poll; the miss read sooner.
    let base = g.base.clone();
    let first = tokio::spawn(async move {
        call(
            &base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", "Bearer sk-omni-limited")],
            r#"{"model":"slow","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (s, h, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", "Bearer sk-omni-limited")],
        r#"{"model":"slow","messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(s, 429, "{b}");
    assert!(b.contains("API key rate limit exceeded"));
    assert!(
        h.iter().any(|(k, _)| k == "x-ratelimit-limit-requests"),
        "{h:?}"
    );
    let (s1, h1, _) = first.await.expect("first");
    assert_eq!(s1, 200);
    assert!(
        h1.contains(&("x-ratelimit-remaining-requests".into(), "99".into())),
        "{h1:?}"
    );
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_complete_at_head_time_goes_out_with_a_content_length() {
    let g = boot().await;
    let auth = bearer(&g);
    let (s, h, b) = call(&g.base, "POST", "/v1/messages", &[("authorization", &auth)],
        r#"{"model":"nope","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#).await;
    assert_eq!(s, 200);
    assert!(b.starts_with("event: error\n"), "{b}");
    assert!(
        h.contains(&("content-length".into(), b.len().to_string())),
        "{h:?}"
    );
    stop(g).await;
}

/// Screening is not ported: keys that need it fail closed, as TS refuses
/// when screening is not configured (`guardrail/judge.ts`, `smartRouter/check.ts`).
async fn screened(settings: &[(&str, &str)]) -> Gw {
    let g = boot_with(&[("m1", "mock-c3-d0")], Duration::from_secs(10)).await;
    add_key(
        &g.f.path,
        "kpol",
        "sk-omni-policy",
        ", guardrail_policy",
        ", 'no secrets'",
    );
    add_key(&g.f.path, "ksr", "sk-omni-smart", ", smart_routing", ", 1");
    for (k, v) in settings {
        set_setting(&g.f.path, k, v);
    }
    // Let the refresher pick the settings and keys up.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    g
}

fn screen_rows(f: &Fixture) -> Vec<Vec<String>> {
    rows(
        &f.path,
        "SELECT api_key_id, requested_model, status, error_code, attempts, degradations, credential_id FROM request_logs ORDER BY at, id",
    )
}

const MSG: &str = r#"{"model":"m1","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}"#;
const MSG_STREAM: &str =
    r#"{"model":"m1","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#;

#[tokio::test(flavor = "multi_thread")]
async fn a_policy_key_with_no_guardrail_model_is_refused_as_unconfigured() {
    let g = screened(&[]).await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-policy")],
        MSG,
    )
    .await;
    assert_eq!(s, 500);
    assert_eq!(
        b,
        r#"{"type":"error","error":{"type":"api_error","message":"usage policy check is not configured"}}"#
    );
    let (s, h, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-policy")],
        MSG_STREAM,
    )
    .await;
    assert_eq!(s, 200);
    assert!(
        h.contains(&("content-length".into(), b.len().to_string())),
        "{h:?}"
    );
    assert_eq!(
        b,
        "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"usage policy check is not configured\"}}\n\n"
    );
    let f = stop(g).await;
    let r = screen_rows(&f);
    assert_eq!(r.len(), 2);
    for row in r {
        assert_eq!(
            row,
            [
                "kpol",
                "m1",
                "500",
                "INTERNAL",
                "0",
                r#"["guardrail:unconfigured"]"#,
                "null"
            ]
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_policy_key_with_a_guardrail_model_is_refused_as_unavailable_without_a_classifier_call() {
    let g = screened(&[("guardrailModel", "\"m1\"")]).await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("x-api-key", "sk-omni-policy")],
        r#"{"model":"m1","messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(s, 502);
    assert_eq!(
        b,
        r#"{"error":{"message":"usage policy check unavailable","type":"server_error","code":"server_error"}}"#
    );
    let f = stop(g).await;
    // One row: no classifier row, nothing dispatched.
    assert_eq!(
        screen_rows(&f),
        [[
            "kpol",
            "m1",
            "502",
            "UPSTREAM",
            "0",
            r#"["guardrail:unavailable"]"#,
            "null"
        ]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_smart_routing_key_takes_the_normal_path_while_smart_routing_is_off() {
    let g = screened(&[]).await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-smart")],
        MSG,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(b.contains("lorem ipsum"));
    let f = stop(g).await;
    assert_eq!(
        screen_rows(&f),
        [["ksr", "m1", "200", "null", "1", "[]", "c0"]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_smart_routing_key_with_no_models_is_refused_as_unconfigured() {
    let g = screened(&[("smartRouterEnabled", "true")]).await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-smart")],
        MSG,
    )
    .await;
    assert_eq!(s, 500);
    assert_eq!(
        b,
        r#"{"type":"error","error":{"type":"api_error","message":"confidential routing is not configured"}}"#
    );
    let f = stop(g).await;
    assert_eq!(
        screen_rows(&f),
        [[
            "ksr",
            "m1",
            "500",
            "INTERNAL",
            "0",
            r#"["smart-router:unconfigured"]"#,
            "null"
        ]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_smart_routing_key_with_models_set_is_refused_as_unavailable() {
    let g = screened(&[
        ("smartRouterEnabled", "true"),
        ("smartRouterClassifierModel", "\"m1\""),
        ("smartRouterLocalModel", "\"m1\""),
    ])
    .await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/responses",
        &[("x-api-key", "sk-omni-smart")],
        r#"{"model":"m1","input":"hi"}"#,
    )
    .await;
    assert_eq!(s, 502);
    assert!(
        b.contains("\"message\":\"confidentiality check unavailable\""),
        "{b}"
    );
    let f = stop(g).await;
    assert_eq!(
        screen_rows(&f),
        [[
            "ksr",
            "m1",
            "502",
            "UPSTREAM",
            "0",
            r#"["smart-router:unavailable"]"#,
            "null"
        ]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_screen_still_takes_its_rate_limit_slot() {
    let g = boot_with(&[("m1", "mock-c3-d0")], Duration::from_secs(10)).await;
    add_key(
        &g.f.path,
        "kpl",
        "sk-omni-pol-lim",
        ", guardrail_policy, limits",
        r#", 'p', '{"requests":{"1m":1}}'"#,
    );
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let (s1, _, _) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-pol-lim")],
        MSG,
    )
    .await;
    let (s2, _, b2) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-pol-lim")],
        MSG,
    )
    .await;
    assert_eq!((s1, s2), (500, 429), "{b2}");
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_complete_stream_of_two_frames_is_still_chunked_as_bun_sends_it() {
    let g = boot().await;
    let auth = bearer(&g);
    let (s, h, b) = call(
        &g.base,
        "POST",
        "/v1/responses",
        &[("authorization", &auth)],
        r#"{"model":"nope","stream":true,"input":"hi"}"#,
    )
    .await;
    assert_eq!(s, 200);
    assert!(
        b.starts_with("event: response.failed\n") && b.ends_with("data: [DONE]\n\n"),
        "{b}"
    );
    assert!(
        h.contains(&("transfer-encoding".into(), "chunked".into())),
        "{h:?}"
    );
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn repeated_auth_headers_are_joined_as_whatwg_headers_get_joins_them() {
    let g = boot().await;
    let auth = bearer(&g);
    // Two Authorization lines read as "Bearer k, Bearer k": not a key.
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", &auth), ("authorization", &auth)],
        MSG,
    )
    .await;
    assert_eq!(s, 401, "{b}");
    assert!(b.contains("invalid API key"), "{b}");
    // Matching Authorization and x-api-key tokens are accepted.
    let (s, _, _) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", &auth), ("x-api-key", &g.key)],
        MSG,
    )
    .await;
    assert_eq!(s, 200);
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_still_open_at_the_drain_deadline_files_its_499_before_the_writer_closes() {
    let g = boot_opts(
        &[("slow", "mock-c50-d200")],
        Options {
            stop_deadline: Duration::from_millis(300),
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let body = r#"{"model":"slow","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let req = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\nauthorization: {auth}\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.expect("write");
    let mut got = Vec::new();
    while !String::from_utf8_lossy(&got).contains("lorem ipsum") {
        let mut chunk = [0u8; 4096];
        let n = s.read(&mut chunk).await.expect("read");
        assert!(n > 0);
        got.extend_from_slice(&chunk[..n]);
    }
    let f = stop(g).await;
    drop(s);
    assert_eq!(
        rows(
            &f.path,
            "SELECT status, error_code, state, attempts FROM request_logs"
        ),
        [["499", "interrupted", "done", "1"]]
    );
}

async fn idle_gw(idle: Duration) -> Gw {
    boot_opts(
        &[("m1", "mock-c3-d0")],
        Options {
            idle_timeout: idle,
            ..Options::default()
        },
    )
    .await
}

/// Reads until the server closes; `None` when the read itself waited past `limit`.
async fn read_until_closed(s: &mut TcpStream, limit: Duration) -> Option<String> {
    let mut out = Vec::new();
    let r = tokio::time::timeout(limit, s.read_to_end(&mut out)).await;
    r.ok().map(|_| String::from_utf8_lossy(&out).into_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_that_stops_arriving_is_cut_after_the_idle_timeout() {
    let g = idle_gw(Duration::from_millis(300)).await;
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let req = format!(
        "POST /v1/messages HTTP/1.1\r\nhost: x\r\nx-api-key: {}\r\ncontent-length: 100\r\n\r\n{{\"model\":",
        g.key
    );
    s.write_all(req.as_bytes()).await.expect("write");
    let started = std::time::Instant::now();
    let got = read_until_closed(&mut s, Duration::from_secs(3))
        .await
        .expect("closed within 3 s");
    assert!(
        started.elapsed() >= Duration::from_millis(250),
        "{:?}",
        started.elapsed()
    );
    // No answer, never dispatched; the row reads as a hang-up.
    assert!(!got.contains("HTTP/1.1"), "{got}");
    let f = stop(g).await;
    assert_eq!(
        rows(
            &f.path,
            "SELECT status, error_code, requested_model, api_key_id FROM request_logs"
        ),
        [["499", "interrupted", "", "kp"]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_but_steady_body_is_not_cut() {
    let g = idle_gw(Duration::from_millis(300)).await;
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let body = MSG.as_bytes();
    let head = format!(
        "POST /v1/messages HTTP/1.1\r\nhost: x\r\nx-api-key: {}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n",
        g.key,
        body.len()
    );
    s.write_all(head.as_bytes()).await.expect("write");
    // Total well past the idle timeout, every gap well under it.
    for part in body.chunks(8) {
        s.write_all(part).await.expect("write");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let got = read_until_closed(&mut s, Duration::from_secs(5))
        .await
        .expect("answered");
    assert!(got.starts_with("HTTP/1.1 200"), "{got}");
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_keep_alive_connection_and_a_stalled_head_are_closed() {
    let g = idle_gw(Duration::from_millis(300)).await;
    let mut idle = TcpStream::connect(&g.base).await.expect("connect");
    assert!(
        read_until_closed(&mut idle, Duration::from_secs(3))
            .await
            .is_some()
    );
    let mut half = TcpStream::connect(&g.base).await.expect("connect");
    half.write_all(b"GET /health HTTP/1.1\r\nhost")
        .await
        .expect("write");
    assert!(
        read_until_closed(&mut half, Duration::from_secs(3))
            .await
            .is_some()
    );
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_silent_upstream_stream_with_keepalives_outlives_the_idle_timeout() {
    // Idle timeout 300 ms; the upstream is silent 1 s between deltas; the
    // gateway's keepalive every 100 ms keeps the response going. The idle
    // timeouts bound reading the request only.
    let g = boot_opts(
        &[("silent", "mock-c2-d1000")],
        Options {
            idle_timeout: Duration::from_millis(300),
            keepalive: Duration::from_millis(100),
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", &auth)],
        MSG_STREAM.replace("m1", "silent").as_str(),
    )
    .await;
    assert_eq!(s, 200);
    assert!(b.matches(": keepalive").count() >= 10, "{b}");
    assert!(b.contains("event: message_stop"), "{b}");
    let f = stop(g).await;
    assert_eq!(rows(&f.path, "SELECT status FROM request_logs"), [["200"]]);
}

/// `POST /__omni/bench/flush`, with bench endpoints on (`OMNI_BENCH=1`):
/// answered once every row from before it is committed, with the writer's
/// cumulative counters.
#[tokio::test(flavor = "multi_thread")]
async fn the_bench_flush_barrier_commits_and_counts() {
    let g = boot_opts(
        &[("fast", "mock-c1-d0")],
        Options {
            bench_endpoints: true,
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    for _ in 0..5 {
        let (s, _, _) = call(
            &g.base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", &auth)],
            r#"{"model":"fast","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await;
        assert_eq!(s, 200);
    }
    let (s, _, b) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s, 200, "{b}");
    let v: serde_json::Value = serde_json::from_str(&b).expect("json");
    assert_eq!(v["dropped"], 0, "{b}");
    assert_eq!(v["failed"], 0, "{b}");
    // Two events per request (Begin, Finish), all ahead of the barrier.
    assert_eq!(v["watermark"], 10, "{b}");
    assert_eq!(v["committed"], 10, "{b}");
    // Committed means in the database, now.
    let done = rows(
        &g.f.path,
        "SELECT COUNT(*) FROM request_logs WHERE state = 'done'",
    );
    assert_eq!(done, [["5"]]);
    stop(g).await;
}

/// Without `OMNI_BENCH=1` the route does not exist: the ordinary 404.
#[tokio::test(flavor = "multi_thread")]
async fn the_bench_flush_route_is_off_by_default() {
    let g = boot_opts(&[("fast", "mock-c1-d0")], Options::default()).await;
    let (s, _, _) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s, 404);
    stop(g).await;
}

/// Holds the database's write lock from another connection, so the writer's
/// next batch (and any barrier behind it) waits.
fn hold_write_lock(path: &std::path::Path) -> rusqlite::Connection {
    let c = rusqlite::Connection::open(path).expect("open");
    c.execute_batch("BEGIN IMMEDIATE").expect("lock");
    c
}

/// One barrier at a time: while one waits on a stuck writer, a second gets
/// 409; the first gives up after the server's timeout with 504
/// `inconclusive`; the slot stays taken until the writer answers it.
#[tokio::test(flavor = "multi_thread")]
async fn a_concurrent_barrier_is_409_and_a_stuck_one_times_out_with_504() {
    let g = boot_opts(
        &[("fast", "mock-c1-d0")],
        Options {
            bench_endpoints: true,
            bench_flush_timeout: Duration::from_millis(500),
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    let (s, _, _) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        r#"{"model":"fast","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(s, 200);
    let lock = hold_write_lock(&g.f.path);
    let base = g.base.clone();
    let first =
        tokio::spawn(async move { call(&base, "POST", "/__omni/bench/flush", &[], "").await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (s2, _, b2) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s2, 409, "{b2}");
    assert!(b2.contains("\"inconclusive\":true"), "{b2}");
    let (s1, _, b1) = first.await.expect("first");
    assert_eq!(s1, 504, "{b1}");
    assert!(b1.contains("\"inconclusive\":true"), "{b1}");
    // Still in flight (the writer has not answered it): still 409.
    let (s3, _, _) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s3, 409);
    drop(lock);
    // Once the writer gets through, barriers are admitted again.
    let mut ok = false;
    for _ in 0..50 {
        let (s, _, b) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
        if s == 200 {
            let v: serde_json::Value = serde_json::from_str(&b).expect("json");
            assert_eq!(v["watermark"], 2, "{b}");
            assert_eq!(v["committed"], 2, "{b}");
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ok, "no barrier admitted after the writer recovered");
    stop(g).await;
}

/// A barrier never waits for queue room: a full queue is 503 `inconclusive`.
#[tokio::test(flavor = "multi_thread")]
async fn a_barrier_on_a_full_queue_is_503() {
    let g = boot_opts(
        &[("fast", "mock-c1-d0")],
        Options {
            bench_endpoints: true,
            writer_capacity: Some(2),
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    let lock = hold_write_lock(&g.f.path);
    // The writer takes the first request's events into a batch that, after
    // the 200 ms interval, sticks on the lock; the next ones fill its 2-slot
    // queue (and the rest are dropped).
    for i in 0..4 {
        if i == 1 {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        let (s, _, _) = call(
            &g.base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", &auth)],
            r#"{"model":"fast","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await;
        assert_eq!(s, 200);
    }
    let started = std::time::Instant::now();
    let (s, _, b) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s, 503, "{b}");
    assert!(b.contains("\"inconclusive\":true"), "{b}");
    assert!(started.elapsed() < Duration::from_secs(1), "it waited");
    drop(lock);
    stop(g).await;
}

/// `/metrics` exists only with a token, takes exactly `Bearer <token>`, and
/// counts a finished request under TS's series names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metrics_route_is_token_gated_and_records_completions() {
    let port = upstream().await;
    let f = fixture(&["c0"]);
    let c = rusqlite::Connection::open(&f.path).expect("open");
    c.execute(
        "UPDATE credentials SET provider_data=? WHERE id='c0'",
        rusqlite::params![format!(
            "{{\"endpointId\":\"e0\",\"origin\":\"http://127.0.0.1:{port}\",\"protocol\":\"chat_completions\"}}"
        )],
    )
    .expect("origin");
    c.execute(
        "INSERT OR REPLACE INTO virtual_models (id, targets, strategy) VALUES ('m1', ?, 'priority')",
        rusqlite::params![
            "[{\"provider\":\"custom\",\"endpointId\":\"e0\",\"model\":\"mock-c1-d0\",\"tier\":1,\"weight\":1,\
             \"costPerMTok\":{\"input\":1,\"output\":2},\"capabilities\":{\"tools\":true,\"images\":true,\"reasoning\":true}}]"
        ],
    )
    .expect("model");
    drop(c);
    add_key(&f.path, "kp", KEY, "", "");
    let mut env: std::collections::HashMap<String, String> = [
        ("OMNI_ENCRYPTION_KEY", ENC),
        ("OMNI_DB_PATH", f.path.to_str().expect("path")),
        ("OMNI_PORT", "1"),
        ("OMNI_DAY_OFFSET_MINUTES", "0"),
        ("OMNI_METRICS_TOKEN", "tok"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(
        config,
        Options {
            version: "1.2.3".into(),
            ..Options::default()
        },
    )
    .await
    .expect("start");
    let base = format!("127.0.0.1:{}", running.addr.port());

    let (s, h, body) = call(&base, "GET", "/metrics", &[], "").await;
    assert_eq!((s, body.as_str()), (401, ""));
    assert!(!h.iter().any(|(k, _)| k == "content-type"));
    let (s, _, _) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tokx")],
        "",
    )
    .await;
    assert_eq!(s, 401);
    let (s, h, body) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tok")],
        "",
    )
    .await;
    assert_eq!(s, 200);
    assert!(h.contains(&(
        "content-type".into(),
        "text/plain; version=0.0.4; charset=utf-8".into()
    )));
    assert!(
        body.ends_with("omni_build_info{version=\"1.2.3\"} 1\n"),
        "{body}"
    );
    assert!(!body.contains("omni_requests_total"));

    let req = r#"{"model":"m1","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let (s, _, _) = call(
        &base,
        "POST",
        "/v1/chat/completions",
        &[
            ("authorization", &format!("Bearer {KEY}")),
            ("content-type", "application/json"),
        ],
        req,
    )
    .await;
    assert_eq!(s, 200);
    let (_, _, body) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tok")],
        "",
    )
    .await;
    assert!(
        body.contains(
            "omni_requests_total{provider=\"custom\",model=\"mock-c1-d0\",status=\"200\",code=\"\",api_key_id=\"kp\"} 1\n"
        ),
        "{body}"
    );
    assert!(body.contains("omni_upstream_duration_seconds_count{provider=\"custom\"} 1\n"));
    assert!(body.contains("omni_ttft_seconds_count{provider=\"custom\",model=\"mock-c1-d0\"} 1\n"));
    // `localCounts()` is empty once the slot is released, and no scrape set
    // the gauge while it was held: TS registers no `omni_inflight` series.
    assert!(!body.contains("omni_inflight"), "{body}");
    running.shutdown();
    running.wait().await.expect("stop");

    // No token: no route, TS's 404 for an unmatched GET.
    env.remove("OMNI_METRICS_TOKEN");
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(config, Options::default()).await.expect("start");
    let base = format!("127.0.0.1:{}", running.addr.port());
    let (s, _, body) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tok")],
        "",
    )
    .await;
    assert_eq!(s, 404);
    assert_eq!(
        body,
        r#"{"error":{"code":"NOT_FOUND","message":"no route for /metrics"}}"#
    );
    running.shutdown();
    running.wait().await.expect("stop");
}

/// `/api/plugins*` answers the spec's 501 for every method.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_routes_are_unsupported() {
    let g = boot().await;
    for (m, p) in [
        ("GET", "/api/plugins"),
        ("POST", "/api/plugins/x"),
        ("DELETE", "/api/plugins/x/y"),
    ] {
        let (s, _, body) = call(&g.base, m, p, &[], "").await;
        assert_eq!(s, 501, "{m} {p}");
        assert_eq!(
            body,
            r#"{"error":{"code":"UNSUPPORTED","message":"plugins are not supported in this release"}}"#
        );
    }
    let (s, _, _) = call(&g.base, "GET", "/api/pluginsx", &[], "").await;
    assert_eq!(s, 404);
    stop(g).await;
}
