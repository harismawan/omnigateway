//! Grok as a codec: the request its adapter built, with the sending left to
//! the host.
//!
//! xAI serves the two credential types from two hosts and never falls back
//! between them. Sending an OAuth bearer to the API host does not return a
//! clean 401: it bills against API credits and answers 402 even for an account
//! whose subscription is healthy, which is a confusing enough symptom that
//! the codec test asserts the pairing directly.
use crate::codec::{CodecHttpRequest, CodecInput, CodecRequest, ProviderCodec, StreamDecoder};
use omni_ir::error::{ErrorCode, GatewayError};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

const PROXY_URL: &str = "https://cli-chat-proxy.grok.com/v1/responses"; // OAuth
const API_URL: &str = "https://api.x.ai/v1/responses"; // apiKey

/// Domain separator, so this hash can never collide with another use of a
/// request id.
const CONV_NAMESPACE: &str = "omni-grok-conv";

/// Derives a stable UUID from a value, in the v5 shape xAI's own ids use.
///
/// Derived rather than minted so codec behaviour stays deterministic without
/// threading a random source through every request — which the contract
/// requires outright: `build_request` must describe the same request given the
/// same input, because the host may build it once and send it on more than one
/// attempt. SHA-256 based, not RFC 4122's SHA-1 v5: only the shape is borrowed.
fn derived_uuid(value: &str) -> String {
    let hash = Sha256::digest(format!("{CONV_NAMESPACE}:{value}").as_bytes());
    let h: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    // Version nibble 5 and the RFC 4122 variant bits, so the id reads as the
    // kind of name-based UUID it actually is rather than as a random one.
    let variant = u8::from_str_radix(&h[16..17], 16).unwrap_or(0);
    let variant = (variant & 0x3) | 0x8;
    format!(
        "{}-{}-5{}-{variant:x}{}-{}",
        &h[..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}

/// The per-request identifiers xAI's client sends.
///
/// `x-grok-req-id` reuses the gateway's own request id so stdout,
/// `request_logs` and the upstream all join on one value rather than three.
/// The conversation and session ids are derived from it and equal to each
/// other, which is what xAI's client does for a main turn. When the caller has
/// no request id — every path outside dispatch — the three are omitted rather
/// than invented.
fn request_identity_headers(model: &str, request_id: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![("x-grok-model-override".into(), model.to_owned())];
    let Some(request_id) = request_id.filter(|s| !s.is_empty()) else {
        return headers;
    };
    let conversation = derived_uuid(request_id);
    headers.push(("x-grok-req-id".into(), request_id.to_owned()));
    headers.push(("x-grok-conv-id".into(), conversation.clone()));
    headers.push(("x-grok-session-id".into(), conversation));
    headers
}

pub struct GrokCodec;

impl ProviderCodec for GrokCodec {
    type State = ();

    fn build_request(&self, input: &CodecInput<'_>) -> Result<CodecRequest<()>, GatewayError> {
        let oauth = input.credentials.access_token.is_some();
        let encoded = super::wire::to_grok_wire(input.request, input.model);

        let mut protocol = vec![("Content-Type".into(), "application/json".into())];
        if let Some(token) = &input.credentials.access_token {
            protocol.push(("Authorization".into(), format!("Bearer {token}")));
            // Both are proxy-only. The API host has no idea what they mean.
            protocol.push(("X-XAI-Token-Auth".into(), "xai-grok-cli".into()));
            protocol.push((
                "x-authenticateresponse".into(),
                "authenticate-response".into(),
            ));
        } else if let Some(key) = &input.credentials.api_key {
            protocol.push(("Authorization".into(), format!("Bearer {key}")));
        } else {
            // `AUTH` rather than a bare failure: dispatch gates its
            // credential-refresh retry on this code.
            return Err(GatewayError::new(
                ErrorCode::Auth,
                "grok credential has no token",
            ));
        }

        protocol.extend(request_identity_headers(input.model, input.request_id));
        // Bound to the credential at connect time and must stay stable; a
        // fresh id per request is a visible behavioural difference from xAI's
        // own client.
        protocol.extend(super::device::headers(&input.credentials.provider_data));

        // The client identity headers and `Accept` come from the profile.
        let headers = super::profile::headers(protocol);

        // Non-streaming client requests are served by collecting the stream in
        // dispatch, so always ask for SSE.
        let mut body = encoded.body;
        omni_ir::deep::insert(&mut body, "stream".into(), Value::Bool(true));
        let body = super::profile::order_fields(body, super::profile::BODY_ORDER);

        Ok(CodecRequest {
            request: CodecHttpRequest {
                url: if oauth { PROXY_URL } else { API_URL }.into(),
                method: "POST".into(),
                headers,
                body: omni_ir::jsjson::to_string(&Value::Object(body)),
                body_encoding: None,
            },
            decode_state: (),
            degradations: encoded.degradations,
            cloaked_tools: None,
        })
    }

    fn decoder(&self, (): (), _headers: &crate::http::Headers) -> Box<dyn StreamDecoder> {
        Box::new(super::decode::GrokDecoder::new())
    }
}
