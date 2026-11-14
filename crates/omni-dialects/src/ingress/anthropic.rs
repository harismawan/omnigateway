//! `POST /v1/messages` (and its `count_tokens` body): `ingress/anthropic.ts`.

use omni_ir::error::GatewayError;
use omni_ir::js::safe_token;
use omni_ir::request::{
    ChatRequest, ContentBlock, FileBlock, ImageBlock, Message, ProviderNativeBlock,
    ReasoningConfig, ReasoningDisplay, ReasoningEffort, Role, TextBlock, ThinkingBlock, ToolChoice,
    ToolResultBlock, ToolUseBlock,
};
use serde_json::{Map, Value};

use super::anthropic_tools::{mcp_server_names, parse_tools};
use super::zod::{
    self, EFFORTS, Kind, Z, arr, arr_min, nullable, nullish, num, obj, one_of, opt, pos_int, rec,
    str, str_between, str_max, strict,
};
use super::{
    Headers, IngressOptions, bad, empty_request, extra_fields, ir_cache_control,
    normalize_client_model, number, parse_or_throw, present, read_conversation_header, string,
    validate_request, zod_detail,
};

const NATIVE_BLOCK_TYPES: &[&str] = &[
    "server_tool_use",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "mcp_tool_use",
    "mcp_tool_result",
    "tool_search_tool_result",
    "tool_reference",
    "advisor_tool_result",
    "advisor_result",
    "advisor_redacted_result",
    "container_upload",
    "compaction",
    "search_result",
    "document",
    "mid_conv_system",
    "tool_addition",
    "tool_removal",
    "fallback",
    "redacted_thinking",
];

const KNOWN: &[&str] = &[
    "model",
    "messages",
    "system",
    "max_tokens",
    "temperature",
    "stop_sequences",
    "stream",
    "tools",
    "tool_choice",
    "thinking",
    "metadata",
];

fn cc() -> Z {
    zod::cache_control()
}

fn text_block() -> Z {
    obj(vec![
        ("type", one_of(&["text"])),
        ("text", str()),
        ("cache_control", opt(cc())),
        ("citations", opt(arr(Z::Unknown))),
    ])
}

fn image_block() -> Z {
    obj(vec![
        ("type", one_of(&["image"])),
        (
            "source",
            obj(vec![
                ("type", one_of(&["base64"])),
                ("media_type", str()),
                ("data", str()),
            ]),
        ),
        ("cache_control", opt(cc())),
    ])
}

fn block() -> Z {
    Z::Disc(
        "type",
        vec![
            text_block(),
            image_block(),
            obj(vec![
                ("type", one_of(&["thinking"])),
                ("thinking", str()),
                ("signature", opt(str())),
            ]),
            obj(vec![
                ("type", one_of(&["tool_use"])),
                ("id", str()),
                ("name", str()),
                ("input", Z::DefaultEmptyObject(Box::new(rec()))),
                ("cache_control", opt(cc())),
            ]),
            obj(vec![
                ("type", one_of(&["tool_result"])),
                ("tool_use_id", str()),
                ("content", opt(Z::Union(vec![str(), arr(Z::Unknown)]))),
                ("is_error", opt(Z::Bool)),
                ("cache_control", opt(cc())),
            ]),
        ],
    )
}

fn native_cc() -> (&'static str, Z) {
    ("cache_control", opt(nullable(cc())))
}

fn caller() -> Z {
    opt(Z::Disc(
        "type",
        vec![
            strict(vec![("type", one_of(&["direct"]))]),
            strict(vec![
                (
                    "type",
                    one_of(&[
                        "code_execution_20250825",
                        "code_execution_20260120",
                        "code_execution_20260521",
                    ]),
                ),
                ("tool_id", str()),
            ]),
        ],
    ))
}

fn citations_config() -> Z {
    strict(vec![("enabled", opt(Z::Bool))])
}

fn tool_change(kind: &'static [&'static str]) -> Z {
    let reference = Z::Disc(
        "type",
        vec![
            strict(vec![("type", one_of(&["tool_reference"])), ("name", str())]),
            strict(vec![
                ("type", one_of(&["mcp_tool_reference"])),
                ("server_name", str()),
                ("name", str()),
            ]),
            strict(vec![
                ("type", one_of(&["mcp_toolset_reference"])),
                ("server_name", str()),
            ]),
        ],
    );
    strict(vec![
        ("type", one_of(kind)),
        ("tool", reference),
        native_cc(),
    ])
}

