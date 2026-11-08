//! Connections: connect (with per-address attempt timeouts), TLS, and the
//! keep-alive pool.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::Instant;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use super::{CONNECT_ATTEMPT_TIMEOUT, HttpError, Scheme, Target};

/// How many idle connections the pool keeps, and for how long.
///
/// Every bound is enforced on its own: the global cap and the per-destination
/// cap on each return (the oldest idle connection is closed to make room), and
/// expiry by an owned reaper task as well as by a sweep on every checkout and
/// return, so an origin that is never visited again still has its sockets
/// closed. A destination with no idle connection left has no entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolLimits {
    /// Idle connections across every destination.
    pub max_idle: usize,
    /// Idle connections per destination (node's global agent keeps 256).
    pub max_idle_per_destination: usize,
    /// An idle connection older than this is closed rather than reused.
    pub idle_timeout: Duration,
}

impl Default for PoolLimits {
    fn default() -> Self {
        PoolLimits {
            max_idle: 256,
            max_idle_per_destination: 256,
            idle_timeout: Duration::from_secs(90),
        }
    }
}

/// One transport connection. Dropping it closes the socket.
#[derive(Debug)]
pub(crate) enum Conn {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for Conn {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Conn::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Conn {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Conn::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Conn::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Plain(s) => Pin::new(s).poll_flush(cx),
            Conn::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Conn::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

impl Conn {
    /// Whether an idle connection can carry another request: the peer has not
    /// closed it and has sent nothing unsolicited. Never blocks.
    fn still_idle(&mut self) -> bool {
        let mut cx = Context::from_waker(Waker::noop());
        let mut byte = [0u8; 1];
        let mut buf = ReadBuf::new(&mut byte);
        // Ready means EOF, stray bytes, or an error: none of them is reusable.
        Pin::new(self).poll_read(&mut cx, &mut buf).is_pending()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    scheme: Scheme,
    host: String,
    port: u16,
}

impl Key {
    pub fn of(target: &Target) -> Key {
        Key {
            scheme: target.scheme,
            host: target.host.clone(),
            port: target.port,
        }
    }
}

pub(crate) struct Pool {
    /// Per destination, oldest first.
    idle: Mutex<HashMap<Key, VecDeque<(Conn, Instant)>>>,
    limits: PoolLimits,
    /// The expiry task, started by the first return inside a runtime. It
    /// holds only a `Weak` to the pool and is aborted when the pool drops.
    reaper: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Built on first TLS use; the platform root store is read once.
    tls: OnceLock<TlsConnector>,
    roots: Option<rustls::RootCertStore>,
}

impl std::fmt::Debug for Pool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pool")
            .field("idle", &self.idle_count())
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        if let Ok(mut reaper) = self.reaper.lock()
            && let Some(task) = reaper.take()
        {
            task.abort();
        }
    }
}

impl Pool {
    pub fn new(roots: Option<rustls::RootCertStore>, limits: PoolLimits) -> Pool {
        Pool {
            idle: Mutex::new(HashMap::new()),
            limits,
            reaper: Mutex::new(None),
            tls: OnceLock::new(),
            roots,
        }
    }

    pub fn idle_count(&self) -> usize {
        self.idle
            .lock()
            .map_or(0, |idle| idle.values().map(VecDeque::len).sum())
    }

    /// Destinations with at least one idle connection.
    #[cfg(test)]
    fn destinations(&self) -> usize {
        self.idle.lock().map_or(0, |idle| idle.len())
    }

    #[cfg(test)]
    fn reaper_handle(&self) -> Option<tokio::task::AbortHandle> {
        self.reaper
            .lock()
            .ok()?
            .as_ref()
            .map(tokio::task::JoinHandle::abort_handle)
    }

    /// Closes every expired idle connection, across all destinations, and
    /// removes destinations left empty.
    fn sweep(idle: &mut HashMap<Key, VecDeque<(Conn, Instant)>>, timeout: Duration) {
        idle.retain(|_, list| {
            // Oldest first: expired connections are a prefix.
            while list
                .front()
                .is_some_and(|(_, since)| since.elapsed() >= timeout)
            {
                list.pop_front();
            }
            !list.is_empty()
        });
    }

