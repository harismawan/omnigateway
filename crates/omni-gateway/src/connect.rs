//! Browser OAuth with expiring coordinator pending state.
use crate::{
    api::{ApiError, json_ok, read_json, require_admin},
    server::{App, Body},
};
use hyper::{Request, Response, body::Incoming};
use omni_control::settings_value::{get, trim_units};
use omni_coord::{Coord, MemoryCoord};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    jsjson::{JsValue, parse_js, stringify},
};
use omni_providers::oauth::{AuthorizeStart, DeviceError, FlowResult, PendingFlow};
use std::sync::Arc;

type Result<T> = std::result::Result<T, GatewayError>;
const PROVIDERS: &[(&str, &str)] = &[
    ("anthropic", ""),
    ("openai", "http://localhost:1455/auth/callback"),
    ("antigravity", "https://antigravity.google/oauth-callback"),
    ("kimi", ""),
    ("kilo", ""),
    ("grok", "http://127.0.0.1:56121/callback"),
    ("muse", ""),
    ("qoder", ""),
];
fn bad(s: &str) -> GatewayError {
    GatewayError::new(ErrorCode::BadRequest, s)
}
fn internal() -> GatewayError {
    GatewayError::new(ErrorCode::Internal, "internal error")
}
fn text(v: Option<&JsValue>) -> Option<String> {
    match v {
        Some(JsValue::String(s)) => Some(String::from_utf16_lossy(s)),
        _ => None,
    }
}
fn string(s: &str) -> JsValue {
    JsValue::String(s.encode_utf16().collect())
}
fn object(fields: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}

type Flight = tokio::sync::watch::Sender<Option<Result<String>>>;
pub struct ConnectFlows {
    coord: Arc<dyn Coord>,
    flights: std::sync::Mutex<std::collections::HashMap<String, Flight>>,
}
impl Default for ConnectFlows {
    fn default() -> Self {
        Self::new(Arc::new(MemoryCoord::new(omni_coord::system_clock())))
    }
}
impl ConnectFlows {
    pub fn new(coord: Arc<dyn Coord>) -> Self {
        Self {
            coord,
            flights: std::sync::Mutex::default(),
        }
    }
    async fn poll(
        self: &Arc<Self>,
        host: Arc<crate::refresh::Refresher>,
        holder: Arc<omni_gateway_core::snapshot::SnapshotHolder>,
        id: String,
    ) -> Result<String> {
        let mut rx = {
            let mut flights = self
                .flights
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(tx) = flights.get(&id) {
                tx.subscribe()
            } else {
                let (tx, rx) = tokio::sync::watch::channel(None);
                flights.insert(id.clone(), tx.clone());
                let owner = self.clone();
                let key = id.clone();
                tokio::spawn(async move {
                    let result = match owner.pending(&key, false).await {
                        // Device flights peek: the flow must survive a pending
                        // answer so the next poll can ask again.
                        Ok(flow) if device_flow(&flow) => {
                            owner.device_complete(&host, &holder, &key, flow).await
                        }
                        Ok(_) => match owner.pending(&key, true).await {
                            Ok(flow) => complete(host, holder, flow, "").await,
                            Err(e) => Err(e),
                        },
                        Err(e) => Err(e),
                    };
                    owner
                        .flights
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .remove(&key);
                    tx.send_replace(Some(result));
                });
                rx
            }
        };
        loop {
            if let Some(result) = rx.borrow().clone() {
                break result;
            }
            rx.changed().await.map_err(|_| internal())?;
        }
    }
    async fn finish(&self, app: &App, id: &str, code: &str) -> Result<String> {
        let flow = self.pending(id, true).await?;
        let provider = text(get(&flow, "provider")).ok_or_else(internal)?;
        let pending = pending_value(&flow)?;
        let code = normalize(&provider, &pending, code)?;
        finish_exchange(
            app.deps.refresher.clone(),
            app.deps.holder.clone(),
            flow,
            code,
        )
        .await
    }
    async fn pending(&self, id: &str, take: bool) -> Result<JsValue> {
        let key = format!("oauth:pending:{id}");
        if take {
            return omni_coord::with_lock(
                self.coord.as_ref(),
                &key,
                10_000,
                std::time::Duration::from_secs(1),
                || self.read_pending(&key, true),
            )
            .await
            .map_err(|_| internal())?;
        }
        self.read_pending(&key, false).await
    }

    async fn read_pending(&self, key: &str, take: bool) -> Result<JsValue> {
        let raw = self
            .coord
            .kv_get(key)
            .await
            .map_err(|_| internal())?
            .ok_or_else(|| bad("unknown or expired authorization"))?;
        if take {
            self.coord.kv_del(key).await.map_err(|_| internal())?;
        }
        parse_js(&raw).map_err(|_| internal())
    }
    async fn start(&self, app: &App, body: &JsValue) -> Result<String> {
        let provider = text(get(body, "provider"));
        let (provider, redirect) = PROVIDERS
            .iter()
            .find(|(p, _)| Some(*p) == provider.as_deref())
            .ok_or_else(|| {
                bad(&format!(
                    "provider must be one of {}",
                    PROVIDERS
                        .iter()
                        .map(|(p, _)| *p)
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?;
        let credential = if let Some(v) = get(body, "credentialId") {
            let id = text(Some(v)).ok_or_else(|| bad("invalid credential for reconnect"))?;
            let id = omni_ir::js::trim(&id).to_owned();
            if id.is_empty() {
                return Err(bad("invalid credential for reconnect"));
            }
            let row = app
                .deps
                .refresher
                .store
                .credential(&app.credential_key, &id)
                .await
                .map_err(|_| internal())?;
            if !row.is_some_and(|r| {
                r.provider == *provider && r.auth_type == omni_store::AuthType::OAuth
            }) {
                return Err(bad("invalid credential for reconnect"));
            }
            Some(id)
        } else {
            None
        };
        let label = match get(body, "label") {
            Some(JsValue::String(s)) if !trim_units(s).is_empty() => {
                JsValue::String(trim_units(s).to_vec())
            }
            _ => string(provider),
        };
        if *provider == "kimi" {
            // Device begin: mint the identity locally, then ask upstream for a
            // device code before the operator is shown anything.
            let initial = omni_providers::kimi::oauth::start();
            let device_id = omni_providers::kimi::oauth::minted_device_id(&initial)?;
            let request = omni_providers::kimi::oauth::begin_request(&device_id)?;
            let mut runner = crate::oauth_runner::ExchangeRunner::new(
                app.deps.refresher.http.as_ref(),
                crate::oauth_runner::ExchangeConfig {
                    provider: "kimi",
                    step: "begin",
                    max_requests: 1,
                    origins: crate::oauth_runner::Origins::Allowlist(
                        omni_providers::kimi::oauth::AUTH_ORIGINS,
                    ),
                },
            );
            let response = runner.send(request, 30).await?;
            let start =
                omni_providers::kimi::oauth::begin_result(response.0, &response.1, &device_id)?;
            return self
                .store_flow(provider, label, credential, &start, "device", false)
                .await;
        }
        if *provider == "kilo" {
            // Device begin: Kilo mints no client identity and needs no PKCE
            // pair, so the whole start of the flow is this single POST.
            let request = omni_providers::kilo::oauth::begin_request();
            let mut runner = crate::oauth_runner::ExchangeRunner::new(
                app.deps.refresher.http.as_ref(),
                crate::oauth_runner::ExchangeConfig {
                    provider: "kilo",
                    step: "begin",
                    max_requests: 1,
                    origins: crate::oauth_runner::Origins::Allowlist(
                        omni_providers::kilo::oauth::AUTH_ORIGINS,
                    ),
                },
            );
            let response = runner.send(request, 30).await?;
            #[allow(clippy::cast_precision_loss)]
            let now = (app.deps.refresher.now)() as f64;
            let start = omni_providers::kilo::oauth::begin_result(response.0, &response.1, now)?;
            return self
                .store_flow(provider, label, credential, &start, "device", false)
                .await;
        }
        if *provider == "muse" {
            // Device begin: Muse mints no client identity and needs no PKCE
            // pair, so the whole start of the flow is this single POST.
            let request = omni_providers::muse::oauth::begin_request();
            let mut runner = crate::oauth_runner::ExchangeRunner::new(
                app.deps.refresher.http.as_ref(),
                crate::oauth_runner::ExchangeConfig {
                    provider: "muse",
                    step: "begin",
                    max_requests: 1,
                    origins: crate::oauth_runner::Origins::Allowlist(
                        omni_providers::muse::oauth::AUTH_ORIGINS,
                    ),
                },
            );
            let response = runner.send(request, 30).await?;
            let start = omni_providers::muse::oauth::begin_result(response.0, &response.1)?;
            return self
                .store_flow(provider, label, credential, &start, "device", false)
                .await;
        }
        if *provider == "grok" {
            // Discovery first: the authorize URL is published by xAI's OIDC
            // metadata, validated against the x.ai https rule before use.
            let mut runner = crate::oauth_runner::ExchangeRunner::new(
                app.deps.refresher.http.as_ref(),
                crate::oauth_runner::ExchangeConfig {
                    provider: "grok",
                    step: "start",
                    max_requests: 1,
                    origins: crate::oauth_runner::Origins::Validator(
                        &omni_providers::grok::oauth::trusted_origin,
                    ),
                },
            );
            let response = runner
                .send(omni_providers::grok::oauth::discovery_request(), 15)
                .await?;
            let endpoints = omni_providers::grok::oauth::discovery_result(response.0, &response.1)?;
            let (verifier, challenge) = omni_providers::oauth::pkce();
            let state = omni_providers::oauth::random_state();
            let start = omni_providers::grok::oauth::start(
                &endpoints.authorize_url,
                redirect,
                &verifier,
                &challenge,
                &state,
            )?;
            return self
                .store_flow(provider, label, credential, &start, "pkce", true)
                .await;
        }
        if *provider == "qoder" {
            // Local begin: PKCE and a synthetic machine identity, zero HTTP.
            // A reconnect keeps the identity the credential was minted with.
            let prior = if let Some(id) = &credential {
                app.deps
                    .refresher
                    .store
                    .credential(&app.credential_key, id)
                    .await
                    .map_err(|_| internal())?
                    .map(|c| c.provider_data)
            } else {
                None
            };
            #[allow(clippy::cast_precision_loss)]
            let now = (app.deps.refresher.now)() as f64;
            let start = omni_providers::qoder::oauth::begin(
                prior.as_ref().and_then(serde_json::Value::as_object),
                now,
            );
            return self
                .store_flow(provider, label, credential, &start, "device", false)
                .await;
        }
        let (verifier, challenge) = omni_providers::oauth::pkce();
        let state = omni_providers::oauth::random_state();
        let start = if *provider == "openai" {
            omni_providers::openai::oauth::start(redirect, &verifier, &challenge, &state)
        } else if *provider == "antigravity" {
            omni_providers::antigravity::oauth::start(&verifier, &challenge, &state)
        } else {
            omni_providers::anthropic::oauth::start(&verifier, &challenge, &state)
        };
        self.store_flow(provider, label, credential, &start, "pkce", true)
            .await
    }

    /// Stores the pending flow and builds the start reply, for pkce starts and
    /// device `begin` results alike. Device begins carry deviceCode/interval/
    /// extra on the pending plus a userCode; pkce leaves them unset and keeps
    /// its existing reply bytes.
    async fn store_flow(
        &self,
        provider: &str,
        label: JsValue,
        credential: Option<String>,
        start: &AuthorizeStart,
        kind: &str,
        supports_manual_paste: bool,
    ) -> Result<String> {
        let pending = &start.pending;
        let mut pending_fields = vec![
            ("verifier", string(&pending.verifier)),
            ("challenge", string(&pending.challenge)),
            ("state", string(&pending.state)),
            ("redirectUri", string(&pending.redirect_uri)),
        ];
        if let Some(code) = &pending.device_code {
            pending_fields.push(("deviceCode", string(code)));
        }
        if let Some(interval) = pending.interval {
            pending_fields.push(("interval", JsValue::Number(interval)));
        }
        if !pending.extra.is_empty() {
            let extra = omni_ir::jsjson::to_string(&serde_json::Value::Object(
                omni_ir::deep::clone_map(&pending.extra),
            ));
            pending_fields.push(("extra", parse_js(&extra).map_err(|_| internal())?));
        }
        let mut fields = vec![
            ("provider", string(provider)),
            ("label", label),
            ("pending", object(pending_fields)),
        ];
        if let Some(id) = credential {
            fields.push(("credentialId", string(&id)));
        }
        if let Some(code) = &start.user_code {
            fields.push(("userCode", string(code)));
        }
        let id = omni_providers::oauth::random_state();
        self.coord
            .kv_set(
                &format!("oauth:pending:{id}"),
                &stringify(&object(fields)).ok_or_else(internal)?,
                600_000,
            )
            .await
            .map_err(|_| internal())?;
        stringify(&object(vec![
            ("flowId", string(&id)),
            ("authorizeUrl", string(&start.authorize_url)),
            (
                "userCode",
                start.user_code.as_deref().map_or(JsValue::Null, string),
            ),
            ("kind", string(kind)),
            ("supportsManualPaste", JsValue::Bool(supports_manual_paste)),
            (
                "pollIntervalMs",
                JsValue::Number(pending.interval.unwrap_or(5.0) * 1000.0),
            ),
        ]))
        .ok_or_else(internal)
    }

    /// One device exchange per poll. Pending keeps the flow for the next poll;
    /// completion takes it under the coordinator lock before persisting, and a
    /// terminal failure consumes it.
    async fn device_complete(
        &self,
        host: &Arc<crate::refresh::Refresher>,
        holder: &Arc<omni_gateway_core::snapshot::SnapshotHolder>,
        id: &str,
        flow: JsValue,
    ) -> Result<String> {
        let provider = text(get(&flow, "provider")).ok_or_else(internal)?;
        let pending = pending_value(&flow)?;
        let reconnect = text(get(&flow, "credentialId"));
        let prior = if let Some(credential) = &reconnect {
            Some(
                host.store
                    .credential(&host.key, credential)
                    .await
                    .map_err(|_| internal())?
                    .ok_or_else(|| bad("credential not found"))?,
            )
        } else {
            None
        };
        let data = prior
            .as_ref()
            .filter(|c| c.provider == provider)
            .map_or(&serde_json::Value::Null, |c| &c.provider_data);
        match device_exchange(&provider, host, &pending, data).await {
            Ok(result) => {
                self.pending(id, true).await?;
                persist_flow_result(host.clone(), holder.clone(), &flow, result).await
            }
            Err(DeviceError::Pending) => Err(pending_signal()),
            Err(DeviceError::Gateway(error)) => {
                // An already expired flow is gone either way.
                drop(self.pending(id, true).await);
                Err(error)
            }
        }
    }
}
pub async fn serve(
    app: &App,
    req: Request<Incoming>,
    route: &str,
) -> std::result::Result<Response<Body>, ApiError> {
    require_admin(req.headers(), &app.admin).await?;
    let body = read_json(req, app.idle_timeout).await?;
    let result = match route {
        "start" => app.connect.start(app, &body).await,
        "finish" if text(get(&body, "flowId")).is_none() || text(get(&body, "code")).is_none() => {
            Err(bad("flowId and code are required"))
        }
        "poll" if text(get(&body, "flowId")).is_none() => Err(bad("flowId is required")),
        "finish" => app
            .connect
            .finish(
                app,
                &text(get(&body, "flowId")).unwrap_or_default(),
                &text(get(&body, "code")).unwrap_or_default(),
            )
            .await
            .map(|id| serde_json::json!({"id":id}).to_string()),
        _ => poll_reply(
            app.connect
                .poll(
                    app.deps.refresher.clone(),
                    app.deps.holder.clone(),
                    text(get(&body, "flowId")).unwrap_or_default(),
                )
                .await,
        ),
    };
    result.map(json_ok).map_err(ApiError::Gateway)
}

/// A device poll's "not approved yet" travels through the flight channel's
/// `Result<String>` as a marked error (the TS `pendingError` marker); only
/// `poll_reply` translates it, so pkce replies keep their exact bytes.
const PENDING_MARKER: &str = "__omni_authorization_pending";
fn pending_signal() -> GatewayError {
    GatewayError::new(ErrorCode::Auth, PENDING_MARKER)
}
fn poll_reply(result: Result<String>) -> Result<String> {
    match result {
        Ok(id) => Ok(serde_json::json!({"status":"complete","id":id}).to_string()),
        Err(e) if e.code == ErrorCode::Auth && e.message == PENDING_MARKER => {
            Ok(serde_json::json!({"status":"pending"}).to_string())
        }
        Err(e) => Err(e),
    }
}

/// Device exchange dispatch: exactly one provider poll per call; the caller
/// owns the loop and deadline. Each device provider commit adds an arm here
/// driving its oauth.rs builders through `crate::oauth_runner::ExchangeRunner`.
async fn device_exchange(
    provider: &str,
    host: &crate::refresh::Refresher,
    pending: &PendingFlow,
    prior: &serde_json::Value,
) -> std::result::Result<FlowResult, DeviceError> {
    match provider {
        "kimi" => {
            let (request, device) = omni_providers::kimi::oauth::exchange_request(pending)?;
            let mut runner = crate::oauth_runner::ExchangeRunner::new(
                host.http.as_ref(),
                crate::oauth_runner::ExchangeConfig {
                    provider: "kimi",
                    step: "exchange",
                    max_requests: 1,
                    origins: crate::oauth_runner::Origins::Allowlist(
                        omni_providers::kimi::oauth::AUTH_ORIGINS,
                    ),
                },
            );
            let response = runner.send(request, 30).await?;
            #[allow(clippy::cast_precision_loss)]
            let now = (host.now)() as f64;
            omni_providers::kimi::oauth::poll_result(response.0, &response.1, &device, now)
        }
        "kilo" => {
            #[allow(clippy::cast_precision_loss)]
            let now = (host.now)() as f64;
            let request = omni_providers::kilo::oauth::exchange_request(pending, now)?;
            // Two requests: the poll, then the best-effort organization read.
            let mut runner = crate::oauth_runner::ExchangeRunner::new(
                host.http.as_ref(),
                crate::oauth_runner::ExchangeConfig {
                    provider: "kilo",
                    step: "exchange",
                    max_requests: 2,
                    origins: crate::oauth_runner::Origins::Allowlist(
                        omni_providers::kilo::oauth::AUTH_ORIGINS,
                    ),
                },
            );
            let response = runner.send(request, 15).await?;
            let mut result = omni_providers::kilo::oauth::poll_result(response.0, &response.1)?;
            // Best-effort: an account with no organization is normal, and a
            // failed read must not fail a connect the operator already
            // approved — nor surface as AUTH, which disables credentials.
            let access = String::from_utf16_lossy(&result.access_token);
            if let Ok((status, text)) = runner
                .send(omni_providers::kilo::oauth::org_request(&access), 15)
                .await
                && let Some(org) = omni_providers::kilo::oauth::org_id(status, &text)
            {
                omni_ir::deep::insert(
                    &mut result.provider_data,
                    "orgId".into(),
                    serde_json::Value::String(org),
                );
            }
            Ok(result)
        }
        "muse" => {
            let request = omni_providers::muse::oauth::exchange_request(pending)?;
            // Two requests: the device poll, then the key mint. Only reached
            // once the operator has approved, so a mint failure is a fact
            // about the account rather than a step still in progress.
            let mut runner = crate::oauth_runner::ExchangeRunner::new(
                host.http.as_ref(),
                crate::oauth_runner::ExchangeConfig {
                    provider: "muse",
                    step: "exchange",
                    max_requests: 2,
                    origins: crate::oauth_runner::Origins::Allowlist(
                        omni_providers::muse::oauth::AUTH_ORIGINS,
                    ),
                },
            );
            let response = runner.send(request, 30).await?;
            let token = omni_providers::muse::oauth::poll_token(response.0, &response.1)?;
            let access = String::from_utf16_lossy(&token.access_token);
            let (status, text) = runner
                .send(omni_providers::muse::oauth::mint_request(&access), 30)
                .await?;
            #[allow(clippy::cast_precision_loss)]
            let now = (host.now)() as f64;
            Ok(omni_providers::muse::oauth::exchange_result(
                token, status, &text, None, now,
            )?)
        }
        "qoder" => {
            #[allow(clippy::cast_precision_loss)]
            let now = (host.now)() as f64;
            let (request, machine_id) =
                omni_providers::qoder::oauth::exchange_request(pending, now)?;
            // Five requests at most: the poll, userinfo, endpoint election
            // (v5 plus the anonymous v3 fallback) and the signed model list.
            let mut runner = crate::oauth_runner::ExchangeRunner::new(
                host.http.as_ref(),
                crate::oauth_runner::ExchangeConfig {
                    provider: "qoder",
                    step: "exchange",
                    max_requests: 5,
                    origins: crate::oauth_runner::Origins::Allowlist(
                        omni_providers::qoder::oauth::AUTH_ORIGINS,
                    ),
                },
            );
            let response = runner.send(request, 15).await?;
            let token = omni_providers::qoder::oauth::poll_result(response.0, &response.1)?;
            let state = omni_providers::oauth::random_state();
            // A first exchange carries no previous state, reconnect or not:
            // the TS flow passes `{}` here and providerData only on refresh.
            let previous = serde_json::Map::new();
            omni_providers::qoder::oauth::finish(
                &mut runner,
                &token,
                &machine_id,
                now,
                &state,
                &previous,
            )
            .await
            .map_err(DeviceError::Gateway)
        }
        #[cfg(test)]
        "device-fixture" => tests::device_fixture(host, pending, prior).await,
        _ => {
            let _ = (host, pending, prior);
            Err(DeviceError::Gateway(internal()))
        }
    }
}

fn pending_value(flow: &JsValue) -> Result<PendingFlow> {
    let p = get(flow, "pending").ok_or_else(internal)?;
    let extra = match get(p, "extra") {
        Some(v) => {
            serde_json::from_str(&stringify(v).ok_or_else(internal)?).map_err(|_| internal())?
        }
        None => serde_json::Map::new(),
    };
    Ok(PendingFlow {
        verifier: text(get(p, "verifier")).ok_or_else(internal)?,
        challenge: text(get(p, "challenge")).ok_or_else(internal)?,
        state: text(get(p, "state")).ok_or_else(internal)?,
        redirect_uri: text(get(p, "redirectUri")).ok_or_else(internal)?,
        device_code: text(get(p, "deviceCode")),
        interval: match get(p, "interval") {
            Some(JsValue::Number(n)) => Some(*n),
            _ => None,
        },
        extra,
    })
}
/// A stored pending carrying a device code marks a device flow; the machinery
/// keys on flow data, never on provider names.
fn device_flow(flow: &JsValue) -> bool {
    get(flow, "pending")
        .and_then(|p| text(get(p, "deviceCode")))
        .is_some()
}
fn normalize(provider: &str, pending: &PendingFlow, code: &str) -> Result<String> {
    let callback = PROVIDERS
        .iter()
        .find(|(p, _)| *p == provider)
        .map_or("", |(_, c)| *c);
    if callback.is_empty() {
        return Ok(code.into());
    }
    let Ok(url) = url::Url::parse(code) else {
        return Ok(code.into());
    };
    let expected = url::Url::parse(callback).map_err(|_| internal())?;
    let label = if provider == "antigravity" {
        "Antigravity"
    } else if provider == "grok" {
        "Grok"
    } else {
        "OpenAI"
    };
    if url.origin() != expected.origin() || url.path() != expected.path() {
        return Err(bad(&format!("invalid {label} callback URL")));
    }
    let field = |name| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| omni_ir::js::trim(&v).to_owned())
            .unwrap_or_default()
    };
    let code = field("code");
    let state = field("state");
    if code.is_empty() || state.is_empty() {
        return Err(bad(&format!(
            "{label} callback URL must contain code and state"
        )));
    }
    if state != pending.state {
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "authorization state mismatch",
        ));
    }
    Ok(format!("{code}#{state}"))
}
fn exchange_failure(provider: &str) -> GatewayError {
    // Transport failures escape the exchange steps uncaught, so they
    // classify as UPSTREAM.
    GatewayError::new(
        ErrorCode::Upstream,
        format!("{provider} oauth exchange threw"),
    )
}
async fn finish_exchange(
    host: Arc<crate::refresh::Refresher>,
    holder: Arc<omni_gateway_core::snapshot::SnapshotHolder>,
    flow: JsValue,
    code: String,
) -> Result<String> {
    // Dropping an admin connection must not cancel an already consumed flow.
    tokio::spawn(async move { complete(host, holder, flow, &code).await })
        .await
        .map_err(|_| internal())?
}
async fn complete(
    host: Arc<crate::refresh::Refresher>,
    holder: Arc<omni_gateway_core::snapshot::SnapshotHolder>,
    flow: JsValue,
    code: &str,
) -> Result<String> {
    use omni_providers::http::HttpRequest;
    let provider = text(get(&flow, "provider")).ok_or_else(internal)?;
    let reconnect = text(get(&flow, "credentialId"));
    let prior = if let Some(id) = &reconnect {
        Some(
            host.store
                .credential(&host.key, id)
                .await
                .map_err(|_| internal())?
                .ok_or_else(|| bad("credential not found"))?,
        )
    } else {
        None
    };
    let data = prior
        .as_ref()
        .filter(|c| c.provider == provider)
        .map_or(&serde_json::Value::Null, |c| &c.provider_data);
    let pending = pending_value(&flow)?;
    let result = if provider == "antigravity" {
        tokio::time::timeout(
            std::time::Duration::from_secs(150),
            antigravity_exchange(&host, code, &pending),
        )
        .await
        .map_err(|_| {
            GatewayError::new(
                ErrorCode::Upstream,
                "antigravity oauth exchange did not finish within 150000ms",
            )
        })??
    } else if provider == "grok" {
        grok_exchange(&host, code, &pending).await?
    } else {
        let request = if provider == "openai" {
            omni_providers::openai::oauth::exchange_request(code, &pending)?
        } else {
            omni_providers::anthropic::oauth::exchange_request(code, &pending)?
        };
        let response = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let response = host
                .http
                .send(HttpRequest {
                    provider: provider.clone(),
                    url: request.url,
                    method: request.method,
                    headers: request.headers,
                    body: request.body,
                    body_encoding: None,
                    request_id: None,
                })
                .await?;
            Ok::<_, omni_providers::http::HttpError>((response.status, response.body.text().await?))
        })
        .await
        .map_err(|_| exchange_failure(&provider))?
        .map_err(|_| exchange_failure(&provider))?;
        #[allow(clippy::cast_precision_loss)]
        let now = (host.now)() as f64;
        if provider == "openai" {
            omni_providers::openai::oauth::token_result(response.0, &response.1, None, now, data)?
        } else {
            omni_providers::anthropic::oauth::token_result(response.0, &response.1, None, now)?
        }
    };
    persist_flow_result(host, holder, &flow, result).await
}

