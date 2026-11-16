//! The HTTP surface (`app.ts` + `routes/proxy.ts` + `routes/models.ts`):
//! `/health`, the three inference routes, `count_tokens`, `/v1/models`, and
//! TS's 404 for everything else.
//!
//! hyper 1 serves HTTP/1.1 directly; routing is a match on method and path.

use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt as _;
use http_body_util::{BodyExt as _, Full, Limited, StreamBody, combinators::UnsyncBoxBody};
use hyper::body::{Frame, Incoming};
use hyper::header::HeaderValue;
use hyper::{Method, Request, Response, StatusCode};
use omni_dialects::egress::{
    AnthropicStream, Dialect, OpenAiStream, ResponsesRender, ResponsesStream, StreamEncoder,
    retry_after,
};
use omni_dialects::ingress::{Headers, IngressOptions, Surface, ingest, random_tool_use_id};
use omni_gateway_core::ratelimit::RateLimiter;
use omni_gateway_core::snapshot::{
    AuthOutcome, AuthenticatedKey, GatewaySnapshot, MissResolver, MissResult, api_key_header,
};
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::stream::StreamEvent;
use omni_ratelimit::{HeadroomByDimension, after_this_request};

use crate::dispatch::{self, Deps};
use crate::finish::Finisher;

/// The `/v1/*` request-body limit (spec: at least several MiB; TS has none).
pub const BODY_LIMIT: usize = 32 * 1024 * 1024;

pub type Body = UnsyncBoxBody<Bytes, std::io::Error>;

/// Handles live with the server, not the response. Reap on every registration:
/// retained handles are bounded by peak concurrent workers, never request count.
pub struct DeadlineWorkers(
    std::sync::Mutex<Option<tokio::task::JoinSet<()>>>,
    #[cfg(test)] std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<&'static str>>>,
);

impl Default for DeadlineWorkers {
    fn default() -> Self {
        Self::new()
    }
}

impl DeadlineWorkers {
    pub fn new() -> Self {
        Self(
            std::sync::Mutex::new(Some(tokio::task::JoinSet::new())),
            #[cfg(test)]
            std::sync::Mutex::new(None),
        )
    }

