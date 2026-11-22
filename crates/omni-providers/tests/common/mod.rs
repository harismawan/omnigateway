//! Shared test helpers.
#![allow(dead_code)]

use bytes::Bytes;
use serde_json::Value;

/// Rebuilds a test chunk: a string, `{bytes}`, `{repeat,count}` or `{concat}`.
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
