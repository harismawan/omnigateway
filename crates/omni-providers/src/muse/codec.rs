//! Muse as a codec: the request its adapter built, with the sending left to
//! the host.
//!
//! Meta's Model API front door serves the Responses dialect. One URL for both
//! credential types, which is the whole reason this codec is shorter than
//! OpenAI's: a Muse Code subscription is not spent as a bearer token on the
//! inference path — the OAuth grant buys a Model API key from `muse-code/key`,
//! and that key is what every request carries. So `api_key` is the field read
//! here whichever way the credential was obtained, and `access_token` — which
//! the flow also stores — belongs to the mint and the usage probe alone.
use crate::codec::{CodecHttpRequest, CodecInput, CodecRequest, ProviderCodec, StreamDecoder};
use omni_ir::error::{ErrorCode, GatewayError};
use serde_json::Value;

pub struct MuseCodec;

impl ProviderCodec for MuseCodec {
    // Whether reasoning items on this stream are the client's to replay.
    type State = bool;

    fn build_request(&self, input: &CodecInput<'_>) -> Result<CodecRequest<bool>, GatewayError> {
        let encoded = super::wire::to_muse_wire(input.request, input.model);

        let Some(api_key) = &input.credentials.api_key else {
            // Deliberately not falling back to `access_token`. An OAuth
            // credential whose api key is empty is one whose mint failed or
            // was never run, and sending the device-flow token to the
            // inference host would answer 401 with nothing naming the real
            // cause. `AUTH` rather than a bare failure: dispatch gates its
            // credential-refresh retry on this code.
            return Err(GatewayError::new(
                ErrorCode::Auth,
                "muse credential has no model api key",
            ));
        };

        let protocol = vec![
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), format!("Bearer {api_key}")),
            // Muse's own client sends a session id on every request. Sent
            // here on the same terms as the body's `prompt_cache_key`: both
            // name the same conversation, and which one the front door reads
            // is upstream's business.
            ("x-meta-ai-gateway-session-id".into(), encoded.cache_key),
        ];
        // The client identity headers and `Accept` come from the profile.
        let headers = super::profile::headers(protocol);

        // What the client asked to get back, which decides whether reasoning
        // items are the client's to replay or a thinking block for it to
        // read. Taken from the built body because that is where the vendor
        // bag has already landed.
        let native_reasoning = encoded
            .body
            .get("include")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter()
                    .any(|v| v.as_str() == Some("reasoning.encrypted_content"))
            });

        // Non-streaming client requests are served by collecting the stream in
        // dispatch, so always ask for SSE.
        let mut body = encoded.body;
        omni_ir::deep::insert(&mut body, "stream".into(), Value::Bool(true));
        let body = super::profile::order_fields(body, super::profile::BODY_ORDER);

        Ok(CodecRequest {
            request: CodecHttpRequest {
                // Validated here, not trusted from storage: this is the read
                // that attaches a decrypted key, and `provider_data` is
                // parsed back out of the database with no schema between.
                url: super::endpoint::responses_url(&input.credentials.provider_data),
                method: "POST".into(),
                headers,
                body: omni_ir::jsjson::to_string(&Value::Object(body)),
                body_encoding: None,
            },
            decode_state: native_reasoning,
            degradations: encoded.degradations,
            cloaked_tools: None,
        })
    }

    fn decoder(&self, native: bool, _headers: &crate::http::Headers) -> Box<dyn StreamDecoder> {
        Box::new(super::decode::MuseDecoder::new(native))
    }
}
