//! `dispatch` (`apps/gateway/src/dispatch/index.ts`, with `attempt.ts` and
//! `classify.ts`): resolve the model, rank its candidates, then try them in
//! order. Before the commit point (the first `blockDelta`) a retryable failure
//! moves to the next candidate; after it, a failure is forwarded in-stream.
//!
//! Resolution and ranking run eagerly, and the head candidate's load slot is
//! claimed then, as TS claims it before its generator starts. The attempts run
//! lazily inside the returned stream, so a streaming response's head goes out
//! before any upstream is called, exactly as in TS.
//!
//! Cancellation is structural: dropping the stream drops the upstream
//! [`omni_providers::EventStream`] (closing the socket) and every load slot and
//! probe claim this request holds.
//!
//! Health is applied to the in-memory snapshot under one lock (TS applies it
//! inside a store transaction) and written through the writer: a
//! [`BreakerTransition`] whenever the breaker state or `opened_at` changes, a
//! [`HealthMeasurement`] otherwise.

use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures_core::Stream;
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::js::safe_token;
use omni_ir::request::ChatRequest;
use omni_ir::stream::StreamEvent;
use omni_providers::adapter::{AdapterRequest, SendError};
use omni_providers::codec::Credentials;
use omni_providers::http::{HttpClient, HttpError};
use omni_router::{
    ExcludedKind, Failure, Providers, RankInput, blank_health, health_key, rank, record_failure,
    record_success, resolve_model, success_would_change,
};
use omni_store::writer::{
    BreakerTransition, HealthMeasurement, LogEvent, PendingLog, RequestLog, RouteTarget,
    WriterHandle,
};
use omni_store::{AuthType, BreakerState, Credential, CredentialHealth, Secret, Target};

use omni_gateway_core::snapshot::SnapshotHolder;

use crate::load::{LoadRegistry, LoadSlot, Probes};
use crate::price::price_of;

// Erase provider-specific send futures before entering the dispatch state
// machine, so each adapter shares a single bounded await slot.
fn send_provider<'a>(
    provider: &str,
    request: AdapterRequest<'a>,
    http: &'a dyn HttpClient,
) -> Pin<
    Box<
        dyn std::future::Future<Output = Result<omni_providers::adapter::AdapterResult, SendError>>
            + Send
            + 'a,
    >,
> {
    use omni_providers::adapter::send;
    match provider {
        "anthropic" => Box::pin(send(
            &omni_providers::anthropic::codec::AnthropicCodec,
            "anthropic",
            request,
            http,
        )),
        "openai" => Box::pin(send(
            &omni_providers::openai::OpenAiCodec,
            "openai",
            request,
            http,
        )),
        "antigravity" => Box::pin(send(
            &omni_providers::antigravity::codec::AntigravityCodec,
            "antigravity",
            request,
            http,
        )),
        _ => Box::pin(send(
            &omni_providers::custom::CustomCodec,
            omni_providers::custom::ID,
            request,
            http,
        )),
    }
}

/// Pre-commit buffering cap: events held before the first delta. Past
/// either bound the attempt commits (flushes and streams on); a failure
/// after that point is in-stream, with no failover.
pub const PENDING_MAX_EVENTS: usize = 4096;
/// The same cap in buffered event payload bytes (estimated).
pub const PENDING_MAX_BYTES: usize = 1024 * 1024;

/// A cheap upper estimate of an event's payload: its strings plus a fixed
/// overhead; native payloads count their serialized size.
fn event_size(e: &StreamEvent) -> usize {
    use omni_ir::stream::{ContentBlockStart, Delta};
    const BASE: usize = 64;
    BASE + match e {
        StreamEvent::Start { id, model } => id.len() + model.len(),
        StreamEvent::BlockStart { block, .. } => match block {
            ContentBlockStart::ToolUse { id, name } => id.len() + name.len(),
            ContentBlockStart::ProviderNative {
                block_type, data, ..
            } => {
                block_type.len()
                    + omni_ir::jsjson::to_string(
                        &omni_ir::deep::Owned(serde_json::Value::Object(omni_ir::deep::clone_map(
                            data,
                        )))
                        .0,
                    )
                    .len()
            }
            _ => 0,
        },
        StreamEvent::BlockDelta { delta, .. } => match delta {
            Delta::Text { text } | Delta::Thinking { text } => text.len(),
            Delta::ThinkingSignature { signature } => signature.len(),
            Delta::ToolJson { partial } => partial.len(),
            Delta::ProviderNativeJson { partial, .. } => partial.len(),
            Delta::ProviderNative { data, .. } => omni_ir::jsjson::to_string(
                &omni_ir::deep::Owned(serde_json::Value::Object(omni_ir::deep::clone_map(data))).0,
            )
            .len(),
        },
        StreamEvent::End { vendor, .. } => vendor.as_ref().map_or(0, |v| {
            omni_ir::jsjson::to_string(
                &omni_ir::deep::Owned(serde_json::Value::Object(omni_ir::deep::clone_map(v))).0,
            )
            .len()
        }),
        StreamEvent::Error { message, .. } => message.len(),
        StreamEvent::BlockEnd { .. } => 0,
    }
}

