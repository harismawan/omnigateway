//! Connections: connect (with per-address attempt timeouts), TLS, and the
//! keep-alive pool.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use super::{CONNECT_ATTEMPT_TIMEOUT, HttpError, Scheme, Target};

/// Idle connections kept per destination. node's global agent keeps 256.
const MAX_IDLE_PER_KEY: usize = 256;
/// An idle connection older than this is closed rather than reused.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

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
    idle: Mutex<HashMap<Key, Vec<(Conn, Instant)>>>,
    /// Built on first TLS use; the platform root store is read once.
    tls: OnceLock<TlsConnector>,
    roots: Option<rustls::RootCertStore>,
}

impl std::fmt::Debug for Pool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pool")
            .field("idle", &self.idle_count())
            .finish_non_exhaustive()
    }
}

impl Pool {
    pub fn new(roots: Option<rustls::RootCertStore>) -> Pool {
        Pool {
            idle: Mutex::new(HashMap::new()),
            tls: OnceLock::new(),
            roots,
        }
    }

    pub fn idle_count(&self) -> usize {
        self.idle
            .lock()
            .map_or(0, |idle| idle.values().map(Vec::len).sum())
    }

    /// The most recently returned live connection for `key`, if any.
    pub fn checkout(&self, key: &Key) -> Option<Conn> {
        let mut idle = self.idle.lock().ok()?;
        let list = idle.get_mut(key)?;
        while let Some((mut conn, since)) = list.pop() {
            if since.elapsed() < IDLE_TIMEOUT && conn.still_idle() {
                return Some(conn);
            }
        }
        None
    }

    /// Returns a connection whose last response was read cleanly to its end.
    pub fn checkin(&self, key: Key, conn: Conn) {
        let Ok(mut idle) = self.idle.lock() else {
            return;
        };
        let list = idle.entry(key).or_default();
        if list.len() >= MAX_IDLE_PER_KEY {
            list.remove(0);
        }
        list.push((conn, Instant::now()));
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
///
/// With several addresses (node's `autoSelectFamily`), families are interleaved
/// starting with the resolver's first answer, and each attempt gets
/// [`CONNECT_ATTEMPT_TIMEOUT`] before the next is tried. With one address there
/// is no attempt timeout, as in node: only the OS connect timeout applies.
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
    let single = ordered.len() == 1;
    let mut last = None;
    for addr in ordered {
        let attempt = TcpStream::connect(addr);
        let outcome = if single {
            attempt.await
        } else {
            match tokio::time::timeout(CONNECT_ATTEMPT_TIMEOUT, attempt).await {
                Ok(r) => r,
                Err(_) => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("connect ETIMEDOUT {addr}"),
                )),
            }
        };
        match outcome {
            Ok(stream) => {
                // node's http client sets noDelay by default.
                stream.set_nodelay(true).map_err(HttpError::Connect)?;
                return Ok(stream);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(HttpError::Connect(last.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::NotConnected, "no address connected")
    })))
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
mod tests {
    use super::*;

    #[test]
    fn interleaves_families_starting_with_the_first() {
        let v4 = |n: u8| SocketAddr::from(([10, 0, 0, n], 1));
        let v6 = |n: u16| SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, n], 1));
        assert_eq!(
            interleave(vec![v6(1), v6(2), v4(1), v4(2), v4(3)]),
            vec![v6(1), v4(1), v6(2), v4(2), v4(3)]
        );
        assert_eq!(interleave(vec![v4(1), v6(1)]), vec![v4(1), v6(1)]);
        assert!(interleave(vec![]).is_empty());
    }
}
