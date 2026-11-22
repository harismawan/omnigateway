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
    sv::write(store, &parse_patch(raw)?, raw)
}

pub(crate) fn parse_patch(raw: &JsValue) -> Result<Value, String> {
    let defaults = omni_store::settings::default_settings_json();
    let mut input = Map::new();
    // Schema order matters: do not prevalidate later fields before earlier ones.
    for key in defaults.as_object().expect("defaults").keys() {
        if let Some(v) = sv::get(raw, key) {
            let v = if let (true, JsValue::Object(fields)) = (key == "weights", v) {
                // One level, shallowly: a weight is validated as a number, and
                // any other member only needs its name (an unrecognized key).
                Value::Object(
                    fields
                        .iter()
                        .map(|(k, v)| (String::from_utf16_lossy(k), sv::shallow(v)))
                        .collect(),
                )
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
                crate::body_schema::received(Some(raw))
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
            let weights = match sv::get(raw, "weights") {
                Some(JsValue::Object(_)) => v.as_object().cloned().unwrap_or_default(),
                other => {
                    return Err(error(
                        key,
                        format!(
                            "Invalid input: expected object, received {}",
                            crate::body_schema::received(other)
                        ),
                    ));
                }
            };
            let raw_weights = sv::get(raw, "weights");
            for k in ["tier", "health", "quota", "cost", "latency", "load"] {
                let w = raw_weights.and_then(|r| sv::get(r, k));
                if !matches!(w, Some(JsValue::Number(n)) if n.is_finite()) {
                    return Err(error(
                        &format!("weights.{k}"),
                        format!(
                            "Invalid input: expected number, received {}",
                            crate::body_schema::received(w)
                        ),
                    ));
                }
            }
            if let Some(k) = omni_ir::jsjson::own_entries(&weights)
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
                    format!(
                        "Invalid input: expected boolean, received {}",
                        crate::body_schema::received(sv::get(raw, key))
                    ),
                ));
            }
        } else if !(default.is_null() && matches!(sv::get(raw, key), Some(JsValue::Null))) {
            let s = v.as_str().ok_or_else(|| {
                error(
                    key,
                    format!(
                        "Invalid input: expected string, received {}",
                        crate::body_schema::received(sv::get(raw, key))
                    ),
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
            // zod 4.6 measures `max` in code points.
            if s.chars().count() > max {
                return Err(error(
                    key,
                    format!("Too big: expected string to have <={max} characters"),
                ));
            }
            v = Value::String(s.into());
        }
        patch.insert(key.clone(), v);
    }
    Ok(Value::Object(patch))
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

    #[test]
    fn an_older_client_sending_ponytail_mode_still_saves_and_the_key_is_gone() {
        let store = SqliteStore::open(":memory:", 0).expect("store");
        omni_store::settings::write_operator_raw(
            store.connection(),
            r#"{"ponytailMode":"lite","extra":1}"#,
        )
        .expect("seed");
        let mut input = get(&store).expect("read");
        sv::set(
            &mut input,
            "ponytailMode",
            JsValue::from(&serde_json::json!("ultra")),
        );
        sv::set(&mut input, "maxAttempts", JsValue::Number(5.0));
        let saved = put(&store, &input).expect("save");
        assert_eq!(sv::get(&saved, "maxAttempts"), Some(&JsValue::Number(5.0)));
        assert_eq!(sv::get(&saved, "ponytailMode"), None);
        assert_eq!(sv::get(&saved, "extra"), Some(&JsValue::Number(1.0)));
        let raw = omni_store::settings::operator_raw(store.connection())
            .expect("row")
            .expect("written");
        assert!(!raw.contains("ponytailMode"), "{raw}");
        assert_eq!(sv::get(&get(&store).expect("read"), "ponytailMode"), None);
    }
}
