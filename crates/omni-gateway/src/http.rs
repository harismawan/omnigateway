//! Bun's socket budget: writes rearm; inbound traffic must reach 16 KiB/s
//! worth of bytes per idle window. Inference requests disable the budget.
use std::io::{self, IoSlice};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::Instant;

struct Clock {
    origin: Instant,
    last: AtomicU64,
    disabled: AtomicBool,
    idle: Duration,
    request_changed: tokio::sync::Notify,
    received: AtomicU64,
    routed: AtomicBool,
    omit_zero_length: AtomicBool,
}

#[derive(Clone)]
pub(crate) struct Activity(Arc<Clock>);

impl Activity {
    pub(crate) fn omit_zero_length(&self) {
        self.0.omit_zero_length.store(true, Relaxed);
    }
    fn touch(&self) {
        self.0.last.store(
            u64::try_from(self.0.origin.elapsed().as_nanos()).unwrap_or(u64::MAX),
            Relaxed,
        );
    }

    pub(crate) fn request(&self, inference: bool) {
        self.0.routed.store(true, Relaxed);
        // Frozen proxy.ts explicitly calls server.timeout(request, 0) for
        // these three routes, including their JSON and streaming responses.
        self.0.disabled.store(inference, Relaxed);
        self.0.received.store(0, Relaxed);
        self.touch();
        self.0.request_changed.notify_one();
    }

    pub(crate) async fn expired(&self) {
        if self.0.idle.is_zero() {
            std::future::pending::<()>().await;
        }
        let mut deadline = self.0.origin + self.0.idle.min(Duration::from_secs(10));
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => {},
                () = self.0.request_changed.notified() => {},
            }
            if self.0.disabled.load(Relaxed) {
                deadline = Instant::now() + self.0.idle;
                continue;
            }
            let idle = if self.0.routed.load(Relaxed) {
                self.0.idle
            } else {
                self.0.idle.min(Duration::from_secs(10))
            };
            deadline = self.0.origin + Duration::from_nanos(self.0.last.load(Relaxed)) + idle;
            if deadline <= Instant::now() {
                return;
            }
        }
    }
}

pub(crate) struct IdleIo<T> {
    inner: T,
    activity: Activity,
}