/// `DISPATCH_REFRESH_LEAD_MS`.
pub const REFRESH_LEAD_MS: i64 = 120_000;

/// The stream of a dispatch: events, then at most one `Err` (a throw TS lets
/// escape the generator), then the end.
pub type EventsStream = Pin<Box<dyn Stream<Item = Result<StreamEvent, GatewayError>> + Send>>;

/// What every dispatch shares: one per process.
pub struct Deps {
    pub refresher: Arc<crate::refresh::Refresher>,
    pub http: Arc<dyn HttpClient>,
    pub writer: WriterHandle,
    pub holder: Arc<SnapshotHolder>,
    pub load: Arc<LoadRegistry>,
    pub probes: Arc<Probes>,
    pub providers: Providers,
    /// This process's own recent health writes, by `healthKey`, with when
    /// they were made. Held under one lock, which also serializes the
    /// read-modify-write as TS's store transaction does. See [`HealthOverlay`].
    pub health: Arc<HealthOverlay>,
    /// `/metrics` series (off unless `OMNI_METRICS_TOKEN` is set).
    pub telemetry: Arc<crate::telemetry::Telemetry>,
    pub now: fn() -> i64,
    pub rand: fn() -> f64,
}

impl Deps {
    pub fn with_http(&self, http: Arc<dyn HttpClient>) -> Arc<Self> {
        Arc::new(Self {
            http,
            refresher: self.refresher.clone(),
            writer: self.writer.clone(),
            holder: self.holder.clone(),
            load: self.load.clone(),
            probes: self.probes.clone(),
            providers: self.providers.clone(),
            health: self.health.clone(),
            telemetry: self.telemetry.clone(),
            now: self.now,
            rand: self.rand,
        })
    }
}

pub use crate::overlay::HealthOverlay;

impl std::fmt::Debug for Deps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Deps").finish_non_exhaustive()
    }
}

/// One request handed to dispatch.
#[derive(Debug)]
pub struct Request {
    pub request: ChatRequest,
    pub request_id: String,
    /// The authenticated key, written on the pending row.
    pub api_key_id: Option<String>,
    /// The route's `startedAt`: the pending row's `at`.
    pub route_started_at: i64,
}

/// Per-call choices, independent of the installation's dispatch dependencies.
#[derive(Debug, Clone, Copy)]
pub struct DispatchOptions {
    /// Whether operator transforms may run. Both are currently unported;
    /// screening callers explicitly opt out rather than relying on defaults.
    pub request_transforms: bool,
    /// Revalidate the model against dispatch's own snapshot before routing.
    pub local_only: bool,
    /// Whether attempt selection writes pending/route rows. Classifier calls
    /// have their own completed row, never the parent's `onRoute` callback.
    pub on_route: bool,
}

impl Default for DispatchOptions {
    fn default() -> Self {
        Self {
            request_transforms: true,
            local_only: false,
            on_route: true,
        }
    }
}

/// `DispatchOutcome`: the events and the log they fill in.
pub struct Dispatched {
    pub deadline: Option<tokio::time::Instant>,
    pub events: EventsStream,
    /// Final once the stream has ended; the route completes the row from it.
    pub log: Arc<Mutex<RequestLog>>,
}

impl std::fmt::Debug for Dispatched {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dispatched").finish_non_exhaustive()
    }
}

