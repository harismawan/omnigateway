//! Client body → IR, for the three dialects.
//!
//! Each parser takes the body as `JSON.parse` produced it, the request
//! headers, and the injected tool-use id minter, and returns the IR request or
//! a `BAD_REQUEST` whose message is byte-stable (clients match on it).
//!
//! # Known deviations from `JSON.parse` semantics
//!
//! - A body number outside the double range (`1e400`) is `Infinity` to
//!   `JSON.parse` and a parse failure to [`parse_body`]; such a body is
//!   refused either way, with a different message.
//! - Lone surrogates in a body become U+FFFD (see `omni_ir::js`).

use std::collections::HashSet;

use omni_ir::deep::Owned;
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::js::{safe_token, trim, utf16_len};
use omni_ir::request::{
    CONTEXT_1M_BETA, CacheControl, CacheControlType, CacheTtl, ChatRequest, ContentBlock, Message,
};
use serde_json::{Map, Value};

pub mod anthropic;
mod anthropic_tools;
pub mod openai;
pub mod responses;
mod zod;

/// Request headers as the WHATWG `Headers` object presents them: names
/// lower-cased, repeats joined with `", "`, values stripped of HTTP whitespace.
#[derive(Debug, Clone, Default)]
pub struct Headers {
    entries: Vec<(String, String)>,
}

impl Headers {
    pub fn new() -> Headers {
        Headers::default()
    }

    /// `Headers.append`.
    pub fn append(&mut self, name: &str, value: &str) {
        let name = name.to_ascii_lowercase();
        let value = value.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n'));
        match self.entries.iter_mut().find(|(n, _)| *n == name) {
            Some((_, existing)) => {
                existing.push_str(", ");
                existing.push_str(value);
            }
            None => self.entries.push((name, value.to_string())),
        }
    }

    /// `Headers.get`: case-insensitive, repeats combined.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// `Headers.forEach` order: names sorted.
    pub fn sorted(&self) -> Vec<(&str, &str)> {
        let mut all: Vec<(&str, &str)> = self
            .entries
            .iter()
            .map(|(n, v)| (n.as_str(), v.as_str()))
            .collect();
        all.sort_by(|a, b| a.0.cmp(b.0));
        all
    }
}

/// What a parser needs besides the body and headers.
pub struct IngressOptions<'a> {
    /// The tool-use id minter, reached only for a `toolUse` sent
    /// with an empty id. Production passes [`random_tool_use_id`].
    pub new_tool_use_id: &'a mut dyn FnMut() -> String,
}

/// `tu_${crypto.randomUUID()}`.
pub fn random_tool_use_id() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "tu_{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Which client dialect a body is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// `/v1/messages` and `/v1/messages/count_tokens`.
    Anthropic,
    /// `/v1/chat/completions`.
    OpenAi,
    /// `/v1/responses`.
    Responses,
}

/// What [`ingest`] reads off a body besides the IR.
#[derive(Debug)]
pub struct Ingested {
    pub request: ChatRequest,
    /// The freeform tool names; the Responses egress needs them, empty elsewhere.
    pub custom_tool_names: HashSet<String>,
    /// The request model as the exact UTF-16 JS holds it, where it holds a
    /// lone surrogate; `None` otherwise. `request.model` is then its lossy
    /// form (U+FFFD, what SQLite stores and logs show), which must not be
    /// used for identity: see [`ModelIdentity`].
    pub model_lone: Option<Vec<u16>>,
}

/// A request model's identity for the key allowlist and per-model limits,
/// compared as exact UTF-16 strings.
pub type ModelIdentity<'a> = (&'a str, Option<&'a [u16]>);