    fn spawn(
        &self,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Option<tokio::task::AbortHandle> {
        let mut guard = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let workers = guard.as_mut()?;
        while workers.try_join_next().is_some() {}
        Some(workers.spawn(future))
    }

    pub async fn shutdown(&self) {
        // Taking the set and registering a worker share one lock. No worker
        // can escape the shutdown snapshot; rejected futures drop in caller.
        let workers = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(mut workers) = workers {
            #[cfg(test)]
            if let Some(tx) = self.1.lock().expect("test observer").as_ref() {
                tx.send("joining").expect("test observer alive");
            }
            workers.shutdown().await;
        }
    }

    #[cfg(test)]
    pub(crate) fn before_writer_close(&self) {
        if let Some(tx) = self.1.lock().expect("test observer").as_ref() {
            tx.send("closing").expect("test observer alive");
        }
    }
}

/// A deadline-owned pump keeps polling cancellation even when hyper stops
/// polling the body. One-frame channel bounds read-ahead. Dropping the returned
/// body aborts its owned worker, dropping dispatch and the admission finisher.
fn deadline_body(body: Body, deadline: tokio::time::Instant, workers: &DeadlineWorkers) -> Body {
    struct Worker(Option<tokio::task::AbortHandle>);
    impl Drop for Worker {
        fn drop(&mut self) {
            if let Some(worker) = &self.0 {
                worker.abort();
            }
        }
    }
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let expired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = expired.clone();
    let worker = Worker(workers.spawn(async move {
        let mut body = body;
        let pump = async {
            while let Some(frame) = body.frame().await {
                if tx.send(frame).await.is_err() {
                    return;
                }
            }
        };
        if tokio::time::timeout_at(deadline, pump).await.is_err() {
            // Release upstream, load/probe and concurrency BEFORE attempting
            // to notify a client whose bounded output queue may still be full.
            drop(body);
            flag.store(true, std::sync::atomic::Ordering::Release);
        }
    }));
    let stream = async_stream::stream! {
        let _worker = worker;
        while let Some(frame) = rx.recv().await { yield frame; }
        if expired.load(std::sync::atomic::Ordering::Acquire) {
            yield Err(std::io::Error::new(std::io::ErrorKind::TimedOut,"request deadline exceeded"));
        }
    };
    StreamBody::new(stream).boxed_unsync()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod deadline_ownership {
    use super::*;

    #[tokio::test]
    async fn workers_reap_history_and_refuse_spawn_after_shutdown() {
        let workers = DeadlineWorkers::new();
        for _ in 0..1000 {
            let handle = workers.spawn(async {}).unwrap();
            while !handle.is_finished() {
                tokio::task::yield_now().await;
            }
            assert!(workers.0.lock().unwrap().as_ref().unwrap().len() <= 1);
        }
        workers.shutdown().await;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let owned = Released(Some(tx));
        assert!(
            workers
                .spawn(async move {
                    let _owned = owned;
                    std::future::pending::<()>().await;
                })
                .is_none()
        );
        rx.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_racing_shutdown_cannot_escape_ownership() {
        for _ in 0..100 {
            let workers = Arc::new(DeadlineWorkers::new());
            let barrier = Arc::new(tokio::sync::Barrier::new(2));
            let (tx, rx) = tokio::sync::oneshot::channel();
            let owned = Released(Some(tx));
            let spawning = {
                let workers = workers.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    workers.spawn(async move {
                        let _owned = owned;
                        std::future::pending::<()>().await;
                    });
                })
            };
            barrier.wait().await;
            workers.shutdown().await;
            spawning.await.unwrap();
            rx.await.unwrap();
            assert!(workers.0.lock().unwrap().is_none());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn shutdown_joins_gated_worker_before_terminal_row_and_writer_close() {
        use omni_store::writer::{LogEvent, PendingLog};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateway.db");
        let env = std::collections::HashMap::from([
            (
                "OMNI_ENCRYPTION_KEY".into(),
                "test-encryption-key-0123456789".into(),
            ),
            ("OMNI_DB_PATH".into(), path.to_str().unwrap().into()),
        ]);
        let mut config = omni_gateway_core::config::load_config(&env, || 0).unwrap();
        config.port = 0;
        let running = crate::start(
            config,
            crate::Options {
                stop_deadline: Duration::ZERO,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let app = running.app.clone();
        let writer = app.deps.writer.clone();
        writer.send(LogEvent::Begin(PendingLog {
            id: "gated".into(),
            at: 0,
            api_key_id: None,
            requested_model: "m".into(),
            resolved_provider: None,
            resolved_model: None,
            credential_id: None,
        }));
        writer.flush().await.unwrap();
        let state = || {
            rusqlite::Connection::open(&path)
                .unwrap()
                .query_row(
                    "SELECT state, status FROM request_logs WHERE id='gated'",
                    [],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .unwrap()
        };
        assert_eq!(state().0, "pending");
        let (events, mut observed) = tokio::sync::mpsc::unbounded_channel();
        *app.deadline_workers.1.lock().unwrap() = Some(events.clone());
        let (release, gate) = std::sync::mpsc::channel();
        let (dropped, released) = tokio::sync::oneshot::channel();
        struct Gated {
            events: tokio::sync::mpsc::UnboundedSender<&'static str>,
            gate: std::sync::mpsc::Receiver<()>,
            finisher: Option<Finisher>,
            released: Option<tokio::sync::oneshot::Sender<()>>,
        }
        impl Drop for Gated {
            fn drop(&mut self) {
                self.events.send("destruction").unwrap();
                self.gate.recv().unwrap();
                drop(self.finisher.take());
                self.released.take().unwrap().send(()).unwrap();
            }
        }
        let owned = Gated {
            events: events.clone(),
            gate,
            finisher: Some(Finisher::new(
                writer.clone(),
                "gated".into(),
                0,
                "test",
                crate::clock::now_ms,
            )),
            released: Some(dropped),
        };
        let source = async_stream::stream! {
            let _owned = owned;
            events.send("live").unwrap();
            std::future::pending::<()>().await;
            yield Ok::<_,std::io::Error>(Frame::data(Bytes::new()));
        };
        let body = deadline_body(
            StreamBody::new(source).boxed_unsync(),
            tokio::time::Instant::now() + Duration::from_secs(3600),
            &app.deadline_workers,
        );
        assert_eq!(observed.recv().await, Some("live"));
        running.shutdown();
        let mut wait = tokio::spawn(running.wait());
        let phase = observed.recv().await.unwrap();
        // Shutdown itself must cancel the still-live pump. On RED, disconnect
        // it here so the test can release the gate and report without hanging.
        drop(body);
        assert_eq!(observed.recv().await, Some("destruction"));
        if phase == "closing" {
            // Force the reported legal interleaving on the old implementation:
            // writer fully closes before the blocked destructor can file Finish.
            (&mut wait).await.unwrap().unwrap();
            release.send(()).unwrap();
            released.await.unwrap();
            assert_eq!(state().0, "pending");
            assert_eq!(writer.stats().dropped, 1);
            panic!("writer closed before worker destruction: pending row, dropped Finish=1");
        }
        // Release even on RED, so a failing assertion cannot strand a runtime thread.
        let waiting = !wait.is_finished();
        let pending = state().0;
        release.send(()).unwrap();
        released.await.unwrap();
        wait.await.unwrap().unwrap();
        assert_eq!(
            phase, "joining",
            "writer closure overtook worker destruction"
        );
        assert!(waiting);
        assert_eq!(pending, "pending");
        assert_eq!(state(), ("done".into(), 499));
        assert_eq!(writer.stats().dropped, 0);
        assert_eq!(writer.stats().failed, 0);
        assert!(app.deadline_workers.0.lock().unwrap().is_none());
    }
    struct Released(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for Released {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                tx.send(()).ok();
            }
        }
    }
    #[tokio::test]
    async fn deadline_drops_unpolled_body_and_disconnect_aborts_worker() {
        for disconnect in [false, true] {
            let workers = DeadlineWorkers::new();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let owned = Released(Some(tx));
            let source = async_stream::stream! {
                let _owned=owned;
                loop { yield Ok::<_,std::io::Error>(Frame::data(Bytes::from_static(b"frame"))); }
            };
            let body = deadline_body(
                StreamBody::new(source).boxed_unsync(),
                tokio::time::Instant::now() + Duration::from_millis(20),
                &workers,
            );
            if disconnect {
                drop(body);
            } else {
                // The downstream has never polled the returned body.
                tokio::time::timeout(Duration::from_secs(1), rx)
                    .await
                    .expect("independent deadline")
                    .expect("source dropped");
                drop(body);
                continue;
            }
            tokio::time::timeout(Duration::from_secs(1), rx)
                .await
                .expect("owned abort")
                .expect("source dropped");
        }
    }
}

/// Everything a request handler reads. One per process.
pub struct App {
    pub connect: Arc<crate::connect::ConnectFlows>,
    pub deadline_workers: DeadlineWorkers,
    pub deps: Arc<Deps>,
    pub limiter: Arc<RateLimiter>,
    pub miss: MissResolver,
    pub node_id: String,
    /// `KEEPALIVE_MS`; Responses streams use `min(this, 4 s)`.
    pub keepalive: Duration,
    /// Longest wait for the next byte of a request body.
    pub idle_timeout: Duration,
    /// Serve `POST /__omni/bench/flush` (`OMNI_BENCH=1` only).
    pub bench_endpoints: bool,
    /// How long that barrier waits for the writer before a 504.
    pub bench_flush_timeout: Duration,
    /// `OMNI_METRICS_TOKEN`: registers `/metrics`; absent means no route.
    pub metrics_token: Option<String>,
    /// `realpath` of the dashboard directory at boot; `None` when absent.
    pub static_root: Option<std::path::PathBuf>,
    /// The session authority behind every `/api` route.
    pub admin: crate::admin_auth::AdminAuth,
    /// Whether `baseUrl` (`OMNI_BASE_URL`) is https: `Secure` on the cookie.
    pub base_url_https: bool,
    /// The admin routes' own store connection (keys, models, settings).
    pub control: crate::admin_routes::ControlStore,
    pub credential_key: omni_crypto::field::FieldKey,
    /// `OMNI_BODY_LOGGING_ALLOWED`, reported on `/api/settings`.
    pub body_logging_allowed: bool,
    /// The daily-bucket offset, reported on `/api/settings`.
    pub day_offset_minutes: i64,
    /// Catalog problems already logged, one line each per process.
    pub reported_catalog_problems: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl App {
    /// `reportCatalogProblem`: `provider catalog repaired`, once per
    /// distinct `field provider` per process.
    pub fn report_catalog_problems(&self, problems: Vec<omni_control::api::CatalogProblem>) {
        if problems.is_empty() {
            return;
        }
        let mut seen = self
            .reported_catalog_problems
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for p in problems {
            if seen.insert(format!("{} {}", p.field, p.provider)) {
                tracing::warn!(
                    reason = %format!("{} {}: not a CSS colour; served neutral grey instead", p.provider, p.field),
                    "provider catalog repaired"
                );
            }
        }
    }
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App")
            .field("node_id", &self.node_id)
            .finish_non_exhaustive()
    }
}

const RESPONSES_KEEPALIVE: Duration = Duration::from_secs(4);

pub(crate) fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into())
        .map_err(|never: Infallible| match never {})
        .boxed_unsync()
}

fn json_response(
    status: u16,
    content_type: &'static str,
    body: String,
    headers: &[(String, String)],
) -> Response<Body> {
    let mut res = Response::new(full(body));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let h = res.headers_mut();
    h.insert("content-type", HeaderValue::from_static(content_type));
    for (k, v) in headers {
        if let (Ok(name), Ok(value)) = (
            hyper::header::HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            h.append(name, value);
        }
    }
    res
}

const APPLICATION_JSON: &str = "application/json";
const JSON_UTF8: &str = "application/json;charset=utf-8";

fn error_response(
    dialect: Dialect,
    e: &GatewayError,
    headers: &[(String, String)],
) -> Response<Body> {
    let body = omni_ir::jsjson::to_string(&dialect.error_body(e.code, &e.message));
    json_response(e.code.http_status(), APPLICATION_JSON, body, headers)
}

/// Elysia's 404 for an unmatched GET (the `/*` catch-all with no dashboard).
pub(crate) fn not_found_get(path: &str) -> Response<Body> {
    let mut body = String::from("{\"error\":{\"code\":\"NOT_FOUND\",\"message\":");
    omni_ir::jsjson::write_str(&format!("no route for {path}"), &mut body);
    body.push_str("}}");
    json_response(404, JSON_UTF8, body, &[])
}

/// Elysia's 404 for any other unmatched method.
fn not_found_other() -> Response<Body> {
    let mut res = Response::new(full("NOT_FOUND"));
    *res.status_mut() = StatusCode::NOT_FOUND;
    res.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/plain;charset=utf-8"),
    );
    res
}

/// Routes one request.
///
/// Routes match `new URL(request.url).pathname`, as Elysia's do: dot
/// segments (and their `%2e` spellings) resolved and the path encode set
/// applied. A plain path (every `/v1/*` call a client makes) skips
/// normalization; the one copy below is the same `to_owned` the router made
/// before normalization existed, needed because handlers take `req` by value.
pub async fn handle(app: Arc<App>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    let path = crate::static_files::pathname(req.uri().path()).into_owned();
    // Elysia matches a route with one trailing slash as the route itself.
    let route = if path.len() > 1 && path.ends_with('/') && !path.ends_with("//") {
        &path[..path.len() - 1]
    } else {
        path.as_str()
    };
    let method = req.method().clone();
    // Bun refuses a declared body over `maxRequestBodySize` before routing,
    // on every route but `/v1/*` (whose own limit is stricter).
    if !route.starts_with("/v1/") && crate::api::declares_oversized_body(&req) {
        return Ok(crate::api::payload_too_large());
    }
    let get = matches!(method, Method::GET | Method::HEAD);
    let res = match (method.clone(), route) {
        (Method::GET | Method::HEAD, "/health") => health(&app),
        (Method::POST, "/__omni/bench/flush") if app.bench_endpoints => bench_flush(&app).await,
        (Method::POST, "/v1/messages") => proxy(app, Surface::Anthropic, req).await,
        (Method::POST, "/v1/chat/completions") => proxy(app, Surface::OpenAi, req).await,
        (Method::POST, "/v1/responses") => proxy(app, Surface::Responses, req).await,
        (Method::POST, "/v1/messages/count_tokens") => count_tokens(app, req).await,
        (Method::GET | Method::HEAD, "/v1/models") => models(&app, &req).await,
        (Method::GET | Method::HEAD, "/metrics") if app.metrics_token.is_some() => {
            metrics(&app, &req)
        }
        (_, r) if is_plugin_api(r) => plugins_unsupported(),
        (m, r) if let Some(api) = crate::api::route(&m, r) => {
            crate::api::serve(app, api, req).await
        }
        (Method::GET | Method::HEAD, r) if is_plugin_asset(&path, r) => plugin_asset_not_found(),
        _ if get => crate::static_files::serve(app.static_root.as_deref(), &path, &req).await,
        _ => not_found_other(),
    };
    let mut res = res;
    if method != Method::HEAD {
        stamp_date(&mut res);
    }
    Ok(res)
}

/// `date: <IMF-fixdate>` as Bun writes it on every response but a HEAD's,
/// formatted once per second per thread.
fn stamp_date(res: &mut Response<Body>) {
    thread_local! {
        static CACHE: std::cell::RefCell<(u64, Option<HeaderValue>)> =
            const { std::cell::RefCell::new((0, None)) };
    }
    if res.headers().contains_key(hyper::header::DATE)
        || res.extensions().get::<crate::api::NoDate>().is_some()
    {
        return;
    }
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let value = CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.0 != secs || c.1.is_none() {
            c.0 = secs;
            c.1 = HeaderValue::from_str(&httpdate::fmt_http_date(now)).ok();
        }
        c.1.clone()
    });
    if let Some(v) = value {
        res.headers_mut().insert(hyper::header::DATE, v);
    }
}

