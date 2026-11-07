//! The outbound HTTP/1.1 client.
//!
//! **Why not hyper's client.** The bytes on the wire must be exactly what
//! `nodeHttpClient` writes: the caller's header pairs in order and casing, then
//! `Content-Length`, `Host` and `Connection: keep-alive` *after* them. hyper's
//! HTTP/1 encoder writes the `Host` it derives (or the one in the map) where the
//! `HeaderMap` puts it, and its map groups a name's values together, so the
//! trailing order and node's last-casing-wins collapse are not expressible. The
//! spec pre-approves this fallback: a small request writer ([`wire`]) over a
//! pooled `TcpStream` / `tokio-rustls` stream, with `httparse` reading the
//! response head ([`body`]).
//!
//! **Cancellation is structural.** A connection is owned by exactly one
//! in-flight future or [`ResponseBody`] at a time. Dropping either drops the
//! socket, which closes it; only a body read to its clean end, with nothing
//! left over, goes back to the pool.

mod body;
mod pool;
mod wire;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub use body::{Headers, ResponseBody};
use pool::{Conn, Pool};

/// How long one address gets before the next is tried (node's
/// `autoSelectFamilyAttemptTimeout`, `CONNECT_ATTEMPT_TIMEOUT_MS`). Above
/// Linux's one-second initial RTO, so a dropped SYN can be retransmitted.
pub const CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(3000);

/// A request-body encoding the transport applies. Codex's backend reads zstd.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyEncoding {
    Zstd,
}

/// An upstream request with everything already decided (`HttpRequest` in TS).
///
/// Headers are ordered and cased; the body is the finished string. There is no
/// `signal`: the deadline is the caller dropping the future or the body.
#[derive(Debug, Clone, PartialEq)]
pub struct HttpRequest {
    pub provider: String,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub body_encoding: Option<BodyEncoding>,
    /// Gateway correlation for logs. Never sent on the wire.
    pub request_id: Option<String>,
}

/// The response head plus an incrementally readable body.
#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Headers,
    pub body: ResponseBody,
}

#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error("invalid url: {0}")]
    InvalidUrl(String),
    #[error("invalid http method: {0}")]
    InvalidMethod(String),
    /// A header name that is not a token, or a value node would refuse.
    #[error("invalid character in header [{name}]")]
    InvalidHeader { name: String },
    #[error("body encoding {0:?} is not implemented by this transport")]
    UnsupportedEncoding(BodyEncoding),
    /// `getaddrinfo` failed or returned nothing (node `ENOTFOUND`).
    #[error("getaddrinfo ENOTFOUND {host}: {source}")]
    Dns {
        host: String,
        source: std::io::Error,
    },
    /// Every address refused or timed out (node `ECONNREFUSED` / `ETIMEDOUT`).
    #[error("connect failed: {0}")]
    Connect(std::io::Error),
    #[error("tls: {0}")]
    Tls(std::io::Error),
    /// The server closed before a response head (node "socket hang up").
    #[error("socket hang up")]
    ConnectionClosed,
    /// The response could not be parsed (node `HPE_*`).
    #[error("parse error: {0}")]
    InvalidResponse(String),
    /// The body ended before its framing said it would (node "aborted").
    #[error("aborted")]
    BodyAborted,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl HttpError {
    /// Whether this is a transport failure dispatch files as `NETWORK`.
    ///
    /// Mirrors `classify()`'s hints in `apps/gateway/src/dispatch/classify.ts`:
    /// node's `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET` and
    /// "socket hang up" match; a parse error or a TLS verification failure does
    /// not, and TS files those as `INTERNAL`.
    pub fn is_network(&self) -> bool {
        matches!(
            self,
            HttpError::Dns { .. }
                | HttpError::Connect(_)
                | HttpError::ConnectionClosed
                | HttpError::BodyAborted
                | HttpError::Io(_)
        )
    }
}

/// The transport seam Task 5's dispatch calls; tests substitute their own.
pub trait HttpClient: Send + Sync {
    fn send(
        &self,
        req: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Scheme {
    Http,
    Https,
}

/// A parsed destination.
#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub scheme: Scheme,
    /// Hostname or IP literal to connect to (brackets stripped).
    pub host: String,
    pub port: u16,
    /// What node writes as `Host`: `host[:port]`, port omitted when default.
    pub host_header: String,
    /// `pathname + search`.
    pub path: String,
}

/// A keep-alive client over plain TCP and rustls.
#[derive(Clone, Debug)]
pub struct Client {
    pool: Arc<Pool>,
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

impl Client {
    /// Trusts the platform's roots plus the Mozilla set (`webpki-roots`).
    pub fn new() -> Self {
        Client {
            pool: Arc::new(Pool::new(None)),
        }
    }

    /// A client trusting exactly `roots`, for tests and private CAs.
    pub fn with_roots(roots: rustls::RootCertStore) -> Self {
        Client {
            pool: Arc::new(Pool::new(Some(roots))),
        }
    }

    /// Idle pooled connections, across every destination.
    pub fn idle_connections(&self) -> usize {
        self.pool.idle_count()
    }

    /// Sends one request and returns once the response head has arrived.
    pub async fn send(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        if let Some(encoding) = req.body_encoding {
            return Err(HttpError::UnsupportedEncoding(encoding));
        }
        let target = wire::parse_target(&req.url)?;
        let (bytes, facts) = wire::encode(&req.method, &target, &req.headers, req.body.as_bytes())?;
        let started = Instant::now();
        let result = self.exchange(&target, &bytes, facts).await;
        let duration_ms = started.elapsed().as_millis();
        match &result {
            Ok(res) => tracing::debug!(
                provider = %req.provider,
                status = res.status,
                host = %target.host_header,
                path = %path_only(&target.path),
                duration_ms,
                "upstream http"
            ),
            Err(_) => tracing::debug!(
                provider = %req.provider,
                host = %target.host_header,
                path = %path_only(&target.path),
                duration_ms,
                reason = "transport error",
                "upstream http"
            ),
        }
        result
    }

    async fn exchange(
        &self,
        target: &Target,
        bytes: &[u8],
        facts: wire::RequestFacts,
    ) -> Result<HttpResponse, HttpError> {
        let key = pool::Key::of(target);
        if let Some(conn) = self.pool.checkout(&key) {
            // A pooled socket that cannot take the write comes back `Stale`:
            // nothing was sent, so that, and only that, is retried once on a
            // fresh connection. A request that went out is never resent.
            match body::roundtrip(conn, true, bytes, facts, &self.pool, key.clone()).await {
                Err(body::Failure::Stale) => {}
                Err(body::Failure::Fatal(e)) => return Err(e),
                Ok(res) => return Ok(res),
            }
        }
        let conn: Conn = self.pool.connect(target).await?;
        match body::roundtrip(conn, false, bytes, facts, &self.pool, key).await {
            Ok(res) => Ok(res),
            Err(body::Failure::Stale) => Err(HttpError::ConnectionClosed),
            Err(body::Failure::Fatal(e)) => Err(e),
        }
    }
}

impl HttpClient for Client {
    fn send(
        &self,
        req: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        Box::pin(Client::send(self, req))
    }
}

/// The path without its query, which can carry a key and is never logged.
fn path_only(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}