fn native_result(kind: &'static [&'static str], has_caller: bool) -> Z {
    let mut shape = vec![
        ("type", one_of(kind)),
        ("tool_use_id", str()),
        (
            "content",
            Z::NotNull(Box::new(Z::Unknown), "expected native result content"),
        ),
    ];
    if has_caller {
        shape.push(("caller", caller()));
    }
    shape.push(native_cc());
    strict(shape)
}

/// `nativeSchemas[type]`, for the types legal in request history.
fn native_schema(t: &str) -> Option<Z> {
    Some(match t {
        "server_tool_use" => strict(vec![
            ("type", one_of(&["server_tool_use"])),
            ("id", str()),
            (
                "name",
                one_of(&[
                    "advisor",
                    "web_search",
                    "web_fetch",
                    "code_execution",
                    "bash_code_execution",
                    "text_editor_code_execution",
                    "tool_search_tool_regex",
                    "tool_search_tool_bm25",
                ]),
            ),
            ("input", Z::Unknown),
            ("caller", caller()),
            native_cc(),
        ]),
        "web_search_tool_result" => native_result(&["web_search_tool_result"], true),
        "web_fetch_tool_result" => native_result(&["web_fetch_tool_result"], true),
        "code_execution_tool_result" => native_result(&["code_execution_tool_result"], false),
        "bash_code_execution_tool_result" => {
            native_result(&["bash_code_execution_tool_result"], false)
        }
        "text_editor_code_execution_tool_result" => {
            native_result(&["text_editor_code_execution_tool_result"], false)
        }
        "tool_search_tool_result" => native_result(&["tool_search_tool_result"], false),
        "advisor_tool_result" => native_result(&["advisor_tool_result"], false),
        "mcp_tool_use" => strict(vec![
            ("type", one_of(&["mcp_tool_use"])),
            ("id", str()),
            ("name", str()),
            ("server_name", str()),
            ("input", Z::Unknown),
            native_cc(),
        ]),
        "mcp_tool_result" => strict(vec![
            ("type", one_of(&["mcp_tool_result"])),
            ("tool_use_id", str()),
            ("content", opt(Z::Union(vec![str(), arr(Z::Unknown)]))),
            ("is_error", opt(Z::Bool)),
            native_cc(),
        ]),
        "container_upload" => strict(vec![
            ("type", one_of(&["container_upload"])),
            ("file_id", str()),
            native_cc(),
        ]),
        "compaction" => strict(vec![
            ("type", one_of(&["compaction"])),
            ("content", nullable(str())),
            ("encrypted_content", nullish(str())),
            native_cc(),
        ]),
        "search_result" => strict(vec![
            ("type", one_of(&["search_result"])),
            ("source", str()),
            ("title", str()),
            ("content", arr(Z::Unknown)),
            ("citations", opt(citations_config())),
            native_cc(),
        ]),
        "redacted_thinking" => strict(vec![
            ("type", one_of(&["redacted_thinking"])),
            ("data", str()),
        ]),
        "document" => strict(vec![
            ("type", one_of(&["document"])),
            (
                "source",
                Z::Disc(
                    "type",
                    vec![
                        strict(vec![
                            ("type", one_of(&["base64"])),
                            ("media_type", one_of(&["application/pdf"])),
                            ("data", str()),
                        ]),
                        strict(vec![
                            ("type", one_of(&["text"])),
                            ("media_type", one_of(&["text/plain"])),
                            ("data", str()),
                        ]),
                        strict(vec![
                            ("type", one_of(&["content"])),
                            ("content", arr(Z::Unknown)),
                        ]),
                        strict(vec![("type", one_of(&["url"])), ("url", str())]),
                        strict(vec![("type", one_of(&["file"])), ("file_id", str())]),
                    ],
                ),
            ),
            ("citations", nullish(citations_config())),
            ("context", nullish(str())),
            ("title", nullish(str())),
            native_cc(),
        ]),
        "mid_conv_system" => strict(vec![
            ("type", one_of(&["mid_conv_system"])),
            (
                "content",
                arr(Z::Disc(
                    "type",
                    vec![
                        strict(vec![
                            ("type", one_of(&["text"])),
                            ("text", str()),
                            ("cache_control", opt(nullable(cc()))),
                            ("citations", opt(nullable(arr(Z::Unknown)))),
                        ]),
                        tool_change(&["tool_addition"]),
                        tool_change(&["tool_removal"]),
                    ],
                )),
            ),
            native_cc(),
        ]),
        "tool_addition" => tool_change(&["tool_addition"]),
        "tool_removal" => tool_change(&["tool_removal"]),
        "fallback" => {
            let model = || strict(vec![("model", str())]);
            strict(vec![
                ("type", one_of(&["fallback"])),
                ("from", model()),
                ("to", model()),
                ("trigger", opt(Z::Unknown)),
            ])
        }
        _ => return None,
    })
}

