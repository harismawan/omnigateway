//! Custom's wire encoders, one per protocol (`packages/providers/src/custom/wire.ts`).
//!
//! Bodies are built as insertion-ordered JSON maps that mirror the TS object
//! literal assignments step for step. Order is everything here: the body is
//! serialized with `omni_ir::jsjson`, and `JSON.stringify` writes keys in
//! insertion order (array-index keys first). `Object.assign` keeps an existing
//! key's position and appends new ones, which is what `Map::insert` does.

use omni_ir::js::object_assign;
use omni_ir::jsjson;
use omni_ir::request::{
    CONTEXT_1M_BETA, ChatRequest, ContentBlock, ReasoningConfig, ReasoningDisplay, Role,
    ToolChoice, ToolDef,
};
use serde_json::{Map, Value, json};

use crate::response_format::{
    ResponseFormatRead, is_record, move_to_responses_text, read_response_format,
};
use crate::system::system_text;
use crate::tool_result_files::{responses_files, split_files, with_file_text};

/// An encoded body and what it could not express.
#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub body: Map<String, Value>,
    pub degradations: Vec<String>,
}

/// Records each degradation once, in first-seen order.
#[derive(Default)]
struct Notes(Vec<String>);

impl Notes {
    fn note(&mut self, d: impl Into<String>) {
        let d = d.into();
        if !self.0.contains(&d) {
            self.0.push(d);
        }
    }
}

fn chat_tool_choice(c: &ToolChoice) -> Value {
    match c {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::Any => json!("required"),
        ToolChoice::None => json!("none"),
        ToolChoice::Tool { name } => json!({"type": "function", "function": {"name": name}}),
    }
}

fn responses_tool_choice(c: &ToolChoice) -> Value {
    match c {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::Any => json!("required"),
        ToolChoice::None => json!("none"),
        ToolChoice::Tool { name } => json!({"type": "function", "name": name}),
    }
}

/// `customEffort`: verbatim, `medium` when adaptive names none.
fn custom_effort(reasoning: Option<&ReasoningConfig>) -> Option<&'static str> {
    match reasoning {
        Some(ReasoningConfig::Adaptive { effort, .. }) => {
            Some(effort.map_or("medium", |e| e.as_str()))
        }
        _ => None,
    }
}

/// `JSON.stringify(input)` for a tool call's arguments.
fn arguments(input: &Value) -> String {
    jsjson::to_string(input)
}

fn num(v: f64) -> Value {
    omni_ir::stream::number(v)
}

/// `{ name, description, parameters }`, with `description` omitted when the
/// tool has none (`JSON.stringify` drops `undefined`).
fn function_fields(
    out: &mut Map<String, Value>,
    name: &str,
    description: Option<&String>,
    schema: &Value,
) {
    out.insert("name".into(), json!(name));
    if let Some(d) = description {
        out.insert("description".into(), json!(d));
    }
    out.insert("parameters".into(), omni_ir::deep::clone(schema));
}

fn note_betas(req: &ChatRequest, notes: &mut Notes) {
    if req
        .betas
        .as_ref()
        .is_some_and(|b| b.iter().any(|x| x == CONTEXT_1M_BETA))
    {
        notes.note("custom:context-1m-dropped");
    }
}