/// `/api/plugins` and everything below it: the plugin API, which this
/// release refuses (spec, non-goals).
fn is_plugin_api(route: &str) -> bool {
    route == "/api/plugins" || route.starts_with("/api/plugins/")
}

/// `/plugin-assets/:id/*` (a non-empty id, then a slash): with no plugin
/// loaded, TS answers every such path its own 404.
fn is_plugin_asset(path: &str, _route: &str) -> bool {
    path.strip_prefix("/plugin-assets/")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(id, _)| !id.is_empty())
}

/// `pluginUiRoutes`' `notFound()` for an id no plugin has.
fn plugin_asset_not_found() -> Response<Body> {
    json_response(
        404,
        JSON_UTF8,
        "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no such plugin asset\"}}".to_owned(),
        &[],
    )
}

/// The spec's plugin refusal: 501 with the usual `/api` error body.
fn plugins_unsupported() -> Response<Body> {
    json_response(
        501,
        JSON_UTF8,
        "{\"error\":{\"code\":\"UNSUPPORTED\",\"message\":\"plugins are not supported in this release\"}}"
            .to_owned(),
        &[],
    )
}

/// `GET /metrics`: `authorization` must be exactly `Bearer <token>`,
/// compared in constant time over equal lengths (the length itself is not
/// secret, as in TS); anything else is a bare 401.
fn metrics(app: &App, req: &Request<Incoming>) -> Response<Body> {
    let Some(token) = &app.metrics_token else {
        return not_found_get(req.uri().path());
    };
    let supplied = header(req, "authorization").unwrap_or_default();
    let expected = format!("Bearer {token}");
    // `timingSafeEqual` after a length check, as TS: `subtle`'s comparison
    // is written to resist the optimizer turning it into an early exit.
    let ok = supplied.len() == expected.len()
        && bool::from(subtle::ConstantTimeEq::ct_eq(
            supplied.as_bytes(),
            expected.as_bytes(),
        ));
    if !ok {
        let mut res = Response::new(full(Bytes::new()));
        *res.status_mut() = StatusCode::UNAUTHORIZED;
        return res;
    }
    let text = app.deps.telemetry.scrape(&app.deps.load.provider_counts());
    let mut res = Response::new(full(text));
    res.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    res
}

