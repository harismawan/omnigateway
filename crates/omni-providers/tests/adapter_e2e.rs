//! The custom adapter over the real client against a local SSE server: the
//! benchmark's shape (plain http to 127.0.0.1), incremental decoding,
//! keep-alive after `[DONE]`, and cancellation by dropping the stream.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use omni_ir::request::ChatRequest;
use omni_ir::stream::{Delta, StreamEvent};
use omni_providers::adapter::{AdapterRequest, SendError, send};
use omni_providers::codec::Credentials;
use omni_providers::custom::CustomCodec;
use omni_providers::http::Client;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc};

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

async fn read_request(sock: &mut TcpStream, buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    loop {
        if let Some(end) = find(buf, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
            let length = head
                .split("\r\n")
                .find_map(|l| l.strip_prefix("content-length: "))
                .map_or(0, |v| v.trim().parse::<usize>().expect("length"));
            if buf.len() >= end + 4 + length {
                return Some(buf.drain(..end + 4 + length).collect());
            }
        }
        let mut chunk = [0u8; 8192];
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn chunk(data: &str) -> Vec<u8> {
    format!("{:x}\r\n{data}\r\n", data.len()).into_bytes()
}

fn request() -> ChatRequest {
    serde_json::from_value(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": false
    }))
    .expect("request")
}

fn creds(port: u16) -> Credentials {
    Credentials {
        access_token: None,
        api_key: Some("sk-test".into()),
        provider_data:
            json!({"origin": format!("http://127.0.0.1:{port}"), "protocol": "chat_completions"})
                .as_object()
                .expect("object")
                .clone(),
    }
}

#[tokio::test]
#[allow(clippy::unwrap_used)]
async fn responses_coerced_arguments_streamed_and_buffered() {
    for buffered in [false, true] {
        for string in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket, &mut Vec::new()).await.unwrap();
                let deltas = if string {
                    vec![json!(["\""]), json!("[".repeat(40001)), json!("\"")]
                } else {
                    vec![
                        json!(["[".repeat(40001)]),
                        json!("0"),
                        json!(["]".repeat(40001)]),
                    ]
                };
                let mut wire = String::from(
                    "event: response.output_item.added\ndata: {\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c\",\"name\":\"f\"}}\n\n",
                );
                for delta in deltas {
                    wire.push_str(&format!(
                        "event: response.function_call_arguments.delta\ndata: {}\n\n",
                        json!({"output_index":0,"delta":delta})
                    ));
                }
                wire.push_str("event: response.completed\ndata: {\"response\":{\"status\":\"completed\"}}\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{wire}",wire.len()).as_bytes()).await.unwrap();
            });
            let client = Client::new();
            let req = request();
            let mut credentials = creds(port);
            credentials
                .provider_data
                .insert("protocol".into(), "responses".into());
            let mut result = send(
                &CustomCodec,
                "custom",
                AdapterRequest::new(&req, "m", &credentials),
                &client,
            )
            .await
            .unwrap();
            let mut events = Vec::new();
            let mut raw = String::new();
            let mut failed = false;
            while let Some(event) = result.events.next().await {
                match event {
                    Ok(e) => {
                        if let StreamEvent::BlockDelta {
                            delta: Delta::ToolJson { partial },
                            ..
                        } = &e
                        {
                            raw.push_str(partial.as_utf8().expect("fixture arguments"));
                        }
                        events.push(e);
                    }
                    Err(e) => {
                        assert!(e.message.contains("depth 40000"));
                        failed = true;
                        break;
                    }
                }
            }
            assert_eq!(failed, !string);
            if string {
                assert_eq!(
                    serde_json::from_str::<String>(&raw).unwrap(),
                    "[".repeat(40001)
                );
                if buffered {
                    let response = omni_ir::stream::try_collect(events).unwrap();
                    let rendered = omni_dialects::egress::anthropic::response(&response, "r");
                    assert!(omni_ir::jsjson::to_string(&rendered).contains(&"[".repeat(40001)));
                }
            } else {
                assert!(raw.is_empty(), "overflowing fragment escaped");
            }
            server.await.unwrap();
        }
    }
}