    /// Closes expired idle connections now (what the reaper runs).
    fn expire(&self) {
        if let Ok(mut idle) = self.idle.lock() {
            Self::sweep(&mut idle, self.limits.idle_timeout);
        }
    }

    /// The most recently returned live connection for `key`, if any.
    pub fn checkout(&self, key: &Key) -> Option<Conn> {
        let mut idle = self.idle.lock().ok()?;
        Self::sweep(&mut idle, self.limits.idle_timeout);
        let list = idle.get_mut(key)?;
        let mut found = None;
        while let Some((mut conn, _)) = list.pop_back() {
            if conn.still_idle() {
                found = Some(conn);
                break;
            }
        }
        if list.is_empty() {
            idle.remove(key);
        }
        found
    }

    /// Returns a connection whose last response was read cleanly to its end.
    pub fn checkin(&self, key: Key, conn: Conn) {
        let Ok(mut idle) = self.idle.lock() else {
            return;
        };
        Self::sweep(&mut idle, self.limits.idle_timeout);
        if self.limits.max_idle == 0 || self.limits.max_idle_per_destination == 0 {
            return;
        }
        let list = idle.entry(key).or_default();
        while list.len() >= self.limits.max_idle_per_destination {
            list.pop_front();
        }
        list.push_back((conn, Instant::now()));
        let mut total: usize = idle.values().map(VecDeque::len).sum();
        while total > self.limits.max_idle {
            // Close the oldest idle connection of any destination.
            let oldest = idle
                .iter()
                .filter_map(|(k, list)| list.front().map(|(_, since)| (k.clone(), *since)))
                .min_by_key(|(_, since)| *since)
                .map(|(k, _)| k);
            let Some(oldest) = oldest else { break };
            if let Some(list) = idle.get_mut(&oldest) {
                list.pop_front();
                if list.is_empty() {
                    idle.remove(&oldest);
                }
            }
            total -= 1;
        }
    }

    /// [`checkin`](Self::checkin), starting the reaper if it is not running.
    pub fn checkin_owned(pool: &Arc<Pool>, key: Key, conn: Conn) {
        pool.checkin(key, conn);
        Self::ensure_reaper(pool);
    }

    fn ensure_reaper(pool: &Arc<Pool>) {
        let Ok(mut reaper) = pool.reaper.lock() else {
            return;
        };
        if reaper.as_ref().is_some_and(|t| !t.is_finished()) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let weak = Arc::downgrade(pool);
        // A quarter of the timeout: a connection outlives its expiry by at
        // most that much even if nothing else touches the pool.
        let period = (pool.limits.idle_timeout / 4).max(Duration::from_millis(100));
        *reaper = Some(runtime.spawn(async move {
            loop {
                tokio::time::sleep(period).await;
                let Some(pool) = weak.upgrade() else { return };
                pool.expire();
            }
        }));
    }

