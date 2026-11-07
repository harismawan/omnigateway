//! `decodeCustomChat`: a custom server's Chat Completions stream.

use std::collections::{HashMap, VecDeque};

use omni_ir::error::ErrorCode;
use omni_ir::js::{self, nullish_or, prop, truthy};
use omni_ir::stream::{ContentBlockStart, Delta, StopReason, StreamEvent, Usage};
use serde_json::Value;

use super::{JsKey, KeyMint, index0, iterate, json_object, nonempty, or_zero, usage_of};
use crate::codec::{DecodeThrow, Flow, StreamDecoder};
use crate::sse::SseMessage;

/// The reasoning text one chat delta carries: the first non-empty spelling.
fn reasoning_text(delta: Option<&Value>) -> String {
    if let Some(r) = nonempty(prop(delta, "reasoning")) {
        return r.to_string();
    }
    if let Some(r) = nonempty(prop(delta, "reasoning_content")) {
        return r.to_string();
    }
    let Some(Value::Array(details)) = prop(delta, "reasoning_details") else {
        return String::new();
    };
    let mut out = String::new();
    for entry in details {
        let entry = Some(entry);
        if let Some(t) = nonempty(prop(entry, "text")) {
            out.push_str(t);
        } else if let Some(s) = nonempty(prop(entry, "summary")) {
            out.push_str(s);
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Open {
    Text,
    Thinking,
    Tool,
}

/// `decodeCustomChat`.
#[derive(Debug, Default)]
pub struct ChatDecoder {
    started: bool,
    stop_reason: Option<StopReason>,
    usage: Usage,
    tool_index: HashMap<JsKey, u32>,
    keys: KeyMint,
    next_index: u32,
    open: Option<(Open, u32)>,
}

impl ChatDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Closes whatever block is open and opens a new one: at most one block
    /// is open at a time, so an Anthropic-shaped egress can replay the order.
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

    /// The open block if it is a `kind` (text or thinking), else a new one.
    fn continue_or_open(&mut self, kind: Open, out: &mut VecDeque<StreamEvent>) -> u32 {
        match self.open {
            Some((k, i)) if k == kind => i,
            _ => {
                // Never signed: a signature here was minted by another provider.
                let block = if kind == Open::Thinking {
                    ContentBlockStart::Thinking { signed: None }
                } else {
                    ContentBlockStart::Text
                };
                self.open_block(kind, block, out)
            }
        }
    }
}

const CHAT_FINISH: [(&str, StopReason); 4] = [
    ("stop", StopReason::EndTurn),
    ("length", StopReason::MaxTokens),
    ("tool_calls", StopReason::ToolUse),
    ("content_filter", StopReason::ContentFilter),
];

impl StreamDecoder for ChatDecoder {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeThrow> {
        if msg.data == "[DONE]" {
            // The transport-level success marker.
            if let Some((_, i)) = self.open {
                out.push_back(StreamEvent::BlockEnd { index: i });
            }
            out.push_back(StreamEvent::End {
                stop_reason: self.stop_reason.unwrap_or(StopReason::EndTurn),
                usage: self.usage,
                vendor: None,
            });
            return Ok(Flow::Stop);
        }
        let Some(d) = json_object(&msg.data) else {
            return Ok(Flow::Continue);
        };
        let d = Some(&d);

        let id = prop(d, "id");
        let model = prop(d, "model");
        if !self.started && (id.is_some() || model.is_some()) {
            self.started = true;
            let text = |v: Option<&Value>| match v {
                None | Some(Value::Null) => String::new(),
                some => js::to_string(some),
            };
            out.push_back(StreamEvent::Start {
                id: text(id),
                model: text(model),
            });
        }

        let usage = prop(d, "usage");
        if truthy(usage) {
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
            );
        }

        let choice = index0(prop(d, "choices"));
        if !truthy(choice.as_ref()) {
            return Ok(Flow::Continue);
        }
        let choice = choice.as_ref();
        let delta = prop(choice, "delta").filter(|v| !v.is_null());

        let reasoning = reasoning_text(delta);
        if !reasoning.is_empty() {
            let index = self.continue_or_open(Open::Thinking, out);
            out.push_back(StreamEvent::BlockDelta {
                index,
                delta: Delta::Thinking { text: reasoning },
            });
        }

        if let Some(content) = nonempty(prop(delta, "content")) {
            let index = self.continue_or_open(Open::Text, out);
            out.push_back(StreamEvent::BlockDelta {
                index,
                delta: Delta::Text {
                    text: content.to_string(),
                },
            });
        }

        for call in iterate(prop(delta, "tool_calls"))? {
            // Reading a property of `null` throws in JS.
            if call.is_null() {
                return Err(DecodeThrow("tool call is null"));
            }
            let call = Some(&call);
            let wire_index = or_zero(prop(call, "index"));
            let key = self.keys.key(&wire_index);
            let function = prop(call, "function");
            let index = match self.tool_index.get(&key) {
                Some(&index) => index,
                None => {
                    let id = match prop(call, "id") {
                        None | Some(Value::Null) => {
                            format!("call_{}", js::to_string(Some(&wire_index)))
                        }
                        some => js::to_string(some),
                    };
                    let name = match prop(function, "name") {
                        None | Some(Value::Null) => String::new(),
                        some => js::to_string(some),
                    };
                    let index =
                        self.open_block(Open::Tool, ContentBlockStart::ToolUse { id, name }, out);
                    self.tool_index.insert(key, index);
                    index
                }
            };
            if let Some(args) = nonempty(prop(function, "arguments")) {
                out.push_back(StreamEvent::BlockDelta {
                    index,
                    delta: Delta::ToolJson {
                        partial: args.to_string(),
                    },
                });
            }
        }

        if let Some(Value::String(reason)) = prop(choice, "finish_reason") {
            match CHAT_FINISH.iter().find(|(k, _)| k == reason) {
                Some((_, mapped)) => self.stop_reason = Some(*mapped),
                None => {
                    out.push_back(StreamEvent::Error {
                        code: ErrorCode::Upstream,
                        message: format!("unrecognized custom endpoint finish reason \"{reason}\""),
                        retryable: false,
                    });
                    return Ok(Flow::Stop);
                }
            }
        }
        Ok(Flow::Continue)
    }

    fn finish(&mut self, out: &mut VecDeque<StreamEvent>) {
        out.push_back(StreamEvent::Error {
            code: ErrorCode::Upstream,
            message: "upstream stream ended before [DONE]".into(),
            retryable: ErrorCode::Upstream.retryable(),
        });
    }
}
