use omni_control::settings_value as sv;
use omni_ir::{
    js,
    jsjson::{self, JsValue},
};
use serde_json::{Value, json};
use std::collections::HashMap;

fn text(v: &JsValue) -> Result<String, (u8, String)> {
    omni_control::operator_json::string(v).map_err(|e| (1, e))
}
pub fn run(
    command: &str,
    flags: &HashMap<String, String>,
    args: &[String],
) -> Result<String, (u8, String)> {
    let set = command == "settings-set";
    if set {
        for (i, name) in ["setting path", "value"].iter().enumerate() {
            if args.get(i).is_none_or(String::is_empty) {
                return Err((2, format!("{name} is required")));
            }
        }
    }
    let store = crate::context::open(flags).map_err(|e| (1, e))?;
    let mut current = omni_control::settings::get(&store).map_err(|e| (1, e))?;
    let mut human = String::new();
    if set {
        let path = &args[0];
        let raw = &args[1];
        let mut parts = path.split('.');
        let head = parts.next().expect("head");
        let tail = parts.next();
        if sv::get(&current, head).is_none() {
            return Err((2, format!("no setting \"{path}\"")));
        }
        if tail.is_some() && head != "weights" {
            return Err((2, format!("\"{head}\" has no sub-settings")));
        }
        let existing = if let Some(tail) = tail {
            sv::get(sv::get(&current, head).expect("head"), tail)
        } else {
            sv::get(&current, head)
        };
        let trimmed = js::trim(raw);
        let nullable = tail.is_none()
            && omni_store::settings::default_settings_json()
                .get(head)
                .is_some_and(Value::is_null);
        let value = if nullable && trimmed == "null" {
            Value::Null
        } else if nullable || matches!(existing, Some(JsValue::String(_))) {
            if trimmed.is_empty() {
                return Err((2, format!("{path} must not be blank")));
            }
            Value::String(trimmed.into())
        } else if matches!(existing, Some(JsValue::Bool(_))) {
            match trimmed.to_lowercase().as_str() {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => return Err((2, format!("{path} must be true or false, got \"{raw}\""))),
            }
        } else {
            let n = js::string_to_number(raw);
            if trimmed.is_empty() || !n.is_finite() {
                return Err((2, format!("{path} must be a number, got \"{raw}\"")));
            }
            json!(n)
        };
        let value = JsValue::from(&value);
        human = format!("{path} = {}", text(&value)?);
        if let Some(tail) = tail {
            let mut weights = sv::get(&current, "weights").expect("weights").clone();
            sv::set(&mut weights, tail, value);
            sv::set(&mut current, "weights", weights);
        } else {
            sv::set(&mut current, head, value);
        }
        current = omni_control::settings::put(&store, &current).map_err(|e| (1, e))?;
    }
    if flags.contains_key("json") {
        return Ok(jsjson::stringify_pretty(&JsValue::Object(vec![(
            "settings".encode_utf16().collect(),
            current,
        )]))
        .expect("settings"));
    }
    if set {
        return Ok(human);
    }
    let mut rows = Vec::new();
    for (k, v) in entries(&current) {
        if matches!(v, JsValue::Object(_)) {
            for (inner, value) in entries(v) {
                rows.push((format!("{k}.{inner}"), text(value)?));
            }
        } else if let JsValue::Array(a) = v {
            for (i, value) in a.iter().enumerate() {
                rows.push((format!("{k}.{i}"), text(value)?));
            }
        } else {
            rows.push((k.to_owned(), text(v)?));
        }
    }
    let width = rows
        .iter()
        .map(|(k, _)| js::utf16_len(k))
        .max()
        .unwrap_or(0);
    Ok(rows
        .into_iter()
        .map(|(k, v)| format!("{k}{}  {v}", " ".repeat(width - js::utf16_len(&k))))
        .collect::<Vec<_>>()
        .join("\n"))
}

fn entries(value: &JsValue) -> Vec<(String, &JsValue)> {
    let JsValue::Object(fields) = value else {
        return vec![];
    };
    let mut entries: Vec<_> = fields
        .iter()
        .map(|(k, v)| (String::from_utf16_lossy(k), v))
        .collect();
    entries.sort_by_key(|(k, _)| {
        k.parse::<u32>()
            .ok()
            .filter(|n| *n != u32::MAX && n.to_string() == *k)
            .map_or((1, 0), |n| (0, n))
    });
    entries
}
