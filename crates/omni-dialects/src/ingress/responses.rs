//! `POST /v1/responses`, stateless: `ingress/responses.ts`.

use std::collections::HashSet;

use omni_ir::error::GatewayError;
use omni_ir::js::{safe_token, trim, utf16_len};
use omni_ir::request::{
    ChatRequest, ContentBlock, CustomToolDef, FileBlock, ImageBlock, Message, ProviderNativeBlock,
    ProviderToolDef, ReasoningConfig, ReasoningDisplay, Role, TextBlock, ToolChoice, ToolDef,
    ToolResultBlock, ToolUseBlock,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::anthropic::effort_of;
use super::zod::{EFFORTS, Z, arr, nullish, num, obj, one_of, opt, pos_int, str, str_between};
use super::{
    Headers, IngressOptions, bad, empty_request, extra_fields, is_record, normalize_client_model,
    number, parse_data_url, parse_or_throw, read_conversation_header, split_data_url, string,
    validate_request,
};

const KNOWN: &[&str] = &[
    "model",
    "input",
    "instructions",
    "tools",
    "tool_choice",
    "stream",
    "store",
    "reasoning",
    "background",
    "previous_response_id",
    "max_output_tokens",
    "temperature",
    "metadata",
    "user",
];

/// The schema, built once: it is immutable, and building it per request
/// allocated a few hundred nodes.
fn schema_cached() -> &'static Z {
    static SCHEMA: std::sync::OnceLock<Z> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(schema)
}

fn schema() -> Z {
    obj(vec![
        ("model", str_between(1, super::MODEL_NAME_MAX)),
        ("input", Z::Union(vec![str(), arr(Z::Unknown)])),
        ("tools", opt(arr(Z::Unknown))),
        ("instructions", opt(str())),
        ("max_output_tokens", opt(pos_int())),
        ("temperature", opt(num())),
        ("stream", opt(Z::Bool)),
        (
            "reasoning",
            opt(obj(vec![
                ("effort", opt(one_of(EFFORTS))),
                ("summary", opt(str())),
            ])),
        ),
        (
            "tool_choice",
            opt(Z::Union(vec![
                one_of(&["auto", "none", "required"]),
                obj(vec![
                    ("type", one_of(&["function", "custom"])),
                    ("name", str()),
                ]),
            ])),
        ),
        ("previous_response_id", nullish(str())),
        ("store", nullish(Z::Bool)),
        ("background", nullish(Z::Bool)),
        ("prompt_cache_key", nullish(str())),
    ])
}

/// `clampCallId`: ids over 64 UTF-16 units become their SHA-256 hex digest.
fn clamp_call_id(raw: &str) -> String {
    if utf16_len(raw) <= 64 {
        return raw.to_string();
    }
    Sha256::digest(raw.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn role_of(raw: Option<&Value>) -> Role {
    match string(raw) {
        Some("assistant") => Role::Assistant,
        Some("system" | "developer") => Role::System,
        _ => Role::User,
    }
}

/// `String(part.text ?? "")`.
fn text_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        some => omni_ir::js::to_string(some),
    }
}

fn text(t: String) -> ContentBlock {
    ContentBlock::Text(TextBlock {
        text: t,
        cache_control: None,
        citations: None,
    })
}

/// `safeToken(String(type))` for a value that may be `undefined`.
fn token_of(v: Option<&Value>) -> String {
    safe_token(&omni_ir::js::to_string(v)).to_string()
}

fn content_part(part: &Value) -> Result<Option<ContentBlock>, GatewayError> {
    if !is_record(Some(part)) {
        return Err(bad("input: content part must be an object"));
    }
    let t = part.get("type");
    match string(t) {
        Some("input_text" | "output_text") => Ok(Some(text(text_of(part.get("text"))))),
        Some("input_image") => {
            let url = string(part.get("image_url")).unwrap_or_default();
            if !url.starts_with("data:") {
                return Ok(None);
            }
            let (media_type, data) = parse_data_url(url)?;
            Ok(Some(ContentBlock::Image(ImageBlock {
                media_type,
                data,
                cache_control: None,
            })))
        }
        _ => Err(bad(format!(
            "input: unsupported content part type \"{}\"",
            token_of(t)
        ))),
    }
}

