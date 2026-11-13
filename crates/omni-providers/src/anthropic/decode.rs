//! Incremental Anthropic SSE decoder; mirrors the frozen provider decoder.
use crate::{
    codec::{DecodeError, Flow, StreamDecoder},
    sse::SseMessage,
};
use omni_ir::{
    error::ErrorCode,
    stream::{ContentBlockStart, Delta, NativeFold, StopReason, StreamEvent, Usage},
};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

pub struct AnthropicDecoder {
    usage: Usage,
    reason: StopReason,
    terminal: bool,
    native: HashSet<u32>,
    vendor: Option<Map<String, Value>>,
    /// Wire alias to original client tool name.
    pub uncloak: HashMap<String, String>,
}
impl Default for AnthropicDecoder {
    fn default() -> Self {
        Self {
            usage: Usage::default(),
            reason: StopReason::EndTurn,
            terminal: false,
            native: HashSet::new(),
            vendor: None,
            uncloak: HashMap::new(),
        }
    }
}
pub fn is_fingerprint_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("out of extra usage") || lower.contains("draw from extra usage")
}
fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").into()
}
fn name(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => omni_ir::jsjson::to_string(v),
    }
}
fn protocol(out: &mut VecDeque<StreamEvent>, message: String) -> Flow {
    out.push_back(StreamEvent::Error {
        code: ErrorCode::Upstream,
        message,
        retryable: false,
    });
    Flow::Stop
}
const NATIVE: &[&str] = &[
    "server_tool_use",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "mcp_tool_use",
    "mcp_tool_result",
    "tool_search_tool_result",
    "tool_reference",
    "advisor_tool_result",
    "advisor_result",
    "advisor_redacted_result",
    "container_upload",
    "compaction",
    "search_result",
    "document",
    "mid_conv_system",
    "tool_addition",
    "tool_removal",
    "fallback",
    "redacted_thinking",
];
impl AnthropicDecoder {
    fn safeguards(&mut self, value: &Value) {
        if let Some(v) = value.get("safeguard_results") {
            self.vendor = Some(
                serde_json::json!({"anthropic":{"safeguard_results":v}})
                    .as_object()
                    .expect("object")
                    .clone(),
            );
        }
    }
}
impl StreamDecoder for AnthropicDecoder {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        let depth = omni_ir::deep::depth_of(&msg.data);
        omni_ir::deep::scope_for_bound(depth, |_| self.message_inner(msg, out))
    }
    fn finish(&mut self, out: &mut VecDeque<StreamEvent>) {
        if !self.terminal {
            out.push_back(StreamEvent::Error {
                code: ErrorCode::Upstream,
                message: "upstream stream ended before message_stop".into(),
                retryable: true,
            });
        }
    }
}
impl AnthropicDecoder {
    fn message_inner(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        let d = match omni_ir::deep::parse(&msg.data) {
            Ok(v) => omni_ir::deep::Owned(v),
            Err(omni_ir::deep::ParseError::Syntax) => return Ok(Flow::Continue),
            Err(omni_ir::deep::ParseError::TooDeep) => {
                return Err(DecodeError::Gateway(omni_ir::error::GatewayError::new(
                    ErrorCode::Upstream,
                    "upstream JSON exceeds maximum depth",
                )));
            }
        };
        let d = &d.0;
        if !d.is_object() && !d.is_array() {
            return Ok(Flow::Continue);
        }
        let index = d["index"].as_u64().unwrap_or(0) as u32;
        match msg.event.as_str() {
            "message_start" => {
                let m = &d["message"];
                let u = &m["usage"];
                self.usage.input_tokens = u["input_tokens"].as_f64().unwrap_or(0.0);
                self.usage.cache_read_tokens = u["cache_read_input_tokens"].as_f64().unwrap_or(0.0);
                self.usage.cache_write_tokens =
                    u["cache_creation_input_tokens"].as_f64().unwrap_or(0.0);
                self.usage.cache_write_5m_tokens =
                    u["cache_creation"]["ephemeral_5m_input_tokens"].as_f64();
                self.usage.cache_write_1h_tokens =
                    u["cache_creation"]["ephemeral_1h_input_tokens"].as_f64();
                out.push_back(StreamEvent::Start {
                    id: text(&m["id"]),
                    model: text(&m["model"]),
                });
            }
            "content_block_start" => {
                let b = &d["content_block"];
                let block = match b["type"].as_str().unwrap_or("") {
                    "text" => ContentBlockStart::Text,
                    "thinking" => ContentBlockStart::Thinking { signed: Some(true) },
                    "tool_use" => {
                        let n = name(b.get("name"));
                        ContentBlockStart::ToolUse {
                            id: name(b.get("id")),
                            name: self.uncloak.get(&n).cloned().unwrap_or(n),
                        }
                    }
                    t if NATIVE.contains(&t) => {
                        self.native.insert(index);
                        let mut data = b
                            .as_object()
                            .map(omni_ir::deep::clone_map)
                            .unwrap_or_default();
                        data.shift_remove("type");
                        ContentBlockStart::ProviderNative {
                            provider: "anthropic".into(),
                            block_type: t.into(),
                            data,
                        }
                    }
                    _ => {
                        return Ok(protocol(
                            out,
                            format!(
                                "unrecognized Anthropic content block type \"{}\"",
                                name(b.get("type"))
                            ),
                        ));
                    }
                };
                out.push_back(StreamEvent::BlockStart { index, block });
            }
            "content_block_delta" => {
                let delta = &d["delta"];
                let dt = delta["type"].as_str().unwrap_or("");
                let mapped = match dt {
                    "text_delta" => Delta::Text {
                        text: text(&delta["text"]),
                    },
                    "thinking_delta" => Delta::Thinking {
                        text: text(&delta["thinking"]),
                    },
                    "signature_delta" => {
                        let signature = text(&delta["signature"]);
                        if signature.is_empty() {
                            return Ok(Flow::Continue);
                        }
                        Delta::ThinkingSignature { signature }
                    }
                    "input_json_delta" => {
                        let partial = text(&delta["partial_json"]);
                        if self.native.contains(&index) {
                            Delta::ProviderNativeJson {
                                provider: "anthropic".into(),
                                partial,
                            }
                        } else {
                            Delta::ToolJson { partial }
                        }
                    }
                    "citations_delta" | "compaction_delta" => {
                        let mut data = Map::new();
                        for key in if dt == "citations_delta" {
                            &["citation"][..]
                        } else {
                            &["content", "encrypted_content"][..]
                        } {
                            if let Some(v) = delta.get(*key) {
                                data.insert((*key).into(), omni_ir::deep::clone(v));
                            }
                        }
                        Delta::ProviderNative {
                            provider: "anthropic".into(),
                            delta_type: dt.into(),
                            fold: Some(if dt == "citations_delta" {
                                NativeFold::Citation
                            } else {
                                NativeFold::Merge
                            }),
                            data,
                        }
                    }
                    _ => {
                        return Ok(protocol(
                            out,
                            format!(
                                "unrecognized Anthropic content block delta \"{}\"",
                                name(delta.get("type"))
                            ),
                        ));
                    }
                };
                out.push_back(StreamEvent::BlockDelta {
                    index,
                    delta: mapped,
                });
            }
            "content_block_stop" => {
                self.native.remove(&index);
                out.push_back(StreamEvent::BlockEnd { index });
            }
            "message_delta" => {
                self.safeguards(if d["delta"].get("safeguard_results").is_some() {
                    &d["delta"]
                } else {
                    d
                });
                if let Some(reason) = d["delta"]["stop_reason"].as_str() {
                    self.reason = match reason {
                        "end_turn" => StopReason::EndTurn,
                        "max_tokens" => StopReason::MaxTokens,
                        "stop_sequence" => StopReason::StopSequence,
                        "tool_use" => StopReason::ToolUse,
                        "refusal" => StopReason::ContentFilter,
                        "pause_turn" => StopReason::PauseTurn,
                        _ => {
                            return Ok(protocol(
                                out,
                                format!("unrecognized Anthropic stop reason \"{reason}\""),
                            ));
                        }
                    };
                }
                self.usage.input_tokens = d["usage"]["input_tokens"]
                    .as_f64()
                    .unwrap_or(self.usage.input_tokens);
                self.usage.output_tokens = d["usage"]["output_tokens"]
                    .as_f64()
                    .unwrap_or(self.usage.output_tokens);
            }
            "message_stop" => {
                self.safeguards(d);
                self.terminal = true;
                out.push_back(StreamEvent::End {
                    stop_reason: self.reason,
                    usage: self.usage,
                    vendor: self.vendor.as_ref().map(omni_ir::deep::clone_map),
                });
            }
            "error" => {
                self.terminal = true;
                let message = d["error"]["message"]
                    .as_str()
                    .unwrap_or("upstream error")
                    .to_owned();
                let t = d["error"]["type"].as_str().unwrap_or("");
                let code = if t == "invalid_request_error" && is_fingerprint_message(&message) {
                    ErrorCode::FingerprintRefused
                } else {
                    match t {
                        "overloaded_error" => ErrorCode::Overloaded,
                        "rate_limit_error" => ErrorCode::RateLimit,
                        "authentication_error" | "permission_error" => ErrorCode::Auth,
                        "invalid_request_error" => ErrorCode::BadRequest,
                        _ => ErrorCode::Upstream,
                    }
                };
                out.push_back(StreamEvent::Error {
                    code,
                    message,
                    retryable: code.retryable(),
                });
            }
            "ping" => (),
            _ => {
                return Ok(protocol(
                    out,
                    format!("unrecognized Anthropic stream event \"{}\"", msg.event),
                ));
            }
        }
        Ok(Flow::Continue)
    }
}
