//! Anthropic wire content encoding. Request assembly is kept separate.
use super::cloak::ToolCloak;
use crate::tool_result_files::{split_files, with_file_text};
use omni_ir::{
    error::{ErrorCode, GatewayError},
    request::ContentBlock,
};
use serde_json::{Value, json};

pub const OAUTH_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

/// Opt-in placement over successively larger prefixes. Explicit markers win.
pub(crate) fn add_auto_cache(
    body: &mut Value,
    req: &omni_ir::request::ChatRequest,
    notes: &mut Vec<String>,
) {
    use omni_ir::tokens::{estimate_cached_input_tokens, estimate_input_tokens};
    if estimate_cached_input_tokens(req) != 0.0
        || req
            .vendor_bag("anthropic")
            .is_some_and(|v| v.contains_key("cache_control"))
    {
        return;
    }
    // Reuse the canonical estimator rather than duplicating its token rules.
    let mut prefix = omni_ir::request::ChatRequest {
        model: String::new(),
        system: None,
        messages: Vec::new(),
        tools: req.tools.clone(),
        tool_choice: None,
        max_tokens: None,
        temperature: None,
        stop_sequences: None,
        stream: false,
        reasoning: None,
        vendor: None,
        provider_headers: None,
        betas: None,
        conversation_id: None,
    };
    let tools = estimate_input_tokens(&prefix);
    prefix.system = req.system.clone();
    let system = estimate_input_tokens(&prefix);
    let total = estimate_input_tokens(req);
    let mut marked = 0.0;
    let mut stable = false;
    for (key, prefix) in [("tools", tools), ("system", system)] {
        if prefix - marked >= 1024.0
            && let Some(last) = body
                .get_mut(key)
                .and_then(Value::as_array_mut)
                .and_then(|v| v.last_mut())
        {
            omni_ir::deep::replace(&mut last["cache_control"], json!({"type":"ephemeral"}));
            marked = prefix;
            stable = true;
        }
    }
    if stable
        && !notes
            .iter()
            .any(|n| n == "anthropic:cache-breakpoint-added")
    {
        notes.push("anthropic:cache-breakpoint-added".into());
    }
    if total - marked >= 1024.0
        && let Some(last) = body
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .and_then(|v| last_cacheable(v))
    {
        omni_ir::deep::replace(&mut last["cache_control"], json!({"type":"ephemeral"}));
        if !notes
            .iter()
            .any(|n| n == "anthropic:history-cache-breakpoint-added")
        {
            notes.push("anthropic:history-cache-breakpoint-added".into());
        }
    }
}

/// Model lookup normalization used by the frozen Anthropic catalog.
fn model_id(model: &str) -> &str {
    let mut id = omni_ir::js::trim(model);
    if id.to_ascii_lowercase().ends_with("[1m]") {
        id = omni_ir::js::trim(&id[..id.len() - 4]);
    }
    if id.len() >= 9
        && id.as_bytes()[id.len() - 9] == b'-'
        && id.as_bytes()[id.len() - 8..].iter().all(u8::is_ascii_digit)
    {
        id = &id[..id.len() - 9];
    }
    id
}

fn last_cacheable(messages: &mut [Value]) -> Option<&mut Value> {
    for message in messages.iter_mut().rev() {
        if let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) {
            for block in blocks.iter_mut().rev() {
                if matches!(
                    block["type"].as_str(),
                    Some("text" | "image" | "tool_use" | "tool_result" | "document")
                ) {
                    return Some(block);
                }
            }
        }
    }
    None
}

/// Request assembly including vendor/structured-output merge. The option-bearing
/// entry point controls automatic caching and system preservation.
pub fn to_wire(
    req: &omni_ir::request::ChatRequest,
    model: &str,
    oauth: bool,
    cloak: &ToolCloak,
    saved_max: Option<f64>,
) -> Result<(Value, Vec<String>), GatewayError> {
    to_wire_with_options(req, model, oauth, cloak, saved_max, false, false)
}

