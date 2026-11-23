//! Pure RFC 8628 device-authorization steps for Kimi; the host owns HTTP,
//! the polling loop and the deadline.
//!
//! Kimi ties the session to the fingerprint `start` mints, so the device
//! identity rides on every auth call and is frozen onto the credential's
//! `providerData` at exchange time.
use super::device::{self, KimiDevice};
use crate::oauth::{
    AuthRequest, AuthorizeStart, DeviceError, FlowResult, PendingFlow, token_error,
};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    jsjson::{JsValue, parse_js},
};

/// Public client ID of the Kimi CLI.
const CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_CODE_URL: &str = "https://auth.kimi.com/api/oauth/device_authorization";
const TOKEN_URL: &str = "https://auth.kimi.com/api/oauth/token";
const USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";
const DEFAULT_INTERVAL_SECONDS: f64 = 5.0;

/// Origins the auth steps may talk to; hosts feed this to their bounded runner.
pub const AUTH_ORIGINS: &[&str] = &["https://auth.kimi.com"];

/// The fingerprint `start` minted, validated the way the connect hosts need.
pub fn minted_device_id(start: &AuthorizeStart) -> Result<String, GatewayError> {
    start
        .pending
        .extra
        .get("deviceId")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !omni_ir::js::trim(s).is_empty())
        // INTERNAL: a flow that needs an identity and did not mint one is a
        // gateway bug, not something the operator did.
        .ok_or_else(|| {
            GatewayError::new(
                ErrorCode::Internal,
                "device authorization did not provide a device id",
            )
        })
        .map(str::to_owned)
}

/// The url is a constant and the fingerprint is minted locally: no request.
pub fn start() -> AuthorizeStart {
    AuthorizeStart {
        authorize_url: "https://www.kimi.com/device".into(),
        pending: PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: String::new(),
            redirect_uri: String::new(),
            device_code: None,
            interval: None,
            extra: device::mint().map(),
        },
        user_code: None,
    }
}

/// `begin` is reachable without the connect host's `needsDeviceId` check, and
/// a fingerprint is kimi's own requirement — hence the backstop here. The
/// non-id fields are constants, so building the identity twice (request and
/// result) yields the same values.
pub fn begin_request(device_id: &str) -> Result<AuthRequest, GatewayError> {
    if omni_ir::js::trim(device_id).is_empty() {
        return Err(GatewayError::new(
            ErrorCode::Internal,
            "kimi begin requires a non-blank deviceId",
        ));
    }
    Ok(post_request(
        DEVICE_CODE_URL,
        &[],
        &device_for_begin(device_id),
    ))
}

pub fn begin_result(
    status: u16,
    text: &str,
    device_id: &str,
) -> Result<AuthorizeStart, GatewayError> {
    let body = post_outcome(status, text).map_err(PostError::into_gateway)?;
    let unusable = || {
        GatewayError::new(
            ErrorCode::Auth,
            "device code endpoint returned an unusable response",
        )
    };
    let device_code = string_from(&body, "device_code").ok_or_else(unusable)?;
    let user_code = string_from(&body, "user_code").ok_or_else(unusable)?;
    let verification_uri = string_from(&body, "verification_uri_complete")
        .or_else(|| string_from(&body, "verification_uri"))
        .map(|s| String::from_utf16_lossy(s))
        .unwrap_or_else(|| "https://www.kimi.com/device".into());
    let interval = positive_number_from(&body, "interval").unwrap_or(DEFAULT_INTERVAL_SECONDS);
    Ok(AuthorizeStart {
        authorize_url: verification_uri,
        pending: PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: String::new(),
            redirect_uri: String::new(),
            device_code: Some(String::from_utf16_lossy(device_code)),
            interval: Some(interval),
            extra: device_for_begin(device_id).map(),
        },
        user_code: Some(String::from_utf16_lossy(user_code)),
    })
}

/// The device comes back alongside the request so the poll parser and the
/// stored `providerData` share one identity: minting twice would send one
/// device id upstream and freeze a different one onto the credential.
pub fn exchange_request(pending: &PendingFlow) -> Result<(AuthRequest, KimiDevice), GatewayError> {
    let Some(device_code) = pending.device_code.as_deref() else {
        return Err(GatewayError::new(
            ErrorCode::Internal,
            "kimi exchange requires a pending flow produced by begin()",
        ));
    };
    let device = device::from_data(Some(&pending.extra));
    let request = post_request(
        TOKEN_URL,
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("device_code", device_code),
            ("device_id", &device.device_id),
        ],
        &device,
    );
    Ok((request, device))
}

/// One poll. The caller owns the loop and the deadline.
pub fn poll_result(
    status: u16,
    text: &str,
    device: &KimiDevice,
    now: f64,
) -> Result<FlowResult, DeviceError> {
    let body = post_outcome(status, text).map_err(|e| match e {
        PostError::Pending(_) => DeviceError::Pending,
        PostError::Gateway(g) => DeviceError::Gateway(g),
    })?;
    let token = token_from(&body)?;
    Ok(to_result(token, device, None, now))
}