/// **The ingress entry point 5b calls.** Body bytes in, IR out.
///
/// Parses the text (`JSON.parse`, bounded at `omni_ir::deep::MAX_DEPTH`),
/// validates it in the surface's dialect and converts it to the IR. A body
/// that may nest past `omni_ir::deep::SHALLOW_DEPTH` (JSON inside its strings
/// counted) runs inside `omni_ir::deep::scope`, where every client-derived
/// value is created, walked and dropped on a stack large enough for the
/// deepest accepted body; any other body runs directly on the caller's stack.
/// Safe to call on a 2 MiB tokio worker, on success and on every refusal.
///
/// The returned values are safe to hold, clone, serialize with
/// `omni_ir::jsjson` and drop on any thread: the IR types that carry client
/// JSON clone and drop iteratively, and the jsjson writer grows its stack.
///
/// Errors: a syntax error is `BAD_REQUEST "request body must be valid JSON"`
/// (5b decides which status to send), a body deeper than
/// the bound is [`TOO_DEEP`], and everything else is the dialect's own
/// `BAD_REQUEST`, with byte-stable wording.
pub fn ingest(
    surface: Surface,
    body: &str,
    headers: &Headers,
    opts: &mut IngressOptions<'_>,
) -> Result<Ingested, GatewayError> {
    // A pre-scan bounds the body's depth, JSON in its strings included: a
    // body over `SHALLOW_DEPTH` runs on a grown segment, anything else on the
    // caller's stack with nothing mapped.
    omni_ir::deep::scope_for_bound(omni_ir::deep::depth_bound(body), |bound| {
        let value = parse_body_bounded(body, bound)?;
        let request = match surface {
            Surface::Anthropic => anthropic::parse(&value, headers, opts),
            Surface::OpenAi => openai::parse(&value, headers, opts),
            Surface::Responses => responses::parse(&value, headers, opts),
        }?;
        let custom_tool_names = match surface {
            Surface::Responses => custom_tool_names(&value),
            _ => HashSet::new(),
        };
        // A lone surrogate in the model reads as U+FFFD in its lossy form,
        // so only a model holding one needs the exact re-read: nothing on
        // the ordinary path (no extra scan of the body).
        let model_lone = if request.model.contains('\u{fffd}') {
            lone_model(body)
        } else {
            None
        };
        // `value` drops here, still inside the scope.
        Ok(Ingested {
            request,
            custom_tool_names,
            model_lone,
        })
    })
}

/// The refusal for JSON nested deeper than `omni_ir::deep::MAX_DEPTH`.
///
/// Refused up front as a client error, rather than carried until an encoder
/// re-serializes it and fails.
pub const TOO_DEEP: &str = "request body is nested too deeply";

/// `request.json()`: the body, or `None` where `JSON.parse` would throw or the
/// body is nested deeper than `omni_ir::deep::MAX_DEPTH`. Safe on any stack.
pub fn parse_body(text: &str) -> Option<Owned> {
    parse_body_checked(text).ok()
}

/// [`parse_body`], telling the two refusals apart: a syntax error is
/// `Err(BAD_REQUEST "request body must be valid JSON")` here (5b chooses the
/// status), too deep is [`TOO_DEEP`].
pub fn parse_body_checked(text: &str) -> Result<Owned, GatewayError> {
    parse_body_bounded(text, usize::MAX)
}

/// [`parse_body_checked`] given `omni_ir::deep::depth_bound(text)`, which
/// spares the parse its own depth scan.
fn parse_body_bounded(text: &str, bound: usize) -> Result<Owned, GatewayError> {
    deep_json(text, bound).map(Owned).map_err(|e| match e {
        omni_ir::deep::ParseError::TooDeep => bad(TOO_DEEP),
        omni_ir::deep::ParseError::Syntax => bad("request body must be valid JSON"),
    })
}

/// `JSON.parse` of client text, bounded and stack-safe, with lone surrogate
/// escapes read as U+FFFD (see `omni_ir::js::parse_json`).
pub(crate) fn deep_json(text: &str, bound: usize) -> Result<Value, omni_ir::deep::ParseError> {
    match omni_ir::deep::parse_bounded(text, bound) {
        Err(omni_ir::deep::ParseError::Syntax) if text.contains("\\u") => {
            omni_ir::js::replace_lone_surrogates(text)
                .map_or(Err(omni_ir::deep::ParseError::Syntax), |t| {
                    omni_ir::deep::parse(&t)
                })
        }
        other => other,
    }
}

/// The API-key model allowlist, checked against `ChatRequest.model` (after
/// alias normalization) on both routes that parse.
pub fn check_model_allowlist(
    model: &str,
    allowlist: Option<&[String]>,
) -> Result<(), GatewayError> {
    check_model_allowed(
        model,
        allowlist.is_none_or(|list| list.iter().any(|m| m == model)),
    )
}