fn health(app: &App) -> Response<Body> {
    let mut body = String::from("{\"ok\":true,\"mode\":\"single\",\"nodeId\":");
    omni_ir::jsjson::write_str(&app.node_id, &mut body);
    body.push_str(",\"coord\":\"ok\"}");
    json_response(200, JSON_UTF8, body, &[])
}

/// The bench harness's writer barrier (`OMNI_BENCH=1` only): the outcome of
/// every event sequenced before it, `{watermark, committed, failed,
/// dropped}` with `committed + failed + dropped == watermark`, so the
/// harness can take exact per-scenario deltas.
///
/// - 409 `inconclusive` while another barrier is in flight (one at a time);
/// - 503 `inconclusive` if the writer's queue has no room (a barrier never
///   waits for room, so it cannot crowd out request events) or it has closed;
/// - 504 `inconclusive` if the writer has not answered within
///   `bench_flush_timeout` (30 s). That barrier stays in flight, and later
///   calls get 409, until the writer answers it.
async fn bench_flush(app: &App) -> Response<Body> {
    use omni_store::writer::BarrierError;
    let inconclusive = |status: u16, reason: &str| {
        json_response(
            status,
            JSON_UTF8,
            format!("{{\"inconclusive\":true,\"reason\":\"{reason}\"}}"),
            &[],
        )
    };
    match tokio::time::timeout(app.bench_flush_timeout, app.deps.writer.flush()).await {
        Ok(Ok(b)) => json_response(
            200,
            JSON_UTF8,
            format!(
                "{{\"watermark\":{},\"committed\":{},\"failed\":{},\"dropped\":{}}}",
                b.watermark, b.committed, b.failed, b.dropped
            ),
            &[],
        ),
        Ok(Err(BarrierError::Busy)) => inconclusive(409, "another barrier is in flight"),
        Ok(Err(BarrierError::Full)) => inconclusive(503, "writer queue full"),
        Ok(Err(BarrierError::Closed)) => inconclusive(503, "writer closed"),
        Err(_) => inconclusive(504, "writer did not answer in time"),
    }
}

/// WHATWG `Headers.get`: every value of `name`, HTTP whitespace trimmed,
/// joined with `", "`. Non-UTF-8 bytes are read as Latin-1, as Bun does.
fn header(req: &Request<Incoming>, name: &str) -> Option<String> {
    let mut out: Option<String> = None;
    for v in req.headers().get_all(name) {
        let text: String = v.as_bytes().iter().map(|&b| char::from(b)).collect();
        let text = text.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n'));
        match &mut out {
            None => out = Some(text.to_owned()),
            Some(acc) => {
                acc.push_str(", ");
                acc.push_str(text);
            }
        }
    }
    out
}

/// `authenticateApiKey(apiKeyHeader(headers), now)` against the snapshot,
/// falling back to one guarded read for a key the snapshot does not hold.
async fn authenticate(
    app: &App,
    req: &Request<Incoming>,
    now: i64,
) -> Result<(AuthenticatedKey, Arc<GatewaySnapshot>), GatewayError> {
    let authorization = header(req, "authorization");
    let x_api_key = header(req, "x-api-key");
    let chosen = api_key_header(authorization.as_deref(), x_api_key.as_deref())?;
    let snapshot = app.deps.holder.load();
    match snapshot.authenticate(chosen, now) {
        AuthOutcome::Ok(k) => Ok((k, snapshot)),
        AuthOutcome::Refused(e) => Err(e),
        AuthOutcome::Miss => {
            let raw = omni_gateway_core::snapshot::extract_token(chosen).unwrap_or("");
            let hash = omni_crypto::apikey::hash(raw);
            match app.miss.resolve(&hash).await {
                MissResult::Found(key) => {
                    let snapshot = app.deps.holder.load();
                    match snapshot.authenticate(chosen, now) {
                        AuthOutcome::Ok(k) => {
                            #[allow(clippy::cast_precision_loss)]
                            app.limiter.preseed(&k.id, &k.limits, now as f64);
                            Ok((k, snapshot))
                        }
                        AuthOutcome::Refused(e) => Err(e),
                        AuthOutcome::Miss => {
                            tracing::debug!(apiKeyId = %key.as_ref().map_or_else(|e| e.id.clone(), |k| k.id.clone()), "key found but not in snapshot");
                            Err(GatewaySnapshot::refuse_unknown())
                        }
                    }
                }
                MissResult::Failed => {
                    tracing::error!(reason = "store read failed", "api key lookup failed");
                    Err(GatewaySnapshot::refuse_unknown())
                }
                MissResult::Absent | MissResult::Shed => Err(GatewaySnapshot::refuse_unknown()),
            }
        }
    }
}

/// `await request.json()`'s text: the body read under the limit, decoded as
/// UTF-8 with replacement and a leading BOM stripped.
/// Why a body read stopped short.
fn body_error(e: &(dyn std::error::Error + 'static)) -> GatewayError {
    if e.downcast_ref::<http_body_util::LengthLimitError>()
        .is_some()
    {
        GatewayError::new(
            ErrorCode::BadRequest,
            format!("request body exceeds {BODY_LIMIT} bytes"),
        )
        .gateway_authored()
    } else {
        GatewayError::new(ErrorCode::Internal, "request body could not be read").gateway_authored()
    }
}

/// `await request.json()`'s text: the body read under the limit (enforced
/// while reading) with at most `idle` between frames, decoded as UTF-8 with
/// replacement and a leading BOM stripped. A body that goes quiet for `idle`
/// ends the request; the connection task then closes the socket, as Bun's
/// `idleTimeout` does.
async fn read_body(req: Request<Incoming>, idle: Duration) -> Result<String, GatewayError> {
    let mut body = Limited::new(req.into_body(), BODY_LIMIT);
    let mut bytes = bytes::BytesMut::new();
    loop {
        match tokio::time::timeout(idle, body.frame()).await {
            Err(_) => return Err(BodyIdle.into()),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(body_error(e.as_ref())),
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    bytes.extend_from_slice(&data);
                }
            }
        }
    }
    // Valid UTF-8 (the usual case) becomes the `String` without a copy.
    let mut text = match String::from_utf8(Vec::from(bytes)) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    if text.starts_with('\u{feff}') {
        text.drain(..'\u{feff}'.len_utf8());
    }
    Ok(text)
}

