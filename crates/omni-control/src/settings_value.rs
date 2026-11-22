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
    set_units(v, &key.encode_utf16().collect::<Vec<_>>(), value);
}
fn set_units(v: &mut JsValue, key: &[u16], value: JsValue) {
    if let JsValue::Object(fields) = v {
        if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k == key) {
            *old = value;
        } else {
            fields.push((key.to_vec(), value));
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
    let raw = omni_store::settings::operator_raw(store.connection()).map_err(|e| e.to_string())?;
    Ok(decode(raw.as_deref()))
}

pub(crate) fn decode(raw: Option<&str>) -> JsValue {
    use omni_store::settings::{default_settings_json, settings_json};
    let defaults = JsValue::from(&default_settings_json());
    let Some(raw) = raw else { return defaults };
    let Ok(stored) = crate::operator_json::parse(raw) else {
        return defaults;
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
        // `ponytailMode` is a retired setting (removed in 1.x): a row written
        // before then still holds it, so it alone is dropped here, keeping it
        // out of every read and of the next write. Other unknown keys are
        // copied back out as before.
        for (k, v) in fields
            .iter()
            .filter(|(k, _)| !k.iter().copied().eq("ponytailMode".encode_utf16()))
        {
            set_units(&mut out, k, v.clone());
        }
    }
    for key in [
        "weights",
        "rtkEnabled",
        "autoCacheEnabled",
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
        let value = match get(&stored, key) {
            Some(JsValue::String(units))
                if matches!(
                    key,
                    "guardrailModel" | "smartRouterClassifierModel" | "smartRouterLocalModel"
                ) && !trim_units(units).is_empty() =>
            {
                JsValue::String(units.clone())
            }
            Some(JsValue::String(units))
                if key == "smartRouterPolicy"
                    && !trim_units(units).is_empty()
                    && trim_units(units).len() <= 4000 =>
            {
                JsValue::String(trim_units(units).to_vec())
            }
            _ => JsValue::from(&normalized[key]),
        };
        set(&mut out, key, value);
    }
    out
}
pub fn write(store: &SqliteStore, patch: &Value, original: &JsValue) -> Result<JsValue, String> {
    // Read again after validation, then merge the patch.
    let next = merge(read(store)?, patch, original);
    let raw = jsjson::stringify(&next).expect("settings");
    omni_store::settings::write_operator_raw(store.connection(), &raw)
        .map_err(|e| e.to_string())?;
    Ok(next)
}

pub(crate) fn merge(mut next: JsValue, patch: &Value, original: &JsValue) -> JsValue {
    for (k, v) in patch.as_object().expect("validated patch") {
        if k == "weights" {
            let mut weights = get(&next, k).expect("weights").clone();
            for (k, v) in v.as_object().expect("weights patch") {
                set(&mut weights, k, JsValue::from(v));
            }
            set(&mut next, k, weights);
        } else {
            let value = match get(original, k) {
                Some(JsValue::String(units)) if v.is_string() => {
                    JsValue::String(trim_units(units).to_vec())
                }
                _ => JsValue::from(v),
            };
            set(&mut next, k, value);
        }
    }
    next
}

pub fn trim_units(mut units: &[u16]) -> &[u16] {
    let whitespace = |u: u16| {
        char::from_u32(u32::from(u))
            .is_some_and(|c| omni_ir::js::trim(c.encode_utf8(&mut [0; 4])).is_empty())
    };
    while units.first().is_some_and(|u| whitespace(*u)) {
        units = &units[1..];
    }
    while units.last().is_some_and(|u| whitespace(*u)) {
        units = &units[..units.len() - 1];
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_stored_ponytail_mode_is_stripped_while_other_unknown_keys_are_echoed() {
        let out = decode(Some(r#"{"ponytailMode":"full","extra":7,"maxAttempts":5}"#));
        assert_eq!(get(&out, "ponytailMode"), None);
        assert_eq!(get(&out, "extra"), Some(&JsValue::Number(7.0)));
        assert_eq!(get(&out, "maxAttempts"), Some(&JsValue::Number(5.0)));
        assert_eq!(get(&decode(None), "ponytailMode"), None);
    }
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
