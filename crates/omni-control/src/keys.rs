//! Operator key summaries.
use omni_store::{SqliteStore, StoreError};
use serde_json::{Value, json};

pub struct CreateKey {
    pub label: String,
    pub models: Option<Vec<String>>,
    pub limits: Value,
    pub no_bodies: bool,
    pub expiry: Option<i64>,
    pub policy: Option<String>,
    pub smart: bool,
}
pub fn create_key(store: &SqliteStore, input: CreateKey, now: i64) -> Result<Value, String> {
    if input.label.is_empty() {
        return Err("BAD_REQUEST: label: Too small: expected string to have >=1 characters".into());
    }
    if let Some(i) = input
        .models
        .as_ref()
        .and_then(|v| v.iter().position(String::is_empty))
    {
        return Err(format!(
            "BAD_REQUEST: modelAllowlist.{i}: Too small: expected string to have >=1 characters"
        ));
    }
    validate_limits(&input.limits, "limits", true)?;
    if input.expiry.is_some_and(|v| v <= 0) {
        return Err("BAD_REQUEST: expiresAt: Too small: expected number to be >0".into());
    }
    let policy = input.policy.as_deref().map(omni_ir::js::trim);
    if let Some(p) = policy {
        if p.is_empty() {
            return Err(
                "BAD_REQUEST: guardrailPolicy: Too small: expected string to have >=1 characters"
                    .into(),
            );
        }
        if p.chars().count() > 4000 {
            return Err(
                "BAD_REQUEST: guardrailPolicy: Too big: expected string to have <=4000 characters"
                    .into(),
            );
        }
    }
    let raw = omni_crypto::apikey::generate();
    // Independent CSPRNG material for the public UUID; never derived from the key.
    let id = omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate());
    let prefix = omni_crypto::apikey::prefix(&raw);
    let limits = omni_store::limits::parse_limits(&input.limits.to_string())
        .ok_or("BAD_REQUEST: invalid limits")?;
    let key = omni_store::keys::ApiKey {
        id: id.clone(),
        label: input.label.clone(),
        prefix: prefix.clone(),
        hash: omni_crypto::apikey::hash(&raw),
        model_allowlist: input.models,
        limits: Some(limits),
        body_logging_opt_out: input.no_bodies,
        created_at: now,
        revoked_at: None,
        expires_at: input.expiry,
        guardrail_policy: policy.map(str::to_owned),
        smart_routing: input.smart,
    };
    omni_store::keys::create(store.connection(), &key).map_err(|e| e.to_string())?;
    Ok(json!({"id":id,"label":input.label,"prefix":prefix,"key":raw}))
}

pub fn set_limits(store: &SqliteStore, id: &str, limits: &Value) -> Result<(), String> {
    validate_limits(limits, "limits", true)?;
    require_key(store, id)?;
    let config = omni_store::limits::parse_limits(&limits.to_string())
        .ok_or("BAD_REQUEST: invalid limits")?;
    let raw = omni_ir::jsjson::stringify(&omni_ir::jsjson::JsValue::from(&config.to_json()))
        .expect("limits JSON");
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Limits(&raw),
    )
    .map_err(|e| e.to_string())
}