/// A ranked candidate, owned so the lazy stream can carry it.
#[derive(Debug, Clone)]
struct Cand {
    credential: Credential,
    target: Target,
    probe: bool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `reasonField`: an upstream's words wait for debug.
fn reason_shown(e: &GatewayError) -> bool {
    e.provider.is_none() || e.gateway_authored || tracing::enabled!(tracing::Level::DEBUG)
}

/// `reportRejection`: the one line saying why a request failed.
pub fn report_rejection(log: &RequestLog, e: &GatewayError, surface: Option<&str>) {
    let reason = reason_shown(e).then_some(e.message.as_str());
    macro_rules! line {
        ($lvl:ident) => {
            tracing::$lvl!(
                requestId = %log.id,
                surface = surface,
                status = log.status,
                provider = log.resolved_provider.as_deref(),
                model = log.resolved_model.as_deref(),
                credentialId = log.credential_id.as_deref(),
                code = e.code.as_str(),
                attempts = log.attempts,
                reason = reason,
                "request rejected"
            )
        };
    }
    if e.code == ErrorCode::Internal {
        line!(error);
    } else {
        line!(warn);
    }
}

/// Node's own message for a transport failure, as `describeError` reads it.
pub fn describe_transport(e: &HttpError) -> String {
    match e {
        HttpError::Connect(io) => {
            let text = io.to_string();
            let addr = text.split(": ").next().unwrap_or("");
            let code = match io.kind() {
                std::io::ErrorKind::ConnectionRefused => Some("ECONNREFUSED"),
                std::io::ErrorKind::TimedOut => Some("ETIMEDOUT"),
                std::io::ErrorKind::ConnectionReset => Some("ECONNRESET"),
                _ => None,
            };
            match code {
                Some(_) if text.starts_with("every address failed") => "AggregateError".into(),
                Some(code) if addr.parse::<std::net::SocketAddr>().is_ok() => {
                    format!("connect {code} {addr}")
                }
                _ => text,
            }
        }
        HttpError::Dns { host, .. } => format!("getaddrinfo ENOTFOUND {host}"),
        HttpError::ConnectionClosed => "socket hang up".into(),
        HttpError::BodyAborted => "aborted".into(),
        other => other.to_string(),
    }
}

/// `classify` over what an attempt can raise.
fn classify_send(e: SendError) -> GatewayError {
    match e {
        SendError::Gateway(g) => g,
        SendError::Transport(h) => {
            let code = if h.is_network() {
                ErrorCode::Network
            } else {
                ErrorCode::Internal
            };
            GatewayError::new(code, describe_transport(&h))
        }
    }
}

/// `rewrap`: a fresh error keeping who wrote the message.
fn rewrap(e: &GatewayError) -> GatewayError {
    let mut out =
        GatewayError::new(e.code, e.message.clone()).with_retry_after_ms(e.retry_after_ms);
    out.provider = e.provider.clone();
    out.gateway_authored = e.gateway_authored;
    out
}

fn timeout_error() -> GatewayError {
    GatewayError::new(ErrorCode::Timeout, "request deadline exceeded")
}

fn note(log: &Mutex<RequestLog>, entries: &[String]) {
    let mut l = lock(log);
    for d in entries {
        if !l.degradations.contains(d) {
            l.degradations.push(d.clone());
        }
    }
}

#[allow(clippy::cast_possible_truncation)]
fn int(x: f64) -> i64 {
    x as i64
}

impl Deps {
    /// `persistHealth`: applies `transition` to the pair's current row.
    fn persist_health(
        &self,
        c: &Cand,
        transition: impl FnOnce(&CredentialHealth) -> CredentialHealth,
    ) -> CredentialHealth {
        let key = health_key(&c.credential.id, &c.target.model);
        let mut overlay = self.health.lock();
        let fresh = overlay.fresh(&key);
        let before = fresh.unwrap_or_else(|| {
            self.holder
                .load()
                .routing
                .health_of(&c.credential.id, &c.target.model)
                .cloned()
                .unwrap_or_else(|| blank_health(&c.credential.id, &c.target.model))
        });
        let after = transition(&before);
        // `deps.telemetry?.breaker(provider, before, after)`, inside apply.
        self.telemetry.breaker(
            &c.target.provider,
            &before.breaker_state,
            &after.breaker_state,
        );
        let decided =
            after.breaker_state != before.breaker_state || after.opened_at != before.opened_at;
        // A refused write is counted in the writer's `dropped` and warned
        // about by the writer task, rate-limited.
        if decided || before.scalar.is_some() || after.scalar.is_some() {
            self.writer.send(BreakerTransition(after.clone()));
        } else {
            self.writer.send(HealthMeasurement {
                credential_id: after.credential_id.clone(),
                model: after.model.clone(),
                consecutive_failures: after.consecutive_failures,
                rate_limited_until: after.rate_limited_until,
            });
        }
        overlay.insert(key, after.clone());
        self.holder.patch_health(after.clone());
        after
    }

    /// Shared OAuth refresh service for preemptive and reactive retries.
    async fn refresh(&self, c: &Credential) -> Result<omni_store::CredentialSecrets, GatewayError> {
        let result = self.refresher.refresh(c).await;
        match self
            .holder
            .refresh_credential(self.refresher.store.clone(), c.id.clone())
            .await
        {
            Ok(()) => {}
            Err(_) => {
                tracing::warn!(credentialId = %c.id, "credential snapshot publication failed; retaining previous snapshot")
            }
        }
        result
    }
}

fn credentials_of(c: &Credential, secrets: Option<&omni_store::CredentialSecrets>) -> Credentials {
    let secret = |s: &Secret| s.as_deref().map(str::to_owned);
    let (access_token, api_key) = match secrets {
        Some(s) => (secret(&s.access_token), secret(&s.api_key)),
        None if c.auth_type == AuthType::OAuth => (secret(c.inference_secret()), None),
        None => (None, secret(c.inference_secret())),
    };
    Credentials {
        access_token,
        api_key,
        provider_data: c
            .provider_data
            .as_object()
            .map(omni_ir::deep::clone_map)
            .unwrap_or_default(),
    }
}

/// A pre-dispatch screen's refusal: the error and the notes its row records.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: ErrorCode,
    pub message: &'static str,
    pub notes: &'static [&'static str],
}

