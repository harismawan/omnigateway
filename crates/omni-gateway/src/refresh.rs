//! OAuth refresh host: shared results, replica lock seam and versioned persistence.
use omni_crypto::field::FieldKey;
use omni_ir::error::{ErrorCode, GatewayError};
use omni_providers::http::{HttpClient, HttpRequest};
use omni_store::{Credential, CredentialSecrets, Store as Backend};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

type FutureResult<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
type Result = std::result::Result<CredentialSecrets, GatewayError>;
type Flight = tokio::sync::watch::Sender<Option<Result>>;

/// An owned guard releases the replica lock on drop.
pub trait RefreshGuard: Send {}
impl RefreshGuard for tokio::sync::OwnedMutexGuard<()> {}
/// Distributed adapters own lease TTL/renewal/expiry; the host only owns the
/// returned guard. Expiry must not release a subsequent owner's lease.
pub trait RefreshLock: Send + Sync {
    fn acquire(&self, key: String) -> FutureResult<'_, Option<Box<dyn RefreshGuard>>>;
}

/// Uses the same coordinator and `refresh:<id>` naming as other fleet state.
pub struct CoordLock(Arc<dyn omni_coord::Coord>);
impl CoordLock {
    pub fn new(coord: Arc<dyn omni_coord::Coord>) -> Self {
        Self(coord)
    }
}
struct HeldCoordLock {
    coord: Arc<dyn omni_coord::Coord>,
    token: Option<omni_coord::LockToken>,
}
impl RefreshGuard for HeldCoordLock {}
impl Drop for HeldCoordLock {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            self.coord.unlock_detached(token);
        }
    }
}
impl RefreshLock for CoordLock {
    fn acquire(&self, key: String) -> FutureResult<'_, Option<Box<dyn RefreshGuard>>> {
        Box::pin(async move {
            let token = self
                .0
                .lock(&key, 60_000, std::time::Duration::from_secs(30))
                .await
                .ok()?;
            Some(Box::new(HeldCoordLock {
                coord: self.0.clone(),
                token: Some(token),
            }) as Box<dyn RefreshGuard>)
        })
    }
}
#[derive(Default)]
pub struct MemoryLock(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);
impl RefreshLock for MemoryLock {
    fn acquire(&self, key: String) -> FutureResult<'_, Option<Box<dyn RefreshGuard>>> {
        let lock = {
            let mut entries = self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            entries.retain(|_, lock| Arc::strong_count(lock) > 1);
            entries.entry(key).or_default().clone()
        };
        Box::pin(async move {
            tokio::time::timeout(std::time::Duration::from_secs(30), lock.lock_owned())
                .await
                .ok()
                .map(|g| Box::new(g) as Box<dyn RefreshGuard>)
        })
    }
}
pub struct Refresher {
    pub(crate) routing: Option<crate::routing::Routing>,
    pub store: Arc<Backend>,
    pub key: FieldKey,
    pub http: Arc<dyn HttpClient>,
    pub lock: Arc<dyn RefreshLock>,
    pub now: fn() -> i64,
    flights: Mutex<HashMap<String, Flight>>,
}
fn storage(_: omni_store::StoreError) -> GatewayError {
    GatewayError::new(ErrorCode::Internal, "credential persistence failed")
}
impl Refresher {
    pub(crate) fn routing_committed(&self, change: crate::routing::RoutingChange) {
        if let Some(routing) = &self.routing {
            routing.committed(change);
        }
    }
    /// After stopping request/sweep producers, let already shared rotations
    /// persist. The host bounds this wait by its remaining shutdown grace.
    pub async fn drain(&self) {
        let receivers: Vec<_> = self
            .flights
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(tokio::sync::watch::Sender::subscribe)
            .collect();
        for mut rx in receivers {
            if rx.borrow().is_none() {
                drop(rx.changed().await);
            }
        }
    }
    /// The scheduler's rule: enabled OAuth inside a five-minute lead; sequential.
    pub async fn sweep(
        self: &Arc<Self>,
        holder: Option<&Arc<omni_gateway_core::snapshot::SnapshotHolder>>,
    ) -> std::result::Result<SweepOutcome, GatewayError> {
        let credentials = self
            .store
            .list_credentials(&self.key)
            .await
            .map_err(storage)?;
        let mut refreshed = 0;
        let mut touched = 0;
        for c in credentials {
            let now = (self.now)();
            #[allow(clippy::cast_precision_loss)]
            let now_number = now as f64;
            if !c.enabled
                || c.auth_type != omni_store::AuthType::OAuth
                || !c.expires_at.is_some_and(|at| at - 300_000.0 <= now_number)
            {
                continue;
            }
            if !c.has_refresh_token {
                if c.expires_at.is_some_and(|at| at <= now_number) {
                    self.store
                        .disable_credential(&c.id, now, "expiredNoRefresh")
                        .await
                        .map_err(storage)?;
                    self.routing_committed(crate::routing::RoutingChange::Credential {
                        id: c.id.clone(),
                    });
                    touched += 1;
                }
            } else {
                match self.refresh(&c).await {
                    Ok(_) => {
                        refreshed += 1;
                        touched += 1;
                    }
                    Err(error) => {
                        touched += usize::from(error.code == ErrorCode::Auth);
                        tracing::warn!(provider = %c.provider, credentialId = %c.id, code = error.code.as_str(), "scheduled token refresh failed")
                    }
                }
            }
            if let Some(holder) = holder {
                holder
                    .refresh_credential(self.store.clone(), c.id.clone())
                    .await
                    .map_err(storage)?;
            }
        }
        Ok(SweepOutcome { refreshed, touched })
    }

