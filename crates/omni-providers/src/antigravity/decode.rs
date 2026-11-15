//! Incremental port of the frozen Cloud Code stream decoder.
use super::cloak::ToolCloak;
use crate::{
    codec::{DecodeError, Flow, StreamDecoder},
    sse::SseMessage,
};
use omni_ir::{
    error::ErrorCode,
    stream::{ContentBlockStart, Delta, StopReason, StreamEvent, Usage, usage_from_prompt_total},
};
use serde_json::Value;
use std::collections::VecDeque;

#[derive(Default)]
pub struct AntigravityDecoder {
    pub cloak: ToolCloak,
    started: bool,
    terminal: bool,
    next_index: u32,
    tool_calls: u32,
    index_exhausted: bool,
    open: Option<(bool, u32)>,
}
fn nonnull(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}
fn string(v: Option<&Value>, default: &str) -> Result<String, DecodeError> {
    nonnull(v).map_or_else(
        || Ok(default.into()),
        |v| {
            omni_ir::js::try_to_string(Some(v))
                .map_err(|_| DecodeError::Throw("JavaScript coercion threw"))
        },
    )
}
fn usage(v: &Value) -> Usage {
    let count = |k: &str| {
        v.get(k)
            .and_then(Value::as_f64)
            .filter(|x| x.is_finite())
            .unwrap_or(0.0)
    };
    usage_from_prompt_total(
        count("promptTokenCount"),
        count("candidatesTokenCount") + count("thoughtsTokenCount"),
        count("cachedContentTokenCount"),
        0.0,
    )
}
fn length(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::from(a.len()),
        Value::String(s) => Value::from(s.encode_utf16().count()),
        _ => v
            .get("length")
            .map(omni_ir::deep::clone)
            .unwrap_or(Value::Null),
    }
}
impl AntigravityDecoder {
    fn allocate_index(&mut self, out: &mut VecDeque<StreamEvent>) -> Option<u32> {
        if self.index_exhausted {
            self.close(out);
            self.error(
                out,
                ErrorCode::Upstream,
                "Antigravity stream exceeded u32 block/tool index bound 4294967295".into(),
                false,
            );
            return None;
        }
        let index = self.next_index;
        match self.next_index.checked_add(1) {
            Some(next) => self.next_index = next,
            None => self.index_exhausted = true,
        }
        Some(index)
    }
    pub fn new(cloak: ToolCloak) -> Self {
        Self {
            cloak,
            ..Self::default()
        }
    }
    fn close(&mut self, out: &mut VecDeque<StreamEvent>) {
        if let Some((_, index)) = self.open.take() {
            out.push_back(StreamEvent::BlockEnd { index });
        }
    }
    fn error(
        &mut self,
        out: &mut VecDeque<StreamEvent>,
        code: ErrorCode,
        message: String,
        retryable: bool,
    ) -> Flow {
        self.terminal = true;
        out.push_back(StreamEvent::Error {
            code,
            message,
            retryable,
        });
        Flow::Stop
    }
    fn inner(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
        bound: usize,
    ) -> Result<Flow, DecodeError> {
        if self.terminal {
            return Ok(Flow::Stop);
        }
        if msg.data == "[DONE]" {
            return Ok(Flow::Continue);
        }
        let frame = match omni_ir::deep::parse_bounded(&msg.data, bound) {
            Ok(v) => omni_ir::deep::Owned(v),
            Err(omni_ir::deep::ParseError::Syntax) => return Ok(Flow::Continue),
            Err(omni_ir::deep::ParseError::TooDeep) => {
                return Err(DecodeError::Throw("upstream JSON exceeds depth 40000"));
            }
        };
        let frame = &frame.0;
        if !frame.is_object() && !frame.is_array() {
            return Ok(Flow::Continue);
        }
        let failure = nonnull(frame.get("error"))
            .or_else(|| frame.get("response").and_then(|r| r.get("error")));
        if let Some(f) = failure {
            self.terminal = true;
            self.close(out);
            if f.is_null() {
                return Err(DecodeError::Throw("null error payload"));
            }
            let status = string(f.get("status"), "")?;
            let code = match status.as_str() {
                "RESOURCE_EXHAUSTED" => ErrorCode::RateLimit,
                "UNAUTHENTICATED" | "PERMISSION_DENIED" => ErrorCode::Auth,
                "INVALID_ARGUMENT" | "FAILED_PRECONDITION" => ErrorCode::BadRequest,
                "DEADLINE_EXCEEDED" => ErrorCode::Timeout,
                _ => ErrorCode::Upstream,
            };
            let message = string(f.get("message"), "upstream error")?;
            return Ok(self.error(out, code, message, code.retryable()));
        }
        let Some(response) = frame.get("response") else {
            return Ok(Flow::Continue);
        };
        if response.is_null() {
            return Err(DecodeError::Throw("null response"));
        }
        let empty = Value::Array(Vec::new());
        let candidates = nonnull(response.get("candidates")).unwrap_or(&empty);
        let len_owner = omni_ir::deep::Owned(length(candidates));
        let len = &len_owner.0;
        if response
            .get("promptFeedback")
            .and_then(|p| p.get("blockReason"))
            .is_some()
            && len.as_f64() == Some(0.0)
        {
            self.terminal = true;
            if !self.started {
                out.push_back(StreamEvent::Start {
                    id: String::new(),
                    model: String::new(),
                });
            }
            self.close(out);
            out.push_back(StreamEvent::End {
                stop_reason: StopReason::ContentFilter,
                usage: usage(&response["usageMetadata"]),
                vendor: None,
            });
            return Ok(Flow::Stop);
        }
        if !self.started {
            self.started = true;
            let id = string(response.get("responseId"), "")?;
            let model = string(response.get("modelVersion"), "")?;
            out.push_back(StreamEvent::Start { id, model });
        }
        if omni_ir::js::try_to_number(Some(len))
            .map_err(|_| DecodeError::Throw("JavaScript coercion threw"))?
            > 1.0
        {
            self.terminal = true;
            self.close(out);
            let n = string(Some(len), "")?;
            return Ok(self.error(
                out,
                ErrorCode::Upstream,
                format!("Antigravity returned {n} candidates, which cannot be represented"),
                false,
            ));
        }
        let candidate = candidates
            .get(0)
            .or_else(|| candidates.get("0"))
            .unwrap_or(&Value::Null);
        let parts =
            nonnull(candidate.get("content").and_then(|c| c.get("parts"))).unwrap_or(&empty);
        if !parts.is_array() && !parts.is_string() {
            return Err(DecodeError::Throw("parts is not iterable"));
        }
        if let Some(parts) = parts.as_array() {
            for part in parts {
                if part.is_null() {
                    return Err(DecodeError::Throw("null part"));
                }
                if let Some(call) = part.get("functionCall") {
                    if call.is_null() {
                        return Err(DecodeError::Throw("null functionCall"));
                    }
                    if let Some(name) = call.get("name").and_then(Value::as_str) {
                        self.close(out);
                        let Some(index) = self.allocate_index(out) else {
                            return Ok(Flow::Stop);
                        };
                        let id = call
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("fc_{}", self.tool_calls));
                        out.push_back(StreamEvent::BlockStart {
                            index,
                            block: ContentBlockStart::ToolUse {
                                id,
                                name: self.cloak.original(name).into(),
                            },
                        });
                        let args = nonnull(call.get("args"));
                        let partial = args.map_or_else(|| "{}".into(), omni_ir::jsjson::to_string);
                        out.push_back(StreamEvent::BlockDelta {
                            index,
                            delta: Delta::ToolJson { partial },
                        });
                        out.push_back(StreamEvent::BlockEnd { index });
                        // Every tool consumes an index; index exhaustion gates the next call.
                        self.tool_calls = self.tool_calls.saturating_add(1);
                        continue;
                    }
                }
                let Some(text) = part.get("text").and_then(Value::as_str) else {
                    continue;
                };
                let thinking = part.get("thought") == Some(&Value::Bool(true));
                let index =
                    if let Some((_, index)) = self.open.filter(|(kind, _)| *kind == thinking) {
                        index
                    } else {
                        self.close(out);
                        let Some(index) = self.allocate_index(out) else {
                            return Ok(Flow::Stop);
                        };
                        self.open = Some((thinking, index));
                        out.push_back(StreamEvent::BlockStart {
                            index,
                            block: if thinking {
                                ContentBlockStart::Thinking { signed: None }
                            } else {
                                ContentBlockStart::Text
                            },
                        });
                        index
                    };
                out.push_back(StreamEvent::BlockDelta {
                    index,
                    delta: if thinking {
                        Delta::Thinking { text: text.into() }
                    } else {
                        Delta::Text { text: text.into() }
                    },
                });
            }
        }
        let Some(finish) = nonnull(candidate.get("finishReason")) else {
            return Ok(Flow::Continue);
        };
        self.terminal = true;
        self.close(out);
        let raw = string(Some(finish), "")?;
        let reason = match raw.as_str() {
            "STOP" => StopReason::EndTurn,
            "MAX_TOKENS" => StopReason::MaxTokens,
            "SAFETY" | "PROHIBITED_CONTENT" | "SPII" | "BLOCKLIST" | "RECITATION" => {
                StopReason::ContentFilter
            }
            "MALFORMED_FUNCTION_CALL" => {
                return Ok(self.error(
                    out,
                    ErrorCode::BadRequest,
                    "the model emitted a malformed function call".into(),
                    false,
                ));
            }
            _ => {
                return Ok(self.error(
                    out,
                    ErrorCode::Upstream,
                    format!("unrecognized Antigravity finish reason \"{raw}\""),
                    false,
                ));
            }
        };
        out.push_back(StreamEvent::End {
            stop_reason: if self.tool_calls > 0 {
                StopReason::ToolUse
            } else {
                reason
            },
            usage: usage(&response["usageMetadata"]),
            vendor: None,
        });
        Ok(Flow::Stop)
    }
}

