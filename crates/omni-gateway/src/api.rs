//! The `/api` surface (`routes/admin.ts`, `routes/http.ts`): the router the
//! admin, client and database rows extend, the request helpers every route
//! shares, and the auth core's four routes — `GET /api/status`,
//! `POST /api/setup`, `POST /api/login`, `POST /api/logout`.
//!
//! Bare hyper, not axum, like the rest of the server: routes are matched by
//! [`crate::server::handle`] on Elysia's normalized path (dot segments
//! resolved, one trailing slash folded), and everything unmatched keeps the
//! exact fallthrough it has today (the plugin 501, the `/api` 404 guard, the
//! `NOT_FOUND` text for other methods). axum's router, rejections and 404/405
//! answers would each need overriding to stay byte-identical, for no gain on
//! a surface of fixed paths. [`route`] is the table later rows add to.
//!
//! Every response here is Elysia's: JSON as `application/json;charset=utf-8`;
//! an error as `{"error":{"code","message"}}` with `HTTP_STATUS[code]`
//! (`apiErrorResponse`), and anything that is not a `GatewayError` as
//! `500 INTERNAL "internal error"`.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::jsjson::JsValue;

use crate::admin_auth::{ADMIN_COOKIE, AdminAuth, AuthError, Principal};
use crate::server::{App, Body, full};

/// Bun's `maxRequestBodySize` default (128 MiB): a request declaring more
/// is refused 413 before any route; a body that grows past it while a route
/// reads it is refused the same way.
pub const API_BODY_LIMIT: u64 = 128 * 1024 * 1024;

const JSON_UTF8: &str = "application/json;charset=utf-8";

/// A matched `/api` route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Status,
    Setup,
    Login,
    Logout,
    ClientLogin,
    ClientSummary,
    ClientLogs,
    ClientUsage,
    /// Keys, models, catalog, settings and passwords (A5).
    Admin(crate::admin_routes::Admin),
}

/// The `/api` route for a method and normalized path, if one is ported.
/// `HEAD` reaches every `GET` route, as Elysia's does.
pub fn route(method: &Method, path: &str) -> Option<Route> {
    match (method, path) {
        (&Method::GET | &Method::HEAD, "/api/status") => Some(Route::Status),
        (&Method::POST, "/api/setup") => Some(Route::Setup),
        (&Method::POST, "/api/login") => Some(Route::Login),
        (&Method::POST, "/api/logout") => Some(Route::Logout),
        (&Method::POST, "/api/client/logout") => Some(Route::Logout),
        (&Method::POST, "/api/client/login") => Some(Route::ClientLogin),
        (&Method::GET | &Method::HEAD, "/api/client/summary") => Some(Route::ClientSummary),
        (&Method::GET | &Method::HEAD, "/api/client/logs") => Some(Route::ClientLogs),
        (&Method::GET | &Method::HEAD, "/api/client/usage") => Some(Route::ClientUsage),
        _ => crate::admin_routes::route(method, path).map(Route::Admin),
    }
}

/// Serves a matched route.
pub async fn serve(app: Arc<App>, route: Route, req: Request<Incoming>) -> Response<Body> {
    let result = match route {
        Route::Status => status(&app, &req).await,
        Route::Setup => setup(&app, req).await,
        Route::Login => login(&app, req).await,
        Route::Logout => logout(&app, &req).await,
        Route::ClientLogin => crate::client_routes::login(&app, req).await,
        Route::ClientSummary => crate::client_routes::summary(&app, req).await,
        Route::ClientLogs => crate::client_routes::logs(&app, req).await,
        Route::ClientUsage => crate::client_routes::usage(&app, req).await,
        Route::Admin(admin) => crate::admin_routes::serve(&app, admin, req).await,
    };
    result.unwrap_or_else(|e| e.into_response())
}

/// Whether a request declares a body over [`API_BODY_LIMIT`]: Bun refuses
/// it 413 before routing, for every method but `GET` and `HEAD`.
pub fn declares_oversized_body(req: &Request<Incoming>) -> bool {
    if matches!(*req.method(), Method::GET | Method::HEAD) {
        return false;
    }
    req.headers()
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .is_some_and(|n| n > API_BODY_LIMIT)
}

/// Marks a response Bun writes without a `date` header.
#[derive(Debug, Clone, Copy)]
pub struct NoDate;

