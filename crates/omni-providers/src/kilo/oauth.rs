//! Kilo's device-code flow, which is not RFC 8628.
//!
//! There is no `client_id`, no form encoding, and no token endpoint: a POST
//! mints a code, a GET on that code answers with an HTTP status until the
//! operator approves, and approval hands back a bare token. Pure request
//! builders and result parsers; the host owns HTTP, the polling loop and the
//! deadline. Kilo identifies an editor, not a machine, so no device identity
//! is minted or sent.
use crate::oauth::{AuthRequest, AuthorizeStart, DeviceError, FlowResult, PendingFlow};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    jsjson::{JsValue, parse_js},
};

const CODES_URL: &str = "https://api.kilo.ai/api/device-auth/codes";
const PROFILE_URL: &str = "https://api.kilo.ai/api/profile";
/// Where the operator ends up if `begin()` never got to state a URL.
const FALLBACK_VERIFICATION_URL: &str = "https://kilo.ai";
const DEFAULT_EXPIRES_SECONDS: f64 = 300.0;
const POLL_INTERVAL_SECONDS: f64 = 3.0;

/// Origins the auth steps may talk to; hosts feed this to their bounded runner.
pub const AUTH_ORIGINS: &[&str] = &["https://api.kilo.ai"];

/// `tokenErrorCode`: 429 is 4xx but is the clearest "try again later" there
/// is; any other 4xx is the provider refusing the request.
fn status_code(status: u16) -> ErrorCode {
    match status {
        429 => ErrorCode::RateLimit,
        400..=499 => ErrorCode::Auth,
        _ => ErrorCode::Upstream,
    }
}

/// Mints the code. Takes no device id: Kilo has no device identity. The body
/// is the empty string, not `{}` — the endpoint takes no parameters at all.
pub fn begin_request() -> AuthRequest {
    AuthRequest {
        url: CODES_URL.into(),
        method: "POST".into(),
        headers: super::profile::headers(vec![
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "application/json".into()),
        ]),
        body: String::new(),
    }
}

pub fn begin_result(status: u16, text: &str, now: f64) -> Result<AuthorizeStart, GatewayError> {
    let body = parsed(text);
    // Distinct from a generic failure because the operator can act on it: an
    // earlier authorization of theirs is still open and has to age out.
    if status == 429 {
        return Err(GatewayError::new(
            ErrorCode::RateLimit,
            "kilo has too many pending device authorizations; wait for one to expire and retry",
        ));
    }
    if !(200..300).contains(&status) {
        return Err(GatewayError::new(
            status_code(status),
            format!("kilo refused a device code: http_{status}"),
        ));
    }
    let code = string_from(&body, "code")
        .ok_or_else(|| {
            GatewayError::new(
                ErrorCode::Auth,
                "device code endpoint returned an unusable response",
            )
        })?
        .clone();
    let verification_url = string_from(&body, "verificationUrl")
        .map(|s| String::from_utf16_lossy(s))
        .unwrap_or_else(|| FALLBACK_VERIFICATION_URL.into());
    let expires_in = positive_number_from(&body, "expiresIn").unwrap_or(DEFAULT_EXPIRES_SECONDS);
    let code = String::from_utf16_lossy(&code);
    // Kilo answers 410 once the code lapses, but the caller's poll loop
    // should not need a round trip to learn what it already knows.
    let mut extra = serde_json::Map::new();
    omni_ir::deep::insert(
        &mut extra,
        "expiresAt".into(),
        omni_ir::stream::number(now + expires_in * 1000.0),
    );
    Ok(AuthorizeStart {
        authorize_url: verification_url,
        // Kilo's one code is both the poll handle and what the operator reads.
        user_code: Some(code.clone()),
        pending: PendingFlow {
            verifier: String::new(),
            challenge: String::new(),
            state: String::new(),
            redirect_uri: String::new(),
            device_code: Some(code),
            interval: Some(POLL_INTERVAL_SECONDS),
            extra,
        },
    })
}

