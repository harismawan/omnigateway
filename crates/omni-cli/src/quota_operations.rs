use crate::observability::{Error, Flags, emit, fail, table, text};
use serde_json::{Value, json};
use std::io::{IsTerminal, Write};
struct CliHost {
    flags: Flags,
}
impl omni_control::quota_runtime::Host for CliHost {
    fn credentials(&self) -> omni_control::quota_runtime::Task<'_, Vec<omni_store::Credential>> {
        Box::pin(async {
            let ctx = crate::context::resolve(&self.flags).map_err(|_| qerror())?;
            let key = omni_crypto::field::derive_key(&ctx.encryption_key().map_err(|_| qerror())?);
            let store = ctx.open().map_err(|_| qerror())?;
            omni_store::credentials::list(store.connection(), &key).map_err(|_| qerror())
        })
    }
    fn token<'a>(
        &'a self,
        c: &'a omni_store::Credential,
    ) -> omni_control::quota_runtime::Task<'a, Option<String>> {
        Box::pin(async move {
            let flags = self.flags.clone();
            let id = c.id.clone();
            tokio::task::spawn_blocking(move || {
                prepare(&flags, &id)
                    .map(|(_, _, token)| token)
                    .map_err(|(_, e)| {
                        let (code, message) = e.split_once(": ").unwrap_or(("INTERNAL", &e));
                        omni_ir::error::GatewayError::new(
                            omni_ir::error::ErrorCode::parse(code)
                                .unwrap_or(omni_ir::error::ErrorCode::Internal),
                            message,
                        )
                        .gateway_authored()
                    })
            })
            .await
            .map_err(|_| qerror())?
        })
    }
    fn send(
        &self,
        provider: String,
        request: omni_providers::quota::QuotaRequest,
    ) -> omni_control::quota_runtime::Task<'_, (u16, String)> {
        Box::pin(async move {
            let r = request.http;
            tokio::time::timeout(request.timeout, async {
                let response = omni_providers::http::Client::new()
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
                omni_ir::error::GatewayError::new(
                    omni_ir::error::ErrorCode::Upstream,
                    "quota operation threw",
                )
            })?
            .map_err(|_| {
                omni_ir::error::GatewayError::new(
                    omni_ir::error::ErrorCode::Upstream,
                    "quota operation threw",
                )
            })
        })
    }
    fn save<'a>(
        &'a self,
        id: &'a str,
        windows: &'a [Value],
    ) -> omni_control::quota_runtime::Task<'a, ()> {
        Box::pin(async move {
            let store = crate::context::open(&self.flags).map_err(|_| qerror())?;
            omni_control::quota_ops::save(&store, id, windows, now()).map_err(|_| qerror())
        })
    }
    fn now(&self) -> i64 {
        now()
    }
}
fn qerror() -> omni_ir::error::GatewayError {
    omni_ir::error::GatewayError::new(
        omni_ir::error::ErrorCode::Internal,
        "quota persistence failed",
    )
}
fn operate(flags: &Flags, operation: &str, id: &str, credit: Option<&str>) -> Result<Value, Error> {
    let quota = omni_control::quota_runtime::Quota::new(std::sync::Arc::new(CliHost {
        flags: flags.clone(),
    }));
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(fail)?;
    rt.block_on(async {
        match operation {
            "list" => quota.credits(id).await,
            "redeem" => quota.redeem(id, credit).await,
            _ => quota.refresh(Some(id)).await,
        }
    })
    .map_err(|e| fail(format!("{}: {}", e.code.as_str(), e.message)))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn account(store: &omni_store::SqliteStore, id: &str) -> Result<Value, Error> {
    omni_control::credentials::cli_rows_for(store, Some(id))
        .map_err(fail)?
        .first()
        .map(omni_control::api::lossy)
        .ok_or_else(|| fail("BAD_REQUEST: no such credential"))
}
fn token(
    store: &omni_store::SqliteStore,
    key: &omni_crypto::field::FieldKey,
    id: &str,
) -> Result<Option<String>, Error> {
    let raw: Option<String> = store
        .connection()
        .query_row(
            "SELECT access_token FROM credentials WHERE id=?",
            [id],
            |r| r.get(0),
        )
        .map_err(fail)?;
    raw.map(|s| omni_crypto::field::decrypt(key, &s).map_err(fail))
        .transpose()
}
fn prepare(
    flags: &Flags,
    id: &str,
) -> Result<(omni_store::SqliteStore, Value, Option<String>), Error> {
    let ctx = crate::context::resolve(flags).map_err(fail)?;
    let key = omni_crypto::field::derive_key(&ctx.encryption_key().map_err(fail)?);
    let store = ctx.open().map_err(fail)?;
    let a = account(&store, id)?;
    if a["hasRefreshToken"] == true
        && a["expiresAt"]
            .as_f64()
            .is_some_and(|e| e - 300000.0 <= now() as f64)
    {
        let mut quiet = flags.clone();
        quiet.insert("json".into(), "true".into());
        crate::oauth::refresh(&quiet, &[id.into()])?;
    }
    let a = account(&store, id)?;
    let token = token(&store, &key, id)?;
    Ok((store, a, token))
}
fn probe(flags: &Flags, id: &str) -> Result<usize, Error> {
    let result = operate(flags, "refresh", id, None)?;
    let outcome = &result["outcomes"][0];
    if outcome["kind"] == "failed" {
        return Err(fail(format!(
            "{}: quota probe failed",
            text(&outcome["code"])
        )));
    }
    Ok(outcome["windows"].as_u64().unwrap_or(0) as usize)
}
fn list(flags: &Flags, id: &str) -> Result<Value, Error> {
    operate(flags, "list", id, None)
}
pub fn run(command: &str, flags: &Flags, args: &[String]) -> Result<(), Error> {
    let store = crate::context::open(flags).map_err(fail)?;
    if command == "quota-refresh" {
        let accounts = omni_control::credentials::cli_rows(&store).map_err(fail)?;
        let wanted = if let Some(id) = args.first() {
            vec![account(&store, id)?]
        } else {
            accounts.iter().map(omni_control::api::lossy).collect()
        };
        if !flags.contains_key("json") {
            eprintln!(
                "{}",
                args.first()
                    .map_or("refreshing every account…".into(), |id| format!(
                        "refreshing {id}…"
                    ))
            );
        }
        let mut outcomes = Vec::new();
        for a in &wanted {
            let id = a["id"].as_str().unwrap_or("");
            let p = a["provider"].as_str().unwrap_or("");
            let out = if a["enabled"] != true {
                json!({"kind":"disabled","credentialId":id})
            } else if a["authType"] != "oauth"
                || !matches!(p, "openai" | "anthropic" | "antigravity" | "kimi" | "muse")
            {
                json!({"kind":"unsupported","credentialId":id})
            } else {
                match probe(flags, id) {
                    Ok(0) => json!({"kind":"noData","credentialId":id}),
                    Ok(n) => json!({"kind":"refreshed","credentialId":id,"windows":n}),
                    Err((_, e)) => {
                        json!({"kind":"failed","credentialId":id,"code":e.split(':').next().unwrap_or("INTERNAL")})
                    }
                }
            };
            outcomes.push(out);
        }
        let refreshed = outcomes.iter().filter(|o| o["kind"] == "refreshed").count();
        let failed = outcomes.iter().filter(|o| o["kind"] == "failed").count();
        emit(flags, &json!({"outcomes":outcomes}), || {
            Ok(format!(
                "{}\n\nrefreshed {refreshed}; failed {failed}; skipped {}",
                table(
                    &["ACCOUNT", "OUTCOME", "DETAIL"],
                    outcomes
                        .iter()
                        .zip(&wanted)
                        .map(|(o, a)| vec![
                            text(&a["label"]),
                            match o["kind"].as_str() {
                                Some("refreshed") => "refreshed",
                                Some("disabled") => "disabled",
                                Some("unsupported") => "no usage endpoint",
                                Some("failed") => "failed",
                                _ => "provider reported nothing",
                            }
                            .into(),
                            if o["kind"] == "refreshed" {
                                format!(
                                    "{} window{}",
                                    o["windows"],
                                    if o["windows"] == 1 { "" } else { "s" }
                                )
                            } else if o["kind"] == "failed" {
                                text(&o["code"])
                            } else {
                                "—".into()
                            }
                        ])
                        .collect(),
                    &[2]
                ),
                outcomes.len() - refreshed - failed
            ))
        })?;
        if failed > 0 {
            return Err(fail(if failed == outcomes.len() {
                "quota refresh did not run".into()
            } else {
                format!(
                    "quota refresh did not run for {failed} of {} accounts",
                    outcomes.len()
                )
            }));
        }
        return Ok(());
    }
    let id = args[0].trim();
    let a = account(&store, id).map_err(|(_, e)| {
        fail(if command == "quota-reset" {
            e.trim_start_matches("BAD_REQUEST: ").to_owned()
        } else {
            e
        })
    })?;
    if command == "quota-resets" {
        let result = list(flags, id)?;
        return emit(flags, &result, || {
            Ok(format!(
                "{}\n\n{} available",
                table(
                    &["CREDIT", "STATUS", "TITLE", "EXPIRES"],
                    result["credits"]
                        .as_array()
                        .unwrap_or(&Vec::new())
                        .iter()
                        .map(|c| vec![
                            text(&c["id"]),
                            text(&c["status"]),
                            c["title"].as_str().unwrap_or("—").into(),
                            crate::output::time(&c["expiresAt"])
                        ])
                        .collect(),
                    &[]
                ),
                result["available"]
            ))
        });
    }
    let p = a["provider"].as_str().unwrap_or("");
    if !matches!(p, "openai" | "anthropic") {
        return Err(fail("this account's provider has no quota resets"));
    }
    let question = format!(
        "spend one banked quota reset on \"{}\" ({id})?",
        text(&a["label"])
    );
    if !flags.contains_key("yes") {
        if !std::io::stdin().is_terminal() {
            return Err(fail(format!("{question} — refusing without --yes")));
        }
        eprintln!("{question} [y/N] ");
        std::io::stderr().flush().map_err(fail)?;
        let mut answer = String::new();
        std::io::stdin().read_line(&mut answer).map_err(fail)?;
        if !matches!(answer.trim().to_lowercase().as_str(), "y" | "yes") {
            return Err(fail("cancelled"));
        }
    }
    let result = operate(flags, "redeem", id, flags.get("credit").map(String::as_str))?;
    emit(flags, &result, || {
        Ok(format!(
            "{}: reset {} redeemed{}; {}",
            text(&a["label"]),
            text(&result["creditId"]),
            result["windowsReset"]
                .as_f64()
                .map_or(String::new(), |n| format!(", {n} window(s) reset")),
            if result["quotaRefreshed"] == true {
                "quota re-read"
            } else {
                "quota re-read failed, next poll will update it"
            }
        ))
    })
}