/// Real transport ownership: both explicit policy errors and downstream
/// cancellation close the unread socket, even after content has committed.
#[tokio::test]
async fn policy_overflow_and_cancellation_close_upstream_after_content() {
    for responses in [false, true] {
        for mode in ["identities", "depth", "cancel"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let port = listener.local_addr().expect("address").port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.expect("accept");
                read_request(&mut socket, &mut Vec::new())
                    .await
                    .expect("request");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.expect("head");
                let record = |i: usize, part: &str| {
                    if responses {
                        format!(
                            "event: response.function_call_arguments.delta\ndata: {}\n\n",
                            json!({"output_index":i,"delta":part})
                        )
                    } else {
                        format!(
                            "data: {}\n\n",
                            json!({"choices":[{"delta":{"tool_calls":[{"index":i,"function":{"arguments":part}}]}}]})
                        )
                    }
                };
                let count = if mode == "identities" { 4097 } else { 1 };
                for i in 0..count {
                    if socket.write_all(&chunk(&record(i, " "))).await.is_err() {
                        break;
                    }
                }
                if mode == "depth" {
                    socket
                        .write_all(&chunk(&record(0, &"[".repeat(40_001))))
                        .await
                        .ok();
                }
                let mut byte = [0];
                let eof = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
                    .await
                    .expect("upstream released without terminal marker");
                assert!(
                    matches!(eof, Ok(0) | Err(_)),
                    "unread connection not closed"
                );
            });
            let client = Client::new();
            let request = request();
            let mut credentials = creds(port);
            if responses {
                credentials
                    .provider_data
                    .insert("protocol".into(), "responses".into());
            }
            let mut result = send(
                &CustomCodec,
                "custom",
                AdapterRequest::new(&request, "m", &credentials),
                &client,
            )
            .await
            .expect("send");
            let mut emitted = 0;
            loop {
                match tokio::time::timeout(Duration::from_secs(5), result.events.next())
                    .await
                    .expect("bounded next")
                {
                    Some(Ok(_)) => {
                        emitted += 1;
                        if mode == "cancel" {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        assert!(emitted > 0, "postcommit");
                        assert_eq!(e.code, omni_ir::error::ErrorCode::Upstream);
                        assert!(e.message.contains(if mode == "depth" {
                            "depth 40000"
                        } else {
                            "identity budget"
                        }));
                        break;
                    }
                    None => panic!("policy failure must not disappear"),
                }
            }
            drop(result);
            server.await.expect("server closure observed");
        }
    }
}

#[tokio::test]
async fn accepted_deep_adapter_arguments_collect_render_and_release() {
    for responses in [false, true] {
        let raw = format!("{}0{}", "[".repeat(40_000), "]".repeat(40_000));
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let input = raw.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            read_request(&mut socket, &mut Vec::new())
                .await
                .expect("request");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await
                .expect("head");
            if responses {
                socket.write_all(&chunk("event: response.output_item.added\ndata: {\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c\",\"name\":\"f\"}}\n\n")).await.expect("start");
            }
            for part in input.as_bytes().chunks(997) {
                let part = std::str::from_utf8(part).expect("ASCII");
                let record = if responses {
                    format!(
                        "event: response.function_call_arguments.delta\ndata: {}\n\n",
                        json!({"output_index":0,"delta":part})
                    )
                } else {
                    format!(
                        "data: {}\n\n",
                        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":part}}]}}]})
                    )
                };
                socket.write_all(&chunk(&record)).await.expect("fragment");
            }
            let done = if responses {
                "event: response.completed\ndata: {\"response\":{\"status\":\"completed\"}}\n\n"
            } else {
                "data: [DONE]\n\n"
            };
            socket.write_all(&chunk(done)).await.expect("done");
            socket.write_all(b"0\r\n\r\n").await.expect("body end");
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
                    .await
                    .expect("release")
                    .expect("read"),
                0
            );
        });
        let client = Client::new();
        let req = request();
        let mut credentials = creds(port);
        if responses {
            credentials
                .provider_data
                .insert("protocol".into(), "responses".into());
        }
        let mut result = send(
            &CustomCodec,
            "custom",
            AdapterRequest::new(&req, "m", &credentials),
            &client,
        )
        .await
        .expect("send");
        let mut events = Vec::new();
        while let Some(e) = result.events.next().await {
            events.push(e.expect("event"));
        }
        let response = omni_ir::stream::try_collect(events).expect("collect");
        let copy = response.clone();
        let rendered = omni_dialects::egress::anthropic::response(&copy, "r");
        assert!(omni_ir::jsjson::to_string(&rendered).contains(&raw));
        drop((rendered, copy, response, result, client));
        server.await.expect("upstream released");
    }
}