/// `fileData`.
fn file_data(raw: &str) -> (String, String) {
    if let Some((m, d)) = split_data_url(raw) {
        return (m.to_string(), d.to_string());
    }
    let media = if raw.starts_with("JVBERi") {
        "application/pdf"
    } else {
        "application/octet-stream"
    };
    (media.to_string(), raw.to_string())
}

/// `readToolOutput`.
fn read_tool_output(output: Option<&Value>) -> Result<ToolResultBlock, GatewayError> {
    let mut out = ToolResultBlock {
        tool_use_id: String::new(),
        content: String::new(),
        images: None,
        files: None,
        native: None,
        is_error: Some(false),
        cache_control: None,
    };
    let parts = match output {
        Some(Value::String(s)) => {
            out.content = s.clone();
            return Ok(out);
        }
        Some(Value::Array(parts)) => parts,
        // `JSON.stringify(output ?? "")`, written from the borrowed value.
        None | Some(Value::Null) => {
            out.content = r#""""#.to_string();
            return Ok(out);
        }
        Some(v) => {
            out.content = omni_ir::jsjson::to_string(v);
            return Ok(out);
        }
    };
    let mut texts = Vec::new();
    let (mut images, mut files) = (Vec::new(), Vec::new());
    for part in parts {
        let rec = is_record(Some(part));
        let t = if rec { string(part.get("type")) } else { None };
        match t {
            Some("input_text" | "output_text") => texts.push(text_of(part.get("text"))),
            Some("input_image")
                if string(part.get("image_url")).is_some_and(|u| u.starts_with("data:")) =>
            {
                let (media_type, data) =
                    parse_data_url(string(part.get("image_url")).unwrap_or_default())?;
                images.push(ImageBlock {
                    media_type,
                    data,
                    cache_control: None,
                });
            }
            Some("input_file") if string(part.get("file_data")).is_some() => {
                let (media_type, data) =
                    file_data(string(part.get("file_data")).unwrap_or_default());
                files.push(FileBlock {
                    media_type,
                    data,
                    filename: string(part.get("filename")).map(str::to_string),
                });
            }
            _ => texts.push(omni_ir::jsjson::to_string(part)),
        }
    }
    out.content = texts.join("\n");
    out.images = (!images.is_empty()).then_some(images);
    out.files = (!files.is_empty()).then_some(files);
    Ok(out)
}

fn message_blocks(content: Option<&Value>) -> Result<Vec<ContentBlock>, GatewayError> {
    match content {
        Some(Value::String(s)) => Ok(vec![text(s.clone())]),
        Some(Value::Array(parts)) => {
            let mut blocks = Vec::new();
            for p in parts {
                if let Some(b) = content_part(p)? {
                    blocks.push(b);
                }
            }
            Ok(blocks)
        }
        _ => Ok(Vec::new()),
    }
}

fn native_block(item: &Value, block_type: &str) -> ContentBlock {
    let mut data = Map::new();
    if let Some(map) = item.as_object() {
        for key in super::js_keys(map) {
            // Object rest (`{ type, ...data }`) keeps an own `__proto__`.
            if key != "type" {
                data.insert(key.to_string(), omni_ir::deep::clone(&map[key]));
            }
        }
    }
    ContentBlock::ProviderNative(ProviderNativeBlock {
        provider: "openai".into(),
        block_type: block_type.to_string(),
        data,
        cache_control: None,
    })
}

/// `jsonArguments`.
fn json_arguments(raw: Option<&Value>, call_id: &str) -> Result<Value, GatewayError> {
    let text = string(raw).unwrap_or_default();
    if text.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    match super::deep_json(text, usize::MAX) {
        Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(v),
        Ok(v) => Ok(json!({ "value": v })),
        Err(omni_ir::deep::ParseError::TooDeep) => Err(bad(super::TOO_DEEP)),
        Err(omni_ir::deep::ParseError::Syntax) => Err(bad(format!(
            "input: arguments for call {} are not valid JSON",
            safe_token(call_id)
        ))),
    }
}

