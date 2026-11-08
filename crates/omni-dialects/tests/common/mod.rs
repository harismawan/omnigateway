//! Shared helpers for the dialect vector suites.
#![allow(dead_code)]

use std::sync::OnceLock;

use omni_ir::error::ErrorCode;
use omni_ir::jsjson;
use omni_ir::stream::{ContentBlockStart, Delta, NativeFold, StopReason, StreamEvent, Usage};
use serde_json::{Map, Value};

/// `conformance/vectors/dialects.json`, parsed once per test binary.
pub fn vectors() -> &'static Value {
    static V: OnceLock<Value> = OnceLock::new();
    V.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/vectors/dialects.json"
        );
        let text = std::fs::read_to_string(path).expect("dialects.json is committed");
        serde_json::from_str(&text).expect("dialects.json parses")
    })
}

pub fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}

fn f(v: &Value) -> f64 {
    v.as_f64().expect("number")
}

fn u(v: &Value) -> u32 {
    u32::try_from(v.as_u64().expect("index")).expect("u32")
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().expect("object").clone()
}

pub fn usage(v: &Value) -> Usage {
    Usage {
        input_tokens: f(&v["inputTokens"]),
        output_tokens: f(&v["outputTokens"]),
        cache_read_tokens: f(&v["cacheReadTokens"]),
        cache_write_tokens: f(&v["cacheWriteTokens"]),
        cache_write_5m_tokens: v.get("cacheWrite5mTokens").map(f),
        cache_write_1h_tokens: v.get("cacheWrite1hTokens").map(f),
    }
}

fn stop(v: &Value) -> StopReason {
    match s(v) {
        "endTurn" => StopReason::EndTurn,
        "maxTokens" => StopReason::MaxTokens,
        "toolUse" => StopReason::ToolUse,
        "stopSequence" => StopReason::StopSequence,
        "contentFilter" => StopReason::ContentFilter,
        "pauseTurn" => StopReason::PauseTurn,
        other => panic!("stop reason {other}"),
    }
}

/// Rebuilds one IR event from its TS JSON shape.
pub fn event(v: &Value) -> StreamEvent {
    match s(&v["type"]) {
        "start" => StreamEvent::Start {
            id: s(&v["id"]).into(),
            model: s(&v["model"]).into(),
        },
        "blockStart" => {
            let b = &v["block"];
            let block = match s(&b["type"]) {
                "text" => ContentBlockStart::Text,
                "thinking" => ContentBlockStart::Thinking {
                    signed: b.get("signed").map(|x| x.as_bool().expect("bool")),
                },
                "toolUse" => ContentBlockStart::ToolUse {
                    id: s(&b["id"]).into(),
                    name: s(&b["name"]).into(),
                },
                "providerNative" => ContentBlockStart::ProviderNative {
                    provider: s(&b["provider"]).into(),
                    block_type: s(&b["blockType"]).into(),
                    data: obj(&b["data"]),
                },
                other => panic!("block {other}"),
            };
            StreamEvent::BlockStart {
                index: u(&v["index"]),
                block,
            }
        }
        "blockDelta" => {
            let d = &v["delta"];
            let delta = match s(&d["type"]) {
                "text" => Delta::Text {
                    text: s(&d["text"]).into(),
                },
                "thinking" => Delta::Thinking {
                    text: s(&d["text"]).into(),
                },
                "thinkingSignature" => Delta::ThinkingSignature {
                    signature: s(&d["signature"]).into(),
                },
                "toolJson" => Delta::ToolJson {
                    partial: s(&d["partial"]).into(),
                },
                "providerNativeJson" => Delta::ProviderNativeJson {
                    provider: s(&d["provider"]).into(),
                    partial: s(&d["partial"]).into(),
                },
                "providerNative" => Delta::ProviderNative {
                    provider: s(&d["provider"]).into(),
                    delta_type: s(&d["deltaType"]).into(),
                    fold: d.get("fold").map(|x| match s(x) {
                        "merge" => NativeFold::Merge,
                        "citation" => NativeFold::Citation,
                        other => panic!("fold {other}"),
                    }),
                    data: obj(&d["data"]),
                },
                other => panic!("delta {other}"),
            };
            StreamEvent::BlockDelta {
                index: u(&v["index"]),
                delta,
            }
        }
        "blockEnd" => StreamEvent::BlockEnd {
            index: u(&v["index"]),
        },
        "end" => StreamEvent::End {
            stop_reason: stop(&v["stopReason"]),
            usage: usage(&v["usage"]),
            vendor: v.get("vendor").map(obj),
        },
        "error" => StreamEvent::Error {
            code: ErrorCode::parse(s(&v["code"])).expect("code"),
            message: s(&v["message"]).into(),
            retryable: v["retryable"].as_bool().expect("bool"),
        },
        other => panic!("event {other}"),
    }
}

pub fn events(v: &Value) -> Vec<StreamEvent> {
    v.as_array().expect("events").iter().map(event).collect()
}

/// Keys whose values are client or upstream payloads carried verbatim: there
/// the key order is part of what the gateway sends, so it is compared as the
/// bytes `JSON.stringify` would write.
const OPAQUE: &[&str] = &[
    "vendor",
    "providerHeaders",
    "data",
    "wire",
    "input",
    "inputSchema",
    "options",
    "citations",
];

/// IR equality: struct-shaped objects compare by key set (Rust writes struct
/// fields in declaration order, TS in construction order, and nothing sends
/// the IR itself anywhere), numbers by value, and opaque payloads by their
/// `JSON.stringify` bytes.
pub fn same_ir(actual: &Value, expected: &Value, path: &str) -> Result<(), String> {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().expect("f64"), b.as_f64().expect("f64"));
            if a.to_bits() == b.to_bits() {
                Ok(())
            } else {
                Err(format!("{path}: {a} != {b}"))
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Err(format!("{path}: length {} != {}", a.len(), b.len()));
            }
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                same_ir(x, y, &format!("{path}.{i}"))?;
            }
            Ok(())
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut ak: Vec<&String> = a.keys().collect();
            let mut bk: Vec<&String> = b.keys().collect();
            ak.sort();
            bk.sort();
            if ak != bk {
                return Err(format!("{path}: keys {ak:?} != {bk:?}"));
            }
            for (k, y) in b {
                let x = &a[k];
                let p = format!("{path}.{k}");
                if OPAQUE.contains(&k.as_str()) {
                    let (xs, ys) = (jsjson::to_string(x), jsjson::to_string(y));
                    if xs != ys {
                        return Err(format!("{p}: {xs} != {ys}"));
                    }
                } else {
                    same_ir(x, y, &p)?;
                }
            }
            Ok(())
        }
        (a, b) if a == b => Ok(()),
        (a, b) => Err(format!("{path}: {a} != {b}")),
    }
}
