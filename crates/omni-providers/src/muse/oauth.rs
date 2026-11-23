//! Muse Code's device flow, and the key mint that follows it; the host owns
//! HTTP, the polling loop and the deadline.
//!
//! Two stages, which is what makes this flow unlike the others. RFC 8628
//! against `auth.meta.com` earns an access token, and that token is then spent
//! at `muse-code/key` for a **Model API key** — which is what the inference
//! host actually accepts. So exchange and refresh both end in a mint, and the
//! credential carries all three secrets: the OAuth pair for renewing, and the
//! minted key for every request.
//!
//! Every constant here is read out of Muse's own shipped client: the
//! endpoints, client id and grant type from the launcher shell script served
//! at `api.meta.ai/muse-launcher.sh`, and the mint path and its response shape
//! from the release binary. Meta publishes no reference for any of it.
use crate::oauth::{
    AuthRequest, AuthorizeStart, DeviceError, FlowResult, PendingFlow, token_error,
};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    jsjson::{JsValue, parse_js},
};
use serde_json::{Map, Value, json};

const DEVICE_CODE_URL: &str = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL: &str = "https://auth.meta.com/oidc/device/token/";
const MINT_URL: &str = "https://api.meta.ai/muse-code/key";

/// Public client id of Muse Code itself. A public client holds no secret —
/// this ships in a shell script anyone can curl, and the device flow is
/// protected by the user's approval at the verification page, not by the id
/// being unknown.
const CLIENT_ID: &str = "1031625952748946";
const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Where the operator ends up if `begin()` never got to state a URL. Quoted
/// from a live `device/authorization/` response rather than guessed: the
/// verification page is under `/oauth/`.
const FALLBACK_VERIFICATION_URL: &str = "https://auth.meta.com/oauth/device/";
const DEFAULT_INTERVAL_SECONDS: f64 = 5.0;

/// Origins the auth steps may talk to; hosts feed this to their bounded
/// runner. Two, because the flow spans the auth host and the mint host.
pub const AUTH_ORIGINS: &[&str] = &["https://auth.meta.com", "https://api.meta.ai"];

/// The token grant's outcome, before the mint spends it.
pub struct Token {
    pub access_token: Vec<u16>,
    pub refresh_token: Option<Vec<u16>>,
    pub expires_in: Option<f64>,
}

/// Mints the device code. Takes no device id: Muse has no device identity —
/// the launcher sends `client_id` and nothing else.
pub fn begin_request() -> AuthRequest {
    post_request(DEVICE_CODE_URL, &[])
}

pub fn begin_result(status: u16, text: &str) -> Result<AuthorizeStart, GatewayError> {
    let body = post_outcome(status, text).map_err(PostError::into_gateway)?;
    let device_code = string_from(&body, "device_code");
    let user_code = string_from(&body, "user_code");
    let (Some(device_code), Some(user_code)) = (device_code, user_code) else {
        // The client's own wording for this case, which names the two fields.
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "device authorization response missing user_code or verification_uri",
        ));
    };
    // `verification_uri_complete` embeds the code, so the operator approves in
    // one click. The bare uri is the fallback, and a constant behind that.
    let verification_uri = string_from(&body, "verification_uri_complete")
        .or_else(|| string_from(&body, "verification_uri"))
        .map(|s| String::from_utf16_lossy(s))
        .unwrap_or_else(|| FALLBACK_VERIFICATION_URL.into());
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
            extra: Map::new(),
        },
        user_code: Some(String::from_utf16_lossy(user_code)),
    })
}

pub fn exchange_request(pending: &PendingFlow) -> Result<AuthRequest, GatewayError> {
    let Some(device_code) = pending.device_code.as_deref() else {
        // INTERNAL, never a bare error: an arbitrary throw reaches the
        // operator as the host's "muse oauth exchange threw", which names
        // neither the missing device code nor that this is a gateway bug.
        return Err(GatewayError::new(
            ErrorCode::Internal,
            "muse exchange requires a pending flow produced by begin()",
        ));
    };
    Ok(post_request(
        TOKEN_URL,
        &[
            ("grant_type", DEVICE_CODE_GRANT),
            ("device_code", device_code),
        ],
    ))
}

/// One poll's token half. The caller owns the loop and the deadline; on
/// success it spends the token via [`mint_request`] + [`exchange_result`].
pub fn poll_token(status: u16, text: &str) -> Result<Token, DeviceError> {
    let body = post_outcome(status, text).map_err(|e| match e {
        PostError::Pending(_) => DeviceError::Pending,
        PostError::Gateway(g) => DeviceError::Gateway(g),
    })?;
    Ok(token_from(&body)?)
}

