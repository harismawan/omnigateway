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
use crate::telemetry::WriterRefusal;

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
    pub quota: std::sync::Arc<omni_control::quota_runtime::Quota>,
    pub database_swap: tokio::sync::Mutex<()>,
    pub quiesce: Arc<crate::quiesce::Quiesce>,
    pub lifecycle: crate::lifecycle::Lifecycle,
    pub version: String,
    pub cluster: bool,
    pub redis: Option<Arc<omni_coord::redis::RedisCoord>>,
    pub stop: tokio::sync::watch::Sender<bool>,
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
    pub stream: Arc<crate::stream_transport::Hub>,
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
    pub(crate) fn routing_committed(&self, change: crate::routing::RoutingChange) {
        self.deps.refresher.routing_committed(change);
    }
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
pub(crate) fn route_path(raw: &str) -> std::borrow::Cow<'_, str> {
    let mut path = crate::static_files::pathname(raw);
    // Elysia matches a route with one trailing slash as the route itself.
    if path.len() > 1 && path.ends_with('/') && !path.ends_with("//") {
        let len = path.len() - 1;
        path.to_mut().truncate(len);
    }
    path
}

pub async fn handle(app: Arc<App>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    let admission = if route_path(req.uri().path()).starts_with("/v1/") {
        match app.quiesce.enter() {
            Some(admission) => Some(admission),
            None => {
                let dialect = match route_path(req.uri().path()).as_ref() {
                    "/v1/chat/completions" => Dialect::OpenAi,
                    "/v1/responses" => Dialect::Responses,
                    _ => Dialect::Anthropic,
                };
                let mut response = error_response(
                    dialect,
                    &GatewayError::new(
                        ErrorCode::Overloaded,
                        "the gateway is briefly quiesced for database maintenance",
                    ),
                    &[("retry-after".into(), "5".into())],
                );
                stamp_date(&mut response);
                return Ok(response);
            }
        }
    } else {
        None
    };
    let mut response = handle_admitted(app, req).await?;
    if let Some(admission) = admission {
        let body = std::mem::replace(response.body_mut(), full(Bytes::new()));
        *response.body_mut() = AdmittedBody {
            body,
            admission: Some(admission),
        }
        .boxed_unsync();
    }
    Ok(response)
}

/// Preserve the wrapped body's length hint and EOF semantics (notably models).
struct AdmittedBody {
    body: Body,
    admission: Option<crate::quiesce::Admission>,
}

impl http_body::Body for AdmittedBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = std::pin::Pin::new(&mut self.body).poll_frame(cx);
        if matches!(result, std::task::Poll::Ready(None | Some(Err(_)))) {
            self.admission.take();
        }
        result
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
}

async fn handle_admitted(
    app: Arc<App>,
    req: Request<Incoming>,
) -> Result<Response<Body>, Infallible> {
    let path = crate::static_files::pathname(req.uri().path()).into_owned();
    let route = route_path(req.uri().path());
    let method = req.method().clone();
    // Bun refuses a declared body over `maxRequestBodySize` before routing,
    // on every route but `/v1/*` (whose own limit is stricter).
    if !route.starts_with("/v1/") && crate::api::declares_oversized_body(&req) {
        return Ok(crate::api::payload_too_large());
    }
    let get = matches!(method, Method::GET | Method::HEAD);
    let res = match (method.clone(), route.as_ref()) {
        (Method::GET | Method::HEAD, "/api/stream") => {
            crate::stream_transport::route(app, req).await
        }
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
            c.1 = HeaderValue::from_str(&http_date(now)).ok();
        }
        c.1.clone()
    });
    if let Some(v) = value {
        res.headers_mut().insert(hyper::header::DATE, v);
    }
}

/// IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) for the `Date` header.
fn http_date(t: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t)
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
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
    // `timingSafeEqual` after a length check, as TS.
    let ok = omni_crypto::ct_eq(supplied.as_bytes(), expected.as_bytes());
    if !ok {
        let mut res = Response::new(full(Bytes::new()));
        *res.status_mut() = StatusCode::UNAUTHORIZED;
        return res;
    }
    let mut text = app
        .deps
        .telemetry
        .scrape_with_streams(&app.deps.load.provider_counts(), app.stream.stats());
    append_writer_metrics(&mut text, app.deps.writer.stats());
    if let Some((queued, credits)) = app.deps.writer.postgres_pressure() {
        use std::fmt::Write as _;
        for (suffix, value) in [("queued", queued), ("credits_in_use", credits)] {
            let name = format!("omni_request_log_writer_{suffix}");
            writeln!(text, "# TYPE {name} gauge\n{name} {value}")
                .expect("writing to a String cannot fail");
        }
    }
    append_writer_refusals(&mut text, &app.deps.telemetry);
    append_cluster_metrics(&mut text, app);
    let mut res = Response::new(full(text));
    res.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    res
}

