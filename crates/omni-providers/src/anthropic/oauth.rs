//! Pure start/exchange/refresh steps; the host owns HTTP and persistence.
use crate::oauth::{AuthRequest, AuthorizeStart, FlowResult, PendingFlow, token_error};
use omni_ir::error::{ErrorCode, GatewayError};
use serde_json::Value;

const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub fn start(verifier: &str, challenge: &str, state: &str) -> AuthorizeStart {
    let redirect = "https://platform.claude.com/oauth/code/callback";
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("code", "true"),
            ("client_id", CLIENT_ID),
            ("response_type", "code"),
            ("redirect_uri", redirect),
            ("scope", "org:create_api_key user:profile user:inference"),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ])
        .finish();
    AuthorizeStart {
        authorize_url: format!("https://claude.ai/oauth/authorize?{query}"),
        pending: PendingFlow {
            verifier: verifier.into(),
            challenge: challenge.into(),
            state: state.into(),
            redirect_uri: redirect.into(),
        },
    }
}

fn request(fields: &[(&str, &str)]) -> AuthRequest {
    let mut body = serde_json::Map::new();
    for (k, v) in fields {
        body.insert((*k).into(), Value::String((*v).into()));
    }
    body.insert("client_id".into(), Value::String(CLIENT_ID.into()));
    AuthRequest {
        url: "https://api.anthropic.com/v1/oauth/token".into(),
        method: "POST".into(),
        headers: super::profile::headers(vec![
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "application/json".into()),
        ]),
        body: omni_ir::jsjson::to_string(&Value::Object(body)),
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
        ("code", raw.trim()),
        ("redirect_uri", &pending.redirect_uri),
        ("code_verifier", &pending.verifier),
        ("state", &pending.state),
    ]))
}
pub fn refresh_request(token: &str) -> AuthRequest {
    request(&[("grant_type", "refresh_token"), ("refresh_token", token)])
}
pub fn token_result(
    status: u16,
    text: &str,
    fallback: Option<&str>,
    now: f64,
) -> Result<FlowResult, GatewayError> {
    let body: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        return Err(token_error(status, &body));
    }
    let access = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GatewayError::new(ErrorCode::Auth, "token endpoint returned no access_token")
        })?;
    Ok(FlowResult {
        access_token: access.into(),
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .or(fallback)
            .map(str::to_owned),
        expires_at: body
            .get("expires_in")
            .and_then(Value::as_f64)
            .map(|s| now + s * 1000.0),
        account_email: body
            .pointer("/account/email_address")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