/// `LOCAL_ONLY_MESSAGE`.
pub const LOCAL_ONLY_MESSAGE: &str = "confidential routing is not configured";

/// `screenFirst`'s refused branch: its own row (no attempt, no target) and
/// one in-stream `error` event, which the route renders exactly as any other
/// pre-commit failure.
pub fn refused(deps: &Deps, req: &Request, refusal: &Refusal, surface: &str) -> Dispatched {
    let mut log = RequestLog::new(req.request_id.clone(), req.route_started_at, 0);
    log.requested_model = req.request.model.clone();
    log.status = i64::from(refusal.code.http_status());
    log.error_code = Some(refusal.code.as_str().to_owned());
    log.duration_ms = (deps.now)() - req.route_started_at;
    log.degradations = refusal.notes.iter().map(|n| (*n).to_owned()).collect();
    report_rejection(
        &log,
        &GatewayError::new(refusal.code, refusal.message).gateway_authored(),
        Some(surface),
    );
    Dispatched {
        deadline: None,
        events: Box::pin(futures_util::stream::iter([Ok(StreamEvent::Error {
            code: refusal.code,
            message: refusal.message.to_owned(),
            retryable: refusal.code.retryable(),
        })])),
        log: Arc::new(Mutex::new(log)),
    }
}

/// `dispatch`. Returns once routing has been decided; the attempts run as
/// the returned stream is pulled.
pub fn dispatch(deps: Arc<Deps>, req: Request) -> Dispatched {
    dispatch_with_options(deps, req, DispatchOptions::default())
}

