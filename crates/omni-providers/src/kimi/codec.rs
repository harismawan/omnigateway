//! Kimi as a codec: the request its adapter built, with the sending left to
//! the host. The device identity is bound to the credential at OAuth time, so
//! it arrives through `providerData` and nowhere else.
use crate::codec::{CodecHttpRequest, CodecInput, CodecRequest, ProviderCodec, StreamDecoder};
use omni_ir::error::{ErrorCode, GatewayError};
use serde_json::Value;

const BASE_URL: &str = "https://api.kimi.com/coding/v1/chat/completions";

pub struct KimiCodec;

impl ProviderCodec for KimiCodec {
    type State = ();

    fn build_request(&self, input: &CodecInput<'_>) -> Result<CodecRequest<()>, GatewayError> {
        let encoded = super::wire::to_chat_wire(input.request, input.model);
        let token = input
            .credentials
            .access_token
            .as_deref()
            .or(input.credentials.api_key.as_deref())
            // `AUTH` rather than a bare failure: dispatch gates its
            // credential-refresh retry on this code, so flattening it here
            // would silently turn a refreshable token into a failover.
            .ok_or_else(|| GatewayError::new(ErrorCode::Auth, "kimi credential has no token"))?;

        let mut protocol = vec![
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "text/event-stream".into()),
            ("Authorization".into(), format!("Bearer {token}")),
        ];
        // A changing device id forces re-authentication upstream.
        protocol.extend(super::device::headers(&input.credentials.provider_data));
        let headers = super::profile::headers(protocol);

        // Non-streaming client requests are served by collecting the stream
        // in dispatch, so always ask for SSE.
        let mut body = encoded.body;
        omni_ir::deep::insert(&mut body, "stream".into(), Value::Bool(true));
        let body = super::profile::order_fields(body, super::profile::BODY_ORDER);

        Ok(CodecRequest {
            request: CodecHttpRequest {
                url: BASE_URL.into(),
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
        Box::new(super::decode::KimiDecoder::new())
    }
}
