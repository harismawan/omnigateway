//! Qoder's local-begin device flow. `begin` mints a PKCE pair and a synthetic
//! machine identity with zero HTTP; the host polls, and [`finish`] drives the
//! rest of the chain — userinfo, endpoint election, signed model listing —
//! through the bounded [`AuthExchange`] channel the host hands it.
//!
//! The credential is a bundle JSON-stringified into `accessToken`: the device
//! token, the account identity, the AES-wrapped auth envelope and the elected
//! origin travel together, so the codec never has to trust `providerData` for
//! anything it signs with.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::jsjson::{self, JsValue};
use serde_json::{Map, Value, json};

use crate::oauth::{
    AuthExchange, AuthRequest, AuthorizeStart, DeviceError, FlowResult, PendingFlow,
};

use super::crypto::encrypt_auth;
use super::endpoint::{trusted_inference_origin, trusted_str};
use super::model_catalog::{
    InvalidCatalog, bundle_rows, inference_rows, parse_model_catalog, public_model_catalog,
};

const OPENAPI: &str = "https://openapi.qoder.sh";
const CENTER: &str = "https://center.qoder.sh";
const CLIENT_ID: &str = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
const MODEL_LIST_PATH: &str = "/api/v2/model/list";

/// Origins the auth steps may talk to; hosts feed this to their bounded
/// runner. The browser URL (`qoder.com`) is never requested from here.
pub const AUTH_ORIGINS: &[&str] = &[
    "https://openapi.qoder.sh",
    "https://center.qoder.sh",
    "https://api1.qoder.sh",
    "https://api2.qoder.sh",
    "https://api3.qoder.sh",
];

/// `syntheticUuid`: a deterministic UUIDv4-shaped id over a seed.
pub(crate) fn synthetic_uuid(seed: &str) -> String {
    omni_crypto::codex::uuid_v4_from(seed)
}

/// `text`: a non-empty string with no control characters, so an upstream
/// value can never become header injection.
fn text(value: Option<&JsValue>) -> Option<String> {
    match value {
        Some(JsValue::String(s)) if !s.is_empty() && s.iter().all(|u| *u >= 0x20 && *u != 0x7f) => {
            Some(String::from_utf16_lossy(s))
        }
        _ => None,
    }
}

/// The same check over stored `providerData`, which is serde JSON.
fn text_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s))
            if !s.is_empty() && s.chars().all(|c| c >= '\u{20}' && c != '\u{7f}') =>
        {
            Some(s.clone())
        }
        _ => None,
    }
}

fn record(value: &JsValue) -> JsValue {
    if value.is_object() {
        value.clone()
    } else {
        JsValue::Object(Vec::new())
    }
}

/// `tokenErrorCode`: only a repudiation is AUTH; a bad minute upstream is not
/// a dead credential.
fn token_code(status: u16) -> ErrorCode {
    match status {
        429 => ErrorCode::RateLimit,
        400..=499 => ErrorCode::Auth,
        _ => ErrorCode::Upstream,
    }
}

/// Secondary reads must not turn transient timeouts into permanent token
/// rejection.
fn secondary_code(status: u16) -> ErrorCode {
    match status {
        401 | 403 => ErrorCode::Auth,
        429 => ErrorCode::RateLimit,
        408 => ErrorCode::Timeout,
        _ => ErrorCode::Upstream,
    }
}

/// A bad minute upstream, not a dead credential — and not the gateway's own
/// refusal either. TS throws its runner's cap/origin refusals PAST the flow,
/// so this catch never sees them; the Rust runner returns them here, marked
/// `gateway_authored`, and they must propagate rather than fall back.
fn transient(error: &GatewayError) -> bool {
    !error.gateway_authored
        && matches!(
            error.code,
            ErrorCode::Upstream | ErrorCode::Timeout | ErrorCode::RateLimit
        )
}

fn status_error(code: ErrorCode, message: &str, status: u16) -> GatewayError {
    let mut error = GatewayError::new(code, message);
    error.upstream_status = Some(status);
    error
}

/// Both the encoded and the plaintext read of a server body failed.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Invalid Qoder response")]
pub struct InvalidServerJson;

/// `decodeServerJson`: the CLI intentionally accepts plaintext JSON when
/// response decryption fails.
pub fn decode_server_json(body: &str) -> Result<JsValue, InvalidServerJson> {
    if let Ok(decoded) = omni_crypto::qoder::decode_body(body)
        && let Ok(value) = jsjson::parse_js(&decoded)
    {
        return Ok(value);
    }
    jsjson::parse_js(body).map_err(|_| InvalidServerJson)
}