impl<T> IdleIo<T> {
    pub(crate) fn new(inner: T, idle: Duration) -> (Self, Activity) {
        let activity = Activity(Arc::new(Clock {
            origin: Instant::now(),
            last: AtomicU64::new(0),
            disabled: AtomicBool::new(false),
            idle,
            request_changed: tokio::sync::Notify::new(),
            received: AtomicU64::new(0),
            routed: AtomicBool::new(false),
            omit_zero_length: AtomicBool::new(false),
        }));
        (
            Self {
                inner,
                activity: activity.clone(),
            },
            activity,
        )
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for IdleIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            let n = (buf.filled().len() - before) as u64;
            let received = self
                .activity
                .0
                .received
                .fetch_add(n, Relaxed)
                .saturating_add(n);
            if u128::from(received)
                >= self.activity.0.idle.as_nanos().saturating_mul(16_384) / 1_000_000_000
            {
                self.activity.0.received.store(0, Relaxed);
                self.activity.touch();
            }
        }
        result
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for IdleIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        // Hyper synthesizes CL:0 even for a close-delimited empty rejection.
        // Its encoded head is contiguous. Only the frozen WebSocket version
        // rejection opts in; preserve partial-write accounting around the line.
        if self.activity.0.omit_zero_length.load(Relaxed) {
            const LINE: &[u8] = b"content-length: 0\r\n";
            if let Some(at) = buf.windows(LINE.len()).position(|w| w == LINE) {
                if at == 0 {
                    self.activity.0.omit_zero_length.store(false, Relaxed);
                    return Poll::Ready(Ok(LINE.len()));
                }
                return match Pin::new(&mut self.inner).poll_write(cx, &buf[..at]) {
                    Poll::Ready(Ok(n)) if n == at => {
                        self.activity.touch();
                        self.activity.0.omit_zero_length.store(false, Relaxed);
                        Poll::Ready(Ok(n + LINE.len()))
                    }
                    result => result,
                };
            }
        }
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            self.activity.touch();
        }
        result
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        if self.activity.0.omit_zero_length.load(Relaxed) {
            return match bufs.iter().find(|b| !b.is_empty()) {
                Some(buf) => self.poll_write(cx, buf),
                None => Poll::Ready(Ok(0)),
            };
        }
        let result = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            self.activity.touch();
        }
        result
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn version_rejection_omits_only_zero_length_across_partial_vectored_writes() {
        let (sock, mut peer) = tokio::io::duplex(3);
        let (mut io, activity) = IdleIo::new(sock, Duration::ZERO);
        activity.omit_zero_length();
        let write = tokio::spawn(async move {
            io.write_all(b"HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\n")
                .await
                .unwrap();
            let line = b"content-length: 0\r\n\r\n";
            let n = io
                .write_vectored(&[IoSlice::new(b""), IoSlice::new(line)])
                .await
                .unwrap();
            io.write_all(&line[n..]).await.unwrap();
            io.shutdown().await.unwrap();
        });
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes).await.unwrap();
        write.await.unwrap();
        assert_eq!(
            bytes,
            b"HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\n\r\n"
        );
    }

    #[test]
    fn normalized_inference_exemptions() {
        for path in [
            "/v1/x/../chat/completions",
            "/v1/x/%2e%2e/messages",
            "/v1/./responses/",
            "/v1\\x\\..\\chat/completions",
        ] {
            let path = crate::server::route_path(path);
            assert!(matches!(
                path.as_ref(),
                "/v1/chat/completions" | "/v1/messages" | "/v1/responses"
            ));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn initial_headers_have_buns_ten_second_budget() {
        let (sock, _peer) = tokio::io::duplex(1);
        let (_, activity) = IdleIo::new(sock, Duration::from_secs(255));
        let start = Instant::now();
        activity.expired().await;
        assert_eq!(start.elapsed(), Duration::from_secs(10));
    }

    #[tokio::test(start_paused = true)]
    async fn trickling_reads_do_not_rearm_timeout() {
        let (sock, mut peer) = tokio::io::duplex(10);
        let (mut io, activity) = IdleIo::new(sock, Duration::from_secs(5));
        let expiry = tokio::spawn(async move { activity.expired().await });
        for _ in 0..2 {
            tokio::time::advance(Duration::from_secs(2)).await;
            peer.write_all(b"x").await.unwrap();
            io.read_u8().await.unwrap();
        }
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(expiry.is_finished());
    }

    #[tokio::test(start_paused = true)]
    async fn inbound_threshold_rearms_window() {
        let (sock, mut peer) = tokio::io::duplex(16_384);
        let (mut io, activity) = IdleIo::new(sock, Duration::from_secs(1));
        let expiry = tokio::spawn(async move { activity.expired().await });
        tokio::time::advance(Duration::from_millis(800)).await;
        peer.write_all(&[0; 16_384]).await.unwrap();
        let mut buf = [0; 16_384];
        io.read_exact(&mut buf).await.unwrap();
        tokio::time::advance(Duration::from_millis(800)).await;
        tokio::task::yield_now().await;
        assert!(!expiry.is_finished());
        tokio::time::advance(Duration::from_millis(200)).await;
        expiry.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn blocked_writer_expires() {
        let (sock, _peer) = tokio::io::duplex(1);
        let (mut io, activity) = IdleIo::new(sock, Duration::from_secs(5));
        io.write_all(b"x").await.unwrap();
        let writer = tokio::spawn(async move { io.write_all(b"more").await });
        activity.expired().await;
        assert!(!writer.is_finished());
        writer.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn idle_reader_expires_and_zero_timeout_is_disabled() {
        let (sock, _peer) = tokio::io::duplex(1);
        let (mut io, activity) = IdleIo::new(sock, Duration::from_secs(5));
        let reader = tokio::spawn(async move { io.read_u8().await });
        activity.expired().await;
        assert!(!reader.is_finished());
        reader.abort();
        let (sock, _peer) = tokio::io::duplex(1);
        let (_, activity) = IdleIo::new(sock, Duration::ZERO);
        let expiry = tokio::spawn(async move { activity.expired().await });
        tokio::time::advance(Duration::from_secs(1000)).await;
        tokio::task::yield_now().await;
        assert!(!expiry.is_finished());
        expiry.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn vectored_partial_write_advances_clock() {
        let (sock, mut peer) = tokio::io::duplex(1);
        let (mut io, activity) = IdleIo::new(sock, Duration::from_secs(5));
        let expiry = tokio::spawn(async move { activity.expired().await });
        tokio::time::advance(Duration::from_secs(4)).await;
        assert_eq!(io.write_vectored(&[IoSlice::new(b"xx")]).await.unwrap(), 1);
        assert_eq!(peer.read_u8().await.unwrap(), b'x');
        tokio::time::advance(Duration::from_secs(4)).await;
        tokio::task::yield_now().await;
        assert!(!expiry.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        expiry.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn connection_timeout_drops_pending_service_work() {
        use std::convert::Infallible;
        use std::sync::atomic::AtomicUsize;

        struct Claim(Arc<AtomicUsize>);
        impl Drop for Claim {
            fn drop(&mut self) {
                self.0.fetch_add(1, Relaxed);
            }
        }

        let dropped = Arc::new(AtomicUsize::new(0));
        let (sock, mut peer) = tokio::io::duplex(1024);
        let (io, activity) = IdleIo::new(sock, Duration::from_secs(5));
        let claims = dropped.clone();
        let service = hyper::service::service_fn(move |_| {
            let claim = Claim(claims.clone());
            async move {
                let _claim = claim;
                std::future::pending::<Result<hyper::Response<crate::server::Body>, Infallible>>()
                    .await
            }
        });
        let task = tokio::spawn(async move {
            let builder = crate::http1_builder(Duration::from_secs(5));
            let conn = builder.serve_connection(hyper_util::rt::TokioIo::new(io), service);
            tokio::select! {
                _ = conn => panic!("connection completed before timeout"),
                () = activity.expired() => {},
            }
        });
        peer.write_all(b"GET /pending HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        task.await.unwrap();
        assert_eq!(dropped.load(Relaxed), 1);
        assert!(peer.read_u8().await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn partial_writes_and_reads_extend_idle() {
        let (sock, mut peer) = tokio::io::duplex(1);
        let (mut io, activity) = IdleIo::new(sock, Duration::from_secs(5));
        let expiry = tokio::spawn(async move { activity.expired().await });
        for _ in 0..3 {
            tokio::time::advance(Duration::from_secs(4)).await;
            assert_eq!(io.write(b"xx").await.unwrap(), 1);
            assert_eq!(peer.read_u8().await.unwrap(), b'x');
            peer.write_all(b"y").await.unwrap();
            assert_eq!(io.read_u8().await.unwrap(), b'y');
            tokio::task::yield_now().await;
            assert!(!expiry.is_finished());
        }
        io.write_all(b"").await.unwrap();
        tokio::time::advance(Duration::from_secs(5)).await;
        expiry.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn inference_exemption_and_next_request() {
        let (sock, _peer) = tokio::io::duplex(1);
        let (_, activity) = IdleIo::new(sock, Duration::from_secs(5));
        activity.request(true);
        let waiter = activity.clone();
        let expiry = tokio::spawn(async move { waiter.expired().await });
        tokio::time::advance(Duration::from_secs(22)).await;
        tokio::task::yield_now().await;
        assert!(!expiry.is_finished());
        activity.request(false);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        tokio::task::yield_now().await;
        assert!(expiry.is_finished());
        expiry.await.unwrap();
    }
}
