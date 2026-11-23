//! Local OAuth operator host. Provider wire details stay in omni-providers.
use omni_control::{credentials::cli_rows_for, settings_value::get};
use omni_ir::jsjson::{self, JsValue as J};
use omni_providers::{
    http::{Client, HttpRequest},
    oauth::{AuthRequest, FlowResult},
};
use std::collections::HashMap;

type Result<T> = std::result::Result<T, (u8, String)>;
fn text(v: &J) -> String {
    omni_control::cli_cell::scalar_string(v)
}
fn field<'a>(v: &'a J, k: &str) -> &'a J {
    static NULL: J = J::Null;
    get(v, k).unwrap_or(&NULL)
}
fn error(e: impl std::fmt::Display) -> (u8, String) {
    (1, e.to_string())
}
fn gateway(e: omni_ir::error::GatewayError) -> (u8, String) {
    (1, format!("{}: {}", e.code.as_str(), e.message))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn normalize(
    provider: &str,
    pending: &omni_providers::oauth::PendingFlow,
    code: &str,
) -> Result<String> {
    let (callback, label) = match provider {
        "openai" => ("http://localhost:1455/auth/callback", "OpenAI"),
        "antigravity" => ("https://antigravity.google/oauth-callback", "Antigravity"),
        "grok" => ("http://127.0.0.1:56121/callback", "Grok"),
        _ => return Ok(code.into()),
    };
    let Ok(url) = url::Url::parse(code) else {
        return Ok(code.into());
    };
    let expected = url::Url::parse(callback).map_err(error)?;
    if url.origin() != expected.origin() || url.path() != expected.path() {
        return Err((1, format!("BAD_REQUEST: invalid {label} callback URL")));
    }
    let field = |k| {
        url.query_pairs()
            .find(|(name, _)| name == k)
            .map(|(_, v)| omni_ir::js::trim(&v).to_owned())
            .unwrap_or_default()
    };
    let code = field("code");
    let state = field("state");
    if code.is_empty() || state.is_empty() {
        return Err((
            1,
            format!("BAD_REQUEST: {label} callback URL must contain code and state"),
        ));
    }
    if state != pending.state {
        return Err((1, "AUTH: authorization state mismatch".into()));
    }
    Ok(format!("{code}#{state}"))
}
pub fn connect(flags: &HashMap<String, String>, args: &[String]) -> Result<String> {
    use std::io::{IsTerminal, Read};
    let provider = args
        .first()
        .filter(|s| !s.is_empty())
        .ok_or((2, "provider is required".into()))?;
    if !matches!(
        provider.as_str(),
        "openai" | "anthropic" | "antigravity" | "kimi" | "kilo" | "grok"
    ) {
        return Err((
            2,
            "provider must be one of anthropic, openai, kimi, kilo, grok, antigravity, muse, qoder"
                .into(),
        ));
    }
    let ctx = crate::context::resolve(flags).map_err(error)?;
    let key = omni_crypto::field::derive_key(&ctx.encryption_key().map_err(error)?);
    let s = ctx.open().map_err(error)?;
    let reconnect = flags.get("credential").map(|s| omni_ir::js::trim(s));
    if let Some(id) = reconnect {
        let c =
            row(&s, id).map_err(|_| (1, "BAD_REQUEST: invalid credential for reconnect".into()))?;
        if id.is_empty()
            || text(field(&c, "provider")) != *provider
            || text(field(&c, "authType")) != "oauth"
        {
            return Err((1, "BAD_REQUEST: invalid credential for reconnect".into()));
        }
    }
    let result = if provider == "kimi" || provider == "kilo" {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(error)?;
        rt.block_on(device_connect(provider, flags.contains_key("json")))?
    } else {
        let (verifier, challenge) = omni_providers::oauth::pkce();
        let state = omni_providers::oauth::random_state();
        let start = match provider.as_str() {
            "openai" => omni_providers::openai::oauth::start(
                "http://localhost:1455/auth/callback",
                &verifier,
                &challenge,
                &state,
            ),
            "antigravity" => {
                omni_providers::antigravity::oauth::start(&verifier, &challenge, &state)
            }
            "grok" => {
                // Discovery first: the authorize URL is published by xAI's
                // OIDC metadata, validated against the x.ai https rule.
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(error)?;
                let response = rt.block_on(send_short(
                    &Client::new(),
                    provider,
                    omni_providers::grok::oauth::discovery_request(),
                    "start",
                ))?;
                let endpoints =
                    omni_providers::grok::oauth::discovery_result(response.0, &response.1)
                        .map_err(gateway)?;
                omni_providers::grok::oauth::start(
                    &endpoints.authorize_url,
                    "http://127.0.0.1:56121/callback",
                    &verifier,
                    &challenge,
                    &state,
                )
                .map_err(gateway)?
            }
            _ => omni_providers::anthropic::oauth::start(&verifier, &challenge, &state),
        };
        eprintln!(
            "\nOpen this URL to authorize {provider}:\n  {}\n",
            start.authorize_url
        );
        let code = if std::io::stdin().is_terminal() {
            String::from_utf16_lossy(
                &crate::password::secret("Paste the code or callback URL: ").map_err(error)?,
            )
        } else {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).map_err(error)?;
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let code = normalize(provider, &start.pending, omni_ir::js::trim(&code))?;
        let prior = reconnect
            .map(|id| {
                row(&s, id).map_err(|e| {
                    if e.1 == "BAD_REQUEST: no such credential" {
                        (1, "BAD_REQUEST: credential not found".into())
                    } else {
                        e
                    }
                })
            })
            .transpose()?;
        // The state check runs before discovery: a forged paste never puts a
        // request on the wire.
        let grok_code = (provider == "grok")
            .then(|| omni_providers::grok::oauth::pasted_code(&code, &start.pending))
            .transpose()
            .map_err(gateway)?;
        let request = match provider.as_str() {
            "openai" => omni_providers::openai::oauth::exchange_request(&code, &start.pending),
            "antigravity" => {
                omni_providers::antigravity::oauth::exchange_request(&code, &start.pending)
            }
            "grok" => Ok(omni_providers::grok::oauth::discovery_request()),
            _ => omni_providers::anthropic::oauth::exchange_request(&code, &start.pending),
        }
        .map_err(gateway)?;
        let data = prior
            .as_ref()
            .filter(|c| text(field(c, "provider")) == *provider)
            .and_then(|c| jsjson::stringify(field(c, "providerData")))
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Null);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(error)?;
        rt.block_on(async {
            let client = Client::new();
            let response = if provider == "grok" {
                send_short(&client, provider, request, "exchange").await?
            } else {
                send(&client, provider, request, "exchange").await?
            };
            let mut result = if provider == "grok" {
                let endpoints =
                    omni_providers::grok::oauth::discovery_result(response.0, &response.1)
                        .map_err(gateway)?;
                let request = omni_providers::grok::oauth::exchange_request(
                    grok_code.as_deref().unwrap_or_default(),
                    &start.pending,
                    &endpoints.token_url,
                );
                let response = send(&client, provider, request, "exchange").await?;
                let agent = omni_providers::grok::device::mint();
                #[allow(clippy::cast_precision_loss)]
                let at = now() as f64;
                omni_providers::grok::oauth::token_result(
                    response.0,
                    &response.1,
                    None,
                    &agent.agent_id,
                    at,
                )
                .map_err(gateway)?
            } else {
                token_result(provider, &response, None, &data)?
            };
            if provider == "antigravity" {
                use omni_providers::antigravity::oauth as ag;
                let access = String::from_utf16_lossy(&result.access_token);
                let email = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    send(&client, provider, ag::email_request(&access), "exchange"),
                )
                .await
                .map_err(|_| (1, "UPSTREAM: antigravity oauth exchange threw".into()))??;
                result.account_email = ag::email_result(email.0, &email.1);
                let loaded = send(&client, provider, ag::load_request(&access), "exchange").await?;
                let (mut project, tier) = ag::project_result(loaded.0, &loaded.1);
                if project.is_empty() {
                    let r = send(
                        &client,
                        provider,
                        ag::onboard_request(&access, &tier),
                        "exchange",
                    )
                    .await?;
                    project = ag::onboard_result(r.0, &r.1);
                }
                result.provider_data = serde_json::json!({"projectId":project,"tier":tier})
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
            }
            Ok::<_, (u8, String)>(result)
        })?
    };
    if result
        .refresh_token
        .as_ref()
        .is_some_and(|v| !matches!(v, J::String(_)))
    {
        return Err((
            1,
            format!("UPSTREAM: {provider} oauth exchange returned something the host cannot use"),
        ));
    }
    let id = reconnect.map(str::to_owned).unwrap_or_else(|| {
        omni_crypto::codex::uuid_v4_from(&omni_providers::oauth::random_state())
    });
    let empty = J::Object(Vec::new());
    if reconnect.is_none() {
        let label = flags
            .get("label")
            .map(|s| omni_ir::js::trim(s))
            .filter(|s| !s.is_empty())
            .unwrap_or(provider);
        // Create seals every secret and binds full metadata before its one INSERT.
        let access =
            omni_crypto::field::encrypt(&key, &String::from_utf16_lossy(&result.access_token));
        let refresh = result
            .refresh_token
            .as_ref()
            .map(|v| omni_crypto::field::encrypt(&key, &text(v)));
        let id_token = result
            .id_token
            .as_ref()
            .map(|v| omni_crypto::field::encrypt(&key, &String::from_utf16_lossy(v)));
        let absent = J::Null;
        let email = email_value(result.account_email.as_ref().unwrap_or(&absent))?;
        let data = jsjson::to_string(&serde_json::Value::Object(omni_ir::deep::clone_map(
            &result.provider_data,
        )));
        let at = now();
        s.connection().execute("INSERT INTO credentials(id,provider,label,auth_type,enabled,tier,weight,access_token,refresh_token,api_key,id_token,expires_at,account_email,provider_data,disabled_reason,disabled_at,created_at,updated_at) VALUES(?,?,?,'oauth',1,1,1,?,?,NULL,?,?,?,?,NULL,NULL,?,?)",rusqlite::params![id,provider,label,access,refresh,id_token,result.expires_at,email,data,at,at]).map_err(error)?;
    } else {
        // Reconnect deliberately keeps the secrets-write / metadata-write boundary.
        persist(&s, &key, &id, &empty, &result, None)?;
    }
    Ok(if flags.contains_key("json") {
        serde_json::to_string_pretty(&serde_json::json!({"id":id,"provider":provider}))
            .map_err(error)?
    } else {
        format!("connected {provider} as {id}")
    })
}
/// The device-code connect: begin, show the operator the URL and code, then
/// poll at the provider's own interval until approval or the 600s deadline.
/// The URL block goes straight to stderr even under `--json`: it is the
/// instruction the operator must act on, not progress chatter.
async fn device_connect(provider: &str, json: bool) -> Result<FlowResult> {
    let client = Client::new();
    let start = if provider == "kilo" {
        // Kilo mints no client identity and needs no PKCE pair: begin is one
        // POST with an empty body.
        use omni_providers::kilo::oauth as kilo;
        let response = send(&client, provider, kilo::begin_request(), "begin").await?;
        #[allow(clippy::cast_precision_loss)]
        let at = now() as f64;
        kilo::begin_result(response.0, &response.1, at).map_err(gateway)?
    } else {
        use omni_providers::kimi::oauth as kimi;
        let initial = kimi::start();
        let device_id = kimi::minted_device_id(&initial).map_err(gateway)?;
        let request = kimi::begin_request(&device_id).map_err(gateway)?;
        let response = send(&client, provider, request, "begin").await?;
        kimi::begin_result(response.0, &response.1, &device_id).map_err(gateway)?
    };
    eprintln!(
        "\nOpen this URL to authorize {provider}:\n  {}",
        start.authorize_url
    );
    if let Some(code) = &start.user_code {
        eprintln!("\nThen enter the code: {code}");
    }
    eprintln!();
    let interval_ms = start.pending.interval.unwrap_or(5.0) * 1000.0;
    let deadline = now() + 600_000;
    let mut announced = false;
    loop {
        let outcome = if provider == "kilo" {
            use omni_providers::kilo::oauth as kilo;
            #[allow(clippy::cast_precision_loss)]
            let at = now() as f64;
            let request = kilo::exchange_request(&start.pending, at).map_err(gateway)?;
            let response = send(&client, provider, request, "exchange").await?;
            kilo::poll_result(response.0, &response.1)
        } else {
            use omni_providers::kimi::oauth as kimi;
            let (request, device) = kimi::exchange_request(&start.pending).map_err(gateway)?;
            let response = send(&client, provider, request, "exchange").await?;
            #[allow(clippy::cast_precision_loss)]
            let at = now() as f64;
            kimi::poll_result(response.0, &response.1, &device, at)
        };
        match outcome {
            Ok(mut result) => {
                if provider == "kilo" {
                    // Best-effort organization read: a failure here must not
                    // fail a connect the operator already approved.
                    use omni_providers::kilo::oauth as kilo;
                    let access = String::from_utf16_lossy(&result.access_token);
                    if let Ok(Ok((status, text))) = tokio::time::timeout(
                        std::time::Duration::from_secs(15),
                        send(&client, provider, kilo::org_request(&access), "exchange"),
                    )
                    .await
                        && let Some(org) = kilo::org_id(status, &text)
                    {
                        omni_ir::deep::insert(
                            &mut result.provider_data,
                            "orgId".into(),
                            serde_json::Value::String(org),
                        );
                    }
                }
                return Ok(result);
            }
            Err(omni_providers::oauth::DeviceError::Gateway(e)) => return Err(gateway(e)),
            Err(omni_providers::oauth::DeviceError::Pending) => {
                if !announced {
                    if !json {
                        eprintln!("waiting for approval…");
                    }
                    announced = true;
                }
                if now() >= deadline {
                    return Err((1, "authorization timed out".into()));
                }
                // The interval is the provider's own: polling faster is what
                // makes a provider start answering `slow_down`.
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                tokio::time::sleep(std::time::Duration::from_millis(interval_ms as u64)).await;
            }
        }
    }
}
fn row(s: &omni_store::SqliteStore, id: &str) -> Result<J> {
    cli_rows_for(s, Some(id))
        .map_err(error)?
        .into_iter()
        .next()
        .ok_or_else(|| (1, "BAD_REQUEST: no such credential".into()))
}
async fn send(
    client: &Client,
    provider: &str,
    request: AuthRequest,
    operation: &str,
) -> Result<(u16, String)> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let r = client
            .send(HttpRequest {
                provider: provider.into(),
                url: request.url,
                method: request.method,
                headers: request.headers,
                body: request.body,
                body_encoding: None,
                request_id: None,
            })
            .await?;
        Ok::<_, omni_providers::http::HttpError>((r.status, r.body.text().await?))
    })
    .await
    .map_err(|_| (1, format!("UPSTREAM: {provider} oauth {operation} threw")))?
    .map_err(|_| (1, format!("UPSTREAM: {provider} oauth {operation} threw")))
}
/// The short deadline, for grok's OIDC discovery: a connect flow is waiting,
/// so a stalled discovery should fail fast rather than hold the operator.
async fn send_short(
    client: &Client,
    provider: &str,
    request: AuthRequest,
    operation: &str,
) -> Result<(u16, String)> {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let r = client
            .send(HttpRequest {
                provider: provider.into(),
                url: request.url,
                method: request.method,
                headers: request.headers,
                body: request.body,
                body_encoding: None,
                request_id: None,
            })
            .await?;
        Ok::<_, omni_providers::http::HttpError>((r.status, r.body.text().await?))
    })
    .await
    .map_err(|_| (1, format!("UPSTREAM: {provider} oauth {operation} threw")))?
    .map_err(|_| (1, format!("UPSTREAM: {provider} oauth {operation} threw")))
}
fn token_result(
    provider: &str,
    response: &(u16, String),
    fallback: Option<&str>,
    prior: &serde_json::Value,
) -> Result<FlowResult> {
    let at = now() as f64;
    match provider {
        "openai" => omni_providers::openai::oauth::token_result(
            response.0,
            &response.1,
            fallback,
            at,
            prior,
        ),
        "antigravity" => omni_providers::antigravity::oauth::token_result(
            response.0,
            &response.1,
            fallback,
            at,
            prior,
        ),
        _ => omni_providers::anthropic::oauth::token_result(response.0, &response.1, fallback, at),
    }
    .map_err(gateway)
}
fn secret(
    s: &omni_store::SqliteStore,
    key: &omni_crypto::field::FieldKey,
    id: &str,
) -> Result<Option<String>> {
    let raw: rusqlite::types::Value = s
        .connection()
        .query_row(
            "SELECT refresh_token FROM credentials WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .map_err(error)?;
    match raw {
        rusqlite::types::Value::Null => Ok(None),
        rusqlite::types::Value::Text(v) => omni_crypto::field::decrypt(key, &v)
            .map(Some)
            .map_err(error),
        _ => Err(error(
            "value.split is not a function. (In 'value.split(\":\")', 'value.split' is undefined)",
        )),
    }
}
fn persist(
    s: &omni_store::SqliteStore,
    key: &omni_crypto::field::FieldKey,
    id: &str,
    c: &J,
    result: &FlowResult,
    expected: Option<&rusqlite::types::Value>,
) -> Result<()> {
    let seal = |v: Option<String>| v.map(|v| omni_crypto::field::encrypt(key, &v));
    let access = seal(Some(String::from_utf16_lossy(&result.access_token)));
    let refresh = seal(result.refresh_token.as_ref().map(text));
    let id_token = seal(
        result
            .id_token
            .as_ref()
            .map(|s| String::from_utf16_lossy(s)),
    );
    let written = if let Some(version) = expected {
        s.connection().execute("UPDATE credentials SET access_token=?,refresh_token=?,api_key=NULL,id_token=?,expires_at=?,updated_at=?,token_version=token_version+1 WHERE id=? AND token_version=?",rusqlite::params![access,refresh,id_token,result.expires_at,now(),id,version])
    } else {
        s.connection().execute("UPDATE credentials SET access_token=?,refresh_token=?,api_key=NULL,id_token=?,expires_at=?,updated_at=?,token_version=token_version+1 WHERE id=?",rusqlite::params![access,refresh,id_token,result.expires_at,now(),id])
    }.map_err(error)?;
    if expected.is_some() && written == 0 {
        // CAS loser opens the winning row's secrets, never writes stale metadata.
        row(s, id).map_err(|_| (1, format!("AUTH: credential {id} is gone")))?;
        open_secrets(s, key, id)?;
        return Ok(());
    }
    let prior = field(c, "providerData");
    let mut data = match prior {
        J::Object(v) => v.clone(),
        J::Array(values) => values
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string().encode_utf16().collect(), v.clone()))
            .collect(),
        J::String(units) => units
            .iter()
            .enumerate()
            .map(|(i, u)| (i.to_string().encode_utf16().collect(), J::String(vec![*u])))
            .collect(),
        _ => Vec::new(),
    };
    for (k, v) in &result.provider_data {
        let k: Vec<u16> = k.encode_utf16().collect();
        let v = jsjson::parse_js(&jsjson::to_string(v)).map_err(error)?;
        if let Some((_, old)) = data.iter_mut().find(|(name, _)| *name == k) {
            *old = v;
        } else {
            data.push((k, v));
        }
    }
    let email = result
        .account_email
        .as_ref()
        .unwrap_or(field(c, "accountEmail"));
    let email = email_value(email)?;
    let sql = if expected.is_none() {
        "UPDATE credentials SET enabled=1,disabled_reason=NULL,disabled_at=NULL,account_email=?,provider_data=?,updated_at=? WHERE id=?"
    } else {
        "UPDATE credentials SET account_email=?,provider_data=?,updated_at=? WHERE id=?"
    };
    s.connection()
        .execute(
            sql,
            rusqlite::params![email, jsjson::stringify(&J::Object(data)), now(), id],
        )
        .map_err(error)?;
    Ok(())
}
fn open_secrets(
    s: &omni_store::SqliteStore,
    key: &omni_crypto::field::FieldKey,
    id: &str,
) -> Result<()> {
    for column in ["access_token", "refresh_token", "api_key", "id_token"] {
        let raw: Option<String> = s
            .connection()
            .query_row(
                &format!("SELECT {column} FROM credentials WHERE id=?"),
                [id],
                |r| r.get(0),
            )
            .map_err(error)?;
        if let Some(raw) = raw {
            omni_crypto::field::decrypt(key, &raw).map_err(error)?;
        }
    }
    Ok(())
}
fn email_value(email: &J) -> Result<Option<String>> {
    Ok(match email {
        J::Null | J::Undefined => None,
        J::Object(_) | J::Array(_) => {
            return Err(error(
                "Binding expected string, TypedArray, boolean, number, bigint or null",
            ));
        }
        v => Some(text(v)),
    })
}
pub fn refresh(flags: &HashMap<String, String>, args: &[String]) -> Result<String> {
    let id = args
        .first()
        .filter(|s| !s.is_empty())
        .ok_or((2, "credential id is required".into()))?;
    let ctx = crate::context::resolve(flags).map_err(error)?;
    let key = omni_crypto::field::derive_key(&ctx.encryption_key().map_err(error)?);
    let s = ctx.open().map_err(error)?;
    let c = row(&s, id)?;
    let provider = text(field(&c, "provider"));
    if !flags.contains_key("json") {
        eprintln!("refreshing {provider} credential {id}…");
    }
    if field(&c, "authType") != &J::String("oauth".encode_utf16().collect()) {
        return Err((
            1,
            format!("BAD_REQUEST: credential \"{id}\" is an api key and has nothing to refresh"),
        ));
    }
    // The CLI's default coordinator is process-local. Re-read under that lock,
    // then CAS the version actually supplied to the provider; no cross-process lock.
    let read = s.connection().unchecked_transaction().map_err(error)?;
    let fresh = row(&s, id)?;
    let version: rusqlite::types::Value = read
        .query_row(
            "SELECT token_version FROM credentials WHERE id=?",
            [id],
            |r| {
                use omni_control::cli_cell::Cell;
                use rusqlite::types::Value;
                Ok(match Cell::read(r.get_ref(0)?) {
                    Cell::Null => Value::Null,
                    Cell::Number(n) => Value::Real(n),
                    Cell::String(s) => Value::Text(s),
                    Cell::Bytes(b) => Value::Blob(b),
                })
            },
        )
        .map_err(error)?;
    read.commit().map_err(error)?;
    if omni_control::cli_cell::scalar_number(field(&fresh, "tokenVersion"))
        > omni_control::cli_cell::scalar_number(field(&c, "tokenVersion"))
    {
        open_secrets(&s, &key, id)?;
        return refresh_output(flags, id, &s);
    }
    let c = fresh;
    // Bind the operator-read version: JS-rounded numbers, replacement TEXT,
    // distinct BLOB bytes. Same snapshot as fresh, released before provider HTTP.
    let provider = text(field(&c, "provider"));
    if provider == "kilo" {
        // Kilo issues neither a refresh token nor an expiry: AUTH records that
        // the credential is unusable until the operator reconnects.
        let e = omni_providers::kilo::oauth::refresh_refusal();
        s.connection().execute("UPDATE credentials SET enabled=0,disabled_reason='tokenRejected',disabled_at=?,updated_at=? WHERE id=?",rusqlite::params![now(),now(),id]).map_err(error)?;
        return Err(gateway(e));
    }
    let token = secret(&s, &key, id)?
        .ok_or_else(|| (1, format!("AUTH: credential {id} has no refresh token")))?;
    let prior =
        serde_json::from_str(&jsjson::stringify(field(&c, "providerData")).unwrap_or_default())
            .unwrap_or(serde_json::Value::Null);
    // One identity per refresh: the request and the stored result must carry
    // the same device id even when providerData has none yet.
    let kimi_device =
        (provider == "kimi").then(|| omni_providers::kimi::device::from_data(prior.as_object()));
    let request = match provider.as_str() {
        "openai" => omni_providers::openai::oauth::refresh_request(&token),
        "anthropic" => omni_providers::anthropic::oauth::refresh_request(&token),
        "antigravity" => omni_providers::antigravity::oauth::refresh_request(&token),
        "grok" => omni_providers::grok::oauth::discovery_request(),
        "kimi" => omni_providers::kimi::oauth::refresh_request(
            &token,
            kimi_device
                .as_ref()
                .ok_or((1, "INTERNAL: internal error".to_string()))?,
        ),
        _ => {
            return Err((
                1,
                "BAD_REQUEST: provider does not support OAuth refresh".into(),
            ));
        }
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(error)?;
    let result = rt.block_on(async {
        let response = if provider == "grok" {
            send_short(&Client::new(), &provider, request, "refresh").await?
        } else {
            send(&Client::new(), &provider, request, "refresh").await?
        };
        let result = if provider == "grok" {
            // Two requests: discovery, then the token POST to the endpoint it
            // published. The stored agent id rides forward.
            let endpoints = omni_providers::grok::oauth::discovery_result(response.0, &response.1)
                .map_err(gateway)?;
            let request =
                omni_providers::grok::oauth::refresh_request(&token, &endpoints.token_url);
            let response = send(&Client::new(), &provider, request, "refresh").await?;
            let agent_id = omni_providers::grok::oauth::agent_id_from(prior.as_object());
            #[allow(clippy::cast_precision_loss)]
            let at = now() as f64;
            omni_providers::grok::oauth::token_result(
                response.0,
                &response.1,
                Some(&token),
                &agent_id,
                at,
            )
            .map_err(gateway)?
        } else if provider == "kimi" {
            #[allow(clippy::cast_precision_loss)]
            let at = now() as f64;
            omni_providers::kimi::oauth::token_result(
                response.0,
                &response.1,
                Some(&token),
                at,
                kimi_device
                    .as_ref()
                    .ok_or((1, "INTERNAL: internal error".to_string()))?,
            )
            .map_err(gateway)?
        } else {
            token_result(&provider, &response, Some(&token), &prior)?
        };
        // Builtin step results still pass through the host's shape guard.
        if provider == "openai" && matches!(field(&c, "providerData"), J::Null) {
            return Err((1, "UPSTREAM: openai oauth refresh threw".into()));
        }
        if provider == "antigravity"
            && !matches!(field(&c, "providerData"), J::Object(_) | J::Array(_))
        {
            return Err((
                1,
                "UPSTREAM: antigravity oauth refresh returned something the host cannot use".into(),
            ));
        }
        Ok(result)
    });
    let result = match result {
        Ok(v) => v,
        Err(e) => {
            if e.1.starts_with("AUTH:") {
                s.connection().execute("UPDATE credentials SET enabled=0,disabled_reason='tokenRejected',disabled_at=?,updated_at=? WHERE id=?",rusqlite::params![now(),now(),id]).map_err(error)?;
            }
            return Err(e);
        }
    };
    persist(&s, &key, id, &c, &result, Some(&version))?;
    refresh_output(flags, id, &s)
}
fn refresh_output(
    flags: &HashMap<String, String>,
    id: &str,
    s: &omni_store::SqliteStore,
) -> Result<String> {
    let expires = field(&row(s, id)?, "expiresAt").clone();
    Ok(if flags.contains_key("json") {
        jsjson::stringify_pretty(&J::Object(vec![
            (
                "id".encode_utf16().collect(),
                J::String(id.encode_utf16().collect()),
            ),
            ("expiresAt".encode_utf16().collect(), expires),
        ]))
        .unwrap_or_default()
    } else {
        format!(
            "{id} refreshed; expires {}",
            match expires {
                J::Number(n) => crate::output::time(&serde_json::json!(n)),
                _ => "—".into(),
            }
        )
    })
}
