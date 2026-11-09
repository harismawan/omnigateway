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
//! - every field read is a `Value`, absent kept apart from `null` ([`present`]),
//!   so `d.id !== undefined` and friends see what they would;
//! - syntax, the depth limit and lone surrogates fail exactly where the
//!   generic parse's first attempt fails, and then go generic.

use std::marker::PhantomData;

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor, value::MapAccessDeserializer};
use serde_json::Value;

use super::chat::{ChoiceView, ChunkView, DeltaView};

/// `Some(value)` for a present field, `null` included; `None` only when absent.
/// Boxed: a `Value` is large, and serde moves each field through several
/// layers of `Result`; a pointer keeps those moves small.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Box<Value>>, D::Error> {
    Value::deserialize(d).map(|v| Some(Box::new(v)))
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
    #[serde(default, deserialize_with = "present")]
    id: Option<Box<Value>>,
    #[serde(default, deserialize_with = "present")]
    model: Option<Box<Value>>,
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
    #[serde(default, deserialize_with = "present")]
    finish_reason: Option<Box<Value>>,
}

#[derive(serde::Deserialize)]
struct FastDelta {
    #[serde(default, deserialize_with = "present")]
    content: Option<Box<Value>>,
    #[serde(default, deserialize_with = "present")]
    reasoning: Option<Box<Value>>,
    #[serde(default, deserialize_with = "present")]
    reasoning_content: Option<Box<Value>>,
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
                        content: d.content.as_deref(),
                        reasoning: d.reasoning.as_deref(),
                        reasoning_content: d.reasoning_content.as_deref(),
                        reasoning_details: d.reasoning_details.as_deref(),
                        tool_calls: d.tool_calls.as_deref(),
                    },
                },
                finish_reason: c.finish_reason.as_deref(),
            });
        ChunkView {
            id: self.id.as_deref(),
            model: self.model.as_deref(),
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

    /// Rebuilds an exported chunk (`Chunk` in `conformance/vectors/custom.ts`).
    fn chunk_bytes(chunk: &serde_json::Value) -> Vec<u8> {
        use serde_json::Value;
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
                let count = usize::try_from(m["count"].as_u64().expect("count")).expect("count");
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

    /// The whole body through `SseParser` and the decoder as the adapter
    /// drives them (stop on `Flow::Stop` or an error, `finish` at end of
    /// body), in `pieces` of the given size (0: as exported): every event,
    /// every flow, and the error, rendered.
    fn decode_body(body: &[Vec<u8>], pieces: usize, fast: bool) -> String {
        use crate::codec::{DecodeError, Flow};
        use crate::sse::SseParser;
        let chunks: Vec<Vec<u8>> = if pieces == 0 {
            body.to_vec()
        } else {
            body.concat().chunks(pieces).map(<[u8]>::to_vec).collect()
        };
        let mut d = ChatDecoder::new();
        d.no_fast = !fast;
        let mut parser = SseParser::new();
        let mut out = VecDeque::new();
        let mut trace = Vec::new();
        let mut feed = |msgs: &[SseMessage], out: &mut VecDeque<_>, trace: &mut Vec<String>| {
            for m in msgs {
                let r = d.message(m, out);
                trace.push(format!("{r:?}"));
                match r {
                    Ok(Flow::Continue) => {}
                    Ok(Flow::Stop) | Err(DecodeError::Gateway(_) | DecodeError::Throw(_)) => {
                        return true;
                    }
                }
            }
            false
        };
        for c in &chunks {
            let mut msgs = Vec::new();
            let parsed = parser.push(c, &mut msgs);
            if feed(&msgs, &mut out, &mut trace) {
                return format!("{out:?} {trace:?}");
            }
            if let Err(e) = parsed {
                trace.push(format!("parse error {e:?}"));
                return format!("{out:?} {trace:?}");
            }
        }
        let last: Vec<SseMessage> = parser.finish().into_iter().collect();
        if !feed(&last, &mut out, &mut trace) {
            d.finish(&mut out);
        }
        format!("{out:?} {trace:?}")
    }

    /// Every `chat_completions` decode vector the TS exporter wrote (the
    /// corpus `decode_vectors_match_the_ts_custom_adapter` holds Rust to),
    /// decoded with the fast path and with it forced off, whole and re-cut
    /// into pieces of 1, 7, 64 and 4096 bytes: the same events, flows and
    /// errors every time.
    #[test]
    fn the_fast_path_agrees_with_the_generic_one_on_every_decode_vector() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/vectors/vectors.json"
        );
        let text = std::fs::read_to_string(path).expect("vectors.json is committed");
        let v: serde_json::Value = serde_json::from_str(&text).expect("vectors.json parses");
        let cases = v["custom"]["decode"].as_array().expect("decode");
        let mut checked = 0;
        let mut fast_messages = 0;
        for case in cases {
            if case["protocol"] != "chat_completions" {
                continue;
            }
            let name = case["name"].as_str().expect("name");
            let body: Vec<Vec<u8>> = case["response"]["chunks"]
                .as_array()
                .expect("chunks")
                .iter()
                .map(chunk_bytes)
                .collect();
            for pieces in [0, 1, 7, 64, 4096] {
                let fast = decode_body(&body, pieces, true);
                let generic = decode_body(&body, pieces, false);
                assert_eq!(fast, generic, "{name}, pieces of {pieces}");
            }
            // How many of its messages the fast path actually answers.
            let mut parser = crate::sse::SseParser::new();
            let mut msgs = Vec::new();
            parser.push(&body.concat(), &mut msgs).ok();
            fast_messages += msgs
                .iter()
                .filter(|m| super::parse_chat_chunk(&m.data).is_some())
                .count();
            checked += 1;
        }
        assert!(checked >= 70, "{checked} chat_completions vectors");
        assert!(
            fast_messages >= 70,
            "the fast path answered only {fast_messages} messages"
        );
    }

    #[test]
    fn the_benchmark_chunk_takes_the_fast_path() {
        let chunk = r#"{"id":"a","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"lorem ipsum "}}]}"#;
        assert!(super::parse_chat_chunk(chunk).is_some());
        assert!(super::parse_chat_chunk(r#"["a"]"#).is_none());
        assert!(super::parse_chat_chunk(r#"{"id":"a","id":"b"}"#).is_none());
    }
}
