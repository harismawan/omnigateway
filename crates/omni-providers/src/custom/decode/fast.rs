//! A typed parse of the ordinary Chat Completions chunk, for the decoder's
//! hot path.
//!
//! The generic path builds a whole `serde_json::Value` per chunk (an
//! `IndexMap` per object, every key hashed and copied, `object`, `created`
//! and `index` included) and then reads five fields back. This reads those
//! fields straight off the text and skips the rest.
//!
//! **It only ever answers for chunks where its answer is the generic one.**
//! Anything it is not sure of returns `None`, and the caller takes the
//! generic path, so the decoder's output never depends on which path ran:
//! - the text must be a JSON object, and `choices` (when present and not
//!   null) an array of objects whose `delta` is an object or null — no
//!   positional (array-as-struct) reading anywhere ([`MapOnly`]);
//! - a repeated field is a serde error, so `JSON.parse`'s last-wins case
//!   goes generic;
//! - absent fields are kept apart from `null` ([`present`], [`scalar`]), so
//!   `d.id !== undefined` and friends see what they would;
//! - syntax, the depth limit and lone surrogates fail exactly where the
//!   generic parse's first attempt fails, and then go generic.

use std::marker::PhantomData;

use omni_ir::jsjson::JsValue as Value;
use serde::de::{Deserialize, Deserializer, MapAccess, Visitor, value::MapAccessDeserializer};

use super::chat::{ChoiceView, ChunkView, DeltaView, Scalar};

/// `Some(value)` for a present field, `null` included; `None` only when absent.
/// Boxed: a `Value` is large, and serde moves each field through several
/// layers of `Result`; a pointer keeps those moves small.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Box<Value>>, D::Error> {
    serde_json::Value::deserialize(d).map(|v| Some(Box::new(Value::from(&v))))
}

enum FastScalar {
    Utf8(String),
    Js(Box<Value>),
}

impl FastScalar {
    fn view(&self) -> Scalar<'_> {
        match self {
            Self::Utf8(s) => Scalar::Utf8(s),
            Self::Js(v) => Scalar::Js(v),
        }
    }
}

fn scalar<'de, D: Deserializer<'de>>(d: D) -> Result<Option<FastScalar>, D::Error> {
    serde_json::Value::deserialize(d).map(|v| {
        Some(match v {
            serde_json::Value::String(s) => FastScalar::Utf8(s),
            other => FastScalar::Js(Box::new(Value::from(&other))),
        })
    })
}

/// A struct read from a JSON object only: serde's derived structs also
/// accept an array, read positionally, which JS would never do.
struct MapOnly<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for MapOnly<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for V<T> {
            type Value = MapOnly<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(MapOnly)
            }
        }
        d.deserialize_map(V(PhantomData))
    }
}

#[derive(serde::Deserialize)]
pub(super) struct FastChunk {
    #[serde(default, deserialize_with = "scalar")]
    id: Option<FastScalar>,
    #[serde(default, deserialize_with = "scalar")]
    model: Option<FastScalar>,
    #[serde(default, deserialize_with = "present")]
    usage: Option<Box<Value>>,
    /// `null` and absent both mean no choice (`index0` of either is undefined).
    #[serde(default)]
    choices: Option<Vec<MapOnly<FastChoice>>>,
}

#[derive(serde::Deserialize)]
struct FastChoice {
    /// `null` and absent read the same: `prop(choice, "delta")` filtered of null.
    #[serde(default)]
    delta: Option<MapOnly<FastDelta>>,
    #[serde(default, deserialize_with = "scalar")]
    finish_reason: Option<FastScalar>,
}

#[derive(serde::Deserialize)]
struct FastDelta {
    #[serde(default, deserialize_with = "scalar")]
    content: Option<FastScalar>,
    #[serde(default, deserialize_with = "scalar")]
    reasoning: Option<FastScalar>,
    #[serde(default, deserialize_with = "scalar")]
    reasoning_content: Option<FastScalar>,
    #[serde(default, deserialize_with = "present")]
    reasoning_details: Option<Box<Value>>,
    #[serde(default, deserialize_with = "present")]
    tool_calls: Option<Box<Value>>,
}

