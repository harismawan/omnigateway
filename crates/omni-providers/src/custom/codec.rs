//! A custom OpenAI-compatible endpoint as a codec (`packages/providers/src/custom/codec.ts`).

use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::jsjson;
use serde_json::Value;

use super::decode::{ChatDecoder, ResponsesDecoder};
use super::wire::{to_custom_chat_wire, to_custom_responses_wire};
use crate::codec::{CodecHttpRequest, CodecInput, CodecRequest, ProviderCodec, StreamDecoder};
use crate::http::Headers;

/// The endpoint's dialect, a property of the credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    ChatCompletions,
    Responses,
}

/// The custom codec. The protocol travels to the decoder as its state.
#[derive(Debug, Clone, Copy, Default)]
pub struct CustomCodec;

/// `fail(code, message)`: provider restamped by the host, never authored.
fn fail(code: ErrorCode, message: &str) -> GatewayError {
    GatewayError::new(code, message).with_provider("custom")
}

/// `endpointUrl`: joins origin and base path, adding `/v1` unless the path
/// already ends in a version segment.
pub fn endpoint_url(origin: &str, base_path: &str, protocol: Protocol) -> String {
    let suffix = match protocol {
        Protocol::ChatCompletions => "chat/completions",
        Protocol::Responses => "responses",
    };
    let joined = format!("{origin}{base_path}");
    let base = joined.trim_end_matches('/');
    if ends_in_version(base) {
        format!("{base}/{suffix}")
    } else {
        format!("{base}/v1/{suffix}")
    }
}

/// `/\/v\d+$/i`.
fn ends_in_version(base: &str) -> bool {
    let digits = base.bytes().rev().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let head = &base.as_bytes()[..base.len() - digits];
    head.len() >= 2
        && head[head.len() - 1].eq_ignore_ascii_case(&b'v')
        && head[head.len() - 2] == b'/'
}

impl ProviderCodec for CustomCodec {
    type State = Protocol;

    fn build_request(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<Protocol>, GatewayError> {
        // Only these carriers enter recursively cloned/serialized temporary
        // maps. Tool-call inputs are written by the stack-safe JSON writer.
        // Keep the entire synchronous lifetime (including temporary drops)
        // inside the scope; only strings and protocol metadata escape it.
        let deep = input.request.tools.iter().flatten().any(|tool| {
            matches!(tool, omni_ir::request::ToolDef::Portable(t) if needs_scope(&t.input_schema))
        }) || input.request.vendor.iter().flat_map(|m| m.values()).any(needs_scope);
        if deep {
            omni_ir::deep::scope(|| build_request(input))
        } else {
            build_request(input)
        }
    }

    fn decoder(&self, state: Protocol, _headers: &Headers) -> Box<dyn StreamDecoder> {
        match state {
            Protocol::ChatCompletions => Box::new(ChatDecoder::new()),
            Protocol::Responses => Box::new(ResponsesDecoder::new()),
        }
    }
}

// A bounded-depth iterator stack, rather than a pending node per sibling.
pub(crate) fn needs_scope(value: &Value) -> bool {
    fn children(value: &Value) -> Option<Box<dyn Iterator<Item = &Value> + '_>> {
        match value {
            Value::Array(a) => Some(Box::new(a.iter())),
            Value::Object(m) => Some(Box::new(m.values())),
            _ => None,
        }
    }
    let Some(root) = children(value) else {
        return false;
    };
    let mut stack = vec![root];
    while let Some(iter) = stack.last_mut() {
        if let Some(child) = iter.next() {
            if let Some(iter) = children(child) {
                stack.push(iter);
                if stack.len() > omni_ir::deep::SHALLOW_DEPTH {
                    return true;
                }
            }
        } else {
            stack.pop();
        }
    }
    false
}

fn build_request(input: &CodecInput<'_>) -> Result<CodecRequest<Protocol>, GatewayError> {
    let Some(api_key) = &input.credentials.api_key else {
        return Err(fail(ErrorCode::Auth, "custom credential has no API key"));
    };
    let data = &input.credentials.provider_data;
    let origin = data.get("origin").and_then(Value::as_str);
    let protocol = match data.get("protocol").and_then(Value::as_str) {
        Some("chat_completions") => Some(Protocol::ChatCompletions),
        Some("responses") => Some(Protocol::Responses),
        _ => None,
    };
    let (Some(origin), Some(protocol)) = (origin, protocol) else {
        return Err(fail(
            ErrorCode::BadRequest,
            "custom credential has invalid endpoint metadata",
        ));
    };
    // Rows written before custom endpoints carried a base path have none.
    let base_path = data.get("basePath").and_then(Value::as_str).unwrap_or("");

    let mut encoded = match protocol {
        Protocol::ChatCompletions => to_custom_chat_wire(input.request, input.model),
        Protocol::Responses => to_custom_responses_wire(input.request, input.model),
    };
    // `{ ...encoded.body, stream: true }`: keeps `stream`'s position.
    omni_ir::deep::insert(&mut encoded.body, "stream".into(), Value::Bool(true));
    let body = jsjson::to_string(&Value::Object(encoded.body));

    Ok(CodecRequest {
        request: CodecHttpRequest {
            url: endpoint_url(origin, base_path, protocol),
            method: "POST".into(),
            headers: vec![
                ("Content-Type".into(), "application/json".into()),
                ("Authorization".into(), format!("Bearer {api_key}")),
            ],
            body,
            body_encoding: None,
        },
        decode_state: protocol,
        degradations: encoded.degradations,
        cloaked_tools: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_urls_follow_the_version_segment_rule() {
        let chat = Protocol::ChatCompletions;
        let cases = [
            (
                "https://host.test",
                "",
                "https://host.test/v1/chat/completions",
            ),
            (
                "https://host.test",
                "/api",
                "https://host.test/api/v1/chat/completions",
            ),
            (
                "https://host.test",
                "/api/v1",
                "https://host.test/api/v1/chat/completions",
            ),
            (
                "https://host.test",
                "/api/coding/paas/v4",
                "https://host.test/api/coding/paas/v4/chat/completions",
            ),
            (
                "http://127.0.0.1:8080",
                "/x/V2//",
                "http://127.0.0.1:8080/x/V2/chat/completions",
            ),
            ("https://h", "/v", "https://h/v/v1/chat/completions"),
            ("https://h", "/v1/x", "https://h/v1/x/v1/chat/completions"),
            ("https://h/v1", "", "https://h/v1/chat/completions"),
            ("https://h", "v1", "https://hv1/v1/chat/completions"),
        ];
        for (origin, base, want) in cases {
            assert_eq!(endpoint_url(origin, base, chat), want, "{origin} {base}");
        }
        assert_eq!(
            endpoint_url("https://host.test", "", Protocol::Responses),
            "https://host.test/v1/responses"
        );
    }
}
