//! `toChatWire`: kimi's Chat Completions body, tools only.
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
use crate::tool_result_files::{split_files, with_file_text};

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

pub fn to_chat_wire(req: &ChatRequest, model: &str) -> Encoded {
    let mut notes = Notes::default();
    // No beta mechanism, so a 1M request is silently not honoured unless the
    // loss is recorded here.
    if req
        .betas
        .as_ref()
        .is_some_and(|b| b.iter().any(|x| x == CONTEXT_1M_BETA))
    {
        notes.note("kimi:context-1m-dropped");
    }

    let mut messages: Vec<Value> = Vec::new();
    let system = system_text(req.system.as_deref(), "kimi", &mut |d| notes.note(d));
    if let Some(system) = system.filter(|s| !s.is_empty()) {
        messages.push(json!({"role": "system", "content": system}));
    }

    for message in &req.messages {
        let mut text: Vec<&str> = Vec::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        for block in &message.content {
            match block {
                ContentBlock::Text(t) => text.push(&t.text),
                ContentBlock::Image(_) => notes.note("kimi:images-dropped"),
                ContentBlock::Thinking(_) => notes.note("kimi:thinking-dropped"),
                ContentBlock::ToolUse(u) => tool_calls.push(json!({
                    "id": u.id,
                    "type": "function",
                    "function": {"name": u.name, "arguments": arguments(&u.input)},
                })),
                ContentBlock::ToolResult(r) => {
                    // Unreachable: the router pins a result's native parts to
                    // their producer.
                    if r.native.is_some() {
                        notes.note("kimi:anthropic-native-block-dropped");
                    }
                    // A tool result is its own message in this API, not a
                    // content block; its text files are decoded into it, and
                    // nothing else fits.
                    let files = split_files(r.files.as_deref().unwrap_or_default(), |_| false);
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": r.tool_use_id,
                        "content": with_file_text(&r.content, &files.text),
                    }));
                    if r.images.is_some() {
                        notes.note("kimi:images-dropped");
                    }
                    if !files.text.is_empty() {
                        notes.note("kimi:tool-result-files-inlined");
                    }
                    if files.dropped {
                        notes.note("kimi:files-dropped");
                    }
                }
                ContentBlock::ProviderNative(_) => {
                    notes.note("kimi:anthropic-native-block-dropped");
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
            notes.note("kimi:anthropic-tool-dropped");
        }
        omni_ir::deep::insert(&mut body, "tools".into(), Value::Array(portable));
    }
    if let Some(c) = &req.tool_choice {
        omni_ir::deep::insert(&mut body, "tool_choice".into(), encode_tool_choice(c));
    }
    if matches!(req.reasoning, Some(ReasoningConfig::BetweenTools)) {
        notes.note("kimi:reasoning-between-tools-as-off");
    }
    if req.reasoning.is_some() {
        notes.note("kimi:reasoning-dropped");
    }

    // Last, so an operator's passthrough can override anything above.
    object_assign(&mut body, req.vendor_value("kimi").filter(|v| !v.is_null()));

    // Only when the merge above did not already carry it: the kimi bag is one
    // no ingress produces, so without this the client's `response_format`
    // would be lost with nothing recorded.
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
                notes.note("kimi:response-format-translated");
            }
        }
        ResponseFormatRead::TooDeep => {
            // Asked, and the reader refused — a schema too deep to serialize.
            // Dropping it is correct; dropping it without a word is not.
            body.shift_remove("response_format");
            notes.note("kimi:response-schema-too-deep");
        }
        _ => {}
    }

    Encoded {
        body,
        degradations: notes.0,
    }
}