/// Bun's 413: no body and no `date` (hyper adds `content-length: 0`).
pub fn payload_too_large() -> Response<Body> {
    let mut res = Response::new(full(Bytes::new()));
    *res.status_mut() = StatusCode::PAYLOAD_TOO_LARGE;
    res.extensions_mut().insert(NoDate);
    res
}

// ------------------------------------------------------------ errors

/// What a route answers when it does not succeed.
#[derive(Debug)]
pub enum ApiError {
    /// `apiErrorResponse(gatewayError)`.
    Gateway(GatewayError),
    /// A response already decided (a 409 body, a 413, a hang-up).
    Response(Box<Response<Body>>),
}

impl ApiError {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        ApiError::Gateway(GatewayError::new(code, message))
    }

    /// `throw new GatewayError(code, message)`.
    pub fn gateway(code: ErrorCode, message: impl Into<String>) -> Self {
        Self::new(code, message)
    }

    /// Anything not a `GatewayError`: `500 INTERNAL "internal error"`.
    pub fn internal() -> Self {
        internal()
    }

    /// `apiErrorResponse`: a non-`GatewayError` never reaches here, it is
    /// already `INTERNAL "internal error"`.
    pub fn into_response(self) -> Response<Body> {
        match self {
            ApiError::Response(r) => *r,
            ApiError::Gateway(e) => error_response(e.code, &e.message),
        }
    }
}

impl From<AuthError> for ApiError {
    /// `throw new Error(...)` inside an auth call: a route that wraps it
    /// reports the message as `BAD_REQUEST` itself; anything else is the
    /// redacted `INTERNAL`.
    fn from(e: AuthError) -> Self {
        tracing::error!(reason = %e, "admin auth failed");
        internal()
    }
}

fn internal() -> ApiError {
    ApiError::new(ErrorCode::Internal, "internal error")
}

/// `{"error":{"code","message"}}` with the code's status.
pub fn error_response(code: ErrorCode, message: &str) -> Response<Body> {
    let mut body = String::from("{\"error\":{\"code\":");
    omni_ir::jsjson::write_str(code.as_str(), &mut body);
    body.push_str(",\"message\":");
    omni_ir::jsjson::write_str(message, &mut body);
    body.push_str("}}");
    json(code.http_status(), body, None)
}

/// A JSON answer, with an optional `set-cookie` (written first, as Elysia's
/// `set.headers` precede the content type).
pub(crate) fn json(status: u16, body: String, cookie: Option<String>) -> Response<Body> {
    let mut res = Response::new(full(body));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let h = res.headers_mut();
    if let Some(c) = cookie.and_then(|c| HeaderValue::from_str(&c).ok()) {
        h.insert(hyper::header::SET_COOKIE, c);
    }
    h.insert(
        hyper::header::CONTENT_TYPE,
        HeaderValue::from_static(JSON_UTF8),
    );
    res
}

pub(crate) const OK: &str = "{\"ok\":true}";

/// A 200 JSON answer (a handler's returned object).
pub(crate) fn json_ok(body: String) -> Response<Body> {
    json(200, body, None)
}

fn conflict() -> ApiError {
    ApiError::Response(Box::new(error_response(
        ErrorCode::Conflict,
        "an admin password is already configured",
    )))
}

// ------------------------------------------------------------ request helpers

/// `request.headers.get(name)`: every value, Latin-1 decoded and HTTP
/// whitespace trimmed, joined with `", "` — or `"; "` for `cookie`, as
/// Bun's `Headers` joins that one.
pub fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    let sep = if name.eq_ignore_ascii_case("cookie") {
        "; "
    } else {
        ", "
    };
    let mut out: Option<String> = None;
    for v in headers.get_all(name) {
        let text: String = v.as_bytes().iter().map(|&b| char::from(b)).collect();
        let text = text.trim_matches(|c| matches!(c, ' ' | '\t'));
        match &mut out {
            None => out = Some(text.to_owned()),
            Some(acc) => {
                acc.push_str(sep);
                acc.push_str(text);
            }
        }
    }
    out
}

/// `readCookie(request, name)`: the first `name=` part's value (everything
/// after the first `=`), parts split on `;` and JS-trimmed; `None` if absent.
pub fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let header = header_text(headers, "cookie")?;
    for part in header.split(';') {
        let part = omni_ir::js::trim(part);
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        if key == name {
            return Some(value.to_owned());
        }
    }
    None
}