/// The body went quiet past the idle timeout. Not a client-visible answer:
/// the route turns it into a hang-up (a 499 row, the socket closed).
#[derive(Debug)]
struct BodyIdle;

impl From<BodyIdle> for GatewayError {
    fn from(_: BodyIdle) -> Self {
        GatewayError::new(ErrorCode::Timeout, BODY_IDLE).gateway_authored()
    }
}

/// The marker message for [`BodyIdle`]; never sent to a client.
const BODY_IDLE: &str = "request body idle timeout";

fn is_body_idle(e: &GatewayError) -> bool {
    e.code == ErrorCode::Timeout && e.message == BODY_IDLE
}

/// A response that makes hyper close the connection without an answer:
/// the body errors at once, which aborts the exchange.
pub(crate) fn hang_up() -> Response<Body> {
    let s = futures_util::stream::iter([Err::<Frame<Bytes>, _>(std::io::Error::other(BODY_IDLE))]);
    let mut res = Response::new(http_body_util::BodyExt::boxed_unsync(StreamBody::new(s)));
    res.headers_mut()
        .insert("connection", HeaderValue::from_static("close"));
    res
}

fn headers_of(req: &Request<Incoming>) -> Headers {
    let mut h = Headers::new();
    for (name, value) in req.headers() {
        let text: String = value.as_bytes().iter().map(|&b| char::from(b)).collect();
        h.append(name.as_str(), &text);
    }
    h
}

/// `ingest`, with TS's answer for a body `JSON.parse` refuses: 500 INTERNAL
/// carrying JavaScriptCore's own message.
fn ingest_body(
    surface: Surface,
    body: &str,
    headers: &Headers,
) -> Result<omni_dialects::ingress::Ingested, GatewayError> {
    let mut mint = random_tool_use_id;
    let mut opts = IngressOptions {
        new_tool_use_id: &mut mint,
    };
    ingest(surface, body, headers, &mut opts).map_err(|e| {
        if e.code == ErrorCode::BadRequest
            && e.message == "request body must be valid JSON"
            && let Some(message) = crate::jsc_json::parse_error(body)
        {
            return GatewayError::new(ErrorCode::Internal, message);
        }
        e
    })
}

fn surface_name(s: Surface) -> &'static str {
    match s {
        Surface::Anthropic => "anthropic",
        Surface::OpenAi => "openai",
        Surface::Responses => "responses",
    }
}

fn dialect_of(s: Surface) -> Dialect {
    match s {
        Surface::Anthropic => Dialect::Anthropic,
        Surface::OpenAi => Dialect::OpenAi,
        Surface::Responses => Dialect::Responses,
    }
}

fn floor_secs(ms: i64) -> i64 {
    ms.div_euclid(1000)
}