pub fn refresh_request(token: &str) -> AuthRequest {
    post_request(
        TOKEN_URL,
        &[("grant_type", "refresh_token"), ("refresh_token", token)],
    )
}

/// The refresh grant's token half; a pending answer here is a failure, since
/// the host cannot poll on this path.
pub fn refresh_token_result(status: u16, text: &str) -> Result<Token, GatewayError> {
    let body = post_outcome(status, text).map_err(PostError::into_gateway)?;
    token_from(&body)
}

/// Spends the OAuth token on a Model API key.
///
/// This is the half that makes a subscription usable:
/// `api.meta.ai/v1/responses` does not accept the device-flow token, and the
/// client mints a key at startup for exactly that reason. The usage probe
/// sends the identical request: minting is a read of the account's existing
/// key, not an issue of a new one (measured — two mints seconds apart returned
/// a byte-identical `api_key`).
pub fn mint_request(access: &str) -> AuthRequest {
    AuthRequest {
        url: MINT_URL.into(),
        method: "POST".into(),
        headers: super::profile::headers(vec![
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), format!("Bearer {access}")),
            ("Accept".into(), "application/json".into()),
        ]),
        // `"{}"`, not `""`. An empty body is refused outright — measured
        // against the live endpoint, which answers 400 "Request body is
        // required but was empty or null" and mints nothing.
        body: "{}".into(),
    }
}

/// The mint's answer plus the grant that fetched it, as the credential the
/// store holds.
///
/// **Muse does not refresh. It re-logs in.** A completed device grant carries
/// `access_token` and `token_type` and nothing else — no `refresh_token`, no
/// `expires_in` — so `expires_at` is null on every muse credential and the
/// refresher, which wakes on a non-null expiry, never runs. The refresh path
/// is kept rather than made to throw: it costs nothing and the token endpoint
/// would accept the grant the day Meta issues a refresh token.
///
/// Inference does not depend on the OAuth token: the codec authenticates with
/// the minted key, which outlives the grant that fetched it. When the login
/// dies, traffic keeps flowing and only the usage probe starts answering 401,
/// which reads as unknown quota rather than disabling anything.
pub fn exchange_result(
    token: Token,
    status: u16,
    text: &str,
    fallback_refresh: Option<&str>,
    now: f64,
) -> Result<FlowResult, GatewayError> {
    // A non-JSON body is a real answer — an HTML error page, an empty 502 —
    // so it parses to null and falls into the unusable-response arm.
    let body = parse_js(text).unwrap_or(JsValue::Null);
    if !(200..300).contains(&status) {
        if status == 401 || status == 403 {
            // AUTH deliberately, and AUTH disables the credential: the
            // provider looked at the login and refused it. The operator's
            // next step is on Meta's site, so the sentence says so.
            return Err(GatewayError::new(
                ErrorCode::Auth,
                "muse rejected the saved login; reconnect the account or use a different one",
            ));
        }
        if status == 429 {
            return Err(GatewayError::new(
                ErrorCode::RateLimit,
                format!("muse rate limited the key mint: http_{status}"),
            ));
        }
        // **Not `token_error`**, which is written for a token endpoint and
        // maps every 4xx but 429 to AUTH. A 400, 404 or 408 from the mint says
        // the request or the endpoint was wrong — not that the login was
        // repudiated.
        return Err(GatewayError::new(
            ErrorCode::Upstream,
            format!("muse key mint failed: http_{status}"),
        ));
    }
    // `isRecord`: object **or array**, null excluded. An array carries no
    // fields, so it falls through to the empty-key refusal below.
    if !matches!(body, JsValue::Object(_) | JsValue::Array(_)) {
        return Err(GatewayError::new(
            ErrorCode::Upstream,
            "muse key mint returned an unusable response",
        ));
    }
    if matches!(get(&body, "require_payment"), Some(JsValue::Bool(true))) {
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "muse requires a payment method on the Meta account; add one at https://dev.meta.ai and reconnect",
        ));
    }
    let Some(api_key) = string_from(&body, "api_key") else {
        // The client's own wording. Distinct from a malformed body: a 200
        // with no key is what an account that has not finished Model API
        // onboarding gets.
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "muse key mint returned an empty api key; finish onboarding at https://dev.meta.ai and reconnect",
        ));
    };
    let api_key = api_key.clone();
    let email = string_from(&body, "user_email").cloned();
    let tier_name = string_from(&body, "subs_tier_name").cloned();
    let subscription_active = matches!(get(&body, "is_subs_active"), Some(JsValue::Bool(true)));
    let base_url = string_from(&body, "base_url")
        .map(|s| String::from_utf16_lossy(s))
        .and_then(|s| super::endpoint::trusted_str(&s));

    // Recorded for the console, never read back on the request path except
    // `baseUrl` — the codec authenticates with the key alone.
    // `subscriptionActive` false is a real state: a lapsed subscription still
    // mints a key that bills per token.
    let mut provider_data = Map::new();
    if let Some(tier) = tier_name {
        omni_ir::deep::insert(
            &mut provider_data,
            "subscriptionTier".into(),
            json!(String::from_utf16_lossy(&tier)),
        );
    }
    omni_ir::deep::insert(
        &mut provider_data,
        "subscriptionActive".into(),
        json!(subscription_active),
    );
    if let Some(base) = base_url {
        // Read back by the codec, which falls back to its own constant.
        // Stored rather than re-fetched because the codec holds no client.
        omni_ir::deep::insert(&mut provider_data, "baseUrl".into(), json!(base));
    }
    Ok(FlowResult {
        access_token: token.access_token,
        // A refresh response may omit `refresh_token`, meaning "keep using
        // the one you have". Reading that omission as null would destroy a
        // working credential on its first refresh.
        refresh_token: token
            .refresh_token
            .map(JsValue::String)
            .or_else(|| fallback_refresh.map(|s| JsValue::String(s.encode_utf16().collect()))),
        id_token: None,
        api_key: Some(api_key),
        expires_at: token.expires_in.map(|n| now + n * 1000.0),
        account_email: email.map(JsValue::String),
        provider_data,
    })
}