pub fn validate_limits(v: &Value, path: &str, root: bool) -> Result<(), String> {
    let err = |p: &str, message: String| format!("BAD_REQUEST: {p}: {message}");
    let object = v.as_object().ok_or_else(|| {
        err(
            path,
            "Invalid input: expected object, received number".into(),
        )
    })?;
    for d in ["requests", "tokens", "spend", "concurrency"] {
        let Some(value) = object.get(d) else { continue };
        let p = format!("{path}.{d}");
        let check = |v: &Value, p: &str| -> Result<(), String> {
            if v.is_null() {
                return Ok(());
            }
            let n = v
                .as_f64()
                .ok_or_else(|| err(p, "Invalid input: expected number, received object".into()))?;
            if d != "spend" && n.fract() != 0.0 {
                return Err(err(
                    p,
                    "Invalid input: expected int, received number".into(),
                ));
            }
            if d != "spend" && n > 9007199254740991.0 {
                return Err(err(
                    p,
                    "Too big: expected int to be <=9007199254740991".into(),
                ));
            }
            if n <= 0.0 {
                return Err(err(p, "Too small: expected number to be >0".into()));
            }
            Ok(())
        };
        if d == "concurrency" {
            check(value, &p)?;
        } else {
            let windows = value
                .as_object()
                .ok_or_else(|| err(&p, "Invalid input: expected object, received number".into()))?;
            for w in ["1m", "5h", "1w"] {
                if d == "spend" && w == "1m" {
                    continue;
                }
                if let Some(n) = windows.get(w) {
                    check(n, &format!("{p}.{w}"))?;
                }
            }
            let unknown: Vec<_> = windows
                .keys()
                .filter(|w| !matches!(w.as_str(), "1m" | "5h" | "1w") || d == "spend" && *w == "1m")
                .collect();
            if !unknown.is_empty() {
                return Err(err(&p, unknown_keys(&unknown)));
            }
        }
    }
    if root && let Some(models) = object.get("models").and_then(Value::as_object) {
        for (model, scope) in omni_ir::jsjson::own_entries(models) {
            if model.is_empty() || model.chars().count() > 256 {
                return Err(err(
                    &format!("{path}.models.{model}"),
                    "Invalid key in record".into(),
                ));
            }
            validate_limits(scope, &format!("{path}.models.{model}"), false)?;
        }
        if models.len() > 64 {
            return Err(err(
                &format!("{path}.models"),
                "at most 64 model overrides per key".into(),
            ));
        }
    }
    let unknown: Vec<_> = object
        .keys()
        .filter(|k| {
            !matches!(k.as_str(), "requests" | "tokens" | "spend" | "concurrency")
                && !(root && *k == "models")
        })
        .collect();
    if !unknown.is_empty() {
        return Err(err(path, unknown_keys(&unknown)));
    }
    Ok(())
}
fn unknown_keys(keys: &[&String]) -> String {
    format!("unrecognized key \"{}\"", safe_token(keys[0]))
}
fn safe_token(s: &str) -> &str {
    if !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:/+-".contains(&b))
    {
        s
    } else {
        "(unprintable)"
    }
}

pub fn set_expiry(store: &SqliteStore, id: &str, expiry: Option<i64>) -> Result<(), String> {
    if expiry.is_some_and(|v| v <= 0) {
        return Err("BAD_REQUEST: expiresAt: Too small: expected number to be >0".into());
    }
    if expiry.is_some_and(|v| v > 8_640_000_000_000_000) {
        return Err(
            "BAD_REQUEST: expiresAt: Too big: expected number to be <=8640000000000000".into(),
        );
    }
    require_key(store, id)?;
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Expiry(expiry),
    )
    .map_err(|e| e.to_string())
}

pub fn set_models(store: &SqliteStore, id: &str, models: Option<&[String]>) -> Result<(), String> {
    if let Some(i) = models.and_then(|m| m.iter().position(String::is_empty)) {
        return Err(format!(
            "BAD_REQUEST: modelAllowlist.{i}: Too small: expected string to have >=1 characters"
        ));
    }
    let json = models.map(|m| serde_json::to_string(m).expect("strings"));
    require_key(store, id)?;
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Models(json.as_deref()),
    )
    .map_err(|e| e.to_string())
}

pub fn set_guardrail(store: &SqliteStore, id: &str, policy: Option<&str>) -> Result<(), String> {
    let policy = policy.map(omni_ir::js::trim);
    if let Some(p) = policy {
        // Frozen Zod counts Unicode code points for string size checks.
        let length = p.chars().count();
        if length == 0 {
            return Err(
                "BAD_REQUEST: policy: Too small: expected string to have >=1 characters".into(),
            );
        }
        if length > 4000 {
            return Err(
                "BAD_REQUEST: policy: Too big: expected string to have <=4000 characters".into(),
            );
        }
    }
    require_key(store, id)?;
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Guardrail(policy),
    )
    .map_err(|e| e.to_string())
}

fn require_key(store: &SqliteStore, id: &str) -> Result<(), String> {
    if omni_store::keys::get_operator(store.connection(), id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err("BAD_REQUEST: no such api key".into());
    }
    Ok(())
}

pub fn set_smart_routing(store: &SqliteStore, id: &str, enabled: bool) -> Result<(), String> {
    require_key(store, id)?;
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::SmartRouting(enabled),
    )
    .map_err(|e| e.to_string())
}

