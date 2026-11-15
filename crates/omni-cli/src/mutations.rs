use std::{collections::HashMap, io::IsTerminal};

pub fn usage(command: &str) -> &'static str {
    match command {
        "models-list" => "models list",
        "models-show" => "models show <id>",
        "models-rm" => "models rm <id>",
        "models-catalog" => "models catalog [--provider P]",
        "models-put" => "models put <id> (-f model.json | --from-catalog <provider>:<model> ...)",
        "settings-get" => "settings get",
        "settings-set" => "settings set <path> <value>",
        "create" => {
            "keys create [--label L] [--allow <model> ...] [--limit <d>:<w>=N ...] [--model-limit <model>:<d>:<w>=N ...] [--expires <when>] [--policy <text>] [--smart-routing] [--no-bodies]"
        }
        "limits" => {
            "keys limits <id> [--set <d>:<w>=N ...] [--unset <d>:<w> ...] [--model-limit <model>:<d>:<w>=N ...] [--unset-model-limit <model>:<d>[:<w>] ...]"
        }
        "expiry" => "keys expiry <id> [--at <when>] [--never]",
        "models" => "keys models <id> [--allow <model> ...] [--all] [--none]",
        "guardrail" => "keys guardrail <id> [--policy <text> | --policy-file <path> | --clear]",
        "smart-routing" => "keys smart-routing <id> (--on | --off)",
        "revoke" => "keys revoke <id>",
        _ => "keys list",
    }
}

