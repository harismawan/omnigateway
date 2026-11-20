//! Anthropic Messages egress: `egress/anthropic.ts`.

use std::collections::{HashMap, HashSet};

use omni_ir::error::ErrorCode;
use omni_ir::jsjson::{JsValue, Spread, write_js_spread, write_number, write_value};
use omni_ir::stream::{
    CollectedBlock, CollectedResponse, ContentBlockStart, Delta, StopReason, StreamEvent, Usage,
};
use omni_ir::text::Text;
use omni_ratelimit::HeadroomByDimension;
use serde_json::{Map, Value};

use super::{Obj, begin_frame, end_frame, js_string, reported};

fn stop_reason(s: StopReason) -> &'static str {
    match s {
        StopReason::EndTurn => "end_turn",
        StopReason::MaxTokens => "max_tokens",
        StopReason::StopSequence => "stop_sequence",
        StopReason::ToolUse => "tool_use",
        StopReason::ContentFilter => "refusal",
        StopReason::PauseTurn => "pause_turn",
    }
}

/// `ERROR_TYPE`.
pub fn error_type(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::Auth => "authentication_error",
        ErrorCode::RateLimit | ErrorCode::QuotaExhausted => "rate_limit_error",
        ErrorCode::Overloaded | ErrorCode::NoCandidates => "overloaded_error",
        ErrorCode::BadRequest
        | ErrorCode::Conflict
        | ErrorCode::ContentFilter
        | ErrorCode::CapabilityMismatch
        | ErrorCode::FingerprintRefused => "invalid_request_error",
        ErrorCode::ModelUnavailable => "not_found_error",
        ErrorCode::Upstream
        | ErrorCode::Timeout
        | ErrorCode::Network
        | ErrorCode::AllCandidatesFailed
        | ErrorCode::Internal => "api_error",
    }
}

fn write_usage(u: &Usage, out: &mut String) {
    let mut o = Obj::new(out);
    o.num("input_tokens", u.input_tokens)
        .value("output_tokens", &u.client_output())
        .value("cache_read_input_tokens", &u.client_cache_read())
        .num("cache_creation_input_tokens", u.cache_write_tokens);
    o.close();
}

/// `safeguardFields`: `safeguard_results` from `vendor.anthropic`, alone.
fn safeguard(vendor: Option<&Map<String, Value>>) -> Option<&Value> {
    vendor?
        .get("anthropic")?
        .as_object()?
        .get("safeguard_results")
}

/// `{ ...data, type }` as a value, for the buffered body (built once per
/// block, not per delta).
fn with_type_last(data: &JsValue, t: &str) -> JsValue {
    let mut data = data.clone();
    data.put("type".encode_utf16().collect(), t.into());
    data
}

/// `anthropicStream`, one event at a time.
pub struct AnthropicStream {
    request_id: String,
    model: Text,
    suppressed: HashSet<u32>,
    out_index: HashMap<u32, u32>,
    next_out_index: u32,
}

impl AnthropicStream {
    pub fn new(request_id: &str) -> AnthropicStream {
        AnthropicStream {
            request_id: request_id.to_string(),
            model: Text::default(),
            suppressed: HashSet::new(),
            out_index: HashMap::new(),
            next_out_index: 0,
        }
    }

    fn index(&self, ir: u32) -> u32 {
        self.out_index.get(&ir).copied().unwrap_or(ir)
    }

