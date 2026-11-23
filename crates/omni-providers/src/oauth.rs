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
    use rand::Rng as _;
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
    /// Present only on device flows (RFC 8628); marks the flow as device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_code: Option<String>,
    /// Device poll interval in seconds; the host owns the polling loop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<f64>,
    /// Provider-owned flow state (device identity, deadlines, machine ids).
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeStart {
    pub authorize_url: String,
    pub pending: PendingFlow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
}

/// A device poll's outcome: `Pending` is control flow ("keep polling"), not a
/// failure. Device poll parsers return `Result<FlowResult, DeviceError>`.
#[derive(Debug)]
pub enum DeviceError {
    Pending,
    Gateway(GatewayError),
}
impl From<GatewayError> for DeviceError {
    fn from(error: GatewayError) -> Self {
        Self::Gateway(error)
    }
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
pub struct FlowResult {
    pub id_token: Option<Vec<u16>>,
    pub provider_data: serde_json::Map<String, Value>,
    pub access_token: Vec<u16>,
    pub refresh_token: Option<omni_ir::jsjson::JsValue>,
    /// A provider-minted inference key (muse): the OAuth grant buys this key,
    /// and the key is what the inference host accepts. Lossless UTF-16 like
    /// `access_token`; `None` for flows that mint nothing.
    pub api_key: Option<Vec<u16>>,
    pub expires_at: Option<f64>,
    pub account_email: Option<omni_ir::jsjson::JsValue>,
}
impl Clone for FlowResult {
    fn clone(&self) -> Self {
        Self {
            id_token: self.id_token.clone(),
            provider_data: omni_ir::deep::clone_map(&self.provider_data),
            access_token: self.access_token.clone(),
            refresh_token: self.refresh_token.clone(),
            api_key: self.api_key.clone(),
            expires_at: self.expires_at,
            account_email: self.account_email.clone(),
        }
    }
}
impl Drop for FlowResult {
    fn drop(&mut self) {
        omni_ir::deep::drop_map_in_place(&mut self.provider_data);
    }
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
