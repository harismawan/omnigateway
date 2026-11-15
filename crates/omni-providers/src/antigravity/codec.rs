//! Request-side codec. A ProviderCodec implementation awaits the real decoder.
use super::cloak::ToolCloak;
use crate::codec::{CodecHttpRequest, CodecInput, CodecRequest};
use omni_ir::error::{ErrorCode, GatewayError};
use sha2::{Digest, Sha256};

pub struct AntigravityCodec;
pub struct DecodeState {
    pub cloak: ToolCloak,
}

impl crate::codec::ProviderCodec for AntigravityCodec {
    type State = DecodeState;

    fn build_request(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<DecodeState>, GatewayError> {
        omni_ir::deep::scope(|| self.build_request_scoped(input))
    }

    fn decoder(&self, state: DecodeState, _headers: &crate::http::Headers) -> Box<dyn crate::codec::StreamDecoder> {
        Box::new(super::decode::AntigravityDecoder::new(state.cloak))
    }
}

impl AntigravityCodec {
    fn build_request_scoped(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<DecodeState>, GatewayError> {
        let token = input
            .credentials
            .access_token
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                GatewayError::new(
                    ErrorCode::Auth,
                    "antigravity credential has no access token",
                )
            })?;
        let project = input
            .credentials
            .provider_data
            .get("projectId")
            .and_then(serde_json::Value::as_str)
            .map(omni_ir::js::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                GatewayError::new(
                    ErrorCode::Auth,
                    "antigravity credential has no Cloud Code project; reconnect the account",
                )
            })?;
        let request_id = input
            .request_id
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let h = format!(
                    "{:x}",
                    Sha256::digest(format!("omni-antigravity-req:{}:{project}", input.model))
                );
                let variant = (u8::from_str_radix(&h[16..17], 16).expect("hex digest") & 3) | 8;
                format!(
                    "{}-{}-4{}-{:x}{}-{}",
                    &h[..8],
                    &h[8..12],
                    &h[13..16],
                    variant,
                    &h[17..20],
                    &h[20..32]
                )
            });
        let cloak = ToolCloak::build(input.request);
        let (body, degradations) =
            super::wire::to_wire(input.request, input.model, project, &request_id, &cloak);
        let serialized = omni_ir::jsjson::to_string(&body);
        omni_ir::deep::drop(body);
        let cloaked_tools = (!cloak.to_wire.is_empty()).then_some(cloak.to_wire.len() as u32);
        Ok(CodecRequest {
            request: CodecHttpRequest {
                url:"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse".into(),
                method:"POST".into(),
                headers:super::profile::headers(vec![("Authorization".into(),format!("Bearer {token}"))]),
                body:serialized,
                body_encoding:None,
            },
            decode_state:DecodeState {cloak},
            degradations,
            cloaked_tools,
        })
    }
}
