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

/// Everything a request handler reads. One per process.
pub struct App {
    pub deps: Arc<Deps>,
    pub limiter: Arc<RateLimiter>,
    pub miss: MissResolver,
    pub node_id: String,
    /// `KEEPALIVE_MS`; Responses streams use `min(this, 4 s)`.
    pub keepalive: Duration,
    /// Longest wait for the next byte of a request body.
    pub idle_timeout: Duration,
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App")
            .field("node_id", &self.node_id)
            .finish_non_exhaustive()
    }
}

const RESPONSES_KEEPALIVE: Duration = Duration::from_secs(4);

fn full(body: impl Into<Bytes>) -> Body {
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
fn not_found_get(path: &str) -> Response<Body> {
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
pub async fn handle(app: Arc<App>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    let path = req.uri().path().to_owned();
    // Elysia matches a route with one trailing slash as the route itself.
    let route = if path.len() > 1 && path.ends_with('/') && !path.ends_with("//") {
        &path[..path.len() - 1]
    } else {
        path.as_str()
    };
    let method = req.method().clone();
    let res = match (method.clone(), route) {
        (Method::GET | Method::HEAD, "/health") => health(&app),
        (Method::POST, "/v1/messages") => proxy(app, Surface::Anthropic, req).await,
        (Method::POST, "/v1/chat/completions") => proxy(app, Surface::OpenAi, req).await,
        (Method::POST, "/v1/responses") => proxy(app, Surface::Responses, req).await,
        (Method::POST, "/v1/messages/count_tokens") => count_tokens(app, req).await,
        (Method::GET | Method::HEAD, "/v1/models") => models(&app, &req).await,
        (Method::GET | Method::HEAD, _) => not_found_get(&path),
        _ => not_found_other(),
    };
    Ok(res)
}

fn health(app: &App) -> Response<Body> {
    let mut body = String::from("{\"ok\":true,\"mode\":\"single\",\"nodeId\":");
    omni_ir::jsjson::write_str(&app.node_id, &mut body);
    body.push_str(",\"coord\":\"ok\"}");
    json_response(200, JSON_UTF8, body, &[])
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
                            tracing::debug!(apiKeyId = %key.id, "key found but not in snapshot");
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
    let text = String::from_utf8_lossy(&bytes);
    Ok(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => text.into_owned(),
    })
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
fn hang_up() -> Response<Body> {
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
        omni_dialects::ingress::check_model_allowlist(&chat.model, key.model_allowlist.as_deref())?;
        fin.requested_model = chat.model.clone();
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
        fin.outcome = Some(dispatched.log.clone());

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
            let body = sse_body(dispatched.events, encoder, keepalive, fin.take());
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
        let mut s = dispatched.events;
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
                let collected = omni_ir::stream::collect(events);
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
        loop {
            let next = tokio::time::timeout(keepalive, events.next()).await;
            match next {
                Err(_) => {
                    yield Ok::<_, std::io::Error>(Frame::data(Bytes::from_static(b": keepalive\n\n")));
                }
                Ok(Some(Ok(event))) => {
                    encoder.push_owned(event, &mut buf);
                    if !buf.is_empty() {
                        let frame = Bytes::copy_from_slice(buf.as_bytes());
                        buf.clear();
                        yield Ok(Frame::data(frame));
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
        let chat = ingest_body(Surface::Anthropic, &body, &headers)?.request;
        omni_dialects::ingress::check_model_allowlist(&chat.model, key.model_allowlist.as_deref())?;
        #[allow(clippy::cast_precision_loss)]
        app.limiter
            .consume(&key.id, &key.limits, &chat.model, now as f64)
            .map_err(|r| r.to_gateway_error())?;
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
            let allowed: Option<HashSet<&str>> = key
                .model_allowlist
                .as_ref()
                .map(|l| l.iter().map(String::as_str).collect());
            let visible: Vec<&omni_store::VirtualModel> = ids
                .into_iter()
                .filter(|id| allowed.as_ref().is_none_or(|a| a.contains(id.as_str())))
                .filter_map(|id| snapshot.routing.models.get(id))
                .collect();
            json_response(200, JSON_UTF8, crate::models::list_body(&visible), &[])
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
}
