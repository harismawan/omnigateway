//! Pure PKCE + OIDC-discovery steps for grok; the host owns HTTP and the
//! bounded runner.
//!
//! Discovery runs on EVERY start, exchange and refresh — not cached: it is
//! rare enough that a cache would only add a way for a rotated endpoint to go
//! unnoticed. The discovered endpoints are honoured only under xAI's own
//! registrable domain, over TLS, and a violation is `UPSTREAM` rather than
//! `AUTH` on purpose: the refresher disables a credential on `AUTH`, and a
//! discovery document says nothing about whether the refresh token is still
//! good.
use crate::oauth::{AuthRequest, AuthorizeStart, FlowResult, PendingFlow, token_error};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    jsjson::{JsValue, parse_js},
};
use serde_json::{Map, Value};

/// Public client ID of xAI's own desktop client. A public PKCE client holds
/// no secret — this ships in a distributed binary and is protected by the
/// code challenge, not by being unknown.
const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";

/// The scopes xAI's client asks for. `offline_access` is what makes a refresh
/// token appear at all; `grok-cli:access` is what the chat proxy checks.
const SCOPES: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";

/// Endpoints are only honoured under this registrable domain.
const TRUSTED_HOST: &str = "x.ai";

/// The origin rule hosts feed to their bounded runner: TLS plus a host under
/// xAI's own domain. `ends_with(".x.ai")` rather than `ends_with("x.ai")`, so
/// that `evilx.ai` and `x.ai.attacker.example` are both refused.
pub fn trusted_origin(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| h == TRUSTED_HOST || h.ends_with(".x.ai"))
}

/// The endpoints a discovery document published, already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub authorize_url: String,
    pub token_url: String,
}

/// Reads xAI's OIDC metadata, as a request the host performs.
/// Unauthenticated on purpose, and said so by the absence of any credential:
/// discovery is what runs before there is anything to present. The host
/// applies the short (15 second) deadline — a connect flow waits on it.
pub fn discovery_request() -> AuthRequest {
    AuthRequest {
        url: DISCOVERY_URL.into(),
        method: "GET".into(),
        headers: super::profile::headers(vec![("Accept".into(), "application/json".into())]),
        body: String::new(),
    }
}

pub fn discovery_result(status: u16, text: &str) -> Result<Endpoints, GatewayError> {
    let upstream = |message: String| GatewayError::new(ErrorCode::Upstream, message);
    if !(200..300).contains(&status) {
        return Err(upstream(format!(
            "discovery endpoint returned http_{status}"
        )));
    }
    // An HTML error page is a real answer; it is just not a discovery
    // document, so the parse reads it as null and the shape check refuses it.
    let parsed = parse_js(text).unwrap_or(JsValue::Null);
    if !parsed.is_object() && !parsed.is_array() {
        return Err(upstream(
            "discovery endpoint returned an unusable response".into(),
        ));
    }
    Ok(Endpoints {
        authorize_url: trusted_endpoint(
            parsed.get("authorization_endpoint"),
            "authorization_endpoint",
        )?,
        token_url: trusted_endpoint(parsed.get("token_endpoint"), "token_endpoint")?,
    })
}

/// Accepts a discovered endpoint only if xAI could have published it. The
/// offending URL is deliberately not echoed: it is attacker-supplied text,
/// and the field name is enough to diagnose from.
fn trusted_endpoint(value: Option<&JsValue>, field: &str) -> Result<String, GatewayError> {
    let upstream = |message: String| GatewayError::new(ErrorCode::Upstream, message);
    let Some(JsValue::String(raw)) = value else {
        return Err(upstream(format!("discovery document has no {field}")));
    };
    let raw = String::from_utf16_lossy(raw);
    if omni_ir::js::trim(&raw).is_empty() {
        return Err(upstream(format!("discovery document has no {field}")));
    }
    let url = url::Url::parse(&raw)
        .map_err(|_| upstream(format!("discovery document has an unusable {field}")))?;
    if !trusted_origin(&url) {
        return Err(upstream(format!(
            "discovery document {field} is not an {TRUSTED_HOST} https url"
        )));
    }
    Ok(url.to_string())
}

