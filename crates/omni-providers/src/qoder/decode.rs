//! `decodeQoder`: the Cosy chat stream.
//!
//! Records arrive bare or inside a `{statusCodeValue, body}` envelope; both
//! shapes carry the same sentinels and the same Chat Completions delta.
//! Blocks are strictly sequential — reasoning and text close each other —
//! while tool calls are buffered per wire index and flushed at `[DONE]` in
//! first-seen order, because parallel calls interleave on the vendor wire and
//! an Anthropic-shaped client cannot reopen a closed block.
//!
//! The JS-coercion helpers below are qoder's own fork of the chat-decoder
//! vocabulary, per the provider boundary rule.

use std::collections::VecDeque;

use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::jsjson::{self, JsValue as Value};
use omni_ir::stream::{
    ContentBlockStart, Delta, StopReason, StreamEvent, Usage, usage_from_prompt_total,
};
use omni_ir::text::Text;

use crate::codec::{DecodeError, Flow, StreamDecoder};
use crate::sse::SseMessage;

fn fail(code: ErrorCode, message: &str) -> DecodeError {
    DecodeError::Gateway(GatewayError::new(code, message))
}

/// `record`: objects only; everything else reads as an empty record.
fn record(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| v.is_object())
}

/// `count`: a safe non-negative integer, else 0.
fn count(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n))
            if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 9_007_199_254_740_991.0 =>
        {
            *n
        }
        _ => 0.0,
    }
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

/// `typeof x === "string" && x` — the value, not a coercion.
fn nonempty_string(v: Option<&Value>) -> Option<Text> {
    v.and_then(Value::as_text).filter(|s| !s.is_empty())
}

