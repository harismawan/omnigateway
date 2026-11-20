//! Incremental Anthropic SSE decoder; mirrors the frozen provider decoder.
use crate::{
    codec::{DecodeError, Flow, StreamDecoder},
    sse::SseMessage,
};
use omni_ir::{
    error::ErrorCode,
    jsjson::{self, JsValue as Value},
    stream::{ContentBlockStart, Delta, NativeFold, StopReason, StreamEvent, Usage},
    text::Text,
};
use serde_json::Map;
use std::collections::{HashMap, HashSet, VecDeque};

pub struct AnthropicDecoder {
    usage: Usage,
    reason: StopReason,
    terminal: bool,
    native: HashSet<u32>,
    vendor: Option<Map<String, serde_json::Value>>,
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
fn text(v: &Value) -> Text {
    v.as_text().unwrap_or_default()
}
fn name(v: Option<&Value>) -> Result<Text, DecodeError> {
    jsjson::coerce_text(v).map_err(|_| DecodeError::Throw("JavaScript coercion threw"))
}
fn protocol(out: &mut VecDeque<StreamEvent>, message: Text) -> Flow {
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
            let mut verdict = Map::new();
            omni_ir::deep::insert(
                &mut verdict,
                "safeguard_results".into(),
                omni_ir::deep::parse(&jsjson::render(v)).unwrap_or(serde_json::Value::Null),
            );
            let mut vendor = Map::new();
            omni_ir::deep::insert(
                &mut vendor,
                "anthropic".into(),
                serde_json::Value::Object(verdict),
            );
            if let Some(old) = self.vendor.replace(vendor) {
                omni_ir::deep::drop_map(old);
            }
        }
    }
}
impl Drop for AnthropicDecoder {
    fn drop(&mut self) {
        if let Some(vendor) = self.vendor.take() {
            omni_ir::deep::drop_map(vendor);
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
        omni_ir::deep::scope_for_bound(depth, |bound| self.message_inner(msg, out, bound))
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
        bound: usize,
    ) -> Result<Flow, DecodeError> {
        let d = match jsjson::parse_bounded(&msg.data, bound) {
            Ok(v) => v,
            Err(omni_ir::deep::ParseError::Syntax) => return Ok(Flow::Continue),
            Err(omni_ir::deep::ParseError::TooDeep) => {
                return Err(DecodeError::Gateway(omni_ir::error::GatewayError::new(
                    ErrorCode::Upstream,
                    "upstream JSON exceeds maximum depth",
                )));
            }
        };
        if !d.is_object() && !d.is_array() {
            return Ok(Flow::Continue);
        }
        let index = d["index"]
            .as_f64()
            .filter(|n| *n >= 0.0 && *n < u64::MAX as f64 && n.fract() == 0.0)
            .map_or(0, |n| n as u64 as u32);
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
                    id: m
                        .get("id")
                        .filter(|v| !v.is_null())
                        .map_or_else(|| Ok(Text::default()), |v| name(Some(v)))?,
                    model: m
                        .get("model")
                        .filter(|v| !v.is_null())
                        .map_or_else(|| Ok(Text::default()), |v| name(Some(v)))?,
                });
            }
            "content_block_start" => {
                let b = &d["content_block"];
                let kind = text(&b["type"]);
                let block = match kind.as_utf8().unwrap_or("") {
                    "text" => ContentBlockStart::Text,
                    "thinking" => ContentBlockStart::Thinking { signed: Some(true) },
                    "tool_use" => {
                        let id = name(b.get("id"))?;
                        let n = name(b.get("name"))?;
                        ContentBlockStart::ToolUse {
                            id,
                            name: n
                                .as_utf8()
                                .and_then(|s| self.uncloak.get(s))
                                .map(Text::from)
                                .unwrap_or(n),
                        }
                    }
                    t if NATIVE.contains(&t) => {
                        self.native.insert(index);
                        let mut data = b.clone().into_object();
                        data.retain(|(k, _)| !"type".encode_utf16().eq(k.iter().copied()));
                        ContentBlockStart::ProviderNative {
                            provider: "anthropic".into(),
                            block_type: t.into(),
                            data: Value::Object(data),
                        }
                    }
                    _ => {
                        return Ok(protocol(
                            out,
                            name(b.get("type"))?
                                .surrounded("unrecognized Anthropic content block type \"", "\""),
                        ));
                    }
                };
                out.push_back(StreamEvent::BlockStart { index, block });
            }
            "content_block_delta" => {
                let delta = &d["delta"];
                let kind = text(&delta["type"]);
                let dt = kind.as_utf8().unwrap_or("");
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
                        let mut data = Value::Object(Vec::new());
                        for key in if dt == "citations_delta" {
                            &["citation"][..]
                        } else {
                            &["content", "encrypted_content"][..]
                        } {
                            if let Some(v) = delta.get(key) {
                                data.put(key.encode_utf16().collect(), v.clone());
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
                            name(delta.get("type"))?
                                .surrounded("unrecognized Anthropic content block delta \"", "\""),
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
                    &d
                });
                if let Some(reason) = d["delta"]["stop_reason"].as_text() {
                    self.reason = match reason.as_utf8() {
                        Some("end_turn") => StopReason::EndTurn,
                        Some("max_tokens") => StopReason::MaxTokens,
                        Some("stop_sequence") => StopReason::StopSequence,
                        Some("tool_use") => StopReason::ToolUse,
                        Some("refusal") => StopReason::ContentFilter,
                        Some("pause_turn") => StopReason::PauseTurn,
                        _ => {
                            return Ok(protocol(
                                out,
                                reason.surrounded("unrecognized Anthropic stop reason \"", "\""),
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
                self.safeguards(&d);
                self.terminal = true;
                out.push_back(StreamEvent::End {
                    stop_reason: self.reason,
                    usage: self.usage.clone(),
                    vendor: self.vendor.as_ref().map(omni_ir::deep::clone_map),
                });
            }
            "error" => {
                self.terminal = true;
                let t = name(d["error"].get("type"))?;
                let message = d["error"]
                    .get("message")
                    .filter(|v| !v.is_null())
                    .map_or_else(|| Ok("upstream error".into()), |v| name(Some(v)))?;
                let code = if t == "invalid_request_error"
                    && is_fingerprint_message(&message.to_utf8_lossy())
                {
                    ErrorCode::FingerprintRefused
                } else {
                    match t.as_utf8() {
                        Some("overloaded_error") => ErrorCode::Overloaded,
                        Some("rate_limit_error") => ErrorCode::RateLimit,
                        Some("authentication_error" | "permission_error") => ErrorCode::Auth,
                        Some("invalid_request_error") => ErrorCode::BadRequest,
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
                    format!("unrecognized Anthropic stream event \"{}\"", msg.event).into(),
                ));
            }
        }
        Ok(Flow::Continue)
    }
}