/// `handle` in `routes/proxy.ts`.
#[allow(clippy::too_many_lines)]
async fn proxy(app: Arc<App>, surface: Surface, req: Request<Incoming>) -> Response<Body> {
    let now = app.deps.now;
    let request_id = crate::clock::request_id();
    let started_at = now();
    let dialect = dialect_of(surface);
    let sname = surface_name(surface);
    let mut fin = Finisher::new(
        app.deps.writer.clone(),
        request_id.clone(),
        started_at,
        sname,
        now,
    );
    if app.deps.telemetry.enabled() {
        fin = fin.with_telemetry(app.deps.telemetry.clone());
    }
    let mut headroom = HeadroomByDimension::default();
    let mut admitted = false;
    let limit_headers = |headroom: &HeadroomByDimension, admitted: bool| {
        #[allow(clippy::cast_precision_loss)]
        let at = started_at as f64;
        if admitted {
            dialect.rate_limit_headers(&after_this_request(headroom), at)
        } else {
            dialect.rate_limit_headers(headroom, at)
        }
    };

    let outcome: Result<Response<Body>, GatewayError> = async {
        let (key, _snapshot) = authenticate(&app, &req, started_at)
            .await
            .inspect_err(|e| {
                if e.code == ErrorCode::Auth {
                    tracing::warn!(requestId = %request_id, surface = sname,
                    reason = "invalid credentials", "authentication rejected");
                }
            })?;
        fin.key_id = Some(key.id.clone());
        let headers = headers_of(&req);
        let body = read_body(req, app.idle_timeout).await?;
        let ingested = ingest_body(surface, &body, &headers)?;
        drop(body);
        let chat = ingested.request;
        let lone = ingested.model_lone.as_deref();
        omni_dialects::ingress::check_model_allowed(&chat.model, key.allows(&chat.model, lone))?;
        fin.requested_model = chat.model.clone();
        // A model holding a lone surrogate the key admits: TS throws its
        // URIError building the model's rate-limit subject, at admission
        // where an override names it, else at the completion's debit after
        // dispatch. Refused here instead, before anything is claimed or sent
        // upstream (a documented divergence; see the A5 report). The row's
        // completion debits the key-wide subject only, as TS's does.
        if lone.is_some() {
            fin.model_unencodable = true;
            return Err(omni_dialects::ingress::lone_surrogate_model_error());
        }
        #[allow(clippy::cast_precision_loss)]
        match app
            .limiter
            .admit(&key.id, &key.limits, &chat.model, started_at as f64)
        {
            Ok(a) => {
                headroom = a.headroom;
                admitted = true;
                fin.admission = Some(a);
            }
            Err(refused) => {
                headroom = *refused.headroom;
                app.deps.telemetry.rate_limit(
                    refused.violation.dimension.as_str(),
                    refused.violation.window.map(omni_ratelimit::Window::as_str),
                );
                let e = refused.to_gateway_error();
                tracing::warn!(requestId = %request_id, surface = sname, apiKeyId = %key.id,
                    model = %chat.model, code = e.code.as_str(), retryAfterMs = e.retry_after_ms,
                    "rate limit rejected");
                return Err(e);
            }
        }
        let stream = chat.stream;
        let dreq = dispatch::Request {
            request: chat,
            request_id: request_id.clone(),
            api_key_id: Some(key.id.clone()),
            route_started_at: started_at,
        };
        // After admission: a refused screen still counts as one request.
        let refusal = dispatch::screen(
            key.guardrail_policy.as_deref(),
            key.smart_routing,
            &app.deps.holder.load().routing.settings,
        );
        let dispatched = match &refusal {
            Some(r) => dispatch::refused(&app.deps, &dreq, r, sname),
            None => dispatch::dispatch(app.deps.clone(), dreq),
        };
        let response_deadline = dispatched.deadline;
        fin.outcome = Some(dispatched.log.clone());
        let retain = !stream || surface == Surface::Responses;
        let mut upstream = dispatched.events;
        let bounded_events: dispatch::EventsStream = Box::pin(async_stream::stream! {
            let mut budget = crate::output_budget::OutputBudget::default();
            while let Some(item) = upstream.next().await {
                if retain && let Ok(event) = &item && let Err(error) = budget.charge(event) {
                    drop(upstream);
                    yield Err(error);
                    return;
                }
                yield item;
            }
        });

        if stream {
            let encoder = match surface {
                Surface::Anthropic => StreamEncoder::Anthropic(AnthropicStream::new(&request_id)),
                Surface::OpenAi => {
                    StreamEncoder::OpenAi(OpenAiStream::new(&request_id, floor_secs(now())))
                }
                Surface::Responses => {
                    StreamEncoder::Responses(Box::new(ResponsesStream::new(ResponsesRender {
                        request_id: request_id.clone(),
                        created: floor_secs(now()),
                        custom_tool_names: ingested.custom_tool_names,
                    })))
                }
            };
            let keepalive = if surface == Surface::Responses {
                app.keepalive.min(RESPONSES_KEEPALIVE)
            } else {
                app.keepalive
            };
            let body = sse_body(bounded_events, encoder, keepalive, fin.take());
            let body = match response_deadline {
                Some(deadline) => deadline_body(body, deadline, &app.deadline_workers),
                None => body,
            };
            let mut res = Response::new(settle(body));
            let h = res.headers_mut();
            h.insert(
                "content-type",
                HeaderValue::from_static("text/event-stream; charset=utf-8"),
            );
            h.insert(
                "cache-control",
                HeaderValue::from_static("no-cache, no-transform"),
            );
            h.insert("connection", HeaderValue::from_static("keep-alive"));
            h.insert("x-accel-buffering", HeaderValue::from_static("no"));
            for (k, v) in limit_headers(&headroom, admitted) {
                if let (Ok(name), Ok(value)) = (
                    hyper::header::HeaderName::from_bytes(k.as_bytes()),
                    HeaderValue::from_str(&v),
                ) {
                    h.append(name, value);
                }
            }
            return Ok(res);
        }

        let mut events = Vec::new();
        let mut throw = None;
        let mut s = bounded_events;
        while let Some(item) = s.next().await {
            match item {
                Ok(ev) => events.push(ev),
                Err(e) => {
                    throw = Some(e);
                    break;
                }
            }
        }
        drop(s);
        if let Some(e) = throw {
            return Err(e);
        }
        let failure = events.iter().find_map(|e| match e {
            StreamEvent::Error { code, message, .. } => Some((*code, message.clone())),
            _ => None,
        });
        let (status, body) = match failure {
            Some((code, message)) => (
                code.http_status(),
                omni_ir::jsjson::to_string(&dialect.error_body(code, &message)),
            ),
            None => {
                let collected = omni_ir::stream::try_collect(events)?;
                let rendered = match surface {
                    Surface::Anthropic => {
                        omni_dialects::egress::anthropic::response(&collected, &request_id)
                    }
                    Surface::OpenAi => omni_dialects::egress::openai::response(
                        &collected,
                        &request_id,
                        floor_secs(now()),
                    ),
                    Surface::Responses => omni_dialects::egress::responses::response(
                        &collected,
                        &ResponsesRender {
                            request_id: request_id.clone(),
                            created: floor_secs(now()),
                            custom_tool_names: ingested.custom_tool_names,
                        },
                    ),
                };
                (200, omni_ir::jsjson::to_string(&rendered))
            }
        };
        fin.complete(false, None);
        Ok(json_response(
            status,
            APPLICATION_JSON,
            body,
            &limit_headers(&headroom, admitted),
        ))
    }
    .await;

    match outcome {
        Ok(res) => res,
        // Bun closes the socket: no answer, and the row reads as a hang-up.
        Err(e) if is_body_idle(&e) => {
            drop(fin);
            hang_up()
        }
        Err(e) => {
            fin.reject(&e);
            let mut headers = limit_headers(&headroom, admitted);
            if let Some(v) = retry_after(&e) {
                headers.push(("retry-after".into(), v));
            }
            error_response(dialect, &e, &headers)
        }
    }
}

/// The most SSE bytes coalesced into one body frame.
const COALESCE_BYTES: usize = 64 * 1024;
/// The most events taken in one poll of the body: per coalesced frame, and
/// across ready events that encode to nothing (a Chat `BlockEnd`), after
/// which the task yields. Without it, an upstream that delivers a long run of
/// such events at once would keep one poll going through all of them.
const COALESCE_EVENTS: usize = 64;