/// `dispatch` with the explicit screening-call choices used by classifiers.
#[allow(clippy::too_many_lines)]
pub fn dispatch_with_options(
    deps: Arc<Deps>,
    req: Request,
    options: DispatchOptions,
) -> Dispatched {
    let started_at = (deps.now)();
    deps.health.reconcile(&deps.holder);
    let snapshot = deps.holder.load();
    let settings = snapshot.routing.settings.clone();
    let deadline = (settings.request_deadline_ms != 0.0).then(|| {
        #[allow(clippy::cast_sign_loss)]
        let ms = settings.request_deadline_ms.max(0.0) as u64;
        tokio::time::Instant::now() + Duration::from_millis(ms)
    });
    let request_id = req.request_id.clone();
    let mut base = RequestLog::new(request_id.clone(), started_at, 0);
    base.requested_model = req.request.model.clone();
    let log = Arc::new(Mutex::new(base));

    let fail = |log: &Arc<Mutex<RequestLog>>, code: ErrorCode, message: String| -> EventsStream {
        {
            let mut l = lock(log);
            l.error_code = Some(code.as_str().to_owned());
            l.status = i64::from(code.http_status());
            l.duration_ms = (deps.now)() - started_at;
            report_rejection(&l, &GatewayError::new(code, message.clone()), None);
        }
        Box::pin(futures_util::stream::iter([Ok(StreamEvent::Error {
            code,
            message,
            retryable: code.retryable(),
        })]))
    };

    // RTK and ponytail run here in TS; both default off and neither is
    // ported, so the request goes as sent (see the report).
    let resolved = if options.local_only {
        omni_router::local_only_model(&req.request.model, &snapshot.routing, &deps.providers)
            .ok_or_else(|| GatewayError::new(ErrorCode::Internal, LOCAL_ONLY_MESSAGE))
    } else {
        resolve_model(&req.request.model, &snapshot.routing, &deps.providers)
    };
    let model = match resolved {
        Ok(m) => m.into_owned(),
        Err(e) => {
            let events = fail(&log, e.code, e.message);
            return Dispatched {
                events,
                log,
                deadline,
            };
        }
    };

    let counts = deps.load.counts();
    let recent = deps.load.recent();
    let ranked = rank(&RankInput {
        request: &req.request,
        model: &model,
        snapshot: &snapshot.routing,
        now: started_at as f64,
        rand: (deps.rand)(),
        load: Some(counts.as_ref()),
        recent: Some(recent.as_ref()),
        providers: Some(&deps.providers),
    });
    tracing::debug!(
        requestId = %request_id,
        requestedModel = %req.request.model,
        model = ranked.candidates.first().map(|c| c.target.model.as_str()),
        credentialId = ranked.candidates.first().map(|c| c.credential.id.as_str()),
        count = ranked.candidates.len(),
        "routing candidates ranked"
    );
    for e in &ranked.excluded {
        let entry = if e.kind == ExcludedKind::Target {
            format!("excluded:{}", e.reason)
        } else {
            format!("excluded:{}:{}", e.credential_id, e.reason)
        };
        note(&log, &[entry]);
        tracing::debug!(requestId = %request_id, reason = %e.reason, "routing candidate excluded");
    }
    let candidates: Vec<Cand> = ranked
        .candidates
        .iter()
        .filter(|c| {
            let unreadable = matches!(c.credential.inference_secret(), Secret::Unreadable(_));
            if unreadable {
                tracing::warn!(credentialId = %c.credential.id,
                    "credential secret unreadable; skipped for routing");
            }
            !unreadable
        })
        .map(|c| Cand {
            credential: c.credential.clone(),
            target: c.target.clone(),
            probe: c.probe,
        })
        .collect();
    drop(ranked);

    if let Some(trace) = deps.telemetry.trace(&request_id) {
        lock(&trace).route(
            started_at,
            started_at,
            (deps.now)(),
            crate::otlp::Attrs {
                candidates: Some(candidates.len()),
                chosen_provider: candidates.first().map(|c| c.target.provider.clone()),
                chosen_model: candidates.first().map(|c| c.target.model.clone()),
                ..crate::otlp::Attrs::default()
            },
        );
    }

    if candidates.is_empty() {
        let message = format!(
            "no eligible credential for model \"{}\"",
            safe_token(&req.request.model)
        );
        let events = fail(&log, ErrorCode::NoCandidates, message);
        return Dispatched {
            events,
            log,
            deadline,
        };
    }

    #[allow(clippy::cast_precision_loss)]
    let max_attempts = omni_ir::js::math_min(settings.max_attempts, candidates.len() as f64);
    let eager = deps.load.acquire(
        &candidates[0].credential.id,
        &candidates[0].target.model,
        &candidates[0].target.provider,
    );

    let events = run(RunState {
        deps,
        req,
        snapshot_health: snapshot,
        settings,
        candidates,
        max_attempts,
        eager: Some(eager),
        log: log.clone(),
        started_at,
        deadline,
        on_route: options.on_route,
    });
    Dispatched {
        events,
        log,
        deadline,
    }
}

struct RunState {
    deps: Arc<Deps>,
    req: Request,
    snapshot_health: Arc<omni_gateway_core::snapshot::GatewaySnapshot>,
    settings: omni_store::settings::Settings,
    candidates: Vec<Cand>,
    max_attempts: f64,
    eager: Option<LoadSlot>,
    log: Arc<Mutex<RequestLog>>,
    started_at: i64,
    deadline: Option<tokio::time::Instant>,
    on_route: bool,
}

/// Awaits `f` unless the deadline passes first.
async fn within<F: std::future::Future>(
    deadline: Option<tokio::time::Instant>,
    f: F,
) -> Result<F::Output, GatewayError> {
    match deadline {
        None => Ok(f.await),
        Some(at) => tokio::time::timeout_at(at, f)
            .await
            .map_err(|_| timeout_error()),
    }
}