/// Builds the authorize URL on the discovered endpoint. The host mints PKCE
/// and the CSRF state; `redirect_uri` is the caller's own loopback listener.
pub fn start(
    authorize_url: &str,
    redirect_uri: &str,
    verifier: &str,
    challenge: &str,
    state: &str,
) -> Result<AuthorizeStart, GatewayError> {
    let mut url = url::Url::parse(authorize_url).map_err(|_| {
        GatewayError::new(
            ErrorCode::Upstream,
            "discovery document has an unusable authorization_endpoint",
        )
    })?;
    // `searchParams.set`: the first occurrence keeps its position and takes
    // the new value, every later duplicate is removed, and a new name appends.
    let mut pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let mut set = |name: &str, value: &str| {
        let mut seen = false;
        pairs.retain_mut(|(k, v)| {
            if k != name {
                return true;
            }
            if seen {
                return false;
            }
            seen = true;
            v.clear();
            v.push_str(value);
            true
        });
        if !seen {
            pairs.push((name.to_owned(), value.to_owned()));
        }
    };
    set("response_type", "code");
    set("client_id", CLIENT_ID);
    set("redirect_uri", redirect_uri);
    set("scope", SCOPES);
    set("code_challenge", challenge);
    set("code_challenge_method", "S256");
    set("state", state);
    set("nonce", &crate::oauth::random_state());
    // xAI's own client identifies itself here. There is deliberately no
    // `plan` parameter: the widely copied `plan=generic&referrer=hermes-agent`
    // pair belongs to a different third-party product.
    set("referrer", "grok-build");
    url.query_pairs_mut()
        .clear()
        .extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    Ok(AuthorizeStart {
        authorize_url: url.to_string(),
        pending: PendingFlow {
            verifier: verifier.into(),
            challenge: challenge.into(),
            state: state.into(),
            redirect_uri: redirect_uri.into(),
            device_code: None,
            interval: None,
            extra: Map::new(),
        },
        user_code: None,
    })
}

/// Unpicks a pasted callback (`<code>#<state>`) and refuses a forged state
/// BEFORE any discovery request: the code must never leave the process on a
/// mismatch. Returns the trimmed raw code.
pub fn pasted_code(code: &str, pending: &PendingFlow) -> Result<String, GatewayError> {
    let mut parts = code.split('#');
    let raw_code = parts.next().unwrap_or("");
    if let Some(pasted_state) = parts.next()
        && pasted_state != pending.state
    {
        return Err(GatewayError::new(
            ErrorCode::Auth,
            "authorization state mismatch",
        ));
    }
    Ok(omni_ir::js::trim(raw_code).to_owned())
}

pub fn exchange_request(raw_code: &str, pending: &PendingFlow, token_url: &str) -> AuthRequest {
    post_token(
        token_url,
        &[
            ("grant_type", "authorization_code"),
            ("code", raw_code),
            ("redirect_uri", &pending.redirect_uri),
            ("client_id", CLIENT_ID),
            ("code_verifier", &pending.verifier),
        ],
    )
}

pub fn refresh_request(refresh_token: &str, token_url: &str) -> AuthRequest {
    post_token(
        token_url,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ],
    )
}

/// The form post the token endpoint takes. Form-encoded, and with no
/// client_secret: a public client has none to send.
fn post_token(url: &str, pairs: &[(&str, &str)]) -> AuthRequest {
    AuthRequest {
        url: url.into(),
        method: "POST".into(),
        headers: super::profile::headers(vec![
            (
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            ),
            ("Accept".into(), "application/json".into()),
        ]),
        body: url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs.iter().copied())
            .finish(),
    }
}

/// Reads the stored agent identity back, minting one if it is absent. The id
/// is minted once at connect time and then frozen onto `providerData`,
/// because the codec sends it as `x-grok-agent-id` on every request and
/// upstream expects one value per installation.
pub fn agent_id_from(provider_data: Option<&Map<String, Value>>) -> String {
    provider_data
        .and_then(|d| d.get("agentId"))
        .and_then(Value::as_str)
        .filter(|s| !omni_ir::js::trim(s).is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| super::device::mint().agent_id)
}

pub fn token_result(
    status: u16,
    text: &str,
    fallback_refresh: Option<&str>,
    agent_id: &str,
    now: f64,
) -> Result<FlowResult, GatewayError> {
    // A non-JSON body is a real answer — an HTML error page, an empty 502 —
    // so it parses to null and the caller falls back to the status.
    let body = parse_js(text).unwrap_or(JsValue::Null);
    if !(200..300).contains(&status) {
        let raw = match body.get("error") {
            Some(JsValue::String(s)) => Some(String::from_utf16_lossy(s)),
            _ => None,
        };
        return Err(token_error(status, &serde_json::json!({ "error": raw })));
    }
    // `parseTokenResponse`: any string counts, blank included — the shape
    // check is `typeof === "string"`, not a non-blank test.
    let access = match body.get("access_token") {
        Some(JsValue::String(s)) => s.clone(),
        _ => {
            return Err(GatewayError::new(
                ErrorCode::Auth,
                "token endpoint returned no access_token",
            ));
        }
    };
    let refresh = match body.get("refresh_token") {
        Some(JsValue::String(s)) => Some(s.clone()),
        _ => None,
    };
    let expires_in = match body.get("expires_in") {
        Some(JsValue::Number(n)) => Some(*n),
        _ => None,
    };
    let id_token = match body.get("id_token") {
        Some(JsValue::String(s)) => Some(s.clone()),
        _ => None,
    };
    let email = email_from_id_token(id_token.as_deref());
    let mut provider_data = Map::new();
    omni_ir::deep::insert(
        &mut provider_data,
        "agentId".into(),
        Value::String(agent_id.to_owned()),
    );
    Ok(FlowResult {
        access_token: access,
        // xAI rotates refresh tokens *conditionally*: a refresh response may
        // omit `refresh_token` entirely, meaning "keep using the one you
        // have". Taking that omission as a null would destroy a working
        // credential on its first refresh.
        refresh_token: refresh
            .map(JsValue::String)
            .or_else(|| fallback_refresh.map(|s| JsValue::String(s.encode_utf16().collect()))),
        id_token,
        api_key: None,
        expires_at: expires_in.map(|n| now + n * 1000.0),
        account_email: email.map(JsValue::String),
        provider_data,
    })
}

