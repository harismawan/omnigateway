//! Agent configuration shared by the reader endpoint and the local CLI.
use crate::{
    api::Failure,
    operator_json,
    settings_value::{get, set, shallow},
};
use omni_ir::jsjson::{JsValue as V, stringify_pretty, to_string};
use omni_store::SqliteStore;
use std::collections::HashMap;

const KEY_PLACEHOLDER: &str = "<your OmniGateway key>";

fn text(s: &str) -> V {
    V::String(s.encode_utf16().collect())
}

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
        endpoint_id: get(t, "endpointId").map(shallow),
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
            |v| serde_json::json!({"endpointId":shallow(v)}),
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
pub const SLOTS: [(&str, &str, &str); 5] = [
    ("Default", "defaultModel", "ANTHROPIC_MODEL"),
    ("Fable", "fableModel", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
    ("Opus", "opusModel", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("Sonnet", "sonnetModel", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("Haiku", "haikuModel", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SetupClient {
    Claude,
    Opencode,
}

impl SetupClient {
    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Opencode => "opencode",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Self::Claude => "settings.json",
            Self::Opencode => "opencode.json",
        }
    }
}

pub struct ModelDescription {
    pub id: String,
    opencode: V,
}

/// Describe the operator model projection, including the serving auth of pins.
pub fn describe_models(models: &[V], credentials: &[V]) -> Result<Vec<ModelDescription>, String> {
    models
        .iter()
        .map(|model| {
            let opencode = describe(model, credentials)?;
            let id = match get(model, "id").expect("model id") {
                V::Null => String::new(),
                id => crate::cli_cell::scalar_string(id),
            };
            Ok(ModelDescription { id, opencode })
        })
        .collect()
}

/// Build the reader's JSON response. The caller authenticates before running
/// this operation; no input or store lookup can supply a live key to it.
pub fn agent_setup(store: &SqliteStore, base_url: &str, query: &str) -> Result<String, Failure> {
    let mut client = SetupClient::Claude;
    let mut mapping = SLOTS.map(|_| String::new());
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if key == "client" {
            client = if value == "opencode" {
                SetupClient::Opencode
            } else {
                SetupClient::Claude
            };
        } else if let Some(index) = SLOTS.iter().position(|(_, name, _)| key == *name) {
            mapping[index] = value.into_owned();
        }
    }
    if mapping[0].is_empty() {
        return Err(Failure::bad(format!(
            "defaultModel is required for {} setup",
            client.name()
        )));
    }

    let models = crate::models::list(store).map_err(Failure::bad)?;
    let credentials = crate::credentials::setup_rows(store).map_err(|e| Failure::bad(e.message))?;
    let described = describe_models(&models, &credentials).map_err(Failure::bad)?;
    let contents =
        render(client, &described, base_url, &mapping, None, None).map_err(Failure::bad)?;
    Ok(to_string(&serde_json::json!({
        "client": client.name(),
        "files": [{"path": client.path(), "contents": contents}],
    })))
}

/// Render one setup file. Only the CLI may supply a key or existing settings.
pub fn render(
    client: SetupClient,
    described: &[ModelDescription],
    base: &str,
    mapping: &[String; SLOTS.len()],
    key: Option<&str>,
    existing: Option<&str>,
) -> Result<String, String> {
    if mapping[0].is_empty() {
        return Err("default model is required".into());
    }
    let claude = client == SetupClient::Claude;
    let key = key.unwrap_or(KEY_PLACEHOLDER);
    let mut config = object();
    if claude && let Some(existing) = existing {
        config = operator_json::parse(existing)
            .map_err(|e| format!("cannot parse existing settings.json: {e}"))?;
        if !matches!(config, V::Object(_)) {
            return Err(
                "cannot parse existing settings.json: settings root is not an object".into(),
            );
        }
    }
    let selected = mapping
        .iter()
        .zip(SLOTS)
        .filter(|(id, _)| !id.is_empty())
        .map(|(id, (_, slot, env_key))| {
            let model = described
                .iter()
                .find(|model| model.id == *id)
                .ok_or_else(|| format!("{slot} names unknown virtual model \"{id}\""))?;
            Ok((model, env_key))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if claude {
        let mut env = get(&config, "env")
            .filter(|v| matches!(v, V::Object(_)))
            .cloned()
            .unwrap_or_else(object);
        for (_, _, key) in SLOTS {
            remove(&mut env, key);
        }
        remove(&mut env, "CLAUDE_CODE_MAX_CONTEXT_TOKENS");
        set(&mut env, "ANTHROPIC_BASE_URL", text(base));
        set(&mut env, "ANTHROPIC_AUTH_TOKEN", text(key));
        set(
            &mut env,
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
            text("1"),
        );
        for (model, env_key) in selected {
            set(&mut env, env_key, text(&model.id));
        }
        set(&mut config, "env", env);
    } else {
        let mut models = object();
        for (model, _) in selected {
            if model.id == "__proto__" || get(&models, &model.id).is_some() {
                continue;
            }
            set(&mut models, &model.id, model.opencode.clone());
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
                set(&mut p[0].1, "models", models);
            }
        }
    }
    Ok(format!("{}\n", stringify_pretty(&config).expect("object")))
}

fn describe(model: &V, credentials: &[V]) -> Result<V, String> {
    let mut result = object();
    let mut label = get(model, "id").expect("id").clone();
    let mut context: Option<f64> = None;
    let mut output: Option<f64> = None;
    // JSON strings are iterable. Their character targets have no model fields,
    // so neither limits nor a catalog label is selected by the frozen consumer.
    let targets = match get(model, "targets").ok_or("missing targets")? {
        V::Array(targets) => targets.as_slice(),
        V::String(_) => &[],
        V::Null => {
            return Err("null is not an object (evaluating 'target of model.targets')".into());
        }
        V::Number(_) => return Err("number is not iterable".into()),
        V::Bool(_) => return Err("boolean is not iterable".into()),
        _ => return Err("{} is not iterable".into()),
    };
    for t in targets {
        if matches!(t, V::Null) {
            return Err("null is not an object (evaluating 'target.provider')".into());
        }
        let provider = get(t, "provider").map(string).unwrap_or_default();
        let choice = crate::catalog::rows(Some(&provider))
            .into_iter()
            .map(|(_, v)| v)
            .find(|v| get(v, "id") == get(t, "model"));
        if targets.len() == 1
            && let Some(v) = choice.and_then(|v| get(v, "label"))
        {
            label = v.clone();
        }
        let rows = credentials
            .iter()
            .filter(|c| {
                get(c, "provider") == Some(&text(&provider))
                    && get(c, "enabled") == Some(&V::Bool(true))
            })
            .map(|c| {
                (
                    string(get(c, "id").expect("credential id")),
                    string(get(c, "authType").expect("auth type")),
                    get(c, "providerData").expect("provider data"),
                )
            })
            .collect::<Vec<_>>();
        let pin = rows.iter().find(|(id, _, data)| {
            get(t, "credentialId") == Some(&text(id)) && serves_pin(t, id, &provider, data)
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
