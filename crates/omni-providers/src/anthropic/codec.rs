//! Anthropic inference request codec; HTTP remains owned by the adapter.
use super::{
    body::apply_system, cloak::ToolCloak, decode::AnthropicDecoder, wire::to_wire_with_options,
};
use crate::{
    codec::{CodecHttpRequest, CodecInput, CodecRequest, ProviderCodec, StreamDecoder},
    http::Headers,
};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    request::{ContentBlock, Role},
};
use serde_json::{Map, Value};
pub struct AnthropicCodec;
impl ProviderCodec for AnthropicCodec {
    type State = ToolCloak;
    fn build_request(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<ToolCloak>, GatewayError> {
        let req = input.request;
        let oauth = input.credentials.access_token.is_some();
        let review = req
            .vendor_bag("anthropic")
            .and_then(|v| v.get("safeguards"))
            .and_then(Value::as_array)
            .is_some_and(|v| !v.is_empty());
        let cloak = if oauth && !review {
            ToolCloak::build(req)
        } else {
            ToolCloak::default()
        };
        let (mut body, mut notes) = to_wire_with_options(
            req,
            input.model,
            oauth,
            &cloak,
            input.max_output_tokens,
            review,
            input.auto_cache_enabled == Some(true),
        )?;
        if !review {
            let first = req
                .messages
                .iter()
                .find(|m| m.role == Role::User)
                .and_then(|m| {
                    m.content.iter().find_map(|b| {
                        if let ContentBlock::Text(t) = b {
                            Some(t.text.as_str())
                        } else {
                            None
                        }
                    })
                })
                .unwrap_or("");
            body["system"] = Value::Array(apply_system(
                body["system"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
                first,
            ));
        }
        body["stream"] = Value::Bool(true);
        let client = req
            .provider_headers
            .as_ref()
            .and_then(|h| h.get("anthropic"))
            .and_then(Value::as_object);
        let header = |key: &str| client.and_then(|h| h.get(key)).and_then(Value::as_str);
        let mut protocol = vec![
            ("Content-Type".into(), "application/json".into()),
            (
                "anthropic-version".into(),
                header("anthropic-version").unwrap_or("2023-06-01").into(),
            ),
            ("Accept".into(), "text/event-stream".into()),
        ];
        for (k, v) in client.into_iter().flatten() {
            if k.starts_with("anthropic-")
                && k != "anthropic-version"
                && k != "anthropic-beta"
                && let Some(v) = v.as_str()
            {
                protocol.push((k.clone(), v.into()));
            }
        }
        let mut betas = Vec::new();
        for b in req.betas.iter().flatten() {
            if !betas.contains(b) {
                betas.push(b.clone());
            }
        }
        if input.model == "claude-haiku-4-5" && betas.iter().any(|b| b == "context-1m-2025-08-07") {
            betas.retain(|b| b != "context-1m-2025-08-07");
            notes.push("anthropic:context-1m-dropped".into());
        }
        if let Some(token) = &input.credentials.access_token {
            protocol.push(("Authorization".into(), format!("Bearer {token}")));
            if !betas.iter().any(|b| b == "oauth-2025-04-20") {
                betas.push("oauth-2025-04-20".into());
            }
        } else if let Some(key) = &input.credentials.api_key {
            protocol.push(("x-api-key".into(), key.clone()));
        } else {
            return Err(GatewayError::new(
                ErrorCode::Auth,
                "anthropic credential has no token",
            ));
        }
        if !betas.is_empty() {
            let raw = header("anthropic-beta");
            let original: Vec<_> = raw
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            let value = if raw.is_some() && original.iter().all(|b| betas.iter().any(|v| v == b)) {
                std::iter::once(raw.unwrap_or_default().to_owned())
                    .chain(
                        betas
                            .iter()
                            .filter(|b| !original.contains(&b.as_str()))
                            .cloned(),
                    )
                    .collect::<Vec<_>>()
                    .join(",")
            } else {
                betas.join(",")
            };
            protocol.push(("anthropic-beta".into(), value));
        }
        let mut body = body.as_object().expect("body").clone();
        let mut ordered = Map::new();
        for key in [
            "model",
            "messages",
            "system",
            "tools",
            "tool_choice",
            "metadata",
            "max_tokens",
            "temperature",
            "thinking",
            "context_management",
            "output_config",
            "stream",
        ] {
            if let Some(v) = body.shift_remove(key) {
                ordered.insert(key.into(), v);
            }
        }
        ordered.extend(body);
        let json = omni_ir::jsjson::to_string(&Value::Object(ordered));
        let json = if review {
            json
        } else {
            omni_crypto::cch::sign_anthropic_body(&json)
        };
        let count = (!cloak.to_wire.is_empty()).then_some(cloak.to_wire.len() as u32);
        Ok(CodecRequest {
            request: CodecHttpRequest {
                url: "https://api.anthropic.com/v1/messages".into(),
                method: "POST".into(),
                headers: super::profile::headers(protocol),
                body: json,
                body_encoding: None,
            },
            decode_state: cloak,
            degradations: notes,
            cloaked_tools: count,
        })
    }
    fn decoder(&self, state: ToolCloak, _headers: &Headers) -> Box<dyn StreamDecoder> {
        let mut decoder = AnthropicDecoder::default();
        decoder.uncloak = state.from_wire;
        Box::new(decoder)
    }
}
