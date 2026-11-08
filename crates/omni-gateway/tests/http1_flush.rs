//! The bench hang: a chunked response whose terminating `0\r\n\r\n` was left
//! in hyper's write buffer, unflushed, for good.
//!
//! hyper 1.10's `poll_loop` re-polls the write side once more when the body
//! can still be written (#3988). If the body ends on that second poll,
//! `end_body()` buffers the terminator, the write then pends on the next
//! message, and the loop returns without flushing. Nothing wakes the
//! connection again (it waits on reads, and a keep-alive client is waiting for
//! the end of this response before it sends its next request), so the client
//! waits forever. Fixed upstream in hyper 1.11.1 (#4143).
//!
//! In the gateway, an SSE body that has just sent a frame, is polled once more
//! while the upstream's last bytes are in flight (Pending), and then ends on the
//! next poll is exactly this interleaving. Under `oha -c 64` at ~25k req/s it
//! happened about once per million responses: each time one client stopped for
//! good, and `oha -z … -w` waits for every in-flight request, so the bench
//! hung. This drives the interleaving deterministically through the gateway's
//! own server configuration.

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use hyper::body::{Body, Frame};
use hyper::{Response, service::service_fn};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One data frame, then `Pending` once (no wake-up arranged: the readiness
/// change happens between hyper's two write polls of one loop turn), then the
/// end of the stream.
#[derive(Default)]
struct PendOnceThenEnd {
    polls: u8,
}

impl Body for PendOnceThenEnd {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.polls += 1;
        match self.polls {
            1 => Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(b"data: x\n\n"))))),
            2 => Poll::Pending,
            _ => Poll::Ready(None),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_that_ends_between_two_write_polls_still_gets_its_terminator() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.expect("accept");
        let service = service_fn(|_req| async {
            Ok::<_, Infallible>(Response::new(PendOnceThenEnd::default()))
        });
        let builder = omni_gateway::http1_builder(omni_gateway::IDLE_TIMEOUT);
        // The connection's own outcome is not what is under test.
        builder
            .serve_connection(TokioIo::new(sock), service)
            .await
            .ok();
    });

    let mut client = TcpStream::connect(addr).await.expect("connect");
    client
        .write_all(b"POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\n\r\n")
        .await
        .expect("write");
    let mut got = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), async {
        let mut buf = [0u8; 512];
        loop {
            let n = client.read(&mut buf).await.expect("read");
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buf[..n]);
            if got.ends_with(b"\r\n0\r\n\r\n") {
                break;
            }
        }
    })
    .await;
    let text = String::from_utf8_lossy(&got);
    assert!(
        read.is_ok() && text.ends_with("\r\n0\r\n\r\n"),
        "the response never completed (terminator stranded in hyper's write buffer): {text:?}"
    );
}