fn append_writer_metrics(text: &mut String, stats: omni_store::writer::WriterStats) {
    use std::fmt::Write as _;
    for (kind, count) in [
        ("terminal_dropped", stats.terminal_dropped),
        ("optional_dropped", stats.optional_dropped),
        ("failed_batches", stats.failed_batches),
        ("failed_events", stats.failed),
        ("sink_dropped", stats.sink_dropped),
    ] {
        let metric = format!("omni_request_log_writer_{kind}_total");
        writeln!(text, "# TYPE {metric} counter\n{metric} {count}")
            .expect("writing to a String cannot fail");
    }
}

fn append_writer_refusals(text: &mut String, telemetry: &crate::telemetry::Telemetry) {
    use std::fmt::Write as _;
    const METRIC: &str = "omni_request_log_writer_reservation_refused_total";
    writeln!(text, "# TYPE {METRIC} counter").expect("writing to a String cannot fail");
    for (reason, count) in telemetry.writer_refusal_counts() {
        writeln!(text, "{METRIC}{{reason=\"{reason}\"}} {count}")
            .expect("writing to a String cannot fail");
    }
}

fn append_cluster_metrics(text: &mut String, app: &App) {
    use std::fmt::Write as _;
    use std::sync::atomic::Ordering::Relaxed;
    macro_rules! counters {
        ($prefix:literal, $m:ident, $($field:ident),+ $(,)?) => {
            $(writeln!(text, concat!("# TYPE ", $prefix, stringify!($field),
                "_total counter\n", $prefix, stringify!($field), "_total {}"), $m.$field.load(Relaxed))
                .expect("writing to a String cannot fail");)+
        };
    }
    if let Some(m) = app.limiter.cluster_metrics() {
        counters!(
            "omni_cluster_limiter_",
            m,
            redis_calls,
            local_admissions,
            refusals,
            unseeded_admits,
            seeds_queued,
            seeds_installed,
            seeds_already,
            seed_failures,
            seed_lock_unavailable,
            debits_queued,
            debit_buckets_applied,
            debit_rows_applied,
            debit_rows_covered,
            debit_buckets_unseeded,
            debit_rows_unseeded,
            debit_buckets_waiting,
            debit_buckets_lost,
            debit_batches,
            releases_refused,
            verdict_mismatches
        );
    }
    if let Some(m) = app.deps.load.fleet_metrics() {
        counters!(
            "omni_cluster_load_",
            m,
            publishes,
            publish_faults,
            refreshes,
            refresh_faults,
            truncated
        );
    }
}

fn health(app: &App) -> Response<Body> {
    let mode = if app.redis.is_some() {
        "cluster"
    } else {
        "single"
    };
    let mut body = format!("{{\"ok\":true,\"mode\":\"{mode}\",\"nodeId\":");
    omni_ir::jsjson::write_str(&app.node_id, &mut body);
    if app.redis.as_ref().is_some_and(|c| !c.healthy()) {
        body.push_str(",\"coord\":\"fallback\"}");
    } else {
        body.push_str(",\"coord\":\"ok\"}");
    }
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
    let mut missed = false;
    let auth = authenticate_for(app, req, now, &mut missed).await;
    preseed_miss(app, &auth, missed, now);
    auth
}

