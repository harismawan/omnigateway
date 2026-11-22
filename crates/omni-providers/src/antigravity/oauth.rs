//! Pure Google authorization, project bootstrap and refresh steps; the host owns HTTP.
use crate::oauth::{AuthRequest, AuthorizeStart, FlowResult, PendingFlow, token_error};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    jsjson::{JsValue, parse_js},
};
use serde_json::{Map, Value};

fn unmask(bytes: &[u8]) -> String {
    const MASK: &[u8] = b"omnigateway-public-v1";
    bytes
        .iter()
        .enumerate()
        .map(|(i, b)| char::from(b ^ MASK[i % MASK.len()]))
        .collect()
}
fn client_id() -> String {
    unmask(&[
        94, 93, 89, 88, 87, 81, 66, 85, 65, 81, 76, 20, 65, 88, 22, 1, 1, 16, 94, 31, 95, 93, 5,
        92, 88, 11, 2, 6, 0, 69, 82, 76, 91, 4, 26, 14, 3, 3, 11, 25, 17, 5, 95, 94, 11, 25, 73, 0,
        4, 21, 4, 79, 30, 66, 31, 18, 14, 9, 28, 16, 72, 4, 82, 0, 3, 26, 12, 9, 21, 90, 6, 24, 12,
    ])
}
fn client_secret() -> String {
    unmask(&[
        40, 34, 45, 58, 55, 57, 89, 46, 66, 89, 63, 122, 34, 65, 90, 90, 37, 7, 97, 60, 0, 2, 33,
        44, 81, 20, 57, 55, 81, 13, 87, 8, 105, 49, 19,
    ])
}
pub fn start(verifier: &str, challenge: &str, state: &str) -> AuthorizeStart {
    let redirect = "https://antigravity.google/oauth-callback";
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("client_id", client_id().as_str()),
            ("response_type", "code"),
            ("redirect_uri", redirect),
            ("scope", "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs"),
            ("state", state),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ])
        .finish();
    AuthorizeStart {
        authorize_url: format!("https://accounts.google.com/o/oauth2/v2/auth?{query}"),
        pending: PendingFlow {
            verifier: verifier.into(),
            challenge: challenge.into(),
            state: state.into(),
            redirect_uri: redirect.into(),
            device_code: None,
            interval: None,
            extra: serde_json::Map::new(),
        },
        user_code: None,
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
    let mut request = refresh_request("");
    request.body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("grant_type", "authorization_code"),
            ("client_id", &client_id()),
            ("client_secret", &client_secret()),
            ("code", omni_ir::js::trim(raw)),
            ("redirect_uri", &pending.redirect_uri),
            ("code_verifier", &pending.verifier),
        ])
        .finish();
    Ok(request)
}

