//! Quota runtime host: no database owner is held over provider I/O.
use omni_control::quota_runtime::{Host, Quota, Task};
use omni_ir::error::{ErrorCode, GatewayError};
use serde_json::Value;
use std::sync::Arc;
pub struct GatewayHost {
    pub completed: Option<Arc<dyn Fn() + Send + Sync>>,
    pub refresh: Arc<crate::refresh::Refresher>,
    pub control: crate::admin_routes::ControlStore,
    pub holder: Option<Arc<omni_gateway_core::snapshot::SnapshotHolder>>,
}
fn internal() -> GatewayError {
    GatewayError::new(ErrorCode::Internal, "quota persistence failed").gateway_authored()
}
impl Host for GatewayHost {
    fn completed(&self) {
        if let Some(callback) = &self.completed {
            callback();
        }
    }
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
            if let Some(pg) = self.control.postgres() {
                omni_control::quota_ops::save_postgres(pg, &id, &windows, now)
                    .await
                    .map_err(|_| internal())?;
                self.refresh
                    .routing_committed(crate::routing::RoutingChange::Quota { id });
                return Ok(());
            }
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
    fn fresh_windows<'a>(&'a self, id: &'a str, started: i64) -> Task<'a, Option<usize>> {
        Box::pin(async move {
            let Some(pg) = self.control.postgres() else {
                return Ok(None);
            };
            pg.fresh_quota_windows(id, started)
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
    lease: Option<(Arc<dyn omni_coord::Coord>, String)>,
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
            if let Some((coord, node)) = &lease
                && !coord
                    .lease_acquire("quota-poll", node, (interval as u64).saturating_mul(2))
                    .await
            {
                continue;
            }
            drop(quota.poll().await);
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
        if app.control.postgres().is_some() {
            let reader = app.control.reader().await?;
            let pg = reader.postgres().ok_or_else(ApiError::internal)?;
            return Ok(json_ok(
                omni_control::quota_ops::history_postgres(
                    pg,
                    &query,
                    crate::clock::now_ms() as f64,
                )
                .await
                .map_err(crate::admin_routes::failure)?,
            ));
        }
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
    Ok(json_ok(result.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn postgres_quota_probe_persists_and_publishes_after_the_shared_lock() {
        use omni_coord::Coord as _;
        use omni_providers::http::{
            Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
        };
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        struct Stub(AtomicUsize);
        impl HttpClient for Stub {
            fn send(
                &self,
                req: HttpRequest,
            ) -> std::pin::Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>>
            {
                Box::pin(async move {
                    assert!(req.url.ends_with("/usage"));
                    self.0.fetch_add(1, SeqCst);
                    Ok(HttpResponse { status: 200, headers: Headers::new(), body: ResponseBody::from_chunks(vec![
                        r#"{"rate_limit":{"primary_window":{"used_percent":25,"reset_at":1893456000,"limit_window_seconds":18000}}}"#.into(),
                    ]) })
                })
            }
        }

        let (Ok(pg_url), Ok(redis_url)) = (
            std::env::var("OMNI_TEST_DATABASE_URL"),
            std::env::var("OMNI_TEST_REDIS_URL"),
        ) else {
            assert_ne!(std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(), Ok("1"));
            return;
        };
        let pg = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(pg_url), 0)
            .await
            .expect("primary");
        let id = crate::clock::uuid_v4();
        let key = omni_crypto::field::derive_key("fixture");
        pg.save_oauth(
            &key,
            &omni_store::credentials::OAuthCredential {
                id: &id,
                provider: "openai",
                label: &id,
                provider_data: "{}",
                account_email: None,
                tokens: &omni_store::credentials::TokenUpdate {
                    access_token: Some("fixture".into()),
                    refresh_token: None,
                    api_key: None,
                    id_token: None,
                    expires_at: None,
                    updated_at: crate::clock::now_ms(),
                },
                reconnect: false,
            },
        )
        .await
        .expect("encrypted quota credential");
        let a = Arc::new(
            omni_coord::RedisCoord::connect(&redis_url, Default::default())
                .await
                .expect("coord A"),
        );
        let b = Arc::new(
            omni_coord::RedisCoord::connect(&redis_url, Default::default())
                .await
                .expect("coord B"),
        );
        let backend = Arc::new(omni_store::Store::Postgres(pg.clone()));
        let holder = Arc::new(
            omni_gateway_core::snapshot::SnapshotHolder::build_from(
                backend.clone(),
                key.clone(),
                0.0,
            )
            .await
            .expect("routing snapshot"),
        );
        let (route, sub, task) = crate::routing::Routing::start(
            b.clone(),
            crate::clock::uuid_v4(),
            backend.clone(),
            holder.clone(),
        );
        let stub = Arc::new(Stub(AtomicUsize::new(0)));
        let mut refresh =
            crate::refresh::Refresher::new(backend, key, stub.clone(), crate::clock::now_ms);
        refresh.routing = Some(route);
        let quota = Quota::coordinated(
            Arc::new(GatewayHost {
                completed: None,
                refresh: Arc::new(refresh),
                control: crate::admin_routes::ControlStore::from_postgres(pg.clone()),
                holder: None,
            }),
            b.clone(),
        );
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let watch = a.subscribe(
            "routing",
            Arc::new(move |_, raw| {
                if let Ok(frame) = serde_json::from_str::<Value>(raw) {
                    drop(tx.try_send(frame));
                }
            }),
        );
        let guard = a
            .lock(
                &format!("quota:probe:{id}"),
                60_000,
                std::time::Duration::ZERO,
            )
            .await
            .expect("peer lock");
        let probe = quota.refresh(Some(&id));
        tokio::pin!(probe);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut probe)
                .await
                .is_err()
        );
        assert_eq!(stub.0.load(SeqCst), 0);
        a.unlock(guard).await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), &mut probe)
            .await
            .expect("released lock")
            .expect("real host probe");
        assert_eq!(result["outcomes"][0]["kind"], "refreshed");
        assert_eq!(stub.0.load(SeqCst), 1);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let frame = rx.recv().await.expect("routing subscription");
                if frame["change"]["id"] == id {
                    assert_eq!(
                        frame["change"],
                        serde_json::json!({"type":"quota", "id":id})
                    );
                    let windows = pg.quota_for(&id).await.expect("committed quota");
                    assert_eq!(windows.len(), 1);
                    assert_eq!(windows[0].used, 25.0);
                    break;
                }
            }
        })
        .await
        .expect("identity-only committed publication");
        drop((watch, sub));
        task.abort();
        drop(task.await);
        quota.drain().await;
        a.shutdown().await;
        b.shutdown().await;
    }

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
            completed: None,
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