#[allow(clippy::too_many_lines)]
fn run(mut s: RunState) -> EventsStream {
    let termination = s.deps.http.dispatch_scope(&s.req.request_id);
    Box::pin(async_stream::stream! {
        let _termination = termination;
        let deps = s.deps.clone();
        let now = deps.now;
        let log = s.log.clone();
        let rid = s.req.request_id.clone();
        let mut last_error: Option<GatewayError> = None;
        let mut attempts: u32 = 0;
        let mut began = false;
        let candidates = std::mem::take(&mut s.candidates);

        'candidates: for c in &candidates {
            if f64::from(attempts) >= s.max_attempts {
                break;
            }
            if s.deadline.is_some_and(|d| tokio::time::Instant::now() >= d) {
                last_error = Some(timeout_error());
                break;
            }
            let adopt = s.eager.as_ref().is_some_and(|e| {
                e.key() == health_key(&c.credential.id, &c.target.model)
            });
            let mut slot = if adopt {
                s.eager.take().unwrap_or_else(|| deps.load.acquire(&c.credential.id, &c.target.model, &c.target.provider))
            } else {
                deps.load.acquire(&c.credential.id, &c.target.model, &c.target.provider)
            };
            let success_writes = success_would_change(
                s.snapshot_health.routing.health_of(&c.credential.id, &c.target.model),
            );

            let mut probing = false;
            let mut _probe_claim = None;
            if c.probe {
                let key = format!("probe:{}", health_key(&c.credential.id, &c.target.model));
                let (held, claim) = deps.probes.acquire(&key);
                _probe_claim = Some(claim);
                if held > 0 {
                    note(&log, &[format!("excluded:{}:breaker:probing", c.credential.id)]);
                    tracing::debug!(requestId = %rid, credentialId = %c.credential.id,
                        reason = "breaker:probing", "routing candidate excluded");
                    let ttft = lock(&log).ttft_ms;
                    slot.release(ttft);
                    continue;
                }
                deps.persist_health(c, |cur| {
                    if cur.breaker_state == BreakerState::Closed {
                        return cur.clone();
                    }
                    probing = true;
                    CredentialHealth { breaker_state: BreakerState::HalfOpen, ..cur.clone() }
                });
            }

            let i = attempts;
            attempts += 1;
            let trace = deps.telemetry.trace(&rid);
            let attempt_span = trace.as_ref().map(|t| crate::otlp::Trace::attempt(t, s.started_at, now(), crate::otlp::Attrs {
                attempt: Some(i + 1), provider: Some(c.target.provider.clone()),
                model: Some(c.target.model.clone()), credential_id: Some(c.credential.id.clone()),
                ..crate::otlp::Attrs::default()
            }, now));
            {
                let mut l = lock(&log);
                l.attempts = i64::from(i + 1);
                l.credential_id = Some(c.credential.id.clone());
                l.resolved_provider = Some(c.target.provider.clone());
                l.resolved_model = Some(c.target.model.clone());
            }
            // `onRoute`: the pending row on the first attempt, a route update on each failover.
            // A refusal is counted in the writer's `dropped` and warned about
            // by the writer task, rate-limited; never a line per request.
            if s.on_route && began {
                deps.writer.send(LogEvent::Route {
                    id: rid.clone(),
                    target: RouteTarget {
                        provider: c.target.provider.clone(),
                        model: c.target.model.clone(),
                        credential_id: c.credential.id.clone(),
                    },
                });
            } else if s.on_route {
                began = true;
                deps.writer.send(LogEvent::Begin(PendingLog {
                    id: rid.clone(),
                    at: s.req.route_started_at,
                    api_key_id: s.req.api_key_id.clone(),
                    requested_model: s.req.request.model.clone(),
                    resolved_provider: Some(c.target.provider.clone()),
                    resolved_model: Some(c.target.model.clone()),
                    credential_id: Some(c.credential.id.clone()),
                }));
            }
            tracing::debug!(requestId = %rid, provider = %c.target.provider, model = %c.target.model,
                credentialId = %c.credential.id, attempt = i + 1, "attempt started");
            {
                let mut l = lock(&log);
                l.input_tokens = 0;
                l.output_tokens = 0;
                l.cache_read_tokens = 0;
                l.cache_write_tokens = 0;
                l.ttft_ms = None;
            }

            let mut committed = false;
            let mut closed_at_commit = false;
            let mut auth_refresh_retried = false;
            let mut retry_secrets: Option<omni_store::CredentialSecrets> = None;
            let attempt_now = now();
            let preemptive_refresh_required = c.credential.auth_type == AuthType::OAuth
                && c.credential.expires_at.is_some_and(|at| at.saturating_sub(REFRESH_LEAD_MS) <= attempt_now);

            if c.target.provider != omni_providers::custom::ID && c.target.provider != "anthropic" && c.target.provider != "openai" && c.target.provider != "antigravity" {
                let ttft = lock(&log).ttft_ms;
                slot.release(ttft);
                yield Err(GatewayError::new(
                    ErrorCode::Internal,
                    format!("no adapter for provider {}", c.target.provider),
                ));
                return;
            }

            loop {
                // ---- attempt (`attempt.ts`)
                let attempt: Result<(), GatewayError> = 'attempt: {
                    let stale = retry_secrets.is_none() && preemptive_refresh_required;
                    if stale {
                        if !c.credential.has_refresh_token {
                            break 'attempt Err(GatewayError::new(
                                ErrorCode::Auth,
                                "credential expired with no refresh token",
                            ).with_provider(c.credential.provider.clone()));
                        }
                        match within(s.deadline, Box::pin(deps.refresh(&c.credential))).await.and_then(|r| r) {
                            Ok(sec) => retry_secrets = Some(sec),
                            Err(e) => break 'attempt Err(e),
                        }
                    }
                    let creds = credentials_of(&c.credential, retry_secrets.as_ref());
                    let mut ar = AdapterRequest::new(&s.req.request, &c.target.model, &creds);
                    ar.request_id = Some(&rid);
                    ar.auto_cache = Some(s.settings.auto_cache_enabled);
                    ar.max_output_tokens = c.target.max_output_tokens;
                    #[allow(clippy::cast_precision_loss)]
                    {
                        ar.request_started_at = Some(s.started_at as f64);
                    }
                    let sent = within(s.deadline, send_provider(&c.target.provider, ar, deps.http.as_ref())).await;
                    let mut result = match sent {
                        Err(t) => break 'attempt Err(t),
                        Ok(Err(e)) => break 'attempt Err(classify_send(e)),
                        Ok(Ok(r)) => r,
                    };
                    note(&log, &result.degradations);
                    if let Some(n) = result.cloaked_tools {
                        tracing::debug!(requestId = %rid, cloakedTools = n, "tool names cloaked");
                    }

                    let mut terminal = false;
                    let mut pending: Vec<StreamEvent> = Vec::new();
                    let mut pending_bytes: usize = 0;
                    loop {
                        let next = match within(s.deadline, result.events.next()).await {
                            Err(t) => break 'attempt Err(t),
                            Ok(n) => n,
                        };
                        let event = match next {
                            None => break,
                            Some(Err(e)) => break 'attempt Err(e),
                            Some(Ok(ev)) => ev,
                        };
                        // Past the buffering cap the attempt commits as if a
                        // delta had arrived: no failover after this point. The
                        // incoming event counts, so one oversized event commits
                        // (and is flushed) rather than being held.
                        let size = event_size(&event);
                        let over_cap = !committed
                            && !matches!(event, StreamEvent::End { .. } | StreamEvent::Error { .. })
                            && (pending.len() + 1 > PENDING_MAX_EVENTS
                                || pending_bytes + size >= PENDING_MAX_BYTES);
                        if (matches!(event, StreamEvent::BlockDelta { .. }) || over_cap) && !committed {
                            committed = true;
                            let ttft = now() - s.started_at;
                            lock(&log).ttft_ms = Some(ttft);
                            if matches!(event, StreamEvent::BlockDelta { .. }) && let Some(t) = &trace {
                                lock(t).commit(s.started_at, now(), &c.target.provider, &c.target.model);
                            }
                            slot.observed(ttft);
                            tracing::debug!(requestId = %rid, provider = %c.target.provider,
                                model = %c.target.model, credentialId = %c.credential.id,
                                attempt = i + 1, ttftMs = ttft, "stream committed");
                            for buffered in pending.drain(..) {
                                yield Ok(buffered);
                            }
                            if probing {
                                deps.persist_health(c, record_success);
                                probing = false;
                                closed_at_commit = true;
                            }
                        }
                        let is_end = matches!(event, StreamEvent::End { .. });
                        if let StreamEvent::End { usage, .. } = &event {
                            terminal = true;
                            let mut l = lock(&log);
                            l.input_tokens = int(usage.input_tokens);
                            l.output_tokens = int(usage.output_tokens);
                            l.cache_read_tokens = int(usage.cache_read_tokens);
                            l.cache_write_tokens = int(usage.cache_write_tokens);
                            l.cost_usd = price_of(&c.target.cost_per_m_tok, usage, &c.target.provider);
                        }
                        if let StreamEvent::Error { code, message, .. } = &event {
                            let (code, message) = (*code, message.clone());
                            if !committed && code.retryable() {
                                break 'attempt Err(GatewayError::new(code, message)
                                    .with_provider(c.target.provider.clone()));
                            }
                            {
                                let mut l = lock(&log);
                                l.status = i64::from(code.http_status());
                                l.error_code = Some(code.as_str().to_owned());
                                l.duration_ms = now() - s.started_at;
                                report_rejection(&l, &GatewayError::new(code, message)
                                    .with_provider(c.target.provider.clone()), None);
                            }
                            yield Ok(event);
                            deps.persist_health(c, |cur| record_failure(cur, &Failure {
                                settings: &s.settings,
                                #[allow(clippy::cast_precision_loss)]
                                now: now() as f64,
                                code,
                                retry_after_ms: None,
                                jitter: (deps.rand)(),
                            }));
                            let ttft = lock(&log).ttft_ms;
                            slot.release(ttft);
                            return;
                        }
                        if !committed && !is_end {
                            pending_bytes += size;
                            pending.push(event);
                        } else {
                            if !committed {
                                for buffered in pending.drain(..) {
                                    yield Ok(buffered);
                                }
                            }
                            yield Ok(event);
                        }
                        if is_end {
                            break;
                        }
                    }
                    if !terminal {
                        break 'attempt Err(GatewayError::new(
                            ErrorCode::Upstream,
                            "upstream stream ended without a terminal event",
                        ));
                    }
                    Ok(())
                };

                let error = match attempt {
                    Ok(()) => {
                        if success_writes && !closed_at_commit {
                            deps.persist_health(c, record_success);
                        }
                        {
                            let mut l = lock(&log);
                            l.status = 200;
                            l.error_code = None;
                            l.duration_ms = now() - s.started_at;
                        }
                        let ttft = lock(&log).ttft_ms;
                        slot.release(ttft);
                        return;
                    }
                    Err(e) => e,
                };

                // ---- the attempt's catch
                let classified = if s.deadline.is_some_and(|d| tokio::time::Instant::now() >= d)
                    && error.code != ErrorCode::Timeout
                {
                    let mut t = rewrap(&error);
                    t.code = ErrorCode::Timeout;
                    t.retryable = true;
                    t
                } else {
                    rewrap(&error)
                };
                note(&log, &error.degradations);
                let mut failure = classified;
                if let Some(span) = &attempt_span { span.code(failure.code.as_str()); }

                if failure.code == ErrorCode::Auth
                    && !committed
                    && !auth_refresh_retried
                    && !preemptive_refresh_required
                    && c.credential.auth_type == AuthType::OAuth
                    && c.credential.has_refresh_token
                {
                    auth_refresh_retried = true;
                    tracing::warn!(requestId = %rid, provider = %c.target.provider,
                        model = %c.target.model, credentialId = %c.credential.id,
                        attempt = i + 1, code = failure.code.as_str(),
                        "attempt authentication failed; refreshing credential");
                    match within(s.deadline, Box::pin(deps.refresh(&c.credential))).await.and_then(|r| r) {
                        Ok(sec) => {
                            retry_secrets = Some(sec);
                            continue;
                        }
                        Err(re) => {
                            failure = rewrap(&re);
                            tracing::warn!(requestId = %rid, provider = %c.target.provider,
                                credentialId = %c.credential.id, attempt = i + 1,
                                code = failure.code.as_str(),
                                reason = reason_shown(&failure).then_some(failure.message.as_str()),
                                "credential refresh failed");
                        }
                    }
                }

                deps.persist_health(c, |cur| record_failure(cur, &Failure {
                    settings: &s.settings,
                    #[allow(clippy::cast_precision_loss)]
                    now: now() as f64,
                    code: failure.code,
                    retry_after_ms: failure.retry_after_ms,
                    jitter: (deps.rand)(),
                }));

                if !committed && failure.code.retryable() && f64::from(attempts) < s.max_attempts {
                    tracing::warn!(requestId = %rid, provider = %c.target.provider,
                        model = %c.target.model, credentialId = %c.credential.id,
                        attempt = i + 1, code = failure.code.as_str(), retryable = true,
                        retryAfterMs = failure.retry_after_ms, "attempt failed; retrying");
                }

                if committed {
                    {
                        let mut l = lock(&log);
                        l.status = i64::from(failure.code.http_status());
                        l.error_code = Some(failure.code.as_str().to_owned());
                        l.duration_ms = now() - s.started_at;
                        report_rejection(&l, &failure, None);
                    }
                    let ttft = lock(&log).ttft_ms;
                    slot.release(ttft);
                    yield Ok(StreamEvent::Error {
                        code: failure.code,
                        message: failure.message,
                        retryable: false,
                    });
                    return;
                }
                let retryable = failure.code.retryable();
                last_error = Some(failure);
                let ttft = lock(&log).ttft_ms;
                slot.release(ttft);
                if !retryable {
                    break 'candidates;
                }
                continue 'candidates;
            }
        }

        let untried = attempts == 0 && last_error.is_none();
        let code = match &last_error {
            Some(e) if e.code == ErrorCode::Timeout => ErrorCode::Timeout,
            Some(e) if !e.code.retryable() => e.code,
            _ if untried => ErrorCode::NoCandidates,
            _ => ErrorCode::AllCandidatesFailed,
        };
        let message = match &last_error {
            Some(e) => e.message.clone(),
            None if untried => format!(
                "no eligible credential for model \"{}\"",
                safe_token(&s.req.request.model)
            ),
            None => "all candidates failed".to_owned(),
        };
        {
            let mut l = lock(&log);
            l.status = i64::from(code.http_status());
            l.error_code = Some(code.as_str().to_owned());
            l.duration_ms = now() - s.started_at;
            let mut reported = GatewayError::new(code, message.clone());
            if let Some(e) = &last_error
                && e.provider.is_some()
            {
                reported.provider = e.provider.clone();
                reported.gateway_authored = e.gateway_authored;
            }
            report_rejection(&l, &reported, None);
        }
        drop(s.eager.take());
        yield Ok(StreamEvent::Error { code, message, retryable: false });
    })
}
