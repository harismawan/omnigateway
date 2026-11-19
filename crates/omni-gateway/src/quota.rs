//! Quota runtime host: no database owner is held over provider I/O.
use omni_control::quota_runtime::{Host, Quota, Task};
use omni_ir::error::{ErrorCode, GatewayError};
use serde_json::Value;
use std::sync::Arc;
pub struct GatewayHost {
    pub refresh: Arc<crate::refresh::Refresher>,
    pub control: crate::admin_routes::ControlStore,
    pub holder: Option<Arc<omni_gateway_core::snapshot::SnapshotHolder>>,
}
fn internal() -> GatewayError {
    GatewayError::new(ErrorCode::Internal, "quota persistence failed").gateway_authored()
}
impl Host for GatewayHost {
    fn credentials(&self) -> Task<'_, Vec<omni_store::Credential>> {
        Box::pin(async {
            self.refresh
                .store
                .list_credentials(&self.refresh.key)
                .await
                .map_err(|_| internal())
        })
    }
    fn token<'a>(&'a self, c: &'a omni_store::Credential) -> Task<'a, Option<String>> {
        Box::pin(async move {
            if c.has_refresh_token
                && c.expires_at
                    .is_some_and(|e| e.saturating_sub(300000) <= self.now())
            {
                return Ok(self
                    .refresh
                    .refresh(c)
                    .await?
                    .access_token
                    .as_deref()
                    .map(str::to_owned));
            }
            if matches!(c.secrets.access_token, omni_store::Secret::Unreadable(_)) {
                return Err(internal());
            }
            Ok(c.secrets.access_token.as_deref().map(str::to_owned))
        })
    }
    fn send(
        &self,
        provider: String,
        request: omni_providers::quota::QuotaRequest,
    ) -> Task<'_, (u16, String)> {
        Box::pin(async move {
            let r = request.http;
            tokio::time::timeout(request.timeout, async {
                let response = self
                    .refresh
                    .http
                    .send(omni_providers::http::HttpRequest {
                        provider: provider.clone(),
                        url: r.url,
                        method: r.method,
                        headers: r.headers,
                        body: r.body,
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
            .map_err(|_| {
                GatewayError::new(ErrorCode::Upstream, format!("{provider} oauth usage threw"))
                    .gateway_authored()
            })?
            .map_err(|_| {
                GatewayError::new(ErrorCode::Upstream, format!("{provider} oauth usage threw"))
                    .gateway_authored()
            })
        })
    }
    fn save<'a>(&'a self, id: &'a str, windows: &'a [Value]) -> Task<'a, ()> {
        Box::pin(async move {
            let id = id.to_owned();
            let windows = windows.to_vec();
            let now = self.now();
            self.control
                .run({
                    let holder = self.holder.clone();
                    move |s| {
                        omni_control::quota_ops::save(s, &id, &windows, now)
                            .and_then(|()| {
                                holder
                                    .as_ref()
                                    .map_or(Ok(()), |h| h.rebuild(s).map_err(|e| e.to_string()))
                            })
                            .map_err(|message| omni_control::api::Failure {
                                code: None,
                                message,
                            })
                    }
                })
                .await
                .map_err(|_| internal())
        })
    }
    fn now(&self) -> i64 {
        (self.refresh.now)()
    }
}
pub fn start(
    quota: Arc<Quota>,
    hub: Arc<crate::stream_transport::Hub>,
    interval: f64,
) -> Option<tokio::task::JoinHandle<()>> {
    if interval <= 0.0 {
        return None;
    }
    Some(tokio::spawn(async move {
        let period = std::time::Duration::from_millis(interval.max(1.0) as u64);
        let mut ticks = tokio::time::interval(period);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            drop(quota.refresh(None).await);
            hub.invalidate("res:quota", None);
        }
    }))
}
pub fn route(method: &hyper::Method, path: &str) -> Option<(String, Option<String>)> {
    if matches!(*method, hyper::Method::GET | hyper::Method::HEAD)
        && path == "/api/credentials/quota/history"
    {
        return Some(("history".into(), None));
    }
    if method == hyper::Method::POST && path == "/api/credentials/quota/refresh" {
        return Some(("refresh".into(), None));
    }
    let rest = path.strip_prefix("/api/credentials/")?;
    if matches!(*method, hyper::Method::GET | hyper::Method::HEAD) {
        return rest
            .strip_suffix("/resets")
            .map(|id| ("list".into(), Some(id.into())));
    }
    if method == hyper::Method::POST {
        return rest
            .strip_suffix("/resets/redeem")
            .map(|id| ("redeem".into(), Some(id.into())));
    }
    None
}
pub async fn serve(
    app: &Arc<crate::server::App>,
    operation: String,
    id: Option<String>,
    req: hyper::Request<hyper::body::Incoming>,
) -> Result<hyper::Response<crate::server::Body>, crate::api::ApiError> {
    use crate::api::{ApiError, json_ok, require_admin};
    if operation == "history" {
        crate::api::require_reader(req.headers(), &app.admin).await?;
        let query = req.uri().query().unwrap_or("").to_owned();
        return Ok(json_ok(
            app.control
                .run(move |s| {
                    omni_control::quota_ops::history(s, &query, crate::clock::now_ms() as f64)
                })
                .await?,
        ));
    }
    require_admin(req.headers(), &app.admin).await?;
    let result = match operation.as_str() {
        "list" => app.quota.credits(id.as_deref().unwrap_or("")).await,
        _ => {
            let raw = crate::api::read_json(req, app.idle_timeout).await?;
            let value = omni_control::api::lossy(&raw);
            if !value.is_object() {
                return Err(ApiError::gateway(
                    ErrorCode::BadRequest,
                    "body must be a JSON object",
                ));
            }
            if operation == "refresh" {
                match value["kind"].as_str() {
                    Some("all") if value.as_object().is_some_and(|o| o.len() == 1) => {
                        app.quota.refresh(None).await
                    }
                    Some("one")
                        if value.as_object().is_some_and(|o| o.len() == 2)
                            && value["credentialId"].as_str().is_some_and(|s| {
                                !s.trim().is_empty()
                                    && s.trim().len() <= 64
                                    && s.trim().bytes().all(|b| {
                                        b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
                                    })
                            }) =>
                    {
                        app.quota.refresh(value["credentialId"].as_str()).await
                    }
                    _ => {
                        return Err(ApiError::gateway(
                            ErrorCode::BadRequest,
                            "invalid quota refresh request",
                        ));
                    }
                }
            } else {
                if value
                    .as_object()
                    .is_some_and(|o| o.keys().any(|k| k != "creditId"))
                    || value.get("creditId").is_some_and(|v| {
                        v.as_str().is_none_or(|s| {
                            s.is_empty()
                                || s.len() > 128
                                || !s
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                        })
                    })
                {
                    return Err(ApiError::gateway(
                        ErrorCode::BadRequest,
                        "invalid reset request",
                    ));
                }
                app.quota
                    .redeem(id.as_deref().unwrap_or(""), value["creditId"].as_str())
                    .await
            }
        }
    }
    .map_err(|e| ApiError::gateway(e.code, e.message))?;
    if operation == "redeem"
        || result["outcomes"].as_array().is_some_and(|a| {
            a.iter()
                .any(|o| o["kind"] == "refreshed" || o["kind"] == "coalesced")
        })
    {
        app.stream.invalidate("res:quota", None);
    }
    Ok(json_ok(result.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn quota_host_uses_registered_owner_after_restore() {
        use omni_control::quota_runtime::Host;
        let root = tempfile::tempdir().expect("fixture");
        let path = root.path().join("db");
        let store = omni_store::SqliteStore::open(&path, 0).expect("store");
        store.connection().execute_batch("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('c','openai','c','oauth',1,1)").expect("credential");
        let control = crate::admin_routes::ControlStore::new(store);
        let backend =
            omni_store::Store::open(omni_store::StoreConfig::Sqlite { path: path.clone() }, 0)
                .await
                .expect("backend");
        let host = GatewayHost {
            control,
            holder: None,
            refresh: Arc::new(crate::refresh::Refresher::new(
                Arc::new(backend),
                omni_crypto::field::derive_key("fixture"),
                Arc::new(omni_providers::http::Client::new()),
                || 1000,
            )),
        };
        let path2 = path.clone();
        tokio::task::spawn_blocking(move || {
            omni_store::lifecycle::exclusive(&path2, |owners| {
                for owner in owners.iter_mut() {
                    owner.suspend().expect("suspend");
                }
                for owner in owners.iter_mut() {
                    owner.resume().expect("resume");
                }
            })
        })
        .await
        .expect("barrier");
        host.save("c",&[serde_json::json!({"windowType":"fiveHour","used":25,"limit":100,"resetsAt":2000000,"windowMs":null})]).await.expect("new owner");
        let rows = host
            .control
            .run(|s| {
                Ok(s.connection()
                    .query_row("SELECT count(*) FROM quota_windows", [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .expect("rows"))
            })
            .await
            .expect("read");
        assert_eq!(rows, 1);
    }
}