/// `json`: a decoded record, or the one error every secondary read shares.
fn json(body: &str) -> Result<JsValue, GatewayError> {
    decode_server_json(body)
        .map(|v| record(&v))
        .map_err(|_| GatewayError::new(ErrorCode::Upstream, "Invalid Qoder response"))
}

/// `getJsonRequest` / `getJsonUnauthenticatedRequest`: bearer first, then
/// Accept, then the caller's extras, merged over the profile and ordered.
fn get_request(url: &str, access: Option<&str>, extra: &[(&str, &str)]) -> AuthRequest {
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(token) = access {
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }
    headers.push(("Accept".into(), "application/json".into()));
    headers.extend(extra.iter().map(|(k, v)| ((*k).into(), (*v).into())));
    AuthRequest {
        url: url.into(),
        method: "GET".into(),
        headers: super::profile::headers(headers),
        body: String::new(),
    }
}

/// `new Date(now).toUTCString()`.
fn http_date(now_ms: f64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms as i64)
        .map(|d| d.format("%a, %d %b %Y %H:%M:%S GMT").to_string())
        .unwrap_or_else(|| "Thu, 01 Jan 1970 00:00:00 GMT".into())
}

/// A `Date.parse` subset: RFC 3339, IMF-fixdate, naive ISO date-times (read as
/// UTC, the server's zone) and date-only forms. Anything else is NaN, which
/// the caller reads as "no absolute expiry stated".
fn parse_date(value: &str) -> Option<f64> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone as _, Utc};
    if let Ok(d) = DateTime::parse_from_rfc3339(value) {
        return Some(d.timestamp_millis() as f64);
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%a, %d %b %Y %H:%M:%S GMT",
    ] {
        if let Ok(d) = NaiveDateTime::parse_from_str(value, format) {
            return Some(Utc.from_utc_datetime(&d).timestamp_millis() as f64);
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(
            Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0)?)
                .timestamp_millis() as f64,
        );
    }
    None
}

/// `expires`: an absolute `expires_at` (string date, or seconds/milliseconds
/// judged by magnitude), else a relative `expires_in`, else nothing stated.
fn expires(token: &JsValue, now: f64) -> Option<f64> {
    match token.get("expires_at") {
        Some(JsValue::String(s)) => {
            if let Some(n) = parse_date(&String::from_utf16_lossy(s)) {
                return Some(n);
            }
        }
        Some(JsValue::Number(n)) if n.is_finite() && *n > 0.0 => {
            return Some(if *n > 1e12 { *n } else { *n * 1000.0 });
        }
        _ => {}
    }
    match token.get("expires_in") {
        Some(JsValue::Number(n)) if n.is_finite() && *n > 0.0 => Some(now + *n * 1000.0),
        _ => None,
    }
}

/// `begin`: the browser device URL needs no upstream request. A reconnect
/// keeps the machine identity the credential was minted with; a first connect
/// mints one.
pub fn begin(provider_data: Option<&Map<String, Value>>, now: f64) -> AuthorizeStart {
    let (verifier, challenge) = crate::oauth::pkce();
    let nonce = synthetic_uuid(&crate::oauth::random_state());
    let machine_id = provider_data
        .and_then(|d| text_value(d.get("machineId")))
        .unwrap_or_else(|| synthetic_uuid(&crate::oauth::random_state()));
    let params = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("challenge", &challenge)
        .append_pair("challenge_method", "S256")
        .append_pair("nonce", &nonce)
        .append_pair("machine_id", &machine_id)
        .append_pair("client_id", CLIENT_ID)
        .finish();
    let mut extra = Map::new();
    omni_ir::deep::insert(&mut extra, "machineId".into(), json!(machine_id));
    omni_ir::deep::insert(
        &mut extra,
        "deadline".into(),
        omni_ir::stream::number(now + 300_000.0),
    );
    AuthorizeStart {
        authorize_url: format!("https://qoder.com/device/selectAccounts?{params}"),
        pending: PendingFlow {
            verifier,
            challenge,
            state: nonce,
            redirect_uri: String::new(),
            // The flow is device-shaped but polls by nonce, not by a device
            // code; the empty marker is what the hosts key on.
            device_code: Some(String::new()),
            interval: Some(1.0),
            extra,
        },
        user_code: None,
    }
}