/// grok's two-step exchange: discovery, then the token POST to the endpoint
/// it published. The state check runs before discovery, so a forged paste
/// never puts a request on the wire.
async fn grok_exchange(
    host: &crate::refresh::Refresher,
    code: &str,
    pending: &PendingFlow,
) -> Result<FlowResult> {
    let raw_code = omni_providers::grok::oauth::pasted_code(code, pending)?;
    let mut runner = crate::oauth_runner::ExchangeRunner::new(
        host.http.as_ref(),
        crate::oauth_runner::ExchangeConfig {
            provider: "grok",
            step: "exchange",
            max_requests: 2,
            origins: crate::oauth_runner::Origins::Validator(
                &omni_providers::grok::oauth::trusted_origin,
            ),
        },
    );
    let response = runner
        .send(omni_providers::grok::oauth::discovery_request(), 15)
        .await?;
    let endpoints = omni_providers::grok::oauth::discovery_result(response.0, &response.1)?;
    let request =
        omni_providers::grok::oauth::exchange_request(&raw_code, pending, &endpoints.token_url);
    let response = runner.send(request, 30).await?;
    #[allow(clippy::cast_precision_loss)]
    let now = (host.now)() as f64;
    // The agent id is minted once, here, and frozen onto the credential.
    let agent = omni_providers::grok::device::mint();
    omni_providers::grok::oauth::token_result(response.0, &response.1, None, &agent.agent_id, now)
}

/// Persistence half of a completed exchange, shared by the pkce and device
/// paths.
async fn persist_flow_result(
    host: Arc<crate::refresh::Refresher>,
    holder: Arc<omni_gateway_core::snapshot::SnapshotHolder>,
    flow: &JsValue,
    result: FlowResult,
) -> Result<String> {
    let provider = text(get(flow, "provider")).ok_or_else(internal)?;
    let reconnect = text(get(flow, "credentialId"));
    // Flow secrets are validated before persistence.
    if result
        .refresh_token
        .as_ref()
        .is_some_and(|v| !matches!(v, JsValue::String(_)))
    {
        return Err(GatewayError::new(
            ErrorCode::Upstream,
            format!("{provider} oauth exchange returned something the host cannot use"),
        ));
    }
    let tokens = omni_store::credentials::TokenUpdate {
        access_token: Some(String::from_utf16_lossy(&result.access_token)),
        refresh_token: result.refresh_token.as_ref().map(crate::refresh::js_text),
        api_key: result.api_key.as_ref().map(|s| String::from_utf16_lossy(s)),
        id_token: result
            .id_token
            .as_ref()
            .map(|s| String::from_utf16_lossy(s)),
        expires_at: result.expires_at,
        updated_at: (host.now)(),
    };
    let email = result
        .account_email
        .as_ref()
        .map(|v| crate::refresh::email_text(v, host.store.engine()))
        .transpose()
        .map_err(|_| internal())?;
    let id = reconnect.clone().unwrap_or_else(|| {
        omni_crypto::codex::uuid_v4_from(&omni_providers::oauth::random_state())
    });
    let label = text(get(flow, "label")).ok_or_else(internal)?;
    host.store
        .save_oauth(
            &host.key,
            &omni_store::credentials::OAuthCredential {
                id: &id,
                provider: &provider,
                label: &label,
                provider_data: &omni_ir::jsjson::to_string(&serde_json::Value::Object(
                    omni_ir::deep::clone_map(&result.provider_data),
                )),
                account_email: email.as_deref(),
                tokens: &tokens,
                reconnect: reconnect.is_some(),
            },
        )
        .await
        .map_err(|_| internal())?;
    host.routing_committed(crate::routing::RoutingChange::Credential { id: id.clone() });
    if holder.rebuild_from(host.store.clone()).await.is_err() {
        tracing::warn!(credentialId = %id, "credential snapshot publication failed; retaining previous snapshot");
    }
    if reconnect.is_some() {
        tracing::info!(provider, credentialId = id, "oauth reconnect completed");
    } else {
        tracing::info!(provider, credentialId = id, "oauth connect completed");
    }
    Ok(id)
}