    pub fn start_scheduler(
        self: &Arc<Self>,
        holder: Arc<omni_gateway_core::snapshot::SnapshotHolder>,
        hub: Arc<crate::stream_transport::Hub>,
        lease: Option<(Arc<dyn omni_coord::Coord>, String)>,
    ) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            let period = std::time::Duration::from_secs(60);
            let mut next = tokio::time::Instant::now() + period;
            loop {
                tokio::time::sleep_until(next).await;
                if let Some((coord, node)) = &lease
                    && !coord.lease_acquire("refresh-sweep", node, 120_000).await
                {
                    next = next_sweep(next, tokio::time::Instant::now());
                    continue;
                }
                match this.sweep(Some(&holder)).await {
                    Ok(outcome) if outcome.touched > 0 => hub.invalidate("res:credentials", None),
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(code = error.code.as_str(), "token refresh sweep failed")
                    }
                }
                next = next_sweep(next, tokio::time::Instant::now());
            }
        })
    }
    pub fn new(
        store: Arc<Backend>,
        key: FieldKey,
        http: Arc<dyn HttpClient>,
        now: fn() -> i64,
    ) -> Self {
        Self {
            store,
            key,
            http,
            lock: Arc::new(MemoryLock::default()),
            routing: None,
            now,
            flights: Mutex::default(),
        }
    }
    pub async fn refresh(self: &Arc<Self>, credential: &Credential) -> Result {
        let mut rx = {
            let mut flights = self
                .flights
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(sender) = flights.get(&credential.id) {
                sender.subscribe()
            } else {
                let (sender, rx) = tokio::sync::watch::channel(None);
                flights.insert(credential.id.clone(), sender.clone());
                let this = self.clone();
                let credential = credential.clone();
                // Refresh must survive cancellation of any one waiting request.
                tokio::spawn(async move {
                    let result = this.serialised(&credential).await;
                    let mut flights = this
                        .flights
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    sender.send_replace(Some(result));
                    flights.remove(&credential.id);
                });
                rx
            }
        };
        loop {
            if let Some(result) = rx.borrow().clone() {
                return result;
            }
            rx.changed()
                .await
                .map_err(|_| GatewayError::new(ErrorCode::Internal, "refresh task stopped"))?;
        }
    }
    async fn serialised(&self, credential: &Credential) -> Result {
        let guard = self
            .lock
            .acquire(format!("refresh:{}", credential.id))
            .await;
        let fresh;
        let current = if guard.is_some() {
            fresh = self
                .store
                .credential(&self.key, &credential.id)
                .await
                .map_err(storage)?;
            if let Some(c) = &fresh
                && c.token_version > credential.token_version
            {
                return Ok(c.secrets.clone());
            }
            fresh.as_ref().unwrap_or(credential)
        } else {
            tracing::warn!("refresh lock unavailable; refreshing unserialised");
            credential
        };
        self.run(current).await
    }
    async fn run(&self, c: &Credential) -> Result {
        if let omni_store::Secret::Unreadable(error) = &c.secrets.refresh_token {
            return Err(GatewayError::new(ErrorCode::Internal, error.to_string()));
        }
        // TS checks the null refresh token FIRST, outside the disable-on-AUTH
        // try: a credential with nothing to refresh keeps its enabled state.
        let token = c.secrets.refresh_token.as_deref().ok_or_else(|| {
            GatewayError::new(
                ErrorCode::Auth,
                format!("credential {} has no refresh token", c.id),
            )
        })?;
        if c.provider == "kilo" {
            // Kilo issues neither a refresh token nor an expiry, so this path
            // should be unreachable; AUTH records that the credential is
            // unusable until the operator reconnects, rather than retrying.
            // Only reached WITH a refresh token: TS raises this refusal from
            // inside provider.refresh, within the disable-on-AUTH path.
            let error = omni_providers::kilo::oauth::refresh_refusal();
            self.store
                .disable_rejected_token(&c.id, (self.now)())
                .await
                .map_err(storage)?;
            self.routing_committed(crate::routing::RoutingChange::Credential { id: c.id.clone() });
            return Err(error);
        }
        // One identity per refresh: minting separately for the request and the
        // result would send one device id upstream and store another.
        let kimi_device = (c.provider == "kimi")
            .then(|| omni_providers::kimi::device::from_data(c.provider_data.as_object()));
        let result = if c.provider == "grok" {
            // Two requests: discovery, then the token POST to the endpoint it
            // published. A discovery failure is UPSTREAM, never AUTH.
            grok_refresh(self, c, token).await
        } else if c.provider == "muse" {
            // Two requests: the refresh grant, then the key mint. Muse does
            // not issue refresh tokens today, so this path is kept for the
            // day it does rather than reached by the expiry sweep.
            muse_refresh(self, token).await
        } else if c.provider == "qoder" {
            // The refresh grant, then the finish chain: userinfo, endpoint
            // election and the signed model listing, under one runner.
            qoder_refresh(self, c, token).await
        } else {
            let request = match c.provider.as_str() {
                "anthropic" => omni_providers::anthropic::oauth::refresh_request(token),
                "openai" => omni_providers::openai::oauth::refresh_request(token),
                "antigravity" => omni_providers::antigravity::oauth::refresh_request(token),
                "kimi" => omni_providers::kimi::oauth::refresh_request(
                    token,
                    kimi_device
                        .as_ref()
                        .ok_or_else(|| GatewayError::new(ErrorCode::Internal, "internal error"))?,
                ),
                _ => {
                    return Err(GatewayError::new(
                        ErrorCode::BadRequest,
                        "provider does not support OAuth refresh",
                    ));
                }
            };
            let response = tokio::time::timeout(std::time::Duration::from_secs(30), async {
                let response = self
                    .http
                    .send(HttpRequest {
                        provider: c.provider.clone(),
                        url: request.url,
                        method: request.method,
                        headers: request.headers,
                        body: request.body,
                        body_encoding: None,
                        request_id: None,
                    })
                    .await?;
                Ok::<_, omni_providers::http::HttpError>((
                    response.status,
                    response.body.text().await?,
                ))
            })
            .await
            // All built-in flows share one path: send, body and
            // per-step deadline exceptions are raised into refresh, then relabelled.
            .map_err(|_| refresh_threw(&c.provider))?
            .map_err(|_| refresh_threw(&c.provider))?;
            #[allow(clippy::cast_precision_loss)]
            let result = if c.provider == "openai" {
                omni_providers::openai::oauth::token_result(
                    response.0,
                    &response.1,
                    Some(token),
                    (self.now)() as f64,
                    &c.provider_data,
                )
            } else if c.provider == "antigravity" {
                omni_providers::antigravity::oauth::token_result(
                    response.0,
                    &response.1,
                    Some(token),
                    (self.now)() as f64,
                    &c.provider_data,
                )
            } else if c.provider == "kimi" {
                omni_providers::kimi::oauth::token_result(
                    response.0,
                    &response.1,
                    Some(token),
                    (self.now)() as f64,
                    kimi_device
                        .as_ref()
                        .ok_or_else(|| GatewayError::new(ErrorCode::Internal, "internal error"))?,
                )
            } else {
                omni_providers::anthropic::oauth::token_result(
                    response.0,
                    &response.1,
                    Some(token),
                    (self.now)() as f64,
                )
            };
            result
        };
        let mut result = match result {
            Ok(result) => result,
            Err(error) => {
                if error.code == ErrorCode::Auth {
                    self.store
                        .disable_rejected_token(&c.id, (self.now)())
                        .await
                        .map_err(storage)?;
                    self.routing_committed(crate::routing::RoutingChange::Credential {
                        id: c.id.clone(),
                    });
                }
                return Err(error);
            }
        };
        // Lossy decode: unpaired UTF-16 units become U+FFFD before encryption.
        let access = String::from_utf16_lossy(&result.access_token);
        let refresh = result.refresh_token.as_ref().map(js_text);
        let update = omni_store::credentials::TokenUpdate {
            access_token: Some(access),
            refresh_token: refresh,
            api_key: result.api_key.as_ref().map(|s| String::from_utf16_lossy(s)),
            id_token: result
                .id_token
                .as_ref()
                .map(|s| String::from_utf16_lossy(s)),
            expires_at: result.expires_at,
            updated_at: (self.now)(),
        };
        if self
            .store
            .update_tokens(&self.key, &c.id, &update, c.token_version)
            .await
            .map_err(storage)?
        {
            let email = result
                .account_email
                .as_ref()
                .map(|v| email_text(v, self.store.engine()))
                .transpose()?;
            let mut data = c
                .provider_data
                .as_object()
                .map(omni_ir::deep::clone_map)
                .unwrap_or_default();
            for (key, value) in std::mem::take(&mut result.provider_data) {
                omni_ir::deep::insert(&mut data, key, value);
            }
            let data = omni_ir::deep::Owned(serde_json::Value::Object(data));
            self.store
                .refresh_metadata_with_data(
                    &c.id,
                    email,
                    Some(omni_ir::jsjson::to_string(&data)),
                    (self.now)(),
                )
                .await
                .map_err(storage)?;
            self.routing_committed(crate::routing::RoutingChange::Credential { id: c.id.clone() });
        }
        self.store
            .credential(&self.key, &c.id)
            .await
            .map_err(storage)?
            .map(|c| c.secrets)
            .ok_or_else(|| {
                GatewayError::new(ErrorCode::Auth, format!("credential {} is gone", c.id))
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SweepOutcome {
    pub refreshed: usize,
    pub touched: usize,
}
fn refresh_threw(provider: &str) -> GatewayError {
    GatewayError::new(
        ErrorCode::Upstream,
        format!("{provider} oauth refresh threw"),
    )
}
/// grok's two-step refresh: discovery, then the token POST. The stored agent
/// id rides forward; the old refresh token is the fallback when the response
/// omits a rotated one.
async fn grok_refresh(
    host: &Refresher,
    c: &Credential,
    token: &str,
) -> std::result::Result<omni_providers::oauth::FlowResult, GatewayError> {
    let mut runner = crate::oauth_runner::ExchangeRunner::new(
        host.http.as_ref(),
        crate::oauth_runner::ExchangeConfig {
            provider: "grok",
            step: "refresh",
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
    let request = omni_providers::grok::oauth::refresh_request(token, &endpoints.token_url);
    let response = runner.send(request, 30).await?;
    #[allow(clippy::cast_precision_loss)]
    let now = (host.now)() as f64;
    let agent_id = omni_providers::grok::oauth::agent_id_from(c.provider_data.as_object());
    omni_providers::grok::oauth::token_result(response.0, &response.1, Some(token), &agent_id, now)
}
/// muse's two-step refresh: the refresh grant, then the key mint spent on the
/// NEW access token. The old refresh token is the fallback when the response
/// omits a rotated one.
async fn muse_refresh(
    host: &Refresher,
    token: &str,
) -> std::result::Result<omni_providers::oauth::FlowResult, GatewayError> {
    let mut runner = crate::oauth_runner::ExchangeRunner::new(
        host.http.as_ref(),
        crate::oauth_runner::ExchangeConfig {
            provider: "muse",
            step: "refresh",
            max_requests: 2,
            origins: crate::oauth_runner::Origins::Allowlist(
                omni_providers::muse::oauth::AUTH_ORIGINS,
            ),
        },
    );
    let response = runner
        .send(omni_providers::muse::oauth::refresh_request(token), 30)
        .await?;
    let grant = omni_providers::muse::oauth::refresh_token_result(response.0, &response.1)?;
    let access = String::from_utf16_lossy(&grant.access_token);
    let (status, text) = runner
        .send(omni_providers::muse::oauth::mint_request(&access), 30)
        .await?;
    #[allow(clippy::cast_precision_loss)]
    let now = (host.now)() as f64;
    omni_providers::muse::oauth::exchange_result(grant, status, &text, Some(token), now)
}
/// qoder's multi-step refresh: the refresh grant, then userinfo, endpoint
/// election and the signed model listing. The stored providerData seeds the
/// last-good origin and catalog when a transient failure would lose them.
async fn qoder_refresh(
    host: &Refresher,
    c: &Credential,
    token: &str,
) -> std::result::Result<omni_providers::oauth::FlowResult, GatewayError> {
    let (request, machine_id) =
        omni_providers::qoder::oauth::refresh_request(token, c.provider_data.as_object())?;
    let mut runner = crate::oauth_runner::ExchangeRunner::new(
        host.http.as_ref(),
        crate::oauth_runner::ExchangeConfig {
            provider: "qoder",
            step: "refresh",
            max_requests: 5,
            origins: crate::oauth_runner::Origins::Allowlist(
                omni_providers::qoder::oauth::AUTH_ORIGINS,
            ),
        },
    );
    let response = runner.send(request, 30).await?;
    let merged =
        omni_providers::qoder::oauth::refresh_token_result(response.0, &response.1, token)?;
    let state = omni_providers::oauth::random_state();
    let previous = c
        .provider_data
        .as_object()
        .map(omni_ir::deep::clone_map)
        .unwrap_or_default();
    // The finish chain reads the clock per step, as TS does.
    let clock = || {
        #[allow(clippy::cast_precision_loss)]
        let at = (host.now)() as f64;
        at
    };
    omni_providers::qoder::oauth::finish(
        &mut runner,
        &merged,
        &machine_id,
        &clock,
        &state,
        &previous,
    )
    .await
}
// The sweep timer keeps its phase; callbacks while `running` simply return.
fn next_sweep(previous: tokio::time::Instant, now: tokio::time::Instant) -> tokio::time::Instant {
    let period = std::time::Duration::from_secs(60);
    let mut next = previous + period;
    while next <= now {
        next += period;
    }
    next
}

pub(crate) fn email_text(
    value: &omni_ir::jsjson::JsValue,
    engine: omni_store::Engine,
) -> std::result::Result<String, GatewayError> {
    use omni_ir::jsjson::JsValue;
    match (engine, value) {
        (omni_store::Engine::Sqlite, JsValue::Object(_) | JsValue::Array(_)) => {
            Err(GatewayError::new(
                ErrorCode::Internal,
                "Binding expected string, TypedArray, boolean, number, bigint or null",
            ))
        }
        (omni_store::Engine::Sqlite, JsValue::Bool(b)) => Ok(if *b { "1" } else { "0" }.into()),
        (omni_store::Engine::Postgres, JsValue::Object(_)) => {
            Ok(omni_ir::jsjson::stringify(value).unwrap_or_default())
        }
        _ => Ok(js_text(value)),
    }
}
pub(crate) fn js_text(value: &omni_ir::jsjson::JsValue) -> String {
    use omni_ir::jsjson::JsValue;
    let mut out = String::new();
    let mut parents: Vec<std::slice::Iter<'_, JsValue>> = Vec::new();
    let mut current = Some(value);
    loop {
        if let Some(v) = current.take() {
            match v {
                JsValue::Array(values) => {
                    parents.push(values.iter());
                    current = parents.last_mut().and_then(Iterator::next);
                    if current.is_some() {
                        continue;
                    }
                }
                JsValue::String(s) => out.push_str(&String::from_utf16_lossy(s)),
                JsValue::Null if parents.is_empty() => out.push_str("null"),
                JsValue::Undefined if parents.is_empty() => out.push_str("undefined"),
                JsValue::Null | JsValue::Undefined => {}
                JsValue::Object(_) => out.push_str("[object Object]"),
                _ => out.push_str(&omni_ir::jsjson::stringify(v).unwrap_or_default()),
            }
        }
        loop {
            let Some(parent) = parents.last_mut() else {
                return out;
            };
            if let Some(next) = parent.next() {
                out.push(',');
                current = Some(next);
                break;
            }
            parents.pop();
        }
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn long_sweep_skips_elapsed_interval_callbacks() {
        let start = tokio::time::Instant::now();
        let first = start + std::time::Duration::from_secs(60);
        tokio::time::advance(std::time::Duration::from_secs(130)).await;
        assert_eq!(
            next_sweep(first, tokio::time::Instant::now()),
            start + std::time::Duration::from_secs(180)
        );
        tokio::time::advance(std::time::Duration::from_secs(50)).await;
        assert_eq!(
            tokio::time::Instant::now(),
            start + std::time::Duration::from_secs(180)
        );
    }
    #[tokio::test]
    async fn expiry_carrier_preserves_nonfinite_routing() {
        use omni_gateway_core::snapshot::SnapshotHolder;
        use omni_store::credentials::{OAuthCredential, TokenUpdate};
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("db");
        let store = Arc::new(
            Backend::open(omni_store::StoreConfig::Sqlite { path: path.clone() }, 0)
                .await
                .expect("store"),
        );
        let key = omni_crypto::field::derive_key("expiry-test");
        for (id, expiry, expected) in [
            ("nan", f64::NAN, None),
            ("positive-inf", f64::INFINITY, Some(f64::INFINITY)),
            ("negative-inf", f64::NEG_INFINITY, Some(f64::NEG_INFINITY)),
        ] {
            // NaN can arrive in a FlowResult but is not an OAuth JSON literal.
            let tokens = TokenUpdate {
                access_token: Some("fixture".into()),
                refresh_token: None,
                api_key: None,
                id_token: None,
                expires_at: Some(expiry),
                updated_at: 1,
            };
            store
                .save_oauth(
                    &key,
                    &OAuthCredential {
                        id,
                        provider: "anthropic",
                        label: id,
                        provider_data: "{}",
                        account_email: None,
                        tokens: &tokens,
                        reconnect: false,
                    },
                )
                .await
                .expect("create");
            assert!(
                store
                    .update_tokens(&key, id, &tokens, 0)
                    .await
                    .expect("rotate")
            );
            let db = omni_store::SqliteStore::open(&path, 0).expect("sqlite");
            let kind: String = db
                .connection()
                .query_row(
                    "SELECT typeof(expires_at) FROM credentials WHERE id=?",
                    [id],
                    |r| r.get(0),
                )
                .expect("raw expiry");
            assert_eq!(kind, if expected.is_none() { "null" } else { "real" });
            let holder = SnapshotHolder::build(&db, key.clone(), 1.0).expect("snapshot");
            let snapshot = holder.load();
            let credential = snapshot
                .routing
                .credentials
                .iter()
                .find(|c| c.id == id)
                .expect("routable row");
            assert_eq!(credential.expires_at, expected);
            assert_eq!(credential.token_version, 1);
        }
        // NULL and +Infinity are not due; only -Infinity disables the
        // unrefreshable credential. No transport should be needed.
        let refresher = Arc::new(Refresher::new(
            store.clone(),
            key.clone(),
            Arc::new(omni_providers::http::Client::new()),
            || 1,
        ));
        assert_eq!(
            refresher.sweep(None).await.expect("sweep"),
            SweepOutcome {
                refreshed: 0,
                touched: 1
            }
        );
        for (id, enabled) in [
            ("nan", true),
            ("positive-inf", true),
            ("negative-inf", false),
        ] {
            assert_eq!(
                store
                    .credential(&key, id)
                    .await
                    .expect("read")
                    .expect("credential")
                    .enabled,
                enabled
            );
        }
    }
    #[test]
    fn sqlite_email_binding_is_not_text_encoder_coercion() {
        use omni_ir::jsjson::parse_js;
        assert_eq!(
            email_text(
                &parse_js("false").expect("json"),
                omni_store::Engine::Sqlite
            )
            .expect("bind"),
            "0"
        );
        assert!(email_text(&parse_js("{}").expect("json"), omni_store::Engine::Sqlite).is_err());
        assert_eq!(
            email_text(&parse_js("{}").expect("json"), omni_store::Engine::Postgres).expect("bind"),
            "{}"
        );
        assert_eq!(js_text(&parse_js("{}").expect("json")), "[object Object]");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod transport_tests {
    use super::*;
    use omni_providers::http::{Client, HttpError, HttpResponse};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Transport(Option<String>);
    impl HttpClient for Transport {
        fn send(
            &self,
            mut request: HttpRequest,
        ) -> FutureResult<'_, std::result::Result<HttpResponse, HttpError>> {
            Box::pin(async move {
                let Some(url) = &self.0 else {
                    return std::future::pending().await;
                };
                request.url.clone_from(url);
                Client::new().send(request).await
            })
        }
    }

    async fn check(provider: &str, kind: &str) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("refresh.db");
        let db = omni_store::SqliteStore::open(&path, 0).unwrap();
        let key = omni_crypto::field::derive_key("refresh-transport");
        db.connection().execute("INSERT INTO credentials (id,provider,label,auth_type,access_token,refresh_token,expires_at,created_at,updated_at) VALUES ('c',?,'fixture','oauth',?,?,1,1000,1000)", rusqlite::params![provider, omni_crypto::field::encrypt(&key,"old-access"), omni_crypto::field::encrypt(&key,"old-refresh")]).unwrap();
        drop(db);
        let store = Arc::new(
            Backend::open(omni_store::StoreConfig::Sqlite { path }, 0)
                .await
                .unwrap(),
        );
        let before = store.credential(&key, "c").await.unwrap().unwrap();
        let (url, server) = if kind == "timeout" {
            (None, None)
        } else {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/token", listener.local_addr().unwrap());
            let truncated = kind == "truncated";
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                assert!(socket.read(&mut bytes).await.unwrap() > 0);
                if truncated {
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{",
                        )
                        .await
                        .unwrap();
                }
            });
            (Some(url), Some(server))
        };
        let service = Refresher::new(store, key, Arc::new(Transport(url)), || 2000);
        // Only the pending fake is time-advanced; socket/body cases use real I/O.
        if kind == "timeout" {
            tokio::time::pause();
        }
        let error = service.run(&before).await.unwrap_err();
        if kind == "timeout" {
            tokio::time::resume();
        }
        if let Some(server) = server {
            server.await.unwrap();
        }
        assert_eq!(error.code, ErrorCode::Upstream);
        assert_eq!(error.message, format!("{provider} oauth refresh threw"));
        let after = service
            .store
            .credential(&service.key, "c")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before, after);
        assert!(after.enabled);
    }
    macro_rules! case {
        ($name:ident, $provider:literal, $kind:literal) => {
            #[tokio::test]
            async fn $name() {
                check($provider, $kind).await;
            }
        };
    }
    case!(antigravity_close, "antigravity", "close");
    case!(antigravity_truncated, "antigravity", "truncated");
    case!(antigravity_timeout, "antigravity", "timeout");
    case!(anthropic_close, "anthropic", "close");
    case!(anthropic_truncated, "anthropic", "truncated");
    case!(anthropic_timeout, "anthropic", "timeout");
    case!(openai_close, "openai", "close");
    case!(openai_truncated, "openai", "truncated");
    case!(openai_timeout, "openai", "timeout");
}
