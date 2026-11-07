//! Shared helpers for the vector-driven suites.
#![allow(dead_code)]

use std::sync::OnceLock;

use bytes::Bytes;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// `conformance/vectors/vectors.json`, parsed once per test binary.
pub fn vectors() -> &'static Value {
    static V: OnceLock<Value> = OnceLock::new();
    V.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/vectors/vectors.json"
        );
        let text = std::fs::read_to_string(path).expect("vectors.json is committed");
        serde_json::from_str(&text).expect("vectors.json parses")
    })
}

/// Rebuilds one exported chunk (see `Chunk` in `conformance/vectors/custom.ts`).
pub fn chunk_bytes(chunk: &Value) -> Vec<u8> {
    match chunk {
        Value::String(s) => s.as_bytes().to_vec(),
        Value::Object(m) if m.contains_key("bytes") => m["bytes"]
            .as_array()
            .expect("bytes")
            .iter()
            .map(|b| u8::try_from(b.as_u64().expect("byte")).expect("u8"))
            .collect(),
        Value::Object(m) if m.contains_key("repeat") => {
            let unit = m["repeat"].as_str().expect("repeat");
            let count = usize::try_from(m["count"].as_u64().expect("count")).expect("usize");
            unit.repeat(count).into_bytes()
        }
        Value::Object(m) if m.contains_key("concat") => m["concat"]
            .as_array()
            .expect("concat")
            .iter()
            .flat_map(chunk_bytes)
            .collect(),
        other => panic!("unknown chunk {other}"),
    }
}

pub fn chunks(value: &Value) -> Vec<Bytes> {
    value
        .as_array()
        .expect("chunks")
        .iter()
        .map(|c| Bytes::from(chunk_bytes(c)))
        .collect()
}

/// Undoes the exporter's `{"$utf16": [...]}` wrapping of strings holding a
/// lone surrogate. A Rust `String` cannot hold one, so the expected value is
/// what the TS string becomes when encoded lossily: each lone half is U+FFFD.
pub fn normalize(value: &Value) -> Value {
    match value {
        Value::Object(m) if m.len() == 1 && m.contains_key("$utf16") => {
            let units: Vec<u16> = m["$utf16"]
                .as_array()
                .expect("units")
                .iter()
                .map(|u| u16::try_from(u.as_u64().expect("unit")).expect("u16"))
                .collect();
            Value::String(String::from_utf16_lossy(&units))
        }
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), normalize(v)))
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        other => other.clone(),
    }
}

/// The exporter's `describeData`: short data verbatim, long data summarised.
pub fn describe_data(data: &str) -> Value {
    let units = omni_ir::js::utf16_len(data);
    if units <= 2000 {
        return Value::String(data.to_string());
    }
    let digest = Sha256::digest(data.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    serde_json::json!({ "length": units, "sha256": hex })
}

/// The exporter's `describeError` for a `GatewayError`.
pub fn describe_error(e: &omni_ir::error::GatewayError) -> Value {
    serde_json::json!({
        "gatewayError": true,
        "code": e.code.as_str(),
        "message": e.message,
        "retryable": e.retryable,
        "provider": e.provider,
        "upstreamStatus": e.upstream_status,
        "gatewayAuthored": e.gateway_authored,
        "retryAfterMs": e.retry_after_ms.map(omni_ir::stream::number),
        "degradations": e.degradations,
    })
}

/// Compares two JSON values treating numbers by value (`5` and `5.0` agree).
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        // By key: these are structured results, not wire bytes (wire bodies
        // are compared as strings, byte for byte).
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}
