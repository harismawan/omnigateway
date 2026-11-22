//! Custom's stream decoders (`packages/providers/src/custom/decode.ts`).
//!
//! The TS decoders read payloads typed `unknown` and lean on JS coercion:
//! `String(x)`, `x ?? d`, truthiness, `for…of` over whatever arrived, `Map` /
//! `Set` keys compared by SameValueZero, and template-string keys. Each is
//! reproduced through [`omni_ir::js`], so a sloppy upstream decodes the same.
//! One stated divergence: usage counts are coerced with `Number()`, where TS
//! would carry a non-numeric `completion_tokens` through as-is.

use omni_ir::jsjson::{self, JsValue as Value};
use omni_ir::stream::{Usage, usage_from_prompt_total};
use omni_ir::text::Text;

use crate::codec::DecodeError;

mod chat;
mod fast;
mod responses;

pub use chat::ChatDecoder;
pub use responses::ResponsesDecoder;

#[derive(Debug, Default)]
pub(super) struct IdentityBudget {
    entries: usize,
    bytes: usize,
}
impl IdentityBudget {
    pub(super) fn remove(&mut self, bytes: usize) {
        self.entries -= 1;
        self.bytes -= bytes;
    }
    pub(super) fn add(&mut self, bytes: usize) -> Result<(), DecodeError> {
        if self.entries == 4096 || bytes > 1024 * 1024 - self.bytes {
            return Err(DecodeError::Gateway(omni_ir::error::GatewayError::new(
                omni_ir::error::ErrorCode::Upstream,
                "upstream decoder identity budget exceeded",
            )));
        }
        self.entries += 1;
        self.bytes += bytes;
        Ok(())
    }
}

impl JsKey {
    pub(super) fn bytes(&self) -> usize {
        if let Self::String(s) = self {
            s.len()
        } else {
            0
        }
    }
}

/// Container depth across argument fragments, including split string escapes.
/// The same lexical policy as deep::depth_of; syntax remains the collector's
/// concern, preserving malformed-input fallback below the ceiling.
#[derive(Debug, Default)]
pub(super) struct ArgumentDepth {
    depth: usize,
    quoted: bool,
    escaped: bool,
}

impl ArgumentDepth {
    pub(super) fn push(&mut self, text: &Text) -> Result<(), DecodeError> {
        // Only ASCII punctuation matters to this depth scanner.
        let text = text.to_utf8_lossy();
        for b in text.bytes() {
            if self.quoted {
                if self.escaped {
                    self.escaped = false;
                } else if b == b'\\' {
                    self.escaped = true;
                } else if b == b'"' {
                    self.quoted = false;
                }
            } else {
                match b {
                    b'"' => self.quoted = true,
                    b'[' | b'{' => {
                        self.depth += 1;
                        if self.depth > omni_ir::deep::MAX_DEPTH {
                            return Err(DecodeError::Gateway(omni_ir::error::GatewayError::new(
                                omni_ir::error::ErrorCode::Upstream,
                                "tool arguments exceed JSON depth 40000",
                            )));
                        }
                    }
                    b']' | b'}' => self.depth = self.depth.saturating_sub(1),
                    _ => {}
                }
            }
        }
        Ok(())
    }
}

/// A JS `Map`/`Set` key under SameValueZero. Objects and arrays parsed from
/// JSON are distinct identities, so each gets a key no other value equals.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) enum JsKey {
    /// The f64 bits, with `-0` folded into `0`.
    Number(u64),
    String(Text),
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
                let f = *n;
                JsKey::Number(if f == 0.0 { 0 } else { f.to_bits() })
            }
            Value::String(s) => JsKey::String(Text::from_utf16(s.clone())),
            Value::Bool(b) => JsKey::Bool(*b),
            Value::Null => JsKey::Null,
            _ => {
                self.0 += 1;
                JsKey::Unique(self.0)
            }
        }
    }
}

/// `x ?? 0` as a value, for keys and template strings.
pub(super) fn or_zero(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::from(0.0),
        Some(v) => v.clone(),
    }
}

/// `JSON.parse` that keeps only what `typeof v === "object" && v !== null` keeps.
pub(super) fn json_object(data: &str) -> Option<Value> {
    jsjson::parse_js(data)
        .ok()
        .filter(|v| v.is_object() || v.is_array())
}

/// `x?.[0]`.
pub(super) fn index0(v: Option<&Value>) -> Option<Value> {
    match v? {
        Value::Array(items) => items.first().cloned(),
        v @ Value::Object(_) => v.get("0").cloned(),
        Value::String(s) => s.first().map(|u| Value::String(vec![*u])),
        _ => None,
    }
}

/// `for (const x of v ?? [])`: what iterating each JSON value yields, or a
/// throw for a value that is not iterable.
pub(super) fn iterate(v: Option<&Value>) -> Result<Vec<Value>, DecodeError> {
    match v {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(s)) => Ok(char::decode_utf16(s.iter().copied())
            .map(|v| match v {
                Ok(ch) => Value::String(ch.encode_utf16(&mut [0; 2]).to_vec()),
                Err(unit) => Value::String(vec![unit.unpaired_surrogate()]),
            })
            .collect()),
        Some(_) => Err(DecodeError::Throw("tool_calls is not iterable")),
    }
}

/// A non-empty string, or `None` (`typeof x === "string" && x.length > 0`).
pub(super) fn nonempty(v: Option<&Value>) -> Option<Text> {
    v.and_then(Value::as_text).filter(|s| !s.is_empty())
}

fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v.and_then(|v| v.get(key))
}
fn nullish_or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    a.filter(|v| !v.is_null()).or(b)
}
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null | Value::Undefined | Value::Bool(false)) => false,
        Some(Value::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

/// `usageFromPromptTotal` over raw JSON counts, coerced as JS arithmetic does.
pub(super) fn usage_of(
    prompt: Option<&Value>,
    output: Option<&Value>,
    read: Option<&Value>,
    write: Option<&Value>,
) -> Result<Usage, DecodeError> {
    let n = |v: Option<&Value>| jsjson::coerce_number(Some(&or_zero(v))).unwrap_or(f64::NAN);
    let checked =
        |v| jsjson::coerce_number(v).map_err(|_| DecodeError::Throw("JavaScript coercion threw"));
    let zero = Value::from(0.0);
    let p = checked(nullish_or(prompt, Some(&zero)))?;
    let r = checked(nullish_or(read, Some(&zero)))?;
    let w = checked(nullish_or(write, Some(&zero)))?;
    Ok(usage_from_prompt_total(p, n(output), r, w))
}

fn string(v: Option<&Value>) -> Result<Text, DecodeError> {
    jsjson::coerce_text(v).map_err(|_| DecodeError::Throw("JavaScript coercion threw"))
}
