//! OpenAI Chat Completions egress: `egress/openai.ts`.

use std::collections::HashMap;

use omni_ir::deep::Owned;
use omni_ir::error::ErrorCode;
use omni_ir::jsjson::{write_number, write_str};
use omni_ir::request::ContentBlock;
use omni_ir::stream::{
    CollectedResponse, ContentBlockStart, Delta, StopReason, StreamEvent, Usage, number,
    prompt_tokens,
};
use omni_ratelimit::HeadroomByDimension;
use serde_json::{Map, Value, json};

use super::{Obj, begin_frame, end_frame, js_max0, js_string, reported};

fn finish_reason(s: StopReason) -> &'static str {
    match s {
        StopReason::EndTurn | StopReason::StopSequence | StopReason::PauseTurn => "stop",
        StopReason::MaxTokens => "length",
        StopReason::ToolUse => "tool_calls",
        StopReason::ContentFilter => "content_filter",
    }
}

/// `ERROR_TYPE`: `(type, code)`, shared with the Responses dialect.
pub fn error_type(code: ErrorCode) -> (&'static str, &'static str) {
    match code {
        ErrorCode::Auth => ("invalid_request_error", "invalid_api_key"),
        ErrorCode::RateLimit => ("rate_limit_error", "rate_limit_exceeded"),
        ErrorCode::QuotaExhausted => ("insufficient_quota", "insufficient_quota"),
        ErrorCode::Overloaded
        | ErrorCode::Upstream
        | ErrorCode::Network
        | ErrorCode::AllCandidatesFailed
        | ErrorCode::Internal => ("server_error", "server_error"),
        ErrorCode::BadRequest | ErrorCode::CapabilityMismatch | ErrorCode::FingerprintRefused => {
            ("invalid_request_error", "invalid_request")
        }
        ErrorCode::Conflict => ("invalid_request_error", "conflict"),
        ErrorCode::ContentFilter => ("invalid_request_error", "content_policy_violation"),
        ErrorCode::ModelUnavailable => ("invalid_request_error", "model_not_found"),
        ErrorCode::Timeout => ("server_error", "timeout"),
        ErrorCode::NoCandidates => ("server_error", "service_unavailable"),
    }
}