/// `sseResponse`: frames into one reused buffer, `: keepalive` while idle,
/// and the row completed exactly once — at the end, on a break, or (through
/// the finisher's `Drop`) when the client hangs up and the body is dropped.
fn sse_body(
    mut events: dispatch::EventsStream,
    mut encoder: StreamEncoder,
    keepalive: Duration,
    mut fin: Finisher,
) -> Body {
    fin.streaming();
    let stream = async_stream::stream! {
        let mut buf = String::with_capacity(1024);
        // The first non-empty frame goes out alone, so `settle` still sees
        // one frame exactly when TS's stream had one.
        let mut sent_first = false;
        // An item pulled while coalescing that is not an event: handled by
        // the next loop turn, after the coalesced frame went out.
        let mut held: Option<Option<Result<omni_ir::stream::StreamEvent, GatewayError>>> = None;
        // Events taken since this body last gave the task back (a frame out,
        // or a pending poll).
        let mut taken = 0usize;
        loop {
            let next = match held.take() {
                Some(item) => Ok(item),
                None => tokio::time::timeout(keepalive, events.next()).await,
            };
            match next {
                Err(_) => {
                    yield Ok::<_, std::io::Error>(Frame::data(Bytes::from_static(b": keepalive\n\n")));
                }
                Ok(Some(Ok(event))) => {
                    encoder.push_owned(event, &mut buf);
                    taken += 1;
                    // Every event already decoded joins this frame: one body
                    // write (one chunk, one syscall) per upstream read rather
                    // than per event. Never waits: a pending poll ends it.
                    // Bounded by bytes and by events taken.
                    while sent_first && buf.len() < COALESCE_BYTES && taken < COALESCE_EVENTS {
                        let ready = std::future::poll_fn(|cx| {
                            std::task::Poll::Ready(events.as_mut().poll_next(cx))
                        })
                        .await;
                        match ready {
                            std::task::Poll::Pending => {
                                taken = 0;
                                break;
                            }
                            std::task::Poll::Ready(Some(Ok(event))) => {
                                encoder.push_owned(event, &mut buf);
                                taken += 1;
                            }
                            std::task::Poll::Ready(other) => {
                                held = Some(other);
                                break;
                            }
                        }
                    }
                    if !buf.is_empty() {
                        sent_first = true;
                        taken = 0;
                        let frame = Bytes::copy_from_slice(buf.as_bytes());
                        buf.clear();
                        yield Ok(Frame::data(frame));
                    } else if taken >= COALESCE_EVENTS {
                        // Nothing to write, and the budget is spent: give
                        // the task back once rather than run on through
                        // every ready event in this poll.
                        taken = 0;
                        tokio::task::yield_now().await;
                    }
                }
                Ok(Some(Err(e))) => {
                    drop(events);
                    fin.complete(false, Some(&e));
                    yield Err(std::io::Error::other(e.message));
                    return;
                }
                Ok(None) => {
                    drop(events);
                    encoder.finish(&mut buf);
                    if !buf.is_empty() {
                        let frame = Bytes::copy_from_slice(buf.as_bytes());
                        buf.clear();
                        yield Ok(Frame::data(frame));
                    }
                    fin.complete(false, None);
                    return;
                }
            }
        }
    };
    http_body_util::BodyExt::boxed_unsync(StreamBody::new(stream))
}

/// Bun sends a stream body of one frame that is already complete when the
/// head is written with `content-length`; two or more frames are chunked.
/// So this pulls at most two frames without waiting: one frame and the end
/// answers with a fixed length, anything else streams on unchanged (the
/// frames already pulled first, in order). At most two frames are held.
pub fn settle(mut body: Body) -> Body {
    use futures_util::FutureExt as _;
    let mut first: Option<Bytes> = None;
    let rest = loop {
        match body.frame().now_or_never() {
            Some(Some(Ok(frame))) => match frame.into_data() {
                Ok(data) if first.is_none() => first = Some(data),
                // A second frame: chunked, whatever follows.
                Ok(data) => break vec![Ok(Frame::data(data))],
                Err(_) => {}
            },
            Some(None) if first.is_some() => {
                return full(first.unwrap_or_default());
            }
            Some(None) => return full(Bytes::new()),
            Some(Some(Err(e))) => break vec![Err(e)],
            None => break Vec::new(),
        }
    };
    let head =
        futures_util::stream::iter(first.into_iter().map(|b| Ok(Frame::data(b))).chain(rest));
    let tail = http_body_util::BodyStream::new(body);
    http_body_util::BodyExt::boxed_unsync(StreamBody::new(head.chain(tail)))
}

/// `POST /v1/messages/count_tokens`.
async fn count_tokens(app: Arc<App>, req: Request<Incoming>) -> Response<Body> {
    let now = (app.deps.now)();
    let result: Result<f64, GatewayError> = async {
        let (key, _snapshot) = authenticate(&app, &req, now).await?;
        let headers = headers_of(&req);
        let body = read_body(req, app.idle_timeout).await?;
        let ingested = ingest_body(Surface::Anthropic, &body, &headers)?;
        let lone = ingested.model_lone;
        let chat = ingested.request;
        omni_dialects::ingress::check_model_allowed(
            &chat.model,
            key.allows(&chat.model, lone.as_deref()),
        )?;
        // `consume` builds the model's subject only where an override names
        // it, and TS's URIError comes from exactly there; a lone-surrogate
        // model no override names is judged against the key-wide limits.
        let key_wide;
        let limits = match lone.as_deref() {
            Some(units) if key.limits.has_lone_override(units) => {
                return Err(omni_dialects::ingress::lone_surrogate_model_error());
            }
            Some(_) => {
                key_wide = key.limits.key_wide();
                &key_wide
            }
            None => &key.limits,
        };
        #[allow(clippy::cast_precision_loss)]
        app.limiter
            .consume(&key.id, limits, &chat.model, now as f64)
            .map_err(|r| {
                app.deps.telemetry.rate_limit(
                    r.violation.dimension.as_str(),
                    r.violation.window.map(omni_ratelimit::Window::as_str),
                );
                r.to_gateway_error()
            })?;
        // The ponytail ruleset defaults off and is not ported.
        Ok(omni_ir::tokens::estimate_input_tokens(&chat))
    }
    .await;
    match result {
        Err(e) if is_body_idle(&e) => hang_up(),
        Ok(n) => {
            let mut body = String::from("{\"input_tokens\":");
            omni_ir::jsjson::write_number(n, &mut body);
            body.push('}');
            json_response(200, JSON_UTF8, body, &[])
        }
        Err(e) => {
            tracing::warn!(status = e.code.http_status(), code = e.code.as_str(),
                reason = %e.message, "token count failed");
            let headers: Vec<(String, String)> = retry_after(&e)
                .map(|v| ("retry-after".to_owned(), v))
                .into_iter()
                .collect();
            error_response(Dialect::Anthropic, &e, &headers)
        }
    }
}

