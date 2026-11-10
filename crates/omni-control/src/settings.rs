//! Operator settings validation; gateway read normalization remains in the store.
use crate::settings_value as sv;
use omni_ir::jsjson::JsValue;
use omni_store::SqliteStore;
use serde_json::{Map, Value};

pub fn get(store: &SqliteStore) -> Result<JsValue, String> {
    sv::read(store)
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        Value::Number(_) => "number",
    }
}
fn error(path: &str, message: impl std::fmt::Display) -> String {
    format!("BAD_REQUEST: {path}: {message}")
}
pub fn put(store: &SqliteStore, raw: &JsValue) -> Result<JsValue, String> {
    let defaults = omni_store::settings::default_settings_json();
    let mut input = Map::new();
    // Schema order matters: do not prevalidate later fields before earlier ones.
    for key in defaults.as_object().expect("defaults").keys() {
        if let Some(v) = sv::get(raw, key) {
            let v = if key == "weights" {
                // Store normalization guarantees six finite primitive weights.
                serde_json::from_str(&omni_ir::jsjson::stringify(v).expect("weights"))
                    .unwrap_or(Value::Null)
            } else {
                sv::shallow(v)
            };
            input.insert(key.clone(), v);
        }
    }
    let input = Value::Object(input);
    if !matches!(raw, JsValue::Object(_)) {
        return Err(error(
            "(root)",
            format!(
                "Invalid input: expected object, received {}",
                kind(&sv::shallow(raw))
            ),
        ));
    }
    let defaults = omni_store::settings::default_settings_json();
    let mut patch = Map::new();
    for (key, default) in defaults.as_object().expect("defaults") {
        if input.get(key).is_none() {
            if matches!(
                key.as_str(),
                "bodyRetentionDays"
                    | "snapshotKeepLatest"
                    | "snapshotMaxAgeDays"
                    | "guardrailModel"
                    | "guardrailTimeoutMs"
                    | "guardrailHistoryTurns"
                    | "smartRouterEnabled"
                    | "smartRouterClassifierModel"
                    | "smartRouterLocalModel"
                    | "smartRouterPolicy"
                    | "smartRouterTimeoutMs"
            ) {
                continue;
            }
            let expected = if key == "weights" {
                "object"
            } else if default.is_number() {
                "number"
            } else if default.is_boolean() {
                "boolean"
            } else {
                "string"
            };
            return Err(error(
                key,
                format!("Invalid input: expected {expected}, received undefined"),
            ));
        }
        let v = input.get(key).unwrap_or(&Value::Null);
        let mut v = v.clone();
        if key == "weights" {
            let weights = v.as_object().ok_or_else(|| {
                error(
                    key,
                    format!("Invalid input: expected object, received {}", kind(&v)),
                )
            })?;
            for k in ["tier", "health", "quota", "cost", "latency", "load"] {
                let w = weights.get(k).unwrap_or(&Value::Null);
                if !w.is_number() {
                    return Err(error(
                        &format!("weights.{k}"),
                        format!("Invalid input: expected number, received {}", kind(w)),
                    ));
                }
            }
            if let Some(k) = omni_ir::jsjson::own_entries(weights)
                .into_iter()
                .map(|(k, _)| k)
                .find(|k| {
                    !["tier", "health", "quota", "cost", "latency", "load"].contains(&k.as_str())
                })
            {
                return Err(error(
                    key,
                    format!("unrecognized key \"{}\"", crate::keys::safe_token(k)),
                ));
            }
        } else if default.is_number() {
            let n = v.as_f64().ok_or_else(|| {
                error(
                    key,
                    format!(
                        "Invalid input: expected number, received {}",
                        match sv::get(raw, key) {
                            Some(JsValue::Number(n)) if n.is_infinite() =>
                                if n.is_sign_negative() {
                                    "-Infinity"
                                } else {
                                    "Infinity"
                                },
                            _ => kind(&v),
                        }
                    ),
                )
            })?;
            if n.fract() != 0.0 {
                return Err(error(key, "Invalid input: expected int, received number"));
            }
            if n.abs() > 9007199254740991.0 {
                return Err(error(
                    key,
                    if n > 0.0 {
                        "Too big: expected int to be <=9007199254740991"
                    } else {
                        "Too small: expected int to be >=-9007199254740991"
                    },
                ));
            }
            let min = if matches!(key.as_str(), "requestDeadlineMs" | "quotaPollIntervalMs") {
                0.0
            } else {
                1.0
            };
            if n < min {
                return Err(error(
                    key,
                    if key == "breakerCooldownMs" {
                        "Too small: expected number to be >0".into()
                    } else {
                        format!("Too small: expected number to be >={min}")
                    },
                ));
            }
            let max = match key.as_str() {
                "maxAttempts" | "guardrailHistoryTurns" => 10.0,
                "bodyRetentionDays" | "snapshotMaxAgeDays" => 3650.0,
                "snapshotKeepLatest" => 100.0,
                "guardrailTimeoutMs" | "smartRouterTimeoutMs" => 60000.0,
                _ => f64::INFINITY,
            };
            if n > max {
                return Err(error(
                    key,
                    format!("Too big: expected number to be <={max}"),
                ));
            }
        } else if default.is_boolean() {
            if !v.is_boolean() {
                return Err(error(
                    key,
                    format!("Invalid input: expected boolean, received {}", kind(&v)),
                ));
            }
        } else if key == "ponytailMode" {
            if !v
                .as_str()
                .is_some_and(|s| ["off", "lite", "full", "ultra"].contains(&s))
            {
                return Err(error(
                    key,
                    "Invalid option: expected one of \"off\"|\"lite\"|\"full\"|\"ultra\"",
                ));
            }
        } else if !(default.is_null() && v.is_null()) {
            let s = v.as_str().ok_or_else(|| {
                error(
                    key,
                    format!("Invalid input: expected string, received {}", kind(&v)),
                )
            })?;
            let s = omni_ir::js::trim(s);
            let max = if key == "smartRouterPolicy" {
                4000
            } else {
                256
            };
            if s.is_empty() {
                return Err(error(
                    key,
                    "Too small: expected string to have >=1 characters",
                ));
            }
            if omni_ir::js::utf16_len(s) > max {
                return Err(error(
                    key,
                    format!("Too big: expected string to have <={max} characters"),
                ));
            }
            v = Value::String(s.into());
        }
        patch.insert(key.clone(), v);
    }
    sv::write(store, &Value::Object(patch), raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_before_write_and_normalizes_saved_strings() {
        let store = SqliteStore::open(":memory:", 0).expect("store");
        let mut input = get(&store).expect("defaults");
        sv::set(&mut input, "maxAttempts", JsValue::Number(0.0));
        assert!(put(&store, &input).is_err());
        let rows: i64 = store
            .connection()
            .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
            .expect("rows");
        assert_eq!(rows, 0);
        sv::set(&mut input, "maxAttempts", JsValue::Number(3.0));
        sv::set(
            &mut input,
            "guardrailModel",
            JsValue::from(&serde_json::json!("  model  ")),
        );
        let saved = put(&store, &input).expect("save");
        assert_eq!(
            sv::get(&saved, "guardrailModel"),
            Some(&JsValue::from(&serde_json::json!("model")))
        );
        assert_eq!(get(&store).expect("read"), saved);
    }
}
