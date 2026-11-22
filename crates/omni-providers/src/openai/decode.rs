//! OpenAI Responses SSE semantics. Arbitrary payloads remain scoped;
//! emitted native maps use the IR's iterative ownership implementation.
use crate::{
    codec::{DecodeError, Flow, StreamDecoder},
    sse::SseMessage,
};
use omni_ir::{
    deep,
    error::ErrorCode,
    jsjson::{self, JsValue as Value},
    stream::{
        ContentBlockStart, Delta, NativeFold, StopReason, StreamEvent, usage_from_prompt_total,
    },
    text::Text,
};
use std::collections::VecDeque;
const KNOWN: &[&str] = &[
    "keepalive",
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
    "response.metadata",
    "response.completed",
    "response.incomplete",
    "response.failed",
    "error",
];
pub struct OpenAiDecoder {
    native: bool,
    indices: Vec<Text>,
    // Only primitives can match a later JSON payload under JS SameValueZero.
    owns: Vec<Value>,
    tool: bool,
    terminal: bool,
}
impl OpenAiDecoder {
    pub fn new(native_reasoning: bool) -> Self {
        Self {
            native: native_reasoning,
            indices: Vec::new(),
            owns: Vec::new(),
            tool: false,
            terminal: false,
        }
    }
    fn index(
        &mut self,
        output: Option<&Value>,
        content: Option<&Value>,
    ) -> Result<u32, DecodeError> {
        // The index key is a template string, not a two-part tuple.
        let mut key = string(output)?.surrounded("", ":");
        key.push(&string(content)?);
        if let Some(i) = self.indices.iter().position(|k| k == &key) {
            return Ok(i as u32);
        }
        self.indices.push(key);
        Ok((self.indices.len() - 1) as u32)
    }
}
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|v| v.get(key))
}
fn nullish_or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    a.filter(|v| !v.is_null()).or(b)
}
fn string(v: Option<&Value>) -> Result<Text, DecodeError> {
    jsjson::coerce_text(v).map_err(|_| DecodeError::Throw("JavaScript coercion threw"))
}
fn index_value(v: Option<&Value>) -> Option<&Value> {
    nullish_or(v, None)
}
fn key(v: Option<&Value>) -> Option<Value> {
    match index_value(v) {
        None => Some(0.0.into()),
        Some(Value::Array(_) | Value::Object(_)) => None,
        Some(v) => Some(v.clone()),
    }
}
fn text(v: Option<&Value>) -> Result<Text, DecodeError> {
    nullish_or(v, None)
        .map(|v| string(Some(v)))
        .unwrap_or_else(|| Ok(Text::default()))
}
fn error(out: &mut VecDeque<StreamEvent>, message: Text) {
    out.push_back(StreamEvent::Error {
        code: ErrorCode::Upstream,
        message,
        retryable: false,
    });
}
impl StreamDecoder for OpenAiDecoder {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        if msg.data == "[DONE]" {
            return Ok(Flow::Continue);
        }
        if !KNOWN.contains(&msg.event.as_str()) {
            error(
                out,
                format!("unrecognized OpenAI stream event \"{}\"", msg.event).into(),
            );
            return Ok(Flow::Stop);
        }
        let depth = deep::depth_of(&msg.data);
        if depth > deep::MAX_DEPTH {
            return Err(DecodeError::Throw("upstream JSON exceeds depth 40000"));
        }
        deep::scope_for_bound(depth, |_| {
            let Ok(parsed) = jsjson::parse_bounded(&msg.data, depth) else {
                return Ok(Flow::Continue);
            };
            if !parsed.is_object() && !parsed.is_array() {
                return Ok(Flow::Continue);
            }
            let d = Some(&parsed);
            let zero = Value::from(0.0);
            let output = Some(index_value(prop(d, "output_index")).unwrap_or(&zero));
            let content = Some(index_value(prop(d, "content_index")).unwrap_or(&zero));
            let item = prop(d, "item");
            match msg.event.as_str() {
                "response.created" => {
                    let r = prop(d, "response");
                    out.push_back(StreamEvent::Start {
                        id: text(prop(r, "id"))?,
                        model: text(prop(r, "model"))?,
                    });
                }
                "response.output_item.added" => {
                    let kind = prop(item, "type").and_then(Value::as_text);
                    let kind = kind.as_ref().and_then(Text::as_utf8);
                    if matches!(kind, Some("reasoning" | "function_call")) {
                        if let Some(k) = key(output)
                            && !self.owns.contains(&k)
                        {
                            self.owns.push(k);
                        }
                        let index = self.index(output, Some(&zero))?;
                        let block = if kind == Some("function_call") {
                            self.tool = true;
                            ContentBlockStart::ToolUse {
                                id: string(prop(item, "call_id"))?,
                                name: string(prop(item, "name"))?,
                            }
                        } else if self.native {
                            ContentBlockStart::ProviderNative {
                                provider: "openai".into(),
                                block_type: "reasoning".into(),
                                data: Value::Object(Vec::new()),
                            }
                        } else {
                            ContentBlockStart::Thinking { signed: None }
                        };
                        out.push_back(StreamEvent::BlockStart { index, block });
                    }
                }
                "response.content_part.added" => {
                    if prop(prop(d, "part"), "type")
                        .and_then(Value::as_text)
                        .is_some_and(|t| t == "output_text")
                    {
                        out.push_back(StreamEvent::BlockStart {
                            index: self.index(output, content)?,
                            block: ContentBlockStart::Text,
                        });
                    }
                }
                "response.output_text.delta" => out.push_back(StreamEvent::BlockDelta {
                    index: self.index(output, content)?,
                    delta: Delta::Text {
                        text: text(prop(d, "delta"))?,
                    },
                }),
                "response.function_call_arguments.delta" => {
                    out.push_back(StreamEvent::BlockDelta {
                        index: self.index(output, Some(&zero))?,
                        delta: Delta::ToolJson {
                            partial: text(prop(d, "delta"))?,
                        },
                    })
                }
                "response.reasoning_summary_text.delta" => {
                    let index = self.index(output, Some(&zero))?;
                    let t = text(prop(d, "delta"))?;
                    let delta = if self.native {
                        let data = Value::object([("text", (&t).into())]);
                        Delta::ProviderNative {
                            provider: "openai".into(),
                            delta_type: "reasoning_summary_text.delta".into(),
                            data,
                            fold: None,
                        }
                    } else {
                        Delta::Thinking { text: t }
                    };
                    out.push_back(StreamEvent::BlockDelta { index, delta });
                }
                "response.content_part.done" => out.push_back(StreamEvent::BlockEnd {
                    index: self.index(output, content)?,
                }),
                "response.output_item.done" => {
                    if let Some(at) =
                        key(output).and_then(|k| self.owns.iter().position(|v| v == &k))
                    {
                        self.owns.remove(at);
                        let index = self.index(output, Some(&zero))?;
                        if self.native
                            && prop(item, "type")
                                .and_then(Value::as_text)
                                .is_some_and(|t| t == "reasoning")
                        {
                            let data = item
                                .filter(|v| v.is_object())
                                .cloned()
                                .unwrap_or_else(|| Value::Object(Vec::new()));
                            out.push_back(StreamEvent::BlockDelta {
                                index,
                                delta: Delta::ProviderNative {
                                    provider: "openai".into(),
                                    delta_type: "response.output_item.done".into(),
                                    data,
                                    fold: Some(NativeFold::Merge),
                                },
                            });
                        }
                        out.push_back(StreamEvent::BlockEnd { index });
                    }
                }
                "response.completed" | "response.incomplete" => {
                    self.terminal = true;
                    let r = prop(d, "response");
                    let reason = prop(prop(r, "incomplete_details"), "reason");
                    let status = prop(r, "status");
                    let reason_text = reason.and_then(Value::as_text);
                    let stop = match reason_text.as_ref().and_then(Text::as_utf8) {
                        Some("max_output_tokens") => StopReason::MaxTokens,
                        Some("content_filter") => StopReason::ContentFilter,
                        _ => {
                            if reason.is_some()
                                || msg.event == "response.incomplete"
                                || status
                                    .is_some_and(|s| !s.as_text().is_some_and(|t| t == "completed"))
                            {
                                let message = if reason.is_some() {
                                    string(reason)?.surrounded(
                                        "unrecognized OpenAI incomplete reason \"",
                                        "\"",
                                    )
                                } else if status.is_some_and(|s| {
                                    !s.as_text().is_some_and(|t| t == "incomplete")
                                }) {
                                    string(status)?.surrounded(
                                        "OpenAI reported terminal response status \"",
                                        "\"",
                                    )
                                } else {
                                    "OpenAI reported the response incomplete without a reason"
                                        .into()
                                };
                                error(out, message);
                                return Ok(Flow::Continue);
                            }
                            if self.tool {
                                StopReason::ToolUse
                            } else {
                                StopReason::EndTurn
                            }
                        }
                    };
                    let u = prop(r, "usage");
                    let checked = |v| {
                        jsjson::coerce_number(nullish_or(v, None).or(Some(&zero)))
                            .map_err(|_| DecodeError::Throw("JavaScript coercion threw"))
                    };
                    let output = nullish_or(prop(u, "output_tokens"), Some(&zero)).unwrap_or(&zero);
                    let cached = nullish_or(
                        nullish_or(
                            prop(prop(u, "input_tokens_details"), "cached_tokens"),
                            prop(prop(u, "prompt_tokens_details"), "cached_tokens"),
                        ),
                        Some(&zero),
                    )
                    .unwrap_or(&zero);
                    let mut usage = usage_from_prompt_total(
                        checked(prop(u, "input_tokens"))?,
                        jsjson::coerce_number(Some(output)).unwrap_or(f64::NAN),
                        checked(Some(cached))?,
                        0.0,
                    );
                    usage.raw_output_tokens =
                        output.as_f64().is_none().then(|| Box::new(output.clone()));
                    usage.raw_cache_read_tokens =
                        cached.as_f64().is_none().then(|| Box::new(cached.clone()));
                    out.push_back(StreamEvent::End {
                        stop_reason: stop,
                        usage,
                        vendor: None,
                    });
                }
                "response.failed" | "error" => {
                    self.terminal = true;
                    let e = nullish_or(prop(prop(d, "response"), "error"), prop(d, "error"));
                    let raw = string(nullish_or(prop(e, "code"), prop(e, "type")))?;
                    let code = match raw.as_utf8() {
                        Some("rate_limit_exceeded") => ErrorCode::RateLimit,
                        Some("insufficient_quota") => ErrorCode::QuotaExhausted,
                        Some("invalid_api_key") => ErrorCode::Auth,
                        Some("context_length_exceeded") => ErrorCode::BadRequest,
                        Some("content_policy_violation") => ErrorCode::ContentFilter,
                        _ => ErrorCode::Upstream,
                    };
                    out.push_back(StreamEvent::Error {
                        code,
                        message: nullish_or(prop(e, "message"), None)
                            .map(|v| string(Some(v)))
                            .unwrap_or_else(|| Ok("upstream error".into()))?,
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
                retryable: true,
            });
        }
    }
}
