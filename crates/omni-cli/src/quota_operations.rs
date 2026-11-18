use crate::observability::{Error, Flags, emit, fail, table, text};
use serde_json::{Value, json};
use std::io::{IsTerminal, Write};
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
fn wire(
    provider: &str,
    operation: &str,
    token: Option<&str>,
    data: &Value,
    body: Value,
) -> Result<Option<Value>, Error> {
    if token.is_none() && matches!(operation, "redeem" | "profile") {
        return Err(fail("AUTH: credential holds no access token"));
    }
    if token.is_none() && provider != "antigravity" {
        return Ok(None);
    }
    let Some(r) =
        omni_providers::quota::request(provider, operation, token.unwrap_or("null"), data, body)
    else {
        return Ok(None);
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(fail)?;
    let response = rt.block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let r = omni_providers::http::Client::new()
                .send(omni_providers::http::HttpRequest {
                    provider: provider.into(),
                    url: r.url,
                    method: r.method,
                    headers: r.headers,
                    body: r.body,
                    body_encoding: None,
                    request_id: None,
                })
                .await?;
            Ok::<_, omni_providers::http::HttpError>((r.status, r.body.text().await?))
        })
        .await
    });
    let (status, body) = response
        .map_err(|_| fail(format!("UPSTREAM: {provider} oauth {operation} threw")))?
        .map_err(|_| fail(format!("UPSTREAM: {provider} oauth {operation} threw")))?;
    if status == 429 && !matches!(operation, "redeem" | "profile") {
        return Err(fail(format!(
            "RATE_LIMIT: {provider} usage endpoint is rate limited"
        )));
    }
    if !(200..300).contains(&status) {
        if operation == "redeem" || operation == "profile" {
            let code = if status == 429 {
                "RATE_LIMIT"
            } else if status == 401 || status == 403 {
                "AUTH"
            } else if status < 500 {
                "CONFLICT"
            } else {
                "UPSTREAM"
            };
            return Err(fail(format!(
                "{code}: {} refused: http_{status}",
                if operation == "profile" {
                    "profile read"
                } else if provider == "openai" {
                    "reset credit redeem"
                } else {
                    "reset claim"
                }
            )));
        }
        return Ok(None);
    }
    Ok(serde_json::from_str(&body).ok())
}
fn probe(flags: &Flags, id: &str) -> Result<usize, Error> {
    let (store, a, token) = prepare(flags, id)?;
    let p = a["provider"].as_str().unwrap_or("");
    let Some(v) = wire(
        p,
        "usage",
        token.as_deref(),
        &a["providerData"],
        Value::Null,
    )?
    else {
        return Ok(0);
    };
    let windows = omni_providers::quota::usage(p, &v, now() as f64);
    if !windows.is_empty() {
        omni_control::quota_ops::save(&store, id, &windows, now()).map_err(fail)?;
    }
    Ok(windows.len())
}
fn list(flags: &Flags, id: &str) -> Result<Value, Error> {
    let store = crate::context::open(flags).map_err(fail)?;
    let before = account(&store, id)?;
    if before["authType"] != "oauth"
        || !matches!(before["provider"].as_str(), Some("openai" | "anthropic"))
    {
        return Err(fail(
            "BAD_REQUEST: this account's provider has no quota resets",
        ));
    }
    let (_, a, token) = prepare(flags, id)?;
    let p = a["provider"].as_str().unwrap_or("");
    if a["authType"] != "oauth" || !matches!(p, "openai" | "anthropic") {
        return Err(fail(
            "BAD_REQUEST: this account's provider has no quota resets",
        ));
    }
    let result = wire(p, "list", token.as_deref(), &a["providerData"], Value::Null)?
        .and_then(|v| omni_providers::quota::credits(p, &v))
        .ok_or_else(|| fail("UPSTREAM: provider answered the reset list with nothing usable"))?;
    Ok(json!({"credentialId":id,"available":result["available"],"credits":result["credits"]}))
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
                || !matches!(p, "openai" | "anthropic" | "antigravity")
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
    let listed = list(flags, id)?;
    let mut available = listed["credits"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter(|c| c["status"] == "available")
        .cloned()
        .collect::<Vec<_>>();
    available.sort_by(|a, b| {
        a["expiresAt"]
            .as_f64()
            .unwrap_or(f64::INFINITY)
            .total_cmp(&b["expiresAt"].as_f64().unwrap_or(f64::INFINITY))
    });
    let credit = available
        .iter()
        .find(|c| {
            flags
                .get("credit")
                .is_none_or(|id| c["id"].as_str() == Some(id))
        })
        .ok_or_else(|| {
            fail(if flags.contains_key("credit") {
                "CONFLICT: that reset credit is not available"
            } else {
                "CONFLICT: no reset credit is available for this account"
            })
        })?;
    let credit_id = text(&credit["id"]);
    let (_, a, token) = prepare(flags, id)?;
    let mut data = a["providerData"].clone();
    let request_id = uuid();
    let body = if p == "openai" {
        json!({"credit_id":credit_id,"redeem_request_id":request_id})
    } else {
        let profile =
            wire(p, "profile", token.as_deref(), &data, Value::Null)?.unwrap_or(Value::Null);
        let org = profile["organization"]["uuid"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            .ok_or_else(|| fail("UPSTREAM: profile names no organization"))?;
        data["organization"] = json!(org);
        let grant = credit_id
            .rsplit_once("-u")
            .map(|x| x.0)
            .ok_or_else(|| fail("CONFLICT: that reset credit is not available"))?;
        json!({"program":"cedar_ember","grant_id":grant,"request_id":request_id})
    };
    let result = wire(p, "redeem", token.as_deref(), &data, body)?.unwrap_or(Value::Null);
    let windows = omni_providers::quota::redeemed(p, &result).map_err(fail)?;
    let refreshed = probe(flags, id).is_ok_and(|n| n > 0);
    let result = json!({"credentialId":id,"creditId":credit_id,"windowsReset":windows,"quotaRefreshed":refreshed});
    emit(flags, &result, || {
        Ok(format!(
            "{}: reset {credit_id} redeemed{}; {}",
            text(&a["label"]),
            windows.map_or(String::new(), |n| format!(", {n} window(s) reset")),
            if refreshed {
                "quota re-read"
            } else {
                "quota re-read failed, next poll will update it"
            }
        ))
    })
}
fn uuid() -> String {
    omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate())
}