    pub fn push(&mut self, event: &StreamEvent, out: &mut String) {
        if event.has_json_payload() {
            return omni_ir::deep::scope(|| self.push_inner(event, out));
        }
        self.push_inner(event, out);
    }
    fn push_inner(&mut self, event: &StreamEvent, out: &mut String) {
        match event {
            StreamEvent::Start { model, .. } => {
                self.model.clone_from(model);
                begin_frame("message_start", out);
                out.push_str(r#"{"type":"message_start","message":{"id":"#);
                omni_ir::jsjson::write_str(&self.request_id, out);
                out.push_str(r#","type":"message","role":"assistant","model":"#);
                self.model.write_json(out);
                out.push_str(
                    r#","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
                );
                end_frame(out);
            }
            StreamEvent::BlockStart { index, block } => {
                if let ContentBlockStart::Thinking { signed } = block
                    && *signed != Some(true)
                {
                    self.suppressed.insert(*index);
                    return;
                }
                let at = self.next_out_index;
                self.next_out_index += 1;
                self.out_index.insert(*index, at);
                begin_frame("content_block_start", out);
                out.push_str(r#"{"type":"content_block_start","index":"#);
                write_number(f64::from(at), out);
                out.push_str(r#","content_block":"#);
                match block {
                    ContentBlockStart::Text => out.push_str(r#"{"type":"text","text":""}"#),
                    ContentBlockStart::Thinking { .. } => {
                        out.push_str(r#"{"type":"thinking","thinking":""}"#);
                    }
                    ContentBlockStart::ProviderNative {
                        block_type, data, ..
                    } => write_js_spread(data, "type", block_type, Spread::KeyLast, out),
                    ContentBlockStart::ToolUse { id, name } => {
                        let mut o = Obj::new(out);
                        o.str("type", "tool_use").text("id", id).text("name", name);
                        o.raw("input", "{}");
                        o.close();
                    }
                }
                out.push('}');
                end_frame(out);
            }
            StreamEvent::BlockDelta { index, delta } => {
                if self.suppressed.contains(index) {
                    return;
                }
                begin_frame("content_block_delta", out);
                out.push_str(r#"{"type":"content_block_delta","index":"#);
                write_number(f64::from(self.index(*index)), out);
                out.push_str(r#","delta":"#);
                match delta {
                    Delta::Text { text } => {
                        Obj::new(out)
                            .str("type", "text_delta")
                            .text("text", text)
                            .close_ref();
                    }
                    Delta::Thinking { text } => {
                        Obj::new(out)
                            .str("type", "thinking_delta")
                            .text("thinking", text)
                            .close_ref();
                    }
                    Delta::ThinkingSignature { signature } => {
                        Obj::new(out)
                            .str("type", "signature_delta")
                            .text("signature", signature)
                            .close_ref();
                    }
                    Delta::ProviderNative {
                        delta_type, data, ..
                    } => write_js_spread(data, "type", delta_type, Spread::KeyFirst, out),
                    Delta::ToolJson { partial } | Delta::ProviderNativeJson { partial, .. } => {
                        Obj::new(out)
                            .str("type", "input_json_delta")
                            .text("partial_json", partial)
                            .close_ref();
                    }
                }
                out.push('}');
                end_frame(out);
            }
            StreamEvent::BlockEnd { index } => {
                if self.suppressed.contains(index) {
                    return;
                }
                begin_frame("content_block_stop", out);
                out.push_str(r#"{"type":"content_block_stop","index":"#);
                write_number(f64::from(self.index(*index)), out);
                out.push('}');
                end_frame(out);
            }
            StreamEvent::End {
                stop_reason: s,
                usage,
                vendor,
            } => {
                begin_frame("message_delta", out);
                out.push_str(r#"{"type":"message_delta","delta":{"stop_reason":"#);
                omni_ir::jsjson::write_str(stop_reason(*s), out);
                out.push_str(r#","stop_sequence":null"#);
                if let Some(v) = safeguard(vendor.as_ref()) {
                    out.push_str(r#","safeguard_results":"#);
                    write_value(v, out);
                }
                out.push_str(r#"},"usage":"#);
                write_usage(usage, out);
                out.push('}');
                end_frame(out);
                begin_frame("message_stop", out);
                out.push_str(r#"{"type":"message_stop"}"#);
                end_frame(out);
            }
            StreamEvent::Error { code, message, .. } => {
                begin_frame("error", out);
                out.push_str(r#"{"type":"error","error":"#);
                Obj::new(out)
                    .str("type", error_type(*code))
                    .text("message", message)
                    .close_ref();
                out.push('}');
                end_frame(out);
            }
        }
    }
}

fn usage_value(u: &Usage) -> JsValue {
    JsValue::object([
        ("input_tokens", u.input_tokens.into()),
        ("output_tokens", u.client_output()),
        ("cache_read_input_tokens", u.client_cache_read()),
        ("cache_creation_input_tokens", u.cache_write_tokens.into()),
    ])
}

/// `anthropicResponse`.
pub fn response(collected: &CollectedResponse, request_id: &str) -> JsValue {
    let content = collected
        .content
        .iter()
        .filter_map(|b| match b {
            CollectedBlock::Text { text, citations } => Some(JsValue::object([
                ("type", "text".into()),
                ("text", text.into()),
                (
                    "citations",
                    if citations.is_empty() {
                        JsValue::Undefined
                    } else {
                        JsValue::Array(citations.clone())
                    },
                ),
            ])),
            CollectedBlock::Thinking { text, signature } => {
                signature.as_ref().filter(|s| !s.is_empty()).map(|s| {
                    JsValue::object([
                        ("type", "thinking".into()),
                        ("thinking", text.into()),
                        ("signature", s.into()),
                    ])
                })
            }
            CollectedBlock::ToolUse { id, name, input } => Some(JsValue::object([
                ("type", "tool_use".into()),
                ("id", id.into()),
                ("name", name.into()),
                ("input", input.clone()),
            ])),
            CollectedBlock::ProviderNative {
                data, block_type, ..
            } => Some(with_type_last(data, block_type)),
        })
        .collect();
    JsValue::object([
        (
            "safeguard_results",
            safeguard(collected.vendor.as_ref()).map_or(JsValue::Undefined, JsValue::from),
        ),
        ("id", request_id.into()),
        ("type", "message".into()),
        ("role", "assistant".into()),
        ("model", (&collected.model).into()),
        ("content", JsValue::Array(content)),
        ("stop_reason", stop_reason(collected.stop_reason).into()),
        ("stop_sequence", JsValue::Null),
        ("usage", usage_value(&collected.usage)),
    ])
}

/// `anthropicErrorBody`.
pub fn error_body(code: ErrorCode, message: &Text) -> JsValue {
    JsValue::object([
        ("type", "error".into()),
        (
            "error",
            JsValue::object([
                ("type", error_type(code).into()),
                ("message", message.into()),
            ]),
        ),
    ])
}

/// `rfc3339`: whole seconds, rounded up, as `toISOString().slice(0, 19) + "Z"`.
///
/// `None` where `toISOString` throws (an instant outside ±8.64e15 ms); TS
/// would fail the response there, Rust leaves the header out.
fn rfc3339(at: f64) -> Option<String> {
    let ms = (at / 1000.0).ceil() * 1000.0;
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    // In range, so exact as an integer.
    #[allow(clippy::cast_possible_truncation)]
    let secs = (ms / 1000.0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, mo, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    let iso = format!(
        "{year}-{mo:02}-{d:02}T{:02}:{:02}:{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    );
    // `.slice(0, 19)` of the full ISO string: the expanded-year form is three
    // characters longer, so it loses the seconds.
    Some(format!("{}Z", &iso[..19]))
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let d = u32::try_from(d).unwrap_or(1);
    let m = u32::try_from(m).unwrap_or(1);
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `anthropicRateLimitHeaders`.
pub fn rate_limit_headers(headroom: &HeadroomByDimension) -> Vec<(String, String)> {
    let mut headers = Vec::new();
    for (dimension, entry) in reported(headroom) {
        let Some(entry) = entry else { continue };
        headers.push((
            format!("anthropic-ratelimit-{dimension}-limit"),
            js_string(entry.limit),
        ));
        headers.push((
            format!("anthropic-ratelimit-{dimension}-remaining"),
            js_string(entry.remaining),
        ));
        if let Some(reset) = rfc3339(entry.reset_at) {
            headers.push((format!("anthropic-ratelimit-{dimension}-reset"), reset));
        }
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instants_render_like_to_iso_string() {
        assert_eq!(rfc3339(0.0).as_deref(), Some("1970-01-01T00:00:00Z"));
        assert_eq!(rfc3339(1.0).as_deref(), Some("1970-01-01T00:00:01Z"));
        assert_eq!(
            rfc3339(951_782_400_000.0).as_deref(),
            Some("2000-02-29T00:00:00Z")
        );
        assert_eq!(rfc3339(-1.0).as_deref(), Some("1970-01-01T00:00:00Z"));
        assert_eq!(rfc3339(-1001.0).as_deref(), Some("1969-12-31T23:59:59Z"));
        assert_eq!(rfc3339(f64::NAN), None);
        assert_eq!(rfc3339(8.7e15), None);
    }
}
