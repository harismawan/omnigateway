//! `decodeChat`: kimi's Chat Completions stream.
//!
//! Blocks are strictly sequential: at most one is open at a time and it
//! closes before the next opens, so an Anthropic-shaped egress can replay the
//! order verbatim. Text arriving after a tool call opens a *second* text
//! block rather than reopening the first. `[DONE]` is the transport-level
//! success marker; a stream that ends without it is an error, and a finish
//! reason this decoder does not know fails visibly rather than reading as a
//! complete reply.
//!
//! The JS-coercion helpers below are kimi's own fork of the chat-decoder
//! vocabulary (`String(x)`, `x ?? d`, truthiness, `for…of`, SameValueZero map
//! keys), per the provider boundary rule.

use std::collections::{HashMap, VecDeque};

use omni_ir::error::ErrorCode;
use omni_ir::jsjson::{self, JsValue as Value};
use omni_ir::stream::{
    ContentBlockStart, Delta, StopReason, StreamEvent, Usage, usage_from_prompt_total,
};
use omni_ir::text::Text;

use crate::codec::{DecodeError, Flow, StreamDecoder};
use crate::sse::SseMessage;

const FINISH: [(&str, StopReason); 4] = [
    ("stop", StopReason::EndTurn),
    ("length", StopReason::MaxTokens),
    ("tool_calls", StopReason::ToolUse),
    ("content_filter", StopReason::ContentFilter),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Open {
    Text,
    Tool,
}

#[derive(Debug, Default)]
pub struct KimiDecoder {
    identity_budget: IdentityBudget,
    started: bool,
    stop_reason: Option<StopReason>,
    usage: Usage,
    tool_index: HashMap<JsKey, u32>,
    argument_depth: HashMap<u32, ArgumentDepth>,
    keys: KeyMint,
    next_index: u32,
    open: Option<(Open, u32)>,
}

impl KimiDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Closes whatever block is open and opens a new one.
    fn open_block(
        &mut self,
        kind: Open,
        block: ContentBlockStart,
        out: &mut VecDeque<StreamEvent>,
    ) -> u32 {
        if let Some((_, i)) = self.open {
            out.push_back(StreamEvent::BlockEnd { index: i });
        }
        let index = self.next_index;
        self.next_index += 1;
        self.open = Some((kind, index));
        out.push_back(StreamEvent::BlockStart { index, block });
        index
    }

    fn apply(&mut self, d: &Value, out: &mut VecDeque<StreamEvent>) -> Result<Flow, DecodeError> {
        let d = Some(d);
        // Not every chunk carries identity — only the first one from a real
        // upstream does. Waiting for one avoids a hollow start event.
        let (id, model) = (prop(d, "id"), prop(d, "model"));
        if !self.started && (id.is_some() || model.is_some()) {
            self.started = true;
            let start_text = |v: Option<&Value>| match v {
                None | Some(Value::Null) => Ok(Text::default()),
                some => string(some),
            };
            out.push_back(StreamEvent::Start {
                id: start_text(id)?,
                model: start_text(model)?,
            });
        }

        let usage = prop(d, "usage");
        if truthy(usage) {
            // `prompt_tokens` is the whole prompt, hits included; the IR wants
            // the miss remainder so pricing does not charge a hit twice.
            let details = prop(usage, "prompt_tokens_details");
            self.usage = usage_of(
                prop(usage, "prompt_tokens"),
                prop(usage, "completion_tokens"),
                nullish_or(
                    prop(details, "cached_tokens"),
                    prop(usage, "prompt_cache_hit_tokens"),
                ),
                nullish_or(
                    prop(details, "cache_creation_tokens"),
                    prop(details, "cache_write_tokens"),
                ),
            )?;
        }

        let choice = index0(prop(d, "choices"));
        if !truthy(choice.as_ref()) {
            return Ok(Flow::Continue);
        }
        let choice = choice.as_ref();
        let delta = prop(choice, "delta").filter(|v| !v.is_null());

        if let Some(content) = nonempty(prop(delta, "content")) {
            let index = match self.open {
                Some((Open::Text, i)) => i,
                _ => self.open_block(Open::Text, ContentBlockStart::Text, out),
            };
            out.push_back(StreamEvent::BlockDelta {
                index,
                delta: Delta::Text { text: content },
            });
        }

        for call in iterate(prop(delta, "tool_calls"))? {
            // Reading a property of `null` throws in JS.
            if call.is_null() {
                return Err(DecodeError::Throw("tool call is null"));
            }
            let call = Some(&call);
            let wire_index = or_zero(prop(call, "index"));
            let key = self.keys.key(&wire_index);
            let function = prop(call, "function");
            let index = match self.tool_index.get(&key) {
                Some(&index) => index,
                None => {
                    self.identity_budget.add(key.bytes())?;
                    // Yield the previous block's end before coercing the next
                    // tool's identity (which may throw).
                    if let Some((_, index)) = self.open.take() {
                        out.push_back(StreamEvent::BlockEnd { index });
                    }
                    let id = match prop(call, "id") {
                        None | Some(Value::Null) => {
                            string(Some(&wire_index))?.surrounded("call_", "")
                        }
                        some => string(some)?,
                    };
                    let name = match prop(function, "name") {
                        None | Some(Value::Null) => Text::default(),
                        some => string(some)?,
                    };
                    let index =
                        self.open_block(Open::Tool, ContentBlockStart::ToolUse { id, name }, out);
                    self.tool_index.insert(key, index);
                    index
                }
            };
            // A fragment for a call closed earlier is still emitted against
            // its own index rather than reopening the block: splitting one
            // JSON document across two blocks would hand the client arguments
            // it cannot parse.
            if let Some(args) = nonempty(prop(function, "arguments")) {
                self.argument_depth.entry(index).or_default().push(&args)?;
                out.push_back(StreamEvent::BlockDelta {
                    index,
                    delta: Delta::ToolJson { partial: args },
                });
            }
        }

        // Only a reason that is actually present is judged: `null` mid-stream
        // is how this wire spells "not finished yet".
        if let Some(reason) = prop(choice, "finish_reason").and_then(Value::as_text) {
            match FINISH.iter().find(|(k, _)| reason == *k) {
                Some((_, mapped)) => self.stop_reason = Some(*mapped),
                None => {
                    out.push_back(StreamEvent::Error {
                        code: ErrorCode::Upstream,
                        message: reason.surrounded("unrecognized Kimi finish reason \"", "\""),
                        retryable: false,
                    });
                    return Ok(Flow::Stop);
                }
            }
        }
        Ok(Flow::Continue)
    }
}