/// The allowlist refusal for `model`, where `allowed` is the (exact UTF-16)
/// verdict of `modelAllowlist === null || modelAllowlist.includes(model)`.
pub fn check_model_allowed(model: &str, allowed: bool) -> Result<(), GatewayError> {
    if allowed {
        return Ok(());
    }
    Err(GatewayError::new(
        ErrorCode::Auth,
        format!(
            "model \"{}\" is not allowed for this API key",
            safe_token(model)
        ),
    ))
}

/// The `URIError` for a model holding a lone surrogate, thrown building
/// its rate-limit subject id (`encodeURIComponent`): at admission where an
/// override names it, else whenever a completed row's debit is attempted.
pub fn lone_surrogate_model_error() -> GatewayError {
    GatewayError::new(
        ErrorCode::Internal,
        "String contained an illegal UTF-16 sequence.",
    )
    .gateway_authored()
}

/// The top-level `model` string of a body known to hold a lone surrogate
/// escape, normalized as [`normalize_client_model`] does, as exact UTF-16;
/// `None` when it holds no lone surrogate (or is not a string).
fn lone_model(body: &str) -> Option<Vec<u16>> {
    // One linear pass over the body (no value is built), whatever its width.
    let raw = omni_ir::jsjson::top_level_string(body, "model")?;
    let units = normalize_model_units(&raw);
    String::from_utf16(&units).is_err().then_some(units)
}

/// [`normalize_client_model`] on UTF-16: JS `trim`, then a trailing `[1m]`
/// (any case) dropped when something non-blank precedes it. Only the model
/// changes here; the 1M beta it implies is read from the lossy form.
fn normalize_model_units(raw: &[u16]) -> Vec<u16> {
    fn trim(mut s: &[u16]) -> &[u16] {
        let ws = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(omni_ir::js::is_js_whitespace);
        while s.first().is_some_and(ws) {
            s = &s[1..];
        }
        while s.last().is_some_and(ws) {
            s = &s[..s.len() - 1];
        }
        s
    }
    let model = trim(raw);
    let suffix: Vec<u16> = "[1m]".encode_utf16().collect();
    if model.len() >= suffix.len() {
        let (head, tail) = model.split_at(model.len() - suffix.len());
        let lowered: Vec<u16> = tail
            .iter()
            .map(|u| if (65..=90).contains(u) { u + 32 } else { *u })
            .collect();
        if lowered == suffix {
            let stripped = trim(head);
            if !stripped.is_empty() {
                return stripped.to_vec();
            }
        }
    }
    model.to_vec()
}

/// The trimmed model name with a trailing `[1m]` folded into the
/// 1M-context beta.
pub fn normalize_client_model(raw: &str, betas: &[String]) -> (String, Vec<String>) {
    const SUFFIX: &str = "[1m]";
    let mut model = trim(raw).to_string();
    let mut wants_one_m = false;
    if model.len() >= SUFFIX.len()
        && model.is_char_boundary(model.len() - SUFFIX.len())
        && model[model.len() - SUFFIX.len()..].eq_ignore_ascii_case(SUFFIX)
    {
        let stripped = trim(&model[..model.len() - SUFFIX.len()]).to_string();
        if !stripped.is_empty() {
            model = stripped;
            wants_one_m = true;
        }
    }
    let mut merged = betas.to_vec();
    if wants_one_m && !merged.iter().any(|b| b == CONTEXT_1M_BETA) {
        merged.push(CONTEXT_1M_BETA.to_string());
    }
    (model, merged)
}

/// The tools a Responses client declared freeform, which the Responses
/// egress renders as `custom_tool_call`.
pub fn custom_tool_names(body: &Value) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        for entry in tools {
            if entry.get("type").and_then(Value::as_str) == Some("custom")
                && let Some(name) = entry.get("name").and_then(Value::as_str)
            {
                names.insert(name.to_string());
            }
        }
    }
    names
}

// ------------------------------------------------------------------ shared helpers

pub(crate) fn bad(message: impl Into<String>) -> GatewayError {
    GatewayError::new(ErrorCode::BadRequest, message)
}

/// The keys of a parsed JSON object in JS enumeration order: canonical array
/// indices ascending, then the rest in insertion order.
pub(crate) fn js_keys(map: &Map<String, Value>) -> Vec<&str> {
    let mut indexed: Vec<(u32, &str)> = Vec::new();
    let mut named = Vec::with_capacity(map.len());
    for k in map.keys() {
        match omni_ir::jsjson::array_index(k) {
            Some(i) => indexed.push((i, k.as_str())),
            None => named.push(k.as_str()),
        }
    }
    indexed.sort_unstable_by_key(|(i, _)| *i);
    indexed.into_iter().map(|(_, k)| k).chain(named).collect()
}

