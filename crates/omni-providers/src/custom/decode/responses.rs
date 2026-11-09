//! `decodeCustomResponses`: a custom server's Responses stream.

use std::collections::{HashMap, HashSet, VecDeque};

use omni_ir::error::ErrorCode;
use omni_ir::js::{self, nullish_or, prop};
use omni_ir::stream::{ContentBlockStart, Delta, StopReason, StreamEvent};
use serde_json::Value;

use super::{JsKey, KeyMint, json_object, or_zero, usage_of};
use crate::codec::{DecodeError, Flow, StreamDecoder};
use crate::sse::SseMessage;

const RESPONSES_ERROR_CODE: [(&str, ErrorCode); 6] = [
    ("rate_limit_exceeded", ErrorCode::RateLimit),
    ("insufficient_quota", ErrorCode::QuotaExhausted),
    ("invalid_api_key", ErrorCode::Auth),
    ("server_error", ErrorCode::Upstream),
    ("context_length_exceeded", ErrorCode::BadRequest),
    ("content_policy_violation", ErrorCode::ContentFilter),
];

const KNOWN_RESPONSES_EVENTS: [&str; 24] = [
    "response.created",
    "response.queued",
    "response.in_progress",
    "response.output_item.added",
    "response.output_item.done",
    "response.content_part.added",
    "response.content_part.done",
    "response.output_text.delta",
    "response.output_text.done",
    "response.output_text.annotation.added",
    "response.refusal.delta",
    "response.refusal.done",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_text.delta",
    "response.reasoning_text.done",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.completed",
    "response.incomplete",
    "response.failed",
    "error",
];

/// `decodeCustomResponses`.
#[derive(Debug, Default)]
pub struct ResponsesDecoder {
    identity_budget: super::IdentityBudget,
    argument_depth: std::collections::HashMap<u32, super::ArgumentDepth>,
    /// Keyed by the template string `${output_index}:${content_index}`.
    indices: HashMap<String, u32>,
    next: u32,
    saw_tool_call: bool,
    terminal: bool,
    /// Output indices whose block `output_item.added` opened (SameValueZero).
    owns_block: HashSet<JsKey>,
    keys: KeyMint,
}

impl ResponsesDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    fn ir_index(&mut self, output: &Value, content: &Value) -> Result<u32, DecodeError> {
        let key = format!(
            "{}:{}",
            js::to_string(Some(output)),
            js::to_string(Some(content))
        );
        if let Some(&i) = self.indices.get(&key) {
            return Ok(i);
        }
        self.identity_budget.add(key.len())?;
        let assigned = self.next;
        self.next += 1;
        self.indices.insert(key, assigned);
        Ok(assigned)
    }
}

/// `String(x ?? "")`.
fn string_or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        some => js::to_string(some),
    }
}

