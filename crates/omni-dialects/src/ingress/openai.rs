//! `POST /v1/chat/completions`: `ingress/openai.ts`, including the Ollama
//! `images` and SDK `attachments` sidecar carriers (`ingress/schemas.ts`).

use omni_ir::error::GatewayError;
use omni_ir::js::safe_token;
use omni_ir::request::{
    ChatRequest, ContentBlock, CustomToolDef, ImageBlock, Message, ReasoningConfig, Role,
    TextBlock, ToolChoice, ToolDef, ToolResultBlock, ToolUseBlock,
};
use serde_json::{Map, Value};

use super::anthropic::effort_of;
use super::zod::{EFFORTS, Z, arr, arr_min, num, obj, one_of, opt, pos_int, rec, str, str_between};
use super::{
    Headers, IngressOptions, apply_message_cache_control, bad, empty_request, extra_fields,
    loose_cache_control, normalize_client_model, number, parse_data_url, parse_or_throw,
    read_conversation_header, split_data_url, string, validate_request,
};

const KNOWN: &[&str] = &[
    "model",
    "messages",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "stop",
    "stream",
    "tools",
    "tool_choice",
    "reasoning_effort",
    "stream_options",
    "user",
    "n",
];

fn attachment() -> Z {
    obj(vec![
        ("url", str()),
        ("contentType", opt(str())),
        ("mediaType", opt(str())),
    ])
}

/// The schema, built once: it is immutable, and building it per request
/// allocated a few hundred nodes.
fn schema_cached() -> &'static Z {
    static SCHEMA: std::sync::OnceLock<Z> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(schema)
}

fn schema() -> Z {
    let part = Z::Disc(
        "type",
        vec![
            obj(vec![
                ("type", one_of(&["text"])),
                ("text", str()),
                ("cache_control", opt(Z::Unknown)),
            ]),
            obj(vec![
                ("type", one_of(&["image_url"])),
                ("image_url", obj(vec![("url", str())])),
                ("cache_control", opt(Z::Unknown)),
            ]),
        ],
    );
    let tool_call = obj(vec![
        ("id", str()),
        ("type", one_of(&["function"])),
        ("function", obj(vec![("name", str()), ("arguments", str())])),
    ]);
    let message = obj(vec![
        (
            "role",
            one_of(&["system", "developer", "user", "assistant", "tool"]),
        ),
        ("content", opt(Z::Union(vec![str(), arr(part), Z::Null]))),
        ("tool_calls", opt(arr(tool_call))),
        ("tool_call_id", opt(str())),
        ("cache_control", opt(Z::Unknown)),
        ("images", opt(arr(str()))),
        ("attachments", opt(arr(attachment()))),
        ("experimental_attachments", opt(arr(attachment()))),
    ]);
    obj(vec![
        ("model", str_between(1, super::MODEL_NAME_MAX)),
        ("messages", arr_min(message, 1)),
        ("max_tokens", opt(pos_int())),
        ("max_completion_tokens", opt(pos_int())),
        ("temperature", opt(num())),
        ("stop", opt(Z::Union(vec![str(), arr(str())]))),
        ("stream", opt(Z::Bool)),
        (
            "tools",
            opt(arr(obj(vec![
                ("type", one_of(&["function"])),
                (
                    "function",
                    obj(vec![
                        ("name", str()),
                        ("description", opt(str())),
                        ("parameters", opt(rec())),
                        ("cache_control", opt(Z::Unknown)),
                    ]),
                ),
                ("cache_control", opt(Z::Unknown)),
            ]))),
        ),
        (
            "tool_choice",
            opt(Z::Union(vec![
                one_of(&["auto", "none", "required"]),
                obj(vec![
                    ("type", one_of(&["function"])),
                    ("function", obj(vec![("name", str())])),
                ]),
            ])),
        ),
        ("reasoning_effort", opt(one_of(EFFORTS))),
    ])
}

const BASE64_MAGIC: &[(&str, &str)] = &[
    ("iVBORw0KGgo", "image/png"),
    ("/9j/", "image/jpeg"),
    ("R0lGOD", "image/gif"),
    ("UklGR", "image/webp"),
];