pub fn to_wire_with_options(
    req: &omni_ir::request::ChatRequest,
    model: &str,
    oauth: bool,
    cloak: &ToolCloak,
    saved_max: Option<f64>,
    preserve_system: bool,
    auto_cache: bool,
) -> Result<(Value, Vec<String>), GatewayError> {
    use omni_ir::request::{ReasoningConfig, Role, ToolChoice, ToolDef};
    let mut notes = Vec::new();
    let mut note = |s: String| {
        if !notes.contains(&s) {
            notes.push(s);
        }
    };
    let mut system = Vec::new();
    for b in req.system.iter().flatten() {
        if let ContentBlock::Text(t) = b {
            let mut v = json!({});
            if preserve_system
                && let Some(original) = req
                    .vendor_bag("anthropic")
                    .and_then(|v| v.get("system"))
                    .and_then(Value::as_array)
                    .and_then(|v| v.get(system.len()))
                    .and_then(Value::as_object)
            {
                for (k, value) in original {
                    if !["type", "text", "cache_control"].contains(&k.as_str()) {
                        omni_ir::deep::replace(&mut v[k], value.clone());
                    }
                }
            }
            omni_ir::deep::replace(&mut v["type"], json!("text"));
            omni_ir::deep::replace(&mut v["text"], json!(t.text));
            if let Some(c) = &t.cache_control {
                omni_ir::deep::replace(&mut v["cache_control"], json!(c));
            }
            system.push(v);
        } else {
            note(format!("anthropic:system-{}-dropped", b.type_name()));
        }
    }
    if oauth
        && !preserve_system
        && system.first().and_then(|v| v["text"].as_str()) != Some(OAUTH_IDENTITY)
    {
        system.insert(0, json!({"type":"text","text":OAUTH_IDENTITY}));
        note("anthropic:oauth-system-prefix".into());
    }
    if !cloak.to_wire.is_empty() {
        note("anthropic:tool-names-cloaked".into());
    }
    let marked = req
        .messages
        .iter()
        .filter(|m| m.role == Role::System)
        .flat_map(|m| &m.content)
        .filter(|b| b.cache_control().is_some())
        .count();
    let retarget = req
        .messages
        .last()
        .filter(|m| m.role == Role::System)
        .and_then(|m| m.content.iter().rev().find_map(ContentBlock::cache_control));
    if marked > usize::from(retarget.is_some()) {
        note("anthropic:system-turn-cache-control-dropped".into());
    }
    for b in req.messages.iter().flat_map(|m| &m.content) {
        if let ContentBlock::ToolResult(b) = b {
            let files = split_files(b.files.as_deref().unwrap_or_default(), |t| {
                t == "application/pdf"
            });
            if !files.text.is_empty() {
                note("anthropic:tool-result-files-inlined".into());
            }
            if files.dropped {
                note("anthropic:files-dropped".into());
            }
        }
    }
    let mut messages = Vec::new();
    for m in &req.messages {
        let content = if m.role == Role::System
            && m.content.iter().all(|b| matches!(b, ContentBlock::Text(_)))
        {
            Value::String(
                m.content
                    .iter()
                    .filter_map(|b| {
                        if let ContentBlock::Text(t) = b {
                            Some(t.text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        } else {
            let mut blocks = Vec::new();
            for b in &m.content {
                if m.role != Role::System
                    && matches!(b,ContentBlock::Thinking(t) if t.signature.as_deref().is_none_or(str::is_empty))
                {
                    note("anthropic:unsigned-thinking-dropped".into());
                    continue;
                }
                blocks.push(encode_block(b, cloak)?);
            }
            if blocks.is_empty() && m.role != Role::System {
                continue;
            }
            Value::Array(blocks)
        };
        let mut message = json!({"role":m.role});
        omni_ir::deep::replace(&mut message["content"], content);
        messages.push(message);
    }
    let id = model_id(model);
    let ceiling = match id {
        "claude-haiku-4-5" => Some(64000.0),
        "claude-fable-5-1" | "claude-opus-5-5" | "claude-fable-5" | "claude-opus-5"
        | "claude-sonnet-5-5" | "claude-sonnet-5" | "claude-haiku-5-5" => Some(128000.0),
        _ => None,
    };
    let max = req.max_tokens.unwrap_or(match (saved_max, ceiling) {
        (Some(s), Some(c)) => s.min(c),
        (Some(s), None) => s,
        (None, Some(c)) => c,
        _ => 4096.0,
    });
    if let Some(cache) = retarget {
        if let Some(blocks) = messages
            .last_mut()
            .and_then(|m| m["content"].as_array_mut())
        {
            for b in blocks {
                if let Some(o) = b.as_object_mut() {
                    o.shift_remove("cache_control");
                }
            }
        }
        if !req
            .vendor_bag("anthropic")
            .is_some_and(|v| v.contains_key("cache_control"))
        {
            let len = messages.len().saturating_sub(1);
            if let Some(b) = last_cacheable(&mut messages[..len]) {
                if b.get("cache_control").is_none() {
                    omni_ir::deep::replace(&mut b["cache_control"], json!(cache));
                    note("anthropic:system-turn-cache-control-retargeted".into());
                }
            } else {
                note("anthropic:system-turn-cache-control-dropped".into());
            }
        }
    }
    let mut body = json!({"model":model,"messages":null,"max_tokens":max,"stream":req.stream});
    omni_ir::deep::replace(&mut body["messages"], Value::Array(messages));
    if !system.is_empty() {
        omni_ir::deep::replace(&mut body["system"], Value::Array(system));
    }
    if let Some(t) = req.temperature {
        omni_ir::deep::replace(&mut body["temperature"], json!(t));
    }
    if let Some(s) = &req.stop_sequences {
        omni_ir::deep::replace(&mut body["stop_sequences"], json!(s));
    }
    if let Some(tools) = &req.tools {
        let mut out = Vec::new();
        for t in tools {
            let (mut v, cache) = match t {
                ToolDef::Portable(t) => {
                    let mut v = json!({"name":cloak.name(&t.name)});
                    if let Some(d) = &t.description {
                        omni_ir::deep::replace(&mut v["description"], json!(d));
                    }
                    omni_ir::deep::replace(
                        &mut v["input_schema"],
                        omni_ir::deep::clone(&t.input_schema),
                    );
                    if let Some(o) = &t.options {
                        v.as_object_mut()
                            .expect("object")
                            .extend(omni_ir::deep::clone_map(o));
                    }
                    (v, &t.cache_control)
                }
                ToolDef::Provider(t) => {
                    if t.provider != "anthropic" {
                        return Err(GatewayError::new(
                            ErrorCode::Internal,
                            format!(
                                "anthropic adapter received a {} provider-defined tool",
                                t.provider
                            ),
                        ));
                    }
                    let mut v = json!({"type":t.tool_type});
                    if !t.name.is_empty() {
                        omni_ir::deep::replace(&mut v["name"], json!(t.name));
                    }
                    v.as_object_mut()
                        .expect("object")
                        .extend(omni_ir::deep::clone_map(&t.wire));
                    (v, &t.cache_control)
                }
            };
            if let Some(c) = cache {
                omni_ir::deep::replace(&mut v["cache_control"], json!(c));
            }
            out.push(v);
        }
        omni_ir::deep::replace(&mut body["tools"], Value::Array(out));
    }
    if let Some(c) = &req.tool_choice {
        omni_ir::deep::replace(
            &mut body["tool_choice"],
            match c {
                ToolChoice::Tool { name } => json!({"type":"tool","name":cloak.name(name)}),
                _ => json!(c),
            },
        );
    }
    if auto_cache {
        add_auto_cache(&mut body, req, &mut notes);
    }
    let mut note = |s: String| {
        if !notes.contains(&s) {
            notes.push(s);
        }
    };
    if let Some(r) = &req.reasoning {
        omni_ir::deep::replace(&mut body["thinking"], Value::Null);
        let thinking = match r {
            ReasoningConfig::BetweenTools => json!({"type":"between_tools"}),
            ReasoningConfig::Off => json!({"type":"disabled"}),
            ReasoningConfig::Budget { budget_tokens } => {
                json!({"type":"enabled","budget_tokens":budget_tokens})
            }
            ReasoningConfig::Adaptive { effort, display } => {
                if id == "claude-haiku-4-5" {
                    note("anthropic:adaptive-thinking-unsupported".into());
                    json!({"type":"disabled"})
                } else {
                    let mut v = json!({"type":"adaptive"});
                    if let Some(d) = display {
                        omni_ir::deep::replace(&mut v["display"], json!(d));
                    }
                    if let Some(e) = effort {
                        omni_ir::deep::replace(&mut body["output_config"], json!({"effort":e}));
                    }
                    v
                }
            }
        };
        omni_ir::deep::replace(&mut body["thinking"], thinking);
    }
    super::vendor::merge(
        &mut body,
        req,
        id == "claude-haiku-4-5",
        preserve_system,
        &mut notes,
    );
    Ok((body, notes))
}

pub fn encode_block(block: &ContentBlock, cloak: &ToolCloak) -> Result<Value, GatewayError> {
    let mut value = match block {
        ContentBlock::Text(b) => {
            let mut v = json!({"type":"text","text":b.text});
            if let Some(c) = &b.citations {
                omni_ir::deep::replace(&mut v["citations"], json!(c));
            }
            v
        }
        ContentBlock::Image(b) => {
            json!({"type":"image","source":{"type":"base64","media_type":b.media_type,"data":b.data}})
        }
        ContentBlock::Thinking(b) => {
            let mut v = json!({"type":"thinking","thinking":b.text});
            if let Some(s) = &b.signature {
                omni_ir::deep::replace(&mut v["signature"], json!(s));
            }
            v
        }
        ContentBlock::ToolUse(b) => {
            let mut v = json!({"type":"tool_use","id":b.id,"name":cloak.name(&b.name)});
            omni_ir::deep::replace(&mut v["input"], omni_ir::deep::clone(&b.input));
            v
        }
        ContentBlock::ProviderNative(b) => {
            if b.provider != "anthropic" {
                return Err(GatewayError::new(
                    ErrorCode::Internal,
                    format!(
                        "anthropic adapter received a {} provider-native block",
                        b.provider
                    ),
                ));
            }
            let mut v = Value::Object(omni_ir::deep::clone_map(&b.data));
            omni_ir::deep::replace(&mut v["type"], json!(b.block_type));
            v
        }
        ContentBlock::ToolResult(b) => {
            let files = split_files(b.files.as_deref().unwrap_or_default(), |t| {
                t == "application/pdf"
            });
            let text = with_file_text(&b.content, &files.text);
            let mut parts = Vec::new();
            for image in b.images.iter().flatten() {
                parts.push(encode_block(&ContentBlock::Image(image.clone()), cloak)?);
            }
            for file in files.carried {
                let mut doc = json!({"type":"document","source":{"type":"base64","media_type":file.media_type,"data":file.data}});
                if let Some(title) = &file.filename {
                    omni_ir::deep::replace(&mut doc["title"], json!(title));
                }
                parts.push(doc);
            }
            for native in b.native.iter().flatten() {
                parts.push(encode_block(
                    &ContentBlock::ProviderNative(native.clone()),
                    cloak,
                )?);
            }
            let content = if parts.is_empty() {
                Value::String(text)
            } else {
                if !text.is_empty() {
                    parts.insert(0, json!({"type":"text","text":text}));
                }
                Value::Array(parts)
            };
            let mut v = json!({"type":"tool_result","tool_use_id":b.tool_use_id,"content":content});
            if let Some(error) = b.is_error {
                omni_ir::deep::replace(&mut v["is_error"], json!(error));
            }
            v
        }
    };
    if let Some(cache) = block.cache_control() {
        omni_ir::deep::replace(&mut value["cache_control"], json!(cache));
    }
    Ok(value)
}