fn read_input_items(items: &[Value]) -> Result<Vec<Message>, GatewayError> {
    let mut dropped: HashSet<String> = HashSet::new();
    let mut messages = Vec::new();
    let mut push = |role: Role, content: Vec<ContentBlock>| {
        if !content.is_empty() {
            messages.push(Message { role, content });
        }
    };
    for raw in items {
        if !is_record(Some(raw)) {
            return Err(bad("input: item must be an object"));
        }
        // `raw.type ?? (raw.role === undefined ? undefined : "message")`.
        // Borrowed: `type` may be any client value, kept only to be named.
        let t = raw.get("type").filter(|t| !t.is_null());
        let kind = match t {
            Some(t) => t.as_str(),
            None if raw.get("role").is_some() => Some("message"),
            None => None,
        };
        match kind {
            Some("message") => push(
                role_of(raw.get("role")),
                message_blocks(raw.get("content"))?,
            ),
            Some(kind @ ("function_call" | "custom_tool_call")) => {
                let name = string(raw.get("name")).unwrap_or_default();
                let call_id = string(raw.get("call_id")).unwrap_or_default();
                if name.is_empty() || call_id.is_empty() {
                    dropped.insert(call_id.to_string());
                    continue;
                }
                let id = clamp_call_id(call_id);
                let input = if kind == "custom_tool_call" {
                    json!({ "input": string(raw.get("input")).unwrap_or_default() })
                } else {
                    json_arguments(raw.get("arguments"), &id)?
                };
                push(
                    Role::Assistant,
                    vec![ContentBlock::ToolUse(ToolUseBlock {
                        id,
                        name: name.to_string(),
                        input,
                        cache_control: None,
                    })],
                );
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                let call_id = string(raw.get("call_id")).unwrap_or_default();
                if dropped.contains(call_id) {
                    continue;
                }
                let mut result = read_tool_output(raw.get("output"))?;
                result.tool_use_id = clamp_call_id(call_id);
                push(Role::User, vec![ContentBlock::ToolResult(result)]);
            }
            Some(kind @ ("reasoning" | "local_shell_call")) => {
                push(Role::Assistant, vec![native_block(raw, kind)]);
            }
            Some("local_shell_call_output") => {
                push(
                    Role::User,
                    vec![native_block(raw, "local_shell_call_output")],
                );
            }
            Some("item_reference") => {
                return Err(bad(
                    "input: item_reference names a stored item, and this gateway stores no responses",
                ));
            }
            _ => {
                return Err(bad(format!(
                    "input: unsupported item type \"{}\"",
                    token_of(t)
                )));
            }
        }
    }
    Ok(messages)
}

/// `^[A-Za-z0-9_-]{1,128}$`.
fn is_tool_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

const TOOL_NAME_RULE: &str = "tools: a tool name must match ^[A-Za-z0-9_-]{1,128}$";

fn read_tools(raw: &[Value]) -> Result<Vec<ToolDef>, GatewayError> {
    let mut tools = Vec::new();
    for entry in raw {
        if !is_record(Some(entry)) {
            return Err(bad("tools: each tool must be an object"));
        }
        // An array passes `isRecord` and reads every named field as undefined.
        let empty = Map::new();
        let map = entry.as_object().unwrap_or(&empty);
        let t = string(map.get("type")).unwrap_or_default();
        let declared = string(map.get("name")).unwrap_or_default();
        if t == "function" || t == "custom" {
            if !is_tool_name(declared) {
                return Err(bad(TOOL_NAME_RULE));
            }
            let input_schema = if t == "custom" {
                json!({"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"]})
            } else {
                match map.get("parameters") {
                    Some(p @ (Value::Object(_) | Value::Array(_))) => omni_ir::deep::clone(p),
                    _ => json!({"type": "object"}),
                }
            };
            tools.push(ToolDef::Portable(CustomToolDef {
                name: declared.to_string(),
                description: string(map.get("description")).map(str::to_string),
                input_schema,
                cache_control: None,
                options: None,
            }));
            continue;
        }
        let name = if declared.is_empty() { t } else { declared };
        if !is_tool_name(name) {
            return Err(bad(TOOL_NAME_RULE));
        }
        let mut wire = Map::new();
        for key in super::js_keys(map) {
            if key != "type" && key != "name" {
                wire.insert(key.to_string(), omni_ir::deep::clone(&map[key]));
            }
        }
        tools.push(ToolDef::Provider(ProviderToolDef {
            provider: "openai".into(),
            tool_type: t.to_string(),
            name: name.to_string(),
            wire,
            cache_control: None,
            family: None,
        }));
    }
    Ok(tools)
}