/// Exchange runner limits, applied before transport. The other two providers
/// retain their existing single-request path, including its byte ordering.
struct AntigravityExchange<'a> {
    host: &'a crate::refresh::Refresher,
    sent: usize,
}
impl AntigravityExchange<'_> {
    async fn send(
        &mut self,
        request: omni_providers::oauth::AuthRequest,
        seconds: u64,
    ) -> Result<(u16, String)> {
        self.sent += 1;
        if self.sent > 4 {
            return Err(GatewayError::new(
                ErrorCode::Upstream,
                "antigravity oauth exchange asked for more than 4 requests",
            ));
        }
        let url = url::Url::parse(&request.url).map_err(|_| exchange_failure("antigravity"))?;
        if ![
            "https://oauth2.googleapis.com",
            "https://www.googleapis.com",
            "https://cloudcode-pa.googleapis.com",
            "https://accounts.google.com",
            "https://daily-cloudcode-pa.googleapis.com",
        ]
        .contains(&url.origin().ascii_serialization().as_str())
        {
            return Err(GatewayError::new(
                ErrorCode::Upstream,
                "antigravity oauth exchange described a request to an origin its manifest does not declare",
            ));
        }
        tokio::time::timeout(std::time::Duration::from_secs(seconds.min(30)), async {
            let response = self
                .host
                .http
                .send(omni_providers::http::HttpRequest {
                    provider: "antigravity".into(),
                    url: request.url,
                    method: request.method,
                    headers: request.headers,
                    body: request.body,
                    body_encoding: None,
                    request_id: None,
                })
                .await?;
            Ok::<_, omni_providers::http::HttpError>((response.status, response.body.text().await?))
        })
        .await
        .map_err(|_| exchange_failure("antigravity"))?
        .map_err(|_| exchange_failure("antigravity"))
    }
}
async fn antigravity_exchange(
    host: &crate::refresh::Refresher,
    code: &str,
    pending: &PendingFlow,
) -> Result<omni_providers::oauth::FlowResult> {
    use omni_providers::antigravity::oauth as ag;
    let mut runner = AntigravityExchange { host, sent: 0 };
    let token = runner
        .send(ag::exchange_request(code, pending)?, 30)
        .await?;
    // Expiry is computed only after all bootstrap calls have completed.
    let mut result = ag::token_result(token.0, &token.1, None, 0.0, &serde_json::Value::Null)?;
    let access = String::from_utf16_lossy(&result.access_token);
    let email = runner.send(ag::email_request(&access), 15).await?;
    result.account_email = ag::email_result(email.0, &email.1);
    let loaded = runner.send(ag::load_request(&access), 30).await?;
    let (mut project, tier) = ag::project_result(loaded.0, &loaded.1);
    if project.is_empty() {
        let onboarded = runner.send(ag::onboard_request(&access, &tier), 30).await?;
        project = ag::onboard_result(onboarded.0, &onboarded.1);
    }
    #[allow(clippy::cast_precision_loss)]
    let now = (host.now)() as f64;
    result.expires_at = result.expires_at.map(|expiry| expiry + now);
    result.provider_data = serde_json::json!({"projectId": project, "tier": tier})
        .as_object()
        .cloned()
        .unwrap_or_default();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ExpiryEndpoint(&'static str);

    impl ExpiryEndpoint {
        fn response(&self) -> omni_providers::http::HttpResponse {
            use omni_providers::http::{Headers, HttpResponse, ResponseBody};
            HttpResponse {
                status: 200,
                headers: Headers::new(),
                body: ResponseBody::from_bytes(format!(
                    r#"{{"access_token":"fixture","refresh_token":"refresh","expires_in":{}}}"#,
                    self.0
                )),
            }
        }
    }

    impl omni_providers::http::HttpClient for ExpiryEndpoint {
        fn send(
            &self,
            _: omni_providers::http::HttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<
                            omni_providers::http::HttpResponse,
                            omni_providers::http::HttpError,
                        >,
                    > + Send
                    + '_,
            >,
        > {
            Box::pin(async { Ok(self.response()) })
        }
    }

    struct ExpiryCase {
        seconds: &'static str,
        now: fn() -> i64,
        expiry: f64,
        expired_at_one: bool,
    }

    async fn check_sqlite_expiry(case: ExpiryCase) {
        use omni_gateway_core::snapshot::SnapshotHolder;
        use omni_store::{Store, StoreConfig};
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("db");
        let key = omni_crypto::field::derive_key("test-key");
        let store = Arc::new(
            Store::open(StoreConfig::Sqlite { path: path.clone() }, 0)
                .await
                .expect("store"),
        );
        let host = Arc::new(crate::refresh::Refresher::new(
            store.clone(),
            key.clone(),
            Arc::new(ExpiryEndpoint(case.seconds)),
            case.now,
        ));
        let holder = Arc::new(
            SnapshotHolder::build_from(store.clone(), key.clone(), 1.0)
                .await
                .expect("snapshot"),
        );
        let flow = parse_js(r#"{"provider":"anthropic","label":"fixture","pending":{"verifier":"v","challenge":"c","state":"s","redirectUri":""}}"#).expect("flow");
        let id = complete(host.clone(), holder.clone(), flow, "code#s")
            .await
            .expect("connect");
        let connected = &holder.load().routing.credentials[0];
        assert_eq!(connected.id, id);
        assert_eq!(connected.token_version, 0);
        assert_eq!(connected.expires_at, Some(case.expiry));

        host.refresh(connected).await.expect("rotate");
        holder
            .refresh_credential(store.clone(), id.clone())
            .await
            .expect("publish rotation");
        let rotated = &holder.load().routing.credentials[0];
        assert_eq!(rotated.token_version, 1);
        assert_eq!(rotated.expires_at, Some(case.expiry));

        let db = omni_store::SqliteStore::open(&path, 0).expect("sqlite");
        let cell: (String, f64) = db
            .connection()
            .query_row(
                "SELECT typeof(expires_at), expires_at FROM credentials WHERE id=?",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("read raw expiry");
        assert_eq!(cell, ("real".into(), case.expiry));
        db.connection()
            .execute(
                "UPDATE credentials SET refresh_token=NULL WHERE id=?",
                [&id],
            )
            .expect("remove refresh token");
        holder
            .refresh_credential(store.clone(), id.clone())
            .await
            .expect("publish unrefreshable credential");
        let snapshot = holder.load();
        assert_eq!(snapshot.routing.credentials.len(), 1);
        let model = omni_store::VirtualModel {
            id: "fixture".into(), strategy: omni_store::Strategy::Priority, is_alias: false,
            targets: vec![serde_json::from_str(r#"{"provider":"anthropic","model":"claude","tier":1,"weight":1,"costPerMTok":{"input":0,"output":0},"capabilities":{"tools":true,"images":true,"reasoning":true}}"#).expect("target")],
        };
        let request = serde_json::from_str(r#"{"model":"fixture","messages":[],"stream":false}"#)
            .expect("request");
        let ranked = omni_router::eligible(&omni_router::RankInput {
            request: &request,
            model: &model,
            snapshot: &snapshot.routing,
            now: 1.0,
            rand: 0.0,
            load: None,
            recent: None,
            providers: None,
        });
        assert_eq!(ranked.pairs.len(), usize::from(!case.expired_at_one));
        if case.expired_at_one {
            assert_eq!(ranked.excluded[0].reason, "expired");
        }
        let sweeper = Arc::new(crate::refresh::Refresher::new(
            store,
            key,
            Arc::new(ExpiryEndpoint(case.seconds)),
            || 1,
        ));
        let sweep = sweeper.sweep(Some(&holder)).await.expect("sweep");
        assert_eq!(sweep.refreshed, 0);
        assert_eq!(sweep.touched, usize::from(case.expired_at_one));
        assert_eq!(
            holder.load().routing.credentials[0].enabled,
            !case.expired_at_one
        );
    }

    #[tokio::test]
    async fn expiry_fraction_survives_connect_refresh_and_routing() {
        check_sqlite_expiry(ExpiryCase {
            seconds: "0.0015",
            now: || 0,
            expiry: 1.5,
            expired_at_one: false,
        })
        .await;
    }

    #[tokio::test]
    async fn expiry_infinities_survive_connect_refresh_and_routing() {
        check_sqlite_expiry(ExpiryCase {
            seconds: "1e309",
            now: || 0,
            expiry: f64::INFINITY,
            expired_at_one: false,
        })
        .await;
        check_sqlite_expiry(ExpiryCase {
            seconds: "-1e309",
            now: || 0,
            expiry: f64::NEG_INFINITY,
            expired_at_one: true,
        })
        .await;
    }

    #[tokio::test]
    async fn expiry_a15_survives_connect_refresh_and_routing() {
        check_sqlite_expiry(ExpiryCase {
            seconds: "1e21",
            now: || 1_794_700_000_000,
            expiry: 1.000_000_000_001_794_7e24,
            expired_at_one: false,
        })
        .await;
    }
    #[test]
    fn connect_callback_matches_generated_catalog() {
        let catalog: serde_json::Value =
            serde_json::from_str(omni_control::catalog::DATA).expect("catalog");
        assert_eq!(
            catalog["openai"]["callback"]["uri"].as_str(),
            Some(PROVIDERS[1].1)
        );
        assert!(catalog["anthropic"].get("callback").is_none());
        assert_eq!(
            catalog["antigravity"]["callback"]["uri"].as_str(),
            Some(PROVIDERS[2].1)
        );
        assert_eq!(
            catalog["grok"]["callback"]["uri"].as_str(),
            Some(PROVIDERS[5].1)
        );
    }
    #[test]
    fn connect_callback_parser() {
        let p = PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: "state".into(),
            redirect_uri: PROVIDERS[1].1.into(),
            device_code: None,
            interval: None,
            extra: serde_json::Map::new(),
        };
        assert_eq!(
            normalize("openai", &p, "raw#state").expect("raw"),
            "raw#state"
        );
        assert!(normalize("openai", &p, "abc:def").is_err());
        assert_eq!(
            normalize("anthropic", &p, "abc:def").expect("raw"),
            "abc:def"
        );
        assert_eq!(
            normalize(
                "openai",
                &p,
                "http://localhost:1455/auth/callback?code=%20first%20&code=second&state=state"
            )
            .expect("callback"),
            "first#state"
        );
        assert!(
            normalize(
                "openai",
                &p,
                "http://localhost:1455/auth/callback?code=a&state=wrong"
            )
            .is_err()
        );
        assert!(normalize("openai", &p, "http://localhost:1455/auth/callback?code=a").is_err());
        let g = PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: "state".into(),
            redirect_uri: PROVIDERS[5].1.into(),
            device_code: None,
            interval: None,
            extra: serde_json::Map::new(),
        };
        assert_eq!(
            normalize(
                "grok",
                &g,
                "http://127.0.0.1:56121/callback?code=a&state=state"
            )
            .expect("callback"),
            "a#state"
        );
        assert!(
            normalize(
                "grok",
                &g,
                "http://127.0.0.1:56121/callback?code=a&state=wrong"
            )
            .is_err()
        );
        let missing = normalize("grok", &g, "http://127.0.0.1:56121/callback?code=a")
            .expect_err("missing state");
        assert_eq!(
            missing.message,
            "Grok callback URL must contain code and state"
        );
    }
    #[test]
    fn antigravity_callback_parser() {
        let p = PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: "s".into(),
            redirect_uri: PROVIDERS[2].1.into(),
            device_code: None,
            interval: None,
            extra: serde_json::Map::new(),
        };
        assert_eq!(
            normalize(
                "antigravity",
                &p,
                "https://antigravity.google/oauth-callback?code=%20x%20&state=s"
            )
            .expect("callback"),
            "x#s"
        );
        assert_eq!(normalize("antigravity", &p, "x#s").expect("bare"), "x#s");
        assert_eq!(
            normalize("antigravity", &p, "https://wrong.test/")
                .expect_err("origin")
                .message,
            "invalid Antigravity callback URL"
        );
        assert_eq!(
            normalize(
                "antigravity",
                &p,
                "https://antigravity.google/oauth-callback?code=x"
            )
            .expect_err("state")
            .message,
            "Antigravity callback URL must contain code and state"
        );
        assert_eq!(
            normalize(
                "antigravity",
                &p,
                "https://antigravity.google/oauth-callback?code=x&state=wrong"
            )
            .expect_err("state")
            .message,
            "authorization state mismatch"
        );
    }
    #[tokio::test]
    async fn connect_pending_ttl_take_peek_and_lossless_label() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let now = Arc::new(AtomicU64::new(0));
        let clock = now.clone();
        #[allow(clippy::cast_precision_loss)]
        let coord = Arc::new(MemoryCoord::new(Arc::new(move || {
            clock.load(Ordering::SeqCst) as f64
        })));
        let flows = ConnectFlows {
            coord: coord.clone(),
            flights: std::sync::Mutex::default(),
        };
        let raw = r#"{"label":"\ud800"}"#;
        coord
            .kv_set("oauth:pending:a", raw, 600_000)
            .await
            .expect("put");
        assert_eq!(
            stringify(&flows.pending("a", false).await.expect("peek")).expect("json"),
            raw
        );
        assert!(flows.pending("a", true).await.is_ok());
        assert!(flows.pending("a", false).await.is_err());
        coord
            .kv_set("oauth:pending:a", raw, 600_000)
            .await
            .expect("put");
        now.store(600_000, Ordering::SeqCst);
        assert!(flows.pending("a", false).await.is_err());
    }
    struct Counting(std::sync::atomic::AtomicUsize);
    impl omni_providers::http::HttpClient for Counting {
        fn send(
            &self,
            _: omni_providers::http::HttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<
                            omni_providers::http::HttpResponse,
                            omni_providers::http::HttpError,
                        >,
                    > + Send
                    + '_,
            >,
        > {
            Box::pin(async {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok(omni_providers::http::HttpResponse {
                    status: 400,
                    headers: omni_providers::http::Headers::new(),
                    body: omni_providers::http::ResponseBody::from_bytes("{}"),
                })
            })
        }
    }
    #[tokio::test]
    async fn connect_finish_survives_waiter_cancellation() {
        survives_waiter_cancellation(false).await;
    }
    #[tokio::test]
    async fn connect_poll_survives_waiter_cancellation_and_consumes() {
        survives_waiter_cancellation(true).await;
    }
    async fn survives_waiter_cancellation(poll: bool) {
        struct Delayed {
            entered: tokio::sync::Notify,
            release: tokio::sync::Notify,
        }
        impl omni_providers::http::HttpClient for Delayed {
            fn send(
                &self,
                _: omni_providers::http::HttpRequest,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = std::result::Result<
                                omni_providers::http::HttpResponse,
                                omni_providers::http::HttpError,
                            >,
                        > + Send
                        + '_,
                >,
            > {
                Box::pin(async {
                    self.entered.notify_one();
                    self.release.notified().await;
                    Ok(omni_providers::http::HttpResponse {
                        status: 200,
                        headers: omni_providers::http::Headers::new(),
                        body: omni_providers::http::ResponseBody::from_bytes(
                            r#"{"access_token":"survived","refresh_token":"r","expires_in":3600}"#,
                        ),
                    })
                })
            }
        }
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let http = Arc::new(Delayed {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let host = Arc::new(crate::refresh::Refresher::new(
            store.clone(),
            key.clone(),
            http.clone(),
            crate::clock::now_ms,
        ));
        let flow = parse_js(r#"{"provider":"anthropic","label":"survivor","pending":{"verifier":"v","challenge":"c","state":"s","redirectUri":""}}"#).expect("flow");
        let flows = Arc::new(ConnectFlows::default());
        flows
            .coord
            .kv_set(
                "oauth:pending:cancelled",
                &stringify(&flow).expect("json"),
                600_000,
            )
            .await
            .expect("put");
        let owner = flows.clone();
        let holder = Arc::new(
            omni_gateway_core::snapshot::SnapshotHolder::build(
                &omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("sqlite"),
                key.clone(),
                0.0,
            )
            .expect("snapshot"),
        );
        let waiter = tokio::spawn(async move {
            if poll {
                owner.poll(host, holder, "cancelled".into()).await
            } else {
                finish_exchange(host, holder, flow, "code#s".into()).await
            }
        });
        http.entered.notified().await;
        waiter.abort();
        assert!(waiter.await.expect_err("cancelled").is_cancelled());
        http.release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let rows = store.list_credentials(&key).await.expect("credentials");
                if let Some(row) = rows.first() {
                    if poll
                        && flows
                            .coord
                            .kv_get("oauth:pending:cancelled")
                            .await
                            .expect("peek")
                            .is_some()
                    {
                        tokio::task::yield_now().await;
                        continue;
                    }
                    assert_eq!(rows.len(), 1);
                    assert_eq!(row.label, "survivor");
                    assert_eq!(row.secrets.access_token.as_deref(), Some("survived"));
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached finish persisted");
    }
    #[tokio::test]
    async fn connect_concurrent_poll_shares_exchange_and_consumes_failure() {
        let dir = tempfile::tempdir().expect("dir");
        let store = omni_store::Store::open(
            omni_store::StoreConfig::Sqlite {
                path: dir.path().join("db"),
            },
            0,
        )
        .await
        .expect("store");
        let http = Arc::new(Counting(std::sync::atomic::AtomicUsize::new(0)));
        let holder = Arc::new(
            omni_gateway_core::snapshot::SnapshotHolder::build(
                &omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("sqlite"),
                omni_crypto::field::derive_key("test-key"),
                0.0,
            )
            .expect("snapshot"),
        );
        let host = Arc::new(crate::refresh::Refresher::new(
            Arc::new(store),
            omni_crypto::field::derive_key("test-key"),
            http.clone(),
            crate::clock::now_ms,
        ));
        let flows = Arc::new(ConnectFlows::default());
        flows.coord.kv_set("oauth:pending:test",r#"{"provider":"openai","label":"test","pending":{"verifier":"v","challenge":"c","state":"s","redirectUri":"http://localhost:1455/auth/callback"}}"#,600_000).await.expect("put");
        let (a, b) = tokio::join!(
            flows.poll(host.clone(), holder.clone(), "test".into()),
            flows.poll(host, holder, "test".into())
        );
        assert_eq!(
            a.expect_err("refused").message,
            b.expect_err("refused").message
        );
        assert_eq!(http.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(flows.pending("test", false).await.is_err());
    }

    /// Synthetic one-request device exchange behind the `device-fixture`
    /// dispatch arm: the fake HttpClient's answer decides pending / terminal /
    /// success, so the device machinery is exercised without a real provider.
    pub(super) async fn device_fixture(
        host: &crate::refresh::Refresher,
        pending: &PendingFlow,
        prior: &serde_json::Value,
    ) -> std::result::Result<FlowResult, DeviceError> {
        let _ = (pending, prior);
        let mut runner = crate::oauth_runner::ExchangeRunner::new(
            host.http.as_ref(),
            crate::oauth_runner::ExchangeConfig {
                provider: "device-fixture",
                step: "exchange",
                max_requests: 1,
                origins: crate::oauth_runner::Origins::Allowlist(&["https://device.fixture"]),
            },
        );
        let response = runner
            .send(
                omni_providers::oauth::AuthRequest {
                    url: "https://device.fixture/poll".into(),
                    method: "POST".into(),
                    headers: Vec::new(),
                    body: "{}".into(),
                },
                30,
            )
            .await?;
        let body: serde_json::Value = serde_json::from_str(&response.1).unwrap_or_default();
        if body.get("pending").and_then(serde_json::Value::as_bool) == Some(true) {
            return Err(DeviceError::Pending);
        }
        #[allow(clippy::cast_precision_loss)]
        let now = (host.now)() as f64;
        omni_providers::anthropic::oauth::token_result(response.0, &response.1, None, now)
            .map_err(DeviceError::from)
    }

    const DEVICE_FLOW: &str = r#"{"provider":"device-fixture","label":"device","pending":{"verifier":"","challenge":"","state":"","redirectUri":"","deviceCode":"dc","interval":3,"extra":{"deviceId":"machine"}}}"#;

    struct Scripted {
        status: u16,
        body: &'static str,
    }
    impl omni_providers::http::HttpClient for Scripted {
        fn send(
            &self,
            _: omni_providers::http::HttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<
                            omni_providers::http::HttpResponse,
                            omni_providers::http::HttpError,
                        >,
                    > + Send
                    + '_,
            >,
        > {
            Box::pin(async {
                Ok(omni_providers::http::HttpResponse {
                    status: self.status,
                    headers: omni_providers::http::Headers::new(),
                    body: omni_providers::http::ResponseBody::from_bytes(self.body),
                })
            })
        }
    }

    async fn device_harness(
        http: Arc<dyn omni_providers::http::HttpClient>,
    ) -> (
        tempfile::TempDir,
        Arc<crate::refresh::Refresher>,
        Arc<omni_gateway_core::snapshot::SnapshotHolder>,
        Arc<ConnectFlows>,
    ) {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let holder = Arc::new(
            omni_gateway_core::snapshot::SnapshotHolder::build(
                &omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("sqlite"),
                key.clone(),
                0.0,
            )
            .expect("snapshot"),
        );
        let host = Arc::new(crate::refresh::Refresher::new(
            store,
            key,
            http,
            crate::clock::now_ms,
        ));
        let flows = Arc::new(ConnectFlows::default());
        flows
            .coord
            .kv_set("oauth:pending:dev", DEVICE_FLOW, 600_000)
            .await
            .expect("put");
        (dir, host, holder, flows)
    }

    #[tokio::test]
    async fn device_poll_pending_keeps_flow() {
        let http = Arc::new(Scripted {
            status: 200,
            body: r#"{"pending":true}"#,
        });
        let (_dir, host, holder, flows) = device_harness(http).await;
        let error = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(error.message, PENDING_MARKER);
        assert_eq!(
            poll_reply(Err(error)).expect("reply"),
            r#"{"status":"pending"}"#
        );
        let stored = flows.pending("dev", false).await.expect("kept");
        let pending = pending_value(&stored).expect("pending");
        assert_eq!(pending.device_code.as_deref(), Some("dc"));
        assert_eq!(pending.interval, Some(3.0));
        assert_eq!(
            pending
                .extra
                .get("deviceId")
                .and_then(serde_json::Value::as_str),
            Some("machine")
        );
        // A second poll runs a fresh exchange against the kept flow.
        assert!(flows.poll(host, holder, "dev".into()).await.is_err());
        assert!(flows.pending("dev", false).await.is_ok());
    }

    #[tokio::test]
    async fn device_poll_terminal_failure_consumes_flow() {
        let http = Arc::new(Scripted {
            status: 403,
            body: "{}",
        });
        let (_dir, host, holder, flows) = device_harness(http).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("denied");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "token endpoint rejected the request: http_403"
        );
        assert!(poll_reply(Err(error)).is_err());
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn device_concurrent_poll_shares_exchange_and_consumes_failure() {
        let http = Arc::new(Counting(std::sync::atomic::AtomicUsize::new(0)));
        let (_dir, host, holder, flows) = device_harness(http.clone()).await;
        let (a, b) = tokio::join!(
            flows.poll(host.clone(), holder.clone(), "dev".into()),
            flows.poll(host, holder, "dev".into())
        );
        assert_eq!(
            a.expect_err("refused").message,
            b.expect_err("refused").message
        );
        assert_eq!(http.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn device_poll_success_persists_and_consumes() {
        let http = Arc::new(Scripted {
            status: 200,
            body: r#"{"access_token":"granted","refresh_token":"r","expires_in":3600}"#,
        });
        let (_dir, host, holder, flows) = device_harness(http).await;
        let id = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect("approved");
        assert_eq!(
            poll_reply(Ok(id.clone())).expect("reply"),
            serde_json::json!({"status":"complete","id":id}).to_string()
        );
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "device");
        assert_eq!(rows[0].secrets.access_token.as_deref(), Some("granted"));
        assert_eq!(holder.load().routing.credentials[0].id, id);
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn device_poll_survives_waiter_cancellation() {
        struct Gated {
            entered: tokio::sync::Notify,
            release: tokio::sync::Notify,
        }
        impl omni_providers::http::HttpClient for Gated {
            fn send(
                &self,
                _: omni_providers::http::HttpRequest,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = std::result::Result<
                                omni_providers::http::HttpResponse,
                                omni_providers::http::HttpError,
                            >,
                        > + Send
                        + '_,
                >,
            > {
                Box::pin(async {
                    self.entered.notify_one();
                    self.release.notified().await;
                    Ok(omni_providers::http::HttpResponse {
                        status: 200,
                        headers: omni_providers::http::Headers::new(),
                        body: omni_providers::http::ResponseBody::from_bytes(
                            r#"{"access_token":"survived","refresh_token":"r","expires_in":3600}"#,
                        ),
                    })
                })
            }
        }
        let http = Arc::new(Gated {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let (_dir, host, holder, flows) = device_harness(http.clone()).await;
        let owner = flows.clone();
        let waiter_host = host.clone();
        let waiter =
            tokio::spawn(async move { owner.poll(waiter_host, holder, "dev".into()).await });
        http.entered.notified().await;
        waiter.abort();
        assert!(waiter.await.expect_err("cancelled").is_cancelled());
        http.release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let rows = flows.coord.kv_get("oauth:pending:dev").await.expect("peek");
                let stored = host.store.list_credentials(&host.key).await.expect("rows");
                if let Some(row) = stored.first() {
                    if rows.is_some() {
                        tokio::task::yield_now().await;
                        continue;
                    }
                    assert_eq!(stored.len(), 1);
                    assert_eq!(row.label, "device");
                    assert_eq!(row.secrets.access_token.as_deref(), Some("survived"));
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached device completion persisted and consumed");
    }

    #[tokio::test]
    async fn device_begin_reply_and_pkce_bytes_are_stable() {
        let flows = ConnectFlows::default();
        let start = AuthorizeStart {
            authorize_url: "https://device.fixture/activate".into(),
            pending: PendingFlow {
                verifier: String::new(),
                challenge: String::new(),
                state: String::new(),
                redirect_uri: String::new(),
                device_code: Some("dc".into()),
                interval: Some(3.0),
                extra: serde_json::from_str(r#"{"deviceId":"machine"}"#).expect("extra"),
            },
            user_code: Some("ABCD-1234".into()),
        };
        let reply = flows
            .store_flow(
                "device-fixture",
                string("device"),
                None,
                &start,
                "device",
                false,
            )
            .await
            .expect("reply");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("json");
        assert_eq!(value["kind"], "device");
        assert_eq!(value["userCode"], "ABCD-1234");
        assert_eq!(value["supportsManualPaste"], false);
        assert_eq!(value["pollIntervalMs"], 3000);
        assert_eq!(value["authorizeUrl"], "https://device.fixture/activate");
        let flow = flows
            .pending(value["flowId"].as_str().expect("id"), false)
            .await
            .expect("stored");
        assert!(device_flow(&flow));
        assert_eq!(text(get(&flow, "userCode")).as_deref(), Some("ABCD-1234"));
        let pending = pending_value(&flow).expect("pending");
        assert_eq!(pending.device_code.as_deref(), Some("dc"));
        assert_eq!(pending.interval, Some(3.0));
        assert_eq!(
            pending
                .extra
                .get("deviceId")
                .and_then(serde_json::Value::as_str),
            Some("machine")
        );
        let pkce = AuthorizeStart {
            authorize_url: "https://pkce.fixture/authorize".into(),
            pending: PendingFlow {
                verifier: "v".into(),
                challenge: "c".into(),
                state: "s".into(),
                redirect_uri: "r".into(),
                device_code: None,
                interval: None,
                extra: serde_json::Map::new(),
            },
            user_code: None,
        };
        let reply = flows
            .store_flow("fixture", string("fixture"), None, &pkce, "pkce", true)
            .await
            .expect("reply");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("json");
        assert_eq!(value["userCode"], serde_json::Value::Null);
        assert_eq!(value["kind"], "pkce");
        assert_eq!(value["supportsManualPaste"], true);
        assert_eq!(value["pollIntervalMs"], 5000);
        let flow = flows
            .pending(value["flowId"].as_str().expect("id"), false)
            .await
            .expect("stored");
        assert!(!device_flow(&flow));
        assert_eq!(
            stringify(get(&flow, "pending").expect("pending")).expect("json"),
            r#"{"verifier":"v","challenge":"c","state":"s","redirectUri":"r"}"#
        );
    }

    // --- kimi device flow ----------------------------------------------------
    // Mirrors control/test/oauth/kimi.test.ts against the real host wiring:
    // the pure builders' bytes, the store/poll/persist machinery, and the
    // refresher's token classification.

    const KIMI_DEVICE_DATA: &str = r#"{"deviceId":"11111111-2222-3333-4444-555555555555","deviceName":"MacBook-Pro","deviceModel":"MacBookPro18,3","osVersion":"15.3.1"}"#;
    const KIMI_FLOW: &str = r#"{"provider":"kimi","label":"kimi","pending":{"verifier":"","challenge":"","state":"","redirectUri":"","deviceCode":"dc-1","interval":5,"extra":{"deviceId":"11111111-2222-3333-4444-555555555555","deviceName":"MacBook-Pro","deviceModel":"MacBookPro18,3","osVersion":"15.3.1"}}}"#;
    const KIMI_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
    const KIMI_TOKEN_URL: &str = "https://auth.kimi.com/api/oauth/token";
    const KIMI_EXCHANGE_BODY: &str = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc-1&device_id=11111111-2222-3333-4444-555555555555&client_id=17e5f671-d194-4dfb-9706-5516cb48c098";
    const KIMI_AUTH_HEADERS: [(&str, &str); 9] = [
        ("Content-Type", "application/x-www-form-urlencoded"),
        ("X-Msh-Platform", "kimi_code_cli"),
        ("X-Msh-Version", "0.26.0"),
        ("X-Msh-Device-Id", "11111111-2222-3333-4444-555555555555"),
        ("X-Msh-Device-Name", "MacBook-Pro"),
        ("X-Msh-Device-Model", "MacBookPro18,3"),
        ("X-Msh-Os-Version", "15.3.1"),
        ("User-Agent", "kimi-code-cli/0.26.0"),
        ("Accept", "application/json"),
    ];

    fn kimi_headers() -> Vec<(String, String)> {
        KIMI_AUTH_HEADERS
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
            .collect()
    }

    /// Like `Scripted`, but keeps every request so tests can assert on the
    /// identity headers and form bytes that reached the transport.
    struct Captured {
        status: u16,
        body: &'static str,
        seen: std::sync::Mutex<Vec<omni_providers::http::HttpRequest>>,
    }
    impl Captured {
        fn new(status: u16, body: &'static str) -> Arc<Self> {
            Arc::new(Self {
                status,
                body,
                seen: std::sync::Mutex::new(Vec::new()),
            })
        }
        fn last(&self) -> omni_providers::http::HttpRequest {
            self.seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .last()
                .cloned()
                .expect("captured request")
        }
    }
    impl omni_providers::http::HttpClient for Captured {
        fn send(
            &self,
            req: omni_providers::http::HttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<
                            omni_providers::http::HttpResponse,
                            omni_providers::http::HttpError,
                        >,
                    > + Send
                    + '_,
            >,
        > {
            self.seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(req);
            Box::pin(async {
                Ok(omni_providers::http::HttpResponse {
                    status: self.status,
                    headers: omni_providers::http::Headers::new(),
                    body: omni_providers::http::ResponseBody::from_bytes(self.body),
                })
            })
        }
    }

    /// A kimi device flow at `oauth:pending:dev` with a frozen identity and a
    /// fixed clock, so expiry arithmetic is pinnable.
    async fn kimi_harness(
        http: Arc<dyn omni_providers::http::HttpClient>,
    ) -> (
        tempfile::TempDir,
        Arc<crate::refresh::Refresher>,
        Arc<omni_gateway_core::snapshot::SnapshotHolder>,
        Arc<ConnectFlows>,
    ) {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let holder = Arc::new(
            omni_gateway_core::snapshot::SnapshotHolder::build(
                &omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("sqlite"),
                key.clone(),
                0.0,
            )
            .expect("snapshot"),
        );
        let host = Arc::new(crate::refresh::Refresher::new(store, key, http, || {
            1_000_000
        }));
        let flows = Arc::new(ConnectFlows::default());
        flows
            .coord
            .kv_set("oauth:pending:dev", KIMI_FLOW, 600_000)
            .await
            .expect("put");
        (dir, host, holder, flows)
    }

    /// A stored kimi credential plus a refresher answering `status`/`body`.
    async fn kimi_refresh_harness(
        status: u16,
        body: &'static str,
    ) -> (
        tempfile::TempDir,
        Arc<omni_store::Store>,
        omni_crypto::field::FieldKey,
        Arc<crate::refresh::Refresher>,
        Arc<Captured>,
        omni_store::credentials::Credential,
    ) {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let http = Captured::new(status, body);
        let host = Arc::new(crate::refresh::Refresher::new(
            store.clone(),
            key.clone(),
            http.clone(),
            || 1_000_000,
        ));
        let tokens = omni_store::credentials::TokenUpdate {
            access_token: Some("test-token-1".into()),
            refresh_token: Some("test-token-2".into()),
            api_key: None,
            id_token: None,
            expires_at: Some(2_000_000.0),
            updated_at: 0,
        };
        store
            .save_oauth(
                &key,
                &omni_store::credentials::OAuthCredential {
                    id: "k1",
                    provider: "kimi",
                    label: "kimi",
                    provider_data: KIMI_DEVICE_DATA,
                    account_email: None,
                    tokens: &tokens,
                    reconnect: false,
                },
            )
            .await
            .expect("save");
        let credential = store
            .credential(&key, "k1")
            .await
            .expect("read")
            .expect("present");
        (dir, store, key, host, http, credential)
    }

    #[tokio::test]
    async fn kimi_begin_request_bytes_and_reply_shape() {
        let device_id = "11111111-2222-3333-4444-555555555555";
        let request = omni_providers::kimi::oauth::begin_request(device_id).expect("begin");
        assert_eq!(
            request.url,
            "https://auth.kimi.com/api/oauth/device_authorization"
        );
        assert_eq!(request.method, "POST");
        assert_eq!(request.headers, kimi_headers());
        assert_eq!(request.body, format!("client_id={KIMI_CLIENT_ID}"));

        let start = omni_providers::kimi::oauth::begin_result(
            200,
            r#"{"device_code":"dc-1","user_code":"WDJB-MJHT","verification_uri":"https://kimi.example/device","verification_uri_complete":"https://kimi.example/device?user_code=WDJB-MJHT","interval":5}"#,
            device_id,
        )
        .expect("begin result");
        assert_eq!(start.user_code.as_deref(), Some("WDJB-MJHT"));
        assert_eq!(
            start.authorize_url,
            "https://kimi.example/device?user_code=WDJB-MJHT"
        );
        assert_eq!(start.pending.device_code.as_deref(), Some("dc-1"));
        assert_eq!(start.pending.interval, Some(5.0));

        let flows = ConnectFlows::default();
        let reply = flows
            .store_flow("kimi", string("kimi"), None, &start, "device", false)
            .await
            .expect("reply");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("json");
        assert_eq!(value["kind"], "device");
        assert_eq!(value["userCode"], "WDJB-MJHT");
        assert_eq!(value["supportsManualPaste"], false);
        assert_eq!(value["pollIntervalMs"], 5000);
        assert_eq!(
            value["authorizeUrl"],
            "https://kimi.example/device?user_code=WDJB-MJHT"
        );
        let flow = flows
            .pending(value["flowId"].as_str().expect("id"), false)
            .await
            .expect("stored");
        assert!(device_flow(&flow));
        let pending = pending_value(&flow).expect("pending");
        assert_eq!(
            pending
                .extra
                .get("deviceId")
                .and_then(serde_json::Value::as_str),
            Some(device_id)
        );
    }

    #[test]
    fn kimi_begin_rejects_a_blank_device_id_before_any_request() {
        // INTERNAL, not a bare failure: a flow that needs an identity and did
        // not mint one is a gateway bug, not something the operator did.
        let error = omni_providers::kimi::oauth::begin_request("  ").expect_err("blank");
        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(error.message, "kimi begin requires a non-blank deviceId");
    }

    #[test]
    fn kimi_begin_rejects_a_blank_required_field() {
        let error = match omni_providers::kimi::oauth::begin_result(
            200,
            r#"{"device_code":"","user_code":"WDJB-MJHT"}"#,
            "11111111-2222-3333-4444-555555555555",
        ) {
            Err(error) => error,
            Ok(_) => panic!("expected an unusable response"),
        };
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "device code endpoint returned an unusable response"
        );
    }

    #[tokio::test]
    async fn kimi_poll_pending_keeps_flow_and_sends_the_device_identity() {
        let http = Captured::new(400, r#"{"error":"authorization_pending"}"#);
        let (_dir, host, holder, flows) = kimi_harness(http.clone()).await;
        let error = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(error.message, PENDING_MARKER);
        assert_eq!(
            poll_reply(Err(error)).expect("reply"),
            r#"{"status":"pending"}"#
        );
        let sent = http.last();
        assert_eq!(sent.url, KIMI_TOKEN_URL);
        assert_eq!(sent.headers, kimi_headers());
        assert_eq!(sent.body, KIMI_EXCHANGE_BODY);
        let stored = flows.pending("dev", false).await.expect("kept");
        let pending = pending_value(&stored).expect("pending");
        assert_eq!(pending.device_code.as_deref(), Some("dc-1"));
        assert_eq!(pending.interval, Some(5.0));
        assert_eq!(
            pending
                .extra
                .get("deviceId")
                .and_then(serde_json::Value::as_str),
            Some("11111111-2222-3333-4444-555555555555")
        );
        // A second poll runs a fresh exchange against the kept flow.
        let again = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(again.message, PENDING_MARKER);
        assert!(flows.pending("dev", false).await.is_ok());
    }

    #[tokio::test]
    async fn kimi_poll_slow_down_is_also_pending() {
        let http = Captured::new(400, r#"{"error":"slow_down"}"#);
        let (_dir, host, holder, flows) = kimi_harness(http).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(error.message, PENDING_MARKER);
        assert!(flows.pending("dev", false).await.is_ok());
    }

    #[tokio::test]
    async fn kimi_poll_denied_is_a_terminal_auth_error() {
        let http = Captured::new(400, r#"{"error":"access_denied"}"#);
        let (_dir, host, holder, flows) = kimi_harness(http).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("denied");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "token endpoint rejected the request: access_denied"
        );
        assert!(poll_reply(Err(error)).is_err());
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn kimi_poll_approval_persists_the_device_identity() {
        let http = Captured::new(
            200,
            r#"{"access_token":"test-token-1","refresh_token":"test-token-2","expires_in":3600}"#,
        );
        let (_dir, host, holder, flows) = kimi_harness(http.clone()).await;
        let id = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect("approved");
        assert_eq!(
            poll_reply(Ok(id.clone())).expect("reply"),
            serde_json::json!({"status":"complete","id":id}).to_string()
        );
        assert_eq!(http.last().body, KIMI_EXCHANGE_BODY);
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider, "kimi");
        assert_eq!(
            rows[0].secrets.access_token.as_deref(),
            Some("test-token-1")
        );
        assert_eq!(
            rows[0].secrets.refresh_token.as_deref(),
            Some("test-token-2")
        );
        // The identity sent upstream is the one frozen onto the credential.
        assert_eq!(
            rows[0].provider_data,
            serde_json::from_str::<serde_json::Value>(KIMI_DEVICE_DATA).expect("data")
        );
        let connected = &holder.load().routing.credentials[0];
        assert_eq!(connected.id, id);
        assert_eq!(connected.expires_at, Some(1_000_000.0 + 3_600_000.0));
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn kimi_poll_rejects_a_blank_access_token() {
        let http = Captured::new(200, r#"{"access_token":""}"#);
        let (_dir, host, holder, flows) = kimi_harness(http).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("blank token");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(error.message, "token endpoint returned no access_token");
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn kimi_exchange_without_a_device_code_is_a_programming_error() {
        let http = Captured::new(200, "{}");
        let (_dir, host, _holder, _flows) = kimi_harness(http.clone()).await;
        let pending = PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: String::new(),
            redirect_uri: String::new(),
            device_code: None,
            interval: None,
            extra: serde_json::Map::new(),
        };
        match device_exchange("kimi", &host, &pending, &serde_json::Value::Null).await {
            Err(DeviceError::Gateway(error)) => {
                assert_eq!(error.code, ErrorCode::Internal);
                assert_eq!(
                    error.message,
                    "kimi exchange requires a pending flow produced by begin()"
                );
            }
            Err(DeviceError::Pending) => panic!("expected internal error, got pending"),
            Ok(_) => panic!("expected internal error, got a completed flow"),
        }
        assert!(
            http.seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty(),
            "nothing may reach transport without a device code"
        );
    }

    #[tokio::test]
    async fn kimi_refresh_returns_a_new_access_token_and_reuses_the_stored_device() {
        let (_dir, store, key, host, http, credential) =
            kimi_refresh_harness(200, r#"{"access_token":"test-token-3","expires_in":60}"#).await;
        let secrets = host.refresh(&credential).await.expect("refresh");
        assert_eq!(secrets.access_token.as_deref(), Some("test-token-3"));
        assert_eq!(secrets.refresh_token.as_deref(), Some("test-token-2"));
        let sent = http.last();
        assert_eq!(sent.url, KIMI_TOKEN_URL);
        assert_eq!(sent.headers, kimi_headers());
        assert_eq!(
            sent.body,
            format!(
                "grant_type=refresh_token&refresh_token=test-token-2&device_id=11111111-2222-3333-4444-555555555555&client_id={KIMI_CLIENT_ID}"
            )
        );
        let stored = store
            .credential(&key, "k1")
            .await
            .expect("read")
            .expect("present");
        assert_eq!(stored.expires_at, Some(1_000_000.0 + 60_000.0));
        assert_eq!(
            stored.provider_data,
            serde_json::from_str::<serde_json::Value>(KIMI_DEVICE_DATA).expect("data")
        );
        assert_eq!(
            stored.secrets.refresh_token.as_deref(),
            Some("test-token-2")
        );
    }

    #[tokio::test]
    async fn kimi_refresh_preserves_the_stored_token_when_the_new_one_is_blank() {
        let (_dir, _store, _key, host, _http, credential) =
            kimi_refresh_harness(200, r#"{"access_token":"test-token-3","refresh_token":""}"#)
                .await;
        let secrets = host.refresh(&credential).await.expect("refresh");
        assert_eq!(secrets.access_token.as_deref(), Some("test-token-3"));
        assert_eq!(secrets.refresh_token.as_deref(), Some("test-token-2"));
    }

    #[tokio::test]
    async fn kimi_refresh_classifies_token_endpoint_failures() {
        // A provider having a bad minute must not disable a healthy
        // credential: the refresher disables only on AUTH.
        for (status, body, code) in [
            (500, r#"{"error":"internal_error"}"#, ErrorCode::Upstream),
            (503, "{}", ErrorCode::Upstream),
            (400, r#"{"error":"invalid_grant"}"#, ErrorCode::Auth),
            (429, r#"{"error":"rate_limited"}"#, ErrorCode::RateLimit),
        ] {
            let (_dir, store, key, host, _http, credential) =
                kimi_refresh_harness(status, body).await;
            let error = host.refresh(&credential).await.expect_err("classified");
            assert_eq!(error.code, code, "{status} {body}");
            let stored = store
                .credential(&key, "k1")
                .await
                .expect("read")
                .expect("present");
            assert_eq!(stored.enabled, code != ErrorCode::Auth, "{status} {body}");
        }
    }

    // --- kilo device flow ----------------------------------------------------
    // Mirrors control/test/oauth/kilo.test.ts against the real host wiring:
    // the non-RFC status ladder, the local expiry deadline, the best-effort
    // organization read, and the refresh refusal.

    const KILO_NOW: f64 = 1_000_000.0;
    const KILO_CODES_URL: &str = "https://api.kilo.ai/api/device-auth/codes";
    const KILO_PROFILE_URL: &str = "https://api.kilo.ai/api/profile";
    const KILO_FLOW: &str = r#"{"provider":"kilo","label":"kilo","pending":{"verifier":"","challenge":"","state":"","redirectUri":"","deviceCode":"KILO-CODE-1","interval":3,"extra":{"expiresAt":1300000}}}"#;
    const KILO_EXPIRED_FLOW: &str = r#"{"provider":"kilo","label":"kilo","pending":{"verifier":"","challenge":"","state":"","redirectUri":"","deviceCode":"KILO-CODE-1","interval":3,"extra":{"expiresAt":999999}}}"#;
    const KILO_APPROVED: &str =
        r#"{"status":"approved","token":"kilo-token-1","userEmail":"user@example.com"}"#;

    enum KiloReply {
        Response(u16, &'static str),
        Reset,
    }

    /// Answers each call from a queue and records what was asked, so tests
    /// can assert on the poll URL and the organization read's bearer.
    struct KiloStub {
        replies: std::sync::Mutex<std::collections::VecDeque<KiloReply>>,
        seen: std::sync::Mutex<Vec<omni_providers::http::HttpRequest>>,
    }
    impl KiloStub {
        fn new(replies: Vec<KiloReply>) -> Arc<Self> {
            Arc::new(Self {
                replies: std::sync::Mutex::new(replies.into()),
                seen: std::sync::Mutex::new(Vec::new()),
            })
        }
        fn requests(&self) -> Vec<omni_providers::http::HttpRequest> {
            self.seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }
    impl omni_providers::http::HttpClient for KiloStub {
        fn send(
            &self,
            req: omni_providers::http::HttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<
                            omni_providers::http::HttpResponse,
                            omni_providers::http::HttpError,
                        >,
                    > + Send
                    + '_,
            >,
        > {
            self.seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(req.clone());
            let reply = self
                .replies
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop_front();
            Box::pin(async move {
                match reply {
                    Some(KiloReply::Response(status, body)) => {
                        Ok(omni_providers::http::HttpResponse {
                            status,
                            headers: omni_providers::http::Headers::new(),
                            body: omni_providers::http::ResponseBody::from_bytes(body),
                        })
                    }
                    Some(KiloReply::Reset) => {
                        Err(omni_providers::http::HttpError::ConnectionClosed)
                    }
                    None => panic!("unexpected request to {}", req.url),
                }
            })
        }
    }

    /// A stored kilo flow with a fixed clock, so expiry arithmetic is pinnable.
    async fn kilo_harness(
        http: Arc<dyn omni_providers::http::HttpClient>,
        flow: &'static str,
    ) -> (
        tempfile::TempDir,
        Arc<crate::refresh::Refresher>,
        Arc<omni_gateway_core::snapshot::SnapshotHolder>,
        Arc<ConnectFlows>,
    ) {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let holder = Arc::new(
            omni_gateway_core::snapshot::SnapshotHolder::build(
                &omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("sqlite"),
                key.clone(),
                0.0,
            )
            .expect("snapshot"),
        );
        let host = Arc::new(crate::refresh::Refresher::new(store, key, http, || {
            1_000_000
        }));
        let flows = Arc::new(ConnectFlows::default());
        flows
            .coord
            .kv_set("oauth:pending:dev", flow, 600_000)
            .await
            .expect("put");
        (dir, host, holder, flows)
    }

    #[tokio::test]
    async fn kilo_begin_request_bytes_and_reply_shape() {
        let request = omni_providers::kilo::oauth::begin_request();
        assert_eq!(request.url, KILO_CODES_URL);
        assert_eq!(request.method, "POST");
        // The endpoint takes no parameters at all: the body is "", not "{}".
        assert_eq!(request.body, "");
        assert_eq!(
            request.headers,
            vec![
                ("Content-Type".to_owned(), "application/json".to_owned()),
                ("X-KILOCODE-EDITORNAME".to_owned(), "vscode".to_owned()),
                ("User-Agent".to_owned(), "Kilo-Code/4.140.0".to_owned()),
                ("Accept".to_owned(), "application/json".to_owned()),
            ]
        );

        let start = omni_providers::kilo::oauth::begin_result(
            200,
            r#"{"code":"KILO-CODE-1","verificationUrl":"https://kilo.ai/device?c=1","expiresIn":600}"#,
            KILO_NOW,
        )
        .expect("begin result");
        assert_eq!(start.authorize_url, "https://kilo.ai/device?c=1");
        // One value serves as both: the operator reads it, and the poll redeems it.
        assert_eq!(start.user_code.as_deref(), Some("KILO-CODE-1"));
        assert_eq!(start.pending.device_code.as_deref(), Some("KILO-CODE-1"));
        assert_eq!(start.pending.interval, Some(3.0));
        assert_eq!(
            start
                .pending
                .extra
                .get("expiresAt")
                .and_then(serde_json::Value::as_f64),
            Some(KILO_NOW + 600_000.0)
        );

        let flows = ConnectFlows::default();
        let reply = flows
            .store_flow("kilo", string("kilo"), None, &start, "device", false)
            .await
            .expect("reply");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("json");
        assert_eq!(value["kind"], "device");
        assert_eq!(value["userCode"], "KILO-CODE-1");
        assert_eq!(value["supportsManualPaste"], false);
        assert_eq!(value["pollIntervalMs"], 3000);
        assert_eq!(value["authorizeUrl"], "https://kilo.ai/device?c=1");
        let flow = flows
            .pending(value["flowId"].as_str().expect("id"), false)
            .await
            .expect("stored");
        assert!(device_flow(&flow));
    }

    #[test]
    fn kilo_begin_defaults_the_code_lifetime_and_verification_url() {
        let start = omni_providers::kilo::oauth::begin_result(
            200,
            r#"{"code":"KILO-CODE-1","verificationUrl":"https://kilo.ai/device"}"#,
            KILO_NOW,
        )
        .expect("begin result");
        assert_eq!(
            start
                .pending
                .extra
                .get("expiresAt")
                .and_then(serde_json::Value::as_f64),
            Some(KILO_NOW + 300_000.0)
        );
        let bare = omni_providers::kilo::oauth::begin_result(200, r#"{"code":"c"}"#, KILO_NOW)
            .expect("begin result");
        assert_eq!(bare.authorize_url, "https://kilo.ai");
    }

    #[test]
    fn kilo_begin_status_ladder() {
        fn begin_err(status: u16, text: &str) -> GatewayError {
            match omni_providers::kilo::oauth::begin_result(status, text, KILO_NOW) {
                Err(error) => error,
                Ok(_) => panic!("expected begin to fail: {status} {text}"),
            }
        }
        // Distinct from a generic failure: an earlier authorization of the
        // operator's is still open and has to age out.
        let error = begin_err(429, r#"{"error":"too_many_requests"}"#);
        assert_eq!(error.code, ErrorCode::RateLimit);
        assert_eq!(
            error.message,
            "kilo has too many pending device authorizations; wait for one to expire and retry"
        );
        for (status, code) in [(403, ErrorCode::Auth), (500, ErrorCode::Upstream)] {
            let error = begin_err(status, "{}");
            assert_eq!(error.code, code, "{status}");
            assert_eq!(
                error.message,
                format!("kilo refused a device code: http_{status}")
            );
        }
        let error = begin_err(200, r#"{"verificationUrl":"https://kilo.ai/device"}"#);
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "device code endpoint returned an unusable response"
        );
    }

    #[tokio::test]
    async fn kilo_poll_202_is_pending_and_keeps_the_flow() {
        let http = KiloStub::new(vec![
            KiloReply::Response(202, "{}"),
            KiloReply::Response(202, "{}"),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), KILO_FLOW).await;
        let error = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(error.message, PENDING_MARKER);
        assert_eq!(
            poll_reply(Err(error)).expect("reply"),
            r#"{"status":"pending"}"#
        );
        let sent = http.requests();
        assert_eq!(sent[0].url, format!("{KILO_CODES_URL}/KILO-CODE-1"));
        assert_eq!(sent[0].method, "GET");
        assert_eq!(sent[0].body, "");
        // The poll is what earns the token; there is nothing to authenticate it with.
        assert!(
            !sent[0]
                .headers
                .iter()
                .any(|(n, _)| n.eq_ignore_ascii_case("authorization"))
        );
        assert!(flows.pending("dev", false).await.is_ok());
        // A second poll runs a fresh exchange against the kept flow.
        let again = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(again.message, PENDING_MARKER);
        assert!(flows.pending("dev", false).await.is_ok());
    }

    #[tokio::test]
    async fn kilo_poll_200_not_approved_is_still_pending() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, r#"{"status":"waiting"}"#),
            // A non-JSON 200 is also a state on the way, not a failure.
            KiloReply::Response(200, "<html>"),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http, KILO_FLOW).await;
        for _ in 0..2 {
            let error = flows
                .poll(host.clone(), holder.clone(), "dev".into())
                .await
                .expect_err("pending");
            assert_eq!(error.message, PENDING_MARKER);
        }
        assert!(flows.pending("dev", false).await.is_ok());
    }

    #[tokio::test]
    async fn kilo_poll_403_is_a_denial_and_ends_the_flow() {
        let http = KiloStub::new(vec![KiloReply::Response(403, "{}")]);
        let (_dir, host, holder, flows) = kilo_harness(http, KILO_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("denied");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(error.message, "kilo authorization was denied");
        assert!(poll_reply(Err(error)).is_err());
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn kilo_poll_410_means_the_code_expired() {
        let http = KiloStub::new(vec![KiloReply::Response(410, "{}")]);
        let (_dir, host, holder, flows) = kilo_harness(http, KILO_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("expired");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "kilo device code expired; start the authorization again"
        );
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn kilo_poll_other_failures_are_classified_by_status() {
        for (status, code) in [(429, ErrorCode::RateLimit), (500, ErrorCode::Upstream)] {
            let http = KiloStub::new(vec![KiloReply::Response(status, "{}")]);
            let (_dir, host, holder, flows) = kilo_harness(http, KILO_FLOW).await;
            let error = flows
                .poll(host, holder, "dev".into())
                .await
                .expect_err("refused");
            assert_eq!(error.code, code, "{status}");
            assert_eq!(
                error.message,
                format!("kilo refused the device code poll: http_{status}")
            );
            assert!(flows.pending("dev", false).await.is_err());
        }
    }

    #[tokio::test]
    async fn kilo_code_past_its_stated_lifetime_is_not_polled_at_all() {
        let http = KiloStub::new(Vec::new());
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), KILO_EXPIRED_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("expired");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "kilo device code expired; start the authorization again"
        );
        assert!(http.requests().is_empty());
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn kilo_exchange_without_a_device_code_is_a_programming_error() {
        let http = KiloStub::new(Vec::new());
        let (_dir, host, _holder, _flows) = kilo_harness(http.clone(), KILO_FLOW).await;
        let pending = PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: String::new(),
            redirect_uri: String::new(),
            device_code: None,
            interval: None,
            extra: serde_json::Map::new(),
        };
        match device_exchange("kilo", &host, &pending, &serde_json::Value::Null).await {
            Err(DeviceError::Gateway(error)) => {
                assert_eq!(error.code, ErrorCode::Internal);
                assert_eq!(
                    error.message,
                    "kilo exchange requires a pending flow produced by begin()"
                );
            }
            Err(DeviceError::Pending) => panic!("expected internal error, got pending"),
            Ok(_) => panic!("expected internal error, got a completed flow"),
        }
        assert!(http.requests().is_empty());
    }

    #[tokio::test]
    async fn kilo_approved_poll_persists_token_email_and_organization() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, KILO_APPROVED),
            KiloReply::Response(
                200,
                r#"{"organizations":[{"id":"org-42"},{"id":"org-99"}]}"#,
            ),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), KILO_FLOW).await;
        let id = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect("approved");
        assert_eq!(
            poll_reply(Ok(id.clone())).expect("reply"),
            serde_json::json!({"status":"complete","id":id}).to_string()
        );
        let sent = http.requests();
        assert_eq!(sent.len(), 2);
        // The organization is read with the token the poll just returned.
        assert_eq!(sent[1].url, KILO_PROFILE_URL);
        assert_eq!(sent[1].method, "GET");
        assert!(
            sent[1]
                .headers
                .iter()
                .any(|(n, v)| n == "Authorization" && v == "Bearer kilo-token-1")
        );
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider, "kilo");
        assert_eq!(
            rows[0].secrets.access_token.as_deref(),
            Some("kilo-token-1")
        );
        // Kilo issues neither, and inventing either would have the scheduler
        // chase a refresh that can only fail.
        assert_eq!(rows[0].secrets.refresh_token.as_deref(), None);
        assert_eq!(rows[0].expires_at, None);
        assert_eq!(rows[0].account_email.as_deref(), Some("user@example.com"));
        assert_eq!(rows[0].provider_data, serde_json::json!({"orgId":"org-42"}));
        let connected = &holder.load().routing.credentials[0];
        assert_eq!(connected.id, id);
        assert_eq!(connected.expires_at, None);
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn kilo_account_with_no_organization_connects_without_one() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, KILO_APPROVED),
            KiloReply::Response(200, r#"{"organizations":[]}"#),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http, KILO_FLOW).await;
        flows
            .poll(host.clone(), holder, "dev".into())
            .await
            .expect("approved");
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(
            rows[0].secrets.access_token.as_deref(),
            Some("kilo-token-1")
        );
        assert_eq!(rows[0].provider_data, serde_json::json!({}));
    }

    #[tokio::test]
    async fn kilo_failed_profile_read_still_completes_the_connect() {
        // An operator who watched the browser say "approved" must not be told
        // the connect failed because a secondary read did — nor may the
        // failure surface as AUTH, which disables credentials.
        for failure in [
            KiloReply::Response(500, r#"{"error":"boom"}"#),
            KiloReply::Response(401, r#"{"error":"unauthorized"}"#),
            KiloReply::Reset,
        ] {
            let http = KiloStub::new(vec![KiloReply::Response(200, KILO_APPROVED), failure]);
            let (_dir, host, holder, flows) = kilo_harness(http, KILO_FLOW).await;
            flows
                .poll(host.clone(), holder, "dev".into())
                .await
                .expect("approved despite the failed organization read");
            let rows = host.store.list_credentials(&host.key).await.expect("rows");
            assert_eq!(
                rows[0].secrets.access_token.as_deref(),
                Some("kilo-token-1")
            );
            assert_eq!(rows[0].provider_data, serde_json::json!({}));
            assert!(rows[0].enabled);
        }
    }

    #[tokio::test]
    async fn kilo_approved_poll_without_a_token_is_refused() {
        let http = KiloStub::new(vec![KiloReply::Response(
            200,
            r#"{"status":"approved","userEmail":"u@example.com"}"#,
        )]);
        let (_dir, host, holder, flows) = kilo_harness(http, KILO_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("no token");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "kilo approved the authorization without a token"
        );
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn kilo_refresh_refuses_and_disables_without_a_request() {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let http = KiloStub::new(Vec::new());
        let host = Arc::new(crate::refresh::Refresher::new(
            store.clone(),
            key.clone(),
            http.clone(),
            || 1_000_000,
        ));
        let tokens = omni_store::credentials::TokenUpdate {
            access_token: Some("kilo-token-1".into()),
            refresh_token: None,
            api_key: None,
            id_token: None,
            expires_at: None,
            updated_at: 0,
        };
        store
            .save_oauth(
                &key,
                &omni_store::credentials::OAuthCredential {
                    id: "k1",
                    provider: "kilo",
                    label: "kilo",
                    provider_data: "{}",
                    account_email: None,
                    tokens: &tokens,
                    reconnect: false,
                },
            )
            .await
            .expect("save");
        let credential = store
            .credential(&key, "k1")
            .await
            .expect("read")
            .expect("present");
        let error = host.refresh(&credential).await.expect_err("refused");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "kilo tokens cannot be refreshed; reconnect the kilo account to get a new one"
        );
        assert!(http.requests().is_empty());
        let stored = store
            .credential(&key, "k1")
            .await
            .expect("read")
            .expect("present");
        assert!(!stored.enabled);
    }

    // --- grok pkce + discovery flow ------------------------------------------
    // Mirrors control/test/oauth/grok.test.ts against the real host wiring:
    // discovery on every step, the x.ai origin rule, the pasted-state check
    // before any request, and the connect-time agent identity.

    const GROK_DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
    const GROK_AUTHORIZE_URL: &str = "https://auth.x.ai/oauth2/auth";
    const GROK_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
    const GROK_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
    const GROK_SCOPES: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";
    const GROK_CALLBACK: &str = "http://127.0.0.1:56121/callback";
    const GROK_FLOW: &str = r#"{"provider":"grok","label":"grok","pending":{"verifier":"v","challenge":"c","state":"s","redirectUri":"http://127.0.0.1:56121/callback"}}"#;
    const GROK_OK_TOKEN: &str =
        r#"{"access_token":"test-token-1","refresh_token":"test-token-2","expires_in":3600}"#;
    const GROK_DISCOVERY: &str = r#"{"authorization_endpoint":"https://auth.x.ai/oauth2/auth","token_endpoint":"https://auth.x.ai/oauth2/token"}"#;
    const GROK_EXCHANGE_BODY: &str = "grant_type=authorization_code&code=auth-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A56121%2Fcallback&client_id=b1a00492-073a-47ea-816f-4c329264a828&code_verifier=v";
    const GROK_REFRESH_BODY: &str = "grant_type=refresh_token&client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=test-token-2";

    /// Answers discovery and the token endpoint separately, since every grok
    /// flow makes both calls. `token_req()` is the request assertions care about.
    struct GrokStub {
        discovery: (u16, String),
        token: (u16, String),
        seen: std::sync::Mutex<Vec<omni_providers::http::HttpRequest>>,
    }
    impl GrokStub {
        fn new(token: (u16, &str)) -> Arc<Self> {
            Self::with_discovery(token, (200, GROK_DISCOVERY))
        }
        fn with_discovery(token: (u16, &str), discovery: (u16, &str)) -> Arc<Self> {
            Arc::new(Self {
                discovery: (discovery.0, discovery.1.into()),
                token: (token.0, token.1.into()),
                seen: std::sync::Mutex::new(Vec::new()),
            })
        }
        fn calls(&self) -> Vec<omni_providers::http::HttpRequest> {
            self.seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
        fn token_req(&self) -> omni_providers::http::HttpRequest {
            self.calls()
                .into_iter()
                .find(|req| req.url != GROK_DISCOVERY_URL)
                .expect("the token endpoint was never called")
        }
    }
    impl omni_providers::http::HttpClient for GrokStub {
        fn send(
            &self,
            req: omni_providers::http::HttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<
                            omni_providers::http::HttpResponse,
                            omni_providers::http::HttpError,
                        >,
                    > + Send
                    + '_,
            >,
        > {
            self.seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(req.clone());
            let (status, body) = if req.url == GROK_DISCOVERY_URL {
                self.discovery.clone()
            } else {
                self.token.clone()
            };
            Box::pin(async move {
                Ok(omni_providers::http::HttpResponse {
                    status,
                    headers: omni_providers::http::Headers::new(),
                    body: omni_providers::http::ResponseBody::from_bytes(body),
                })
            })
        }
    }

    /// A grok exchange host with a fixed clock, so expiry arithmetic is pinnable.
    async fn grok_harness(
        http: Arc<dyn omni_providers::http::HttpClient>,
    ) -> (
        tempfile::TempDir,
        Arc<crate::refresh::Refresher>,
        Arc<omni_gateway_core::snapshot::SnapshotHolder>,
    ) {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let holder = Arc::new(
            omni_gateway_core::snapshot::SnapshotHolder::build(
                &omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("sqlite"),
                key.clone(),
                0.0,
            )
            .expect("snapshot"),
        );
        let host = Arc::new(crate::refresh::Refresher::new(store, key, http, || {
            1_000_000
        }));
        (dir, host, holder)
    }

    /// A stored grok credential with a frozen agent id, plus a refresher
    /// driven by the stub.
    async fn grok_refresh_harness(
        http: Arc<GrokStub>,
    ) -> (
        tempfile::TempDir,
        Arc<omni_store::Store>,
        omni_crypto::field::FieldKey,
        Arc<crate::refresh::Refresher>,
        omni_store::credentials::Credential,
    ) {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let host = Arc::new(crate::refresh::Refresher::new(
            store.clone(),
            key.clone(),
            http,
            || 1_000_000,
        ));
        let tokens = omni_store::credentials::TokenUpdate {
            access_token: Some("test-token-1".into()),
            refresh_token: Some("test-token-2".into()),
            api_key: None,
            id_token: None,
            expires_at: Some(2_000_000.0),
            updated_at: 0,
        };
        store
            .save_oauth(
                &key,
                &omni_store::credentials::OAuthCredential {
                    id: "g1",
                    provider: "grok",
                    label: "grok",
                    provider_data: r#"{"agentId":"agent-1"}"#,
                    account_email: None,
                    tokens: &tokens,
                    reconnect: false,
                },
            )
            .await
            .expect("save");
        let credential = store
            .credential(&key, "g1")
            .await
            .expect("read")
            .expect("present");
        (dir, store, key, host, credential)
    }

    fn grok_flow() -> JsValue {
        parse_js(GROK_FLOW).expect("flow")
    }

    #[tokio::test]
    async fn grok_is_registered_as_a_pasteable_pkce_provider() {
        assert!(PROVIDERS.contains(&("grok", GROK_CALLBACK)));
        let start =
            omni_providers::grok::oauth::start(GROK_AUTHORIZE_URL, GROK_CALLBACK, "v", "c", "s")
                .expect("start");
        let flows = ConnectFlows::default();
        let reply = flows
            .store_flow("grok", string("grok"), None, &start, "pkce", true)
            .await
            .expect("reply");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("json");
        assert_eq!(value["kind"], "pkce");
        assert_eq!(value["supportsManualPaste"], true);
        assert_eq!(value["userCode"], serde_json::Value::Null);
        let flow = flows
            .pending(value["flowId"].as_str().expect("id"), false)
            .await
            .expect("stored");
        assert!(!device_flow(&flow));
        let pending = pending_value(&flow).expect("pending");
        assert_eq!(pending.verifier, "v");
        assert_eq!(pending.redirect_uri, GROK_CALLBACK);
    }

    #[test]
    fn grok_builds_an_authorize_url_on_the_discovered_endpoint() {
        let endpoints =
            omni_providers::grok::oauth::discovery_result(200, GROK_DISCOVERY).expect("discovery");
        assert_eq!(endpoints.authorize_url, GROK_AUTHORIZE_URL);
        assert_eq!(endpoints.token_url, GROK_TOKEN_URL);
        let start = omni_providers::grok::oauth::start(
            &endpoints.authorize_url,
            GROK_CALLBACK,
            "v",
            "c",
            "s",
        )
        .expect("start");
        let url = url::Url::parse(&start.authorize_url).expect("url");
        assert_eq!(
            format!("{}{}", url.origin().ascii_serialization(), url.path()),
            GROK_AUTHORIZE_URL
        );
        let param = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        assert_eq!(param("response_type").as_deref(), Some("code"));
        assert_eq!(param("client_id").as_deref(), Some(GROK_CLIENT_ID));
        assert_eq!(param("redirect_uri").as_deref(), Some(GROK_CALLBACK));
        assert_eq!(param("scope").as_deref(), Some(GROK_SCOPES));
        assert_eq!(param("code_challenge_method").as_deref(), Some("S256"));
        assert_eq!(param("code_challenge").as_deref(), Some("c"));
        assert_eq!(param("state").as_deref(), Some("s"));
        assert!(param("nonce").is_some_and(|n| !n.is_empty()));
        assert_eq!(start.pending.redirect_uri, GROK_CALLBACK);
        // xAI's own build client, never the third-party `plan=generic` pair.
        assert_eq!(param("referrer").as_deref(), Some("grok-build"));
        assert!(param("plan").is_none());
    }

    #[test]
    fn grok_derives_the_challenge_from_the_verifier_it_kept() {
        let (verifier, challenge) = omni_providers::oauth::pkce();
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge, omni_providers::oauth::pkce_challenge(&verifier));
        // An independently computed S256 vector, so the assertion above is
        // not the function checking itself.
        assert_eq!(
            omni_providers::oauth::pkce_challenge("test-verifier"),
            "JBbiqONGWPaAmwXk_8bT6UnlPfrn65D32eZlJS-zGG0"
        );
    }

    #[tokio::test]
    async fn grok_exchanges_a_code_with_a_form_body_and_the_client_identity() {
        let http = GrokStub::new((200, GROK_OK_TOKEN));
        let (_dir, host, holder) = grok_harness(http.clone()).await;
        complete(host, holder, grok_flow(), "auth-code#s")
            .await
            .expect("exchange");
        let sent = http.token_req();
        assert_eq!(sent.url, GROK_TOKEN_URL);
        assert_eq!(sent.method, "POST");
        assert_eq!(sent.body, GROK_EXCHANGE_BODY);
        assert!(!sent.body.contains("client_secret"));
        for pair in [
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("x-grok-client-identifier", "grok-shell"),
            ("Accept", "application/json"),
        ] {
            assert!(
                sent.headers
                    .iter()
                    .any(|(n, v)| (n.as_str(), v.as_str()) == pair),
                "{pair:?} missing from {:?}",
                sent.headers
            );
        }
    }

    #[tokio::test]
    async fn grok_refuses_a_forged_state_before_any_request() {
        let http = GrokStub::new((200, GROK_OK_TOKEN));
        let (_dir, host, holder) = grok_harness(http.clone()).await;
        let error = complete(host, holder, grok_flow(), "auth-code#forged")
            .await
            .expect_err("forged");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(error.message, "authorization state mismatch");
        // The authorization code must never have left the process.
        assert!(http.calls().is_empty());
    }

    #[tokio::test]
    async fn grok_mints_a_synthetic_agent_id_at_connect_time() {
        let http = GrokStub::new((200, GROK_OK_TOKEN));
        let (_dir, host, holder) = grok_harness(http).await;
        let id = complete(host.clone(), holder.clone(), grok_flow(), "auth-code#s")
            .await
            .expect("exchange");
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider, "grok");
        assert_eq!(
            rows[0].secrets.access_token.as_deref(),
            Some("test-token-1")
        );
        assert_eq!(
            rows[0].secrets.refresh_token.as_deref(),
            Some("test-token-2")
        );
        // Synthetic, not the machine's own name: this id goes upstream on
        // every request, and a hostname is routinely an operator's name.
        let agent_id = rows[0].provider_data["agentId"].as_str().expect("agentId");
        assert_eq!(agent_id.len(), 36);
        assert!(
            agent_id
                .chars()
                .all(|c| c == '-' || (c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
        );
        let connected = &holder.load().routing.credentials[0];
        assert_eq!(connected.id, id);
        assert_eq!(connected.expires_at, Some(1_000_000.0 + 3_600_000.0));
    }

    #[tokio::test]
    async fn grok_reads_the_account_email_from_the_id_token() {
        use base64::Engine as _;
        let b64 = |value: serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        let id_token = format!(
            "{}.{}.signature",
            b64(serde_json::json!({"alg": "RS256"})),
            b64(serde_json::json!({"email": "user@example.com"}))
        );
        let body = serde_json::json!({"access_token": "test-token-1", "id_token": id_token});
        let http = GrokStub::new((200, &body.to_string()));
        let (_dir, host, holder) = grok_harness(http).await;
        complete(host.clone(), holder, grok_flow(), "auth-code#s")
            .await
            .expect("exchange");
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows[0].account_email.as_deref(), Some("user@example.com"));
    }

    #[tokio::test]
    async fn grok_tolerates_a_token_response_with_no_id_token() {
        let http = GrokStub::new((200, r#"{"access_token":"test-token-1"}"#));
        let (_dir, host, holder) = grok_harness(http).await;
        complete(host.clone(), holder, grok_flow(), "auth-code#s")
            .await
            .expect("exchange");
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows[0].account_email, None);
        assert_eq!(rows[0].expires_at, None);
    }

    #[tokio::test]
    async fn grok_refresh_sends_the_stored_token_and_reads_no_usage() {
        let http = GrokStub::new((200, GROK_OK_TOKEN));
        let (_dir, _store, _key, host, credential) = grok_refresh_harness(http.clone()).await;
        let secrets = host.refresh(&credential).await.expect("refresh");
        assert_eq!(secrets.access_token.as_deref(), Some("test-token-1"));
        assert_eq!(http.token_req().body, GROK_REFRESH_BODY);
        // Exactly discovery + token: a grok account's usage is unknown
        // rather than unlimited, because nothing here probes a usage endpoint.
        let urls: Vec<String> = http.calls().into_iter().map(|r| r.url).collect();
        assert_eq!(urls, [GROK_DISCOVERY_URL, GROK_TOKEN_URL]);
    }

    #[tokio::test]
    async fn grok_refresh_keeps_the_previous_refresh_token_when_omitted() {
        // xAI rotates conditionally. Reading the omission as a null would
        // destroy a working credential on its first refresh.
        let http = GrokStub::new((200, r#"{"access_token":"test-token-3","expires_in":60}"#));
        let (_dir, store, key, host, credential) = grok_refresh_harness(http).await;
        let secrets = host.refresh(&credential).await.expect("refresh");
        assert_eq!(secrets.access_token.as_deref(), Some("test-token-3"));
        assert_eq!(secrets.refresh_token.as_deref(), Some("test-token-2"));
        let stored = store
            .credential(&key, "g1")
            .await
            .expect("read")
            .expect("present");
        assert_eq!(stored.expires_at, Some(1_000_000.0 + 60_000.0));
        assert_eq!(
            stored.secrets.refresh_token.as_deref(),
            Some("test-token-2")
        );
    }

    #[tokio::test]
    async fn grok_refresh_takes_a_rotated_refresh_token() {
        let http = GrokStub::new((
            200,
            r#"{"access_token":"t","refresh_token":"test-token-10"}"#,
        ));
        let (_dir, _store, _key, host, credential) = grok_refresh_harness(http).await;
        let secrets = host.refresh(&credential).await.expect("refresh");
        assert_eq!(secrets.refresh_token.as_deref(), Some("test-token-10"));
    }

    #[tokio::test]
    async fn grok_refresh_carries_the_connect_time_agent_id_forward() {
        let http = GrokStub::new((200, GROK_OK_TOKEN));
        let (_dir, store, key, host, credential) = grok_refresh_harness(http).await;
        host.refresh(&credential).await.expect("refresh");
        let stored = store
            .credential(&key, "g1")
            .await
            .expect("read")
            .expect("present");
        assert_eq!(
            stored.provider_data,
            serde_json::json!({"agentId": "agent-1"})
        );
    }

    #[tokio::test]
    async fn grok_discovery_refuses_untrusted_token_endpoints() {
        for endpoint in [
            "http://auth.x.ai/oauth2/token",          // plaintext
            "https://auth.evil.example/oauth2/token", // another domain
            "https://evilx.ai/oauth2/token",          // a lookalike domain
            "https://x.ai.attacker.example/token",    // a prefixed domain
        ] {
            let discovery = serde_json::json!({
                "authorization_endpoint": GROK_AUTHORIZE_URL,
                "token_endpoint": endpoint,
            });
            let http =
                GrokStub::with_discovery((200, GROK_OK_TOKEN), (200, &discovery.to_string()));
            let (_dir, host, holder) = grok_harness(http.clone()).await;
            let error = complete(host, holder, grok_flow(), "auth-code#s")
                .await
                .expect_err(endpoint);
            assert_eq!(error.code, ErrorCode::Upstream, "{endpoint}");
            assert_eq!(
                error.message,
                "discovery document token_endpoint is not an x.ai https url"
            );
            // The authorization code must never have left the process.
            let urls: Vec<String> = http.calls().into_iter().map(|r| r.url).collect();
            assert_eq!(urls, [GROK_DISCOVERY_URL], "{endpoint}");
        }
    }

    #[tokio::test]
    async fn grok_discovery_accepts_a_subdomain_of_x_ai() {
        let http = GrokStub::with_discovery(
            (200, GROK_OK_TOKEN),
            (
                200,
                r#"{"authorization_endpoint":"https://accounts.x.ai/oauth2/auth","token_endpoint":"https://accounts.x.ai/oauth2/token"}"#,
            ),
        );
        let (_dir, host, holder) = grok_harness(http.clone()).await;
        complete(host, holder, grok_flow(), "auth-code#s")
            .await
            .expect("exchange");
        assert_eq!(http.token_req().url, "https://accounts.x.ai/oauth2/token");
    }

    #[tokio::test]
    async fn grok_discovery_refuses_unusable_documents() {
        for (status, body, message) in [
            (
                200,
                r#"{"token_endpoint":"https://auth.x.ai/oauth2/token"}"#,
                "discovery document has no authorization_endpoint",
            ),
            (
                200,
                "<html>not json</html>",
                "discovery endpoint returned an unusable response",
            ),
            (
                500,
                r#"{"error":"internal_error"}"#,
                "discovery endpoint returned http_500",
            ),
        ] {
            let http = GrokStub::with_discovery((200, GROK_OK_TOKEN), (status, body));
            let (_dir, host, holder) = grok_harness(http).await;
            let error = complete(host, holder, grok_flow(), "auth-code#s")
                .await
                .expect_err(message);
            assert_eq!(error.code, ErrorCode::Upstream, "{message}");
            assert_eq!(error.message, message);
        }
    }

    #[tokio::test]
    async fn grok_rejected_discovery_does_not_read_as_a_repudiation() {
        // The refresher disables a credential on AUTH alone, and a discovery
        // document says nothing about whether the refresh token is still good.
        let http = GrokStub::with_discovery(
            (200, GROK_OK_TOKEN),
            (
                200,
                r#"{"authorization_endpoint":"https://auth.x.ai/oauth2/auth","token_endpoint":"http://auth.x.ai/token"}"#,
            ),
        );
        let (_dir, store, key, host, credential) = grok_refresh_harness(http).await;
        let error = host.refresh(&credential).await.expect_err("discovery");
        assert_eq!(error.code, ErrorCode::Upstream);
        let stored = store
            .credential(&key, "g1")
            .await
            .expect("read")
            .expect("present");
        assert!(stored.enabled);
    }

    #[tokio::test]
    async fn grok_refresh_classifies_token_endpoint_failures() {
        for (status, body, code) in [
            (401, r#"{"error":"invalid_grant"}"#, ErrorCode::Auth),
            (500, r#"{"error":"internal_error"}"#, ErrorCode::Upstream),
            (503, "{}", ErrorCode::Upstream),
            (429, r#"{"error":"rate_limited"}"#, ErrorCode::RateLimit),
        ] {
            let http = GrokStub::new((status, body));
            let (_dir, store, key, host, credential) = grok_refresh_harness(http).await;
            let error = host.refresh(&credential).await.expect_err("classified");
            assert_eq!(error.code, code, "{status} {body}");
            let stored = store
                .credential(&key, "g1")
                .await
                .expect("read")
                .expect("present");
            assert_eq!(stored.enabled, code != ErrorCode::Auth, "{status} {body}");
        }
    }

    #[tokio::test]
    async fn grok_exchange_without_an_access_token_fails_the_flow() {
        let http = GrokStub::new((200, r#"{"refresh_token":"test-token-2"}"#));
        let (_dir, host, holder) = grok_harness(http).await;
        let error = complete(host, holder, grok_flow(), "auth-code#s")
            .await
            .expect_err("no access token");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(error.message, "token endpoint returned no access_token");
    }

    #[tokio::test]
    async fn grok_never_puts_the_verifier_or_the_code_in_an_error_message() {
        let http = GrokStub::new((400, r#"{"error":"invalid_grant"}"#));
        let (_dir, host, holder) = grok_harness(http).await;
        let flow = parse_js(
            r#"{"provider":"grok","label":"grok","pending":{"verifier":"verifier-must-not-be-quoted","challenge":"c","state":"s","redirectUri":"http://127.0.0.1:56121/callback"}}"#,
        )
        .expect("flow");
        let error = complete(host, holder, flow, "code-must-not-be-quoted#s")
            .await
            .expect_err("rejected");
        assert!(!error.message.contains("verifier-must-not-be-quoted"));
        assert!(!error.message.contains("code-must-not-be-quoted"));
        assert!(error.message.contains("invalid_grant"), "{}", error.message);
    }

    // --- muse device flow + key mint ------------------------------------------
    // Mirrors control/test/oauth/muse.test.ts against the real host wiring:
    // the two-stage poll+mint, the mint's refusal ladder (which is not the
    // token endpoint's), and the refresh grant that re-mints. `KiloStub` is
    // the shared sequence stub: replies are consumed in order and an
    // unexpected extra request panics rather than being handed a valid mint.

    const MUSE_CLIENT_ID: &str = "1031625952748946";
    const MUSE_DEVICE_URL: &str = "https://auth.meta.com/oidc/device/authorization/";
    const MUSE_TOKEN_URL: &str = "https://auth.meta.com/oidc/device/token/";
    const MUSE_MINT_URL: &str = "https://api.meta.ai/muse-code/key";
    const MUSE_FLOW: &str = r#"{"provider":"muse","label":"muse","pending":{"verifier":"","challenge":"","state":"","redirectUri":"","deviceCode":"dc-1","interval":5}}"#;
    const MUSE_EXCHANGE_BODY: &str = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc-1&client_id=1031625952748946";
    const MUSE_TOKEN: &str =
        r#"{"access_token":"oauth-tok","refresh_token":"oauth-refresh","expires_in":3600}"#;
    /// Shaped on a live `muse-code/key` response with identifying values
    /// replaced: the full field set, `base_url` among them.
    const MUSE_MINTED: &str = r#"{"api_key":"meta-key","base_url":"https://api.meta.ai/v1","user_email":"dev@example.com","user_full_name":"A Developer","is_subs_active":true,"subs_tier_id":"tier-2","subs_tier_name":"Muse Pro","is_subs_upgrade_available":false,"has_payment_method":true,"require_payment":false,"can_subscribe":false,"show_subs_upsell":false,"payment_method":null,"action_url":"https://dev.meta.ai/billing/","subs_usage":{"window":{"used_percent":40,"resets_at":1700000600,"window_duration_mins":300},"weekly":{"used_percent":9,"resets_at":1700086400}}}"#;

    #[test]
    fn muse_is_registered_as_a_device_flow_that_cannot_be_pasted() {
        assert!(PROVIDERS.contains(&("muse", "")));
        // The launcher sends `client_id` and nothing else on any leg: no
        // device identity is demanded before the first request.
        let request = omni_providers::muse::oauth::begin_request();
        assert_eq!(request.body, format!("client_id={MUSE_CLIENT_ID}"));
    }

    #[tokio::test]
    async fn muse_begin_request_bytes_and_reply_shape() {
        let request = omni_providers::muse::oauth::begin_request();
        assert_eq!(request.url, MUSE_DEVICE_URL);
        assert_eq!(request.method, "POST");
        assert_eq!(request.body, format!("client_id={MUSE_CLIENT_ID}"));
        for pair in [
            ("Content-Type", "application/x-www-form-urlencoded"),
            // JSON, not the profile's `text/event-stream`: these endpoints
            // answer JSON and asking for SSE would be a lie.
            ("Accept", "application/json"),
            ("x-api-version", "1.0.0"),
        ] {
            assert!(
                request
                    .headers
                    .contains(&(pair.0.to_owned(), pair.1.to_owned())),
                "{pair:?} missing from {:?}",
                request.headers
            );
        }

        let start = omni_providers::muse::oauth::begin_result(
            200,
            r#"{"device_code":"dc-1","user_code":"WDJB-MJHT","verification_uri":"https://auth.meta.com/device","verification_uri_complete":"https://auth.meta.com/device?code=WDJB-MJHT","interval":5}"#,
        )
        .expect("begin result");
        assert_eq!(start.user_code.as_deref(), Some("WDJB-MJHT"));
        // The complete uri wins: it embeds the code, so the operator approves
        // in one click instead of retyping it.
        assert_eq!(
            start.authorize_url,
            "https://auth.meta.com/device?code=WDJB-MJHT"
        );
        assert_eq!(start.pending.device_code.as_deref(), Some("dc-1"));
        assert_eq!(start.pending.interval, Some(5.0));

        let flows = ConnectFlows::default();
        let reply = flows
            .store_flow("muse", string("muse"), None, &start, "device", false)
            .await
            .expect("reply");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("json");
        assert_eq!(value["kind"], "device");
        assert_eq!(value["userCode"], "WDJB-MJHT");
        assert_eq!(value["supportsManualPaste"], false);
        assert_eq!(value["pollIntervalMs"], 5000);
        assert_eq!(
            value["authorizeUrl"],
            "https://auth.meta.com/device?code=WDJB-MJHT"
        );
        let flow = flows
            .pending(value["flowId"].as_str().expect("id"), false)
            .await
            .expect("stored");
        assert!(device_flow(&flow));
        let pending = pending_value(&flow).expect("pending");
        assert_eq!(pending.device_code.as_deref(), Some("dc-1"));
        assert_eq!(pending.interval, Some(5.0));
    }

    #[test]
    fn muse_begin_defaults_the_interval_and_verification_url() {
        // No interval: fall back rather than polling flat out.
        let start = omni_providers::muse::oauth::begin_result(
            200,
            r#"{"device_code":"dc-1","user_code":"WDJB-MJHT"}"#,
        )
        .expect("begin result");
        assert_eq!(start.pending.interval, Some(5.0));
        assert_eq!(start.authorize_url, "https://auth.meta.com/oauth/device/");
        // The bare uri is the fallback when the complete one is absent.
        let bare = omni_providers::muse::oauth::begin_result(
            200,
            r#"{"device_code":"dc-1","user_code":"WDJB-MJHT","verification_uri":"https://auth.meta.com/device"}"#,
        )
        .expect("begin result");
        assert_eq!(bare.authorize_url, "https://auth.meta.com/device");
    }

    #[test]
    fn muse_begin_rejects_a_response_missing_the_codes() {
        let error =
            match omni_providers::muse::oauth::begin_result(200, r#"{"user_code":"WDJB-MJHT"}"#) {
                Err(error) => error,
                Ok(_) => panic!("expected an unusable response"),
            };
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "device authorization response missing user_code or verification_uri"
        );
    }

    #[tokio::test]
    async fn muse_poll_pending_keeps_flow_and_never_mints() {
        let http = KiloStub::new(vec![
            KiloReply::Response(400, r#"{"error":"authorization_pending"}"#),
            KiloReply::Response(400, r#"{"error":"authorization_pending"}"#),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), MUSE_FLOW).await;
        let error = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(error.message, PENDING_MARKER);
        assert_eq!(
            poll_reply(Err(error)).expect("reply"),
            r#"{"status":"pending"}"#
        );
        // One request, not two: minting on an unapproved token would spend a
        // poll interval on a call that cannot succeed.
        let sent = http.requests();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].url, MUSE_TOKEN_URL);
        assert_eq!(sent[0].body, MUSE_EXCHANGE_BODY);
        assert!(flows.pending("dev", false).await.is_ok());
        // A second poll runs a fresh exchange against the kept flow.
        let again = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(again.message, PENDING_MARKER);
        assert_eq!(http.requests().len(), 2);
        assert!(flows.pending("dev", false).await.is_ok());
    }

    #[tokio::test]
    async fn muse_poll_slow_down_is_also_pending() {
        let http = KiloStub::new(vec![KiloReply::Response(400, r#"{"error":"slow_down"}"#)]);
        let (_dir, host, holder, flows) = kilo_harness(http, MUSE_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(error.message, PENDING_MARKER);
        assert!(flows.pending("dev", false).await.is_ok());
    }

    #[tokio::test]
    async fn muse_poll_expired_code_is_terminal_and_consumes_the_flow() {
        let http = KiloStub::new(vec![KiloReply::Response(
            400,
            r#"{"error":"expired_token"}"#,
        )]);
        let (_dir, host, holder, flows) = kilo_harness(http, MUSE_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("expired");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "muse device code expired; start the authorization again"
        );
        assert!(poll_reply(Err(error)).is_err());
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn muse_exchange_without_a_device_code_is_a_programming_error() {
        let http = KiloStub::new(Vec::new());
        let (_dir, host, _holder, _flows) = kilo_harness(http.clone(), MUSE_FLOW).await;
        let pending = PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: String::new(),
            redirect_uri: String::new(),
            device_code: None,
            interval: None,
            extra: serde_json::Map::new(),
        };
        match device_exchange("muse", &host, &pending, &serde_json::Value::Null).await {
            Err(DeviceError::Gateway(error)) => {
                assert_eq!(error.code, ErrorCode::Internal);
                assert_eq!(
                    error.message,
                    "muse exchange requires a pending flow produced by begin()"
                );
            }
            Err(DeviceError::Pending) => panic!("expected internal error, got pending"),
            Ok(_) => panic!("expected internal error, got a completed flow"),
        }
        assert!(http.requests().is_empty());
    }

    #[tokio::test]
    async fn muse_poll_blank_access_token_never_reaches_the_mint() {
        let http = KiloStub::new(vec![KiloReply::Response(200, r#"{"access_token":""}"#)]);
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), MUSE_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("blank token");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(error.message, "token endpoint returned no access_token");
        assert_eq!(http.requests().len(), 1);
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn muse_approved_poll_buys_a_token_then_mints_the_key() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, MUSE_TOKEN),
            KiloReply::Response(200, MUSE_MINTED),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), MUSE_FLOW).await;
        let id = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect("approved");
        assert_eq!(
            poll_reply(Ok(id.clone())).expect("reply"),
            serde_json::json!({"status":"complete","id":id}).to_string()
        );
        let sent = http.requests();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].url, MUSE_TOKEN_URL);
        assert_eq!(sent[0].body, MUSE_EXCHANGE_BODY);
        // The mint is the one call the OAuth token is for, and it is sent an
        // empty object, never an empty body (the live endpoint refuses "").
        assert_eq!(sent[1].url, MUSE_MINT_URL);
        assert_eq!(sent[1].body, "{}");
        for pair in [
            ("Authorization", "Bearer oauth-tok"),
            ("Content-Type", "application/json"),
        ] {
            assert!(
                sent[1]
                    .headers
                    .contains(&(pair.0.to_owned(), pair.1.to_owned())),
                "{pair:?} missing from {:?}",
                sent[1].headers
            );
        }
        // All three secrets: the key for every request, the pair for renewing.
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider, "muse");
        assert_eq!(rows[0].secrets.access_token.as_deref(), Some("oauth-tok"));
        assert_eq!(
            rows[0].secrets.refresh_token.as_deref(),
            Some("oauth-refresh")
        );
        assert_eq!(rows[0].secrets.api_key.as_deref(), Some("meta-key"));
        assert_eq!(rows[0].account_email.as_deref(), Some("dev@example.com"));
        assert_eq!(
            rows[0].provider_data,
            serde_json::json!({
                "subscriptionTier": "Muse Pro",
                "subscriptionActive": true,
                "baseUrl": "https://api.meta.ai/v1",
            })
        );
        // The OAuth token's expiry, not the key's, which Meta states nowhere.
        let connected = &holder.load().routing.credentials[0];
        assert_eq!(connected.id, id);
        assert_eq!(connected.expires_at, Some(1_000_000.0 + 3_600_000.0));
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn muse_mint_refuses_an_account_with_no_payment_method() {
        // AUTH disables the credential, which is right: no amount of retrying
        // adds a payment method.
        let http = KiloStub::new(vec![
            KiloReply::Response(200, MUSE_TOKEN),
            KiloReply::Response(200, r#"{"require_payment":true,"api_key":"unused"}"#),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http, MUSE_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("no payment method");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "muse requires a payment method on the Meta account; add one at https://dev.meta.ai and reconnect"
        );
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn muse_mint_refuses_a_200_with_no_key() {
        // What an account that has not finished Model API onboarding gets.
        // Storing it would produce a credential the codec refuses on every
        // request.
        let http = KiloStub::new(vec![
            KiloReply::Response(200, MUSE_TOKEN),
            KiloReply::Response(200, r#"{"api_key":""}"#),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http, MUSE_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("no key");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "muse key mint returned an empty api key; finish onboarding at https://dev.meta.ai and reconnect"
        );
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn muse_mint_status_ladder_is_not_the_token_endpoints() {
        // Only 401 and 403 are Meta looking at the credential and refusing
        // it; every other 4xx but 429 is a wrong request or endpoint, and
        // must not permanently disable a healthy account.
        for (status, code, message) in [
            (
                401,
                ErrorCode::Auth,
                "muse rejected the saved login; reconnect the account or use a different one"
                    .to_owned(),
            ),
            (
                403,
                ErrorCode::Auth,
                "muse rejected the saved login; reconnect the account or use a different one"
                    .to_owned(),
            ),
            (
                429,
                ErrorCode::RateLimit,
                "muse rate limited the key mint: http_429".to_owned(),
            ),
            (
                400,
                ErrorCode::Upstream,
                "muse key mint failed: http_400".to_owned(),
            ),
            (
                404,
                ErrorCode::Upstream,
                "muse key mint failed: http_404".to_owned(),
            ),
            (
                408,
                ErrorCode::Upstream,
                "muse key mint failed: http_408".to_owned(),
            ),
            (
                422,
                ErrorCode::Upstream,
                "muse key mint failed: http_422".to_owned(),
            ),
            (
                503,
                ErrorCode::Upstream,
                "muse key mint failed: http_503".to_owned(),
            ),
        ] {
            let http = KiloStub::new(vec![
                KiloReply::Response(200, MUSE_TOKEN),
                KiloReply::Response(status, "{}"),
            ]);
            let (_dir, host, holder, flows) = kilo_harness(http, MUSE_FLOW).await;
            let error = flows
                .poll(host, holder, "dev".into())
                .await
                .expect_err("classified");
            assert_eq!(error.code, code, "{status}");
            assert_eq!(error.message, message, "{status}");
            // A terminal failure consumes the flow.
            assert!(flows.pending("dev", false).await.is_err(), "{status}");
        }
    }

    #[tokio::test]
    async fn muse_mint_unusable_response_is_upstream() {
        // A non-JSON body is a real answer — an HTML error page, an empty
        // 502 — not a repudiation of the login.
        for body in ["<html>", "null"] {
            let http = KiloStub::new(vec![
                KiloReply::Response(200, MUSE_TOKEN),
                KiloReply::Response(200, body),
            ]);
            let (_dir, host, holder, flows) = kilo_harness(http, MUSE_FLOW).await;
            let error = flows
                .poll(host, holder, "dev".into())
                .await
                .expect_err("unusable");
            assert_eq!(error.code, ErrorCode::Upstream, "{body}");
            assert_eq!(error.message, "muse key mint returned an unusable response");
        }
    }

    #[tokio::test]
    async fn muse_mint_base_url_outside_meta_ai_is_not_stored() {
        // This value decides where a decrypted key is sent, so a response
        // cannot redirect it. `.meta.ai` with the dot, so `evilmeta.ai` is
        // refused too. Absent rather than stored-and-ignored: the codec
        // falls back on absence.
        for base in [
            "https://evilmeta.ai/v1",
            "https://api.meta.ai.attacker.example/v1",
            "http://api.meta.ai/v1",
            "not a url",
        ] {
            let minted = serde_json::json!({"api_key": "meta-key", "base_url": base}).to_string();
            let http = KiloStub::new(vec![
                KiloReply::Response(200, MUSE_TOKEN),
                KiloReply::Response(200, Box::leak(minted.into_boxed_str())),
            ]);
            let (_dir, host, holder, flows) = kilo_harness(http, MUSE_FLOW).await;
            flows
                .poll(host.clone(), holder, "dev".into())
                .await
                .expect("approved");
            let rows = host.store.list_credentials(&host.key).await.expect("rows");
            assert_eq!(
                rows[0].provider_data,
                serde_json::json!({"subscriptionActive": false}),
                "{base}"
            );
        }
    }

    #[tokio::test]
    async fn muse_grant_without_refresh_or_expiry_is_stored_as_exactly_that() {
        // The live shape: `access_token` and `token_type`, nothing else. A
        // null expiry keeps the refresher asleep; a null refresh token makes
        // refresh unreachable. The key serves traffic regardless.
        let http = KiloStub::new(vec![
            KiloReply::Response(200, r#"{"access_token":"oauth-tok","token_type":"Bearer"}"#),
            KiloReply::Response(200, MUSE_MINTED),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http, MUSE_FLOW).await;
        flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect("approved");
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows[0].secrets.refresh_token.as_deref(), None);
        assert_eq!(rows[0].expires_at, None);
        assert_eq!(rows[0].secrets.api_key.as_deref(), Some("meta-key"));
        assert_eq!(holder.load().routing.credentials[0].expires_at, None);
        // The expiry sweep never touches it.
        assert_eq!(
            host.sweep(Some(&holder)).await.expect("sweep"),
            crate::refresh::SweepOutcome {
                refreshed: 0,
                touched: 0
            }
        );
    }

    #[tokio::test]
    async fn muse_exchange_runner_caps_requests_at_two() {
        let http = Scripted {
            status: 200,
            body: "{}",
        };
        let mut runner = crate::oauth_runner::ExchangeRunner::new(
            &http,
            crate::oauth_runner::ExchangeConfig {
                provider: "muse",
                step: "exchange",
                max_requests: 2,
                origins: crate::oauth_runner::Origins::Allowlist(
                    omni_providers::muse::oauth::AUTH_ORIGINS,
                ),
            },
        );
        runner
            .send(omni_providers::muse::oauth::begin_request(), 30)
            .await
            .expect("first");
        runner
            .send(omni_providers::muse::oauth::mint_request("tok"), 30)
            .await
            .expect("second");
        let error = runner
            .send(omni_providers::muse::oauth::mint_request("tok"), 30)
            .await
            .expect_err("third");
        assert_eq!(error.code, ErrorCode::Upstream);
        assert_eq!(
            error.message,
            "muse oauth exchange asked for more than 2 requests"
        );
    }

    #[tokio::test]
    async fn muse_exchange_runner_refuses_undeclared_origins() {
        let http = Scripted {
            status: 200,
            body: "{}",
        };
        let mut runner = crate::oauth_runner::ExchangeRunner::new(
            &http,
            crate::oauth_runner::ExchangeConfig {
                provider: "muse",
                step: "exchange",
                max_requests: 2,
                origins: crate::oauth_runner::Origins::Allowlist(
                    omni_providers::muse::oauth::AUTH_ORIGINS,
                ),
            },
        );
        let error = runner
            .send(
                omni_providers::oauth::AuthRequest {
                    url: "https://evil.example/muse-code/key".into(),
                    method: "POST".into(),
                    headers: Vec::new(),
                    body: "{}".into(),
                },
                30,
            )
            .await
            .expect_err("undeclared origin");
        assert_eq!(error.code, ErrorCode::Upstream);
        assert_eq!(
            error.message,
            "muse oauth exchange described a request to an origin its manifest does not declare"
        );
    }

    /// A stored muse credential plus a refresher driven by the sequence stub.
    async fn muse_refresh_harness(
        http: Arc<KiloStub>,
    ) -> (
        tempfile::TempDir,
        Arc<omni_store::Store>,
        omni_crypto::field::FieldKey,
        Arc<crate::refresh::Refresher>,
        omni_store::credentials::Credential,
    ) {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let host = Arc::new(crate::refresh::Refresher::new(
            store.clone(),
            key.clone(),
            http,
            || 1_000_000,
        ));
        let tokens = omni_store::credentials::TokenUpdate {
            access_token: Some("oauth-tok".into()),
            refresh_token: Some("refresh-1".into()),
            api_key: Some("meta-key".into()),
            id_token: None,
            expires_at: Some(2_000_000.0),
            updated_at: 0,
        };
        store
            .save_oauth(
                &key,
                &omni_store::credentials::OAuthCredential {
                    id: "m1",
                    provider: "muse",
                    label: "muse",
                    provider_data: r#"{"baseUrl":"https://api.meta.ai/v1"}"#,
                    account_email: None,
                    tokens: &tokens,
                    reconnect: false,
                },
            )
            .await
            .expect("save");
        let credential = store
            .credential(&key, "m1")
            .await
            .expect("read")
            .expect("present");
        (dir, store, key, host, credential)
    }

    #[tokio::test]
    async fn muse_refresh_renews_the_token_and_mints_a_fresh_key() {
        let http = KiloStub::new(vec![
            KiloReply::Response(
                200,
                r#"{"access_token":"tok-2","refresh_token":"refresh-2","expires_in":60}"#,
            ),
            KiloReply::Response(200, r#"{"api_key":"key-2","is_subs_active":true}"#),
        ]);
        let (_dir, store, key, host, credential) = muse_refresh_harness(http.clone()).await;
        let secrets = host.refresh(&credential).await.expect("refresh");
        assert_eq!(secrets.access_token.as_deref(), Some("tok-2"));
        assert_eq!(secrets.refresh_token.as_deref(), Some("refresh-2"));
        assert_eq!(secrets.api_key.as_deref(), Some("key-2"));
        let sent = http.requests();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].url, MUSE_TOKEN_URL);
        assert_eq!(
            sent[0].body,
            format!("grant_type=refresh_token&refresh_token=refresh-1&client_id={MUSE_CLIENT_ID}")
        );
        // The *new* token mints the new key: minting with the old one would
        // leave the credential authenticating with a stale key.
        assert_eq!(sent[1].url, MUSE_MINT_URL);
        assert!(
            sent[1]
                .headers
                .contains(&("Authorization".to_owned(), "Bearer tok-2".to_owned()))
        );
        let stored = store
            .credential(&key, "m1")
            .await
            .expect("read")
            .expect("present");
        assert_eq!(stored.expires_at, Some(1_000_000.0 + 60_000.0));
        // The mint's metadata merges over the stored provider data.
        assert_eq!(
            stored.provider_data,
            serde_json::json!({"baseUrl":"https://api.meta.ai/v1","subscriptionActive":true})
        );
    }

    #[tokio::test]
    async fn muse_refresh_keeps_the_stored_refresh_token_when_omitted() {
        // Reading the omission as null would destroy a working credential on
        // its first refresh.
        let http = KiloStub::new(vec![
            KiloReply::Response(200, r#"{"access_token":"tok-2","expires_in":60}"#),
            KiloReply::Response(200, r#"{"api_key":"key-2"}"#),
        ]);
        let (_dir, _store, _key, host, credential) = muse_refresh_harness(http).await;
        let secrets = host.refresh(&credential).await.expect("refresh");
        assert_eq!(secrets.access_token.as_deref(), Some("tok-2"));
        assert_eq!(secrets.refresh_token.as_deref(), Some("refresh-1"));
        assert_eq!(secrets.api_key.as_deref(), Some("key-2"));
    }

    #[tokio::test]
    async fn muse_refresh_classifies_token_endpoint_failures() {
        for (status, body, code) in [
            (400, r#"{"error":"invalid_grant"}"#, ErrorCode::Auth),
            (500, r#"{"error":"internal_error"}"#, ErrorCode::Upstream),
            (503, "{}", ErrorCode::Upstream),
            (429, r#"{"error":"rate_limited"}"#, ErrorCode::RateLimit),
        ] {
            let http = KiloStub::new(vec![KiloReply::Response(status, body)]);
            let (_dir, store, key, host, credential) = muse_refresh_harness(http).await;
            let error = host.refresh(&credential).await.expect_err("classified");
            assert_eq!(error.code, code, "{status} {body}");
            let stored = store
                .credential(&key, "m1")
                .await
                .expect("read")
                .expect("present");
            assert_eq!(stored.enabled, code != ErrorCode::Auth, "{status} {body}");
        }
    }

    #[tokio::test]
    async fn muse_refresh_classifies_mint_failures_without_disabling_on_outage() {
        // A 500 from the mint must not read as AUTH: that would permanently
        // disable healthy accounts during an outage. Only 401/403 disable.
        for (status, code) in [
            (401, ErrorCode::Auth),
            (403, ErrorCode::Auth),
            (429, ErrorCode::RateLimit),
            (400, ErrorCode::Upstream),
            (503, ErrorCode::Upstream),
        ] {
            let http = KiloStub::new(vec![
                KiloReply::Response(200, r#"{"access_token":"tok-2","expires_in":60}"#),
                KiloReply::Response(status, "{}"),
            ]);
            let (_dir, store, key, host, credential) = muse_refresh_harness(http).await;
            let error = host.refresh(&credential).await.expect_err("classified");
            assert_eq!(error.code, code, "{status}");
            let stored = store
                .credential(&key, "m1")
                .await
                .expect("read")
                .expect("present");
            assert_eq!(stored.enabled, code != ErrorCode::Auth, "{status}");
        }
    }

    #[tokio::test]
    async fn muse_refresh_pending_answer_is_a_failure_not_a_poll() {
        // The host cannot poll on the refresh path, so a pending answer
        // surfaces verbatim rather than looping.
        let http = KiloStub::new(vec![KiloReply::Response(
            400,
            r#"{"error":"authorization_pending"}"#,
        )]);
        let (_dir, _store, _key, host, credential) = muse_refresh_harness(http.clone()).await;
        let error = host.refresh(&credential).await.expect_err("pending");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "authorization not yet complete: authorization_pending"
        );
        assert_eq!(http.requests().len(), 1);
    }

    // --- qoder local-begin device flow ---------------------------------------
    // Mirrors control/test/oauth/qoder.test.ts against the real host wiring:
    // the zero-HTTP begin, the 404 poll, the local deadline, the finish chain
    // (userinfo cross-check, v5→v3 election, signed listing), the bounded
    // runner, and the refresh that carries the machine identity. `KiloStub`
    // is the shared sequence stub: an unexpected extra request panics.

    const QODER_NOW: f64 = 1_000_000.0;
    const QODER_CLIENT_ID: &str = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
    const QODER_POLL_URL: &str = "https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=nonce-1&verifier=qoder-verifier&challenge_method=S256";
    const QODER_FLOW: &str = r#"{"provider":"qoder","label":"qoder","pending":{"verifier":"qoder-verifier","challenge":"qoder-challenge","state":"nonce-1","redirectUri":"","deviceCode":"","interval":1,"extra":{"machineId":"synthetic-stable","deadline":1300000}}}"#;
    const QODER_EXPIRED_FLOW: &str = r#"{"provider":"qoder","label":"qoder","pending":{"verifier":"qoder-verifier","challenge":"qoder-challenge","state":"nonce-1","redirectUri":"","deviceCode":"","interval":1,"extra":{"machineId":"synthetic-stable","deadline":999999}}}"#;
    const QODER_TOKEN: &str = r#"{"token":"dummy-token","user_id":"u1","user_name":"Synthetic","refresh_token":"dummy-refresh","expires_in":3600}"#;
    const QODER_USER: &str = r#"{"id":"u1","name":"Synthetic","email":"synthetic@example.test"}"#;
    const QODER_ENDPOINTS: &str = r#"{"inferNodes":[{"url":"https://evil.test"},{"url":"https://api2.qoder.sh","type":"public"}]}"#;
    const QODER_MODELS: &str = r#"{"assistant":[{"key":"synthetic","display_name":"Synthetic","is_vl":true,"max_input_tokens":1234}]}"#;
    /// The providerData a successful first exchange writes, reused as the
    /// stored last-good state on the refresh path.
    const QODER_DATA: &str = r#"{"machineId":"synthetic-stable","uid":"u1","inferenceOrigin":"https://api2.qoder.sh","catalogStatus":"available","modelCatalog":{"version":1,"models":[{"id":"synthetic","name":"Synthetic","pricing":null,"limits":{"contextWindow":1234}}]},"inferenceModels":[{"key":"synthetic","display_name":"Synthetic","is_vl":true,"is_reasoning":false,"max_input_tokens":1234}]}"#;

    fn qoder_login() -> Vec<KiloReply> {
        vec![
            KiloReply::Response(200, QODER_TOKEN),
            KiloReply::Response(200, QODER_USER),
            KiloReply::Response(200, QODER_ENDPOINTS),
            KiloReply::Response(200, QODER_MODELS),
        ]
    }

    fn qoder_bundle(access: Option<&str>) -> omni_providers::qoder::credential::Bundle {
        omni_providers::qoder::credential::parse(access.expect("access token")).expect("bundle")
    }

    #[tokio::test]
    async fn qoder_begin_is_local_and_binds_pkce_and_identity() {
        // `begin` takes no transport at all: the browser URL is minted
        // locally, so a connect start cannot reach the network before the
        // operator acts. A reconnect keeps the stored machine identity.
        let prior = serde_json::json!({"machineId":"synthetic-stable"});
        let start = omni_providers::qoder::oauth::begin(prior.as_object(), QODER_NOW);
        let url = url::Url::parse(&start.authorize_url).expect("url");
        assert_eq!(
            format!("{}{}", url.origin().ascii_serialization(), url.path()),
            "https://qoder.com/device/selectAccounts"
        );
        let param = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        assert_eq!(
            param("challenge").as_deref(),
            Some(start.pending.challenge.as_str())
        );
        assert_eq!(param("challenge_method").as_deref(), Some("S256"));
        assert_eq!(param("client_id").as_deref(), Some(QODER_CLIENT_ID));
        assert_eq!(param("machine_id").as_deref(), Some("synthetic-stable"));
        assert!(param("machine_token").is_none());
        let nonce = param("nonce").expect("nonce");
        assert_eq!(nonce, start.pending.state);
        // UUIDv4 shape: version nibble 4, variant nibble 8..b.
        assert_eq!(nonce.len(), 36);
        assert_eq!(nonce.as_bytes()[14], b'4');
        assert!(matches!(nonce.as_bytes()[19], b'8'..=b'b'));
        assert_eq!(start.pending.interval, Some(1.0));
        assert_eq!(start.user_code, None);
        assert_eq!(
            start
                .pending
                .extra
                .get("deadline")
                .and_then(serde_json::Value::as_f64),
            Some(QODER_NOW + 300_000.0)
        );
        // A first connect mints a fresh identity instead of demanding one.
        let fresh = omni_providers::qoder::oauth::begin(None, QODER_NOW);
        let minted = fresh
            .pending
            .extra
            .get("machineId")
            .and_then(serde_json::Value::as_str)
            .expect("minted");
        assert_eq!(minted.len(), 36);
        assert!(
            url::Url::parse(&fresh.authorize_url)
                .expect("url")
                .query_pairs()
                .any(|(k, v)| k == "machine_id" && v == minted)
        );

        let flows = ConnectFlows::default();
        let reply = flows
            .store_flow("qoder", string("qoder"), None, &start, "device", false)
            .await
            .expect("reply");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("json");
        assert_eq!(value["kind"], "device");
        assert_eq!(value["userCode"], serde_json::Value::Null);
        assert_eq!(value["supportsManualPaste"], false);
        assert_eq!(value["pollIntervalMs"], 1000);
        let flow = flows
            .pending(value["flowId"].as_str().expect("id"), false)
            .await
            .expect("stored");
        // The empty device code is the marker the host keys device flows on.
        assert!(device_flow(&flow));
        let pending = pending_value(&flow).expect("pending");
        assert_eq!(pending.device_code.as_deref(), Some(""));
        assert_eq!(
            pending
                .extra
                .get("machineId")
                .and_then(serde_json::Value::as_str),
            Some("synthetic-stable")
        );
    }

    #[tokio::test]
    async fn qoder_poll_404_is_pending_and_keeps_flow() {
        let http = KiloStub::new(vec![
            KiloReply::Response(404, "{}"),
            KiloReply::Response(404, "{}"),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), QODER_FLOW).await;
        let error = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(error.message, PENDING_MARKER);
        assert_eq!(
            poll_reply(Err(error)).expect("reply"),
            r#"{"status":"pending"}"#
        );
        let sent = http.requests();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].url, QODER_POLL_URL);
        assert_eq!(sent[0].method, "GET");
        // The poll is anonymous: the verifier rides the query, not a bearer.
        assert!(
            !sent[0]
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        );
        assert!(flows.pending("dev", false).await.is_ok());
        // A second poll runs a fresh exchange against the kept flow.
        let again = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("pending");
        assert_eq!(again.message, PENDING_MARKER);
        assert_eq!(http.requests().len(), 2);
        assert!(flows.pending("dev", false).await.is_ok());
    }

    #[tokio::test]
    async fn qoder_poll_past_deadline_is_terminal_before_http() {
        // The stub panics on any request: the expiry pre-check must answer
        // without touching the transport, and the flow is consumed.
        let http = KiloStub::new(Vec::new());
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), QODER_EXPIRED_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("expired");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(error.message, "Qoder authorization expired");
        assert!(poll_reply(Err(error)).is_err());
        assert!(http.requests().is_empty());
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn qoder_approved_poll_persists_bundle_and_public_catalog() {
        let http = KiloStub::new(qoder_login());
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), QODER_FLOW).await;
        let id = flows
            .poll(host.clone(), holder.clone(), "dev".into())
            .await
            .expect("approved");
        assert_eq!(
            poll_reply(Ok(id.clone())).expect("reply"),
            serde_json::json!({"status":"complete","id":id}).to_string()
        );
        let sent = http.requests();
        assert_eq!(sent.len(), 4);
        assert_eq!(sent[0].url, QODER_POLL_URL);
        assert_eq!(sent[1].url, "https://openapi.qoder.sh/api/v1/userinfo");
        assert!(
            sent[1]
                .headers
                .contains(&("Authorization".to_owned(), "Bearer dummy-token".to_owned()))
        );
        assert_eq!(
            sent[2].url,
            "https://center.qoder.sh/algo/api/v5/service/region/endpoints"
        );
        // The signed listing goes to the elected trusted origin, never to
        // the untrusted candidate the endpoints reply listed first.
        assert_eq!(
            sent[3].url,
            "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1"
        );
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider, "qoder");
        let bundle = qoder_bundle(rows[0].secrets.access_token.as_deref());
        assert_eq!(bundle.device_token, "dummy-token");
        assert_eq!(bundle.uid, "u1");
        assert_eq!(bundle.machine_id, "synthetic-stable");
        assert_eq!(bundle.origin, "https://api2.qoder.sh");
        assert_eq!(bundle.models.len(), 1);
        assert_eq!(bundle.models[0].key, "synthetic");
        assert_eq!(bundle.models[0].max_input_tokens, Some(1234.0));
        assert!(
            sent[3]
                .headers
                .iter()
                .any(|(k, v)| k == "Authorization" && v.starts_with("Bearer COSY.")),
            "{:?}",
            sent[3].headers
        );
        assert!(
            sent[3]
                .headers
                .contains(&("Cosy-Key".to_owned(), bundle.key.clone()))
        );
        assert!(
            sent[3]
                .headers
                .contains(&("Cosy-MachineId".to_owned(), "synthetic-stable".to_owned()))
        );
        assert_eq!(
            rows[0].secrets.refresh_token.as_deref(),
            Some("dummy-refresh")
        );
        assert_eq!(rows[0].secrets.api_key.as_deref(), None);
        assert_eq!(rows[0].secrets.id_token.as_deref(), None);
        assert_eq!(
            rows[0].account_email.as_deref(),
            Some("synthetic@example.test")
        );
        assert_eq!(
            rows[0].provider_data,
            serde_json::from_str::<serde_json::Value>(QODER_DATA).expect("data")
        );
        // No secret crosses into the public providerData.
        let public = rows[0].provider_data.to_string();
        for secret in [
            "dummy-token",
            "dummy-refresh",
            &bundle.key,
            &bundle.encrypt_user_info,
        ] {
            assert!(!public.contains(secret), "{secret} leaked");
        }
        let connected = &holder.load().routing.credentials[0];
        assert_eq!(connected.id, id);
        assert_eq!(connected.expires_at, Some(QODER_NOW + 3_600_000.0));
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn qoder_uid_cross_check_refuses_mismatched_or_missing_identity() {
        for replies in [
            vec![
                KiloReply::Response(200, QODER_TOKEN),
                KiloReply::Response(200, r#"{"id":"another-user"}"#),
            ],
            vec![
                KiloReply::Response(200, QODER_TOKEN),
                KiloReply::Response(200, "{}"),
            ],
            vec![
                KiloReply::Response(200, r#"{"token":"dummy-token"}"#),
                KiloReply::Response(200, "{}"),
            ],
        ] {
            let http = KiloStub::new(replies);
            let (_dir, host, holder, flows) = kilo_harness(http.clone(), QODER_FLOW).await;
            let error = flows
                .poll(host, holder, "dev".into())
                .await
                .expect_err("identity");
            assert_eq!(error.code, ErrorCode::Upstream);
            assert_eq!(error.message, "Invalid Qoder account identity");
            assert!(http.requests().len() <= 2);
            assert!(flows.pending("dev", false).await.is_err());
        }
    }

    #[tokio::test]
    async fn qoder_malformed_token_replies_are_upstream() {
        for (body, message) in [
            ("{}", "Qoder returned no device token"),
            ("<html>", "Invalid Qoder response"),
        ] {
            let http = KiloStub::new(vec![KiloReply::Response(200, body)]);
            let (_dir, host, holder, flows) = kilo_harness(http.clone(), QODER_FLOW).await;
            let error = flows
                .poll(host, holder, "dev".into())
                .await
                .expect_err("malformed");
            assert_eq!(error.code, ErrorCode::Upstream, "{body}");
            assert_eq!(error.message, message);
            assert_eq!(http.requests().len(), 1);
            assert!(flows.pending("dev", false).await.is_err());
        }
    }

    #[tokio::test]
    async fn qoder_token_rejection_differs_from_transient_failures() {
        for (status, code) in [
            (401, ErrorCode::Auth),
            (403, ErrorCode::Auth),
            (429, ErrorCode::RateLimit),
            (500, ErrorCode::Upstream),
        ] {
            let http = KiloStub::new(vec![KiloReply::Response(status, "{}")]);
            let (_dir, host, holder, flows) = kilo_harness(http, QODER_FLOW).await;
            let error = flows
                .poll(host, holder, "dev".into())
                .await
                .expect_err("classified");
            assert_eq!(error.code, code, "{status}");
            assert_eq!(error.message, "Qoder device authorization failed");
            assert_eq!(error.upstream_status, Some(status));
            assert!(flows.pending("dev", false).await.is_err(), "{status}");
        }
    }

    #[tokio::test]
    async fn qoder_endpoint_denial_falls_back_to_anonymous_v3() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, QODER_TOKEN),
            KiloReply::Response(200, QODER_USER),
            KiloReply::Response(403, "{}"),
            KiloReply::Response(
                200,
                r#"{"inferNodes":["https://evil.test","https://api1.qoder.sh"]}"#,
            ),
            KiloReply::Response(200, QODER_MODELS),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), QODER_FLOW).await;
        flows
            .poll(host.clone(), holder, "dev".into())
            .await
            .expect("approved");
        let sent = http.requests();
        assert_eq!(sent.len(), 5);
        assert_eq!(
            sent[3].url,
            "https://center.qoder.sh/algo/api/v3/service/region/endpoints"
        );
        // The anonymous leg is signed, never bearer-authenticated.
        assert!(
            sent[3]
                .headers
                .contains(&("Appcode".to_owned(), "cosy".to_owned()))
        );
        assert!(sent[3].headers.iter().any(|(k, _)| k == "Signature"));
        assert!(
            !sent[3]
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        );
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(
            qoder_bundle(rows[0].secrets.access_token.as_deref()).origin,
            "https://api1.qoder.sh"
        );
    }

    #[tokio::test]
    async fn qoder_untrusted_origin_is_refused() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, QODER_TOKEN),
            KiloReply::Response(200, QODER_USER),
            KiloReply::Response(200, r#"{"inferNodes":[{"url":"https://evil.test"}]}"#),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http, QODER_FLOW).await;
        let error = flows
            .poll(host, holder, "dev".into())
            .await
            .expect_err("untrusted");
        assert_eq!(error.code, ErrorCode::Upstream);
        assert_eq!(
            error.message,
            "Qoder returned no trusted inference endpoint"
        );
        assert!(flows.pending("dev", false).await.is_err());
    }

    #[tokio::test]
    async fn qoder_initial_listing_outage_allows_manual_models() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, QODER_TOKEN),
            KiloReply::Response(200, QODER_USER),
            KiloReply::Response(200, QODER_ENDPOINTS),
            KiloReply::Response(503, "{}"),
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http, QODER_FLOW).await;
        flows
            .poll(host.clone(), holder, "dev".into())
            .await
            .expect("approved");
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert!(
            qoder_bundle(rows[0].secrets.access_token.as_deref())
                .models
                .is_empty()
        );
        assert_eq!(rows[0].provider_data["catalogStatus"], "unavailable");
        assert!(rows[0].provider_data.get("modelCatalog").is_none());
        assert_eq!(
            rows[0].provider_data["inferenceModels"],
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn qoder_listing_transport_failure_keeps_the_token() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, QODER_TOKEN),
            KiloReply::Response(200, QODER_USER),
            KiloReply::Response(200, QODER_ENDPOINTS),
            KiloReply::Reset,
        ]);
        let (_dir, host, holder, flows) = kilo_harness(http, QODER_FLOW).await;
        flows
            .poll(host.clone(), holder, "dev".into())
            .await
            .expect("approved");
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(
            qoder_bundle(rows[0].secrets.access_token.as_deref()).device_token,
            "dummy-token"
        );
        assert_eq!(rows[0].provider_data["catalogStatus"], "unavailable");
    }

    #[tokio::test]
    async fn qoder_exchange_runner_caps_requests_at_five() {
        let http = Scripted {
            status: 200,
            body: "{}",
        };
        let mut runner = crate::oauth_runner::ExchangeRunner::new(
            &http,
            crate::oauth_runner::ExchangeConfig {
                provider: "qoder",
                step: "exchange",
                max_requests: 5,
                origins: crate::oauth_runner::Origins::Allowlist(
                    omni_providers::qoder::oauth::AUTH_ORIGINS,
                ),
            },
        );
        let request = || omni_providers::oauth::AuthRequest {
            url: "https://openapi.qoder.sh/api/v1/userinfo".into(),
            method: "GET".into(),
            headers: Vec::new(),
            body: String::new(),
        };
        for _ in 0..5 {
            runner.send(request(), 15).await.expect("within cap");
        }
        let error = runner.send(request(), 15).await.expect_err("sixth");
        assert_eq!(error.code, ErrorCode::Upstream);
        assert_eq!(
            error.message,
            "qoder oauth exchange asked for more than 5 requests"
        );
    }

    #[tokio::test]
    async fn qoder_exchange_runner_refuses_undeclared_origins() {
        let http = Scripted {
            status: 200,
            body: "{}",
        };
        let mut runner = crate::oauth_runner::ExchangeRunner::new(
            &http,
            crate::oauth_runner::ExchangeConfig {
                provider: "qoder",
                step: "exchange",
                max_requests: 5,
                origins: crate::oauth_runner::Origins::Allowlist(
                    omni_providers::qoder::oauth::AUTH_ORIGINS,
                ),
            },
        );
        let error = runner
            .send(
                omni_providers::oauth::AuthRequest {
                    url: "https://evil.test/api/v1/userinfo".into(),
                    method: "GET".into(),
                    headers: Vec::new(),
                    body: String::new(),
                },
                15,
            )
            .await
            .expect_err("undeclared origin");
        assert_eq!(error.code, ErrorCode::Upstream);
        assert_eq!(
            error.message,
            "qoder oauth exchange described a request to an origin its manifest does not declare"
        );
    }

    /// A stored qoder credential plus a refresher driven by the sequence stub.
    async fn qoder_refresh_harness(
        http: Arc<KiloStub>,
        data: &'static str,
    ) -> (
        tempfile::TempDir,
        Arc<omni_store::Store>,
        omni_crypto::field::FieldKey,
        Arc<crate::refresh::Refresher>,
        omni_store::credentials::Credential,
    ) {
        let dir = tempfile::tempdir().expect("dir");
        let store = Arc::new(
            omni_store::Store::open(
                omni_store::StoreConfig::Sqlite {
                    path: dir.path().join("db"),
                },
                0,
            )
            .await
            .expect("store"),
        );
        let key = omni_crypto::field::derive_key("test-key");
        let host = Arc::new(crate::refresh::Refresher::new(
            store.clone(),
            key.clone(),
            http,
            || 1_000_000,
        ));
        let tokens = omni_store::credentials::TokenUpdate {
            access_token: Some("old-bundle".into()),
            refresh_token: Some("dummy-refresh".into()),
            api_key: None,
            id_token: None,
            expires_at: Some(2_000_000.0),
            updated_at: 0,
        };
        store
            .save_oauth(
                &key,
                &omni_store::credentials::OAuthCredential {
                    id: "q1",
                    provider: "qoder",
                    label: "qoder",
                    provider_data: data,
                    account_email: None,
                    tokens: &tokens,
                    reconnect: false,
                },
            )
            .await
            .expect("save");
        let credential = store
            .credential(&key, "q1")
            .await
            .expect("read")
            .expect("present");
        (dir, store, key, host, credential)
    }

    #[tokio::test]
    async fn qoder_refresh_rotates_origin_and_keeps_missing_rotation() {
        let http = KiloStub::new(vec![
            KiloReply::Response(
                200,
                r#"{"device_token":"new-dummy-token","expires_at":1700007200}"#,
            ),
            KiloReply::Response(200, QODER_USER),
            KiloReply::Response(200, r#"{"inferNodes":[{"url":"https://api3.qoder.sh"}]}"#),
            KiloReply::Response(200, QODER_MODELS),
        ]);
        let (_dir, store, key, host, credential) =
            qoder_refresh_harness(http.clone(), QODER_DATA).await;
        let secrets = host.refresh(&credential).await.expect("refresh");
        let bundle = qoder_bundle(secrets.access_token.as_deref());
        assert_eq!(bundle.origin, "https://api3.qoder.sh");
        assert_eq!(bundle.device_token, "new-dummy-token");
        // The response did not rotate the refresh token: the old one stands.
        assert_eq!(secrets.refresh_token.as_deref(), Some("dummy-refresh"));
        let sent = http.requests();
        assert_eq!(sent.len(), 4);
        assert_eq!(
            sent[0].url,
            "https://openapi.qoder.sh/api/v1/deviceToken/refresh"
        );
        assert_eq!(sent[0].method, "POST");
        // The machine identity is part of the grant itself.
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&sent[0].body).expect("body"),
            serde_json::json!({"refresh_token":"dummy-refresh","machine_id":"synthetic-stable"})
        );
        let stored = store
            .credential(&key, "q1")
            .await
            .expect("read")
            .expect("present");
        // Absolute expires_at in seconds, read as milliseconds.
        assert_eq!(stored.expires_at, Some(1_700_007_200_000.0));
        assert_eq!(
            stored.provider_data["inferenceOrigin"],
            "https://api3.qoder.sh"
        );
        assert_eq!(stored.provider_data["catalogStatus"], "available");
        assert!(stored.enabled);
    }

    #[tokio::test]
    async fn qoder_refresh_without_machine_id_is_refused_before_http() {
        let http = KiloStub::new(Vec::new());
        let (_dir, store, key, host, credential) = qoder_refresh_harness(http.clone(), "{}").await;
        let error = host.refresh(&credential).await.expect_err("no identity");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(
            error.message,
            "Qoder device identity missing; reconnect required"
        );
        assert!(http.requests().is_empty());
        let stored = store
            .credential(&key, "q1")
            .await
            .expect("read")
            .expect("present");
        assert!(!stored.enabled);
    }

    #[tokio::test]
    async fn qoder_refresh_transient_listing_keeps_last_good_catalog() {
        // A bad minute on the listing keeps the account enabled with the
        // last-good public catalog; only a repudiation disables.
        for status in [503, 408, 429] {
            let http = KiloStub::new(vec![
                KiloReply::Response(
                    200,
                    r#"{"device_token":"new-dummy-token","refresh_token":"rotated"}"#,
                ),
                KiloReply::Response(200, QODER_USER),
                KiloReply::Response(200, QODER_ENDPOINTS),
                KiloReply::Response(status, "{}"),
            ]);
            let (_dir, store, key, host, credential) =
                qoder_refresh_harness(http, QODER_DATA).await;
            let secrets = host.refresh(&credential).await.expect("refresh");
            assert_eq!(secrets.refresh_token.as_deref(), Some("rotated"));
            let bundle = qoder_bundle(secrets.access_token.as_deref());
            assert_eq!(bundle.models.len(), 1, "{status}");
            assert_eq!(bundle.models[0].key, "synthetic");
            assert_eq!(bundle.models[0].max_input_tokens, Some(1234.0));
            let stored = store
                .credential(&key, "q1")
                .await
                .expect("read")
                .expect("present");
            assert!(stored.enabled, "{status}");
            assert_eq!(stored.provider_data["catalogStatus"], "unavailable");
            let previous: serde_json::Value = serde_json::from_str(QODER_DATA).expect("data");
            assert_eq!(
                stored.provider_data["modelCatalog"], previous["modelCatalog"],
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn qoder_refresh_listing_denial_is_auth() {
        let http = KiloStub::new(vec![
            KiloReply::Response(200, r#"{"device_token":"new-dummy-token"}"#),
            KiloReply::Response(200, QODER_USER),
            KiloReply::Response(200, QODER_ENDPOINTS),
            KiloReply::Response(401, "{}"),
        ]);
        let (_dir, store, key, host, credential) = qoder_refresh_harness(http, QODER_DATA).await;
        let error = host.refresh(&credential).await.expect_err("denied");
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(error.message, "Qoder model listing failed");
        let stored = store
            .credential(&key, "q1")
            .await
            .expect("read")
            .expect("present");
        assert!(!stored.enabled);
    }

    #[tokio::test]
    async fn qoder_refresh_discovery_outage_keeps_last_good_origin() {
        for status in [503, 408] {
            let http = KiloStub::new(vec![
                KiloReply::Response(
                    200,
                    r#"{"device_token":"rotated-token","refresh_token":"rotated-refresh","expires_at":"2026-11-04T12:00:00Z"}"#,
                ),
                KiloReply::Response(200, QODER_USER),
                KiloReply::Response(status, "{}"),
                KiloReply::Response(200, QODER_MODELS),
            ]);
            let (_dir, store, key, host, credential) =
                qoder_refresh_harness(http, QODER_DATA).await;
            let secrets = host.refresh(&credential).await.expect("refresh");
            assert_eq!(
                qoder_bundle(secrets.access_token.as_deref()).origin,
                "https://api2.qoder.sh",
                "{status}"
            );
            assert_eq!(secrets.refresh_token.as_deref(), Some("rotated-refresh"));
            let stored = store
                .credential(&key, "q1")
                .await
                .expect("read")
                .expect("present");
            assert!(stored.enabled, "{status}");
            // The string date is read as an absolute expiry.
            assert_eq!(stored.expires_at, Some(1_793_793_600_000.0));
            assert_eq!(stored.provider_data["catalogStatus"], "available");
        }
    }

    #[tokio::test]
    async fn qoder_reconnect_keeps_the_original_machine_identity() {
        let http = KiloStub::new(qoder_login());
        let (_dir, host, holder, flows) = kilo_harness(http.clone(), QODER_FLOW).await;
        let tokens = omni_store::credentials::TokenUpdate {
            access_token: Some("old-bundle".into()),
            refresh_token: Some("old-refresh".into()),
            api_key: None,
            id_token: None,
            expires_at: None,
            updated_at: 0,
        };
        host.store
            .save_oauth(
                &host.key,
                &omni_store::credentials::OAuthCredential {
                    id: "q1",
                    provider: "qoder",
                    label: "reconnected",
                    provider_data: r#"{"machineId":"synthetic-original"}"#,
                    account_email: None,
                    tokens: &tokens,
                    reconnect: false,
                },
            )
            .await
            .expect("save");
        // The reconnect begin reads the stored identity, exactly as the host
        // start path does before calling `begin`.
        let prior = serde_json::json!({"machineId":"synthetic-original"});
        let start = omni_providers::qoder::oauth::begin(prior.as_object(), QODER_NOW);
        assert!(
            url::Url::parse(&start.authorize_url)
                .expect("url")
                .query_pairs()
                .any(|(k, v)| k == "machine_id" && v == "synthetic-original")
        );
        let reply = flows
            .store_flow(
                "qoder",
                string("reconnected"),
                Some("q1".into()),
                &start,
                "device",
                false,
            )
            .await
            .expect("reply");
        let value: serde_json::Value = serde_json::from_str(&reply).expect("json");
        let id = flows
            .poll(
                host.clone(),
                holder,
                value["flowId"].as_str().expect("id").to_owned(),
            )
            .await
            .expect("approved");
        assert_eq!(id, "q1");
        let rows = host.store.list_credentials(&host.key).await.expect("rows");
        assert_eq!(rows.len(), 1);
        let bundle = qoder_bundle(rows[0].secrets.access_token.as_deref());
        assert_eq!(bundle.machine_id, "synthetic-original");
        assert_eq!(bundle.device_token, "dummy-token");
    }
}
