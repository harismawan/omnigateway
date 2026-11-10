//! Operator-only settings values. Never pass stored containers through serde.
use omni_ir::jsjson::{self, JsValue};
use omni_store::SqliteStore;
use serde_json::{Value, json};

pub fn get<'a>(v: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    if let JsValue::Object(fields) = v {
        fields
            .iter()
            .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
            .map(|(_, v)| v)
    } else {
        None
    }
}
pub fn set(v: &mut JsValue, key: &str, value: JsValue) {
    if let JsValue::Object(fields) = v {
        if let Some((_, old)) = fields
            .iter_mut()
            .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
        {
            *old = value;
        } else {
            fields.push((key.encode_utf16().collect(), value));
        }
    }
}
/// Only type and primitive value are needed by the schema. Container children
/// are deliberately not converted, cloned, or recursively dropped by serde.
pub fn shallow(v: &JsValue) -> Value {
    match v {
        JsValue::Bool(b) => json!(b),
        JsValue::Number(n) => json!(n),
        JsValue::String(s) => json!(String::from_utf16_lossy(s)),
        JsValue::Array(_) => json!([]),
        JsValue::Object(_) => json!({}),
        _ => Value::Null,
    }
}
pub fn read(store: &SqliteStore) -> Result<JsValue, String> {
    use omni_store::settings::{default_settings_json, settings_json};
    let raw = omni_store::settings::operator_raw(store.connection()).map_err(|e| e.to_string())?;
    let defaults = JsValue::from(&default_settings_json());
    let Some(raw) = raw else { return Ok(defaults) };
    let Ok(stored) = crate::operator_json::parse(&raw) else {
        return Ok(defaults);
    };
    let mut projection = serde_json::Map::new();
    if let JsValue::Object(fields) = &stored {
        for (k, v) in fields {
            let key = String::from_utf16_lossy(k);
            if default_settings_json().get(&key).is_some() {
                let value = if key == "weights" {
                    let mut weights = serde_json::Map::new();
                    for k in ["tier", "health", "quota", "load", "cost", "latency"] {
                        if let Some(v) = get(v, k) {
                            weights.insert(k.into(), shallow(v));
                        }
                    }
                    Value::Object(weights)
                } else {
                    shallow(v)
                };
                projection.insert(key, value);
            }
        }
    }
    let normalized = settings_json(Some(&Value::Object(projection).to_string()));
    let mut out = defaults;
    if let JsValue::Object(fields) = &stored {
        for (k, v) in fields {
            set(&mut out, &String::from_utf16_lossy(k), v.clone());
        }
    }
    for key in [
        "weights",
        "rtkEnabled",
        "autoCacheEnabled",
        "ponytailMode",
        "bodyRetentionDays",
        "bodyLoggingEnabled",
        "bodyLoggingCaptureStreamChunks",
        "guardrailModel",
        "guardrailTimeoutMs",
        "guardrailHistoryTurns",
        "smartRouterEnabled",
        "smartRouterClassifierModel",
        "smartRouterLocalModel",
        "smartRouterPolicy",
        "smartRouterTimeoutMs",
    ] {
        set(&mut out, key, JsValue::from(&normalized[key]));
    }
    Ok(out)
}
pub fn write(store: &SqliteStore, patch: &Value) -> Result<JsValue, String> {
    // TS putSettings reads again after validation, then merges the patch.
    let mut next = read(store)?;
    for (k, v) in patch.as_object().expect("validated patch") {
        if k == "weights" {
            let mut weights = get(&next, k).expect("weights").clone();
            for (k, v) in v.as_object().expect("weights patch") {
                set(&mut weights, k, JsValue::from(v));
            }
            set(&mut next, k, weights);
        } else {
            set(&mut next, k, JsValue::from(v));
        }
    }
    let raw = jsjson::stringify(&next).expect("settings");
    omni_store::settings::write_operator_raw(store.connection(), &raw)
        .map_err(|e| e.to_string())?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deep_success_duplicate_and_error_cleanup_on_small_stack() {
        std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                let store = SqliteStore::open(":memory:", 0).expect("store");
                let deep = format!("{}0{}", "[".repeat(20_000), "]".repeat(20_000));
                let raw = format!("{{\"bodyLoggingEnabled\":true,\"extra\":{deep}}}");
                omni_store::settings::write_operator_raw(store.connection(), &raw).expect("seed");
                let mut input = read(&store).expect("read");
                set(&mut input, "rtkEnabled", JsValue::Bool(true));
                let saved = crate::settings::put(&store, &input).expect("save");
                let serialized = jsjson::stringify(&saved).expect("serialize");
                assert!(serialized.contains(&format!("\"extra\":{deep}")));
                assert!(serialized.contains("\"bodyLoggingEnabled\":true"));
                for n in ["1e400", "-1e400"] {
                    let raw = format!("{{\"maxAttempts\":{n},\"extra\":{deep}}}");
                    omni_store::settings::write_operator_raw(store.connection(), &raw)
                        .expect("seed");
                    let input = read(&store).expect("read");
                    assert!(crate::settings::put(&store, &input).is_err());
                    assert_eq!(
                        omni_store::settings::operator_raw(store.connection()).expect("row"),
                        Some(raw)
                    );
                }
                let raw = format!("{{\"extra\":{deep},\"extra\":2}}");
                omni_store::settings::write_operator_raw(store.connection(), &raw).expect("seed");
                assert!(matches!(
                    get(&read(&store).expect("read"), "extra"),
                    Some(JsValue::Number(2.0))
                ));
            })
            .expect("thread")
            .join()
            .expect("safe ownership");
    }
}