pub fn run(
    command: &str,
    flags: &HashMap<String, String>,
    positional: &[String],
    allow: &[String],
) -> Result<String, (u8, String)> {
    let fail = |s: String| (1, s);
    let usage = |s: &str| (2, s.to_owned());
    let color = !flags.contains_key("no-color")
        && std::env::var("NO_COLOR").unwrap_or_default().is_empty()
        && std::io::stdout().is_terminal();
    let paint = |code, s: &str| {
        if color {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.into()
        }
    };
    if command == "create" {
        let entries: Vec<_> = allow
            .iter()
            .filter(|v| v.contains('\0'))
            .map(|v| v.replacen("limit\0", "set\0", usize::from(v.starts_with("limit\0"))))
            .collect();
        let limits = crate::limits::edit(&serde_json::json!({}), &entries)
            .map_err(|(code, e)| (code, e.replace("--set", "--limit")))?;
        let store = crate::context::open(flags).map_err(fail)?;
        let expiry = flags
            .get("expires")
            .map(|raw| {
                crate::date::parse(raw).ok_or_else(|| {
                    (
                        2,
                        format!("--expires must be a date, e.g. 2030-01-01, got \"{raw}\""),
                    )
                })
            })
            .transpose()?;
        let input = omni_control::keys::CreateKey {
            label: flags
                .get("label")
                .cloned()
                .unwrap_or_else(|| "api key".into()),
            models: flags.contains_key("allow").then(|| {
                allow
                    .iter()
                    .filter(|v| !v.contains('\0'))
                    .cloned()
                    .collect()
            }),
            limits,
            no_bodies: flags.contains_key("no-bodies"),
            expiry,
            policy: flags.get("policy").cloned(),
            smart: flags.contains_key("smart-routing"),
        };
        let created =
            omni_control::keys::create_key(&store, input, chrono::Utc::now().timestamp_millis())
                .map_err(fail)?;
        if flags.contains_key("json") {
            return Ok(
                omni_ir::jsjson::stringify_pretty(&omni_ir::jsjson::JsValue::from(&created))
                    .expect("created"),
            );
        }
        eprintln!(
            "{}",
            paint(33, "this key is shown once and stored only as a hash")
        );
        return Ok(created["key"].as_str().expect("key").into());
    }
    let id = positional
        .first()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| usage("key id is required"))?;
    let has = |k: &str| flags.contains_key(k);
    if command == "smart-routing" && has("on") == has("off") {
        return Err(usage("pass exactly one of --on or --off"));
    }
    let given = [has("policy"), has("policy-file"), has("clear")]
        .into_iter()
        .filter(|b| *b)
        .count();
    if command == "guardrail" && given > 1 {
        return Err(usage("pass one of --policy, --policy-file or --clear"));
    }
    let store = crate::context::open(flags).map_err(fail)?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut listing = omni_control::keys::list_keys(&store, now).map_err(fail)?;
    let index = listing.data["keys"]
        .as_array()
        .expect("key listing array")
        .iter()
        .position(|k| k["id"] == *id)
        .ok_or_else(|| fail(format!("no api key \"{id}\"")))?;
    let key = &listing.data["keys"][index];
    let replaced = command == "limits" && !allow.is_empty() && key["limits"].is_null();
    match command {
        "limits" if !allow.is_empty() => {
            if replaced {
                if allow.iter().any(|e| e.starts_with("unset")) {
                    return Err(fail(format!(
                        "the stored limits for \"{id}\" cannot be read, so there is nothing to unset; replace them with --set instead"
                    )));
                }
                if !has("json") {
                    eprintln!(
                        "{}",
                        paint(
                            33,
                            "the stored limits could not be read and are being replaced"
                        )
                    );
                }
            }
            let existing = if replaced {
                omni_ir::jsjson::JsValue::Null
            } else {
                listing.limits_js[index].clone()
            };
            let limits = crate::limits::edit_lossless(&existing, allow)?;
            let normalized = omni_control::api::lossy(&limits);
            listing
                .capture_mutation(&store, id, now, "limits", normalized, || {
                    omni_control::keys::set_limits(&store, id, &limits).map(Some)
                })
                .map_err(fail)?;
        }
        "expiry" if has("at") || has("never") => {
            if has("at") && has("never") {
                return Err(usage("--at and --never cannot be combined"));
            }
            let at = if let Some(raw) = flags.get("at") {
                Some(crate::date::parse(raw).ok_or_else(|| {
                    (
                        2,
                        format!("--at must be a date, e.g. 2030-01-01, got \"{raw}\""),
                    )
                })?)
            } else {
                None
            };
            listing
                .capture_mutation(&store, id, now, "expiresAt", serde_json::json!(at), || {
                    omni_control::keys::set_expiry(&store, id, at).map(|()| None)
                })
                .map_err(fail)?;
        }
        "smart-routing" => {
            listing
                .capture_mutation(&store, id, now, "smartRouting", has("on").into(), || {
                    omni_control::keys::set_smart_routing(&store, id, has("on")).map(|()| None)
                })
                .map_err(fail)?;
        }
        "models" if has("all") || has("none") || has("allow") => {
            if [has("all"), has("none"), has("allow")]
                .into_iter()
                .filter(|b| *b)
                .count()
                > 1
            {
                return Err(usage("--all, --none, and --allow cannot be combined"));
            }
            let value = if has("all") {
                serde_json::Value::Null
            } else {
                serde_json::json!(if has("none") { &[][..] } else { allow })
            };
            listing
                .capture_mutation(&store, id, now, "modelAllowlist", value, || {
                    omni_control::keys::set_models(
                        &store,
                        id,
                        if has("all") {
                            None
                        } else {
                            Some(if has("none") { &[] } else { allow })
                        },
                    )
                    .map(|()| None)
                })
                .map_err(fail)?;
        }
        "guardrail" if given == 1 => {
            let policy = if let Some(file) = flags.get("policy-file") {
                String::from_utf8_lossy(
                    &std::fs::read(file).map_err(|_| fail(format!("could not read {file}")))?,
                )
                .into_owned()
            } else {
                flags.get("policy").cloned().unwrap_or_default()
            };
            let value = if has("clear") {
                serde_json::Value::Null
            } else {
                serde_json::json!(omni_ir::js::trim(&policy))
            };
            listing
                .capture_mutation(&store, id, now, "guardrailPolicy", value, || {
                    omni_control::keys::set_guardrail(
                        &store,
                        id,
                        if has("clear") { None } else { Some(&policy) },
                    )
                    .map(|()| None)
                })
                .map_err(fail)?;
        }
        "revoke" => {
            let question = format!(
                "revoke key \"{}\" ({}…)?",
                omni_control::cli_cell::scalar_string(listing.cell(index, "label")),
                omni_control::cli_cell::scalar_string(listing.cell(index, "prefix"))
            );
            if !has("yes") {
                if !std::io::stdin().is_terminal() {
                    return Err(fail(format!("{question} — refusing without --yes")));
                }
                eprintln!("{question} [y/N] ");
                let mut line = String::new();
                std::io::stdin()
                    .read_line(&mut line)
                    .map_err(|e| fail(e.to_string()))?;
                if !matches!(line.trim().to_lowercase().as_str(), "y" | "yes") {
                    return Err(fail("cancelled".into()));
                }
            }
            omni_control::keys::revoke(&store, id, chrono::Utc::now().timestamp_millis())
                .map_err(fail)?;
            return Ok(if has("json") {
                format!(
                    "{{\n  \"id\": {},\n  \"revoked\": true\n}}",
                    serde_json::to_string(id).expect("string id")
                )
            } else {
                format!("{id} revoked")
            });
        }
        _ => {}
    }
    let index = listing.data["keys"]
        .as_array()
        .expect("key listing array")
        .iter()
        .position(|key| key["id"] == *id)
        .ok_or_else(|| fail(format!("no api key \"{id}\"")))?;
    if has("json") {
        if replaced {
            listing.data["keys"][index]["limitsReplaced"] = true.into();
        }
        return Ok(listing.one_json(index));
    }
    let key = &listing.data["keys"][index];
    let width = if command == "smart-routing" { 13 } else { 6 };
    let head = format!(
        "{:<width$}  {}\n{:<width$}  {}\n{:<width$}  {}…",
        "id",
        id,
        "label",
        omni_control::cli_cell::scalar_string(listing.cell(index, "label")),
        "prefix",
        omni_control::cli_cell::scalar_string(listing.cell(index, "prefix"))
    );
    Ok(match command {
        "limits" => {
            let text = crate::limits::human(key, &head);
            if key["limits"].is_null() {
                text.replacen("limits unreadable", &paint(31, "limits unreadable"), 1)
            } else {
                text.replace(
                    "usage is counted from completed requests still inside each window",
                    &paint(
                        2,
                        "usage is counted from completed requests still inside each window",
                    ),
                )
            }
        }
        "expiry" => {
            if matches!(
                listing.cell(index, "expiresAt"),
                omni_ir::jsjson::JsValue::Null
            ) {
                format!("{head}\nexpires: never")
            } else {
                format!(
                    "{head}\nexpires: {}{}",
                    crate::output::time(&key["expiresAt"]),
                    if matches!(
                        listing.cell(index, "revokedAt"),
                        omni_ir::jsjson::JsValue::Null
                    ) && !matches!(listing.cell(index, "expiresAt"), omni_ir::jsjson::JsValue::Number(v) if *v > now as f64)
                    {
                        format!(" {}", paint(31, "(expired)"))
                    } else {
                        String::new()
                    }
                )
            }
        }
        "smart-routing" => format!(
            "{head}\nsmart routing  {}",
            if key["smartRouting"] == true {
                "on"
            } else {
                "off"
            }
        ),
        "guardrail" => match key["guardrailPolicy"].as_str() {
            None => format!("{head}\npolicy: none; requests are not judged"),
            Some(p) => format!("{head}\npolicy:\n{p}"),
        },
        "models" => {
            let models = omni_control::operator_json::models_detail(&listing.allowlists[index])
                .map_err(fail)?;
            format!("{head}\nmodels: {models}")
        }
        _ => unreachable!(),
    })
}