/// `forwardedProto(request) === "https"`: the first hop of
/// `x-forwarded-proto`, JS-trimmed and lowercased. No Latin-1 character
/// lowercases into ASCII, so an ASCII case-insensitive match is exact.
fn forwarded_https(headers: &HeaderMap) -> bool {
    header_text(headers, "x-forwarded-proto").is_some_and(|h| {
        let first = h.split(',').next().unwrap_or("");
        omni_ir::js::trim(first).eq_ignore_ascii_case("https")
    })
}

/// Whether the configured public origin is https: `URL.canParse(baseUrl)
/// && new URL(baseUrl).protocol === "https:"`. Decided once at boot.
pub fn base_url_is_https(base_url: &str) -> bool {
    url::Url::parse(base_url).is_ok_and(|u| u.scheme() == "https")
}

/// `sessionCookie(request, baseUrl, token, maxAge)`. The request URL's own
/// scheme is always `http:` here: this server speaks plain HTTP/1.1 only.
pub fn session_cookie(headers: &HeaderMap, base_https: bool, token: &str, max_age: i64) -> String {
    let secure = if base_https || forwarded_https(headers) {
        "; Secure"
    } else {
        ""
    };
    format!("{ADMIN_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict{secure}; Max-Age={max_age}")
}

/// `principalOf(request, admin)`.
pub async fn principal_of(
    headers: &HeaderMap,
    admin: &AdminAuth,
) -> Result<Option<Principal>, ApiError> {
    match read_cookie(headers, ADMIN_COOKIE) {
        None => Ok(None),
        Some(token) => Ok(admin.verify(&token).await?),
    }
}

/// `requireAdmin`: the operator, and nobody else.
pub async fn require_admin(headers: &HeaderMap, admin: &AdminAuth) -> Result<(), ApiError> {
    match principal_of(headers, admin).await? {
        Some(Principal::Admin) => Ok(()),
        _ => Err(ApiError::new(ErrorCode::Auth, "admin session required")),
    }
}

/// `requireReader`: the operator or the read-only administrator.
pub async fn require_reader(headers: &HeaderMap, admin: &AdminAuth) -> Result<Principal, ApiError> {
    match principal_of(headers, admin).await? {
        Some(p @ (Principal::Admin | Principal::Viewer)) => Ok(p),
        _ => Err(ApiError::new(ErrorCode::Auth, "admin session required")),
    }
}

/// `requireClient`: the holder of one API key; its id.
pub async fn require_client(headers: &HeaderMap, admin: &AdminAuth) -> Result<String, ApiError> {
    match principal_of(headers, admin).await? {
        Some(Principal::Client { api_key_id }) => Ok(api_key_id),
        _ => Err(ApiError::new(ErrorCode::Auth, "client session required")),
    }
}

/// `await request.text()` as `request.json()` reads it: at most
/// [`API_BODY_LIMIT`] bytes (413 past it), at most `idle` between frames
/// (a hang-up past it), UTF-8 with replacement, one leading BOM dropped.
async fn read_text(req: Request<Incoming>, idle: Duration) -> Result<String, ApiError> {
    let mut body = http_body_util::Limited::new(
        req.into_body(),
        usize::try_from(API_BODY_LIMIT).unwrap_or(usize::MAX),
    );
    let mut bytes = bytes::BytesMut::new();
    loop {
        match tokio::time::timeout(idle, body.frame()).await {
            Err(_) => return Err(ApiError::Response(Box::new(crate::server::hang_up()))),
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                if e.downcast_ref::<http_body_util::LengthLimitError>()
                    .is_some()
                {
                    return Err(ApiError::Response(Box::new(payload_too_large())));
                }
                return Err(internal());
            }
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    bytes.extend_from_slice(&data);
                }
            }
        }
    }
    let mut text = match String::from_utf8(Vec::from(bytes)) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    if text.starts_with('\u{feff}') {
        text.drain(..'\u{feff}'.len_utf8());
    }
    Ok(text)
}

/// The top-level string fields a route reads from `readJsonRecord`.
#[derive(Debug, Default)]
pub struct Fields {
    values: Vec<(String, Option<String>)>,
}

impl Fields {
    /// `typeof body?.[name] === "string" ? body[name] : null`.
    pub fn string(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.as_deref())
    }
}