impl StreamDecoder for ResponsesDecoder {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        if msg.data == "[DONE]" {
            return Ok(Flow::Continue);
        }
        let depth = omni_ir::deep::depth_of(&msg.data);
        if depth > omni_ir::deep::MAX_DEPTH {
            return Err(DecodeError::Throw("upstream JSON exceeds depth 40000"));
        }
        omni_ir::deep::scope_for_bound(depth, |_| {
            if !KNOWN_RESPONSES_EVENTS.contains(&msg.event.as_str()) {
                out.push_back(StreamEvent::Error {
                    code: ErrorCode::Upstream,
                    message: format!(
                        "unrecognized custom endpoint stream event \"{}\"",
                        msg.event
                    ),
                    retryable: false,
                });
                return Ok(Flow::Stop);
            }
            let Some(d) = json_object(&msg.data) else {
                return Ok(Flow::Continue);
            };
            let d = Some(&d);
            let output = or_zero(prop(d, "output_index"));
            let content = or_zero(prop(d, "content_index"));
            let zero = Value::from(0);

            match msg.event.as_str() {
                "response.created" => {
                    let response = prop(d, "response");
                    out.push_back(StreamEvent::Start {
                        id: string_or_empty(prop(response, "id")),
                        model: string_or_empty(prop(response, "model")),
                    });
                }
                "response.output_item.added" => {
                    let item = prop(d, "item").filter(|v| !v.is_null());
                    match prop(item, "type").and_then(Value::as_str) {
                        Some("reasoning") => {
                            let key = self.keys.key(&output);
                            if !self.owns_block.contains(&key) {
                                self.identity_budget.add(key.bytes())?;
                            }
                            self.owns_block.insert(key);
                            let index = self.ir_index(&output, &zero)?;
                            out.push_back(StreamEvent::BlockStart {
                                index,
                                block: ContentBlockStart::Thinking { signed: None },
                            });
                        }
                        Some("function_call") => {
                            self.saw_tool_call = true;
                            let key = self.keys.key(&output);
                            if !self.owns_block.contains(&key) {
                                self.identity_budget.add(key.bytes())?;
                            }
                            self.owns_block.insert(key);
                            let index = self.ir_index(&output, &zero)?;
                            out.push_back(StreamEvent::BlockStart {
                                index,
                                block: ContentBlockStart::ToolUse {
                                    id: js::to_string(prop(item, "call_id")),
                                    name: js::to_string(prop(item, "name")),
                                },
                            });
                        }
                        _ => {}
                    }
                }
                "response.content_part.added" => {
                    if prop(prop(d, "part"), "type").and_then(Value::as_str) == Some("output_text")
                    {
                        let index = self.ir_index(&output, &content)?;
                        out.push_back(StreamEvent::BlockStart {
                            index,
                            block: ContentBlockStart::Text,
                        });
                    }
                }
                "response.output_text.delta" => {
                    let index = self.ir_index(&output, &content)?;
                    out.push_back(StreamEvent::BlockDelta {
                        index,
                        delta: Delta::Text {
                            text: string_or_empty(prop(d, "delta")),
                        },
                    });
                }
                "response.reasoning_summary_text.delta" => {
                    let index = self.ir_index(&output, &zero)?;
                    out.push_back(StreamEvent::BlockDelta {
                        index,
                        delta: Delta::Thinking {
                            text: string_or_empty(prop(d, "delta")),
                        },
                    });
                }
                "response.function_call_arguments.delta" => {
                    let index = self.ir_index(&output, &zero)?;
                    self.argument_depth
                        .entry(index)
                        .or_default()
                        .push(prop(d, "delta").and_then(Value::as_str).unwrap_or(""))?;
                    out.push_back(StreamEvent::BlockDelta {
                        index,
                        delta: Delta::ToolJson {
                            partial: string_or_empty(prop(d, "delta")),
                        },
                    });
                }
                "response.content_part.done" => {
                    let index = self.ir_index(&output, &content)?;
                    out.push_back(StreamEvent::BlockEnd { index });
                }
                "response.output_item.done" => {
                    // A fresh object key never matches, exactly as `Set.delete`.
                    let key = self.keys.key(&output);
                    if self.owns_block.remove(&key) {
                        self.identity_budget.remove(key.bytes());
                        let index = self.ir_index(&output, &zero)?;
                        out.push_back(StreamEvent::BlockEnd { index });
                    }
                }
                "response.completed" | "response.incomplete" => {
                    self.terminal = true;
                    let r = prop(d, "response").filter(|v| !v.is_null());
                    let reason = prop(prop(r, "incomplete_details"), "reason");
                    let status = prop(r, "status");
                    let mut stop = if self.saw_tool_call {
                        StopReason::ToolUse
                    } else {
                        StopReason::EndTurn
                    };
                    match reason.and_then(Value::as_str) {
                        Some("max_output_tokens") => stop = StopReason::MaxTokens,
                        Some("content_filter") => stop = StopReason::ContentFilter,
                        _ => {
                            let status_bad =
                                status.is_some_and(|s| s.as_str() != Some("completed"));
                            if reason.is_some() || msg.event == "response.incomplete" || status_bad
                            {
                                let message = if reason.is_some() {
                                    format!(
                                        "unrecognized custom endpoint incomplete reason \"{}\"",
                                        js::to_string(reason)
                                    )
                                } else if status.is_some_and(|s| s.as_str() != Some("incomplete")) {
                                    format!(
                                        "custom endpoint reported terminal response status \"{}\"",
                                        js::to_string(status)
                                    )
                                } else {
                                    "custom endpoint reported the response incomplete without a reason"
                                    .to_string()
                                };
                                out.push_back(StreamEvent::Error {
                                    code: ErrorCode::Upstream,
                                    message,
                                    retryable: false,
                                });
                                return Ok(Flow::Continue);
                            }
                        }
                    }
                    let usage = prop(r, "usage");
                    out.push_back(StreamEvent::End {
                        stop_reason: stop,
                        usage: usage_of(
                            prop(usage, "input_tokens"),
                            prop(usage, "output_tokens"),
                            nullish_or(
                                prop(prop(usage, "input_tokens_details"), "cached_tokens"),
                                prop(prop(usage, "prompt_tokens_details"), "cached_tokens"),
                            ),
                            None,
                        ),
                        vendor: None,
                    });
                }
                "response.failed" | "error" => {
                    self.terminal = true;
                    let err = nullish_or(prop(prop(d, "response"), "error"), prop(d, "error"));
                    let raw = js::to_string(nullish_or(prop(err, "code"), prop(err, "type")));
                    let code = RESPONSES_ERROR_CODE
                        .iter()
                        .find(|(k, _)| *k == raw)
                        .map_or(ErrorCode::Upstream, |(_, c)| *c);
                    let message = match nullish_or(prop(err, "message"), None) {
                        None => "upstream error".to_string(),
                        some => js::to_string(some),
                    };
                    out.push_back(StreamEvent::Error {
                        code,
                        message,
                        retryable: code.retryable(),
                    });
                }
                _ => {}
            }
            Ok(Flow::Continue)
        })
    }

    fn finish(&mut self, out: &mut VecDeque<StreamEvent>) {
        if !self.terminal {
            out.push_back(StreamEvent::Error {
                code: ErrorCode::Upstream,
                message: "upstream stream ended before response completion".into(),
                retryable: ErrorCode::Upstream.retryable(),
            });
        }
    }
}
