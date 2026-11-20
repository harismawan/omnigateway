//! Cloud Code request codec and incremental Antigravity stream decoder integration.
use super::cloak::ToolCloak;
use crate::codec::{BuildError, CodecHttpRequest, CodecInput, CodecRequest};
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::{request::CanonicalRequest, text::Text};
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
        self.try_build_request(input).map_err(|e| match e {
            BuildError::Gateway(e) => e,
            BuildError::Throw => {
                GatewayError::new(ErrorCode::Upstream, "antigravity codec buildRequest threw")
                    .with_provider("antigravity")
                    .gateway_authored()
            }
        })
    }

    fn try_build_request(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<DecodeState>, BuildError> {
        self.build_request_scoped(input)
    }

    fn decoder(
        &self,
        state: DecodeState,
        _headers: &crate::http::Headers,
    ) -> Box<dyn crate::codec::StreamDecoder> {
        Box::new(super::decode::AntigravityDecoder::new(state.cloak))
    }
}

impl AntigravityCodec {
    /// Compatibility entry point for existing request-side callers.
    pub fn build_request(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<DecodeState>, GatewayError> {
        <Self as crate::codec::ProviderCodec>::build_request(self, input)
    }

    /// Encode a losslessly imported canonical request. The HTTP client
    /// ingress remains on its validated `ChatRequest` path.
    pub fn build_canonical(
        &self,
        request: &CanonicalRequest,
        model: &str,
        access_token: &str,
        project: &Text,
        request_id: Option<&Text>,
    ) -> Result<CodecRequest<DecodeState>, BuildError> {
        encode(
            &request.validated,
            Some(&request.source),
            model,
            access_token,
            project,
            request_id,
            ToolCloak::from_source(&request.source),
        )
    }

    fn build_request_scoped(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<DecodeState>, BuildError> {
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
        let project = Text::from(project);
        let request_id = input.request_id.map(Text::from);
        encode(
            input.request,
            None,
            input.model,
            token,
            &project,
            request_id.as_ref(),
            ToolCloak::build(input.request),
        )
    }
}

fn encode(
    request: &omni_ir::request::ChatRequest,
    source: Option<&omni_ir::jsjson::JsValue>,
    model: &str,
    token: &str,
    project: &Text,
    request_id: Option<&Text>,
    cloak: ToolCloak,
) -> Result<CodecRequest<DecodeState>, BuildError> {
    let request_id = request_id
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            let project = project.to_utf8_lossy();
            let h = format!(
                "{:x}",
                Sha256::digest(format!("omni-antigravity-req:{model}:{project}"))
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
            .into()
        });
    let (body, degradations) =
        super::wire::to_wire_source(request, source, model, project, &request_id, &cloak)?;
    let serialized = omni_ir::jsjson::to_string(&body);
    let cloaked_tools = (!cloak.to_wire.is_empty()).then_some(cloak.to_wire.len() as u32);
    Ok(CodecRequest {
        request: CodecHttpRequest {
            url:
                "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
                    .into(),
            method: "POST".into(),
            headers: super::profile::headers(vec![(
                "Authorization".into(),
                format!("Bearer {token}"),
            )]),
            body: serialized,
            body_encoding: None,
        },
        decode_state: DecodeState { cloak },
        degradations,
        cloaked_tools,
    })
}
