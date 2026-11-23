//! `toKiloWire`: Kilo's Chat Completions body plus OpenRouter's `reasoning`.
//!
//! Forked from the Kimi encoder rather than shared with it: Kilo proxies a
//! catalog of several hundred third-party models and carries OpenRouter's own
//! extensions, so a shared encoder would collect a branch per vendor quirk.
//! Images and PDF file parts are expressible here; cache breakpoints and
//! thinking blocks are not, and their loss is recorded.
//!
//! Bodies are built as insertion-ordered JSON maps, one object-literal
//! assignment step at a time; `omni_ir::jsjson` serializes them with
//! `JSON.stringify` key-order rules.
use omni_ir::js::object_assign;
use omni_ir::jsjson;
use omni_ir::request::{
    CONTEXT_1M_BETA, ChatRequest, ContentBlock, ReasoningConfig, ToolChoice, ToolDef,
};
use serde_json::{Map, Value, json};

use crate::response_format::{ResponseFormatRead, read_response_format};
use crate::system::system_text;
use crate::tool_result_files::{file_name, split_files, with_file_text};

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

/// One entry of a multipart chat message content array.
enum Part {
    Text(String),
    ImageUrl(String),
    File { filename: String, data: String },
}

impl Part {
    fn value(&self) -> Value {
        match self {
            Self::Text(text) => json!({"type": "text", "text": text}),
            Self::ImageUrl(url) => json!({"type": "image_url", "image_url": {"url": url}}),
            Self::File { filename, data } => {
                json!({"type": "file", "file": {"filename": filename, "file_data": data}})
            }
        }
    }
}