/// One poll's request. The caller owns the loop; the local deadline is checked
/// here so an expired code costs no round trip.
pub fn exchange_request(pending: &PendingFlow, now: f64) -> Result<AuthRequest, GatewayError> {
    let Some(code) = pending.device_code.as_deref() else {
        // INTERNAL: only `begin()` produces a usable pending flow, so reaching
        // here is a gateway bug rather than anything the operator or Kilo did.
        return Err(GatewayError::new(
            ErrorCode::Internal,
            "kilo exchange requires a pending flow produced by begin()",
        ));
    };
    let expires_at = pending
        .extra
        .get("expiresAt")
        .and_then(serde_json::Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0);
    if expires_at.is_some_and(|expires_at| now >= expires_at) {
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "kilo device code expired; start the authorization again",
        ));
    }
    // The poll is what earns the token; there is nothing to send yet, and
    // sending nothing is the stated intent — the code itself is the handle.
    Ok(AuthRequest {
        url: format!("{CODES_URL}/{}", encode_uri_component(code)),
        method: "GET".into(),
        headers: super::profile::headers(vec![("Accept".into(), "application/json".into())]),
        body: String::new(),
    })
}

/// One poll's outcome. `Pending` is control flow ("keep polling"), not a
/// failure: 202, and any 200 whose status is not yet "approved".
pub fn poll_result(status: u16, text: &str) -> Result<FlowResult, DeviceError> {
    if status == 202 {
        return Err(DeviceError::Pending);
    }
    if status == 403 {
        return Err(GatewayError::new(ErrorCode::Auth, "kilo authorization was denied").into());
    }
    if status == 410 {
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "kilo device code expired; start the authorization again",
        )
        .into());
    }
    if !(200..300).contains(&status) {
        return Err(GatewayError::new(
            status_code(status),
            format!("kilo refused the device code poll: http_{status}"),
        )
        .into());
    }
    let body = parsed(text);
    if !body.is_object() {
        return Err(DeviceError::Pending);
    }
    // Any status but "approved" is a state on the way there, not a failure.
    let approved =
        string_from(&body, "status").is_some_and(|s| String::from_utf16_lossy(s) == "approved");
    if !approved {
        return Err(DeviceError::Pending);
    }
    let token = string_from(&body, "token")
        .ok_or_else(|| {
            GatewayError::new(
                ErrorCode::Auth,
                "kilo approved the authorization without a token",
            )
        })?
        .clone();
    Ok(FlowResult {
        access_token: token,
        // Kilo issues neither a refresh token nor an expiry. Recording
        // anything else here would have the scheduler chase a refresh that
        // cannot work.
        refresh_token: None,
        id_token: None,
        expires_at: None,
        account_email: string_from(&body, "userEmail").map(|s| JsValue::String(s.clone())),
        provider_data: serde_json::Map::new(),
    })
}

/// The best-effort organization read, sent with the token the poll just
/// returned. The host applies the 15 second timeout.
pub fn org_request(access: &str) -> AuthRequest {
    AuthRequest {
        url: PROFILE_URL.into(),
        method: "GET".into(),
        headers: super::profile::headers(vec![
            ("Authorization".into(), format!("Bearer {access}")),
            ("Accept".into(), "application/json".into()),
        ]),
        body: String::new(),
    }
}

/// The organization the credential bills to, or nothing.
///
/// Best-effort by construction: an account with no organization is normal, and
/// a failed read here must not fail a connect the operator already approved in
/// their browser. It must never be reported as `AUTH` either — that code
/// disables credentials — so nothing escapes this step.
pub fn org_id(status: u16, text: &str) -> Option<String> {
    if !(200..300).contains(&status) {
        return None;
    }
    let body = parsed(text);
    let JsValue::Array(organizations) = get(&body, "organizations")? else {
        return None;
    };
    let first = organizations.first()?;
    string_from(first, "id").map(|s| String::from_utf16_lossy(s))
}

/// Kilo issues no refresh token and no expiry, so every refresh path should
/// be unreachable. `AUTH` is deliberate: if some future path does reach here,
/// the credential really is unusable until the operator reconnects, and
/// `AUTH` is what records that rather than retrying forever.
pub fn refresh_refusal() -> GatewayError {
    GatewayError::new(
        ErrorCode::Auth,
        "kilo tokens cannot be refreshed; reconnect the kilo account to get a new one",
    )
}

/// `encodeURIComponent`: everything outside the unreserved set is percent
/// encoded from its UTF-8 bytes, uppercase hex.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A non-JSON body is a real answer — an HTML error page, an empty 502 — so
/// it parses to null and the caller falls back to the status.
fn parsed(text: &str) -> JsValue {
    parse_js(text).unwrap_or(JsValue::Null)
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