/// `^[a-z][a-z0-9+.-]*:` (case-insensitive): a URL scheme.
fn has_scheme(raw: &str) -> bool {
    let mut chars = raw.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// `readSidecarImage`: an image, or the rejection detail.
fn read_sidecar_image(raw: &str, declared: Option<&str>) -> Result<(String, String), String> {
    if !raw.starts_with("data:") && has_scheme(raw) {
        return Err("the gateway does not fetch remote images".into());
    }
    let (sniffed, data) = if raw.starts_with("data:") {
        match split_data_url(raw) {
            Some((m, d)) => (Some(m), d),
            None => return Err("data URL must carry base64 content".into()),
        }
    } else {
        let magic = BASE64_MAGIC
            .iter()
            .find(|(prefix, _)| raw.starts_with(prefix))
            .map(|(_, m)| *m);
        (magic, raw)
    };
    let Some(media_type) = sniffed.or(declared) else {
        return Err("unrecognized image data; expected PNG, JPEG, GIF or WebP".into());
    };
    if !media_type.starts_with("image/") {
        return Err(format!("{} is not an image", safe_token(media_type)));
    }
    Ok((media_type.to_string(), data.to_string()))
}

fn image(
    media_type: String,
    data: String,
    cache_control: Option<omni_ir::request::CacheControl>,
) -> ContentBlock {
    ContentBlock::Image(ImageBlock {
        media_type,
        data,
        cache_control,
    })
}

fn has_ollama_images(m: &Value) -> bool {
    m.get("images")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
}

fn sidecar_images(m: &Value) -> Result<Vec<ContentBlock>, GatewayError> {
    let mut blocks = Vec::new();
    if let Some(images) = m.get("images").and_then(Value::as_array) {
        for (index, raw) in images.iter().enumerate() {
            let raw = raw.as_str().unwrap_or_default();
            let (media, data) = read_sidecar_image(raw, None)
                .map_err(|detail| bad(format!("messages: images[{index}]: {detail}")))?;
            blocks.push(image(media, data, None));
        }
    }
    for list in ["attachments", "experimental_attachments"] {
        if let Some(items) = m.get(list).and_then(Value::as_array) {
            for a in items {
                let url = string(a.get("url")).unwrap_or_default();
                let declared = string(a.get("mediaType")).or_else(|| string(a.get("contentType")));
                if let Ok((media, data)) = read_sidecar_image(url, declared) {
                    blocks.push(image(media, data, None));
                }
            }
        }
    }
    Ok(blocks)
}

fn content_blocks(content: Option<&Value>) -> Result<Vec<ContentBlock>, GatewayError> {
    match content {
        Some(Value::String(s)) if s.is_empty() => Ok(Vec::new()),
        Some(Value::String(s)) => Ok(vec![ContentBlock::Text(TextBlock {
            text: s.clone(),
            cache_control: None,
            citations: None,
        })]),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| {
                let cc = loose_cache_control(p.get("cache_control"));
                if string(p.get("type")) == Some("text") {
                    Ok(ContentBlock::Text(TextBlock {
                        text: string(p.get("text")).unwrap_or_default().to_string(),
                        cache_control: cc,
                        citations: None,
                    }))
                } else {
                    let url = string(p.get("image_url").and_then(|u| u.get("url")));
                    let (media, data) = parse_data_url(url.unwrap_or_default())?;
                    Ok(image(media, data, cc))
                }
            })
            .collect(),
        _ => Ok(Vec::new()),
    }
}

/// `parseArguments`: a malformed or non-object argument string becomes `{}`.
///
/// Only where `JSON.parse` would throw: valid JSON nested past
/// `omni_ir::deep::MAX_DEPTH` is refused with [`super::TOO_DEEP`], never
/// replaced by `{}`.
fn parse_arguments(raw: &str) -> Result<Value, GatewayError> {
    match super::deep_json(raw, usize::MAX) {
        Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(v),
        Ok(other) => {
            omni_ir::deep::drop(other);
            Ok(Value::Object(Map::new()))
        }
        Err(omni_ir::deep::ParseError::TooDeep) => Err(bad(super::TOO_DEEP)),
        Err(omni_ir::deep::ParseError::Syntax) => Ok(Value::Object(Map::new())),
    }
}