fn native_role(t: &str) -> Option<Role> {
    Some(match t {
        "server_tool_use"
        | "web_search_tool_result"
        | "web_fetch_tool_result"
        | "code_execution_tool_result"
        | "bash_code_execution_tool_result"
        | "text_editor_code_execution_tool_result"
        | "tool_search_tool_result"
        | "advisor_tool_result"
        | "mcp_tool_use"
        | "compaction"
        | "redacted_thinking"
        | "fallback" => Role::Assistant,
        "mcp_tool_result" | "container_upload" | "search_result" | "document" => Role::User,
        "mid_conv_system" | "tool_addition" | "tool_removal" => Role::System,
        _ => return None,
    })
}

/// The schema, built once: it is immutable, and building it per request
/// allocated a few hundred nodes.
fn schema_cached() -> &'static Z {
    static SCHEMA: std::sync::OnceLock<Z> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(schema)
}

fn schema() -> Z {
    obj(vec![
        ("model", str_between(1, super::MODEL_NAME_MAX)),
        (
            "messages",
            arr_min(
                obj(vec![
                    ("role", one_of(&["user", "assistant", "system"])),
                    ("content", Z::Union(vec![str(), arr(Z::Unknown)])),
                ]),
                1,
            ),
        ),
        ("system", opt(Z::Union(vec![str(), arr(text_block())]))),
        ("max_tokens", opt(pos_int())),
        ("temperature", opt(num())),
        ("stop_sequences", opt(arr(str()))),
        ("stream", opt(Z::Bool)),
        ("tools", opt(arr(Z::Unknown))),
        (
            "tool_choice",
            opt(Z::Union(vec![
                obj(vec![("type", one_of(&["auto", "any", "none"]))]),
                obj(vec![("type", one_of(&["tool"])), ("name", str())]),
            ])),
        ),
        (
            "thinking",
            opt(Z::Union(vec![
                obj(vec![
                    ("type", one_of(&["adaptive"])),
                    (
                        "display",
                        opt(one_of(&["summarized", "omitted", "updates"])),
                    ),
                ]),
                obj(vec![
                    ("type", one_of(&["enabled"])),
                    ("budget_tokens", pos_int()),
                ]),
                obj(vec![("type", one_of(&["disabled"]))]),
                obj(vec![("type", one_of(&["between_tools"]))]),
            ])),
        ),
        (
            "metadata",
            nullish(obj(vec![("user_id", nullish(str_max(512)))])),
        ),
    ])
}

/// Strips `type` and `cache_control` from a parsed native block.
fn native_block(t: &str, parsed: &Value) -> ProviderNativeBlock {
    let mut data = Map::new();
    let mut cache_control = None;
    if let Some(map) = parsed.as_object() {
        for (k, v) in map {
            match k.as_str() {
                "type" => {}
                "cache_control" => cache_control = ir_cache_control(present(Some(v))),
                _ => {
                    omni_ir::deep::insert(&mut data, k.clone(), omni_ir::deep::clone(v));
                }
            }
        }
    }
    ProviderNativeBlock {
        provider: "anthropic".into(),
        block_type: t.to_string(),
        data,
        cache_control,
    }
}

fn image_from(parsed: &Value) -> ImageBlock {
    ImageBlock {
        media_type: string(parsed["source"].get("media_type"))
            .unwrap_or_default()
            .to_string(),
        data: string(parsed["source"].get("data"))
            .unwrap_or_default()
            .to_string(),
        cache_control: ir_cache_control(parsed.get("cache_control")),
    }
}

