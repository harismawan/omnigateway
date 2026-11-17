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

pub use body::{BodyObserver, Headers, ResponseBody};
pub use pool::PoolLimits;
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
#[derive(Clone, PartialEq)]
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
impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HttpRequest(<redacted>)")
    }
}

/// The response head plus an incrementally readable body.
pub struct HttpResponse {
    pub status: u16,
    pub headers: Headers,
    pub body: ResponseBody,
}
impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

/// Diagnostics retain only a parsed scheme and host, never URL credentials.
#[derive(Debug)]
pub struct RejectedUrl(String);

impl From<&str> for RejectedUrl {
    fn from(raw: &str) -> Self {
        Self(url::Url::parse(raw).ok().map_or_else(
            || "[unparseable URL]".into(),
            |url| {
                format!(
                    "{}://{}",
                    url.scheme(),
                    url.host_str().unwrap_or("[no host]")
                )
            },
        ))
    }
}

impl std::fmt::Display for RejectedUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error("invalid url: {0}")]
    InvalidUrl(RejectedUrl),
    #[error("invalid http method: {0}")]
    InvalidMethod(String),
    /// A header name that is not a token, or a value node would refuse.
    #[error("invalid character in header [{name}]")]
    InvalidHeader { name: String },
    #[error("body encoding {0:?} is not implemented by this transport")]
    UnsupportedEncoding(BodyEncoding),
    #[error("{0} codec buildRequest did not return a usable request")]
    InvalidEncodedRequest(String),
    #[error("empty zstd request bodies require unsupported implicit chunked upload")]
    EmptyEncodedBody,
    #[error("request body compression failed: {0}")]
    Compression(std::io::Error),
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
    /// Opt-in request-local transport lifetime, including detached capture reads.
    fn dispatch_scope(&self, _request_id: &str) -> Option<Box<dyn Send>> {
        None
    }

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

#[cfg(test)]
mod drain_tests;

/// `onResponseHead`: called once per request when the response head or a
/// transport failure arrives, with the provider and the elapsed whole ms.
pub type OnResponseHead = Arc<dyn Fn(&str, u64) + Send + Sync>;

/// A keep-alive client over plain TCP and rustls.
#[derive(Clone)]
pub struct Client {
    pool: Arc<Pool>,
    on_head: Option<OnResponseHead>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("pool", &self.pool)
            .finish_non_exhaustive()
    }
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
            pool: Arc::new(Pool::new(None, PoolLimits::default())),
            on_head: None,
        }
    }

    /// A client trusting exactly `roots`, for tests and private CAs.
    pub fn with_roots(roots: rustls::RootCertStore) -> Self {
        Client {
            pool: Arc::new(Pool::new(Some(roots), PoolLimits::default())),
            on_head: None,
        }
    }

    /// A client with explicit trust roots (`None`: the platform's plus the
    /// Mozilla set) and pool limits.
    pub fn with_config(roots: Option<rustls::RootCertStore>, limits: PoolLimits) -> Self {
        Client {
            pool: Arc::new(Pool::new(roots, limits)),
            on_head: None,
        }
    }

    /// Installs `onResponseHead` (the gateway's telemetry hook).
    #[must_use]
    pub fn with_on_response_head(mut self, hook: OnResponseHead) -> Self {
        self.on_head = Some(hook);
        self
    }

    /// Idle pooled connections, across every destination.
    pub fn idle_connections(&self) -> usize {
        self.pool.idle_count()
    }

    /// Sends one request and returns once the response head has arrived.
    pub async fn send(&self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        if req.body_encoding.is_some() {
            let encodings: Vec<_> = req
                .headers
                .iter()
                .filter(|(n, _)| n.eq_ignore_ascii_case("content-encoding"))
                .collect();
            if req
                .headers
                .iter()
                .any(|(n, _)| n.eq_ignore_ascii_case("content-length"))
                || encodings.len() != 1
                || !omni_ir::js::trim(&encodings[0].1).eq_ignore_ascii_case("zstd")
            {
                return Err(HttpError::InvalidEncodedRequest(req.provider.clone()));
            }
            if req.body.is_empty() {
                return Err(HttpError::EmptyEncodedBody);
            }
        }
        let target = wire::parse_target(&req.url)?;
        let (bytes, facts) = if req.body_encoding.is_some() {
            use std::io::Write as _;
            let mut encoder =
                zstd::stream::write::Encoder::new(Vec::new(), 3).map_err(HttpError::Compression)?;
            encoder
                .write_all(req.body.as_bytes())
                .map_err(HttpError::Compression)?;
            let compressed = encoder.finish().map_err(HttpError::Compression)?;
            wire::encode_owned(&req.method, &target, &req.headers, compressed)?
        } else {
            wire::encode(&req.method, &target, &req.headers, req.body.as_bytes())?
        };
        let started = Instant::now();
        // `trace()`, once: on the response head, on a transport error, or —
        // as TS's `onAbort` destroy → `error` → `trace(undefined, true)` —
        // when this future is dropped before either (a request deadline or a
        // client hang-up cancelling the attempt).
        let traced = self.on_head.as_ref().map(|hook| HeadTrace {
            hook: hook.clone(),
            provider: req.provider.clone(),
            started_ms: epoch_ms(),
        });
        let result = self.exchange(&target, &bytes, facts).await;
        drop(traced);
        let duration_ms = started.elapsed().as_millis();
        match &result {
            Ok(res) => tracing::debug!(
                provider = %req.provider,
                status = res.status,
                host = %target.host_header,
                path = %path_only(&target.path),
                durationMs = duration_ms,
                "upstream http"
            ),
            Err(_) => tracing::debug!(
                provider = %req.provider,
                host = %target.host_header,
                path = %path_only(&target.path),
                durationMs = duration_ms,
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
            // A pooled socket that accepted zero bytes of the request comes
            // back `Stale` (the peer had closed it while idle): nothing was
            // sent, so that, and only that, is retried once on a fresh
            // connection. Once any byte was accepted the error is surfaced,
            // never replayed. See `body::Failure` for the rule.
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

/// Fires `onResponseHead` exactly once, when dropped: after the exchange
/// returned, or when the pending exchange was cancelled.
struct HeadTrace {
    hook: OnResponseHead,
    provider: String,
    started_ms: u64,
}

impl Drop for HeadTrace {
    fn drop(&mut self) {
        // Wall-clock whole milliseconds, as TS's `now() - startedAt`, but
        // saturated at zero: a backwards clock step is not a duration, and
        // a negative observation would land in the first bucket as if real.
        (self.hook)(&self.provider, epoch_ms().saturating_sub(self.started_ms));
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The path without its query, which can carry a key and is never logged.
fn path_only(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}