pub fn refresh_request(token: &str, device: &KimiDevice) -> AuthRequest {
    post_request(
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", token),
            ("device_id", &device.device_id),
        ],
        device,
    )
}

pub fn token_result(
    status: u16,
    text: &str,
    fallback: Option<&str>,
    now: f64,
    device: &KimiDevice,
) -> Result<FlowResult, GatewayError> {
    let body = post_outcome(status, text).map_err(PostError::into_gateway)?;
    let token = token_from(&body)?;
    Ok(to_result(token, device, fallback, now))
}

/// The usage probe carries the device identity the credential was minted
/// with: kimi ties a session to it, and a probe from an unknown device is
/// answered differently. The host applies the 15 second timeout.
pub fn usage_request(access: &str, device: &KimiDevice) -> AuthRequest {
    let mut extra = vec![
        ("Authorization".into(), format!("Bearer {access}")),
        ("Accept".into(), "application/json".into()),
    ];
    extra.extend(device.headers());
    AuthRequest {
        url: USAGE_URL.into(),
        method: "GET".into(),
        headers: super::profile::headers(extra),
        body: String::new(),
    }
}

fn device_for_begin(device_id: &str) -> KimiDevice {
    KimiDevice {
        device_id: device_id.into(),
        ..device::mint()
    }
}

/// The form post every kimi endpoint takes. `client_id` appends last, matching
/// the TS `new URLSearchParams({ ...body, client_id })` key order.
fn post_request(url: &str, pairs: &[(&str, &str)], device: &KimiDevice) -> AuthRequest {
    let mut extra = vec![
        (
            "Content-Type".into(),
            "application/x-www-form-urlencoded".into(),
        ),
        ("Accept".into(), "application/json".into()),
    ];
    extra.extend(device.headers());
    AuthRequest {
        url: url.into(),
        method: "POST".into(),
        headers: super::profile::headers(extra),
        body: url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs.iter().copied())
            .append_pair("client_id", CLIENT_ID)
            .finish(),
    }
}

/// "Keep polling" as control flow, with the reason kept so begin/refresh —
/// where the host cannot poll — surface the TS `pendingError` message verbatim.
enum PostError {
    Pending(String),
    Gateway(GatewayError),
}
impl PostError {
    fn into_gateway(self) -> GatewayError {
        match self {
            Self::Pending(reason) => GatewayError::new(
                ErrorCode::Auth,
                format!("authorization not yet complete: {reason}"),
            ),
            Self::Gateway(g) => g,
        }
    }
}

fn post_outcome(status: u16, text: &str) -> Result<JsValue, PostError> {
    // A non-JSON body is a real answer — an HTML error page, an empty 502 —
    // so it parses to null and the caller falls back to the status.
    let body = parse_js(text).unwrap_or(JsValue::Null);
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let raw = string_from(&body, "error").map(|s| String::from_utf16_lossy(s));
    let code = raw.clone().unwrap_or_else(|| format!("http_{status}"));
    if code == "authorization_pending" || code == "slow_down" {
        return Err(PostError::Pending(code));
    }
    Err(PostError::Gateway(token_error(
        status,
        &serde_json::json!({ "error": raw }),
    )))
}

struct Token {
    access: Vec<u16>,
    refresh: Option<Vec<u16>>,
    expires_in: Option<f64>,
    email: Option<Vec<u16>>,
}

fn token_from(body: &JsValue) -> Result<Token, GatewayError> {
    let access = string_from(body, "access_token")
        .ok_or_else(|| {
            GatewayError::new(ErrorCode::Auth, "token endpoint returned no access_token")
        })?
        .clone();
    Ok(Token {
        access,
        refresh: string_from(body, "refresh_token").cloned(),
        expires_in: positive_number_from(body, "expires_in"),
        email: string_from(body, "email").cloned(),
    })
}

fn to_result(token: Token, device: &KimiDevice, fallback: Option<&str>, now: f64) -> FlowResult {
    FlowResult {
        access_token: token.access,
        refresh_token: token
            .refresh
            .map(JsValue::String)
            .or_else(|| fallback.map(|s| JsValue::String(s.encode_utf16().collect()))),
        id_token: None,
        api_key: None,
        expires_at: token.expires_in.map(|n| now + n * 1000.0),
        account_email: token.email.map(JsValue::String),
        provider_data: device.map(),
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

/// `stringFrom`: a string that is non-blank after trimming, returned untrimmed.
fn string_from<'a>(body: &'a JsValue, field: &str) -> Option<&'a Vec<u16>> {
    match get(body, field) {
        Some(JsValue::String(s)) if !omni_ir::js::trim(&String::from_utf16_lossy(s)).is_empty() => {
            Some(s)
        }
        _ => None,
    }
}

fn positive_number_from(body: &JsValue, field: &str) -> Option<f64> {
    match get(body, field) {
        Some(JsValue::Number(n)) if n.is_finite() && *n > 0.0 => Some(*n),
        _ => None,
    }
}