/// `toCustomChatWire`.
pub fn to_custom_chat_wire(req: &ChatRequest, model: &str) -> Encoded {
    let mut notes = Notes::default();
    note_betas(req, &mut notes);

    let mut messages: Vec<Value> = Vec::new();
    let system = system_text(req.system.as_deref(), "custom", &mut |d| notes.note(d));
    if let Some(system) = system.filter(|s| !s.is_empty()) {
        messages.push(json!({"role": "system", "content": system}));
    }

    for message in &req.messages {
        let mut text: Vec<&str> = Vec::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        for block in &message.content {
            match block {
                ContentBlock::Text(t) => text.push(&t.text),
                ContentBlock::Image(_) => notes.note("custom:images-dropped"),
                ContentBlock::Thinking(_) => notes.note("custom:thinking-dropped"),
                ContentBlock::ToolUse(u) => tool_calls.push(json!({
                    "id": u.id,
                    "type": "function",
                    "function": {"name": u.name, "arguments": arguments(&u.input)},
                })),
                ContentBlock::ToolResult(r) => {
                    if r.native.is_some() {
                        notes.note("custom:anthropic-native-block-dropped");
                    }
                    let files = split_files(r.files.as_deref().unwrap_or_default(), |_| false);
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": r.tool_use_id,
                        "content": with_file_text(&r.content, &files.text),
                    }));
                    if r.images.is_some() {
                        notes.note("custom:images-dropped");
                    }
                    if !files.text.is_empty() {
                        notes.note("custom:tool-result-files-inlined");
                    }
                    if files.dropped {
                        notes.note("custom:files-dropped");
                    }
                }
                ContentBlock::ProviderNative(_) => {
                    notes.note("custom:anthropic-native-block-dropped");
                }
            }
        }
        let role = message.role.as_str();
        if !tool_calls.is_empty() {
            let content = if text.is_empty() {
                Value::Null
            } else {
                json!(text.join("\n"))
            };
            messages.push(json!({"role": role, "content": content, "tool_calls": tool_calls}));
        } else if !text.is_empty() {
            messages.push(json!({"role": role, "content": text.join("\n")}));
        }
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), json!(req.stream));
    body.insert("stream_options".into(), json!({"include_usage": true}));
    if let Some(v) = req.max_tokens {
        body.insert("max_tokens".into(), num(v));
    }
    if let Some(v) = req.temperature {
        body.insert("temperature".into(), num(v));
    }
    if let Some(stop) = &req.stop_sequences {
        body.insert("stop".into(), json!(stop));
    }
    if let Some(tools) = &req.tools {
        let portable: Vec<Value> = tools
            .iter()
            .filter_map(|t| match t {
                ToolDef::Portable(t) => {
                    let mut function = Map::new();
                    function_fields(
                        &mut function,
                        &t.name,
                        t.description.as_ref(),
                        &t.input_schema,
                    );
                    let mut tool = Map::new();
                    tool.insert("type".into(), json!("function"));
                    tool.insert("function".into(), Value::Object(function));
                    Some(Value::Object(tool))
                }
                ToolDef::Provider(_) => None,
            })
            .collect();
        if portable.len() != tools.len() {
            notes.note("custom:anthropic-tool-dropped");
        }
        body.insert("tools".into(), Value::Array(portable));
    }
    if let Some(c) = &req.tool_choice {
        body.insert("tool_choice".into(), chat_tool_choice(c));
    }

    if matches!(req.reasoning, Some(ReasoningConfig::BetweenTools)) {
        notes.note("custom:reasoning-between-tools-as-off");
    }
    if let Some(effort) = custom_effort(req.reasoning.as_ref()) {
        body.insert("reasoning_effort".into(), json!(effort));
    } else if matches!(req.reasoning, Some(ReasoningConfig::Budget { .. })) {
        notes.note("custom:reasoning-budget-dropped");
    }

    // Last, so an operator's passthrough can override anything above.
    object_assign(&mut body, vendor_openai(req));

    // `text` is the Responses spelling; this endpoint does not define it.
    let dropped_text = body.shift_remove("text");

    match read_response_format(req) {
        ResponseFormatRead::Readable(format) => {
            if !body.contains_key("response_format") {
                let mut spec = Map::new();
                spec.insert("name".into(), json!(format.name));
                spec.insert("schema".into(), Value::Object(format.schema));
                spec.insert("strict".into(), Value::Bool(true));
                let mut format = Map::new();
                format.insert("type".into(), json!("json_schema"));
                format.insert("json_schema".into(), Value::Object(spec));
                body.insert("response_format".into(), Value::Object(format));
                notes.note("custom:response-format-translated");
            }
        }
        _ if is_record(dropped_text.as_ref())
            && dropped_text
                .as_ref()
                .and_then(|t| t.get("format"))
                .is_some() =>
        {
            notes.note("custom:response-format-dropped");
        }
        ResponseFormatRead::TooDeep => {
            body.shift_remove("response_format");
            notes.note("custom:response-schema-too-deep");
        }
        _ => {}
    }

    Encoded {
        body,
        degradations: notes.0,
    }
}

/// `req.vendor?.openai ?? {}`.
fn vendor_openai(req: &ChatRequest) -> Option<&Value> {
    req.vendor_value("openai").filter(|v| !v.is_null())
}

fn image_url(media_type: &str, data: &str) -> String {
    format!("data:{media_type};base64,{data}")
}