/// `collapse`: a message of nothing but text is a plain string, which is what
/// every client of this API sends and what the upstream echoes back. Only a
/// message carrying an image or file needs the array form.
fn collapse(parts: &[Part]) -> Value {
    if parts.is_empty() {
        return Value::Null;
    }
    let texts: Option<Vec<&str>> = parts
        .iter()
        .map(|p| match p {
            Part::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    if let Some(texts) = texts {
        return json!(texts.join("\n"));
    }
    Value::Array(parts.iter().map(Part::value).collect())
}

fn encode_tool_choice(c: &ToolChoice) -> Value {
    match c {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::Any => json!("required"),
        ToolChoice::None => json!("none"),
        ToolChoice::Tool { name } => json!({"type": "function", "function": {"name": name}}),
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
    omni_ir::deep::insert(out, "name".into(), json!(name));
    if let Some(d) = description {
        omni_ir::deep::insert(out, "description".into(), json!(d));
    }
    omni_ir::deep::insert(out, "parameters".into(), omni_ir::deep::clone(schema));
}

/// Whether the caller placed a cache breakpoint anywhere in the request. The
/// chat completions wire has no field for one at all, so the marker cannot be
/// forwarded and the loss is recorded instead of being silent.
fn has_cache_breakpoint(req: &ChatRequest) -> bool {
    req.system
        .iter()
        .flatten()
        .any(|b| b.cache_control().is_some())
        || req
            .messages
            .iter()
            .flat_map(|m| &m.content)
            .any(|b| b.cache_control().is_some())
}

/// A tool result is its own message in this API, so anything accumulated
/// before it has to be emitted first or the turn arrives out of order.
fn flush(
    messages: &mut Vec<Value>,
    role: &str,
    parts: &mut Vec<Part>,
    tool_calls: &mut Vec<Value>,
) {
    if !tool_calls.is_empty() {
        messages.push(json!({
            "role": role,
            "content": collapse(parts),
            "tool_calls": std::mem::take(tool_calls),
        }));
    } else if !parts.is_empty() {
        messages.push(json!({"role": role, "content": collapse(parts)}));
    }
    parts.clear();
    tool_calls.clear();
}

pub fn to_kilo_wire(req: &ChatRequest, model: &str) -> Encoded {
    let mut notes = Notes::default();
    // No beta mechanism, so a 1M request is silently not honoured unless the
    // loss is recorded here.
    if req
        .betas
        .as_ref()
        .is_some_and(|b| b.iter().any(|x| x == CONTEXT_1M_BETA))
    {
        notes.note("kilo:context-1m-dropped");
    }
    if has_cache_breakpoint(req) {
        notes.note("kilo:cache-control-dropped");
    }

    let mut messages: Vec<Value> = Vec::new();
    let system = system_text(req.system.as_deref(), "kilo", &mut |d| notes.note(d));
    if let Some(system) = system.filter(|s| !s.is_empty()) {
        messages.push(json!({"role": "system", "content": system}));
    }

    for message in &req.messages {
        let mut parts: Vec<Part> = Vec::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        // A tool message takes text only, and nothing may sit between the tool
        // messages answering one assistant turn, so a result's images and
        // files wait for a user message after all of them.
        let mut tool_images: Vec<Part> = Vec::new();
        let role = message.role.as_str();

        for block in &message.content {
            match block {
                ContentBlock::Text(t) => parts.push(Part::Text(t.text.clone())),
                ContentBlock::Image(i) => {
                    // Kilo claims images, and this wire can express them: a
                    // data URL is the form every OpenAI-compatible surface takes.
                    parts.push(Part::ImageUrl(format!(
                        "data:{};base64,{}",
                        i.media_type, i.data
                    )));
                }
                ContentBlock::Thinking(_) => {
                    // Nothing on this wire replays a thinking block back to the model.
                    notes.note("kilo:thinking-dropped");
                }
                ContentBlock::ToolUse(u) => tool_calls.push(json!({
                    "id": u.id,
                    "type": "function",
                    "function": {"name": u.name, "arguments": arguments(&u.input)},
                })),
                ContentBlock::ToolResult(r) => {
                    // Unreachable: the router pins a result's native parts to
                    // their producer.
                    if r.native.is_some() {
                        notes.note("kilo:anthropic-native-block-dropped");
                    }
                    flush(&mut messages, role, &mut parts, &mut tool_calls);
                    // Text files are decoded into the result; a PDF is the one
                    // file type the chat `file` part is known to carry.
                    let files = split_files(r.files.as_deref().unwrap_or_default(), |t| {
                        t == "application/pdf"
                    });
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": r.tool_use_id,
                        "content": with_file_text(&r.content, &files.text),
                    }));
                    if !files.text.is_empty() {
                        notes.note("kilo:tool-result-files-inlined");
                    }
                    if files.dropped {
                        notes.note("kilo:files-dropped");
                    }
                    for image in r.images.as_deref().unwrap_or_default() {
                        notes.note("kilo:tool-result-images-moved");
                        tool_images.push(Part::ImageUrl(format!(
                            "data:{};base64,{}",
                            image.media_type, image.data
                        )));
                    }
                    for file in files.carried {
                        notes.note("kilo:tool-result-files-moved");
                        tool_images.push(Part::File {
                            filename: file_name(file),
                            data: format!("data:{};base64,{}", file.media_type, file.data),
                        });
                    }
                }
                ContentBlock::ProviderNative(_) => {
                    // Unreachable: the router excludes this provider from any
                    // request carrying another provider's native history.
                    // Recorded, not ignored.
                    notes.note("kilo:anthropic-native-block-dropped");
                }
            }
        }

        flush(&mut messages, role, &mut parts, &mut tool_calls);
        if !tool_images.is_empty() {
            messages.push(json!({
                "role": "user",
                "content": Value::Array(tool_images.iter().map(Part::value).collect()),
            }));
        }
    }

    // The adapter always streams upstream, and an OpenAI-compatible chat
    // stream reports no usage at all without `stream_options` — which reaches
    // the request log as a request that cost nothing and cached nothing.
    let mut body = Map::new();
    omni_ir::deep::insert(&mut body, "model".into(), json!(model));
    omni_ir::deep::insert(&mut body, "messages".into(), Value::Array(messages));
    omni_ir::deep::insert(&mut body, "stream".into(), json!(req.stream));
    omni_ir::deep::insert(
        &mut body,
        "stream_options".into(),
        json!({"include_usage": true}),
    );
    if let Some(v) = req.max_tokens {
        omni_ir::deep::insert(&mut body, "max_tokens".into(), num(v));
    }
    if let Some(v) = req.temperature {
        omni_ir::deep::insert(&mut body, "temperature".into(), num(v));
    }
    if let Some(stop) = &req.stop_sequences {
        omni_ir::deep::insert(&mut body, "stop".into(), json!(stop));
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
                    omni_ir::deep::insert(&mut tool, "type".into(), json!("function"));
                    omni_ir::deep::insert(&mut tool, "function".into(), Value::Object(function));
                    Some(Value::Object(tool))
                }
                ToolDef::Provider(_) => None,
            })
            .collect();
        if portable.len() != tools.len() {
            notes.note("kilo:anthropic-tool-dropped");
        }
        omni_ir::deep::insert(&mut body, "tools".into(), Value::Array(portable));
    }
    if let Some(c) = &req.tool_choice {
        omni_ir::deep::insert(&mut body, "tool_choice".into(), encode_tool_choice(c));
    }
    match &req.reasoning {
        Some(ReasoningConfig::BetweenTools) => {
            notes.note("kilo:reasoning-between-tools-as-off");
        }
        Some(ReasoningConfig::Budget { budget_tokens }) => {
            let mut reasoning = Map::new();
            omni_ir::deep::insert(&mut reasoning, "max_tokens".into(), num(*budget_tokens));
            omni_ir::deep::insert(&mut body, "reasoning".into(), Value::Object(reasoning));
        }
        Some(ReasoningConfig::Adaptive { effort, .. }) => {
            // OpenRouter's published ladder runs `none` through `max`. Model
            // support varies, and an unsupported value is the upstream's error
            // to raise, not ours to pre-clamp into a different depth.
            let mut reasoning = Map::new();
            omni_ir::deep::insert(
                &mut reasoning,
                "effort".into(),
                json!(effort.map_or("medium", omni_ir::request::ReasoningEffort::as_str)),
            );
            omni_ir::deep::insert(&mut body, "reasoning".into(), Value::Object(reasoning));
        }
        Some(ReasoningConfig::Off) | None => {}
    }

    // Last, so an operator's passthrough can override anything above.
    object_assign(&mut body, req.vendor_value("kilo").filter(|v| !v.is_null()));

    // The bag above is named after a provider, and every ingress writes one
    // named after a *surface*, so a structured-output request never reaches
    // it. This endpoint speaks Chat Completions, where the client's own
    // spelling is already the right one.
    match read_response_format(req) {
        ResponseFormatRead::Readable(format) => {
            if !body.contains_key("response_format") {
                let mut spec = Map::new();
                omni_ir::deep::insert(&mut spec, "name".into(), json!(format.name));
                omni_ir::deep::insert(&mut spec, "schema".into(), Value::Object(format.schema));
                omni_ir::deep::insert(&mut spec, "strict".into(), Value::Bool(true));
                let mut format = Map::new();
                omni_ir::deep::insert(&mut format, "type".into(), json!("json_schema"));
                omni_ir::deep::insert(&mut format, "json_schema".into(), Value::Object(spec));
                omni_ir::deep::insert(&mut body, "response_format".into(), Value::Object(format));
                notes.note("kilo:response-format-translated");
            }
        }
        ResponseFormatRead::TooDeep => {
            // Asked, and the reader refused — a schema too deep to serialize.
            // Dropping it is correct; dropping it without a word is not.
            body.shift_remove("response_format");
            notes.note("kilo:response-schema-too-deep");
        }
        _ => {}
    }

    Encoded {
        body,
        degradations: notes.0,
    }
}