/// `GET /v1/models`.
async fn models(app: &App, req: &Request<Incoming>) -> Response<Body> {
    let now = (app.deps.now)();
    match authenticate(app, req, now).await {
        Ok((key, snapshot)) => {
            let mut ids: Vec<&String> = snapshot.routing.models.keys().collect();
            ids.sort();
            // Model ids are well-formed (a stored id is UTF-8), so only the
            // allowlist's well-formed names can equal one: an entry with a
            // lone surrogate is never U+FFFD's.
            let allowed: Option<HashSet<&str>> = key
                .model_allowlist
                .as_ref()
                .map(|l| l.iter().map(String::as_str).collect());
            let visible: Vec<&omni_store::VirtualModel> = ids
                .into_iter()
                .filter(|id| allowed.as_ref().is_none_or(|a| a.contains(id.as_str())))
                .filter_map(|id| snapshot.routing.models.get(id))
                .collect();
            json_response(
                200,
                JSON_UTF8,
                crate::models::list_body(&visible, &snapshot.routing.credentials),
                &[],
            )
        }
        Err(e) => {
            tracing::error!(status = e.code.http_status(), code = e.code.as_str(),
                reason = %e.message, "model listing failed");
            error_response(Dialect::Anthropic, &e, &[])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body::Body as _;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counted(n: usize, pulled: Arc<AtomicUsize>) -> Body {
        let s = futures_util::stream::iter((0..n).map(move |i| {
            pulled.fetch_add(1, Ordering::SeqCst);
            Ok::<_, std::io::Error>(Frame::data(Bytes::from(format!("f{i};"))))
        }));
        StreamBody::new(s).boxed_unsync()
    }

    #[tokio::test]
    async fn settle_reads_at_most_two_frames_ahead_and_keeps_order() {
        let pulled = Arc::new(AtomicUsize::new(0));
        let body = settle(counted(1000, pulled.clone()));
        assert_eq!(pulled.load(Ordering::SeqCst), 2);
        assert!(body.size_hint().exact().is_none());
        let all = body.collect().await.expect("body").to_bytes();
        let want: String = (0..1000).map(|i| format!("f{i};")).collect();
        assert_eq!(all, Bytes::from(want));
    }

    #[tokio::test]
    async fn one_complete_frame_gets_a_fixed_length() {
        let body = settle(counted(1, Arc::new(AtomicUsize::new(0))));
        assert_eq!(body.size_hint().exact(), Some(3));
    }
    use omni_ir::stream::{ContentBlockStart, Delta};

    /// A finisher whose writer is closed: `sse_body` needs one, and these
    /// tests only look at the frames.
    async fn finisher() -> (Finisher, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("omni.db");
        drop(omni_store::SqliteStore::open(&db, 0).expect("open"));
        let w = omni_store::writer::Writer::spawn(&db, omni_store::writer::WriterConfig::default())
            .expect("writer");
        let handle = w.handle();
        w.close().await.expect("close");
        let fin = Finisher::new(handle, "req_t".into(), 0, "openai", || 0);
        (fin, dir)
    }

    fn text(t: &str) -> StreamEvent {
        StreamEvent::BlockDelta {
            index: 0,
            delta: Delta::Text { text: t.into() },
        }
    }

    /// Events that are all ready but encode to nothing (`BlockEnd` writes no
    /// Chat Completions chunk) cannot keep one poll going: after
    /// `COALESCE_EVENTS` the frame (empty or not) gives the task back, and
    /// what follows comes out in the next frames.
    #[tokio::test]
    async fn ready_events_that_write_nothing_cannot_extend_one_poll() {
        let (fin, _dir) = finisher().await;
        let pulled = Arc::new(AtomicUsize::new(0));
        let counter = pulled.clone();
        let mut items: Vec<Result<StreamEvent, GatewayError>> = vec![
            Ok(StreamEvent::Start {
                id: "a".into(),
                model: "m".into(),
            }),
            Ok(StreamEvent::BlockStart {
                index: 0,
                block: ContentBlockStart::Text,
            }),
        ];
        items.extend((0..10_000).map(|_| Ok(StreamEvent::BlockEnd { index: 0 })));
        items.push(Ok(text("tail")));
        let events: dispatch::EventsStream =
            Box::pin(futures_util::stream::iter(items).inspect(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
            }));
        let encoder = StreamEncoder::OpenAi(OpenAiStream::new("req_t", 0));
        let mut body = sse_body(events, encoder, Duration::from_secs(60), fin);
        // The first frame goes out alone (`settle`'s rule).
        let first = body.frame().await.expect("frame").expect("ok");
        assert!(!first.into_data().unwrap_or_default().is_empty());
        let before = pulled.load(Ordering::SeqCst);
        // The second poll: all 10 000 no-output events are ready, but one
        // poll may take at most the budget of them.
        let polled = futures_util::FutureExt::now_or_never(body.frame());
        let after = pulled.load(Ordering::SeqCst);
        assert!(
            after - before <= 64,
            "one poll took {} ready events (budget 64)",
            after - before
        );
        let mut seen = match polled {
            Some(Some(Ok(f))) => {
                String::from_utf8_lossy(&f.into_data().unwrap_or_default()).into_owned()
            }
            _ => String::new(),
        };
        let rest = body.collect().await.expect("rest").to_bytes();
        seen.push_str(&String::from_utf8_lossy(&rest));
        assert!(
            seen.contains("tail"),
            "the events after still arrive: {seen}"
        );
        assert_eq!(pulled.load(Ordering::SeqCst), 10_003, "every event pulled");
    }

    /// An upstream that pends between events: what is ready goes out at once
    /// (no waiting for more to coalesce), and an idle gap still gets its
    /// keepalive.
    #[tokio::test(start_paused = true)]
    async fn a_pending_upstream_flushes_what_is_ready_and_keepalives_still_fire() {
        let (fin, _dir) = finisher().await;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<StreamEvent, GatewayError>>();
        let events: dispatch::EventsStream = Box::pin(tokio_stream_from(rx));
        let encoder = StreamEncoder::OpenAi(OpenAiStream::new("req_t", 0));
        let mut body = sse_body(events, encoder, Duration::from_millis(100), fin);
        tx.send(Ok(StreamEvent::Start {
            id: "a".into(),
            model: "m".into(),
        }))
        .expect("send");
        tx.send(Ok(StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        }))
        .expect("send");
        let first = body.frame().await.expect("frame").expect("ok");
        assert!(
            String::from_utf8_lossy(&first.into_data().unwrap_or_default()).contains("assistant")
        );
        // Two deltas ready, then the upstream pends: both go out in one frame
        // now, not after the next event.
        tx.send(Ok(text("one "))).expect("send");
        tx.send(Ok(text("two"))).expect("send");
        let f = body.frame().await.expect("frame").expect("ok");
        let f = String::from_utf8_lossy(&f.into_data().unwrap_or_default()).into_owned();
        assert!(f.contains("one ") && f.contains("two"), "{f}");
        // Nothing for 250 ms: keepalives.
        let k = body.frame().await.expect("frame").expect("ok");
        assert_eq!(
            k.into_data().unwrap_or_default(),
            Bytes::from_static(b": keepalive\n\n")
        );
        tx.send(Ok(text("three"))).expect("send");
        drop(tx);
        let rest = body.collect().await.expect("rest").to_bytes();
        let rest = String::from_utf8_lossy(&rest);
        assert!(rest.contains("three"), "{rest}");
    }

    fn tokio_stream_from<T: Send + 'static>(
        mut rx: tokio::sync::mpsc::UnboundedReceiver<T>,
    ) -> impl futures_util::Stream<Item = T> + Send {
        futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
    }
}