    pub async fn connect(&self, target: &Target) -> Result<Conn, HttpError> {
        let tcp = connect_tcp(&target.host, target.port).await?;
        match target.scheme {
            Scheme::Http => Ok(Conn::Plain(tcp)),
            Scheme::Https => {
                let connector = self.tls.get_or_init(|| tls_connector(self.roots.clone()));
                let name = rustls::pki_types::ServerName::try_from(target.host.clone())
                    .map_err(|e| HttpError::Tls(io::Error::new(io::ErrorKind::InvalidInput, e)))?;
                let tls = connector.connect(name, tcp).await.map_err(HttpError::Tls)?;
                Ok(Conn::Tls(Box::new(tls)))
            }
        }
    }
}

fn tls_connector(roots: Option<rustls::RootCertStore>) -> TlsConnector {
    let roots = roots.unwrap_or_else(|| {
        let mut store = rustls::RootCertStore::empty();
        store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        // The platform store adds an operator's private CAs. Unreadable
        // entries are skipped: the Mozilla set above still applies.
        let native = rustls_native_certs::load_native_certs();
        let (added, ignored) = store.add_parsable_certificates(native.certs);
        tracing::debug!(added, ignored, "loaded platform root certificates");
        store
    });
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map(|b| b.with_root_certificates(roots).with_no_client_auth());
    match config {
        Ok(config) => TlsConnector::from(Arc::new(config)),
        // The ring provider supports the default versions, so this is
        // unreachable; an empty-root config still refuses every handshake.
        Err(_) => TlsConnector::from(Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(rustls::RootCertStore::empty())
                .with_no_client_auth(),
        )),
    }
}

/// Connects to the first address that answers, node-style.
async fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, HttpError> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|source| HttpError::Dns {
            host: host.to_string(),
            source,
        })?
        .collect();
    let ordered = interleave(addrs);
    if ordered.is_empty() {
        return Err(HttpError::Dns {
            host: host.to_string(),
            source: io::Error::new(io::ErrorKind::NotFound, "no addresses"),
        });
    }
    let stream = connect_any(ordered, |addr| Box::pin(TcpStream::connect(addr))).await?;
    // node's http client sets noDelay by default.
    stream.set_nodelay(true).map_err(HttpError::Connect)?;
    Ok(stream)
}

/// The attempt loop of node's `autoSelectFamily`, over any connector.
///
/// `addrs` is already family-interleaved ([`interleave`]). Every attempt —
/// including the only one, for a single-address destination — is bounded by
/// [`CONNECT_ATTEMPT_TIMEOUT`]; an attempt that runs out is abandoned (its
/// future dropped, so its socket closed) and the next address is tried. A
/// refusal or any other immediate error falls through to the next address at
/// once. Attempts are sequential, as in node: at most one SYN is outstanding.
///
/// When every address fails, the error names each attempt and its cause (node
/// raises an `AggregateError` whose `errors` carry the same). With one address
/// the error is that attempt's own, kind preserved.
async fn connect_any<S, F>(addrs: Vec<SocketAddr>, mut connect: F) -> Result<S, HttpError>
where
    F: FnMut(SocketAddr) -> Pin<Box<dyn Future<Output = io::Result<S>> + Send>>,
{
    let mut failures: Vec<(SocketAddr, io::Error)> = Vec::new();
    for addr in addrs {
        match tokio::time::timeout(CONNECT_ATTEMPT_TIMEOUT, connect(addr)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(e)) => failures.push((addr, e)),
            Err(_) => failures.push((
                addr,
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("connect ETIMEDOUT {addr} after {CONNECT_ATTEMPT_TIMEOUT:?}"),
                ),
            )),
        }
    }
    if failures.len() == 1 {
        let (addr, e) = failures.remove(0);
        let text = e.to_string();
        let message = if text.contains(&addr.to_string()) {
            text
        } else {
            format!("{addr}: {text}")
        };
        return Err(HttpError::Connect(io::Error::new(e.kind(), message)));
    }
    let kind = failures
        .last()
        .map_or(io::ErrorKind::NotConnected, |(_, e)| e.kind());
    let causes: Vec<String> = failures
        .iter()
        .map(|(addr, e)| format!("{addr}: {e}"))
        .collect();
    Err(HttpError::Connect(io::Error::new(
        kind,
        format!("every address failed [{}]", causes.join("; ")),
    )))
}

/// Alternates address families, beginning with the family of the first.
fn interleave(addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let Some(first) = addrs.first().copied() else {
        return addrs;
    };
    let (same, other): (Vec<_>, Vec<_>) = addrs
        .into_iter()
        .partition(|a| a.is_ipv6() == first.is_ipv6());
    let mut out = Vec::with_capacity(same.len() + other.len());
    let (mut a, mut b) = (same.into_iter(), other.into_iter());
    loop {
        match (a.next(), b.next()) {
            (None, None) => return out,
            (x, y) => out.extend(x.into_iter().chain(y)),
        }
    }
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
