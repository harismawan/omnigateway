//! OpenAI API-key request assembly. OAuth and decoding are separate increments.
pub mod decode;
mod identity;
#[cfg(test)]
mod identity_tests;
mod lite;
#[cfg(test)]
mod lite_tests;
mod profile;
mod wire;
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
    let token = input
        .credentials
        .api_key
        .as_ref()
        .ok_or_else(|| GatewayError::new(ErrorCode::Auth, "openai credential has no token"))?;
    Ok(deep::scope(|| {
        let (mut body, degradations, key) = wire::encode(input.request, input.model);
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
        let headers = profile::headers(vec![
            ("x-client-request-id".into(), key.clone()),
            ("session-id".into(), key.clone()),
            ("thread-id".into(), key),
            ("content-type".into(), "application/json".into()),
            ("authorization".into(), format!("Bearer {token}")),
        ]);
        let native = input
            .request
            .vendor_bag("openai")
            .and_then(|b| b.get("include"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|a| a.iter().any(|v| v == "reasoning.encrypted_content"));
        CodecRequest {
            request: CodecHttpRequest {
                url: "https://api.openai.com/v1/responses".into(),
                method: "POST".into(),
                headers,
                body: omni_ir::jsjson::to_string(&body.0),
                body_encoding: None,
            },
            decode_state: native,
            degradations,
            cloaked_tools: None,
        }
    }))
}