pub fn revoke(store: &SqliteStore, id: &str, now: i64) -> Result<(), String> {
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Revoke(now),
    )
    .map_err(|e| e.to_string())
}

fn scope_usage(
    store: &SqliteStore,
    id: &str,
    scope: &Value,
    model: Option<&str>,
    now: i64,
    out: &mut Vec<Value>,
) -> Result<(), StoreError> {
    let mut sums = std::collections::HashMap::new();
    for dimension in ["requests", "tokens", "spend"] {
        for (window, ms) in [("1m", 60_000), ("5h", 18_000_000), ("1w", 604_800_000)] {
            let limit = &scope[dimension][window];
            if limit.is_null() {
                continue;
            }
            if !sums.contains_key(window) {
                sums.insert(
                    window,
                    omni_store::usage::sum_since(store.connection(), id, now - ms, model)?,
                );
            }
            let sum = &sums[window];
            let used = match dimension {
                "requests" => sum.requests,
                "tokens" => sum.tokens,
                _ => sum.cost_usd,
            };
            out.push(json!({"dimension":dimension,"window":window,"limit":limit,"used":used,"model":model}));
        }
    }
    if !scope["concurrency"].is_null() {
        out.push(json!({"dimension":"concurrency","window":null,"limit":scope["concurrency"],"used":null,"model":model}));
    }
    Ok(())
}

/// Explicit public projection: never serialize the stored hash.
pub struct KeyListing {
    pub data: Value,
    pub allowlists: Vec<omni_ir::jsjson::JsValue>,
}

impl KeyListing {
    pub fn one_json(&self, index: usize) -> String {
        use omni_ir::jsjson::{JsValue, stringify_pretty};
        let mut data = JsValue::from(&self.data["keys"][index]);
        if let JsValue::Object(fields) = &mut data {
            for (name, value) in fields {
                if name.iter().copied().eq("modelAllowlist".encode_utf16()) {
                    *value = self.allowlists[index].clone();
                }
            }
        }
        stringify_pretty(&data).unwrap_or_default()
    }
    pub fn json(&self) -> String {
        use omni_ir::jsjson::{JsValue, stringify_pretty};
        let mut data = JsValue::from(&self.data);
        if let JsValue::Object(root) = &mut data
            && let JsValue::Array(keys) = &mut root[0].1
        {
            for (key, allowlist) in keys.iter_mut().zip(&self.allowlists) {
                if let JsValue::Object(fields) = key
                    && let Some((_, v)) = fields
                        .iter_mut()
                        .find(|(k, _)| k.iter().copied().eq("modelAllowlist".encode_utf16()))
                {
                    *v = allowlist.clone();
                }
            }
        }
        stringify_pretty(&data).unwrap_or_default()
    }
}

pub fn list_keys(store: &SqliteStore, now: i64) -> Result<KeyListing, String> {
    let mut keys = Vec::new();
    let mut allowlists = Vec::new();
    for omni_store::keys::OperatorKey {
        key,
        allowlist_json: raw,
        created_at,
        expires_at,
    } in omni_store::keys::list_operator(store.connection()).map_err(|e| e.to_string())?
    {
        allowlists.push(match raw {
            None => omni_ir::jsjson::JsValue::Null,
            Some(raw) => crate::operator_json::parse(&raw)?,
        });
        let allowlist = Value::Null;
        let limits = key.limits.as_ref().map_or(Value::Null, |l| l.to_json());
        let mut usage = Vec::new();
        scope_usage(store, &key.id, &limits, None, now, &mut usage).map_err(|e| e.to_string())?;
        if let Some(models) = limits["models"].as_object() {
            for (model, scope) in omni_ir::jsjson::own_entries(models) {
                scope_usage(store, &key.id, scope, Some(model), now, &mut usage)
                    .map_err(|e| e.to_string())?;
            }
        }
        keys.push(json!({"id":key.id,"label":key.label,"prefix":key.prefix,"modelAllowlist":allowlist,"limits":limits,"limitUsage":usage,"bodyLoggingOptOut":key.body_logging_opt_out,"createdAt":created_at,"revokedAt":key.revoked_at,"expiresAt":expires_at,"guardrailPolicy":key.guardrail_policy,"smartRouting":key.smart_routing}));
    }
    Ok(KeyListing {
        data: json!({"keys":keys}),
        allowlists,
    })
}