enum Portable {
    File(FileBlock),
    Text(String),
}

/// `portableDocument`.
fn portable_document(doc: &Value) -> Option<Portable> {
    if present(doc.get("citations")).is_some()
        || present(doc.get("context")).is_some()
        || present(doc.get("cache_control")).is_some()
    {
        return None;
    }
    let source = doc.get("source")?;
    let title = string(doc.get("title"));
    let data = string(source.get("data"));
    match (string(source.get("type")), data) {
        (Some("base64"), Some(data)) => Some(Portable::File(FileBlock {
            media_type: "application/pdf".into(),
            data: data.to_string(),
            filename: title.map(str::to_string),
        })),
        (Some("text"), Some(data)) => Some(Portable::Text(match title {
            None => data.to_string(),
            Some(t) => format!("{t}\n{data}"),
        })),
        _ => None,
    }
}

/// `readToolResult`.
fn read_tool_result(content: Option<&Value>) -> ToolResultBlock {
    let mut out = ToolResultBlock {
        tool_use_id: String::new(),
        content: String::new(),
        images: None,
        files: None,
        native: None,
        is_error: None,
        cache_control: None,
    };
    let parts = match content {
        Some(Value::String(s)) => {
            out.content = s.clone();
            return out;
        }
        Some(Value::Array(parts)) => parts,
        _ => return out,
    };
    let mut text: Vec<String> = Vec::new();
    let (mut images, mut files, mut native) = (Vec::new(), Vec::new(), Vec::new());
    let image = image_block();
    for part in parts {
        if let Value::String(s) = part {
            text.push(s.clone());
            continue;
        }
        if let Ok(parsed) = zod::parse(&image, part) {
            images.push(image_from(&parsed));
            continue;
        }
        let t = part.as_object().and_then(|o| o.get("type"));
        let t_str = string(t);
        let parsed = match t_str {
            Some(t @ ("document" | "search_result")) => {
                native_schema(t).and_then(|s| zod::parse(&s, part).ok())
            }
            _ => None,
        };
        if let (Some("document"), Some(doc)) = (t_str, &parsed)
            && let Some(portable) = portable_document(doc)
        {
            match portable {
                Portable::Text(s) => text.push(s),
                Portable::File(f) => files.push(f),
            }
            continue;
        }
        if let (Some(t), Some(doc)) = (t_str, &parsed) {
            native.push(native_block(t, doc));
            continue;
        }
        let as_text = match (t_str, part.get("text")) {
            (Some("text"), Some(Value::String(s))) => s.clone(),
            _ => omni_ir::jsjson::to_string(part),
        };
        text.push(as_text);
    }
    out.content = text.join("\n");
    out.images = (!images.is_empty()).then_some(images);
    out.files = (!files.is_empty()).then_some(files);
    out.native = (!native.is_empty()).then_some(native);
    out
}

fn to_ir_block(b: &Value) -> ContentBlock {
    let s = |k: &str| string(b.get(k)).unwrap_or_default().to_string();
    match string(b.get("type")) {
        Some("text") => ContentBlock::Text(TextBlock {
            text: s("text"),
            cache_control: ir_cache_control(b.get("cache_control")),
            citations: b
                .get("citations")
                .and_then(Value::as_array)
                .map(|c| c.iter().map(omni_ir::deep::clone).collect()),
        }),
        Some("image") => ContentBlock::Image(image_from(b)),
        Some("thinking") => ContentBlock::Thinking(ThinkingBlock {
            text: s("thinking"),
            signature: string(b.get("signature")).map(str::to_string),
        }),
        Some("tool_use") => ContentBlock::ToolUse(ToolUseBlock {
            id: s("id"),
            name: s("name"),
            input: b.get("input").map_or(Value::Null, omni_ir::deep::clone),
            cache_control: ir_cache_control(b.get("cache_control")),
        }),
        _ => {
            let mut r = read_tool_result(b.get("content"));
            r.tool_use_id = s("tool_use_id");
            r.is_error = Some(b.get("is_error").and_then(Value::as_bool).unwrap_or(false));
            r.cache_control = ir_cache_control(b.get("cache_control"));
            ContentBlock::ToolResult(r)
        }
    }
}