/// Reads the email claim out of an ID token. The signature is not verified,
/// and does not need to be: this token came back over TLS from the token
/// endpoint in answer to a request this process made. A malformed token
/// degrades to no email rather than failing the connection — the address is
/// a label in the console, not an authorization input.
fn email_from_id_token(id_token: Option<&[u16]>) -> Option<Vec<u16>> {
    let token = String::from_utf16_lossy(id_token?);
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 || parts[1].is_empty() {
        return None;
    }
    let bytes = base64url_lenient(parts[1])?;
    let json = String::from_utf8_lossy(&bytes);
    let parsed = parse_js(&json).ok()?;
    if !parsed.is_object() && !parsed.is_array() {
        return None;
    }
    match parsed.get("email") {
        Some(JsValue::String(s)) if !omni_ir::js::trim(&String::from_utf16_lossy(s)).is_empty() => {
            Some(s.clone())
        }
        _ => None,
    }
}

/// Node's `Buffer.from(payload, "base64url")` is lenient: padding optional,
/// stray characters ignored, trailing bits unchecked. A decode that cannot
/// produce bytes degrades to no email, exactly as the JSON parse would.
fn base64url_lenient(payload: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let mut cleaned: String = payload
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' => Some(c),
            '+' => Some('-'),
            '/' => Some('_'),
            _ => None,
        })
        .collect();
    // Node drops a single leftover character (a length ≡ 1 mod 4 can never
    // encode a byte) and decodes the rest, rather than refusing the payload.
    if cleaned.len() % 4 == 1 {
        cleaned.pop();
    }
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    engine.decode(cleaned.as_bytes()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_replaces_the_first_match_and_removes_later_duplicates() {
        // `url.searchParams.set` on `?state=a&state=b` leaves one value.
        let start = start(
            "https://auth.x.ai/authorize?state=a&prompt=login&state=b",
            "http://127.0.0.1:56121/callback",
            "verifier",
            "challenge",
            "host-state",
        )
        .expect("start");
        let url = url::Url::parse(&start.authorize_url).expect("url");
        let states: Vec<_> = url
            .query_pairs()
            .filter(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned())
            .collect();
        assert_eq!(states, ["host-state"]);
        // The first occurrence keeps its position, before `prompt`.
        let keys: Vec<_> = url.query_pairs().map(|(k, _)| k.into_owned()).collect();
        let state = keys.iter().position(|k| k == "state").expect("state");
        let prompt = keys.iter().position(|k| k == "prompt").expect("prompt");
        assert!(state < prompt);
    }

    #[test]
    fn lenient_base64url_drops_a_lone_leftover_character() {
        // 5 cleaned chars ≡ 1 (mod 4): Node decodes "YWJj" and drops the "R".
        assert_eq!(base64url_lenient("YWJjR").as_deref(), Some(&b"abc"[..]));
        // A length ≡ 2 or 3 (mod 4) still decodes its whole groups.
        assert_eq!(base64url_lenient("YWJj").as_deref(), Some(&b"abc"[..]));
        assert_eq!(base64url_lenient("YWJ").as_deref(), Some(&b"ab"[..]));
    }

    #[test]
    fn id_token_email_survives_a_lone_leftover_character() {
        use base64::Engine as _;
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"email":"x@y.zz"}"#);
        assert_eq!(payload.len() % 4, 0);
        let token = format!("eyJhbGciOiJub25lIn0.{payload}Q.sig");
        let email = email_from_id_token(Some(&token.encode_utf16().collect::<Vec<u16>>()));
        assert_eq!(
            email.map(|e| String::from_utf16_lossy(&e)).as_deref(),
            Some("x@y.zz")
        );
    }
}
