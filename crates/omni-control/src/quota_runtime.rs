//! Caller-independent quota operations. Hosts own transport, refresh and storage access.
use futures_util::{StreamExt, stream};
use omni_ir::error::{ErrorCode, GatewayError};
use omni_store::{AuthType, Credential};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
pub type Task<'a, T> = Pin<Box<dyn Future<Output = Result<T, GatewayError>> + Send + 'a>>;
/// Hosts must release database owners before returning a future that awaits I/O.
/// `token` reuses the caller's OAuth refresher; `send` enforces QuotaRequest.timeout.
pub trait Host: Send + Sync + 'static {
    fn credentials(&self) -> Task<'_, Vec<Credential>>;
    fn token<'a>(&'a self, c: &'a Credential) -> Task<'a, Option<String>>;
    fn send(
        &self,
        provider: String,
        request: omni_providers::quota::QuotaRequest,
    ) -> Task<'_, (u16, String)>;
    fn save<'a>(&'a self, id: &'a str, windows: &'a [Value]) -> Task<'a, ()>;
    fn now(&self) -> i64;
}
type Flight = tokio::sync::watch::Sender<Option<Value>>;
#[derive(Default)]
struct State {
    flights: HashMap<String, Flight>,
    cooldown: HashMap<String, i64>,
    locks: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}