/// `toCustomResponsesWire`.
pub fn to_custom_responses_wire(req: &ChatRequest, model: &str) -> Encoded {
    let mut notes = Notes::default();
    let mut input: Vec<Value> = Vec::new();
    note_betas(req, &mut notes);

    for message in &req.messages {
        let mut parts: Vec<Value> = Vec::new();
        // A mid-conversation operator turn goes as `developer`, in place.
        let as_developer = message.role == Role::System;
        if as_developer {
            notes.note("custom:system-turn-as-developer");
        }
        let role = if as_developer {
            "developer"
        } else {
            message.role.as_str()
        };
        let flush = |parts: &mut Vec<Value>, input: &mut Vec<Value>| {
            if !parts.is_empty() {
                input.push(
                    json!({"type": "message", "role": role, "content": std::mem::take(parts)}),
                );
            }
        };

        for block in &message.content {
            match block {
                ContentBlock::Text(t) => parts.push(json!({
                    "type": if role == "assistant" { "output_text" } else { "input_text" },
                    "text": t.text,
                })),
                ContentBlock::Image(i) => parts.push(json!({
                    "type": "input_image",
                    "image_url": image_url(&i.media_type, &i.data),
                })),
                ContentBlock::Thinking(_) => notes.note("custom:thinking-dropped"),
                ContentBlock::ToolUse(u) => {
                    flush(&mut parts, &mut input);
                    input.push(json!({
                        "type": "function_call",
                        "call_id": u.id,
                        "name": u.name,
                        "arguments": arguments(&u.input),
                    }));
                }
                ContentBlock::ToolResult(r) => {
                    if r.native.is_some() {
                        notes.note("custom:anthropic-native-block-dropped");
                    }
                    flush(&mut parts, &mut input);
                    let files = responses_files(r.files.as_deref().unwrap_or_default());
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": r.tool_use_id,
                        "output": with_file_text(&r.content, &files.text),
                    }));
                    if let Some(images) = &r.images {
                        notes.note("custom:tool-result-images-moved");
                        for image in images {
                            parts.push(json!({
                                "type": "input_image",
                                "image_url": image_url(&image.media_type, &image.data),
                            }));
                        }
                    }
                    if !files.parts.is_empty() {
                        notes.note("custom:tool-result-files-moved");
                        parts.extend(files.parts);
                    }
                    if !files.text.is_empty() {
                        notes.note("custom:tool-result-files-inlined");
                    }
                    if files.dropped {
                        notes.note("custom:files-dropped");
                    }
                }
                ContentBlock::ProviderNative(_) => {
                    notes.note("custom:anthropic-native-block-dropped");
                }
            }
        }
        flush(&mut parts, &mut input);
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("input".into(), Value::Array(input));
    body.insert("stream".into(), json!(req.stream));
    body.insert("store".into(), json!(false));

    let instructions = system_text(req.system.as_deref(), "custom", &mut |d| notes.note(d));
    if let Some(instructions) = instructions.filter(|s| !s.is_empty()) {
        body.insert("instructions".into(), json!(instructions));
    }
    if let Some(v) = req.max_tokens {
        body.insert("max_output_tokens".into(), num(v));
    }
    if let Some(v) = req.temperature {
        body.insert("temperature".into(), num(v));
    }
    if let Some(tools) = &req.tools {
        let portable: Vec<Value> = tools
            .iter()
            .filter_map(|t| match t {
                ToolDef::Portable(t) => {
                    let mut tool = Map::new();
                    tool.insert("type".into(), json!("function"));
                    function_fields(&mut tool, &t.name, t.description.as_ref(), &t.input_schema);
                    Some(Value::Object(tool))
                }
                ToolDef::Provider(_) => None,
            })
            .collect();
        if portable.len() != tools.len() {
            notes.note("custom:anthropic-tool-dropped");
        }
        body.insert("tools".into(), Value::Array(portable));
    }
    if let Some(c) = &req.tool_choice {
        body.insert("tool_choice".into(), responses_tool_choice(c));
    }

    if matches!(req.reasoning, Some(ReasoningConfig::BetweenTools)) {
        notes.note("custom:reasoning-between-tools-as-off");
    }
    if let Some(effort) = custom_effort(req.reasoning.as_ref()) {
        let quiet = matches!(
            req.reasoning,
            Some(ReasoningConfig::Adaptive {
                display: Some(ReasoningDisplay::Omitted | ReasoningDisplay::Updates),
                ..
            })
        );
        let reasoning = if quiet {
            json!({"effort": effort})
        } else {
            json!({"effort": effort, "summary": "auto"})
        };
        body.insert("reasoning".into(), reasoning);
    } else if matches!(req.reasoning, Some(ReasoningConfig::Budget { .. })) {
        notes.note("custom:reasoning-budget-dropped");
    }

    object_assign(&mut body, vendor_openai(req));

    if let Some(moved) = move_to_responses_text(req, &mut body, "custom") {
        notes.note(moved);
    }

    Encoded {
        body,
        degradations: notes.0,
    }
}