fn write_usage(u: &Usage, out: &mut String) {
    let prompt = prompt_tokens(u);
    let mut o = Obj::new(out);
    o.num("prompt_tokens", prompt)
        .num("completion_tokens", u.output_tokens)
        .num("total_tokens", prompt + u.output_tokens);
    let d = o.key("prompt_tokens_details");
    d.push_str(r#"{"cached_tokens":"#);
    write_number(u.cache_read_tokens, d);
    d.push('}');
    o.close();
}

fn usage_value(u: &Usage) -> Value {
    let prompt = prompt_tokens(u);
    json!({
        "prompt_tokens": number(prompt),
        "completion_tokens": number(u.output_tokens),
        "total_tokens": number(prompt + u.output_tokens),
        "prompt_tokens_details": { "cached_tokens": number(u.cache_read_tokens) },
    })
}

/// `openaiStream`, one event at a time.
pub struct OpenAiStream {
    request_id: String,
    created: i64,
    model: String,
    role_sent: bool,
    completed: bool,
    tool_index: HashMap<u32, u32>,
}

impl OpenAiStream {
    pub fn new(request_id: &str, created: i64) -> OpenAiStream {
        OpenAiStream {
            request_id: request_id.to_string(),
            created,
            model: String::new(),
            role_sent: false,
            completed: false,
            tool_index: HashMap::new(),
        }
    }

    /// Writes `chunk(...)` up to and including the `choices` array opening and
    /// the choice's `"index":0,"delta":`; the caller writes the delta.
    fn chunk_head(&self, out: &mut String) {
        begin_frame("message", out);
        out.push_str(r#"{"id":"#);
        write_str(&self.request_id, out);
        out.push_str(r#","object":"chat.completion.chunk","created":"#);
        #[allow(clippy::cast_precision_loss)]
        write_number(self.created as f64, out);
        out.push_str(r#","model":"#);
        write_str(&self.model, out);
        out.push_str(r#","choices":[{"index":0,"delta":"#);
    }

    fn chunk_tail(out: &mut String) {
        out.push_str(r#","finish_reason":null}]}"#);
        end_frame(out);
    }

    pub fn push(&mut self, event: &StreamEvent, out: &mut String) {
        if event.has_json_payload() {
            return omni_ir::deep::scope(|| self.push_inner(event, out));
        }
        self.push_inner(event, out);
    }
    fn push_inner(&mut self, event: &StreamEvent, out: &mut String) {
        match event {
            StreamEvent::Start { model, .. } => self.model.clone_from(model),
            StreamEvent::BlockStart { index, block } => match block {
                ContentBlockStart::Text => {
                    if !self.role_sent {
                        self.role_sent = true;
                        self.chunk_head(out);
                        out.push_str(r#"{"role":"assistant","content":""}"#);
                        Self::chunk_tail(out);
                    }
                }
                ContentBlockStart::Thinking { .. } => {
                    if !self.role_sent {
                        self.role_sent = true;
                        self.chunk_head(out);
                        out.push_str(r#"{"role":"assistant"}"#);
                        Self::chunk_tail(out);
                    }
                }
                ContentBlockStart::ToolUse { id, name } => {
                    let at = u32::try_from(self.tool_index.len()).unwrap_or(u32::MAX);
                    self.tool_index.insert(*index, at);
                    let first_role = !self.role_sent;
                    self.role_sent = true;
                    self.chunk_head(out);
                    out.push('{');
                    if first_role {
                        out.push_str(r#""role":"assistant","#);
                    }
                    out.push_str(r#""tool_calls":[{"index":"#);
                    write_number(f64::from(at), out);
                    out.push_str(r#","id":"#);
                    write_str(id, out);
                    out.push_str(r#","type":"function","function":{"name":"#);
                    write_str(name, out);
                    out.push_str(r#","arguments":""}}]}"#);
                    Self::chunk_tail(out);
                }
                ContentBlockStart::ProviderNative { .. } => {}
            },
            StreamEvent::BlockDelta { index, delta } => match delta {
                Delta::Text { text } => {
                    self.chunk_head(out);
                    out.push_str(r#"{"content":"#);
                    write_str(text, out);
                    out.push('}');
                    Self::chunk_tail(out);
                }
                Delta::Thinking { text } => {
                    self.chunk_head(out);
                    out.push_str(r#"{"reasoning_content":"#);
                    write_str(text, out);
                    out.push('}');
                    Self::chunk_tail(out);
                }
                Delta::ToolJson { partial } => {
                    let at = self.tool_index.get(index).copied().unwrap_or(0);
                    self.chunk_head(out);
                    out.push_str(r#"{"tool_calls":[{"index":"#);
                    write_number(f64::from(at), out);
                    out.push_str(r#","function":{"arguments":"#);
                    write_str(partial, out);
                    out.push_str("}}]}");
                    Self::chunk_tail(out);
                }
                _ => {}
            },
            StreamEvent::BlockEnd { .. } => {}
            StreamEvent::End {
                stop_reason, usage, ..
            } => {
                self.completed = true;
                self.chunk_head(out);
                out.push_str(r#"{},"finish_reason":"#);
                write_str(finish_reason(*stop_reason), out);
                out.push_str("}],\"usage\":");
                write_usage(usage, out);
                out.push('}');
                end_frame(out);
            }
            StreamEvent::Error { code, message, .. } => {
                let (t, c) = error_type(*code);
                begin_frame("message", out);
                out.push_str(r#"{"error":"#);
                Obj::new(out)
                    .str("message", message)
                    .str("type", t)
                    .str("code", c)
                    .close_ref();
                out.push('}');
                end_frame(out);
            }
        }
    }

    pub fn finish(&mut self, out: &mut String) {
        if self.completed {
            begin_frame("message", out);
            out.push_str("[DONE]");
            end_frame(out);
        }
    }
}

/// `openaiResponse`.
/// The body holds client payloads (tool inputs, native blocks), so it is
/// returned as a [`Owned`] that drops iteratively.
pub fn response(collected: &CollectedResponse, request_id: &str, created: i64) -> Owned {
    Owned(response_value(collected, request_id, created))
}

fn response_value(collected: &CollectedResponse, request_id: &str, created: i64) -> Value {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    for b in &collected.content {
        match b {
            ContentBlock::Text(t) => text.push_str(&t.text),
            ContentBlock::Thinking(t) => reasoning.push_str(&t.text),
            ContentBlock::ToolUse(t) => tool_calls.push(json!({
                "id": t.id,
                "type": "function",
                "function": { "name": t.name, "arguments": omni_ir::jsjson::to_string(&t.input) },
            })),
            _ => {}
        }
    }
    let mut message = Map::new();
    message.insert("role".into(), "assistant".into());
    message.insert(
        "content".into(),
        if !tool_calls.is_empty() && text.is_empty() {
            Value::Null
        } else {
            Value::String(text)
        },
    );
    if !reasoning.is_empty() {
        message.insert("reasoning_content".into(), Value::String(reasoning));
    }
    if !tool_calls.is_empty() {
        message.insert("tool_calls".into(), Value::Array(tool_calls));
    }
    #[allow(clippy::cast_precision_loss)]
    let created = number(created as f64);
    json!({
        "id": request_id,
        "object": "chat.completion",
        "created": created,
        "model": collected.model,
        "choices": [{
            "index": 0,
            "message": Value::Object(message),
            "finish_reason": finish_reason(collected.stop_reason),
        }],
        "usage": usage_value(&collected.usage),
    })
}

/// `openaiErrorBody`.
pub fn error_body(code: ErrorCode, message: &str) -> Value {
    let (t, c) = error_type(code);
    json!({ "error": { "message": message, "type": t, "code": c } })
}

/// `duration`: `4h51m22s`, `6m0s`, `22s`; whole seconds rounded up.
fn duration(ms: f64) -> String {
    let total = js_max0((ms / 1000.0).ceil());
    if !total.is_finite() {
        // `Math.floor(Infinity / 3600)` is `Infinity`; NaN stays NaN.
        let s = js_string(total);
        return if total.is_nan() {
            format!("{s}s")
        } else {
            format!("{s}h{}m{}s", js_string(f64::NAN), js_string(f64::NAN))
        };
    }
    let hours = (total / 3600.0).floor();
    let minutes = ((total % 3600.0) / 60.0).floor();
    let seconds = total % 60.0;
    let (h, m, s) = (js_string(hours), js_string(minutes), js_string(seconds));
    if hours > 0.0 {
        format!("{h}h{m}m{s}s")
    } else if minutes > 0.0 {
        format!("{m}m{s}s")
    } else {
        format!("{s}s")
    }
}

/// `openaiRateLimitHeaders` (also `responsesRateLimitHeaders`).
pub fn rate_limit_headers(headroom: &HeadroomByDimension, now: f64) -> Vec<(String, String)> {
    let mut headers = Vec::new();
    for (dimension, entry) in reported(headroom) {
        let Some(entry) = entry else { continue };
        headers.push((
            format!("x-ratelimit-limit-{dimension}"),
            js_string(entry.limit),
        ));
        headers.push((
            format!("x-ratelimit-remaining-{dimension}"),
            js_string(entry.remaining),
        ));
        headers.push((
            format!("x-ratelimit-reset-{dimension}"),
            duration(entry.reset_at - now),
        ));
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_match_ts() {
        assert_eq!(duration(0.0), "0s");
        assert_eq!(duration(-5.0), "0s");
        assert_eq!(duration(1.0), "1s");
        assert_eq!(duration(60_000.0), "1m0s");
        assert_eq!(duration(3_600_000.0), "1h0m0s");
        assert_eq!(duration(17_482_000.0), "4h51m22s");
        assert_eq!(duration(f64::NAN), "NaNs");
    }
}