/// The poll request, after the flow's own expiry pre-check. Returns the
/// machine identity alongside so the poll parser and the finish chain share
/// the one the authorization was begun with.
pub fn exchange_request(
    pending: &PendingFlow,
    now: f64,
) -> Result<(AuthRequest, String), GatewayError> {
    let machine_id = text_value(pending.extra.get("machineId"));
    let deadline = pending.extra.get("deadline").and_then(Value::as_f64);
    let (Some(machine_id), Some(deadline)) = (machine_id, deadline) else {
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "Qoder authorization expired",
        ));
    };
    if now >= deadline {
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "Qoder authorization expired",
        ));
    }
    let params = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("nonce", &pending.state)
        .append_pair("verifier", &pending.verifier)
        .append_pair("challenge_method", "S256")
        .finish();
    Ok((
        get_request(
            &format!("{OPENAPI}/api/v1/deviceToken/poll?{params}"),
            None,
            &[],
        ),
        machine_id,
    ))
}

/// One poll: 404 is "not approved yet", any other non-2xx is a failure, and a
/// 2xx body is the token record [`finish`] consumes.
pub fn poll_result(status: u16, body: &str) -> Result<JsValue, DeviceError> {
    if status == 404 {
        return Err(DeviceError::Pending);
    }
    if !(200..300).contains(&status) {
        return Err(DeviceError::Gateway(status_error(
            token_code(status),
            "Qoder device authorization failed",
            status,
        )));
    }
    Ok(json(body)?)
}

/// The refresh POST. The machine identity is part of the grant: a credential
/// that lost it cannot be refreshed, only reconnected. It comes back alongside
/// the request so the finish chain signs with the same identity.
pub fn refresh_request(
    refresh_token: &str,
    provider_data: Option<&Map<String, Value>>,
) -> Result<(AuthRequest, String), GatewayError> {
    let machine_id = provider_data
        .and_then(|d| text_value(d.get("machineId")))
        .ok_or_else(|| {
            GatewayError::new(
                ErrorCode::Auth,
                "Qoder device identity missing; reconnect required",
            )
        })?;
    let mut body = Map::new();
    omni_ir::deep::insert(&mut body, "refresh_token".into(), json!(refresh_token));
    omni_ir::deep::insert(&mut body, "machine_id".into(), json!(machine_id));
    Ok((
        AuthRequest {
            url: format!("{OPENAPI}/api/v1/deviceToken/refresh"),
            method: "POST".into(),
            headers: super::profile::headers(vec![
                ("Content-Type".into(), "application/json".into()),
                ("Accept".into(), "application/json".into()),
            ]),
            body: jsjson::to_string(&Value::Object(body)),
        },
        machine_id,
    ))
}

/// The refresh response as the token record [`finish`] consumes, with the
/// old refresh token kept when the response does not rotate it.
pub fn refresh_token_result(
    status: u16,
    body: &str,
    fallback: &str,
) -> Result<JsValue, GatewayError> {
    if !(200..300).contains(&status) {
        return Err(status_error(
            token_code(status),
            "Qoder token refresh failed",
            status,
        ));
    }
    let mut token = json(body)?;
    let refresh = text(token.get("refresh_token")).unwrap_or_else(|| fallback.to_owned());
    token.put(
        "refresh_token".encode_utf16().collect(),
        JsValue::String(refresh.encode_utf16().collect()),
    );
    Ok(token)
}

/// `read`: the account-level userinfo read every finish starts with.
async fn read_userinfo(
    exchange: &mut dyn AuthExchange,
    access: &str,
) -> Result<JsValue, GatewayError> {
    let (status, body) = exchange
        .exchange(
            get_request(&format!("{OPENAPI}/api/v1/userinfo"), Some(access), &[]),
            15,
        )
        .await?;
    if !(200..300).contains(&status) {
        return Err(status_error(
            secondary_code(status),
            "Qoder account request failed",
            status,
        ));
    }
    json(&body)
}

