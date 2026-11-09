//! Operator key summaries.
use omni_store::{SqliteStore, StoreError};
use serde_json::{Value, json};

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
pub fn list_keys(store: &SqliteStore, now: i64) -> Result<Value, StoreError> {
    let mut keys = Vec::new();
    for key in store.list_api_keys()? {
        let limits = key.limits.as_ref().map_or(Value::Null, |l| l.to_json());
        let mut usage = Vec::new();
        scope_usage(store, &key.id, &limits, None, now, &mut usage)?;
        if let Some(models) = limits["models"].as_object() {
            for (model, scope) in models {
                scope_usage(store, &key.id, scope, Some(model), now, &mut usage)?;
            }
        }
        keys.push(json!({"id":key.id,"label":key.label,"prefix":key.prefix,"modelAllowlist":key.model_allowlist,"limits":limits,"limitUsage":usage,"bodyLoggingOptOut":key.body_logging_opt_out,"createdAt":key.created_at,"revokedAt":key.revoked_at,"expiresAt":key.expires_at,"guardrailPolicy":key.guardrail_policy,"smartRouting":key.smart_routing}));
    }
    Ok(json!({"keys":keys}))
}
