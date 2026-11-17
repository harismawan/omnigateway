//! Local operator credential views: preserve raw SQLite cells through rendering.
use omni_control::{cli_cell, settings_value::get};
use omni_ir::jsjson::{self, JsValue as J};
use std::{collections::HashMap, io::IsTerminal};

fn prop<'a>(v: &'a J, k: &str) -> &'a J {
    static UNDEFINED: J = J::Undefined;
    get(v, k).unwrap_or(&UNDEFINED)
}
fn text(v: &J) -> String {
    match v {
        J::Object(_) | J::Null | J::Number(_) | J::String(_) => cli_cell::scalar_string(v),
        _ => omni_control::operator_json::string(v).unwrap_or_default(),
    }
}
fn provider(v: &J, color: bool) -> Result<String, String> {
    if matches!(v, J::String(_)) {
        crate::models::provider(v, color)
    } else {
        Ok(text(v))
    }
}
fn time(v: &J) -> String {
    match v {
        J::Number(n) => crate::output::time(&serde_json::json!(n)),
        _ => "—".into(),
    }
}
fn paint(color: bool, ok: bool, value: String) -> String {
    if color {
        format!("\x1b[{}m{value}\x1b[0m", if ok { 32 } else { 31 })
    } else {
        value
    }
}
fn condition(c: &J, now: f64) -> (bool, String) {
    if prop(c, "enabled") != &J::Bool(true) {
        return (
            false,
            if matches!(prop(c, "disabledReason"), J::Null) {
                "disabled".into()
            } else {
                text(prop(c, "disabledReason"))
            },
        );
    }
    if prop(c, "authType") == &J::String("oauth".encode_utf16().collect())
        && !matches!(prop(c, "expiresAt"), J::Null)
        && cli_cell::scalar_number(prop(c, "expiresAt")) <= now
    {
        if prop(c, "hasRefreshToken") == &J::Bool(true) {
            return (true, "expired (refreshable)".into());
        }
        return (false, "expired".into());
    }
    (true, "enabled".into())
}
fn object(fields: Vec<(&str, J)>) -> J {
    J::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn failure(e: omni_control::api::Failure) -> (u8, String) {
    (
        1,
        e.code
            .map_or(e.message.clone(), |c| format!("{c}: {}", e.message)),
    )
}
fn string(s: &str) -> J {
    J::String(s.encode_utf16().collect())
}
fn mutate(
    command: &str,
    flags: &HashMap<String, String>,
    args: &[String],
) -> Result<String, (u8, String)> {
    use std::io::{BufRead, Read};
    let id = args.first().filter(|s| !s.is_empty()).ok_or((
        2,
        if command == "credentials-add-key" {
            "provider is required"
        } else {
            "credential id is required"
        }
        .into(),
    ))?;
    let mut fields = Vec::new();
    if command == "credentials-set" {
        if let Some(label) = flags.get("label") {
            fields.push(("label", string(label)));
        }
        for name in ["tier", "weight"] {
            if let Some(raw) = flags
                .get(name)
                .filter(|s| !s.trim_matches(omni_ir::js::is_js_whitespace).is_empty())
            {
                let n = cli_cell::scalar_number(&string(raw));
                if !n.is_finite() {
                    return Err((2, format!("--{name} must be a number, got \"{raw}\"")));
                }
                fields.push((name, J::Number(n)));
            }
        }
        if fields.is_empty() {
            return Err((
                2,
                "nothing to change: pass --label, --tier, or --weight".into(),
            ));
        }
    }
    if command == "credentials-add-key" && omni_control::catalog::descriptor(id).is_none() {
        return Err((2, "provider must be one of anthropic, openai, codex, copilot, gemini, antigravity, kiro, qwen, qoder, iflow, custom, or a plugin that loads and supplies one; omni plugin list shows which".into()));
    }
    let mut secret = String::new();
    if command == "credentials-add-key" {
        if std::io::stdin().is_terminal() {
            secret = String::from_utf16_lossy(
                &crate::password::secret(&format!("{id} API key: ")).map_err(|e| (1, e))?,
            );
            eprintln!();
        } else {
            std::io::stdin()
                .read_to_string(&mut secret)
                .map_err(|e| (1, e.to_string()))?;
        }
        secret = secret.trim_matches(omni_ir::js::is_js_whitespace).into();
        if secret.is_empty() {
            return Err((1, "no API key given".into()));
        }
    }
    let ctx = crate::context::resolve(flags).map_err(|e| (1, e))?;
    let key = if command == "credentials-add-key" {
        Some(omni_crypto::field::derive_key(
            &ctx.encryption_key().map_err(|e| (1, e))?,
        ))
    } else {
        None
    };
    let store = ctx.open().map_err(|e| (1, e))?;
    let now = chrono::Utc::now().timestamp_millis();
    let (result, human) = match command {
        "credentials-add-key" => {
            let mut input = vec![("provider", string(id)), ("apiKey", string(&secret))];
            for (flag, name) in [
                ("label", "label"),
                ("endpoint-id", "endpointId"),
                ("endpoint-label", "endpointLabel"),
                ("origin", "origin"),
                ("protocol", "protocol"),
            ] {
                if let Some(v) = flags.get(flag) {
                    input.push((
                        name,
                        string(if flag == "protocol" && v == "chat-completions" {
                            "chat_completions"
                        } else {
                            v
                        }),
                    ));
                }
            }
            if id == "custom"
                && let Some(endpoint) = flags.get("endpoint-id")
            {
                let rows = omni_control::credentials::cli_rows(&store).map_err(|e| (1, e))?;
                if let Some(old) = rows.iter().find(|c| {
                    prop(c, "provider") == &string("custom")
                        && prop(prop(c, "providerData"), "endpointId")
                            == &string(endpoint.trim_matches(omni_ir::js::is_js_whitespace))
                }) {
                    let data = prop(old, "providerData");
                    for name in ["endpointLabel", "origin", "protocol"] {
                        if !input.iter().any(|(k, _)| *k == name) {
                            let v = if name == "origin" {
                                string(&format!(
                                    "{}{}",
                                    cli_cell::scalar_string(prop(data, "origin")),
                                    match prop(data, "basePath") {
                                        J::String(_) =>
                                            cli_cell::scalar_string(prop(data, "basePath")),
                                        _ => String::new(),
                                    }
                                ))
                            } else {
                                prop(data, name).clone()
                            };
                            input.push((name, v));
                        }
                    }
                }
            }
            let created = omni_control::credentials::create(
                &store,
                key.as_ref().expect("key"),
                &object(input),
                now,
            )
            .map_err(failure)?;
            let created = jsjson::parse(&created).map_err(|e| (1, e.to_string()))?;
            let new_id = prop(prop(&created, "credential"), "id").clone();
            let human = format!("stored {id} api key as {}", text(&new_id));
            (
                object(vec![
                    ("id", new_id),
                    ("provider", string(id)),
                    ("pluginFailures", J::Array(vec![])),
                ]),
                human,
            )
        }
        "credentials-rm" => {
            let rows =
                omni_control::credentials::cli_rows_for(&store, Some(id)).map_err(|e| (1, e))?;
            let c = rows
                .first()
                .ok_or((1, "BAD_REQUEST: no such credential".into()))?;
            let models = omni_control::models::cli_list(&store).map_err(|e| (1, e))?;
            let mut pins = Vec::new();
            for m in &models {
                if let J::Array(targets) = prop(m, "targets")
                    && targets
                        .iter()
                        .any(|t| prop(t, "credentialId") == &string(id))
                {
                    pins.push(cli_cell::scalar_string(prop(m, "id")));
                }
            }
            let mut question = format!(
                "delete {} credential \"{}\" ({id})?",
                cli_cell::scalar_string(prop(c, "provider")),
                cli_cell::scalar_string(prop(c, "label"))
            );
            if !pins.is_empty() {
                question.push_str(&format!(
                    " {} {} {} to it, and {} will fail rather than fall back to another account.",
                    if pins.len() == 1 { "model" } else { "models" },
                    pins.join(", "),
                    if pins.len() == 1 {
                        "pins a target"
                    } else {
                        "pin targets"
                    },
                    if pins.len() == 1 {
                        "that target"
                    } else {
                        "those targets"
                    }
                ));
            }
            if !flags.contains_key("yes") {
                if !std::io::stdin().is_terminal() {
                    return Err((1, format!("{question} — refusing without --yes")));
                }
                eprintln!("{question} [y/N] ");
                let mut line = String::new();
                std::io::stdin()
                    .lock()
                    .read_line(&mut line)
                    .map_err(|e| (1, e.to_string()))?;
                if !matches!(
                    line.trim_matches(omni_ir::js::is_js_whitespace)
                        .to_lowercase()
                        .as_str(),
                    "y" | "yes"
                ) {
                    return Err((1, "cancelled".into()));
                }
            }
            omni_control::credentials::remove(&store, Some(id)).map_err(failure)?;
            (
                object(vec![("id", string(id)), ("removed", J::Bool(true))]),
                format!("{id} removed"),
            )
        }
        _ => {
            let human = if command == "credentials-set" {
                format!("{id} updated")
            } else {
                let enabled = command == "credentials-enable";
                fields.push(("enabled", J::Bool(enabled)));
                format!("{id} {}", if enabled { "enabled" } else { "disabled" })
            };
            let patch = object(fields.clone());
            omni_control::credentials::cli_rows_for(&store, Some(id)).map_err(|e| (1, e))?;
            omni_control::credentials::patch(&store, Some(id), &patch, now).map_err(failure)?;
            fields.insert(0, ("id", string(id)));
            (object(fields), human)
        }
    };
    Ok(if flags.contains_key("json") {
        jsjson::stringify_pretty(&result).expect("mutation result")
    } else {
        human
    })
}
pub fn run(
    command: &str,
    flags: &HashMap<String, String>,
    positional: &[String],
) -> Result<String, (u8, String)> {
    if matches!(
        command,
        "credentials-enable"
            | "credentials-disable"
            | "credentials-set"
            | "credentials-rm"
            | "credentials-add-key"
    ) {
        return mutate(command, flags, positional);
    }
    let id = if command == "credentials-show" {
        Some(
            positional
                .first()
                .filter(|s| !s.is_empty())
                .ok_or((2, "credential id is required".into()))?,
        )
    } else {
        None
    };
    let store = crate::context::open(flags).map_err(|e| (1, e))?;
    let rows = omni_control::credentials::cli_rows_for(&store, id.map(|s| s.as_str()))
        .map_err(|e| (1, e))?;
    let color = !flags.contains_key("no-color")
        && std::env::var("NO_COLOR").unwrap_or_default().is_empty()
        && std::io::stdout().is_terminal();
    let now = chrono::Utc::now().timestamp_millis();
    let json = flags.contains_key("json");
    let out = match command {
        "credentials-list" if json => object(vec![("credentials", J::Array(rows))]),
        "credentials-list" => {
            if rows.is_empty() {
                return Ok("no credentials; add one with: omni connect <provider>".into());
            }
            let rendered = rows
                .iter()
                .map(|c| {
                    let (ok, status) = condition(c, now as f64);
                    if prop(c, "enabled") != &J::Bool(true)
                        && !matches!(prop(c, "disabledReason"), J::Null)
                    {
                        cli_cell::table_text(prop(c, "disabledReason"))?;
                    }
                    Ok(vec![
                        cli_cell::table_text(prop(c, "id"))?,
                        {
                            cli_cell::table_text(prop(c, "provider"))?;
                            provider(prop(c, "provider"), color)?
                        },
                        cli_cell::table_text(prop(c, "label"))?,
                        cli_cell::table_text(prop(c, "authType"))?,
                        text(prop(c, "tier")),
                        text(prop(c, "weight")),
                        paint(color, ok, status),
                        time(prop(c, "expiresAt")),
                    ])
                })
                .collect::<Result<Vec<_>, String>>()
                .map_err(|e| (1, e))?;
            return Ok(crate::models::table(
                &[
                    "ID", "PROVIDER", "LABEL", "AUTH", "TIER", "WEIGHT", "STATE", "EXPIRES",
                ],
                &[4, 5],
                rendered,
            ));
        }
        "credentials-show" => {
            let id = id.expect("show id");
            let c = rows
                .iter()
                .find(|c| prop(c, "id") == &J::String(id.encode_utf16().collect()))
                .ok_or((1, "BAD_REQUEST: no such credential".into()))?;
            if !json {
                let (ok, status) = condition(c, now as f64);
                let entries = vec![
                    ("id", text(prop(c, "id"))),
                    (
                        "provider",
                        provider(prop(c, "provider"), color).map_err(|e| (1, e))?,
                    ),
                    ("label", text(prop(c, "label"))),
                    ("auth", text(prop(c, "authType"))),
                    ("state", paint(color, ok, status)),
                    ("tier", text(prop(c, "tier"))),
                    ("weight", text(prop(c, "weight"))),
                    (
                        "account",
                        if matches!(prop(c, "accountEmail"), J::Null) {
                            "—".into()
                        } else {
                            text(prop(c, "accountEmail"))
                        },
                    ),
                    ("expires", time(prop(c, "expiresAt"))),
                    (
                        "refresh token",
                        if prop(c, "hasRefreshToken") == &J::Bool(true) {
                            "yes".into()
                        } else {
                            "no".into()
                        },
                    ),
                    ("created", time(prop(c, "createdAt"))),
                    ("updated", time(prop(c, "updatedAt"))),
                ];
                return Ok(entries
                    .iter()
                    .map(|(k, v)| format!("{k:13}  {v}"))
                    .collect::<Vec<_>>()
                    .join("\n"));
            }
            object(
                [
                    "id",
                    "provider",
                    "label",
                    "authType",
                    "enabled",
                    "tier",
                    "weight",
                    "expiresAt",
                    "accountEmail",
                    "providerData",
                    "disabledReason",
                    "disabledAt",
                    "hasRefreshToken",
                    "createdAt",
                    "updatedAt",
                ]
                .into_iter()
                .map(|k| (k, prop(c, k).clone()))
                .collect(),
            )
        }
        "credentials-health" => {
            let data = omni_control::credentials::cli_health(&store, now).map_err(|e| (1, e))?;
            if !json {
                let J::Array(health) = prop(&data, "health") else {
                    unreachable!()
                };
                let mut rendered = Vec::new();
                for h in health {
                    let closed =
                        prop(h, "breakerState") == &J::String("closed".encode_utf16().collect());
                    if !flags.contains_key("all")
                        && closed
                        && cli_cell::scalar_number(prop(h, "consecutiveFailures")).partial_cmp(&0.0)
                            != Some(std::cmp::Ordering::Greater)
                    {
                        continue;
                    }
                    let label = rows
                        .iter()
                        .find(|c| prop(c, "id") == prop(h, "credentialId"))
                        .map_or(prop(h, "credentialId"), |c| prop(c, "label"));
                    let label = if matches!(label, J::Null | J::Undefined) {
                        prop(h, "credentialId")
                    } else {
                        label
                    };
                    let last = prop(prop(&data, "lastUsed"), &text(prop(h, "credentialId")));
                    let last = time(last);
                    rendered.push(vec![
                        cli_cell::table_text(label).map_err(|e| (1, e))?,
                        cli_cell::table_text(prop(h, "model")).map_err(|e| (1, e))?,
                        paint(
                            color,
                            closed,
                            cli_cell::table_text(prop(h, "breakerState")).map_err(|e| (1, e))?,
                        ),
                        text(prop(h, "consecutiveFailures")),
                        if color {
                            format!("\x1b[2m{last}\x1b[0m")
                        } else {
                            last
                        },
                    ]);
                }
                return Ok(if rendered.is_empty() {
                    "every credential is healthy".into()
                } else {
                    crate::models::table(
                        &["CREDENTIAL", "MODEL", "BREAKER", "FAILS", "LAST USED"],
                        &[3],
                        rendered,
                    )
                });
            }
            object(vec![
                ("health", prop(&data, "health").clone()),
                ("lastUsed", prop(&data, "lastUsed").clone()),
            ])
        }
        _ => unreachable!(),
    };
    Ok(jsjson::stringify_pretty(&out).expect("credential projection"))
}
