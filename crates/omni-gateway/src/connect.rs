//! Browser OAuth and process-local coordinator pending state.
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
use omni_providers::oauth::{AuthorizeStart, PendingFlow};
use std::sync::Arc;

type Result<T> = std::result::Result<T, GatewayError>;
const PROVIDERS: &[(&str, &str)] = &[
    ("anthropic", ""),
    ("openai", "http://localhost:1455/auth/callback"),
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
        Self {
            coord: Arc::new(MemoryCoord::new(omni_coord::system_clock())),
            flights: std::sync::Mutex::default(),
        }
    }
}
impl ConnectFlows {
    async fn poll(
        self: &Arc<Self>,
        host: Arc<crate::refresh::Refresher>,
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
                        Ok(flow) => complete(host, flow, "").await,
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
        let result = loop {
            if let Some(result) = rx.borrow().clone() {
                break result;
            }
            rx.changed().await.map_err(|_| internal())?;
        };
        // Every waiter consumes on success or failure, as frozen pollOutcome.
        match self.pending(&id, true).await {
            Ok(_) => {}
            Err(e) if e.code == ErrorCode::BadRequest => {}
            Err(e) => return Err(e),
        }
        result
    }
    async fn finish(&self, app: &App, id: &str, code: &str) -> Result<String> {
        let flow = self.pending(id, true).await?;
        let provider = text(get(&flow, "provider")).ok_or_else(internal)?;
        let pending = pending_value(&flow)?;
        let code = normalize(&provider, &pending, code)?;
        complete(app.deps.refresher.clone(), flow, &code).await
    }
    async fn pending(&self, id: &str, take: bool) -> Result<JsValue> {
        let key = format!("oauth:pending:{id}");
        let raw = self
            .coord
            .kv_get(&key)
            .await
            .map_err(|_| internal())?
            .ok_or_else(|| bad("unknown or expired authorization"))?;
        if take {
            self.coord.kv_del(&key).await.map_err(|_| internal())?;
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
        let (verifier, challenge) = omni_providers::oauth::pkce();
        let state = omni_providers::oauth::random_state();
        let AuthorizeStart {
            authorize_url,
            pending,
        } = if *provider == "openai" {
            omni_providers::openai::oauth::start(redirect, &verifier, &challenge, &state)
        } else {
            omni_providers::anthropic::oauth::start(&verifier, &challenge, &state)
        };
        let mut fields = vec![
            ("provider", string(provider)),
            ("label", label),
            (
                "pending",
                object(vec![
                    ("verifier", string(&pending.verifier)),
                    ("challenge", string(&pending.challenge)),
                    ("state", string(&pending.state)),
                    ("redirectUri", string(&pending.redirect_uri)),
                ]),
            ),
        ];
        if let Some(id) = credential {
            fields.push(("credentialId", string(&id)));
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
            ("authorizeUrl", string(&authorize_url)),
            ("userCode", JsValue::Null),
            ("kind", string("pkce")),
            ("supportsManualPaste", JsValue::Bool(true)),
            ("pollIntervalMs", JsValue::Number(5000.0)),
        ]))
        .ok_or_else(internal)
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
        _ => app
            .connect
            .poll(
                app.deps.refresher.clone(),
                text(get(&body, "flowId")).unwrap_or_default(),
            )
            .await
            .map(|id| serde_json::json!({"status":"complete","id":id}).to_string()),
    };
    result.map(json_ok).map_err(ApiError::Gateway)
}

fn pending_value(flow: &JsValue) -> Result<PendingFlow> {
    let p = get(flow, "pending").ok_or_else(internal)?;
    Ok(PendingFlow {
        verifier: text(get(p, "verifier")).ok_or_else(internal)?,
        challenge: text(get(p, "challenge")).ok_or_else(internal)?,
        state: text(get(p, "state")).ok_or_else(internal)?,
        redirect_uri: text(get(p, "redirectUri")).ok_or_else(internal)?,
    })
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
    if url.origin() != expected.origin() || url.path() != expected.path() {
        return Err(bad("invalid OpenAI callback URL"));
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
        return Err(bad("OpenAI callback URL must contain code and state"));
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
    // Frozen step runner raises transport failures into the exchange generator.
    // Neither built-in catches them, so rethrow classifies them as UPSTREAM.
    GatewayError::new(ErrorCode::Upstream, format!("{provider} oauth exchange threw"))
}
async fn complete(
    host: Arc<crate::refresh::Refresher>,
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
    let result = if provider == "openai" {
        omni_providers::openai::oauth::token_result(response.0, &response.1, None, now, data)?
    } else {
        omni_providers::anthropic::oauth::token_result(response.0, &response.1, None, now)?
    };
    let tokens = omni_store::credentials::TokenUpdate {
        access_token: Some(String::from_utf16_lossy(&result.access_token)),
        refresh_token: result.refresh_token.as_ref().map(crate::refresh::js_text),
        api_key: None,
        id_token: result
            .id_token
            .as_ref()
            .map(|s| String::from_utf16_lossy(s)),
        expires_at: crate::refresh::persisted_expiry(result.expires_at),
        updated_at: (host.now)(),
    };
    let email = result
        .account_email
        .as_ref()
        .map(|v| crate::refresh::email_text(v, host.store.engine()))
        .transpose()?;
    let id = reconnect.clone().unwrap_or_else(|| {
        omni_crypto::codex::uuid_v4_from(&omni_providers::oauth::random_state())
    });
    let label = text(get(&flow, "label")).ok_or_else(internal)?;
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
    if reconnect.is_some() {
        tracing::info!(provider, credentialId = id, "oauth reconnect completed");
    } else {
        tracing::info!(provider, credentialId = id, "oauth connect completed");
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connect_callback_matches_generated_catalog() {
        let catalog: serde_json::Value =
            serde_json::from_str(omni_control::catalog::DATA).expect("catalog");
        assert_eq!(
            catalog["openai"]["callback"]["uri"].as_str(),
            Some(PROVIDERS[1].1)
        );
        assert!(catalog["anthropic"].get("callback").is_none());
    }
    #[test]
    fn connect_callback_parser() {
        let p = PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: "state".into(),
            redirect_uri: PROVIDERS[1].1.into(),
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
        let host = Arc::new(crate::refresh::Refresher::new(
            Arc::new(store),
            omni_crypto::field::derive_key("test-key"),
            http.clone(),
            crate::clock::now_ms,
        ));
        let flows = Arc::new(ConnectFlows::default());
        flows.coord.kv_set("oauth:pending:test",r#"{"provider":"openai","label":"test","pending":{"verifier":"v","challenge":"c","state":"s","redirectUri":"http://localhost:1455/auth/callback"}}"#,600_000).await.expect("put");
        let (a, b) = tokio::join!(
            flows.poll(host.clone(), "test".into()),
            flows.poll(host, "test".into())
        );
        assert_eq!(
            a.expect_err("refused").message,
            b.expect_err("refused").message
        );
        assert_eq!(http.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(flows.pending("test", false).await.is_err());
    }
}