impl StreamDecoder for AntigravityDecoder {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        omni_ir::deep::scope_for_bound(omni_ir::deep::depth_of(&msg.data), |bound| {
            self.inner(msg, out, bound)
        })
    }
    fn finish(&mut self, out: &mut VecDeque<StreamEvent>) {
        if !self.terminal {
            self.close(out);
            self.error(
                out,
                ErrorCode::Upstream,
                "upstream stream ended before the response finished".into(),
                true,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_exhaustion_is_terminal() {
        // Reachable histories: all tools, alternating text kinds, and mixed blocks.
        for scenario in ["tools", "text", "mixed", "continuing-text"] {
            let mut decoder = AntigravityDecoder {
                next_index: u32::MAX - 1,
                tool_calls: if scenario == "tools" { u32::MAX - 1 } else { 0 },
                ..Default::default()
            };
            let mut out = VecDeque::new();
            for (step, expected) in [(0, Flow::Continue), (1, Flow::Continue), (2, Flow::Stop)] {
                let part = if scenario == "tools" || (scenario == "mixed" && step == 0) {
                    serde_json::json!({"functionCall":{"name":"x"}})
                } else {
                    serde_json::json!({"text":"x","thought":step == 1})
                };
                let msg = SseMessage { event: "message".into(), data: serde_json::json!({"response":{"candidates":[{"content":{"parts":[part]}}]}}).to_string() };
                assert_eq!(
                    decoder.message(&msg, &mut out).expect("counter frame"),
                    expected
                );
                if scenario == "continuing-text" && step == 1 {
                    assert!(decoder.index_exhausted);
                    let before = out.len();
                    assert_eq!(decoder.message(&msg, &mut out).unwrap(), Flow::Continue);
                    assert_eq!(out.len(), before + 1);
                    assert!(matches!(out.back(), Some(StreamEvent::BlockDelta {
                        index: u32::MAX, delta: Delta::Thinking { text }
                    }) if text == "x"));
                }
            }
            let ids: Vec<_> = out
                .iter()
                .filter_map(|e| match e {
                    StreamEvent::BlockStart {
                        block: ContentBlockStart::ToolUse { id, .. },
                        ..
                    } => Some(id.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(
                ids,
                match scenario {
                    "tools" => vec!["fc_4294967294", "fc_4294967295"],
                    "mixed" => vec!["fc_0"],
                    _ => vec![],
                }
            );
            let indices: Vec<_> = out
                .iter()
                .filter_map(|e| match e {
                    StreamEvent::BlockStart { index, .. } => Some(*index),
                    _ => None,
                })
                .collect();
            assert_eq!(indices, [u32::MAX - 1, u32::MAX]);
            assert!(
                matches!(out.get(out.len()-2), Some(StreamEvent::BlockEnd { index }) if *index == u32::MAX)
            );
            assert!(
                matches!(out.back(), Some(StreamEvent::Error {code:ErrorCode::Upstream,message,retryable:false}) if message == "Antigravity stream exceeded u32 block/tool index bound 4294967295")
            );
            let before = out.len();
            assert_eq!(
                decoder
                    .message(
                        &SseMessage {
                            event: String::new(),
                            data: "{}".into()
                        },
                        &mut out
                    )
                    .expect("terminal frame"),
                Flow::Stop
            );
            decoder.finish(&mut out);
            assert_eq!(out.len(), before);
        }
    }
}