fn read_block(raw: &Value, role: Role, path: &str) -> Result<ContentBlock, GatewayError> {
    if let Some(map) = raw.as_object()
        && let Some(Value::String(t)) = map.get("type")
        && NATIVE_BLOCK_TYPES.contains(&t.as_str())
    {
        let (Some(schema), Some(native)) = (native_schema(t), native_role(t)) else {
            return Err(bad(format!(
                "{path}.type: block type \"{t}\" is not legal in request history"
            )));
        };
        if role != native {
            return Err(bad(format!(
                "{path}: block type \"{t}\" is not legal in {} messages",
                role.as_str()
            )));
        }
        let parsed = zod::parse(&schema, raw).map_err(|issue| {
            let mut segments: Vec<String> = issue.path.iter().map(zod::Seg::as_string).collect();
            if let Kind::UnrecognizedKeys(keys) = &issue.kind {
                segments.push(safe_token(keys.first().map_or("", String::as_str)).to_string());
            }
            let suffix = if segments.is_empty() {
                String::new()
            } else {
                format!(".{}", segments.join("."))
            };
            bad(format!("{path}{suffix}: {}", zod_detail(&issue)))
        })?;
        return Ok(ContentBlock::ProviderNative(native_block(t, &parsed)));
    }
    static BLOCK: std::sync::OnceLock<Z> = std::sync::OnceLock::new();
    match zod::parse(BLOCK.get_or_init(block), raw) {
        Ok(parsed) => Ok(to_ir_block(&parsed)),
        Err(issue) => {
            let union = matches!(issue.kind, Kind::InvalidUnion | Kind::NoDiscriminator(_));
            let last_is_type = matches!(issue.path.last(), Some(zod::Seg::Key(k)) if k == "type");
            if (union || last_is_type)
                && let Some(t) = raw.as_object().and_then(|o| string(o.get("type")))
            {
                return Err(bad(format!(
                    "{path}.type: unrecognized block type \"{}\"",
                    safe_token(t)
                )));
            }
            let p = super::raw_path(&issue);
            let suffix = if p.is_empty() { p } else { format!(".{p}") };
            Err(bad(format!("{path}{suffix}: {}", zod_detail(&issue))))
        }
    }
}

fn read_effort(body: &Map<String, Value>) -> Option<ReasoningEffort> {
    let effort = body
        .get("output_config")?
        .as_object()?
        .get("effort")?
        .as_str()?;
    effort_of(effort)
}

pub(crate) fn effort_of(s: &str) -> Option<ReasoningEffort> {
    EFFORTS
        .iter()
        .position(|e| *e == s)
        .map(|i| ReasoningEffort::ALL[i])
}

