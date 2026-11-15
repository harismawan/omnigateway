//! OpenAI Responses request assembly and streaming decoding.
pub mod decode;
mod identity;
#[cfg(test)]
mod identity_tests;
mod lite;
#[cfg(test)]
mod lite_tests;
pub mod oauth;
mod oauth_lifecycle;
mod oauth_start;
mod profile;
mod wire;
/// Credential-selected OpenAI Responses codec.
pub struct OpenAiCodec;
impl crate::codec::ProviderCodec for OpenAiCodec {
    type State = bool;
    fn build_request(&self, input: &CodecInput<'_>) -> Result<CodecRequest<bool>, GatewayError> {
        build_request(*input)
    }
    fn decoder(
        &self,
        state: bool,
        _headers: &crate::http::Headers,
    ) -> Box<dyn crate::codec::StreamDecoder> {
        Box::new(decode::OpenAiDecoder::new(state))
    }
}
/// API-key leg only; OAuth identity/transport is the next migration increment.
pub struct OpenAiApiKeyCodec;
impl crate::codec::ProviderCodec for OpenAiApiKeyCodec {
    type State = bool;
    fn build_request(&self, input: &CodecInput<'_>) -> Result<CodecRequest<bool>, GatewayError> {
        build_api_key_request(*input)
    }
    fn decoder(
        &self,
        state: bool,
        _headers: &crate::http::Headers,
    ) -> Box<dyn crate::codec::StreamDecoder> {
        Box::new(decode::OpenAiDecoder::new(state))
    }
}
use crate::codec::{CodecHttpRequest, CodecInput, CodecRequest};
use omni_ir::{
    deep,
    error::{ErrorCode, GatewayError},
};

/// Capture OpenAI profile environment once, before serving requests.
/// Hosts must call this at startup; library users otherwise capture on first use.
pub fn initialize() {
    profile::initialize();
}

/// API-key request boundary: assembly and temporary arbitrary JSON are scoped;
/// only strings, headers and a boolean escape.
pub fn build_api_key_request(input: CodecInput<'_>) -> Result<CodecRequest<bool>, GatewayError> {
    build_mode(input, false)
}
fn build_request(input: CodecInput<'_>) -> Result<CodecRequest<bool>, GatewayError> {
    build_mode(input, input.credentials.access_token.is_some())
}
fn build_mode(input: CodecInput<'_>, oauth: bool) -> Result<CodecRequest<bool>, GatewayError> {
    let token = if oauth {
        &input.credentials.access_token
    } else {
        &input.credentials.api_key
    }
    .as_ref()
    .ok_or_else(|| GatewayError::new(ErrorCode::Auth, "openai credential has no token"))?;
    Ok(deep::scope(|| {
        let (mut body, degradations, key, mut protocol, prototype) =
            wire::encode_mode(input.request, input.model, oauth.then_some(&input));
        if oauth && !input.model.is_empty() && input.model.bytes().all(|b| (33..=126).contains(&b))
        {
            let tier = crate::response_format::prototype_get(&body, &prototype.0, "service_tier")
                .and_then(serde_json::Value::as_str)
                .filter(|s| {
                    !s.is_empty() && s.bytes().all(|b| (33..=126).contains(&b)) && !s.contains(';')
                });
            protocol.push((
                "x-codex-routing-hint".into(),
                format!(
                    "model={}{}",
                    input.model,
                    tier.map_or(String::new(), |t| format!(";tier={t}"))
                ),
            ));
        }
        deep::insert(&mut body, "stream".into(), true.into());
        let mut ordered = serde_json::Map::new();
        for name in [
            "model",
            "stream",
            "service_tier",
            "input",
            "instructions",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "reasoning",
            "store",
            "stream_options",
            "include",
            "prompt_cache_key",
            "text",
            "client_metadata",
            "access_programs",
            "metadata",
        ] {
            if let Some(value) = body.shift_remove(name) {
                deep::insert(&mut ordered, name.into(), value);
            }
        }
        for (name, value) in body {
            deep::insert(&mut ordered, name, value);
        }
        let body = deep::Owned(serde_json::Value::Object(ordered));
        protocol.extend(vec![
            ("x-client-request-id".into(), key.clone()),
            ("session-id".into(), key.clone()),
            ("thread-id".into(), key),
        ]);
        if oauth {
            protocol.push(("content-encoding".into(), "zstd".into()));
        }
        protocol.extend(vec![
            ("content-type".into(), "application/json".into()),
            ("authorization".into(), format!("Bearer {token}")),
        ]);
        if oauth {
            if let Some(account) = input
                .credentials
                .provider_data
                .get("accountId")
                .and_then(serde_json::Value::as_str)
            {
                protocol.push(("chatgpt-account-id".into(), account.into()));
            }
            protocol.push(("host".into(), "chatgpt.com".into()));
        }
        let headers = profile::headers(protocol);
        let native = input
            .request
            .vendor_bag("openai")
            .and_then(|b| b.get("include"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|a| a.iter().any(|v| v == "reasoning.encrypted_content"));
        CodecRequest {
            request: CodecHttpRequest {
                url: if oauth {
                    "https://chatgpt.com/backend-api/codex/responses"
                } else {
                    "https://api.openai.com/v1/responses"
                }
                .into(),
                method: "POST".into(),
                headers,
                body: omni_ir::jsjson::to_string(&body.0),
                body_encoding: oauth.then_some(crate::http::BodyEncoding::Zstd),
            },
            decode_state: native,
            degradations,
            cloaked_tools: None,
        }
    }))
}