async fn authenticate_for(
    app: &App,
    req: &Request<Incoming>,
    now: i64,
    missed: &mut bool,
) -> ProxyAuth {
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
                            *missed = true;
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

#[allow(clippy::cast_precision_loss)]
fn preseed_miss(app: &App, auth: &ProxyAuth, missed: bool, now: i64) {
    if missed && let Ok((key, _)) = auth {
        app.limiter.preseed(&key.id, &key.limits, now as f64);
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
    let mut deadline = tokio::time::Instant::now() + idle;
    let mut received = 0_u64;
    loop {
        let frame = async {
            if idle.is_zero() {
                Ok(body.frame().await)
            } else {
                tokio::time::timeout_at(deadline, body.frame()).await
            }
        }
        .await;
        match frame {
            Err(_) => return Err(BodyIdle.into()),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(body_error(e.as_ref())),
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    received = received.saturating_add(data.len() as u64);
                    if u128::from(received)
                        >= idle.as_nanos().saturating_mul(16_384) / 1_000_000_000
                    {
                        deadline = tokio::time::Instant::now() + idle;
                        received = 0;
                    }
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

type ProxyAuth = Result<(AuthenticatedKey, Arc<GatewaySnapshot>), GatewayError>;
type FinishSlots = [Option<omni_store::writer::FinishSlot>; 3];

fn writer_overload(app: &App, reason: WriterRefusal) -> GatewayError {
    app.deps.telemetry.record_writer_refusal(reason);
    GatewayError::new(ErrorCode::Overloaded, crate::screening::WRITER_OVERLOAD).gateway_authored()
}

fn screens(auth: &ProxyAuth, primary: Option<&omni_store::Settings>) -> (bool, bool) {
    auth.as_ref().map_or((false, false), |(key, snapshot)| {
        let settings = primary.unwrap_or(&snapshot.routing.settings);
        (
            key.guardrail_policy.is_some(),
            key.smart_routing && settings.smart_router_enabled,
        )
    })
}

/// A wait can outlive a policy or key publication. Read the primary only
/// on this slow path; a lagging peer snapshot is not enough to find a revoke.
async fn revalidate_waiter(
    app: &App,
    req: &Request<Incoming>,
) -> Result<(AuthenticatedKey, Arc<GatewaySnapshot>, omni_store::Settings), GatewayError> {
    let authorization = header(req, "authorization");
    let x_api_key = header(req, "x-api-key");
    let chosen = api_key_header(authorization.as_deref(), x_api_key.as_deref())?;
    let Some(raw) = omni_gateway_core::snapshot::extract_token(chosen) else {
        return Err(GatewaySnapshot::refuse_unknown());
    };
    let store = &app.deps.refresher.store;
    let row = store
        .find_api_key_entry(&omni_crypto::apikey::hash(raw))
        .await
        .map_err(|_| writer_overload(app, WriterRefusal::Revalidation))?;
    // Read the small settings row instead of forcing a snapshot rebuild.
    // Neither a publication nor the poll need have caught up to this commit.
    let settings = store
        .get_settings()
        .await
        .map_err(|_| writer_overload(app, WriterRefusal::Revalidation))?;
    let key = GatewaySnapshot::authenticate_read(row, (app.deps.now)())?;
    Ok((key, app.deps.holder.load(), settings))
}

#[derive(Default)]
struct ReservationWait<'a> {
    turn: Option<omni_store::writer::FinishWaiter<'a>>,
    settings: Option<Arc<omni_store::Settings>>,
}

async fn reserve_proxy<'a, const N: usize>(
    app: &'a App,
    req: &Request<Incoming>,
    mut auth: ProxyAuth,
    deadline: tokio::time::Instant,
    wait: &mut ReservationWait<'a>,
) -> Result<(ProxyAuth, [Option<omni_store::writer::FinishSlot>; N]), GatewayError> {
    use omni_store::writer::ReserveError;
    let writer = &app.deps.writer;
    let slots = match writer.try_reserve_finishes::<N>() {
        Ok(reservation) => reservation,
        Err(ReserveError::Full) => {
            drop(auth);
            if wait.turn.is_none() {
                wait.turn = Some(
                    writer
                        .finish_waiter()
                        .map_err(|e| writer_overload(app, e.into()))?,
                );
            }
            let reservation = wait
                .turn
                .as_ref()
                .expect("waiting turn")
                .reserve::<N>(deadline)
                .await
                .map_err(|e| writer_overload(app, e.into()))?;
            let (key, snapshot, settings) =
                tokio::time::timeout_at(deadline, revalidate_waiter(app, req))
                    .await
                    .map_err(|_| writer_overload(app, WriterRefusal::Deadline))??;
            if writer.postgres_closed() {
                return Err(writer_overload(app, WriterRefusal::Closed));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(writer_overload(app, WriterRefusal::Deadline));
            }
            auth = Ok((key, snapshot));
            wait.settings = Some(Arc::new(settings));
            reservation
        }
        Err(e) => return Err(writer_overload(app, e.into())),
    };
    Ok((auth, slots.into_slots()))
}

struct PreparedProxy {
    auth: ProxyAuth,
    slots: FinishSlots,
    smart: bool,
    screening_settings: Option<Arc<omni_store::Settings>>,
}

async fn prepare_proxy(
    app: &App,
    req: &Request<Incoming>,
    mut auth: ProxyAuth,
) -> Result<PreparedProxy, GatewayError> {
    let deadline = tokio::time::Instant::now() + omni_store::writer::FINISH_WAIT;
    let mut wait = ReservationWait::default();
    loop {
        let (judge, smart) = screens(&auth, wait.settings.as_deref());
        let (next, slots, count) = match (judge, smart) {
            (true, true) => {
                let (next, slots) = reserve_proxy::<3>(app, req, auth, deadline, &mut wait).await?;
                (next, slots, 3)
            }
            (false, false) => {
                let (next, [slot]) =
                    reserve_proxy::<1>(app, req, auth, deadline, &mut wait).await?;
                (next, [slot, None, None], 1)
            }
            _ => {
                let (next, [slot, screen]) =
                    reserve_proxy::<2>(app, req, auth, deadline, &mut wait).await?;
                (next, [slot, screen, None], 2)
            }
        };
        let (judge, smart) = screens(&next, wait.settings.as_deref());
        let needed = 1 + usize::from(judge) + usize::from(smart);
        if needed <= count {
            let [main, second, third] = slots;
            return Ok(PreparedProxy {
                auth: next,
                slots: match (judge, smart) {
                    (true, true) => [main, second, third],
                    (true, false) => [main, second, None],
                    (false, true) => [main, None, second],
                    (false, false) => [main, None, None],
                },
                smart,
                screening_settings: wait.settings,
            });
        }
        // Policy now needs more rows. Return the partial set before trying
        // for the whole set, without starting a new wait budget.
        drop(slots);
        if tokio::time::Instant::now() >= deadline {
            return Err(writer_overload(app, WriterRefusal::Deadline));
        }
        auth = next;
    }
}

/// `handle` in `routes/proxy.ts`.
#[allow(clippy::too_many_lines)]
async fn proxy(app: Arc<App>, surface: Surface, req: Request<Incoming>) -> Response<Body> {
    let now = app.deps.now;
    // The UUIDv7 timestamp must not be later than the logged arrival.
    let request_id = crate::clock::request_id();
    let started_at = now();
    let dialect = dialect_of(surface);
    let sname = surface_name(surface);
    // Reserve the maximum row set before creating any completion owner or
    // claiming admission. A disconnect while waiting has spent nothing.
    if app.deps.writer.postgres_closed() {
        return error_response(dialect, &writer_overload(&app, WriterRefusal::Closed), &[]);
    }
    let mut missed = false;
    let auth = authenticate_for(&app, &req, started_at, &mut missed).await;
    if !app.cluster {
        preseed_miss(&app, &auth, missed, started_at);
    }
    let PreparedProxy {
        auth,
        slots: [slot, judge_slot, check_slot],
        smart,
        screening_settings,
    } = match prepare_proxy(&app, &req, auth).await {
        Ok(prepared) => prepared,
        Err(e) => return error_response(dialect, &e, &[]),
    };
    let mut fin = Finisher::new(
        app.deps.writer.clone(),
        request_id.clone(),
        started_at,
        sname,
        now,
    );
    fin.slot = slot;
    if let Some(t) = &app.deps.telemetry.tracing {
        t.start(
            &request_id,
            started_at,
            req.headers()
                .get("traceparent")
                .and_then(|v| v.to_str().ok()),
            sname,
            (app.deps.rand)(),
        );
    }
    if app.deps.telemetry.enabled() || app.deps.telemetry.tracing.is_some() {
        fin = fin.with_telemetry(app.deps.telemetry.clone());
    }
    let mut headroom = HeadroomByDimension::default();
    let mut admitted = false;
    let mut admission_at = started_at;
    let limit_headers = |headroom: &HeadroomByDimension, admitted: bool, admission_at: i64| {
        #[allow(clippy::cast_precision_loss)]
        let at = admission_at as f64;
        if admitted {
            dialect.rate_limit_headers(&after_this_request(headroom), at)
        } else {
            dialect.rate_limit_headers(headroom, at)
        }
    };

    let outcome: Result<Response<Body>, GatewayError> = async {
        let (key, snapshot) = auth.inspect_err(|e| {
            if e.code == ErrorCode::Auth {
                tracing::warn!(requestId = %request_id, surface = sname,
                    reason = "invalid credentials", "authentication rejected");
            }
        })?;
        fin.key_id = Some(key.id.clone());
        if app.body_logging_allowed
            && !key.body_logging_opt_out
            && snapshot.routing.settings.body_logging_enabled
        {
            fin.capture = Some(crate::body_capture::CaptureCompletion {
                collector: crate::body_capture::Collector::new(
                    snapshot.routing.settings.body_logging_capture_stream_chunks,
                ),
                sink: Default::default(),
                store: app.deps.refresher.store.clone(),
                key: app.credential_key.clone(),
            });
        }
        let headers = headers_of(&req);
        let body = read_body(req, Duration::ZERO).await?;
        // Reading a slow body can outlive the writer even after a successful
        // reservation. No completion owner should file a row in that case.
        if app.deps.writer.postgres_closed() {
            fin.abandon_before_admission();
            return Err(writer_overload(&app, WriterRefusal::Closed));
        }
        if app.cluster && missed {
            #[allow(clippy::cast_precision_loss)]
            app.limiter.preseed(&key.id, &key.limits, now() as f64);
        }
        if let Some(capture) = &fin.capture
            && let Ok(parsed) = omni_ir::jsjson::parse_js(&body)
        {
            capture.collector.request(parsed);
        }
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
        admission_at = if app.cluster { now() } else { started_at };
        #[allow(clippy::cast_precision_loss)]
        match app
            .limiter
            .admit_selected(&key.id, &key.limits, &chat.model, admission_at as f64)
            .await
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
        let request_deps = fin.capture.as_ref().map_or_else(
            || app.deps.clone(),
            |capture| {
                app.deps.with_http(
                    capture
                        .collector
                        .wrap_for(app.deps.http.clone(), request_id.clone()),
                )
            },
        );
        let dispatched = if smart || key.guardrail_policy.is_some() {
            let snapshot = app.deps.holder.load();
            let settings = screening_settings
                .as_deref()
                .unwrap_or(&snapshot.routing.settings);
            if let Some(classifier) = &settings.guardrail_model {
                app.limiter
                    .record_override(&key.id, &key.limits, classifier);
            }
            if let Some(classifier) = &settings.smart_router_classifier_model {
                app.limiter
                    .record_override(&key.id, &key.limits, classifier);
            }
            crate::screening::screen_first(
                request_deps,
                dreq,
                key.guardrail_policy.clone(),
                smart,
                sname,
                [judge_slot, check_slot],
                screening_settings,
            )
        } else {
            dispatch::dispatch(request_deps, dreq)
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
            for (k, v) in limit_headers(&headroom, admitted, admission_at) {
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
        let mut response_headers = limit_headers(&headroom, admitted, admission_at);
        if smart && status == 200 {
            let log = fin
                .outcome
                .as_ref()
                .expect("dispatch log")
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let route = if log.degradations.iter().any(|n| n == "smart-router:public") {
                "external"
            } else {
                "local"
            };
            response_headers.push(("x-omni-route".into(), route.into()));
        }
        if let Some(capture) = &fin.capture
            && let Ok(parsed) = omni_ir::jsjson::parse_js(&body)
        {
            capture.collector.response(parsed);
        }
        fin.complete(false, None);
        Ok(json_response(
            status,
            APPLICATION_JSON,
            body,
            &response_headers,
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
            if let Some(capture) = &fin.capture {
                capture.collector.response(
                    omni_ir::jsjson::parse_js(&omni_ir::jsjson::to_string(
                        &dialect.error_body(e.code, &e.message),
                    ))
                    .unwrap_or(omni_ir::jsjson::JsValue::Null),
                );
            }
            fin.reject(&e);
            let mut headers = limit_headers(&headroom, admitted, admission_at);
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod reservation_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const KEY: &str = "sk-omni-fix2-local-test";
    const CHAT: &str = "/v1/chat/completions";

    async fn fixture_config() -> Option<(omni_gateway_core::config::Config, omni_store::pg::PgStore)>
    {
        let (Ok(pg), Ok(redis)) = (
            std::env::var("OMNI_TEST_DATABASE_URL"),
            std::env::var("OMNI_TEST_REDIS_URL"),
        ) else {
            assert_ne!(std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(), Ok("1"));
            return None;
        };
        let base = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(&pg), 0)
            .await
            .unwrap();
        let db = format!("d4_fix2_{}", crate::clock::uuid_v4().replace('-', ""));
        base.client()
            .await
            .unwrap()
            .batch_execute(&format!("CREATE DATABASE {db}"))
            .await
            .unwrap();
        let mut url = url::Url::parse(&pg).unwrap();
        url.set_path(&format!("/{db}"));
        let store = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(url.as_str()), 0)
            .await
            .unwrap();
        store.client().await.unwrap().execute(
            r#"INSERT INTO api_keys(id,label,prefix,hash,limits,created_at) VALUES($1,'gate','sk-omni',$2,'{"requests":{"1m":1},"tokens":{"5h":1000}}',0)"#,
            &[&db, &omni_crypto::apikey::hash(KEY)],
        ).await.unwrap();
        let env = [
            (
                "OMNI_ENCRYPTION_KEY".into(),
                "test-encryption-key-0123456789".into(),
            ),
            ("OMNI_CLUSTER_MODE".into(), "1".into()),
            ("OMNI_DATABASE_URL".into(), url.to_string()),
            ("OMNI_REDIS_URL".into(), redis),
        ]
        .into_iter()
        .collect();
        let mut cfg = omni_gateway_core::config::load_config(&env, || 0).unwrap();
        cfg.port = 0;
        cfg.metrics_token = Some("reservation-test-metrics".into());
        Some((cfg, store))
    }

    async fn fixture() -> Option<(crate::Running, omni_store::pg::PgStore)> {
        let (cfg, store) = fixture_config().await?;
        let running = crate::start(
            cfg,
            crate::Options {
                writer_capacity: Some(3),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        Some((running, store))
    }

    async fn request(addr: std::net::SocketAddr, path: &str) -> tokio::net::TcpStream {
        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let body = r#"{"model":"unconfigured","messages":[{"role":"user","content":"hello"}]}"#;
        client.write_all(format!("POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {KEY}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        client
    }

    async fn reply(mut client: tokio::net::TcpStream, bound: Duration) -> (u16, serde_json::Value) {
        let mut buf = String::new();
        tokio::time::timeout(bound, client.read_to_string(&mut buf))
            .await
            .expect("bounded HTTP refusal")
            .unwrap();
        let (head, body) = buf.split_once("\r\n\r\n").unwrap();
        let status = head
            .split_ascii_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        (status, serde_json::from_str(body).unwrap())
    }

    async fn no_work(app: &App, store: &omni_store::pg::PgStore) {
        assert_eq!(app.deps.writer.stats().enqueued, 0);
        let row = store
            .client()
            .await
            .unwrap()
            .query_one("SELECT count(*) FROM request_logs", &[])
            .await
            .unwrap();
        assert_eq!(row.get::<_, i64>(0), 0);
        let metrics = app.limiter.cluster_metrics().unwrap();
        assert_eq!(
            metrics
                .redis_calls
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );
        assert_eq!(
            metrics
                .debits_queued
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );
    }

    async fn assert_reservation_refusals(
        addr: std::net::SocketAddr,
        cap: u64,
        deadline: u64,
        closed: u64,
    ) {
        let response = reservation_metrics(addr).await;
        for (reason, count) in [
            ("cap", cap),
            ("deadline", deadline),
            ("closed", closed),
            ("revalidation", 0),
        ] {
            assert!(response.lines().any(|line| line == format!(
                "omni_request_log_writer_reservation_refused_total{{reason=\"{reason}\"}} {count}"
            )), "missing {reason}={count} from scrape");
        }
    }

    async fn reservation_metrics(addr: std::net::SocketAddr) -> String {
        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        client.write_all(b"GET /metrics HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer reservation-test-metrics\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(1), client.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        response
    }

    #[tokio::test]
    async fn pg_writer_pressure_distinguishes_reserved_credits_from_queued_events() {
        let Some((server, store)) = fixture().await else {
            return;
        };
        let writer = &server.app.deps.writer;
        let held = writer.reserve_finishes::<3>().await.unwrap();
        let response = reservation_metrics(server.addr).await;
        assert!(
            response
                .lines()
                .any(|line| line == "omni_request_log_writer_queued 0")
        );
        assert!(
            response
                .lines()
                .any(|line| line == "omni_request_log_writer_credits_in_use 3")
        );
        drop(held);
        let response = reservation_metrics(server.addr).await;
        assert!(
            response
                .lines()
                .any(|line| line == "omni_request_log_writer_credits_in_use 0")
        );
        no_work(&server.app, &store).await;
        server.shutdown();
        server.wait().await.unwrap();
    }

    #[tokio::test]
    async fn pg_reservation_overload_refuses_full_waiters_and_expired_waits() {
        let Some((server, store)) = fixture().await else {
            return;
        };
        let held = server
            .app
            .deps
            .writer
            .reserve_finishes::<3>()
            .await
            .unwrap();
        let waiting = request(server.addr, CHAT).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        for (path, kind, code, param) in [
            ("/v1/messages", "overloaded_error", None, false),
            (CHAT, "server_error", Some("server_error"), false),
            ("/v1/responses", "server_error", Some("server_error"), true),
        ] {
            let (status, body) =
                reply(request(server.addr, path).await, Duration::from_secs(1)).await;
            assert_eq!(status, 503, "{body}");
            assert_eq!(body["error"]["type"], kind);
            assert_eq!(body["error"]["code"].as_str(), code);
            assert_eq!(
                body["error"].get("param"),
                param.then_some(&serde_json::Value::Null)
            );
        }
        let (status, body) = reply(waiting, Duration::from_secs(5)).await;
        assert_eq!(status, 503, "{body}");
        no_work(&server.app, &store).await;
        assert_reservation_refusals(server.addr, 3, 1, 0).await;
        drop(held);
        server.shutdown();
        server.wait().await.unwrap();
    }

    #[tokio::test]
    async fn pg_reservation_overload_refuses_a_closed_writer() {
        let Some((server, store)) = fixture().await else {
            return;
        };
        let app = server.app.clone();
        server.shutdown();
        server.wait().await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let serving = tokio::spawn({
            let app = app.clone();
            async move {
                for _ in 0..2 {
                    let (sock, _) = listener.accept().await.unwrap();
                    let app = app.clone();
                    hyper::server::conn::http1::Builder::new()
                        .serve_connection(
                            hyper_util::rt::TokioIo::new(sock),
                            hyper::service::service_fn(move |req| handle(app.clone(), req)),
                        )
                        .await
                        .unwrap();
                }
            }
        });
        let (status, body) = reply(request(addr, CHAT).await, Duration::from_secs(1)).await;
        assert_eq!(status, 503, "{body}");
        assert_eq!(
            body["error"]["message"],
            "request log writer is busy or unavailable"
        );
        assert_reservation_refusals(addr, 0, 0, 1).await;
        serving.await.unwrap();
        no_work(&app, &store).await;
    }

    #[tokio::test]
    async fn pg_reservation_overload_expires_without_work() {
        let Some((server, store)) = fixture().await else {
            return;
        };
        let held = server
            .app
            .deps
            .writer
            .reserve_finishes::<3>()
            .await
            .unwrap();
        let (status, body) = reply(request(server.addr, CHAT).await, Duration::from_secs(5)).await;
        assert_eq!(status, 503, "{body}");
        assert_eq!(
            body["error"]["message"],
            "request log writer is busy or unavailable"
        );
        no_work(&server.app, &store).await;
        drop(held);
        server.shutdown();
        server.wait().await.unwrap();
    }

    #[tokio::test]
    async fn pg_reservation_revalidates_a_key_revoked_during_the_wait() {
        let Some((server, store)) = fixture().await else {
            return;
        };
        let held = server
            .app
            .deps
            .writer
            .reserve_finishes::<3>()
            .await
            .unwrap();
        let waiting = request(server.addr, CHAT).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        // Mutate the primary without sending a routing publication. Do not
        // depend on the 500 ms snapshot backstop winning the race.
        store
            .client()
            .await
            .unwrap()
            .execute("UPDATE api_keys SET revoked_at=1", &[])
            .await
            .unwrap();
        drop(held);
        let (status, body) = reply(waiting, Duration::from_secs(2)).await;
        assert_eq!(status, 401, "{body}");
        assert_eq!(body["error"]["code"], "invalid_api_key");
        no_work(&server.app, &store).await;
        server.shutdown();
        server.wait().await.unwrap();
    }

    #[tokio::test]
    async fn pg_reservation_applies_the_guardrail_added_while_waiting() {
        let Some((server, store)) = fixture().await else {
            return;
        };
        let held = server
            .app
            .deps
            .writer
            .reserve_finishes::<3>()
            .await
            .unwrap();
        let waiting = request(server.addr, CHAT).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        store
            .client()
            .await
            .unwrap()
            .execute("UPDATE api_keys SET guardrail_policy='test policy'", &[])
            .await
            .unwrap();
        drop(held);
        let (status, body) = reply(waiting, Duration::from_secs(2)).await;
        assert_eq!(status, 500, "{body}");
        assert_eq!(
            body["error"]["message"],
            "usage policy check is not configured"
        );
        server.shutdown();
        server.wait().await.unwrap();
        let row = store
            .client()
            .await
            .unwrap()
            .query_one(
                "SELECT count(*) FROM request_logs WHERE status=500 AND state='done'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, i64>(0), 1);
    }

    #[tokio::test]
    async fn pg_reservation_obeys_fleet_screening_enabled_by_a_peer_during_the_wait() {
        let Some((cfg, store)) = fixture_config().await else {
            return;
        };
        store
            .client()
            .await
            .unwrap()
            .execute("UPDATE api_keys SET smart_routing=true", &[])
            .await
            .unwrap();
        let server = crate::start(
            cfg.clone(),
            crate::Options {
                writer_capacity: Some(3),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let peer = crate::start(cfg, crate::Options::default()).await.unwrap();
        let password = "private-fix3-admin-password";
        peer.app.admin.set_password(password).await.unwrap();
        let token = peer.app.admin.login(password).await.unwrap().unwrap();

        // Keep the waiting replica stale even if the test crosses a poll tick.
        server.snapshot_refresh.0.abort();
        server.snapshot_refresh.1.as_ref().unwrap().abort();
        let writer = &server.app.deps.writer;
        let held = writer.reserve_finishes::<3>().await.unwrap();
        let waiting = request(server.addr, CHAT).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while !matches!(
                writer.finish_waiter(),
                Err(omni_store::writer::ReserveError::Full)
            ) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("inference holds the only waiter turn");

        let mut admin = tokio::net::TcpStream::connect(peer.addr).await.unwrap();
        let mut settings = omni_store::settings::default_settings_json();
        settings["smartRouterEnabled"] = serde_json::Value::Bool(true);
        let body = settings.to_string();
        admin.write_all(format!("PUT /api/settings HTTP/1.1\r\nHost: localhost\r\nCookie: omni_admin={token}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        let (status, body) = reply(admin, Duration::from_secs(1)).await;
        assert_eq!(status, 200, "{body}");
        assert!(store.get_settings().await.unwrap().smart_router_enabled);
        assert!(
            !server
                .app
                .deps
                .holder
                .load()
                .routing
                .settings
                .smart_router_enabled
        );

        drop(held);
        let (status, body) = reply(waiting, Duration::from_secs(2)).await;
        assert_eq!(status, 500, "{body}");
        assert_eq!(
            body["error"]["message"],
            "confidential routing is not configured"
        );
        server.shutdown();
        peer.shutdown();
        server.wait().await.unwrap();
        peer.wait().await.unwrap();
    }

    #[tokio::test]
    #[allow(clippy::cast_precision_loss)]
    async fn pg_reservation_stamps_the_minute_at_admission_but_keeps_arrival_on_the_row() {
        let Some((server, store)) = fixture().await else {
            return;
        };
        let held = server
            .app
            .deps
            .writer
            .reserve_finishes::<3>()
            .await
            .unwrap();
        let waiting = request(server.addr, CHAT).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let released_at = crate::clock::now_ms();
        drop(held);
        let (_, body) = reply(waiting, Duration::from_secs(2)).await;
        assert_eq!(body["error"]["code"], "service_unavailable", "{body}");
        let key = server
            .app
            .deps
            .holder
            .load()
            .keys()
            .next()
            .unwrap()
            .id
            .clone();
        let now = crate::clock::now_ms() as f64;
        let window = server
            .app
            .redis
            .as_ref()
            .unwrap()
            .remote()
            .window_claim(&key, 60_000.0, now)
            .await
            .unwrap();
        assert_eq!(window.before.used, 1.0);
        assert!(
            window.before.reset_at - 60_000.0 >= released_at as f64,
            "minute stamp predates admission: {:?}",
            window.before
        );
        server.shutdown();
        server.wait().await.unwrap();
        let row = store
            .client()
            .await
            .unwrap()
            .query_one("SELECT at FROM request_logs", &[])
            .await
            .unwrap();
        assert!(row.get::<_, i64>(0) < released_at, "arrival time changed");
    }
}

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
                    if let Some(capture) = &mut fin.capture { capture.frame(": keepalive\n\n"); }
                    yield Ok::<_, std::io::Error>(Frame::data(Bytes::from_static(b": keepalive\n\n")));
                }
                Ok(Some(Ok(event))) => {
                    encoder.push_owned(event, &mut buf);
                    if let Some(capture) = &mut fin.capture { capture.frame(&buf); }
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
                                let start = buf.len();
                                encoder.push_owned(event, &mut buf);
                                if let Some(capture) = &mut fin.capture { capture.frame(&buf[start..]); }
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
                    if let Some(capture) = &mut fin.capture { capture.frame(&buf); }
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
            .consume_selected(&key.id, limits, &chat.model, now as f64)
            .await
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
            // These two auth diagnostics are produced verbatim by frozen TS.
            // Other internal errors (notably strict SQLite reader failures)
            // must not expose Rust table/column/storage-class details.
            let frozen_diagnostic = e.message.starts_with("JSON Parse error: ")
                || e.message == "api key configuration is unusable";
            let e = if e.code.http_status() == 500 && !frozen_diagnostic {
                GatewayError::new(ErrorCode::Internal, "internal error")
            } else {
                e
            };
            error_response(Dialect::Anthropic, &e, &[])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body::Body as _;

    /// IMF-fixdate, as `Date` must be sent (RFC 9110 §5.6.7).
    #[test]
    fn date_header_is_imf_fixdate() {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(784_111_777);
        assert_eq!(http_date(t), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(
            http_date(std::time::UNIX_EPOCH),
            "Thu, 01 Jan 1970 00:00:00 GMT"
        );
    }
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
