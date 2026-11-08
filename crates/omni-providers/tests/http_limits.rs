//! Client hardening: the response-head cap, when a failed exchange on a
//! pooled connection may be replayed, and pool retention bounds.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use omni_providers::http::{Client, HttpError, HttpRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn request(port: u16, body: &str) -> HttpRequest {
    HttpRequest {
        provider: "custom".into(),
        url: format!("http://127.0.0.1:{port}/"),
        method: "POST".into(),
        headers: vec![],
        body: body.into(),
        body_encoding: None,
        request_id: None,
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Reads one request with a Content-Length body; `None` at EOF or error.
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
        let mut chunk = [0u8; 65536];
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// A response head of exactly `total` bytes, terminating CRLFs included.
fn head_of(total: usize) -> Vec<u8> {
    let start = "HTTP/1.1 200 OK\r\nX-Pad: ";
    let end = "\r\nContent-Length: 2\r\n\r\n";
    let pad = total - start.len() - end.len();
    format!("{start}{}{end}", "a".repeat(pad)).into_bytes()
}

/// Answers one request with `response` written in a single `write_all`.
async fn one_shot(response: Vec<u8>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();
        if read_request(&mut sock, &mut buf).await.is_some() {
            sock.write_all(&response).await.ok();
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    port
}

async fn send_head(total: usize) -> Result<u16, HttpError> {
    let mut response = head_of(total);
    response.extend_from_slice(b"ok");
    let port = one_shot(response).await;
    Client::new()
        .send(request(port, "{}"))
        .await
        .map(|r| r.status)
}

#[tokio::test]
async fn a_head_of_exactly_16_kib_is_accepted() {
    assert_eq!(send_head(16 * 1024).await.expect("accepted"), 200);
}

#[tokio::test]
async fn a_complete_head_over_16_kib_in_one_read_is_refused() {
    // The terminating CRLF arrives in the same read that crosses the cap, so
    // the head parses complete: the cap must apply to its parsed length.
    for total in [16 * 1024 + 1, 16 * 1024 + 2, 16 * 1024 + 4, 20 * 1024] {
        let err = send_head(total).await.expect_err("too large");
        assert!(
            matches!(&err, HttpError::InvalidResponse(m) if m == "header overflow"),
            "{total}: {err:?}"
        );
    }
}

#[tokio::test]
async fn an_unterminated_head_over_16_kib_is_refused_without_waiting() {
    let mut response = b"HTTP/1.1 200 OK\r\nX-Pad: ".to_vec();
    response.extend(std::iter::repeat_n(b'a', 17 * 1024));
    let port = one_shot(response).await;
    let err = tokio::time::timeout(
        Duration::from_secs(2),
        Client::new().send(request(port, "{}")),
    )
    .await
    .expect("does not wait for more")
    .expect_err("too large");
    assert!(
        matches!(&err, HttpError::InvalidResponse(m) if m == "header overflow"),
        "{err:?}"
    );
}

/// Connection 1 answers one request, then on the next reads `partial` bytes
/// and resets (SO_LINGER 0). Counts requests that reached any connection.
async fn reads_part_then_resets(partial: usize) -> (u16, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(AtomicUsize::new(0));
    let (acc, seen) = (accepted.clone(), started.clone());
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let n = acc.fetch_add(1, Ordering::SeqCst) + 1;
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                if read_request(&mut sock, &mut buf).await.is_none() {
                    return;
                }
                seen.fetch_add(1, Ordering::SeqCst);
                sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx")
                    .await
                    .ok();
                if n != 1 {
                    return;
                }
                // The second request: read a prefix of it, then reset.
                let mut got = buf.len();
                let mut chunk = [0u8; 4096];
                while got < partial {
                    match sock.read(&mut chunk[..(partial - got).min(4096)]).await {
                        Ok(0) | Err(_) => return,
                        Ok(k) => got += k,
                    }
                }
                seen.fetch_add(1, Ordering::SeqCst);
                sock.set_zero_linger().ok();
                drop(sock);
            });
        }
    });
    (port, accepted, started)
}

#[tokio::test]
async fn a_request_partly_read_then_reset_is_never_replayed() {
    let (port, accepted, started) = reads_part_then_resets(64).await;
    let client = Client::new();
    let res = client.send(request(port, "{}")).await.expect("first");
    assert_eq!(res.body.text().await.expect("body"), "x");
    // Big enough that the reset lands while it is still being written.
    let big = "y".repeat(8 * 1024 * 1024);
    let err = client
        .send(request(port, &big))
        .await
        .expect_err("reset mid-request");
    assert!(err.is_network(), "{err:?}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(accepted.load(Ordering::SeqCst), 1, "no second connection");
    assert_eq!(
        started.load(Ordering::SeqCst),
        2,
        "exactly one request observed"
    );
}

#[tokio::test]
async fn a_pooled_connection_closed_while_idle_is_replaced_transparently() {
    // Each connection answers one request, then the server closes it.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let acc = accepted.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            acc.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buf = Vec::new();
                if read_request(&mut sock, &mut buf).await.is_some() {
                    sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx")
                        .await
                        .ok();
                    sock.shutdown().await.ok();
                }
            });
        }
    });
    let client = Client::new();
    for _ in 0..3 {
        let res = client.send(request(port, "{}")).await.expect("send");
        assert_eq!(res.body.text().await.expect("body"), "x");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(accepted.load(Ordering::SeqCst), 3);
}
