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

/// An owned guard releases the replica lock on drop. Redis adapter is a later integration.
pub trait RefreshGuard: Send {}
impl RefreshGuard for tokio::sync::OwnedMutexGuard<()> {}
/// Distributed adapters own lease TTL/renewal/expiry; the host only owns the
/// returned guard. Expiry must not release a subsequent owner's lease.
pub trait RefreshLock: Send + Sync {
    fn acquire(&self, key: String) -> FutureResult<'_, Option<Box<dyn RefreshGuard>>>;
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
    /// Frozen scheduler: enabled OAuth inside a five-minute lead; sequential.
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
            if !c.enabled
                || c.auth_type != omni_store::AuthType::OAuth
                || !c
                    .expires_at
                    .is_some_and(|at| at.saturating_sub(300_000) <= now)
            {
                continue;
            }
            if !c.has_refresh_token {
                if c.expires_at.is_some_and(|at| at <= now) {
                    self.store
                        .disable_credential(&c.id, now, "expiredNoRefresh")
                        .await
                        .map_err(storage)?;
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
    ) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            let period = std::time::Duration::from_secs(60);
            let mut next = tokio::time::Instant::now() + period;
            loop {
                tokio::time::sleep_until(next).await;
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
        let token = c.secrets.refresh_token.as_deref().ok_or_else(|| {
            GatewayError::new(
                ErrorCode::Auth,
                format!("credential {} has no refresh token", c.id),
            )
        })?;
        let request = match c.provider.as_str() {
            "anthropic" => omni_providers::anthropic::oauth::refresh_request(token),
            "openai" => omni_providers::openai::oauth::refresh_request(token),
            "antigravity" => omni_providers::antigravity::oauth::refresh_request(token),
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
            Ok::<_, omni_providers::http::HttpError>((response.status, response.body.text().await?))
        })
        .await
        // All built-in flows run through frozen pluginFlow: send, body and
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
        } else {
            omni_providers::anthropic::oauth::token_result(
                response.0,
                &response.1,
                Some(token),
                (self.now)() as f64,
            )
        };
        let mut result = match result {
            Ok(result) => result,
            Err(error) => {
                if error.code == ErrorCode::Auth {
                    self.store
                        .disable_rejected_token(&c.id, (self.now)())
                        .await
                        .map_err(storage)?;
                }
                return Err(error);
            }
        };
        // TextEncoder, which TS encryption uses, replaces unpaired UTF-16 units.
        let access = String::from_utf16_lossy(&result.access_token);
        let refresh = result.refresh_token.as_ref().map(js_text);
        #[allow(clippy::cast_possible_truncation)]
        let update = omni_store::credentials::TokenUpdate {
            access_token: Some(access),
            refresh_token: refresh,
            api_key: None,
            id_token: result
                .id_token
                .as_ref()
                .map(|s| String::from_utf16_lossy(s)),
            expires_at: persisted_expiry(result.expires_at),
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
// X2: the shared integer carrier truncates fractions and saturates infinities.
// TS setInterval keeps its phase; callbacks while `running` simply return.
fn next_sweep(previous: tokio::time::Instant, now: tokio::time::Instant) -> tokio::time::Instant {
    let period = std::time::Duration::from_secs(60);
    let mut next = previous + period;
    while next <= now {
        next += period;
    }
    next
}

// X2: the shared integer carrier truncates fractions and saturates infinities.
// SQLite binds NaN as NULL; preserving that avoids repeated preemptive refresh.
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn persisted_expiry(expiry: Option<f64>) -> Option<i64> {
    expiry.filter(|n| !n.is_nan()).map(|n| n as i64)
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
    #[test]
    fn expiry_carrier_preserves_nonfinite_routing() {
        assert_eq!(persisted_expiry(Some(f64::NAN)), None);
        assert_eq!(persisted_expiry(Some(f64::INFINITY)), Some(i64::MAX));
        assert_eq!(persisted_expiry(Some(f64::NEG_INFINITY)), Some(i64::MIN));
        assert_eq!(persisted_expiry(Some(1.5)), Some(1));
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
