//! Transport-independent OAuth request and result vocabulary.
use omni_ir::error::{ErrorCode, GatewayError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// RFC 7636 S256 challenge (unpadded base64url).
pub fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 256 bits from the OS-seeded cryptographic RNG, encoded without padding.
pub fn random_state() -> String {
    use base64::Engine as _;
    use rand::RngCore as _;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn pkce() -> (String, String) {
    let verifier = random_state();
    let challenge = pkce_challenge(&verifier);
    (verifier, challenge)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFlow {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
    pub redirect_uri: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeStart {
    pub authorize_url: String,
    pub pending: PendingFlow,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}
impl std::fmt::Debug for AuthRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AuthRequest(<redacted>)")
    }
}

// Deliberately no Debug: these values contain live credentials.
#[derive(Clone)]
pub struct FlowResult {
    pub id_token: Option<Vec<u16>>,
    pub provider_data: serde_json::Map<String, Value>,
    pub access_token: Vec<u16>,
    pub refresh_token: Option<omni_ir::jsjson::JsValue>,
    pub expires_at: Option<f64>,
    pub account_email: Option<omni_ir::jsjson::JsValue>,
}

pub fn token_error(status: u16, body: &Value) -> GatewayError {
    let code = match status {
        429 => ErrorCode::RateLimit,
        400..=499 => ErrorCode::Auth,
        _ => ErrorCode::Upstream,
    };
    let raw = body.get("error").and_then(Value::as_str).unwrap_or("");
    let valid = !raw.is_empty()
        && raw.len() <= 64
        && raw
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c));
    let name = if valid {
        raw.to_owned()
    } else {
        format!("http_{status}")
    };
    GatewayError::new(code, format!("token endpoint rejected the request: {name}"))
}
