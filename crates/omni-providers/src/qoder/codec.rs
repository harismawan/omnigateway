//! Qoder as a codec: the Cosy-signed, body-encoded chat request, with the
//! sending left to the host.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use omni_ir::error::{ErrorCode, GatewayError};
use serde_json::{Map, Value, json};

use crate::codec::{CodecHttpRequest, CodecInput, CodecRequest, ProviderCodec, StreamDecoder};

/// Signed as-is; the URL prefixes `/algo` and appends the query separately.
const PATH: &str = "/api/v2/service/pro/sse/agent_chat_generation";

pub struct QoderCodec;

impl ProviderCodec for QoderCodec {
    type State = ();

    fn build_request(&self, input: &CodecInput<'_>) -> Result<CodecRequest<()>, GatewayError> {
        let bundle =
            super::credential::parse(input.credentials.access_token.as_deref().unwrap_or(""))
                .map_err(|_| {
                    GatewayError::new(
                        ErrorCode::Auth,
                        "Invalid Qoder credential; reconnect required",
                    )
                })?;
        let wire = super::wire::to_qoder_wire(input, &bundle);
        let body = super::profile::order_fields(wire.body, super::profile::BODY_ORDER);
        let request_id = body
            .get("request_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let body =
            omni_crypto::qoder::encode_body(&omni_ir::jsjson::to_string(&Value::Object(body)));
        let date = ((input.request_started_at.unwrap_or(bundle.issued_at)) / 1000.0).floor();
        let date = format!("{}", date as i64);
        let version = super::profile::version();
        let mut auth = Map::new();
        omni_ir::deep::insert(&mut auth, "version".into(), json!("v1"));
        omni_ir::deep::insert(&mut auth, "requestId".into(), json!(request_id));
        omni_ir::deep::insert(&mut auth, "info".into(), json!(bundle.encrypt_user_info));
        omni_ir::deep::insert(&mut auth, "cosyVersion".into(), json!(version));
        omni_ir::deep::insert(&mut auth, "ideVersion".into(), json!(""));
        let auth_base64 = B64.encode(omni_ir::jsjson::to_string(&Value::Object(auth)));
        let signature =
            omni_crypto::qoder::sign_auth(&auth_base64, &bundle.key, &date, &body, PATH);
        let headers = super::profile::headers(vec![
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "text/event-stream".into()),
            (
                "Authorization".into(),
                format!("Bearer COSY.{auth_base64}.{signature}"),
            ),
            ("Cosy-Key".into(), bundle.key.clone()),
            ("Cosy-Date".into(), date),
            ("Cosy-User".into(), bundle.uid.clone()),
            ("Cosy-Version".into(), version),
            ("Cosy-MachineId".into(), bundle.machine_id.clone()),
            ("Cosy-MachineToken".into(), bundle.machine_id.clone()),
            ("Cosy-ClientIp".into(), bundle.machine_id.clone()),
            ("Cosy-ClientType".into(), "5".into()),
            ("Cosy-MachineType".into(), "5".into()),
            ("Cosy-Business-Product".into(), "cli".into()),
            ("Cosy-Business-Type".into(), "agent".into()),
            ("Cosy-Scene".into(), "assistant".into()),
            ("Cosy-Data-Policy".into(), "disagree".into()),
            ("Login-Version".into(), "v2".into()),
        ]);
        Ok(CodecRequest {
            request: CodecHttpRequest {
                url: format!(
                    "{}/algo{PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
                    bundle.origin
                ),
                method: "POST".into(),
                headers,
                body,
                body_encoding: None,
            },
            decode_state: (),
            degradations: wire.degradations,
            cloaked_tools: None,
        })
    }

    fn decoder(&self, (): (), _headers: &crate::http::Headers) -> Box<dyn StreamDecoder> {
        Box::new(super::decode::QoderDecoder::new())
    }
}