/// `readJsonRecord(request)`, reduced to the named top-level fields: each
/// one's value when it is a string (the last duplicate wins, as
/// `JSON.parse`), else `None`. A body `JSON.parse` refuses is
/// `BAD_REQUEST "invalid JSON body"`; a non-object body has no fields.
///
/// Validity is JavaScriptCore's (`omni_ir::jsc_json`: any depth, numbers out
/// of the double range, lone surrogate escapes), so nothing JS accepts is
/// refused. Lone surrogates in a read field become U+FFFD, as they do when
/// the string is UTF-8 encoded for hashing.
pub async fn read_json_fields(
    req: Request<Incoming>,
    idle: Duration,
    names: &[&str],
) -> Result<Fields, ApiError> {
    let text = read_text(req, idle).await?;
    if omni_ir::jsc_json::parse_error(&text).is_some() {
        return Err(ApiError::new(ErrorCode::BadRequest, "invalid JSON body"));
    }
    Ok(top_level_fields(&text, names))
}

/// `readJson(request)`: the whole body as `request.json()` parses it, kept
/// as a JS value (lone surrogates, `1e400` as Infinity, duplicate keys last
/// wins, any depth). A body `JSON.parse` refuses is `BAD_REQUEST "invalid
/// JSON body"`.
pub async fn read_json(req: Request<Incoming>, idle: Duration) -> Result<JsValue, ApiError> {
    let text = read_text(req, idle).await?;
    // Whitespace around the value is JSON; `operator_json` wants none.
    let trimmed = text.trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r'));
    if trimmed.is_empty() || omni_ir::jsc_json::parse_error(&text).is_some() {
        return Err(ApiError::new(ErrorCode::BadRequest, "invalid JSON body"));
    }
    omni_control::operator_json::parse(trimmed)
        .map_err(|_| ApiError::new(ErrorCode::BadRequest, "invalid JSON body"))
}

/// Reads the named top-level members of JSON text already known valid.
fn top_level_fields(text: &str, names: &[&str]) -> Fields {
    let mut fields = Fields {
        values: names.iter().map(|n| ((*n).to_owned(), None)).collect(),
    };
    let b = text.as_bytes();
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return fields;
    }
    i = skip_ws(b, i + 1);
    while b.get(i) == Some(&b'"') {
        let (key, after) = read_string(text, i);
        i = skip_ws(b, after);
        // ':'
        i = skip_ws(b, i + 1);
        let wanted = fields.values.iter_mut().find(|(k, _)| *k == key);
        if b.get(i) == Some(&b'"') {
            let (value, after) = read_string(text, i);
            if let Some((_, slot)) = wanted {
                *slot = Some(value);
            }
            i = after;
        } else {
            if let Some((_, slot)) = wanted {
                *slot = None;
            }
            i = skip_value(b, i);
        }
        i = skip_ws(b, i);
        if b.get(i) == Some(&b',') {
            i = skip_ws(b, i + 1);
        } else {
            break;
        }
    }
    fields
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while matches!(b.get(i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        i += 1;
    }
    i
}

/// Skips one valid JSON value that is not a string at the top: a literal,
/// a number, or a container (iteratively, strings inside skipped whole).
fn skip_value(b: &[u8], mut i: usize) -> usize {
    let mut depth = 0usize;
    loop {
        match b.get(i) {
            None => return i,
            Some(b'"') => i = skip_string(b, i),
            Some(b'[' | b'{') => {
                depth += 1;
                i += 1;
            }
            Some(b']' | b'}') => {
                if depth == 0 {
                    return i;
                }
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return i;
                }
            }
            Some(b',') if depth == 0 => return i,
            Some(_) => i += 1,
        }
    }
}

