//! Custom's stream decoders (`packages/providers/src/custom/decode.ts`).
//!
//! The TS decoders read payloads typed `unknown` and lean on JS coercion:
//! `String(x)`, `x ?? d`, truthiness, `for…of` over whatever arrived, `Map` /
//! `Set` keys compared by SameValueZero, and template-string keys. Each is
//! reproduced through [`omni_ir::js`], so a sloppy upstream decodes the same.
//! One stated divergence: usage counts are coerced with `Number()`, where TS
//! would carry a non-numeric `completion_tokens` through as-is.

use omni_ir::js;
use omni_ir::stream::{Usage, usage_from_prompt_total};
use serde_json::Value;

use crate::codec::DecodeThrow;

mod chat;
mod responses;

pub use chat::ChatDecoder;
pub use responses::ResponsesDecoder;

/// A JS `Map`/`Set` key under SameValueZero. Objects and arrays parsed from
/// JSON are distinct identities, so each gets a key no other value equals.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) enum JsKey {
    /// The f64 bits, with `-0` folded into `0`.
    Number(u64),
    String(String),
    Bool(bool),
    Null,
    Unique(u64),
}

#[derive(Debug, Default)]
pub(super) struct KeyMint(u64);

impl KeyMint {
    pub(super) fn key(&mut self, v: &Value) -> JsKey {
        match v {
            Value::Number(n) => {
                let f = js::number_value(n);
                JsKey::Number(if f == 0.0 { 0 } else { f.to_bits() })
            }
            Value::String(s) => JsKey::String(s.clone()),
            Value::Bool(b) => JsKey::Bool(*b),
            Value::Null => JsKey::Null,
            Value::Array(_) | Value::Object(_) => {
                self.0 += 1;
                JsKey::Unique(self.0)
            }
        }
    }
}

/// `x ?? 0` as a value, for keys and template strings.
pub(super) fn or_zero(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::from(0),
        Some(v) => v.clone(),
    }
}

/// `JSON.parse` that keeps only what `typeof v === "object" && v !== null` keeps.
pub(super) fn json_object(data: &str) -> Option<Value> {
    js::parse_json(data).filter(|v| v.is_object() || v.is_array())
}

/// `x?.[0]`.
pub(super) fn index0(v: Option<&Value>) -> Option<Value> {
    match v? {
        Value::Array(items) => items.first().cloned(),
        Value::Object(map) => map.get("0").cloned(),
        Value::String(s) => s
            .encode_utf16()
            .next()
            .map(|u| Value::String(String::from_utf16_lossy(&[u]))),
        _ => None,
    }
}

/// `for (const x of v ?? [])`: what iterating each JSON value yields, or a
/// throw for a value that is not iterable.
pub(super) fn iterate(v: Option<&Value>) -> Result<Vec<Value>, DecodeThrow> {
    match v {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(s)) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        Some(_) => Err(DecodeThrow("tool_calls is not iterable")),
    }
}

/// A non-empty string, or `None` (`typeof x === "string" && x.length > 0`).
pub(super) fn nonempty(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `usageFromPromptTotal` over raw JSON counts, coerced as JS arithmetic does.
pub(super) fn usage_of(
    prompt: Option<&Value>,
    output: Option<&Value>,
    read: Option<&Value>,
    write: Option<&Value>,
) -> Usage {
    let n = |v: Option<&Value>| js::to_number(Some(&or_zero(v)));
    usage_from_prompt_total(n(prompt), n(output), n(read), n(write))
}