impl StreamDecoder for KimiDecoder {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        if msg.data == "[DONE]" {
            // The transport-level success marker. Only the last block is
            // still open; every earlier one was closed by its successor.
            if let Some((_, i)) = self.open {
                out.push_back(StreamEvent::BlockEnd { index: i });
            }
            out.push_back(StreamEvent::End {
                stop_reason: self.stop_reason.unwrap_or(StopReason::EndTurn),
                usage: self.usage.clone(),
                vendor: None,
            });
            return Ok(Flow::Stop);
        }
        let depth = omni_ir::deep::depth_of(&msg.data);
        if depth > omni_ir::deep::MAX_DEPTH {
            return Err(DecodeError::Throw("upstream JSON exceeds depth 40000"));
        }
        omni_ir::deep::scope_for_bound(depth, |_| {
            let Some(d) = json_object(&msg.data) else {
                return Ok(Flow::Continue);
            };
            self.apply(&d, out)
        })
    }

    fn finish(&mut self, out: &mut VecDeque<StreamEvent>) {
        out.push_back(StreamEvent::Error {
            code: ErrorCode::Upstream,
            message: "upstream stream ended before [DONE]".into(),
            retryable: ErrorCode::Upstream.retryable(),
        });
    }
}

// ------------------------------------------------------------------ JS helpers

#[derive(Debug, Default)]
struct IdentityBudget {
    entries: usize,
    bytes: usize,
}
impl IdentityBudget {
    fn add(&mut self, bytes: usize) -> Result<(), DecodeError> {
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

/// Container depth across argument fragments, including split string escapes.
#[derive(Debug, Default)]
struct ArgumentDepth {
    depth: usize,
    quoted: bool,
    escaped: bool,
}

impl ArgumentDepth {
    fn push(&mut self, text: &Text) -> Result<(), DecodeError> {
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

/// A JS `Map` key under SameValueZero. Objects and arrays parsed from JSON are
/// distinct identities, so each gets a key no other value equals.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum JsKey {
    /// The f64 bits, with `-0` folded into `0`.
    Number(u64),
    String(Text),
    Bool(bool),
    Null,
    Unique(u64),
}

impl JsKey {
    fn bytes(&self) -> usize {
        if let Self::String(s) = self {
            s.len()
        } else {
            0
        }
    }
}

#[derive(Debug, Default)]
struct KeyMint(u64);

impl KeyMint {
    fn key(&mut self, v: &Value) -> JsKey {
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
fn or_zero(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::from(0.0),
        Some(v) => v.clone(),
    }
}

/// `JSON.parse` that keeps only what `typeof v === "object" && v !== null`
/// keeps; a malformed payload is skipped, not fatal.
fn json_object(data: &str) -> Option<Value> {
    jsjson::parse_js(data)
        .ok()
        .filter(|v| v.is_object() || v.is_array())
}

/// `x?.[0]`.
fn index0(v: Option<&Value>) -> Option<Value> {
    match v? {
        Value::Array(items) => items.first().cloned(),
        v @ Value::Object(_) => v.get("0").cloned(),
        Value::String(s) => s.first().map(|u| Value::String(vec![*u])),
        _ => None,
    }
}

/// `for (const x of v ?? [])`.
fn iterate(v: Option<&Value>) -> Result<Vec<Value>, DecodeError> {
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
fn nonempty(v: Option<&Value>) -> Option<Text> {
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
fn usage_of(
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
    let mut usage = usage_from_prompt_total(p, n(output), r, w);
    // Only the subtraction operands are coerced; TS passes output and
    // cache-read counters to the client verbatim when they are not numbers.
    // Cache-write has no raw field — the residual gap openai/grok/muse carry.
    let out = nullish_or(output, Some(&zero)).unwrap_or(&zero);
    let rd = nullish_or(read, Some(&zero)).unwrap_or(&zero);
    usage.raw_output_tokens = out.as_f64().is_none().then(|| Box::new(out.clone()));
    usage.raw_cache_read_tokens = rd.as_f64().is_none().then(|| Box::new(rd.clone()));
    Ok(usage)
}

fn string(v: Option<&Value>) -> Result<Text, DecodeError> {
    jsjson::coerce_text(v).map_err(|_| DecodeError::Throw("JavaScript coercion threw"))
}