/// `discover`: the v5 election, falling back to the anonymous signed v3 when
/// the account is refused, and trusting only the shipped inference origins.
async fn discover(
    exchange: &mut dyn AuthExchange,
    access: &str,
    uid: &str,
    machine_id: &str,
    now: &(dyn Fn() -> f64 + Sync),
) -> Result<String, GatewayError> {
    let (mut status, mut body) = exchange
        .exchange(
            get_request(
                &format!("{CENTER}/algo/api/v5/service/region/endpoints"),
                Some(access),
                &[
                    ("x-gw-user-id", uid),
                    ("Cosy-MachineId", machine_id),
                    ("Cosy-MachineToken", machine_id),
                ],
            ),
            15,
        )
        .await?;
    let mut v3 = false;
    if status == 401 || status == 403 {
        v3 = true;
        // Fresh clock, as TS reads `input.now()` at the anonymous leg.
        let date = http_date(now());
        let signature = omni_crypto::qoder::sign_anonymous(&date);
        (status, body) = exchange
            .exchange(
                get_request(
                    &format!("{CENTER}/algo/api/v3/service/region/endpoints"),
                    None,
                    &[
                        ("Appcode", "cosy"),
                        ("Date", &date),
                        ("Signature", &signature),
                        ("Cosy-MachineId", machine_id),
                    ],
                ),
                15,
            )
            .await?;
    }
    if !(200..300).contains(&status) {
        return Err(status_error(
            secondary_code(status),
            "Qoder endpoint discovery failed",
            status,
        ));
    }
    let nodes = json(&body)?;
    if let Some(JsValue::Array(nodes)) = nodes.get("inferNodes") {
        for node in nodes {
            let candidate = if v3 {
                Some(node)
            } else {
                node.is_object().then_some(node).and_then(|n| n.get("url"))
            };
            if let Some(origin) = candidate.and_then(trusted_inference_origin) {
                return Ok(origin);
            }
        }
    }
    Err(GatewayError::new(
        ErrorCode::Upstream,
        "Qoder returned no trusted inference endpoint",
    ))
}