/// The host must apply the userinfo step's 15 second timeout.
pub fn email_request(access: &str) -> AuthRequest {
    AuthRequest {
        url: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json".into(),
        method: "GET".into(),
        headers: super::profile::headers(vec![
            ("Authorization".into(), format!("Bearer {access}")),
            ("Accept".into(), "application/json".into()),
        ]),
        body: String::new(),
    }
}
pub fn email_result(status: u16, text: &str) -> Option<JsValue> {
    if !(200..300).contains(&status) {
        return None;
    }
    let body = parse_js(text).unwrap_or(JsValue::Null);
    match get(&body, "email") {
        Some(JsValue::String(email))
            if !omni_ir::js::trim(&String::from_utf16_lossy(email)).is_empty() =>
        {
            Some(JsValue::String(email.clone()))
        }
        _ => None,
    }
}
fn project(body: &JsValue) -> String {
    let value = get(body, "cloudaicompanionProject");
    let id = match value {
        Some(JsValue::String(s)) => Some(s),
        Some(v) => match get(v, "id") {
            Some(JsValue::String(s)) => Some(s),
            _ => None,
        },
        _ => None,
    };
    id.map(|s| omni_ir::js::trim(&String::from_utf16_lossy(s)).to_owned())
        .unwrap_or_default()
}
pub fn project_result(status: u16, text: &str) -> (String, String) {
    let body = if (200..300).contains(&status) {
        parse_js(text).unwrap_or(JsValue::Null)
    } else {
        JsValue::Null
    };
    let mut tier = None;
    if let Some(JsValue::Array(tiers)) = get(&body, "allowedTiers") {
        for entry in tiers {
            if matches!(get(entry, "isDefault"), Some(JsValue::Bool(true)))
                && let Some(JsValue::String(id)) = get(entry, "id")
            {
                tier = Some(String::from_utf16_lossy(id));
                break;
            }
        }
    }
    let tier = tier
        .or_else(
            || match get(&body, "currentTier").and_then(|v| get(v, "id")) {
                Some(JsValue::String(id)) => Some(String::from_utf16_lossy(id)),
                _ => None,
            },
        )
        .unwrap_or_else(|| "legacy-tier".into());
    (project(&body), tier)
}
/// One Cloud Code RPC in the captured App shape (bootstrap and quota share
/// inference's host there). Also used by `crate::quota`.
pub(crate) fn code_assist_request(operation: &str, access: &str, body: String) -> AuthRequest {
    AuthRequest {
        url: format!(
            "https://{}/v1internal:{operation}",
            super::profile::INFERENCE_HOST
        ),
        method: "POST".into(),
        headers: super::profile::bootstrap_headers(access, &body),
        body,
    }
}
pub fn load_request(access: &str) -> AuthRequest {
    code_assist_request(
        "loadCodeAssist",
        access,
        "{\"metadata\":{\"ideType\":\"ANTIGRAVITY\"}}".into(),
    )
}
pub fn onboard_request(access: &str, tier: &str) -> AuthRequest {
    code_assist_request(
        "onboardUser",
        access,
        format!(
            // `tierId`, the captured App spelling; `tier_id` came from omniroute.
            "{{\"tierId\":{},\"metadata\":{{\"ideType\":\"ANTIGRAVITY\"}}}}",
            omni_ir::jsjson::to_string(&Value::String(tier.into()))
        ),
    )
}
pub fn onboard_result(status: u16, text: &str) -> String {
    if !(200..300).contains(&status) {
        return String::new();
    }
    let body = parse_js(text).unwrap_or(JsValue::Null);
    get(&body, "response").map(project).unwrap_or_default()
}
pub fn refresh_request(token: &str) -> AuthRequest {
    AuthRequest {
        url: "https://oauth2.googleapis.com/token".into(),
        method: "POST".into(),
        headers: super::profile::headers(vec![
            (
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            ),
            ("Accept".into(), "application/json".into()),
        ]),
        body: url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                ("grant_type", "refresh_token"),
                ("client_id", &client_id()),
                ("client_secret", &client_secret()),
                ("refresh_token", token),
            ])
            .finish(),
    }
}
fn get<'a>(body: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    if let JsValue::Object(entries) = body {
        entries
            .iter()
            .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
            .map(|(_, v)| v)
    } else {
        None
    }
}
struct Token {
    access: Vec<u16>,
    refresh: Option<Vec<u16>>,
    expires_in: Option<f64>,
}
fn parse_token(body: &JsValue) -> Option<Token> {
    let JsValue::String(access) = get(body, "access_token")? else {
        return None;
    };
    Some(Token {
        access: access.clone(),
        refresh: match get(body, "refresh_token") {
            Some(JsValue::String(s)) => Some(s.clone()),
            _ => None,
        },
        expires_in: match get(body, "expires_in") {
            Some(JsValue::Number(n)) => Some(*n),
            _ => None,
        },
    })
}
fn to_result(
    token: Token,
    fallback: Option<&str>,
    now: f64,
    provider_data: &Map<String, Value>,
) -> FlowResult {
    FlowResult {
        access_token: token.access,
        refresh_token: token
            .refresh
            .map(JsValue::String)
            .or_else(|| fallback.map(|s| JsValue::String(s.encode_utf16().collect()))),
        id_token: None,
        expires_at: token.expires_in.map(|n| now + n * 1000.0),
        account_email: None,
        provider_data: omni_ir::deep::clone_map(provider_data),
    }
}
pub fn token_result(
    status: u16,
    text: &str,
    fallback: Option<&str>,
    now: f64,
    provider_data: &Value,
) -> Result<FlowResult, GatewayError> {
    let body = parse_js(text).unwrap_or(JsValue::Null);
    if !(200..300).contains(&status) {
        let error = match get(&body, "error") {
            Some(JsValue::String(s)) => String::from_utf16(s).ok(),
            _ => None,
        };
        return Err(token_error(status, &serde_json::json!({"error":error})));
    }
    let token = parse_token(&body).ok_or_else(|| {
        GatewayError::new(ErrorCode::Auth, "token endpoint returned no access_token")
    })?;
    let empty = Map::new();
    Ok(to_result(
        token,
        fallback,
        now,
        provider_data.as_object().unwrap_or(&empty),
    ))
}
