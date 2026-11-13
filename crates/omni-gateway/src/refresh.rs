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
pub trait RefreshLock: Send + Sync {
    fn acquire(&self, key: String) -> FutureResult<'_, Option<Box<dyn RefreshGuard>>>;
}
#[derive(Default)]
pub struct MemoryLock(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);
impl RefreshLock for MemoryLock {
    fn acquire(&self, key: String) -> FutureResult<'_, Option<Box<dyn RefreshGuard>>> {
        let lock = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(key)
            .or_default()
            .clone();
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
        holder: Option<&omni_gateway_core::snapshot::SnapshotHolder>,
    ) -> std::result::Result<usize, GatewayError> {
        let credentials = self
            .store
            .list_credentials(&self.key)
            .await
            .map_err(storage)?;
        let mut refreshed = 0;
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
                }
            } else {
                match self.refresh(&c).await {
                    Ok(_) => refreshed += 1,
                    Err(error) => {
                        tracing::warn!(code = error.code.as_str(), "scheduled token refresh failed")
                    }
                }
            }
            if let Some(holder) = holder
                && let Some(row) = self
                    .store
                    .credential(&self.key, &c.id)
                    .await
                    .map_err(storage)?
            {
                holder.patch_credential(row);
            }
        }
        Ok(refreshed)
    }

    pub fn start_scheduler(
        self: &Arc<Self>,
        holder: Arc<omni_gateway_core::snapshot::SnapshotHolder>,
    ) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            let period = std::time::Duration::from_secs(60);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                if let Err(error) = this.sweep(Some(&holder)).await {
                    tracing::warn!(code = error.code.as_str(), "token refresh sweep failed");
                }
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
        if c.provider != "anthropic" {
            return Err(GatewayError::new(
                ErrorCode::BadRequest,
                "provider does not support OAuth refresh",
            ));
        }
        let request = omni_providers::anthropic::oauth::refresh_request(token);
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
        .map_err(|_| GatewayError::new(ErrorCode::Timeout, "token request timed out"))?
        .map_err(|_| GatewayError::new(ErrorCode::Network, "token request failed"))?;
        #[allow(clippy::cast_precision_loss)]
        let result = omni_providers::anthropic::oauth::token_result(
            response.0,
            &response.1,
            Some(token),
            (self.now)() as f64,
        );
        let result = match result {
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
            id_token: None,
            expires_at: result.expires_at.map(|n| n as i64),
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
            self.store
                .refresh_metadata(&c.id, email, (self.now)())
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
fn email_text(
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
fn js_text(value: &omni_ir::jsjson::JsValue) -> String {
    match value {
        omni_ir::jsjson::JsValue::String(s) => String::from_utf16_lossy(s),
        omni_ir::jsjson::JsValue::Null => "null".into(),
        omni_ir::jsjson::JsValue::Undefined => "undefined".into(),
        omni_ir::jsjson::JsValue::Object(_) => "[object Object]".into(),
        omni_ir::jsjson::JsValue::Array(values) => values
            .iter()
            .map(|v| match v {
                omni_ir::jsjson::JsValue::Null | omni_ir::jsjson::JsValue::Undefined => {
                    String::new()
                }
                v => js_text(v),
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => omni_ir::jsjson::stringify(value).unwrap_or_default(),
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
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
