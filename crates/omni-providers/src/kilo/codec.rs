//! Kilo as a codec: the request its adapter built, with the sending left to
//! the host. One host, two paths, chosen by credential type: crossing them
//! does not fail loudly — an OAuth token sent to the gateway path, or an API
//! key sent to the OpenRouter path, comes back as a billing or entitlement
//! error, which reads as anything but a routing bug.
use crate::codec::{CodecHttpRequest, CodecInput, CodecRequest, ProviderCodec, StreamDecoder};
use omni_ir::error::{ErrorCode, GatewayError};
use serde_json::Value;

const OAUTH_URL: &str = "https://api.kilo.ai/api/openrouter/chat/completions";
const API_URL: &str = "https://api.kilo.ai/api/gateway/chat/completions";

pub struct KiloCodec;

/// The organization this credential bills to, frozen onto the credential when
/// it was connected. An account with no organization is normal, and the header
/// is omitted rather than sent empty.
fn organization_headers(provider_data: &serde_json::Map<String, Value>) -> Vec<(String, String)> {
    match provider_data.get("orgId").and_then(Value::as_str) {
        Some(org) if !org.is_empty() => vec![("X-Kilocode-OrganizationID".into(), org.into())],
        _ => Vec::new(),
    }
}

impl ProviderCodec for KiloCodec {
    type State = ();

    fn build_request(&self, input: &CodecInput<'_>) -> Result<CodecRequest<()>, GatewayError> {
        // Tool schemas, vendor values and content-block JSON enter recursively
        // cloned/serialized temporary maps. Keep the entire synchronous
        // lifetime (including temporary drops) inside the scope; only strings
        // and metadata escape it.
        if crate::codec::needs_scope_request(input.request) {
            omni_ir::deep::scope(|| build_request(input))
        } else {
            build_request(input)
        }
    }

    fn decoder(&self, (): (), _headers: &crate::http::Headers) -> Box<dyn StreamDecoder> {
        Box::new(super::decode::KiloDecoder::new())
    }
}

fn build_request(input: &CodecInput<'_>) -> Result<CodecRequest<()>, GatewayError> {
    let oauth = input.credentials.access_token.is_some();
    let token = input
        .credentials
        .access_token
        .as_deref()
        .or(input.credentials.api_key.as_deref())
        // `AUTH` rather than a bare failure: dispatch gates its
        // credential-refresh retry on this code, so flattening it here
        // would silently turn a refreshable token into a failover.
        .ok_or_else(|| GatewayError::new(ErrorCode::Auth, "kilo credential has no token"))?;

    let encoded = super::wire::to_kilo_wire(input.request, input.model);

    let mut protocol = vec![
        ("Content-Type".into(), "application/json".into()),
        // Same bearer either way: the credential types differ only in the URL.
        ("Authorization".into(), format!("Bearer {token}")),
    ];
    protocol.extend(organization_headers(&input.credentials.provider_data));
    // The editor identity and `Accept` come from the profile.
    let headers = super::profile::headers(protocol);

    // Non-streaming client requests are served by collecting the stream
    // in dispatch, so always ask for SSE.
    let mut body = encoded.body;
    omni_ir::deep::insert(&mut body, "stream".into(), Value::Bool(true));
    let body = super::profile::order_fields(body, super::profile::BODY_ORDER);

    Ok(CodecRequest {
        request: CodecHttpRequest {
            url: if oauth { OAUTH_URL } else { API_URL }.into(),
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