fn string(v: Option<&Value>) -> Result<Text, DecodeError> {
    jsjson::coerce_text(v).map_err(|_| DecodeError::Throw("JavaScript coercion threw"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Open {
    Thinking,
    Text,
}

#[derive(Debug, Default, Clone)]
struct ToolBuf {
    id: Text,
    name: Text,
    arguments: Text,
}

#[derive(Debug)]
pub struct QoderDecoder {
    started: bool,
    next: u32,
    open: Option<(Open, u32)>,
    /// The vendor's `Map<number, …>` in insertion order; wire indices are
    /// `count`-coerced integers, so a linear scan is the whole lookup.
    tools: Vec<(f64, ToolBuf)>,
    stop_reason: StopReason,
    usage: Usage,
}

impl Default for QoderDecoder {
    fn default() -> Self {
        Self {
            started: false,
            next: 0,
            open: None,
            tools: Vec::new(),
            stop_reason: StopReason::EndTurn,
            usage: usage_from_prompt_total(0.0, 0.0, 0.0, 0.0),
        }
    }
}

impl QoderDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The tail of the generator, run once `[DONE]` arrives: close the open
    /// block, flush every buffered call, end.
    fn flush(&mut self, out: &mut VecDeque<StreamEvent>) -> Result<(), DecodeError> {
        if !self.started {
            return Err(fail(ErrorCode::Upstream, "Empty Qoder stream"));
        }
        if let Some((_, i)) = self.open.take() {
            out.push_back(StreamEvent::BlockEnd { index: i });
        }
        for (_, tool) in &self.tools {
            if tool.id.is_empty() || tool.name.is_empty() {
                return Err(fail(
                    ErrorCode::Upstream,
                    "Qoder tool call missing identity",
                ));
            }
            let index = self.next;
            self.next += 1;
            let arguments = if tool.arguments.is_empty() {
                Text::from("{}")
            } else {
                tool.arguments.clone()
            };
            let text = arguments.to_utf8_lossy();
            // A depth-40000 document throws in JS too, and the same catch
            // relabels it; the bound keeps Rust's parser off the raw stack.
            let depth = omni_ir::deep::depth_of(&text);
            let parsed = if depth > omni_ir::deep::MAX_DEPTH {
                Err(())
            } else {
                omni_ir::deep::scope_for_bound(depth, |_| {
                    jsjson::parse_bounded(&text, depth).map_err(|_| ())
                })
            };
            if parsed.is_err() {
                return Err(fail(ErrorCode::Upstream, "Malformed Qoder tool arguments"));
            }
            out.push_back(StreamEvent::BlockStart {
                index,
                block: ContentBlockStart::ToolUse {
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                },
            });
            out.push_back(StreamEvent::BlockDelta {
                index,
                delta: Delta::ToolJson { partial: arguments },
            });
            out.push_back(StreamEvent::BlockEnd { index });
        }
        out.push_back(StreamEvent::End {
            stop_reason: self.stop_reason,
            usage: self.usage.clone(),
            vendor: None,
        });
        Ok(())
    }

    /// One parsed record, envelope already unwrapped.
    fn apply(&mut self, chunk: &Value, out: &mut VecDeque<StreamEvent>) -> Result<(), DecodeError> {
        let chunk = Some(chunk);
        // `"error" in chunk` is an own-property test, value irrelevant.
        let code_ok = match prop(chunk, "code") {
            None => true,
            some => {
                let text = string(some)?;
                text == "0" || text == "200"
            }
        };
        if prop(chunk, "error").is_some()
            || prop(chunk, "success") == Some(&Value::Bool(false))
            || (!code_ok && prop(chunk, "choices").is_none())
        {
            return Err(fail(ErrorCode::Upstream, "Qoder business error"));
        }
        let choices = prop(chunk, "choices").filter(|v| v.is_array());
        if choices.is_none() && !truthy(prop(chunk, "usage")) {
            return Err(fail(
                ErrorCode::Upstream,
                "Unrecognized Qoder stream record",
            ));
        }
        if !self.started {
            self.started = true;
            let as_string = |v: Option<&Value>| v.and_then(Value::as_text).unwrap_or_default();
            out.push_back(StreamEvent::Start {
                id: as_string(prop(chunk, "id")),
                model: as_string(prop(chunk, "model")),
            });
        }
        let usage = prop(chunk, "usage");
        if truthy(usage) {
            let u = record(usage);
            let details = record(prop(u, "prompt_tokens_details"));
            self.usage = usage_from_prompt_total(
                count(prop(u, "prompt_tokens")),
                count(prop(u, "completion_tokens")),
                count(nullish_or(
                    prop(details, "cached_tokens"),
                    prop(u, "prompt_cache_hit_tokens"),
                )),
                count(nullish_or(
                    prop(u, "cache_creation_input_tokens"),
                    nullish_or(
                        prop(details, "cache_creation_tokens"),
                        prop(details, "cache_write_tokens"),
                    ),
                )),
            );
        }
        let first = choices.and_then(|v| v.as_array()).and_then(|a| a.first());
        let choice = record(first);
        let delta = record(prop(choice, "delta"));
        for (field, kind) in [
            ("reasoning_content", Open::Thinking),
            ("content", Open::Text),
        ] {
            let Some(text) = nonempty_string(prop(delta, field)) else {
                continue;
            };
            let index = match self.open {
                Some((k, i)) if k == kind => i,
                _ => {
                    if let Some((_, i)) = self.open.take() {
                        out.push_back(StreamEvent::BlockEnd { index: i });
                    }
                    let i = self.next;
                    self.next += 1;
                    self.open = Some((kind, i));
                    out.push_back(StreamEvent::BlockStart {
                        index: i,
                        block: if kind == Open::Thinking {
                            ContentBlockStart::Thinking {
                                signed: Some(false),
                            }
                        } else {
                            ContentBlockStart::Text
                        },
                    });
                    i
                }
            };
            out.push_back(StreamEvent::BlockDelta {
                index,
                delta: if kind == Open::Thinking {
                    Delta::Thinking { text }
                } else {
                    Delta::Text { text }
                },
            });
        }
        if let Some(calls) = prop(delta, "tool_calls").and_then(Value::as_array) {
            for raw in calls {
                let c = record(Some(raw));
                let function = record(prop(c, "function"));
                let wire_index = count(prop(c, "index"));
                let at = match self.tools.iter().position(|(k, _)| *k == wire_index) {
                    Some(at) => at,
                    None => {
                        self.tools.push((wire_index, ToolBuf::default()));
                        self.tools.len() - 1
                    }
                };
                let Some((_, tool)) = self.tools.get_mut(at) else {
                    continue;
                };
                if let Some(id) = nonempty_string(prop(c, "id")) {
                    tool.id = id;
                }
                if let Some(name) = nonempty_string(prop(function, "name")) {
                    tool.name.push(&name);
                }
                if let Some(arguments) = prop(function, "arguments").and_then(Value::as_text) {
                    tool.arguments.push(&arguments);
                }
            }
        }
        let reason = prop(choice, "finish_reason").and_then(Value::as_text);
        // An unknown reason is silent here, unlike kimi: this wire's default
        // is a complete reply.
        match reason.as_ref().and_then(Text::as_utf8) {
            Some("tool_calls") => self.stop_reason = StopReason::ToolUse,
            Some("length") => self.stop_reason = StopReason::MaxTokens,
            Some("content_filter") => self.stop_reason = StopReason::ContentFilter,
            _ => {}
        }
        Ok(())
    }
}

impl StreamDecoder for QoderDecoder {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        let mut data = msg.data.clone();
        if data == "[DONE]" {
            self.flush(out)?;
            return Ok(Flow::Stop);
        }
        if data == "[NOT_EXCEED_QUOTA]" || data.starts_with("[NOTIFICATIONS]#") {
            return Ok(Flow::Continue);
        }
        if data == "[EXCEED_QUOTA]" {
            return Err(fail(ErrorCode::RateLimit, "Qoder quota exceeded"));
        }
        let depth = omni_ir::deep::depth_of(&data);
        if depth > omni_ir::deep::MAX_DEPTH {
            return Err(DecodeError::Throw("upstream JSON exceeds depth 40000"));
        }
        omni_ir::deep::scope_for_bound(depth, |_| {
            let Ok(parsed) = jsjson::parse_bounded(&data, depth) else {
                return Err(fail(ErrorCode::Upstream, "Malformed Qoder stream"));
            };
            let mut chunk = record(Some(&parsed))
                .cloned()
                .unwrap_or(Value::Object(Vec::new()));
            if let Some(status) = chunk.get("statusCodeValue") {
                if status != &Value::Number(200.0) {
                    let code = if status == &Value::Number(429.0) {
                        ErrorCode::RateLimit
                    } else {
                        ErrorCode::Upstream
                    };
                    return Err(fail(code, "Qoder stream rejected"));
                }
                let Some(body) = chunk.get("body").and_then(Value::as_text) else {
                    return Err(fail(ErrorCode::Upstream, "Malformed Qoder envelope"));
                };
                data = body.to_utf8_lossy().into_owned();
                if data == "[DONE]" {
                    self.flush(out)?;
                    return Ok(Flow::Stop);
                }
                if data == "[EXCEED_QUOTA]" {
                    return Err(fail(ErrorCode::RateLimit, "Qoder quota exceeded"));
                }
                if data == "[NOT_EXCEED_QUOTA]" || data.starts_with("[NOTIFICATIONS]#") {
                    return Ok(Flow::Continue);
                }
                let inner_depth = omni_ir::deep::depth_of(&data);
                let Ok(inner) = omni_ir::deep::scope_for_bound(inner_depth, |_| {
                    jsjson::parse_bounded(&data, inner_depth)
                }) else {
                    return Err(fail(ErrorCode::Upstream, "Malformed Qoder envelope"));
                };
                chunk = record(Some(&inner))
                    .cloned()
                    .unwrap_or(Value::Object(Vec::new()));
            }
            self.apply(&chunk, out)?;
            Ok(Flow::Continue)
        })
    }

    fn finish(&mut self, out: &mut VecDeque<StreamEvent>) {
        out.push_back(StreamEvent::Error {
            code: ErrorCode::Upstream,
            message: "Truncated Qoder stream".into(),
            retryable: ErrorCode::Upstream.retryable(),
        });
    }
}