/// `parseOpenAIRequest`.
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

    let mut system: Vec<ContentBlock> = Vec::new();
    let mut messages: Vec<Message> = Vec::new();
    for m in parsed["messages"].as_array().into_iter().flatten() {
        let role = string(m.get("role")).unwrap_or_default();
        if role != "user" && role != "assistant" && has_ollama_images(m) {
            return Err(bad(format!(
                "messages: a {role} message cannot carry images; attach them to a user message"
            )));
        }
        if role == "system" || role == "developer" {
            let mut blocks = content_blocks(m.get("content"))?;
            apply_message_cache_control(&mut blocks, m.get("cache_control"));
            system.extend(blocks);
            continue;
        }
        if role == "tool" {
            let Some(id) = string(m.get("tool_call_id")) else {
                return Err(bad("messages: tool message requires tool_call_id"));
            };
            let content = m.get("content");
            let filtered = content.and_then(Value::as_array).map(|parts| {
                Value::Array(
                    parts
                        .iter()
                        .filter(|p| {
                            string(p.get("type")) != Some("image_url")
                                || string(p.get("image_url").and_then(|u| u.get("url")))
                                    .unwrap_or_default()
                                    .starts_with("data:")
                        })
                        .map(omni_ir::deep::clone)
                        .collect(),
                )
            });
            let parts = content_blocks(filtered.as_ref().or(content))?;
            let images: Vec<ImageBlock> = parts
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Image(i) => Some(i.clone()),
                    _ => None,
                })
                .collect();
            let text = match content {
                Some(Value::String(s)) => s.clone(),
                _ => parts
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text(t) => Some(t.text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            };
            messages.push(Message {
                role: Role::User,
                content: vec![ContentBlock::ToolResult(ToolResultBlock {
                    tool_use_id: id.to_string(),
                    content: text,
                    images: (!images.is_empty()).then_some(images),
                    files: None,
                    native: None,
                    is_error: Some(false),
                    cache_control: loose_cache_control(m.get("cache_control")),
                })],
            });
            continue;
        }

        let mut content = content_blocks(m.get("content"))?;
        content.extend(sidecar_images(m)?);
        for call in m
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let f = call.get("function");
            content.push(ContentBlock::ToolUse(ToolUseBlock {
                id: string(call.get("id")).unwrap_or_default().to_string(),
                name: string(f.and_then(|f| f.get("name")))
                    .unwrap_or_default()
                    .to_string(),
                input: parse_arguments(
                    string(f.and_then(|f| f.get("arguments"))).unwrap_or_default(),
                )?,
                cache_control: None,
            }));
        }
        apply_message_cache_control(&mut content, m.get("cache_control"));
        if !content.is_empty() {
            messages.push(Message {
                role: if role == "assistant" {
                    Role::Assistant
                } else {
                    Role::User
                },
                content,
            });
        }
    }

    if messages.is_empty() {
        return Err(bad("messages: at least one non-system message is required"));
    }

    let (model, _) = normalize_client_model(string(parsed.get("model")).unwrap_or_default(), &[]);
    let stream = parsed
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut request = empty_request(model, messages, stream);
    if !system.is_empty() {
        request.system = Some(system);
    }
    request.max_tokens =
        number(parsed.get("max_completion_tokens")).or_else(|| number(parsed.get("max_tokens")));
    request.temperature = number(parsed.get("temperature"));
    request.stop_sequences = match parsed.get("stop") {
        Some(Value::String(s)) => Some(vec![s.clone()]),
        Some(Value::Array(a)) => Some(
            a.iter()
                .map(|s| s.as_str().unwrap_or_default().to_string())
                .collect(),
        ),
        _ => None,
    };
    if let Some(Value::Array(tools)) = parsed.get("tools") {
        request.tools = Some(
            tools
                .iter()
                .map(|t| {
                    let f = &t["function"];
                    let outer = loose_cache_control(t.get("cache_control"));
                    ToolDef::Portable(CustomToolDef {
                        name: string(f.get("name")).unwrap_or_default().to_string(),
                        description: string(f.get("description")).map(str::to_string),
                        input_schema: f
                            .get("parameters")
                            .map(omni_ir::deep::clone)
                            .unwrap_or_else(|| {
                                let mut m = Map::new();
                                m.insert("type".into(), "object".into());
                                Value::Object(m)
                            }),
                        cache_control: outer
                            .or_else(|| loose_cache_control(f.get("cache_control"))),
                        options: None,
                    })
                })
                .collect(),
        );
    }
    request.tool_choice = match parsed.get("tool_choice") {
        Some(Value::String(s)) => Some(match s.as_str() {
            "required" => ToolChoice::Any,
            "none" => ToolChoice::None,
            _ => ToolChoice::Auto,
        }),
        Some(Value::Object(o)) => Some(ToolChoice::Tool {
            name: string(o.get("function").and_then(|f| f.get("name")))
                .unwrap_or_default()
                .to_string(),
        }),
        _ => None,
    };
    if let Some(effort) = string(parsed.get("reasoning_effort")).and_then(effort_of) {
        request.reasoning = Some(ReasoningConfig::Adaptive {
            effort: Some(effort),
            display: None,
        });
    }
    request.conversation_id = read_conversation_header(headers);
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
    fn a_scheme_is_letters_then_scheme_chars_then_a_colon() {
        assert!(has_scheme("https://x"));
        assert!(has_scheme("A+b.c-d:x"));
        assert!(!has_scheme("iVBORw0KGgo"));
        assert!(!has_scheme("/9j/:"));
        assert!(!has_scheme("1http:"));
        assert!(!has_scheme("ab cd:"));
    }
}
