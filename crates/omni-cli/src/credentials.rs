//! Local operator credential views: preserve raw SQLite cells through rendering.
use omni_control::{cli_cell, settings_value::get};
use omni_ir::jsjson::{self, JsValue as J};
use std::{collections::HashMap, io::IsTerminal};

fn prop<'a>(v: &'a J, k: &str) -> &'a J {
    get(v, k).unwrap_or(&J::Undefined)
}
fn text(v: &J) -> String {
    omni_control::operator_json::string(v).unwrap_or_default()
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
pub fn run(
    command: &str,
    flags: &HashMap<String, String>,
    positional: &[String],
) -> Result<String, (u8, String)> {
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
    let rows = omni_control::credentials::cli_rows(&store).map_err(|e| (1, e))?;
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
                    Ok(vec![
                        cli_cell::table_text(prop(c, "id"))?,
                        crate::models::provider(prop(c, "provider"), color)?,
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
                .ok_or((1, "no such credential".into()))?;
            if !json {
                let (ok, status) = condition(c, now as f64);
                let entries = vec![
                    ("id", text(prop(c, "id"))),
                    (
                        "provider",
                        crate::models::provider(prop(c, "provider"), color).map_err(|e| (1, e))?,
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
            let raw = omni_control::credentials::health(&store, now).map_err(|e| (1, e.message))?;
            let data = jsjson::parse(&raw.encode_utf16().collect::<Vec<_>>())
                .map_err(|e| (1, format!("{e:?}")))?;
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
                        && cli_cell::scalar_number(prop(h, "consecutiveFailures")) <= 0.0
                    {
                        continue;
                    }
                    let label = rows
                        .iter()
                        .find(|c| prop(c, "id") == prop(h, "credentialId"))
                        .map_or(prop(h, "credentialId"), |c| prop(c, "label"));
                    let last = prop(prop(&data, "lastUsed"), &text(prop(h, "credentialId")));
                    let last = time(last);
                    rendered.push(vec![
                        cli_cell::table_text(label).map_err(|e| (1, e))?,
                        cli_cell::table_text(prop(h, "model")).map_err(|e| (1, e))?,
                        paint(color, closed, text(prop(h, "breakerState"))),
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
