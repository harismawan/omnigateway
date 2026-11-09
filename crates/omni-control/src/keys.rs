//! Operator key summaries.
use omni_store::{SqliteStore, StoreError};
use serde_json::{Value, json};

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
    if !omni_store::keys::list_operator(store.connection())
        .map_err(|e| e.to_string())?
        .iter()
        .any(|k| k.key.id == id)
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