#[tokio::test]
async fn streams_incrementally_and_reuses_the_connection_after_done() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (acc, rel) = (accepted.clone(), release.clone());
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            acc.fetch_add(1, Ordering::SeqCst);
            let rel = rel.clone();
            let req_tx = req_tx.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                while let Some(req) = read_request(&mut sock, &mut buf).await {
                    req_tx.send(req).ok();
                    let mut out = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
                    out.extend(chunk("data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n"));
                    if sock.write_all(&out).await.is_err() {
                        return;
                    }
                    // The rest waits until the test has seen the first delta.
                    rel.notified().await;
                    let mut rest = chunk(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n",
                    );
                    rest.extend(chunk("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n"));
                    rest.extend(b"0\r\n\r\n");
                    if sock.write_all(&rest).await.is_err() {
                        return;
                    }
                }
            });
        }
    });

    let client = Client::new();
    let request = request();
    let creds = creds(port);
    for round in 0..3 {
        let mut result = send(
            &CustomCodec,
            "custom",
            AdapterRequest::new(&request, "m1", &creds),
            &client,
        )
        .await
        .expect("send");
        assert!(result.degradations.is_empty());

        let raw = req_rx.recv().await.expect("request");
        let raw = String::from_utf8(raw).expect("utf8");
        assert_eq!(
            raw,
            format!(
                "POST /v1/chat/completions HTTP/1.1\r\nContent-Type: application/json\r\n\
                 Authorization: Bearer sk-test\r\nContent-Length: 112\r\nHost: 127.0.0.1:{port}\r\n\
                 Connection: keep-alive\r\n\r\n\
                 {{\"model\":\"m1\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}],\"stream\":true,\"stream_options\":{{\"include_usage\":true}}}}"
            ),
            "round {round}"
        );

        // Two events arrive before the server has sent the rest: incremental.
        let first = result.events.next().await.expect("start").expect("ok");
        assert_eq!(first.to_json(), r#"{"type":"start","id":"c1","model":"m"}"#);
        assert!(matches!(
            result.events.next().await,
            Some(Ok(StreamEvent::BlockStart { index: 0, .. }))
        ));
        let delta = result.events.next().await.expect("delta").expect("ok");
        assert!(
            matches!(delta, StreamEvent::BlockDelta { delta: Delta::Text { ref text }, .. } if text == "Hel")
        );
        release.notify_one();

        let mut rest = Vec::new();
        while let Some(ev) = result.events.next().await {
            rest.push(ev.expect("event").to_json());
        }
        assert_eq!(
            rest,
            [
                r#"{"type":"blockDelta","index":0,"delta":{"type":"text","text":"lo"}}"#,
                r#"{"type":"blockEnd","index":0}"#,
                r#"{"type":"end","stopReason":"endTurn","usage":{"inputTokens":9,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0}}"#,
            ]
        );
    }
    // `[DONE]` and the terminating chunk arrive together, so stopping at
    // `[DONE]` still leaves the connection reusable.
    assert_eq!(accepted.load(Ordering::SeqCst), 1);
    assert_eq!(client.idle_connections(), 1);
}

#[tokio::test]
async fn dropping_the_event_stream_closes_the_upstream_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, mut rx) = mpsc::unbounded_channel::<&'static str>();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();
        read_request(&mut sock, &mut buf).await.expect("request");
        let mut out = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        out.extend(chunk(
            "data: {\"id\":\"c\",\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n",
        ));
        sock.write_all(&out).await.expect("write");
        let mut byte = [0u8; 1];
        let n = sock.read(&mut byte).await.unwrap_or(0);
        tx.send(if n == 0 { "closed" } else { "data" })
            .expect("send");
    });
    let client = Client::new();
    let request = request();
    let creds = creds(port);
    let mut result = send(
        &CustomCodec,
        "custom",
        AdapterRequest::new(&request, "m1", &creds),
        &client,
    )
    .await
    .expect("send");
    assert!(result.events.next().await.is_some());
    drop(result);
    let closed = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("server saw the close");
    assert_eq!(closed, Some("closed"));
    assert_eq!(client.idle_connections(), 0);
}

#[tokio::test]
async fn an_upstream_error_status_is_classified_and_a_dead_port_is_network() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();
        read_request(&mut sock, &mut buf).await.expect("request");
        let body = r#"{"error":{"message":"slow down"}}"#;
        let head = format!(
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(head.as_bytes()).await.expect("write");
    });
    let client = Client::new();
    let request = request();
    let live = creds(port);
    let err = send(
        &CustomCodec,
        "custom",
        AdapterRequest::new(&request, "m1", &live),
        &client,
    )
    .await
    .expect_err("429");
    let SendError::Gateway(e) = err else {
        panic!("expected a classified error, got {err:?}");
    };
    assert_eq!(e.code.as_str(), "RATE_LIMIT");
    assert_eq!(e.message, "slow down");
    assert_eq!(e.upstream_status, Some(429));
    assert_eq!(e.retry_after_ms, Some(3000.0));
    assert_eq!(e.provider.as_deref(), Some("custom"));

    let dead = creds(1);
    let err = send(
        &CustomCodec,
        "custom",
        AdapterRequest::new(&request, "m1", &dead),
        &client,
    )
    .await
    .expect_err("refused");
    assert_eq!(err.code().as_str(), "NETWORK");
}