pub struct Quota {
    host: Arc<dyn Host>,
    state: Mutex<State>,
}
fn err(code: ErrorCode, message: &str) -> GatewayError {
    GatewayError::new(code, message).gateway_authored()
}
impl Quota {
    pub fn new(host: Arc<dyn Host>) -> Arc<Self> {
        Arc::new(Self {
            host,
            state: Mutex::default(),
        })
    }
    fn lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut s = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        s.locks.retain(|_, l| Arc::strong_count(l) > 1);
        s.locks.entry(id.into()).or_default().clone()
    }
    async fn account(&self, id: &str, resets: bool) -> Result<Credential, GatewayError> {
        let c = self
            .host
            .credentials()
            .await?
            .into_iter()
            .find(|c| c.id == id.trim())
            .ok_or_else(|| err(ErrorCode::BadRequest, "no such credential"))?;
        if resets
            && (c.auth_type != AuthType::OAuth
                || !matches!(c.provider.as_str(), "openai" | "anthropic"))
        {
            return Err(err(
                ErrorCode::BadRequest,
                "this account's provider has no quota resets",
            ));
        }
        Ok(c)
    }
    async fn wire(
        &self,
        c: &Credential,
        operation: &str,
        data: &Value,
        body: Value,
    ) -> Result<Option<Value>, GatewayError> {
        let token = self.host.token(c).await?;
        if token.is_none() && matches!(operation, "redeem" | "profile") {
            return Err(err(ErrorCode::Auth, "credential holds no access token"));
        }
        if token.is_none() && c.provider != "antigravity" {
            return Ok(None);
        }
        let Some(request) = omni_providers::quota::request(
            &c.provider,
            operation,
            token.as_deref().unwrap_or("null"),
            data,
            body,
        ) else {
            return Ok(None);
        };
        let (status, body) = self.host.send(c.provider.clone(), request).await?;
        if status == 429 && !matches!(operation, "redeem" | "profile") {
            return Err(err(
                ErrorCode::RateLimit,
                &format!("{} usage endpoint is rate limited", c.provider),
            ));
        }
        if !(200..300).contains(&status) {
            if matches!(operation, "redeem" | "profile") {
                let code = match status {
                    429 => ErrorCode::RateLimit,
                    401 | 403 => ErrorCode::Auth,
                    0..500 => ErrorCode::Conflict,
                    _ => ErrorCode::Upstream,
                };
                let label = if operation == "profile" {
                    "profile read"
                } else if c.provider == "openai" {
                    "reset credit redeem"
                } else {
                    "reset claim"
                };
                return Err(err(code, &format!("{label} refused: http_{status}")));
            }
            return Ok(None);
        }
        Ok(serde_json::from_str(&body).ok())
    }
    async fn probe(&self, c: &Credential) -> Result<usize, GatewayError> {
        let Some(v) = self.wire(c, "usage", &c.provider_data, Value::Null).await? else {
            return Ok(0);
        };
        let windows = omni_providers::quota::usage(&c.provider, &v, self.host.now() as f64);
        if !windows.is_empty() {
            self.host.save(&c.id, &windows).await?;
        }
        Ok(windows.len())
    }
    async fn attempt(self: &Arc<Self>, c: Credential) -> Value {
        let owned_id = c.id.clone();
        let id = &owned_id;
        if !c.enabled {
            return json!({"kind":"disabled","credentialId":id});
        }
        if c.auth_type != AuthType::OAuth
            || !matches!(c.provider.as_str(), "openai" | "anthropic" | "antigravity")
        {
            return json!({"kind":"unsupported","credentialId":id});
        }
        let (mut rx, owner) = {
            let mut s = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.cooldown.retain(|_, until| *until > self.host.now());
            if let Some(f) = s.flights.get(id) {
                (f.subscribe(), false)
            } else {
                if s.cooldown
                    .get(id)
                    .is_some_and(|until| *until > self.host.now())
                {
                    return json!({"kind":"cooldown","credentialId":id});
                }
                let (tx, rx) = tokio::sync::watch::channel(None);
                s.flights.insert(id.clone(), tx);
                (rx, true)
            }
        };
        if owner {
            let this = self.clone();
            tokio::spawn(async move {
                let lock = this.lock(&c.id);
                let _guard = lock.lock().await;
                let outcome = match this.probe(&c).await {
                    Ok(0) => json!({"kind":"noData","credentialId":c.id}),
                    Ok(n) => json!({"kind":"refreshed","credentialId":c.id,"windows":n}),
                    Err(e) => {
                        if e.code == ErrorCode::RateLimit {
                            this.state
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .cooldown
                                .insert(c.id.clone(), this.host.now() + 180000);
                        }
                        tracing::warn!(provider=%c.provider,credentialId=%c.id,code=e.code.as_str(),"quota probe failed");
                        json!({"kind":"failed","credentialId":c.id,"code":e.code.as_str()})
                    }
                };
                if let Some(tx) = this
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .flights
                    .remove(&c.id)
                {
                    tx.send_replace(Some(outcome));
                }
            });
        }
        loop {
            if let Some(mut out) = rx.borrow().clone() {
                if !owner && out["kind"] == "refreshed" {
                    out["kind"] = json!("coalesced");
                }
                return out;
            }
            if rx.changed().await.is_err() {
                return json!({"kind":"failed","credentialId":id,"code":"INTERNAL"});
            }
        }
    }
    pub async fn refresh(self: &Arc<Self>, id: Option<&str>) -> Result<Value, GatewayError> {
        let credentials = if let Some(id) = id {
            vec![self.account(id, false).await?]
        } else {
            self.host.credentials().await?
        };
        let outcomes = stream::iter(credentials)
            .map(|c| self.attempt(c))
            .buffered(4)
            .collect::<Vec<_>>()
            .await;
        Ok(json!({"outcomes":outcomes}))
    }
    pub async fn drain(&self) {
        let receivers = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .flights
            .values()
            .map(|s| s.subscribe())
            .collect::<Vec<_>>();
        for mut rx in receivers {
            if rx.borrow().is_none() {
                drop(rx.changed().await);
            }
        }
    }
    async fn list_for(&self, c: &Credential) -> Result<Value, GatewayError> {
        self.wire(c, "list", &c.provider_data, Value::Null)
            .await?
            .and_then(|v| omni_providers::quota::credits(&c.provider, &v))
            .ok_or_else(|| {
                err(
                    ErrorCode::Upstream,
                    "provider answered the reset list with nothing usable",
                )
            })
    }
    pub async fn credits(&self, id: &str) -> Result<Value, GatewayError> {
        let c = self.account(id, true).await?;
        let value = self.list_for(&c).await?;
        Ok(json!({"credentialId":c.id,"available":value["available"],"credits":value["credits"]}))
    }
    pub async fn redeem(&self, id: &str, credit: Option<&str>) -> Result<Value, GatewayError> {
        let c = self.account(id, true).await?;
        let lock = self.lock(&c.id);
        let _guard = lock.lock().await;
        let listed = self.list_for(&c).await?;
        let mut credits = listed["credits"].as_array().cloned().unwrap_or_default();
        credits.retain(|c| c["status"] == "available");
        credits.sort_by(|a, b| {
            a["expiresAt"]
                .as_f64()
                .unwrap_or(f64::INFINITY)
                .total_cmp(&b["expiresAt"].as_f64().unwrap_or(f64::INFINITY))
        });
        let selected = credits
            .iter()
            .find(|c| credit.is_none_or(|id| c["id"].as_str() == Some(id)))
            .ok_or_else(|| {
                err(
                    ErrorCode::Conflict,
                    if credit.is_some() {
                        "that reset credit is not available"
                    } else {
                        "no reset credit is available for this account"
                    },
                )
            })?;
        let credit = selected["id"].as_str().unwrap_or("");
        let request_id = omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate());
        let mut data = c.provider_data.clone();
        let body = if c.provider == "openai" {
            json!({"credit_id":credit,"redeem_request_id":request_id})
        } else {
            let profile = self
                .wire(&c, "profile", &data, Value::Null)
                .await?
                .unwrap_or(Value::Null);
            let org = profile["organization"]["uuid"]
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 64
                        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
                .ok_or_else(|| err(ErrorCode::Upstream, "profile names no organization"))?;
            data["organization"] = json!(org);
            let grant = credit
                .rsplit_once("-u")
                .ok_or_else(|| err(ErrorCode::Conflict, "that reset credit is not available"))?
                .0;
            json!({"program":"cedar_ember","grant_id":grant,"request_id":request_id})
        };
        let result = self
            .wire(&c, "redeem", &data, body)
            .await?
            .unwrap_or(Value::Null);
        let windows = omni_providers::quota::redeemed(&c.provider, &result).map_err(|m| {
            let (code, message) = m.split_once(": ").unwrap_or(("UPSTREAM", &m));
            err(
                ErrorCode::parse(code).unwrap_or(ErrorCode::Upstream),
                message,
            )
        })?;
        let refreshed = self.probe(&c).await.is_ok_and(|n| n > 0);
        Ok(
            json!({"credentialId":c.id,"creditId":credit,"windowsReset":windows,"quotaRefreshed":refreshed}),
        )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    struct Fake {
        credentials: Vec<Credential>,
        calls: AtomicUsize,
        writes: AtomicUsize,
        status: AtomicUsize,
        now: AtomicI64,
    }
    impl Host for Fake {
        fn credentials(&self) -> Task<'_, Vec<Credential>> {
            Box::pin(async { Ok(self.credentials.clone()) })
        }
        fn token<'a>(&'a self, _: &'a Credential) -> Task<'a, Option<String>> {
            Box::pin(async { Ok(Some("fixture".into())) })
        }
        fn send(
            &self,
            _: String,
            _: omni_providers::quota::QuotaRequest,
        ) -> Task<'_, (u16, String)> {
            Box::pin(async {
                self.calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                Ok((self.status.load(Ordering::SeqCst) as u16,r#"{"credits":[],"rate_limit":{"primary_window":{"used_percent":25,"reset_at":1893456000,"limit_window_seconds":18000}}}"#.into()))
            })
        }
        fn save<'a>(&'a self, _: &'a str, _: &'a [Value]) -> Task<'a, ()> {
            Box::pin(async {
                self.writes.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
        fn now(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
    }
    fn fixture() -> (tempfile::TempDir, Arc<Fake>, Arc<Quota>) {
        let root = tempfile::tempdir().unwrap();
        let store = omni_store::SqliteStore::open(root.path().join("db"), 0).unwrap();
        store.connection().execute_batch("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('c','openai','c','oauth',1,1),('disabled','openai','disabled','oauth',1,1),('custom','custom','custom','apiKey',1,1); UPDATE credentials SET enabled=0 WHERE id='disabled'").unwrap();
        let credentials = omni_store::credentials::list(
            store.connection(),
            &omni_crypto::field::derive_key("fixture"),
        )
        .unwrap();
        let host = Arc::new(Fake {
            credentials,
            calls: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            status: AtomicUsize::new(200),
            now: AtomicI64::new(1000),
        });
        let quota = Quota::new(host.clone());
        (root, host, quota)
    }
    #[tokio::test]
    async fn overlapping_refreshes_share_one_probe_and_preserve_order() {
        let (_root, host, quota) = fixture();
        let (one, all) = tokio::join!(quota.refresh(Some("c")), quota.refresh(None));
        assert_eq!(one.unwrap()["outcomes"][0]["kind"], "refreshed");
        let all = all.unwrap();
        assert_eq!(all["outcomes"][0]["kind"], "coalesced");
        assert_eq!(all["outcomes"][1]["kind"], "unsupported");
        assert_eq!(all["outcomes"][2]["kind"], "disabled");
        assert_eq!(host.calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.writes.load(Ordering::SeqCst), 1);
        quota.drain().await;
    }
    #[tokio::test]
    async fn quota_429_cools_only_probe_and_expires_without_credential_mutation() {
        let (_root, host, quota) = fixture();
        host.status.store(429, Ordering::SeqCst);
        assert_eq!(
            quota.refresh(Some("c")).await.unwrap()["outcomes"][0]["code"],
            "RATE_LIMIT"
        );
        assert_eq!(
            quota.refresh(Some("c")).await.unwrap()["outcomes"][0]["kind"],
            "cooldown"
        );
        assert!(host.credentials[0].enabled);
        assert_eq!(host.writes.load(Ordering::SeqCst), 0);
        host.now.store(181001, Ordering::SeqCst);
        host.status.store(200, Ordering::SeqCst);
        assert_eq!(
            quota.refresh(Some("c")).await.unwrap()["outcomes"][0]["kind"],
            "refreshed"
        );
    }
    #[tokio::test]
    async fn cancelled_waiter_does_not_abandon_probe_persistence() {
        let (_root, host, quota) = fixture();
        let operation = quota.clone();
        let waiter = tokio::spawn(async move { operation.refresh(Some("c")).await });
        while host.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        waiter.abort();
        drop(waiter.await);
        quota.drain().await;
        assert_eq!(host.writes.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn reset_list_keeps_frozen_field_order() {
        let (_root, _host, quota) = fixture();
        // No credits in this synthetic reply still returns a valid empty list.
        let value = quota.credits("c").await.expect("credits");
        assert_eq!(
            value
                .as_object()
                .expect("object")
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["credentialId", "available", "credits"]
        );
    }
}