/// `isRecord`: any object, arrays included.
pub(crate) fn is_record(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// `extraFields`: what the schema does not name, for vendor passthrough.
///
/// `extras[key] = value` on a plain object, so a `__proto__` key sets the
/// prototype rather than an own property and is not carried.
pub(crate) fn extra_fields(
    body: &Map<String, Value>,
    known: &[&str],
) -> Option<Map<String, Value>> {
    let mut extras = Map::new();
    for key in js_keys(body) {
        if !known.contains(&key) && key != "__proto__" {
            omni_ir::deep::insert(
                &mut extras,
                key.to_string(),
                omni_ir::deep::clone(&body[key]),
            );
        }
    }
    (!extras.is_empty()).then_some(extras)
}

/// A parsed `cache_control` object as the IR marker.
pub(crate) fn ir_cache_control(v: Option<&Value>) -> Option<CacheControl> {
    let v = v?.as_object()?;
    if v.get("type")?.as_str()? != "ephemeral" {
        return None;
    }
    let ttl = match v.get("ttl") {
        None => None,
        Some(Value::String(t)) if t == "5m" => Some(CacheTtl::FiveMinutes),
        Some(Value::String(t)) if t == "1h" => Some(CacheTtl::OneHour),
        Some(_) => return None,
    };
    Some(CacheControl {
        kind: CacheControlType::Ephemeral,
        ttl,
    })
}

/// The marker when the shape maps, else nothing.
pub(crate) fn loose_cache_control(v: Option<&Value>) -> Option<CacheControl> {
    zod::parse(&zod::cache_control(), v?).ok()?;
    ir_cache_control(v)
}

fn cache_control_slot(block: &mut ContentBlock) -> Option<&mut Option<CacheControl>> {
    match block {
        ContentBlock::Text(b) => Some(&mut b.cache_control),
        ContentBlock::Image(b) => Some(&mut b.cache_control),
        ContentBlock::Thinking(_) => None,
        ContentBlock::ToolUse(b) => Some(&mut b.cache_control),
        ContentBlock::ToolResult(b) => Some(&mut b.cache_control),
        ContentBlock::ProviderNative(b) => Some(&mut b.cache_control),
    }
}

/// A message-level marker lands on the last block.
pub(crate) fn apply_message_cache_control(blocks: &mut [ContentBlock], v: Option<&Value>) {
    let Some(control) = loose_cache_control(v) else {
        return;
    };
    if let Some(slot) = blocks.last_mut().and_then(cache_control_slot)
        && slot.is_none()
    {
        *slot = Some(control);
    }
}

/// `^data:([^;,]+);base64,(.*)$` (dotAll).
pub(crate) fn split_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let end = rest.find([';', ','])?;
    if end == 0 {
        return None;
    }
    let (media, tail) = rest.split_at(end);
    let data = tail.strip_prefix(";base64,")?;
    Some((media, data))
}

/// `parseDataUrl`.
pub(crate) fn parse_data_url(url: &str) -> Result<(String, String), GatewayError> {
    split_data_url(url)
        .map(|(m, d)| (m.to_string(), d.to_string()))
        .ok_or_else(|| {
            bad("image_url must be a base64 data URL; the gateway does not fetch remote images")
        })
}

/// The longest accepted model name.
pub const MODEL_NAME_MAX: usize = 200;

const CONVERSATION_HEADERS: [&str; 4] = [
    "x-session-id",
    "x-session-affinity",
    "x-deepseek-harness-session-id",
    "session-id",
];

/// The first conversation header present, trimmed, 1–512 UTF-16 units.
pub(crate) fn read_conversation_header(headers: &Headers) -> Option<String> {
    for name in CONVERSATION_HEADERS {
        if let Some(raw) = headers.get(name) {
            let raw = trim(raw);
            let n = utf16_len(raw);
            if n > 0 && n <= 512 {
                return Some(raw.to_string());
            }
        }
    }
    None
}

