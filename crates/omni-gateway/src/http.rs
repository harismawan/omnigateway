//! Connection-level inactivity: only actual socket I/O advances the clock.
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
}

#[derive(Clone)]
pub(crate) struct Activity(Arc<Clock>);

impl Activity {
    fn touch(&self) {
        self.0.last.store(
            u64::try_from(self.0.origin.elapsed().as_nanos()).unwrap_or(u64::MAX),
            Relaxed,
        );
    }

    pub(crate) fn request(&self, inference: bool) {
        // Frozen proxy.ts explicitly calls server.timeout(request, 0) for
        // these three routes, including their JSON and streaming responses.
        self.0.disabled.store(inference, Relaxed);
        self.touch();
    }

    pub(crate) async fn expired(&self) {
        if self.0.idle.is_zero() {
            std::future::pending::<()>().await;
        }
        let mut deadline = self.0.origin + self.0.idle;
        loop {
            tokio::time::sleep_until(deadline).await;
            if self.0.disabled.load(Relaxed) {
                deadline = Instant::now() + self.0.idle;
                continue;
            }
            deadline =
                self.0.origin + Duration::from_nanos(self.0.last.load(Relaxed)) + self.0.idle;
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
            self.activity.touch();
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
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
        tokio::time::advance(Duration::from_secs(20)).await;
        tokio::task::yield_now().await;
        assert!(!expiry.is_finished());
        activity.request(false);
        tokio::time::advance(Duration::from_secs(5)).await;
        expiry.await.unwrap();
    }
}