/// `finish`: the chain after a token grant — userinfo, endpoint election,
/// signed model listing — assembled into the credential bundle. At most four
/// requests beyond the grant itself; the host's runner caps the total.
///
/// `previous` is the stored `providerData` on refresh and empty on a first
/// exchange, exactly as the TS flow passes it: it seeds the last-good origin
/// and catalog when a transient failure would otherwise lose them.
///
/// `now` is a clock, not a timestamp: TS reads `input.now()` freshly at the
/// anonymous v3 `Date`, the listing's `Cosy-Date`, `issuedAt` and the expiry,
/// and a chain that spans seconds must sign each step with its own minute.
pub async fn finish(
    exchange: &mut dyn AuthExchange,
    token: &JsValue,
    machine_id: &str,
    now: &(dyn Fn() -> f64 + Sync),
    random_state: &str,
    previous: &Map<String, Value>,
) -> Result<FlowResult, GatewayError> {
    let access = text(token.get("token"))
        .or_else(|| text(token.get("device_token")))
        .ok_or_else(|| GatewayError::new(ErrorCode::Upstream, "Qoder returned no device token"))?;
    let user = read_userinfo(exchange, &access).await?;
    let user_id = text(user.get("id"))
        .or_else(|| text(user.get("user_id")))
        .or_else(|| text(user.get("uid")));
    let uid = text(token.get("user_id")).or_else(|| user_id.clone());
    let (Some(uid), Some(user_id)) = (uid, user_id) else {
        return Err(GatewayError::new(
            ErrorCode::Upstream,
            "Invalid Qoder account identity",
        ));
    };
    if user_id != uid {
        return Err(GatewayError::new(
            ErrorCode::Upstream,
            "Invalid Qoder account identity",
        ));
    }
    let mut auth_user = Map::new();
    omni_ir::deep::insert(&mut auth_user, "uid".into(), json!(uid));
    omni_ir::deep::insert(&mut auth_user, "security_oauth_token".into(), json!(access));
    omni_ir::deep::insert(&mut auth_user, "data_policy_agreed".into(), json!(false));
    let org = user.get("organization").filter(|v| v.is_object());
    let organization_id = text(user.get("orgId"))
        .or_else(|| text(user.get("organization_id")))
        .or_else(|| text(user.get("organizationId")))
        .or_else(|| text(org.and_then(|o| o.get("org_id"))))
        .or_else(|| text(org.and_then(|o| o.get("id"))));
    if let Some(organization_id) = organization_id {
        omni_ir::deep::insert(
            &mut auth_user,
            "organization_id".into(),
            json!(organization_id),
        );
    }
    let key: String = {
        use rand::Rng as _;
        let mut bytes = [0u8; 8];
        rand::rng().fill_bytes(&mut bytes);
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    };
    let envelope = encrypt_auth(&jsjson::to_string(&Value::Object(auth_user)), &key)
        // Unreachable: the key above is always 16 lowercase hex characters.
        .map_err(|_| GatewayError::new(ErrorCode::Upstream, "Invalid Qoder encryption key"))?;

    let origin = match discover(exchange, &access, &uid, machine_id, now).await {
        Ok(origin) => origin,
        Err(error) => {
            // A transient failure falls back to the last-good origin; a
            // repudiation (or no last-good) propagates.
            let last_good = previous
                .get("inferenceOrigin")
                .and_then(Value::as_str)
                .and_then(trusted_str);
            match last_good {
                Some(origin) if transient(&error) => origin,
                _ => return Err(error),
            }
        }
    };

    let mut auth = Map::new();
    omni_ir::deep::insert(&mut auth, "version".into(), json!("v1"));
    omni_ir::deep::insert(
        &mut auth,
        "requestId".into(),
        json!(synthetic_uuid(random_state)),
    );
    omni_ir::deep::insert(&mut auth, "info".into(), json!(envelope.encrypt_user_info));
    omni_ir::deep::insert(
        &mut auth,
        "cosyVersion".into(),
        json!(super::profile::version()),
    );
    omni_ir::deep::insert(&mut auth, "ideVersion".into(), json!(""));
    let auth_base64 = B64.encode(jsjson::to_string(&Value::Object(auth)));
    let date = format!("{}", (now() / 1000.0).floor() as i64);
    let signature =
        omni_crypto::qoder::sign_auth(&auth_base64, &envelope.key, &date, "", MODEL_LIST_PATH);
    let listing = exchange
        .exchange(
            get_request(
                &format!("{origin}/algo{MODEL_LIST_PATH}?Encode=1"),
                None,
                &[
                    (
                        "Authorization",
                        &format!("Bearer COSY.{auth_base64}.{signature}"),
                    ),
                    ("Cosy-Key", &envelope.key),
                    ("Cosy-Date", &date),
                    ("Cosy-User", &uid),
                    ("Cosy-MachineId", machine_id),
                    ("Cosy-MachineToken", machine_id),
                    ("Cosy-Version", &super::profile::version()),
                    ("Cosy-ClientType", "5"),
                    ("Cosy-Scene", "assistant"),
                    ("Login-Version", "v2"),
                ],
            ),
            15,
        )
        .await;
    let (status, body) = match listing {
        Ok(response) => response,
        // A transport failure is a bad minute, not a dead credential: read it
        // as the unavailable listing it is.
        Err(error) if transient(&error) => (503, String::new()),
        Err(error) => return Err(error),
    };
    let unavailable = status == 408 || status == 429 || status >= 500;
    if !unavailable && !(200..300).contains(&status) {
        return Err(status_error(
            secondary_code(status),
            "Qoder model listing failed",
            status,
        ));
    }
    let models = if unavailable {
        let rows = previous
            .get("inferenceModels")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().map(JsValue::from).collect())
            .unwrap_or_default();
        parse_model_catalog(&JsValue::object([("assistant", JsValue::Array(rows))]))
    } else {
        decode_server_json(&body)
            .map_err(|_| InvalidCatalog)
            .and_then(|v| parse_model_catalog(&v))
    }
    .map_err(|_| GatewayError::new(ErrorCode::Upstream, "Invalid Qoder model catalog"))?;

    let mut bundle = Map::new();
    omni_ir::deep::insert(&mut bundle, "version".into(), json!(1));
    omni_ir::deep::insert(&mut bundle, "deviceToken".into(), json!(access));
    omni_ir::deep::insert(&mut bundle, "uid".into(), json!(uid));
    omni_ir::deep::insert(&mut bundle, "machineId".into(), json!(machine_id));
    omni_ir::deep::insert(
        &mut bundle,
        "encryptUserInfo".into(),
        json!(envelope.encrypt_user_info),
    );
    omni_ir::deep::insert(&mut bundle, "key".into(), json!(envelope.key));
    omni_ir::deep::insert(&mut bundle, "origin".into(), json!(origin));
    omni_ir::deep::insert(&mut bundle, "models".into(), bundle_rows(&models));
    omni_ir::deep::insert(
        &mut bundle,
        "issuedAt".into(),
        omni_ir::stream::number(now()),
    );
    let access_token = jsjson::to_string(&Value::Object(bundle));

    let mut provider_data = omni_ir::deep::clone_map(previous);
    omni_ir::deep::insert(&mut provider_data, "machineId".into(), json!(machine_id));
    omni_ir::deep::insert(&mut provider_data, "uid".into(), json!(uid));
    omni_ir::deep::insert(&mut provider_data, "inferenceOrigin".into(), json!(origin));
    if unavailable {
        omni_ir::deep::insert(
            &mut provider_data,
            "catalogStatus".into(),
            json!("unavailable"),
        );
    } else {
        omni_ir::deep::insert(
            &mut provider_data,
            "catalogStatus".into(),
            json!("available"),
        );
        omni_ir::deep::insert(
            &mut provider_data,
            "modelCatalog".into(),
            Value::Object(public_model_catalog(&models)),
        );
    }
    omni_ir::deep::insert(
        &mut provider_data,
        "inferenceModels".into(),
        inference_rows(&models),
    );

    Ok(FlowResult {
        access_token: access_token.encode_utf16().collect(),
        refresh_token: text(token.get("refresh_token"))
            .map(|s| JsValue::String(s.encode_utf16().collect())),
        id_token: None,
        api_key: None,
        expires_at: expires(token, now()),
        account_email: text(user.get("email")).map(|s| JsValue::String(s.encode_utf16().collect())),
        provider_data,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::oauth::ExchangeFuture;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// A scripted finish-chain channel: records every described request and
    /// answers from a queue, so tests can pin headers, dates and fallbacks.
    struct Scripted {
        replies: std::collections::VecDeque<Result<(u16, String), GatewayError>>,
        seen: Vec<AuthRequest>,
    }
    impl Scripted {
        fn new(replies: Vec<Result<(u16, String), GatewayError>>) -> Self {
            Self {
                replies: replies.into(),
                seen: Vec::new(),
            }
        }
    }
    impl AuthExchange for Scripted {
        fn exchange<'a>(&'a mut self, request: AuthRequest, _seconds: u64) -> ExchangeFuture<'a> {
            self.seen.push(request);
            let reply = self.replies.pop_front().expect("scripted reply");
            Box::pin(async move { reply })
        }
    }

    fn ok(body: &str) -> Result<(u16, String), GatewayError> {
        Ok((200, body.into()))
    }
    const USER: &str = r#"{"id":"u1","email":"u@example.test"}"#;
    const MODELS: &str = r#"{"assistant":[{"key":"synthetic","display_name":"Synthetic","is_vl":true,"max_input_tokens":1234}]}"#;

    fn token() -> JsValue {
        jsjson::parse_js(r#"{"token":"device-tok","user_id":"u1","expires_in":10}"#).unwrap()
    }
    fn header<'a>(request: &'a AuthRequest, name: &str) -> Option<&'a str> {
        request
            .headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    fn bundle_of(result: &FlowResult) -> Value {
        serde_json::from_str(&String::from_utf16_lossy(&result.access_token)).unwrap()
    }

    #[tokio::test]
    async fn finish_reads_the_clock_freshly_at_each_dated_step() {
        // One minute per read: TS reads input.now() at the anonymous v3 Date,
        // the listing's Cosy-Date, issuedAt and the expiry — never once for
        // the whole chain.
        let ticks = AtomicI64::new(0);
        let clock = || (1_000_000 + ticks.fetch_add(1, Ordering::SeqCst) * 60_000) as f64;
        let mut exchange = Scripted::new(vec![
            ok(USER),
            Ok((403, "{}".into())),
            ok(r#"{"inferNodes":["https://api1.qoder.sh"]}"#),
            ok(MODELS),
        ]);
        let result = finish(
            &mut exchange,
            &token(),
            "machine-1",
            &clock,
            "state-seed",
            &Map::new(),
        )
        .await
        .expect("finish");
        // The anonymous v3 leg signs the FIRST read's date.
        let date = http_date(1_000_000.0);
        assert_eq!(header(&exchange.seen[2], "Date"), Some(date.as_str()));
        assert_eq!(
            header(&exchange.seen[2], "Signature"),
            Some(omni_crypto::qoder::sign_anonymous(&date).as_str())
        );
        // The listing's Cosy-Date is the SECOND read, a minute later, and the
        // COSY signature is computed over that fresh date.
        assert_eq!(header(&exchange.seen[3], "Cosy-Date"), Some("1060"));
        let bundle = bundle_of(&result);
        let auth = header(&exchange.seen[3], "Authorization").unwrap();
        let parts: Vec<_> = auth.trim_start_matches("Bearer COSY.").split('.').collect();
        assert_eq!(
            parts[1],
            omni_crypto::qoder::sign_auth(
                parts[0],
                bundle["key"].as_str().unwrap(),
                "1060",
                "",
                MODEL_LIST_PATH
            )
        );
        // issuedAt is the THIRD read; the relative expiry rides the FOURTH.
        assert_eq!(bundle["issuedAt"].as_f64(), Some(1_120_000.0));
        assert_eq!(result.expires_at, Some(1_190_000.0));
    }

    #[tokio::test]
    async fn gateway_authored_discovery_refusal_never_falls_back_to_last_good() {
        // TS throws its runner's cap/origin refusals past the flow, so the
        // last-good fallback never sees them; a transport failure IS raised
        // into the step and stays transient.
        for authored in [false, true] {
            let mut refusal = GatewayError::new(
                ErrorCode::Upstream,
                "qoder oauth refresh asked for more than 5 requests",
            );
            if authored {
                refusal = refusal.gateway_authored();
            }
            let mut replies = vec![ok(USER), Err(refusal)];
            if !authored {
                replies.push(ok(MODELS));
            }
            let mut exchange = Scripted::new(replies);
            let previous = json!({"inferenceOrigin":"https://api2.qoder.sh"})
                .as_object()
                .cloned()
                .unwrap();
            let clock = || 1_000_000.0;
            let outcome = finish(
                &mut exchange,
                &token(),
                "machine-1",
                &clock,
                "state-seed",
                &previous,
            )
            .await;
            if authored {
                assert_eq!(
                    outcome.err().expect("authored refusal propagates").message,
                    "qoder oauth refresh asked for more than 5 requests"
                );
            } else {
                let result = outcome.expect("transport failure falls back");
                assert_eq!(bundle_of(&result)["origin"], "https://api2.qoder.sh");
            }
        }
    }

    #[tokio::test]
    async fn gateway_authored_listing_refusal_is_not_an_unavailable_catalog() {
        for authored in [false, true] {
            let mut refusal = GatewayError::new(
                ErrorCode::Upstream,
                "qoder oauth exchange described a request to an origin its manifest does not declare",
            );
            if authored {
                refusal = refusal.gateway_authored();
            }
            let mut exchange = Scripted::new(vec![
                ok(USER),
                ok(r#"{"inferNodes":[{"url":"https://api1.qoder.sh"}]}"#),
                Err(refusal),
            ]);
            let previous = json!({
                "inferenceOrigin":"https://api1.qoder.sh",
                "inferenceModels":[{"key":"synthetic","display_name":"Synthetic","is_vl":true,"is_reasoning":false,"max_input_tokens":1234}]
            })
            .as_object()
            .cloned()
            .unwrap();
            let clock = || 1_000_000.0;
            let outcome = finish(
                &mut exchange,
                &token(),
                "machine-1",
                &clock,
                "state-seed",
                &previous,
            )
            .await;
            if authored {
                assert_eq!(
                    outcome.err().expect("authored refusal propagates").message,
                    "qoder oauth exchange described a request to an origin its manifest does not declare"
                );
            } else {
                let result = outcome.expect("transient outage tolerated");
                assert_eq!(result.provider_data["catalogStatus"], json!("unavailable"));
            }
        }
    }

    /// Independent MD5 hex, so the signature assertions below are not the
    /// signing function checking itself.
    fn md5_hex(input: &str) -> String {
        use md5::{Digest as _, Md5};
        Md5::digest(input.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[tokio::test]
    async fn finish_pins_the_golden_request_headers_and_cosy_signature() {
        let mut exchange = Scripted::new(vec![
            ok(USER),
            Ok((401, "{}".into())),
            ok(r#"{"inferNodes":["https://api2.qoder.sh"]}"#),
            ok(MODELS),
        ]);
        let clock = || 1_000_000.0;
        let result = finish(
            &mut exchange,
            &token(),
            "machine-1",
            &clock,
            "state-seed",
            &Map::new(),
        )
        .await
        .expect("finish");
        // userinfo: bearer first, then Accept, then the profile's User-Agent.
        assert_eq!(
            exchange.seen[0].url,
            "https://openapi.qoder.sh/api/v1/userinfo"
        );
        assert_eq!(exchange.seen[0].method, "GET");
        assert_eq!(
            exchange.seen[0].headers,
            vec![
                ("Authorization".into(), "Bearer device-tok".into()),
                ("Accept".into(), "application/json".into()),
                ("User-Agent".into(), "qoder/1.1.82".into()),
            ]
        );
        // v5 election: the account identity rides x-gw-user-id, and the machine
        // identity is both Cosy-MachineId and Cosy-MachineToken.
        assert_eq!(
            exchange.seen[1].url,
            "https://center.qoder.sh/algo/api/v5/service/region/endpoints"
        );
        assert_eq!(
            exchange.seen[1].headers,
            vec![
                ("Authorization".into(), "Bearer device-tok".into()),
                ("Accept".into(), "application/json".into()),
                ("User-Agent".into(), "qoder/1.1.82".into()),
                ("x-gw-user-id".into(), "u1".into()),
                ("Cosy-MachineId".into(), "machine-1".into()),
                ("Cosy-MachineToken".into(), "machine-1".into()),
            ]
        );
        // The anonymous v3 leg: Appcode/Date/Signature, no bearer, and the
        // signature is the independent MD5 of the TS constant and the date.
        assert_eq!(
            exchange.seen[2].url,
            "https://center.qoder.sh/algo/api/v3/service/region/endpoints"
        );
        let date = "Thu, 01 Jan 1970 00:16:40 GMT";
        let anonymous = md5_hex(&format!("cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&{date}"));
        assert_eq!(anonymous, "d351fa13ded178b3ae0c742a73a80901");
        assert_eq!(
            exchange.seen[2].headers,
            vec![
                ("Accept".into(), "application/json".into()),
                ("User-Agent".into(), "qoder/1.1.82".into()),
                ("Appcode".into(), "cosy".into()),
                ("Date".into(), date.into()),
                ("Signature".into(), anonymous),
                ("Cosy-MachineId".into(), "machine-1".into()),
            ]
        );
        // The signed listing, in the profile's exact order.
        let listing = &exchange.seen[3];
        assert_eq!(
            listing.url,
            "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1"
        );
        let bundle = bundle_of(&result);
        let auth = header(listing, "Authorization").expect("authorization");
        let parts: Vec<_> = auth.trim_start_matches("Bearer COSY.").split('.').collect();
        assert_eq!(parts.len(), 2);
        // authBase64 is the TS object literal's field order, with the
        // deterministic requestId over the flow's randomState seed.
        let request_id = omni_crypto::codex::uuid_v4_from("state-seed");
        let info = bundle["encryptUserInfo"].as_str().expect("info");
        assert_eq!(
            String::from_utf8(B64.decode(parts[0]).expect("auth base64")).expect("utf8"),
            format!(
                r#"{{"version":"v1","requestId":"{request_id}","info":"{info}","cosyVersion":"1.1.82","ideVersion":""}}"#
            )
        );
        let key = header(listing, "Cosy-Key").expect("key");
        assert_eq!(key, bundle["key"].as_str().expect("key"));
        assert_eq!(B64.decode(key).expect("wrapped key").len(), 128);
        // Independent MD5 over [authBase64, key, date, body, path].join("\n"),
        // with the canonical path — never the /algo-prefixed request path.
        let signature = md5_hex(&format!(
            "{}\n{}\n1000\n\n/api/v2/model/list",
            parts[0], key
        ));
        assert_eq!(parts[1], signature);
        assert_eq!(
            listing.headers,
            vec![
                ("Authorization".into(), auth.into()),
                ("Accept".into(), "application/json".into()),
                ("User-Agent".into(), "qoder/1.1.82".into()),
                ("Cosy-Key".into(), key.into()),
                ("Cosy-Date".into(), "1000".into()),
                ("Cosy-User".into(), "u1".into()),
                ("Cosy-MachineId".into(), "machine-1".into()),
                ("Cosy-MachineToken".into(), "machine-1".into()),
                ("Cosy-Version".into(), "1.1.82".into()),
                ("Cosy-ClientType".into(), "5".into()),
                ("Cosy-Scene".into(), "assistant".into()),
                ("Login-Version".into(), "v2".into()),
            ]
        );
    }

    #[tokio::test]
    async fn an_untrusted_stored_origin_never_seeds_the_discovery_fallback() {
        // The last-good fallback only honours the three shipped inference
        // origins; a stored value outside them is not a fallback, even when
        // the discovery failure is transient (TS trustedInferenceOrigin).
        for origin in [
            "https://evil.example",
            "https://api4.qoder.sh",
            "http://api1.qoder.sh",
            "https://api1.qoder.sh.evil.test",
            "https://api1.qoder.sh/path",
        ] {
            let mut exchange = Scripted::new(vec![
                ok(USER),
                Err(GatewayError::new(
                    ErrorCode::Upstream,
                    "qoder oauth refresh threw",
                )),
            ]);
            let previous = json!({"inferenceOrigin": origin})
                .as_object()
                .cloned()
                .unwrap();
            let clock = || 1_000_000.0;
            let error = finish(
                &mut exchange,
                &token(),
                "machine-1",
                &clock,
                "state-seed",
                &previous,
            )
            .await
            .err()
            .expect(origin);
            assert_eq!(error.code, ErrorCode::Upstream, "{origin}");
            assert_eq!(error.message, "qoder oauth refresh threw", "{origin}");
            // userinfo and the v5 attempt only: no listing was ever signed.
            assert_eq!(exchange.seen.len(), 2, "{origin}");
        }
    }
}