fn skip_string(b: &[u8], mut i: usize) -> usize {
    i += 1;
    while let Some(&c) = b.get(i) {
        match c {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
    }
    i
}

/// Decodes the valid JSON string starting at `start` (its opening quote);
/// the string and the index after its closing quote.
fn read_string(text: &str, start: usize) -> (String, usize) {
    let b = text.as_bytes();
    let mut out = String::new();
    let mut i = start + 1;
    let hex = |at: usize| {
        text.get(at..at + 4)
            .and_then(|h| u16::from_str_radix(h, 16).ok())
    };
    while i < b.len() {
        match b[i] {
            b'"' => return (out, i + 1),
            b'\\' => {
                let esc = b.get(i + 1).copied().unwrap_or(b'"');
                i += 2;
                match esc {
                    b'b' => out.push('\u{8}'),
                    b'f' => out.push('\u{c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let unit = hex(i).unwrap_or(0xfffd);
                        i += 4;
                        if (0xd800..0xdc00).contains(&unit)
                            && b.get(i) == Some(&b'\\')
                            && b.get(i + 1) == Some(&b'u')
                            && let Some(low) = hex(i + 2).filter(|l| (0xdc00..0xe000).contains(l))
                        {
                            let c = 0x10000
                                + ((u32::from(unit) - 0xd800) << 10)
                                + (u32::from(low) - 0xdc00);
                            out.push(char::from_u32(c).unwrap_or('\u{fffd}'));
                            i += 6;
                        } else {
                            out.push(char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}'));
                        }
                    }
                    other => out.push(char::from(other)),
                }
            }
            _ => {
                // Copy the run of plain characters up to the next quote or
                // escape (both ASCII, so the slice is on char boundaries).
                let end = b[i..]
                    .iter()
                    .position(|&c| c == b'"' || c == b'\\')
                    .map_or(b.len(), |p| i + p);
                out.push_str(&text[i..end]);
                i = end;
            }
        }
    }
    (out, i)
}

// ------------------------------------------------------------ routes

/// `GET /api/status`.
async fn status(app: &App, req: &Request<Incoming>) -> Result<Response<Body>, ApiError> {
    let principal = principal_of(req.headers(), &app.admin).await?;
    let configured = app.admin.is_configured().await?;
    let viewer = app.admin.is_viewer_configured().await?;
    let body = format!(
        "{{\"configured\":{configured},\"authenticated\":{},\"principal\":{},\"viewerConfigured\":{viewer}}}",
        principal.is_some(),
        principal
            .as_ref()
            .map_or_else(|| "null".to_owned(), Principal::to_json),
    );
    Ok(json(200, body, None))
}

/// `POST /api/setup`: the first admin password, and a session for it.
async fn setup(app: &App, req: Request<Incoming>) -> Result<Response<Body>, ApiError> {
    if app.admin.is_configured().await? {
        return Err(conflict());
    }
    let headers = req.headers().clone();
    let fields = read_json_fields(req, app.idle_timeout, &["password"]).await?;
    let Some(password) = fields.string("password") else {
        return Err(ApiError::new(ErrorCode::BadRequest, "password is required"));
    };
    // Every failure here, the length rule or the store's, is `BAD_REQUEST`
    // with its described message (`admin.ts`: `catch (error) { throw new
    // GatewayError("BAD_REQUEST", describeError(error, "invalid password"))
    // }`). The message is SQLite's own: it names neither the password nor
    // the database path. Only an operator's own trigger could put the new
    // hash in it — the hash of the password this caller just sent, never
    // stored — and TS echoes that too.
    let created = match app.admin.set_initial_password(password).await {
        Ok(created) => created,
        Err(AuthError::Password(message) | AuthError::Internal(message)) => {
            return Err(ApiError::new(ErrorCode::BadRequest, message));
        }
    };
    if !created {
        return Err(conflict());
    }
    let Some(token) = app.admin.login(password).await? else {
        return Err(ApiError::new(
            ErrorCode::Internal,
            "could not create admin session",
        ));
    };
    tracing::info!("admin setup completed");
    let cookie = session_cookie(
        &headers,
        app.base_url_https,
        &token,
        app.admin.max_age_secs(),
    );
    Ok(json(200, OK.to_owned(), Some(cookie)))
}

/// `POST /api/login`: `mode: "viewer"` asks for a read-only session; any
/// other mode is the operator's. Never one password tried for the other.
async fn login(app: &App, req: Request<Incoming>) -> Result<Response<Body>, ApiError> {
    let headers = req.headers().clone();
    let fields = read_json_fields(req, app.idle_timeout, &["password", "mode"]).await?;
    let viewer = fields.string("mode") == Some("viewer");
    let token = match fields.string("password") {
        None => None,
        Some(password) if viewer => app.admin.login_viewer(password).await?,
        Some(password) => app.admin.login(password).await?,
    };
    let Some(token) = token else {
        tracing::info!(reason = "invalid credentials", "admin login failed");
        return Err(ApiError::new(ErrorCode::Auth, "invalid password"));
    };
    tracing::info!("admin login succeeded");
    let cookie = session_cookie(
        &headers,
        app.base_url_https,
        &token,
        app.admin.max_age_secs(),
    );
    Ok(json(200, OK.to_owned(), Some(cookie)))
}

/// `POST /api/logout`: ends the cookie's session, if any, and clears it.
async fn logout(app: &App, req: &Request<Incoming>) -> Result<Response<Body>, ApiError> {
    if let Some(token) = read_cookie(req.headers(), ADMIN_COOKIE) {
        app.admin.logout(&token).await?;
    }
    let cookie = session_cookie(req.headers(), app.base_url_https, "", 0);
    Ok(json(200, OK.to_owned(), Some(cookie)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &[u8])]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                hyper::header::HeaderName::from_bytes(k.as_bytes()).expect("name"),
                HeaderValue::from_bytes(v).expect("value"),
            );
        }
        h
    }

    #[test]
    fn read_cookie_is_ts_read_cookie() {
        let h = headers(&[("cookie", b"a=b; omni_admin=t=x; omni_admin=second")]);
        assert_eq!(read_cookie(&h, "omni_admin").as_deref(), Some("t=x"));
        let h = headers(&[("cookie", b"a=b"), ("cookie", b"omni_admin=tok")]);
        assert_eq!(read_cookie(&h, "omni_admin").as_deref(), Some("tok"));
        // JS trim removes U+00A0 (a Latin-1 byte).
        let h = headers(&[("cookie", b"\xa0omni_admin=tok ")]);
        assert_eq!(read_cookie(&h, "omni_admin").as_deref(), Some("tok"));
        let h = headers(&[("cookie", b"omni_admin")]);
        assert_eq!(read_cookie(&h, "omni_admin").as_deref(), Some(""));
        let h = headers(&[("cookie", b"OMNI_ADMIN=x")]);
        assert_eq!(read_cookie(&h, "omni_admin"), None);
        assert_eq!(read_cookie(&HeaderMap::new(), "omni_admin"), None);
    }

    #[test]
    fn the_secure_rule_is_ts_session_cookie() {
        let plain = HeaderMap::new();
        assert_eq!(
            session_cookie(&plain, false, "tok", 43_200),
            "omni_admin=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200"
        );
        assert_eq!(
            session_cookie(&plain, true, "", 0),
            "omni_admin=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0"
        );
        let secure = |v: &[u8]| {
            session_cookie(&headers(&[("x-forwarded-proto", v)]), false, "t", 1).contains("Secure")
        };
        assert!(secure(b"https"));
        assert!(secure(b"HTTPS , http"));
        assert!(secure(b"\xa0https"));
        assert!(!secure(b", https"));
        assert!(!secure(b""));
        assert!(!secure(b"http"));
        assert!(!secure(b"\xe9https"));
        let two = headers(&[
            ("x-forwarded-proto", b"http"),
            ("x-forwarded-proto", b"https"),
        ]);
        assert!(!session_cookie(&two, false, "t", 1).contains("Secure"));
    }

    /// `requireAdmin` / `requireReader` / `requireClient` against every
    /// principal, no cookie, an unknown token, and an expired session.
    #[tokio::test]
    async fn guards_admit_exactly_their_principals() {
        use crate::admin_auth::{AdminAuth, Clock, MemoryKv};
        use std::sync::atomic::{AtomicI64, Ordering};
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("omni.db");
        let store = omni_store::SqliteStore::open(&path, 0).expect("open");
        rusqlite::Connection::open(&path)
            .expect("open")
            .execute(
                "INSERT INTO api_keys (id, label, prefix, hash, limits, created_at) VALUES ('k1','l','p',?,'{}',1)",
                [omni_crypto::apikey::hash("sk-omni-guard")],
            )
            .expect("key");
        let clock = Arc::new(AtomicI64::new(1_000));
        let now: Clock = {
            let c = clock.clone();
            Arc::new(move || c.load(Ordering::SeqCst))
        };
        let auth = AdminAuth::new(store, Arc::new(MemoryKv::new(now.clone())), now, 60_000);
        auth.set_initial_password("correct-horse-battery")
            .await
            .expect("set");
        auth.set_viewer_password(Some("viewer-password-1"))
            .await
            .expect("set");
        let admin = auth
            .login("correct-horse-battery")
            .await
            .expect("login")
            .expect("token");
        let viewer = auth
            .login_viewer("viewer-password-1")
            .await
            .expect("login")
            .expect("token");
        let client = auth
            .login_client("sk-omni-guard")
            .await
            .expect("login")
            .expect("token");
        let expired = auth
            .login("correct-horse-battery")
            .await
            .expect("login")
            .expect("token");

        let cookie = |t: Option<&str>| match t {
            None => HeaderMap::new(),
            Some(t) => headers(&[("cookie", format!("omni_admin={t}").as_bytes())]),
        };
        let answer = |r: Result<String, ApiError>| match r {
            Ok(v) => v,
            Err(ApiError::Gateway(e)) => format!("{} {}", e.code.as_str(), e.message),
            Err(ApiError::Response(r)) => format!("response {}", r.status()),
        };
        const NO_ADMIN: &str = "AUTH admin session required";
        const NO_CLIENT: &str = "AUTH client session required";
        // Every session shares one TTL, so the expired case runs last, after
        // the clock passes it.
        let rows: [(&str, Option<&str>, &str, &str, &str); 5] = [
            ("admin", Some(&admin), "ok", "admin", NO_CLIENT),
            ("viewer", Some(&viewer), NO_ADMIN, "viewer", NO_CLIENT),
            ("client", Some(&client), NO_ADMIN, NO_ADMIN, "k1"),
            ("none", None, NO_ADMIN, NO_ADMIN, NO_CLIENT),
            (
                "unknown",
                Some("not-a-token"),
                NO_ADMIN,
                NO_ADMIN,
                NO_CLIENT,
            ),
        ];
        for (who, token, want_admin, want_reader, want_client) in rows {
            let h = cookie(token);
            let a = answer(require_admin(&h, &auth).await.map(|()| "ok".to_owned()));
            let r = answer(
                require_reader(&h, &auth)
                    .await
                    .map(|p| p.kind().as_str().to_owned()),
            );
            let c = answer(require_client(&h, &auth).await);
            assert_eq!(
                (a.as_str(), r.as_str(), c.as_str()),
                (want_admin, want_reader, want_client),
                "{who}"
            );
        }
        clock.fetch_add(60_000, Ordering::SeqCst);
        let h = cookie(Some(&expired));
        assert_eq!(
            answer(require_admin(&h, &auth).await.map(|()| "ok".into())),
            NO_ADMIN
        );
        assert_eq!(
            answer(
                require_reader(&h, &auth)
                    .await
                    .map(|p| p.kind().as_str().into())
            ),
            NO_ADMIN
        );
        assert_eq!(answer(require_client(&h, &auth).await), NO_CLIENT);
    }

    #[test]
    fn base_url_scheme_is_parsed() {
        assert!(base_url_is_https("https://gateway.example.com"));
        assert!(base_url_is_https("HTTPS://gateway.example.com"));
        assert!(!base_url_is_https("http://gateway.example.com/https:/x"));
        assert!(!base_url_is_https("not a url"));
    }

    #[test]
    fn top_level_fields_read_as_json_parse_does() {
        let f = |t: &str| {
            let fields = top_level_fields(t, &["password", "mode"]);
            (
                fields.string("password").map(str::to_owned),
                fields.string("mode").map(str::to_owned),
            )
        };
        assert_eq!(
            f(r#"{"password":"p","mode":"viewer"}"#),
            (Some("p".into()), Some("viewer".into()))
        );
        assert_eq!(
            f(r#"{"password":"x","password":"y"}"#),
            (Some("y".into()), None)
        );
        assert_eq!(f(r#"{"password":"x","password":5}"#), (None, None));
        assert_eq!(
            f(r#"{"pass\u0077ord":"a\"b\\c\u00e9\ud83d\ude00"}"#),
            (Some("a\"b\\cé😀".into()), None)
        );
        assert_eq!(
            f(r#"{"password":"\ud800x"}"#),
            (Some("\u{fffd}x".into()), None)
        );
        assert_eq!(
            f(r#"{"a":{"password":"no"},"b":["}",{"x":"]"}],"mode":"viewer"}"#),
            (None, Some("viewer".into()))
        );
        assert_eq!(f(r#"[{"password":"p"}]"#), (None, None));
        assert_eq!(f(r#""password""#), (None, None));
        assert_eq!(f(" { \"password\" : \"p\" } "), (Some("p".into()), None));
        assert_eq!(
            f(r#"{"x":1e400,"y":-0.5e-3,"z":true,"password":"p"}"#),
            (Some("p".into()), None)
        );
        let deep = format!(
            "{{\"x\":{}{},\"password\":\"p\"}}",
            "[".repeat(100_000),
            "]".repeat(100_000)
        );
        assert_eq!(f(&deep), (Some("p".into()), None));
    }
}