/// The chunk, or `None` for the generic path to decide.
pub(super) fn parse_chat_chunk(data: &str) -> Option<FastChunk> {
    // Only an object: a top-level array would be read positionally.
    let first = data
        .bytes()
        .find(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r'))?;
    if first != b'{' {
        return None;
    }
    serde_json::from_str(data).ok()
}

impl FastChunk {
    pub(super) fn view(&self) -> ChunkView<'_> {
        let choice = self
            .choices
            .as_ref()
            .and_then(|c| c.first())
            .map(|MapOnly(c)| ChoiceView {
                delta: match &c.delta {
                    None => DeltaView::default(),
                    Some(MapOnly(d)) => DeltaView {
                        content: d.content.as_ref().map(FastScalar::view),
                        reasoning: d.reasoning.as_ref().map(FastScalar::view),
                        reasoning_content: d.reasoning_content.as_ref().map(FastScalar::view),
                        reasoning_details: d.reasoning_details.as_deref(),
                        tool_calls: d.tool_calls.as_deref(),
                    },
                },
                finish_reason: c.finish_reason.as_ref().map(FastScalar::view),
            });
        ChunkView {
            id: self.id.as_ref().map(FastScalar::view),
            model: self.model.as_ref().map(FastScalar::view),
            usage: self.usage.as_deref(),
            choice,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::super::ChatDecoder;
    use crate::codec::StreamDecoder;
    use crate::sse::SseMessage;

    /// Every chunk decoded twice, once with the fast path and once with it
    /// forced off, must give the same events and flow.
    fn both(chunks: &[&str]) -> (String, String) {
        let run = |fast: bool| {
            let mut d = ChatDecoder::new();
            d.no_fast = !fast;
            let mut out = VecDeque::new();
            let mut flows = Vec::new();
            for c in chunks {
                let msg = SseMessage {
                    event: "message".into(),
                    data: (*c).to_string(),
                };
                flows.push(format!("{:?}", d.message(&msg, &mut out)));
            }
            format!("{out:?} {flows:?}")
        };
        (run(true), run(false))
    }

    #[test]
    fn deep_unknown_and_usage_fields_match_general_policy() {
        for bound in [200, 512, 40_000, 40_001] {
            for field in ["usage", "ignored"] {
                let nested = format!("{}0{}", "[".repeat(bound - 2), "]".repeat(bound - 2));
                let chunk = format!(
                    r#"{{"choices":[{{"delta":{{"content":"hello"}}}}],"{field}":{{"extra":{nested}}}}}"#
                );
                let (fast, general) = both(&[&chunk, "[DONE]"]);
                assert_eq!(fast, general, "{bound} {field}");
            }
        }
    }

    #[test]
    fn the_fast_path_agrees_with_the_generic_one() {
        let cases: &[&[&str]] = &[
            &[
                r#"{"id":"a","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#,
                r#"{"id":"a","model":"m","choices":[{"index":0,"delta":{"content":"lorem ipsum "}}]}"#,
                r#"{"id":"a","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
                r#"{"id":"a","model":"m","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":4,"total_tokens":68}}"#,
                "[DONE]",
            ],
            // Null id still starts; absent ids do not.
            &[r#"{"id":null,"choices":[{"delta":{"content":"x"}}]}"#],
            &[
                r#"{"choices":[{"delta":{"content":"x"}}]}"#,
                r#"{"model":"m"}"#,
            ],
            // Arrays where objects are expected: read positionally by serde, not by JS.
            &[r#"["a","m",null,[{"delta":{"content":"x"}}]]"#],
            &[r#"{"id":"a","choices":[[{"content":"x"},"stop"]]}"#],
            &[r#"{"id":"a","choices":[{"delta":[{"content":"x"}]}]}"#],
            &[r#"{"id":"a","choices":{"0":{"delta":{"content":"x"}}}}"#],
            &[r#"{"id":"a","choices":"x"}"#],
            &[r#"{"id":"a","choices":[5]}"#],
            &[r#"{"id":"a","choices":[null,{"delta":{"content":"x"}}]}"#],
            &[r#"{"id":"a","choices":[{"delta":null,"finish_reason":"length"}]}"#],
            &[r#"{"id":"a","choices":[{"delta":"str","finish_reason":"weird"}]}"#],
            // Duplicate keys: JSON.parse keeps the last.
            &[r#"{"id":"a","choices":[{"delta":{"content":"x","content":"y"}}]}"#],
            &[r#"{"id":"a","id":"b","choices":[]}"#],
            // Escaped key names, lone surrogates, bad syntax, trailing text.
            &[r#"{"\u0069d":"a","choices":[{"delta":{"c\u006fntent":"x"}}]}"#],
            &[r#"{"id":"a","choices":[{"delta":{"content":"水\ud83d\ude00"}}]}"#],
            &[r#"{"id":"a","x":"\ud800","choices":[{"delta":{"content":"\udc00y"}}]}"#],
            &[r#"{"id":"a","choices":[{"delta":{"content":"x"}}]"#],
            &[r#"{"id":"a"} x"#],
            &[r#" {"id":1,"model":{"a":1},"choices":[{"delta":{"content":5}}]}"#],
            // Reasoning spellings and tool calls.
            &[
                r#"{"id":"a","choices":[{"delta":{"reasoning":"","reasoning_content":"r","reasoning_details":[{"text":"t"}]}}]}"#,
                r#"{"id":"a","choices":[{"delta":{"reasoning_details":[{"summary":"s"},{"text":"t"}]}}]}"#,
                r#"{"id":"a","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"{"}}]}}]}"#,
                r#"{"id":"a","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}"#,
                r#"{"id":"a","choices":[{"delta":{"tool_calls":"ab"}}]}"#,
                r#"{"id":"a","choices":[{"delta":{"tool_calls":[null]}}]}"#,
            ],
            &[r#"{"id":"a","choices":[{"delta":{"tool_calls":7}}]}"#],
            &[
                r#"{"usage":{"prompt_tokens":"9","prompt_tokens_details":{"cached_tokens":2}}}"#,
                "[DONE]",
            ],
            &[r#"{"usage":null,"choices":null}"#, "[DONE]"],
        ];
        for chunks in cases {
            let (fast, generic) = both(chunks);
            assert_eq!(fast, generic, "{chunks:?}");
        }
    }

    #[test]
    fn shadow_and_overflow_path_selection() {
        assert!(super::parse_chat_chunk(r#"{"id":{"toString":null}}"#).is_some());
        assert!(super::parse_chat_chunk(r#"{"id":"keep","ignored":1e309}"#).is_some());
        assert!(super::parse_chat_chunk(r#"{"id":1e309}"#).is_none());
    }

    #[test]
    fn the_benchmark_chunk_takes_the_fast_path() {
        let chunk = r#"{"id":"a","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"lorem ipsum "}}]}"#;
        assert!(super::parse_chat_chunk(chunk).is_some());
        assert!(super::parse_chat_chunk(r#"["a"]"#).is_none());
        assert!(super::parse_chat_chunk(r#"{"id":"a","id":"b"}"#).is_none());
    }
}
