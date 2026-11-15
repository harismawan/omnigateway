use omni_control::{
    operator_json,
    settings_value::{get, set},
};
use omni_ir::jsjson::{JsValue as V, stringify_pretty};
use std::{
    collections::HashMap,
    io::{BufRead, IsTerminal},
    path::PathBuf,
};
fn text(s: &str) -> V {
    V::String(s.encode_utf16().collect())
}
use omni_control::fs_error::fs_error;
fn object() -> V {
    V::Object(vec![])
}
fn string(v: &V) -> String {
    operator_json::string(v).unwrap_or_default()
}
fn remove(v: &mut V, key: &str) {
    if let V::Object(fields) = v {
        fields.retain(|(k, _)| !k.iter().copied().eq(key.encode_utf16()));
    }
}
// Adapt only identity fields to the shared router rule; setup does not need
// secrets, pricing or routing health to decide whether a pin serves a target.
fn serves_pin(t: &V, id: &str, provider: &str, data: &V) -> bool {
    use omni_store::{
        AuthType, Credential, CredentialSecrets, Secret,
        models::{Capabilities, Target, TargetPricing},
    };
    let lone = |v: Option<&V>| match v {
        Some(V::String(units)) if String::from_utf16(units).is_err() => Some(units.clone()),
        _ => None,
    };
    let mut identity = HashMap::new();
    for key in ["provider", "credentialId", "endpointId"] {
        if let Some(units) = lone(get(t, key)) {
            identity.insert(key.into(), units);
        }
    }
    let target = Target {
        lone_identity: identity,
        provider: provider.into(),
        endpoint_id: get(t, "endpointId").map(omni_control::settings_value::shallow),
        credential_id: Some(id.into()),
        model: String::new(),
        tier: 0.0,
        weight: 1.0,
        cost_per_m_tok: TargetPricing {
            input: 0.0,
            output: 0.0,
            cache_read: None,
            cache_write_5m: None,
            cache_write_1h: None,
            extra: Default::default(),
        },
        context_window: None,
        max_output_tokens: None,
        capabilities: Capabilities {
            tools: false,
            images: false,
            reasoning: false,
        },
        extra: Default::default(),
    };
    let account = Credential {
        lone_endpoint: lone(get(data, "endpointId")),
        id: id.into(),
        provider: provider.into(),
        label: String::new(),
        auth_type: AuthType::ApiKey,
        enabled: true,
        tier: 0.0,
        weight: 1.0,
        expires_at: None,
        account_email: None,
        provider_data: get(data, "endpointId").map_or_else(
            || serde_json::json!({}),
            |v| serde_json::json!({"endpointId":omni_control::settings_value::shallow(v)}),
        ),
        disabled_reason: None,
        disabled_at: None,
        has_refresh_token: false,
        token_version: 0,
        created_at: 0,
        updated_at: 0,
        secrets: CredentialSecrets {
            access_token: Secret::Absent,
            refresh_token: Secret::Absent,
            api_key: Secret::Absent,
            id_token: Secret::Absent,
        },
    };
    omni_router::serves_target(&target, &account)
}
const SLOTS: [(&str, &str, &str); 5] = [
    ("Default", "defaultModel", "ANTHROPIC_MODEL"),
    ("Fable", "fableModel", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
    ("Opus", "opusModel", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("Sonnet", "sonnetModel", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("Haiku", "haikuModel", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
];

pub fn run(command: &str, flags: &HashMap<String, String>) -> Result<String, String> {
    let ctx = crate::context::resolve(flags)?;
    let base = ctx.base_url()?;
    let store = ctx.open()?;
    let models = omni_control::models::cli_list(&store)?;
    let descriptions = models
        .iter()
        .map(|m| describe(m, &store))
        .collect::<Result<Vec<_>, _>>()?;
    if models.is_empty() {
        return Err("no virtual models configured; add one with `omni models put`".into());
    }
    let ids = models
        .iter()
        .map(|m| string(get(m, "id").expect("model id")))
        .collect::<Vec<_>>();
    let mut mapping = Vec::new();
    for (i, (label, _, _)) in SLOTS.iter().enumerate() {
        let question = format!(
            "{label} model{} [{}]: ",
            if i == 0 { "" } else { " (blank to omit)" },
            ids.join(", ")
        );
        if !std::io::stdin().is_terminal() {
            return Err(format!("{question} — refusing without a terminal"));
        }
        eprintln!("{question}");
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        let answer = omni_ir::js::trim(&line).to_owned();
        if i == 0 && answer.is_empty() {
            return Err("default model is required".into());
        }
        mapping.push(answer);
    }
    let claude = command == "setup-claude";
    let dir = flags.get("dir").map(PathBuf::from).unwrap_or_else(|| {
        if claude {
            std::env::home_dir().unwrap_or_default().join(".claude")
        } else {
            std::env::current_dir().unwrap_or_default()
        }
    });
    let dir = normalize(&dir);
    let path = normalize(&dir.join(if claude {
        "settings.json"
    } else {
        "opencode.json"
    }));
    let key = flags
        .get("key")
        .map(String::as_str)
        .unwrap_or("<your OmniGateway key>");
    let mut config = object();
    if claude && path.exists() {
        let mut file = std::fs::File::open(&path).map_err(|e| fs_error(&e, "open", &path))?;
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut raw).map_err(|e| fs_error(&e, "read", &path))?;
        config = operator_json::parse(&String::from_utf8_lossy(&raw))
            .map_err(|e| format!("cannot parse existing settings.json: {e}"))?;
        if !matches!(config, V::Object(_)) {
            return Err(
                "cannot parse existing settings.json: settings root is not an object".into(),
            );
        }
    }
    for (i, id) in mapping.iter().enumerate() {
        if !id.is_empty() && !ids.contains(id) {
            return Err(format!(
                "{} names unknown virtual model \"{id}\"",
                SLOTS[i].1
            ));
        }
    }
    if claude {
        let mut env = get(&config, "env")
            .filter(|v| matches!(v, V::Object(_)))
            .cloned()
            .unwrap_or_else(object);
        for (_, _, key) in SLOTS {
            remove(&mut env, key);
        }
        remove(&mut env, "CLAUDE_CODE_MAX_CONTEXT_TOKENS");
        set(&mut env, "ANTHROPIC_BASE_URL", text(&base));
        set(&mut env, "ANTHROPIC_AUTH_TOKEN", text(key));
        set(
            &mut env,
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
            text("1"),
        );
        for (i, id) in mapping.iter().enumerate() {
            if !id.is_empty() {
                set(&mut env, SLOTS[i].2, text(id));
            }
        }
        set(&mut config, "env", env);
    } else {
        let mut selected = object();
        for id in &mapping {
            if id.is_empty() || id == "__proto__" || get(&selected, id).is_some() {
                continue;
            }
            let index = ids.iter().position(|s| s == id).expect("validated id");
            set(&mut selected, id, descriptions[index].clone());
        }
        let mut url = base.trim_end_matches('/').to_owned();
        while url.to_ascii_lowercase().ends_with("/v1") {
            url.truncate(url.len() - 3);
        }
        config = V::from(
            &serde_json::json!({"$schema":"https://opencode.ai/config.json","model":format!("omnigateway/{}",mapping[0]),"provider":{"omnigateway":{"npm":"@ai-sdk/openai-compatible","name":"OmniGateway","options":{"baseURL":format!("{url}/v1"),"apiKey":key}}}}),
        );
        if let V::Object(fields) = &mut config {
            let provider = &mut fields
                .iter_mut()
                .find(|(k, _)| String::from_utf16_lossy(k) == "provider")
                .expect("provider")
                .1;
            if let V::Object(p) = provider {
                set(&mut p[0].1, "models", selected);
            }
        }
    }
    let contents = format!("{}\n", stringify_pretty(&config).expect("object"));
    if !flags.contains_key("dry-run") {
        std::fs::create_dir_all(&dir).map_err(|e| fs_error(&e, "mkdir", &dir))?;
        let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
        let result = std::fs::File::create(&temporary)
            .map_err(|e| fs_error(&e, "open", &temporary))
            .and_then(|mut f| {
                std::io::Write::write_all(&mut f, contents.as_bytes())
                    .map_err(|e| fs_error(&e, "write", &temporary))
            })
            .and_then(|()| {
                std::fs::rename(&temporary, &path).map_err(|e| {
                    format!(
                        "{} -> '{}'",
                        fs_error(&e, "rename", &temporary),
                        path.display()
                    )
                })
            });
        if result.is_err() {
            drop(std::fs::remove_file(&temporary));
        }
        result?;
    }
    let display = path.to_string_lossy();
    Ok(if flags.contains_key("json") {
        omni_ir::jsjson::to_string_pretty(
            &serde_json::json!({"files":[{"path":display,"contents":contents}],"pluginFailures":[]}),
        )
    } else if flags.contains_key("dry-run") {
        format!("--- {display}\n{contents}")
    } else {
        display.into_owned()
    })
}

fn describe(model: &V, store: &omni_store::SqliteStore) -> Result<V, String> {
    let mut result = object();
    let mut label = get(model, "id").expect("id").clone();
    let mut context: Option<f64> = None;
    let mut output: Option<f64> = None;
    let V::Array(targets) = get(model, "targets").ok_or("missing targets")? else {
        return Err("model.targets is not iterable".into());
    };
    for t in targets {
        let provider = get(t, "provider").map(string).unwrap_or_default();
        let choice = omni_control::catalog::rows(Some(&provider))
            .into_iter()
            .map(|(_, v)| v)
            .find(|v| get(v, "id") == get(t, "model"));
        if targets.len() == 1
            && let Some(v) = choice.and_then(|v| get(v, "label"))
        {
            label = v.clone();
        }
        let mut stmt = store
            .connection()
            .prepare(
                "SELECT id,auth_type,provider_data FROM credentials WHERE provider=? AND enabled=1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&provider], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let pin = rows.iter().find(|(id, _, data)| {
            get(t, "credentialId") == Some(&text(id))
                && operator_json::parse(data)
                    .ok()
                    .is_some_and(|d| serves_pin(t, id, &provider, &d))
        });
        let auths = if let Some((_, a, _)) = pin {
            vec![a.as_str()]
        } else if rows.is_empty() {
            vec!["apiKey"]
        } else {
            rows.iter().map(|(_, a, _)| a.as_str()).collect()
        };
        let mut tc = None;
        let mut to = None;
        for auth in auths {
            if let Some(c) = choice {
                let limits = if auth == "oauth" {
                    get(c, "oauthLimits").or_else(|| get(c, "limits"))
                } else {
                    get(c, "limits")
                };
                if let Some(l) = limits {
                    narrow(&mut tc, get(l, "contextWindow"));
                    narrow(&mut to, get(l, "maxOutputTokens"));
                }
            }
        }
        if let Some(V::Number(n)) = get(t, "contextWindow") {
            tc = Some(*n);
        }
        if let Some(V::Number(n)) = get(t, "maxOutputTokens") {
            to = Some(*n);
        }
        if let Some(n) = tc {
            narrow(&mut context, Some(&V::Number(n)));
        }
        if let Some(n) = to {
            narrow(&mut output, Some(&V::Number(n)));
        }
    }
    set(&mut result, "name", label);
    if let Some(n) = context {
        let mut limits = object();
        set(&mut limits, "context", V::Number(n));
        if let Some(n) = output {
            set(&mut limits, "output", V::Number(n));
        }
        set(&mut result, "limit", limits);
    }
    Ok(result)
}
fn narrow(current: &mut Option<f64>, value: Option<&V>) {
    if let Some(V::Number(n)) = value {
        *current = Some(current.map_or(*n, |old| old.min(*n)));
    }
}

fn normalize(path: &std::path::Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if out.file_name().is_some_and(|s| s != "..") {
                    out.pop();
                } else if !out.has_root() {
                    out.push("..");
                }
            }
            p => out.push(p.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}