/// `readCacheKey`.
fn read_cache_key(raw: Option<&Value>) -> Option<String> {
    let trimmed = trim(string(raw)?);
    let n = utf16_len(trimmed);
    (n > 0 && n <= 512).then(|| trimmed.to_string())
}

/// `parseResponsesRequest`.
pub fn parse(
    body: &Value,
    headers: &Headers,
    opts: &mut IngressOptions<'_>,
) -> Result<ChatRequest, GatewayError> {
    if !matches!(body, Value::Object(_) | Value::Array(_)) {
        return Err(bad("request body must be a JSON object"));
    }
    let parsed = parse_or_throw(schema_cached(), body)?;
    let Value::Object(raw) = body else {
        unreachable!("an array fails the schema")
    };

    if string(parsed.get("previous_response_id")).is_some_and(|s| !s.is_empty()) {
        return Err(bad(
            "previous_response_id: this gateway stores no responses, so prior state cannot be resumed",
        ));
    }
    if parsed.get("store").and_then(Value::as_bool) == Some(true) {
        return Err(bad(
            "store: this gateway stores no responses; send store: false or omit it",
        ));
    }

    let messages = match parsed.get("input") {
        Some(Value::String(s)) => vec![Message {
            role: Role::User,
            content: vec![text(s.clone())],
        }],
        Some(Value::Array(items)) => read_input_items(items)?,
        _ => Vec::new(),
    };
    if messages.is_empty() {
        return Err(bad("input: at least one input item is required"));
    }

    let (model, betas) =
        normalize_client_model(string(parsed.get("model")).unwrap_or_default(), &[]);
    let stream = parsed
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut request = empty_request(model, messages, stream);
    if let Some(i) = string(parsed.get("instructions")).filter(|i| !i.is_empty()) {
        request.system = Some(vec![text(i.to_string())]);
    }
    request.max_tokens = number(parsed.get("max_output_tokens"));
    request.temperature = number(parsed.get("temperature"));
    if let Some(Value::Array(tools)) = parsed.get("tools")
        && !tools.is_empty()
    {
        request.tools = Some(read_tools(tools)?);
    }
    request.tool_choice = match parsed.get("tool_choice") {
        Some(Value::String(s)) => Some(match s.as_str() {
            "required" => ToolChoice::Any,
            "none" => ToolChoice::None,
            _ => ToolChoice::Auto,
        }),
        Some(Value::Object(o)) => Some(ToolChoice::Tool {
            name: string(o.get("name")).unwrap_or_default().to_string(),
        }),
        _ => None,
    };
    if let Some(r) = parsed.get("reasoning") {
        request.reasoning = Some(ReasoningConfig::Adaptive {
            effort: string(r.get("effort")).and_then(effort_of),
            display: (string(r.get("summary")) == Some("none"))
                .then_some(ReasoningDisplay::Omitted),
        });
    }
    if !betas.is_empty() {
        request.betas = Some(betas);
    }
    request.conversation_id = read_cache_key(parsed.get("prompt_cache_key"))
        .or_else(|| read_conversation_header(headers));
    if let Some(extras) = extra_fields(raw, KNOWN) {
        let mut vendor = Map::new();
        vendor.insert("openai".into(), Value::Object(extras));
        request.vendor = Some(vendor);
    }
    Ok(validate_request(request, opts.new_tool_use_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_call_ids_become_their_sha256() {
        assert_eq!(clamp_call_id("short"), "short");
        assert_eq!(clamp_call_id(&"x".repeat(64)), "x".repeat(64));
        assert_eq!(clamp_call_id(&"c".repeat(65)).len(), 64);
    }

    #[test]
    fn tool_names_follow_the_published_rule() {
        assert!(is_tool_name("apply_patch-2"));
        assert!(!is_tool_name(""));
        assert!(!is_tool_name("a b"));
        assert!(!is_tool_name(&"a".repeat(129)));
        assert!(!is_tool_name("é"));
    }
}