/// Reads Muse's subscription usage payload.
///
/// Two windows, and the field names are the client's own: `subs_usage` holds
/// `window` — the rolling one, which states its own length in
/// `window_duration_mins` — and `weekly`. Both carry `used_percent` and
/// `resets_at`, which the shared window reader already understands.
///
/// `window_duration_mins` is read rather than assumed to be 300: a window
/// filed under `fiveHour` but actually running three hours would have its
/// start inferred two hours early. The weekly snapshot states no duration;
/// `weekly` already means seven days downstream.
pub fn parse_usage(value: &Value, now: f64) -> Vec<Value> {
    // `recordOf`: arrays excluded, unlike the mint's `isRecord`.
    if !value.is_object() {
        return Vec::new();
    }
    let window = value.get("window").filter(|v| v.is_object());
    let mins = window.and_then(|w| crate::quota::num(w, &["window_duration_mins"]));
    [
        crate::quota::window_from(
            value.get("window").unwrap_or(&Value::Null),
            "fiveHour",
            now,
            mins.map(|m| m * 60_000.0),
        ),
        crate::quota::window_from(
            value.get("weekly").unwrap_or(&Value::Null),
            "weekly",
            now,
            None,
        ),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The form POST both auth endpoints take. `client_id` appends last, matching
/// the TS `new URLSearchParams({ ...body, client_id })` key order. No
/// client_secret: a public client has none. The profile carries
/// `x-api-version`, which the client sends on these calls too.
fn post_request(url: &str, pairs: &[(&str, &str)]) -> AuthRequest {
    AuthRequest {
        url: url.into(),
        method: "POST".into(),
        headers: super::profile::headers(vec![
            (
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            ),
            // These endpoints answer JSON; the profile asks for SSE because
            // every inference request does, and asking for it here would be
            // a lie upstream is entitled to act on.
            ("Accept".into(), "application/json".into()),
        ]),
        body: url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs.iter().copied())
            .append_pair("client_id", CLIENT_ID)
            .finish(),
    }
}

/// "Keep polling" as control flow, with the reason kept so begin/refresh —
/// where the host cannot poll — surface the pending message verbatim.
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
    let body = parse_js(text).unwrap_or(JsValue::Null);
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let raw = string_from(&body, "error").map(|s| String::from_utf16_lossy(s));
    let code = raw.clone().unwrap_or_else(|| format!("http_{status}"));
    // The host owns the loop, and widening its interval on `slow_down` is
    // its decision to make.
    if code == "authorization_pending" || code == "slow_down" {
        return Err(PostError::Pending(code));
    }
    if code == "expired_token" {
        return Err(PostError::Gateway(GatewayError::new(
            ErrorCode::Auth,
            "muse device code expired; start the authorization again",
        )));
    }
    Err(PostError::Gateway(token_error(
        status,
        &json!({ "error": raw }),
    )))
}

fn token_from(body: &JsValue) -> Result<Token, GatewayError> {
    let access_token = string_from(body, "access_token")
        .ok_or_else(|| {
            GatewayError::new(ErrorCode::Auth, "token endpoint returned no access_token")
        })?
        .clone();
    Ok(Token {
        access_token,
        refresh_token: string_from(body, "refresh_token").cloned(),
        expires_in: positive_number_from(body, "expires_in"),
    })
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
