//! Frozen exchange and refresh steps. The host owns transport and persistence.
use crate::oauth::{AuthRequest, FlowResult, PendingFlow, token_error};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    jsjson::{JsValue, parse_js},
};
use serde_json::{Value, json};

fn request(fields: &[(&str, &str)]) -> AuthRequest {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields.iter().copied())
        .append_pair("client_id", "app_EMoamEEZ73f0CkXaXp7hrann")
        .finish();
    AuthRequest {
        url: "https://auth.openai.com/oauth/token".into(),
        method: "POST".into(),
        headers: super::profile::headers(vec![
            (
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            ),
            ("Accept".into(), "application/json".into()),
        ]),
        body,
    }
}
pub fn exchange_request(code: &str, pending: &PendingFlow) -> Result<AuthRequest, GatewayError> {
    let mut parts = code.split('#');
    let raw = parts.next().unwrap_or("");
    if parts.next().is_some_and(|s| s != pending.state) {
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "authorization state mismatch",
        ));
    }
    Ok(request(&[
        ("grant_type", "authorization_code"),
        ("code", omni_ir::js::trim(raw)),
        ("redirect_uri", &pending.redirect_uri),
        ("code_verifier", &pending.verifier),
    ]))
}
pub fn refresh_request(token: &str) -> AuthRequest {
    request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", token),
        ("scope", "openid profile email offline_access"),
    ])
}
fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    if let JsValue::Object(entries) = value {
        entries
            .iter()
            .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
            .map(|(_, v)| v)
    } else {
        None
    }
}
fn string(value: Option<&JsValue>) -> Option<&Vec<u16>> {
    if let Some(JsValue::String(s)) = value {
        Some(s)
    } else {
        None
    }
}
fn nonblank(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !omni_ir::js::trim(s).is_empty())
}
/// `fallback` is Some for refresh and None for exchange (including reconnect).
pub fn token_result(
    status: u16,
    text: &str,
    fallback: Option<&str>,
    now: f64,
    prior: &Value,
) -> Result<FlowResult, GatewayError> {
    let body = parse_js(text).unwrap_or(JsValue::Null);
    if !(200..300).contains(&status) {
        let error = string(get(&body, "error")).map(|s| String::from_utf16_lossy(s));
        return Err(token_error(status, &json!({"error":error})));
    }
    let access = string(get(&body, "access_token")).ok_or_else(|| {
        GatewayError::new(ErrorCode::Auth, "token endpoint returned no access_token")
    })?;
    let id_token = string(get(&body, "id_token")).cloned();
    let claims = id_token
        .as_ref()
        .and_then(|s| claims(&String::from_utf16_lossy(s)))
        .unwrap_or(JsValue::Null);
    // Keep the existing X1 UTF-16-to-scalar boundary for claim metadata.
    let account = string(
        get(&claims, "https://api.openai.com/auth")
            .and_then(|auth| get(auth, "chatgpt_account_id")),
    )
    .map(|s| String::from_utf16_lossy(s));
    let account = account
        .as_deref()
        .filter(|s| !omni_ir::js::trim(s).is_empty())
        .or_else(|| fallback.and_then(|_| nonblank(prior.get("accountId"))));
    let identity = super::identity::ensure_secrets(prior);
    let provider_data = serde_json::Map::from_iter([
        ("accountId".into(), json!(account)),
        ("installationId".into(), json!(identity.installation_id)),
        ("idSalt".into(), json!(identity.id_salt)),
    ]);
    Ok(FlowResult {
        access_token: access.clone(),
        refresh_token: string(get(&body, "refresh_token"))
            .cloned()
            .or_else(|| fallback.map(|s| s.encode_utf16().collect()))
            .map(JsValue::String),
        id_token,
        expires_at: match get(&body, "expires_in") {
            Some(JsValue::Number(n)) => Some(now + n * 1000.0),
            _ => None,
        },
        account_email: string(get(&claims, "email"))
            .map(|s| JsValue::String(String::from_utf16_lossy(s).encode_utf16().collect())),
        provider_data,
    })
}
fn claims(token: &str) -> Option<JsValue> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|s| s.is_empty()) {
        return None;
    }
    // Buffer.from(payload, "base64url") accepts both alphabets, ignores junk,
    // stops at padding and discards an incomplete final sextet.
    let bytes = crate::tool_result_files::node_base64_decode(parts[1]);
    parse_js(&String::from_utf8_lossy(&bytes)).ok()
}