/// `readBetas`: the `anthropic-beta` list, trimmed and de-duplicated.
fn read_betas(headers: &Headers) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(raw) = headers.get("anthropic-beta") {
        for name in raw.split(',') {
            let name = omni_ir::js::trim(name);
            if !name.is_empty() && !out.iter().any(|n| n == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

fn role_of(s: Option<&str>) -> Role {
    match s {
        Some("assistant") => Role::Assistant,
        Some("system") => Role::System,
        _ => Role::User,
    }
}

/// `parseAnthropicRequest`.
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

    let parsed_messages: &[Value] = parsed["messages"].as_array().map_or(&[], Vec::as_slice);
    let mut messages = Vec::with_capacity(parsed_messages.len());
    for (i, m) in parsed_messages.iter().enumerate() {
        let role = role_of(string(m.get("role")));
        let content = match m.get("content") {
            Some(Value::String(s)) => vec![ContentBlock::Text(TextBlock {
                text: s.clone(),
                cache_control: None,
                citations: None,
            })],
            Some(Value::Array(blocks)) => blocks
                .iter()
                .enumerate()
                .map(|(j, b)| read_block(b, role, &format!("messages.{i}.content.{j}")))
                .collect::<Result<_, _>>()?,
            _ => Vec::new(),
        };
        if role == Role::System {
            let next = parsed_messages.get(i + 1);
            if i == 0 || next.is_some_and(|n| string(n.get("role")) != Some("assistant")) {
                return Err(bad(format!(
                    "messages.{i}: system message must follow another message and be last or precede an assistant message"
                )));
            }
        }
        messages.push(Message { role, content });
    }

    let system = match parsed.get("system") {
        Some(Value::String(s)) => Some(vec![ContentBlock::Text(TextBlock {
            text: s.clone(),
            cache_control: None,
            citations: None,
        })]),
        Some(Value::Array(blocks)) => Some(
            blocks
                .iter()
                .map(|b| {
                    ContentBlock::Text(TextBlock {
                        text: string(b.get("text")).unwrap_or_default().to_string(),
                        cache_control: ir_cache_control(b.get("cache_control")),
                        citations: None,
                    })
                })
                .collect(),
        ),
        _ => None,
    };

    let (model, betas) = normalize_client_model(
        string(parsed.get("model")).unwrap_or_default(),
        &read_betas(headers),
    );
    let stream = parsed
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut request = empty_request(model, messages, stream);
    request.system = system;
    request.max_tokens = number(parsed.get("max_tokens"));
    request.temperature = number(parsed.get("temperature"));
    request.stop_sequences = parsed
        .get("stop_sequences")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|s| s.as_str().unwrap_or_default().to_string())
                .collect()
        });
    if let Some(Value::Array(tools)) = parsed.get("tools") {
        request.tools = Some(parse_tools(tools, &mcp_server_names(raw))?);
    }
    if let Some(tc) = parsed.get("tool_choice") {
        request.tool_choice = Some(match string(tc.get("type")) {
            Some("tool") => ToolChoice::Tool {
                name: string(tc.get("name")).unwrap_or_default().to_string(),
            },
            Some("any") => ToolChoice::Any,
            Some("none") => ToolChoice::None,
            _ => ToolChoice::Auto,
        });
    }
    let effort = read_effort(raw);
    if let Some(thinking) = parsed.get("thinking") {
        request.reasoning = Some(match string(thinking.get("type")) {
            Some("adaptive") => ReasoningConfig::Adaptive {
                effort,
                display: match string(thinking.get("display")) {
                    Some("summarized") => Some(ReasoningDisplay::Summarized),
                    Some("omitted") => Some(ReasoningDisplay::Omitted),
                    Some("updates") => Some(ReasoningDisplay::Updates),
                    _ => None,
                },
            },
            Some("enabled") => ReasoningConfig::Budget {
                budget_tokens: number(thinking.get("budget_tokens")).unwrap_or_default(),
            },
            Some("disabled") => ReasoningConfig::Off,
            _ => ReasoningConfig::BetweenTools,
        });
    } else if effort.is_some() {
        request.reasoning = Some(ReasoningConfig::Adaptive {
            effort,
            display: None,
        });
    }

    let user_id = parsed
        .get("metadata")
        .and_then(|m| m.get("user_id"))
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty());
    request.conversation_id = match user_id {
        Some(u) => Some(u.to_string()),
        None => read_conversation_header(headers),
    };

    let mut extras = extra_fields(raw, KNOWN).unwrap_or_default();
    if parsed.get("thinking").is_some()
        && let Some(Value::Object(raw_thinking)) = raw.get("thinking")
        && let Some(t) = extra_fields(raw_thinking, &["type", "display", "budget_tokens"])
    {
        omni_ir::deep::insert(&mut extras, "thinking".into(), Value::Object(t));
    }
    let safeguards = matches!(extras.get("safeguards"), Some(Value::Array(a)) if !a.is_empty());
    if safeguards && let Some(system) = raw.get("system") {
        omni_ir::deep::insert(&mut extras, "system".into(), omni_ir::deep::clone(system));
    }
    if !extras.is_empty() {
        let mut vendor = Map::new();
        omni_ir::deep::insert(&mut vendor, "anthropic".into(), Value::Object(extras));
        request.vendor = Some(vendor);
    }

    if !betas.is_empty() {
        request.betas = Some(betas);
    }

    let mut protocol = Map::new();
    for (name, value) in headers.sorted() {
        if name.starts_with("anthropic-") {
            omni_ir::deep::insert(
                &mut protocol,
                name.to_string(),
                Value::String(value.to_string()),
            );
        }
    }
    if !protocol.is_empty() {
        let mut ph = Map::new();
        omni_ir::deep::insert(&mut ph, "anthropic".into(), Value::Object(protocol));
        request.provider_headers = Some(ph);
    }

    Ok(validate_request(request, opts.new_tool_use_id))
}
