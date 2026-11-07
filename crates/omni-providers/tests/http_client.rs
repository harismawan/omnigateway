//! The outbound client against raw TCP listeners: exact request bytes (checked
//! against what the TS `nodeHttpClient` wrote to the same kind of listener, see
//! `httpWire` in `vectors.json`), keep-alive pooling, response framing and
//! cancellation.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use common::vectors;
use omni_providers::http::{Client, HttpClient, HttpError, HttpRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// Reads one whole request (head plus a Content-Length or chunked body).
async fn read_request(sock: &mut TcpStream, buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    loop {
        if let Some(end) = find(buf, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
            let rest = &buf[end + 4..];
            let complete = if head.contains("\r\ntransfer-encoding: chunked")
                || head.contains("\r\ntransfer-encoding: gzip, chunked")
            {
                find(rest, b"0\r\n\r\n").map(|at| end + 4 + at + 5)
            } else {
                let length = head
                    .split("\r\n")
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .map_or(0, |v| v.trim().parse::<usize>().expect("length"));
                (rest.len() >= length).then_some(end + 4 + length)
            };
            if let Some(total) = complete {
                return Some(buf.drain(..total).collect());
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

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A server answering every request with `response`, reporting
/// `(connection number, raw request)` for each.
async fn capture_server(
    response: &'static [u8],
) -> (u16, mpsc::UnboundedReceiver<(usize, Vec<u8>)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut n = 0;
        while let Ok((mut sock, _)) = listener.accept().await {
            n += 1;
            let tx = tx.clone();
            let id = n;
            tokio::spawn(async move {
                let mut buf = Vec::new();
                while let Some(req) = read_request(&mut sock, &mut buf).await {
                    if tx.send((id, req)).is_err() || sock.write_all(response).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (port, rx)
}

fn request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> HttpRequest {
    HttpRequest {
        provider: "custom".into(),
        url: format!("http://127.0.0.1:{port}{path}"),
        method: method.into(),
        headers: headers
            .iter()
            .map(|(n, v)| ((*n).to_string(), (*v).to_string()))
            .collect(),
        body: body.into(),
        body_encoding: None,
        request_id: None,
    }
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

#[tokio::test]
async fn writes_exactly_the_bytes_node_http_wrote_for_every_vector() {
    let (port, mut rx) = capture_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").await;
    let client = Client::new();
    let cases = vectors()["httpWire"].as_array().expect("httpWire");
    assert!(cases.len() >= 15);
    let mut connections = std::collections::BTreeSet::new();
    for case in cases {
        let headers: Vec<(String, String)> = case["headers"]
            .as_array()
            .expect("headers")
            .iter()
            .map(|p| {
                (
                    p[0].as_str().expect("name").to_string(),
                    p[1].as_str().expect("value").to_string(),
                )
            })
            .collect();
        let req = HttpRequest {
            provider: "custom".into(),
            url: format!(
                "http://127.0.0.1:{port}{}",
                case["path"].as_str().expect("path")
            ),
            method: case["method"].as_str().expect("method").into(),
            headers,
            body: case["body"].as_str().expect("body").into(),
            body_encoding: None,
            request_id: None,
        };
        let res = client.send(req).await.expect("send");
        assert_eq!(res.status, 200);
        assert_eq!(res.body.text().await.expect("text"), "{}");
        let (conn, raw) = rx.recv().await.expect("captured");
        connections.insert(conn);
        let expected = case["raw"]
            .as_str()
            .expect("raw")
            .replace("{port}", &port.to_string());
        assert_eq!(latin1(&raw), expected, "{case}");
    }
    // Keep-alive: one connection carries every request up to the one that
    // asked `Connection: close`, and one more carries the rest.
    assert_eq!(connections.len(), 2, "{connections:?}");
}

#[tokio::test]
async fn header_order_and_casing_survive_and_content_length_host_connection_trail() {
    let (port, mut rx) = capture_server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
    let client = Client::new();
    let res = client
        .send(request(
            port,
            "POST",
            "/v1/messages",
            &[
                ("User-Agent", "claude-cli/2.1.296 (external, cli)"),
                ("x-app", "cli"),
                ("X-Stainless-Lang", "js"),
                ("anthropic-version", "2023-06-01"),
            ],
            "{\"a\":1}",
        ))
        .await
        .expect("send");
    assert_eq!(res.status, 200);
    let (_, raw) = rx.recv().await.expect("captured");
    assert_eq!(
        latin1(&raw),
        format!(
            "POST /v1/messages HTTP/1.1\r\nUser-Agent: claude-cli/2.1.296 (external, cli)\r\n\
             x-app: cli\r\nX-Stainless-Lang: js\r\nanthropic-version: 2023-06-01\r\n\
             Content-Length: 7\r\nHost: 127.0.0.1:{port}\r\nConnection: keep-alive\r\n\r\n{{\"a\":1}}"
        )
    );
}

#[tokio::test]
async fn refuses_headers_node_would_refuse_before_connecting() {
    let client = Client::new();
    for (name, value) in [
        ("a b", "x"),
        ("", "x"),
        ("a", "日本"),
        ("a", "x\r\nb: y"),
        ("a", "\u{7f}"),
    ] {
        let err = client
            .send(request(1, "POST", "/", &[(name, value)], ""))
            .await
            .expect_err("refused");
        assert!(matches!(err, HttpError::InvalidHeader { .. }), "{err:?}");
    }
    let err = client
        .send(HttpRequest {
            url: "ftp://h/".into(),
            ..request(1, "POST", "/", &[], "")
        })
        .await
        .expect_err("refused");
    assert!(matches!(err, HttpError::InvalidUrl(_)), "{err:?}");
}

/// A server that sends `responses[i]` on connection `i` after reading one request.
async fn scripted_server(responses: Vec<Vec<u8>>, close_after: bool) -> (u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = accepted.clone();
    tokio::spawn(async move {
        let mut queue = responses.into_iter();
        while let Ok((mut sock, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            let Some(response) = queue.next() else { return };
            tokio::spawn(async move {
                let mut buf = Vec::new();
                if read_request(&mut sock, &mut buf).await.is_some() {
                    sock.write_all(&response).await.ok();
                    if close_after {
                        sock.shutdown().await.ok();
                    } else {
                        // Hold the socket open so a reader that waits for EOF hangs.
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                }
            });
        }
    });
    (port, accepted)
}

async fn body_of(res: omni_providers::http::HttpResponse) -> Result<Vec<u8>, HttpError> {
    let mut body = res.body;
    let mut out = Vec::new();
    while let Some(chunk) = body.next_chunk().await {
        out.extend_from_slice(&chunk?);
    }
    Ok(out)
}

#[tokio::test]
async fn reads_chunked_content_length_and_close_delimited_bodies() {
    let (port, _) = scripted_server(
        vec![
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\n0\r\nX-Trailer: t\r\n\r\n"
                .to_vec(),
            b"HTTP/1.1 201 Created\r\nContent-Length: 5\r\n\r\nhello".to_vec(),
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nclose-delimited".to_vec(),
        ],
        true,
    )
    .await;
    let client = Client::new();
    for (status, want) in [(200, "abc"), (201, "hello"), (200, "close-delimited")] {
        let res = client
            .send(request(port, "POST", "/", &[], "{}"))
            .await
            .expect("send");
        assert_eq!(res.status, status);
        assert_eq!(body_of(res).await.expect("body"), want.as_bytes());
    }
}

#[tokio::test]
async fn response_headers_follow_node_and_fetch_headers_semantics() {
    let (port, _) = scripted_server(
        vec![
            b"HTTP/1.1 429 Too Many\r\nRetry-After: 5\r\nretry-after: 7\r\nX-M: a\r\nx-m:  b \r\n\
              Set-Cookie: c=1\r\nSet-Cookie: d=2\r\nX-L: \xc3\xa9\r\nContent-Length: 0\r\n\r\n"
                .to_vec(),
        ],
        false,
    )
    .await;
    let res = Client::new()
        .send(request(port, "GET", "/", &[], ""))
        .await
        .expect("send");
    assert_eq!(res.status, 429);
    assert_eq!(res.headers.get("Retry-After").as_deref(), Some("5"));
    assert_eq!(res.headers.get("x-m").as_deref(), Some("a, b"));
    assert_eq!(res.headers.get("set-cookie").as_deref(), Some("c=1, d=2"));
    // node decodes header bytes as latin1.
    assert_eq!(res.headers.get("x-l").as_deref(), Some("Ã©"));
    assert_eq!(res.headers.get("absent"), None);
}

#[tokio::test]
async fn a_truncated_body_is_an_error_not_a_short_success() {
    let (port, _) = scripted_server(
        vec![
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc".to_vec(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n".to_vec(),
        ],
        true,
    )
    .await;
    let client = Client::new();
    for _ in 0..2 {
        let res = client
            .send(request(port, "POST", "/", &[], "{}"))
            .await
            .expect("send");
        let err = body_of(res).await.expect_err("truncated");
        assert!(matches!(err, HttpError::BodyAborted), "{err:?}");
    }
}

#[tokio::test]
async fn transport_failures_are_reported() {
    let client = Client::new();
    // Nothing listens on port 1.
    let refused = client
        .send(request(1, "POST", "/", &[], "{}"))
        .await
        .expect_err("refused");
    assert!(matches!(refused, HttpError::Connect(_)), "{refused:?}");
    assert!(refused.is_network());

    let (port, _) = scripted_server(vec![Vec::new()], true).await;
    let hangup = client
        .send(request(port, "POST", "/", &[], "{}"))
        .await
        .expect_err("hang up");
    assert!(matches!(hangup, HttpError::ConnectionClosed), "{hangup:?}");

    let (port, _) = scripted_server(vec![b"garbage\r\n\r\n".to_vec()], true).await;
    let garbage = client
        .send(request(port, "POST", "/", &[], "{}"))
        .await
        .expect_err("garbage");
    assert!(
        matches!(garbage, HttpError::InvalidResponse(_)),
        "{garbage:?}"
    );
    assert!(!garbage.is_network());
}

#[tokio::test]
async fn keep_alive_reuses_one_connection_and_a_dropped_body_closes_it() {
    // A server that answers each request on a connection with a streaming
    // chunked body it never finishes for path /hang, and a whole body otherwise.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(AtomicUsize::new(0));
    let (acc, clo) = (accepted.clone(), closed.clone());
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            acc.fetch_add(1, Ordering::SeqCst);
            let clo = clo.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                while let Some(req) = read_request(&mut sock, &mut buf).await {
                    let hang = req.starts_with(b"POST /hang ");
                    let response: &[u8] = if hang {
                        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n"
                    } else {
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
                    };
                    if sock.write_all(response).await.is_err() {
                        break;
                    }
                    if hang {
                        // Wait for the client to go away.
                        let mut byte = [0u8; 1];
                        while sock.read(&mut byte).await.is_ok_and(|n| n > 0) {}
                        break;
                    }
                }
                clo.fetch_add(1, Ordering::SeqCst);
            });
        }
    });

    let client = Client::new();
    for _ in 0..5 {
        let res = client
            .send(request(port, "POST", "/ok", &[], "{}"))
            .await
            .expect("send");
        assert_eq!(body_of(res).await.expect("body"), b"ok");
    }
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        1,
        "keep-alive reused one connection"
    );
    assert_eq!(client.idle_connections(), 1);

    // Read one chunk of a body that never ends, then drop it: the connection
    // must be closed, never returned to the pool half-read.
    let res = client
        .send(request(port, "POST", "/hang", &[], "{}"))
        .await
        .expect("send");
    let mut body = res.body;
    let first = body.next_chunk().await.expect("chunk").expect("ok");
    assert_eq!(&first[..], b"first");
    assert_eq!(client.idle_connections(), 0);
    drop(body);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while closed.load(Ordering::SeqCst) == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "server never saw the close"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(client.idle_connections(), 0);

    // The next request needs a fresh connection, and works.
    let res = client
        .send(request(port, "POST", "/ok", &[], "{}"))
        .await
        .expect("send");
    assert_eq!(body_of(res).await.expect("body"), b"ok");
    assert_eq!(accepted.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn dropping_the_response_future_closes_the_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, mut rx) = mpsc::unbounded_channel::<&'static str>();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();
        read_request(&mut sock, &mut buf).await.expect("request");
        tx.send("request").expect("send");
        // Never answer; report when the client hangs up.
        let mut byte = [0u8; 1];
        let n = sock.read(&mut byte).await.unwrap_or(0);
        tx.send(if n == 0 { "closed" } else { "data" })
            .expect("send");
    });
    let client = Client::new();
    let pending = client.send(request(port, "POST", "/", &[], "{}"));
    let outcome = tokio::time::timeout(Duration::from_millis(300), pending).await;
    assert!(outcome.is_err(), "the server never answers");
    assert_eq!(rx.recv().await, Some("request"));
    assert_eq!(rx.recv().await, Some("closed"));
    assert_eq!(client.idle_connections(), 0);
}

#[tokio::test]
async fn a_pooled_connection_the_server_closed_is_not_reused() {
    // Answers one request per connection with keep-alive framing, then closes.
    let (port, accepted) = scripted_server(
        vec![
            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\na".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nb".to_vec(),
        ],
        true,
    )
    .await;
    let client = Client::new();
    let res = client
        .send(request(port, "POST", "/", &[], "{}"))
        .await
        .expect("first");
    assert_eq!(body_of(res).await.expect("body"), b"a");
    // Let the server's FIN arrive while the connection sits idle.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let res = client
        .send(request(port, "POST", "/", &[], "{}"))
        .await
        .expect("second");
    assert_eq!(body_of(res).await.expect("body"), b"b");
    assert_eq!(accepted.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn connect_attempt_timeout_is_longer_than_one_tcp_retransmit() {
    const LINUX_INITIAL_RTO_MS: u64 = 1000;
    assert_eq!(
        omni_providers::http::CONNECT_ATTEMPT_TIMEOUT,
        Duration::from_millis(3000)
    );
    assert!(
        omni_providers::http::CONNECT_ATTEMPT_TIMEOUT.as_millis()
            > u128::from(LINUX_INITIAL_RTO_MS)
    );
}

#[tokio::test]
async fn the_trait_object_is_usable() {
    let (port, _) = scripted_server(vec![b"HTTP/1.1 204 No Content\r\n\r\n".to_vec()], false).await;
    let client: Arc<dyn HttpClient> = Arc::new(Client::new());
    let res = client
        .send(request(port, "DELETE", "/", &[], ""))
        .await
        .expect("send");
    assert_eq!(res.status, 204);
    assert_eq!(body_of(res).await.expect("body"), b"");
}

#[tokio::test]
async fn https_goes_through_rustls_and_pools_too() {
    use std::sync::Arc as StdArc;
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).expect("cert");
    let der = cert.cert.der().clone();
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(cert.signing_key.serialize_der().into());
    let provider = StdArc::new(rustls::crypto::ring::default_provider());
    let server_config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_no_client_auth()
        .with_single_cert(vec![der.clone()], key)
        .expect("server config");
    let acceptor = tokio_rustls::TlsAcceptor::from(StdArc::new(server_config));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let counter = accepted.clone();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            let acceptor = acceptor.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(sock).await else {
                    return;
                };
                let mut buf = Vec::new();
                loop {
                    let end = loop {
                        if let Some(end) = find(&buf, b"\r\n\r\n") {
                            break end;
                        }
                        let mut chunk = [0u8; 4096];
                        match tls.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    };
                    let req: Vec<u8> = buf.drain(..end + 4).collect();
                    tx.send(req).ok();
                    if tls
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecure")
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    let mut roots = rustls::RootCertStore::empty();
    roots.add(der).expect("root");
    let client = Client::with_roots(roots);
    for _ in 0..3 {
        let res = client
            .send(HttpRequest {
                provider: "custom".into(),
                url: format!("https://localhost:{port}/v1/x"),
                method: "GET".into(),
                headers: vec![("X-K".into(), "v".into())],
                body: String::new(),
                body_encoding: None,
                request_id: None,
            })
            .await
            .expect("tls send");
        assert_eq!(body_of(res).await.expect("body"), b"secure");
        let raw = rx.recv().await.expect("request");
        assert_eq!(
            latin1(&raw),
            format!(
                "GET /v1/x HTTP/1.1\r\nX-K: v\r\nHost: localhost:{port}\r\nConnection: keep-alive\r\n\r\n"
            )
        );
    }
    assert_eq!(accepted.load(Ordering::SeqCst), 1);

    // An untrusted certificate is refused, and is not a network error.
    let err = Client::with_roots(rustls::RootCertStore::empty())
        .send(HttpRequest {
            provider: "custom".into(),
            url: format!("https://localhost:{port}/"),
            method: "GET".into(),
            headers: vec![],
            body: String::new(),
            body_encoding: None,
            request_id: None,
        })
        .await
        .expect_err("untrusted");
    assert!(matches!(err, HttpError::Tls(_)), "{err:?}");
}

#[tokio::test]
async fn a_request_the_server_received_is_never_resent() {
    // Connection 1 answers one request, then reads the next and closes without
    // answering — the keep-alive race. The request may have been acted on, so
    // it is reported (as node reports "socket hang up"), not silently resent.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = accepted.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
            tokio::spawn(async move {
                let mut buf = Vec::new();
                while read_request(&mut sock, &mut buf).await.is_some() {
                    if n == 1 && !buf.is_empty() {
                        return;
                    }
                    if sock
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx")
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if n == 1 {
                        // Read the second request, then hang up on it.
                        read_request(&mut sock, &mut buf).await;
                        return;
                    }
                }
            });
        }
    });
    let client = Client::new();
    let res = client
        .send(request(port, "POST", "/", &[], "{}"))
        .await
        .expect("send");
    assert_eq!(body_of(res).await.expect("body"), b"x");
    let err = client
        .send(request(port, "POST", "/", &[], "{}"))
        .await
        .expect_err("hang up");
    assert!(matches!(err, HttpError::ConnectionClosed), "{err:?}");
    assert!(err.is_network());
    assert_eq!(accepted.load(Ordering::SeqCst), 1);
    // The next request opens a fresh connection and works.
    let res = client
        .send(request(port, "POST", "/", &[], "{}"))
        .await
        .expect("send");
    assert_eq!(body_of(res).await.expect("body"), b"x");
    assert_eq!(accepted.load(Ordering::SeqCst), 2);
}
