//! Shared test helpers.

#![allow(dead_code)]

pub mod pg;
pub mod proxy;

pub const ENCRYPTION_KEY: &str = "omni-store-test-key-0123456789";

/// Numbers as f64 and object keys sorted, so a Rust `1.0` and a JS `1` compare
/// equal the way `JSON.stringify` would print them.
pub fn canon(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Number(n) => serde_json::Number::from_f64(n.as_f64().expect("finite"))
            .map_or(Value::Null, Value::Number),
        Value::Array(items) => Value::Array(items.iter().map(canon).collect()),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().map(|(k, v)| (k.clone(), canon(v))).collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(entries.into_iter().collect())
        }
        other => other.clone(),
    }
}