/// The first zod issue as `<path>: <detail>`.
pub(crate) fn parse_or_throw(
    schema: &zod::Z,
    body: &Value,
) -> Result<omni_ir::deep::Owned, GatewayError> {
    zod::parse(schema, body).map_err(|issue| {
        let path = if issue.path.is_empty() {
            "(root)".to_string()
        } else {
            issue
                .path
                .iter()
                .map(|s| safe_token(&s.as_string()).to_string())
                .collect::<Vec<_>>()
                .join(".")
        };
        bad(format!("{path}: {}", zod_detail(&issue)))
    })
}

/// The issue message, with an unknown key bounded.
pub(crate) fn zod_detail(issue: &zod::Issue) -> String {
    match &issue.kind {
        zod::Kind::UnrecognizedKeys(keys) => format!(
            "unrecognized key \"{}\"",
            safe_token(keys.first().map_or("", String::as_str))
        ),
        _ => issue.message(),
    }
}

/// The zod path joined with `.`, unbounded (hand-built paths are not
/// bounded either).
pub(crate) fn raw_path(issue: &zod::Issue) -> String {
    issue
        .path
        .iter()
        .map(zod::Seg::as_string)
        .collect::<Vec<_>>()
        .join(".")
}

/// Mint empty tool-use ids, drop orphaned tool results and empty messages,
/// merge same-role neighbours.
pub(crate) fn validate_request(
    mut req: ChatRequest,
    new_tool_use_id: &mut dyn FnMut() -> String,
) -> ChatRequest {
    let mut seen: HashSet<String> = HashSet::new();
    let mut cleaned: Vec<Message> = Vec::with_capacity(req.messages.len());
    for message in std::mem::take(&mut req.messages) {
        let mut content = Vec::with_capacity(message.content.len());
        for block in message.content {
            match block {
                ContentBlock::ToolUse(mut b) => {
                    if b.id.is_empty() {
                        b.id = new_tool_use_id();
                    }
                    seen.insert(b.id.clone());
                    content.push(ContentBlock::ToolUse(b));
                }
                ContentBlock::ToolResult(b) if !seen.contains(&b.tool_use_id) => {}
                other => content.push(other),
            }
        }
        if content.is_empty() {
            continue;
        }
        match cleaned.last_mut() {
            Some(prev) if prev.role == message.role => prev.content.extend(content),
            _ => cleaned.push(Message {
                role: message.role,
                content,
            }),
        }
    }
    req.messages = cleaned;
    req
}

/// A request with every optional field absent.
pub(crate) fn empty_request(model: String, messages: Vec<Message>, stream: bool) -> ChatRequest {
    ChatRequest {
        model,
        system: None,
        messages,
        tools: None,
        tool_choice: None,
        max_tokens: None,
        temperature: None,
        stop_sequences: None,
        stream,
        reasoning: None,
        vendor: None,
        provider_headers: None,
        betas: None,
        conversation_id: None,
    }
}

pub(crate) fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

pub(crate) fn string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// The value when the schema output carried the key and it is not null.
pub(crate) fn present(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_urls_split_like_the_ts_regex() {
        assert_eq!(
            split_data_url("data:image/png;base64,AA"),
            Some(("image/png", "AA"))
        );
        assert_eq!(
            split_data_url("data:image/png;base64,"),
            Some(("image/png", ""))
        );
        assert_eq!(split_data_url("data:a;base64,x\ny"), Some(("a", "x\ny")));
        assert_eq!(split_data_url("data:;base64,AA"), None);
        assert_eq!(split_data_url("data:image/png,AA"), None);
        assert_eq!(split_data_url("data:image/png;utf8,AA"), None);
    }

    #[test]
    fn minted_tool_use_ids_are_v4_uuids() {
        let id = random_tool_use_id();
        assert_eq!(id.len(), 3 + 36);
        assert_eq!(&id[17..18], "4");
        assert!(matches!(&id[22..23], "8" | "9" | "a" | "b"));
        assert_ne!(id, random_tool_use_id());
    }

    #[test]
    fn headers_combine_repeats_and_sort_like_whatwg() {
        let mut h = Headers::new();
        h.append("B", " 1 ");
        h.append("a", "x");
        h.append("b", "2");
        assert_eq!(h.get("b"), Some("1, 2"));
        assert_eq!(h.sorted(), vec![("a", "x"), ("b", "1, 2")]);
    }
}
