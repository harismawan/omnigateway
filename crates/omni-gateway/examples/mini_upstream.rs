//! A minimal keep-alive chat-completions SSE upstream (`mock-c1-d0` only),
//! for telling the gateway's latency tail apart from the Bun upstream's:
//!
//!   target/profiling/examples/mini_upstream 18100
//!
//! One canned reply, written in one `write_all` per request, current-thread
//! runtime, `TCP_NODELAY` set.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BODY: &str = concat!(
    "data: {\"id\":\"chatcmpl-mini\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"mock-c1-d0\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
    "data: {\"id\":\"chatcmpl-mini\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"mock-c1-d0\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lorem ipsum \"}}]}\n\n",
    "data: {\"id\":\"chatcmpl-mini\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"mock-c1-d0\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: {\"id\":\"chatcmpl-mini\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"mock-c1-d0\",\"choices\":[],\"usage\":{\"prompt_tokens\":64,\"completion_tokens\":2,\"total_tokens\":66}}\n\n",
    "data: [DONE]\n\n",
);

/// The end of the request whose head starts `buf`, if all of it is there.
fn request_end(buf: &[u8]) -> Option<usize> {
    let head = buf.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let text = std::str::from_utf8(&buf[..head]).ok()?.to_ascii_lowercase();
    let length = text
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    (buf.len() >= head + length).then_some(head + length)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let port = std::env::args().nth(1).unwrap_or_else(|| "18100".into());
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .expect("bind");
    let reply = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{BODY}",
        BODY.len()
    );
    loop {
        let Ok((mut sock, _)) = listener.accept().await else {
            continue;
        };
        sock.set_nodelay(true).ok();
        let reply = reply.clone();
        tokio::spawn(async move {
            let mut buf = Vec::with_capacity(64 * 1024);
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                while let Some(end) = request_end(&buf) {
                    buf.drain(..end);
                    if sock.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
                match sock.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
        });
    }
}
