//! `toQoderWire`: the Cosy chat envelope.
//!
//! Bodies are built as insertion-ordered JSON maps, one object-literal
//! assignment step at a time; `omni_ir::jsjson` serializes them with
//! `JSON.stringify` key-order rules. The envelope is then body-encoded by the
//! codec, so nothing here escapes the CLI's own vocabulary.

use omni_ir::jsjson;
use omni_ir::request::{ChatRequest, ContentBlock, Role, ToolChoice, ToolDef};
use serde_json::{Map, Value, json};

use crate::codec::CodecInput;
use crate::system::system_text;
use crate::tool_result_files::{split_files, with_file_text};

use super::credential::Bundle;
use super::model_catalog::QoderModel;

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

fn num(v: f64) -> Value {
    omni_ir::stream::number(v)
}

fn truthy_number(v: Option<f64>) -> bool {
    v.is_some_and(|n| n != 0.0 && !n.is_nan())
}

fn encode_tool_choice(c: &ToolChoice) -> Value {
    match c {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::Any => json!("required"),
        ToolChoice::None => json!("none"),
        ToolChoice::Tool { name } => json!({"type": "function", "function": {"name": name}}),
    }
}

/// `JSON.stringify(req)` for the fallback request-id seed. The host normally
/// supplies a request id; this only has to be deterministic.
fn request_seed(req: &ChatRequest, machine_id: &str) -> String {
    let value = serde_json::to_value(req).unwrap_or(Value::Null);
    format!("{machine_id}:{}", jsjson::to_string(&value))
}

pub fn to_qoder_wire(input: &CodecInput<'_>, bundle: &Bundle) -> Encoded {
    let req = input.request;
    let mut notes = Notes::default();
    let model: Option<&QoderModel> = bundle.models.iter().find(|m| m.key == input.model);

    let mut messages: Vec<Value> = Vec::new();
    for message in &req.messages {
        let mut content: Vec<Value> = Vec::new();
        let mut calls: Vec<Value> = Vec::new();
        let mut reasoning = String::new();
        for block in &message.content {
            if block.cache_control().is_some() {
                notes.note("qoder:cache-control-dropped");
            }
            match block {
                ContentBlock::Text(t) => {
                    content.push(json!({"type": "text", "text": t.text}));
                }
                ContentBlock::Image(img) => {
                    if model.is_some_and(|m| m.images) {
                        content.push(json!({
                            "type": "image_url",
                            "image_url": {"url": format!("data:{};base64,{}", img.media_type, img.data)},
                        }));
                    } else {
                        notes.note("qoder:images-dropped");
                    }
                }
                ContentBlock::Thinking(t) => {
                    reasoning.push_str(&t.text);
                    if t.signature.is_some() {
                        notes.note("qoder:thinking-signature-dropped");
                    }
                }
                ContentBlock::ToolUse(u) => {
                    calls.push(json!({
                        "id": u.id,
                        "type": "function",
                        "function": {"name": u.name, "arguments": jsjson::to_string(&u.input)},
                    }));
                }
                ContentBlock::ToolResult(r) => {
                    // A tool result is its own message on this wire, pushed
                    // before the message that carries it.
                    let files = split_files(r.files.as_deref().unwrap_or_default(), |_| false);
                    let mut tool_message = Map::new();
                    omni_ir::deep::insert(&mut tool_message, "role".into(), json!("tool"));
                    omni_ir::deep::insert(
                        &mut tool_message,
                        "tool_call_id".into(),
                        json!(r.tool_use_id),
                    );
                    omni_ir::deep::insert(
                        &mut tool_message,
                        "content".into(),
                        json!(with_file_text(&r.content, &files.text)),
                    );
                    if r.is_error == Some(true) {
                        omni_ir::deep::insert(&mut tool_message, "is_error".into(), json!(true));
                    }
                    messages.push(Value::Object(tool_message));
                    if r.images.as_ref().is_some_and(|v| !v.is_empty()) {
                        notes.note("qoder:tool-result-images-dropped");
                    }
                    if !files.text.is_empty() {
                        notes.note("qoder:tool-result-files-inlined");
                    }
                    if files.dropped {
                        notes.note("qoder:tool-result-files-dropped");
                    }
                    if r.native.as_ref().is_some_and(|v| !v.is_empty()) {
                        notes.note("qoder:native-block-dropped");
                    }
                }
                ContentBlock::ProviderNative(_) => {
                    notes.note("qoder:unsupported-block-dropped");
                }
            }
        }
        if !content.is_empty() || !calls.is_empty() || !reasoning.is_empty() {
            let has_image = content
                .iter()
                .any(|v| v.get("type").and_then(Value::as_str) == Some("image_url"));
            let mut m = Map::new();
            omni_ir::deep::insert(&mut m, "role".into(), json!(message.role.as_str()));
            if has_image {
                omni_ir::deep::insert(&mut m, "content".into(), Value::Array(content.clone()));
                omni_ir::deep::insert(&mut m, "contents".into(), Value::Array(content));
            } else {
                let text = content
                    .iter()
                    .filter_map(|v| v.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("");
                omni_ir::deep::insert(&mut m, "content".into(), json!(text));
            }
            if !calls.is_empty() {
                omni_ir::deep::insert(&mut m, "tool_calls".into(), Value::Array(calls));
            }
            if !reasoning.is_empty() {
                omni_ir::deep::insert(&mut m, "reasoning_content".into(), json!(reasoning));
            }
            messages.push(Value::Object(m));
        }
    }

    let system =
        system_text(req.system.as_deref(), "qoder", &mut |d| notes.note(d)).unwrap_or_default();
    let request_id = super::oauth::synthetic_uuid(
        &input
            .request_id
            .map(str::to_owned)
            .unwrap_or_else(|| request_seed(req, &bundle.machine_id)),
    );
    let session_id = req
        .conversation_id
        .as_ref()
        .map(|c| super::oauth::synthetic_uuid(&format!("{}:{c}", bundle.machine_id)))
        .unwrap_or_else(|| request_id.clone());

    let mut parameters = Map::new();
    let max_tokens = req.max_tokens.or(input.max_output_tokens);
    if truthy_number(max_tokens) {
        omni_ir::deep::insert(
            &mut parameters,
            "max_tokens".into(),
            num(max_tokens.unwrap_or(0.0)),
        );
    }
    if let Some(t) = req.temperature {
        omni_ir::deep::insert(&mut parameters, "temperature".into(), num(t));
    }
    if let Some(stop) = &req.stop_sequences {
        omni_ir::deep::insert(&mut parameters, "stop".into(), json!(stop));
    }
    if let Some(c) = &req.tool_choice {
        omni_ir::deep::insert(&mut parameters, "tool_choice".into(), encode_tool_choice(c));
    }
    if req.reasoning.is_some() {
        notes.note("qoder:reasoning-config-dropped");
    }
    if req.betas.as_ref().is_some_and(|b| !b.is_empty()) {
        notes.note("qoder:betas-dropped");
    }
    if req.vendor.as_ref().is_some_and(|v| !v.is_empty()) {
        notes.note("qoder:vendor-options-dropped");
    }

    let mut tools: Vec<Value> = Vec::new();
    for tool in req.tools.iter().flatten() {
        match tool {
            ToolDef::Provider(_) => notes.note("qoder:provider-tool-dropped"),
            ToolDef::Portable(t) => {
                let mut function = Map::new();
                omni_ir::deep::insert(&mut function, "name".into(), json!(t.name));
                omni_ir::deep::insert(
                    &mut function,
                    "description".into(),
                    json!(t.description.as_deref().unwrap_or("")),
                );
                omni_ir::deep::insert(
                    &mut function,
                    "parameters".into(),
                    omni_ir::deep::clone(&t.input_schema),
                );
                let mut wire_tool = Map::new();
                omni_ir::deep::insert(&mut wire_tool, "type".into(), json!("function"));
                omni_ir::deep::insert(&mut wire_tool, "function".into(), Value::Object(function));
                tools.push(Value::Object(wire_tool));
            }
        }
    }

    let last_text = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == Role::User)
        .map(|m| {
            m.content
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text(t) => Some(t.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    let mut model_config = Map::new();
    omni_ir::deep::insert(&mut model_config, "key".into(), json!(input.model));
    omni_ir::deep::insert(
        &mut model_config,
        "display_name".into(),
        json!(model.map_or(input.model, |m| m.display_name.as_str())),
    );
    omni_ir::deep::insert(&mut model_config, "model".into(), json!(""));
    omni_ir::deep::insert(
        &mut model_config,
        "is_vl".into(),
        json!(model.is_some_and(|m| m.images)),
    );
    omni_ir::deep::insert(
        &mut model_config,
        "is_reasoning".into(),
        json!(model.is_some_and(|m| m.reasoning)),
    );
    if let Some(n) = model.and_then(|m| m.max_input_tokens).filter(|n| *n != 0.0) {
        omni_ir::deep::insert(&mut model_config, "max_input_tokens".into(), num(n));
    }
    omni_ir::deep::insert(&mut model_config, "source".into(), json!("system"));
    omni_ir::deep::insert(&mut model_config, "format".into(), json!("openai"));
    omni_ir::deep::insert(&mut model_config, "api_key".into(), json!(""));
    omni_ir::deep::insert(&mut model_config, "url".into(), json!(""));

    let mut extra = Map::new();
    omni_ir::deep::insert(&mut extra, "context".into(), json!([]));
    omni_ir::deep::insert(
        &mut extra,
        "modelConfig".into(),
        json!({"key": input.model, "is_reasoning": model.is_some_and(|m| m.reasoning)}),
    );
    omni_ir::deep::insert(&mut extra, "originalContent".into(), json!(last_text));
    let mut chat_context = Map::new();
    omni_ir::deep::insert(&mut chat_context, "text".into(), json!(last_text));
    omni_ir::deep::insert(&mut chat_context, "features".into(), json!([]));
    omni_ir::deep::insert(&mut chat_context, "extra".into(), Value::Object(extra));
    omni_ir::deep::insert(&mut chat_context, "chatPrompt".into(), json!(""));
    omni_ir::deep::insert(&mut chat_context, "imageUrls".into(), Value::Null);

    let mut body = Map::new();
    omni_ir::deep::insert(&mut body, "request_id".into(), json!(request_id));
    omni_ir::deep::insert(&mut body, "chat_record_id".into(), json!(request_id));
    omni_ir::deep::insert(&mut body, "request_set_id".into(), json!(request_id));
    omni_ir::deep::insert(&mut body, "session_id".into(), json!(session_id));
    omni_ir::deep::insert(&mut body, "stream".into(), json!(true));
    omni_ir::deep::insert(&mut body, "chat_task".into(), json!("FREE_INPUT"));
    omni_ir::deep::insert(&mut body, "is_reply".into(), json!(true));
    omni_ir::deep::insert(&mut body, "is_retry".into(), json!(false));
    omni_ir::deep::insert(&mut body, "source".into(), json!(1));
    omni_ir::deep::insert(&mut body, "version".into(), json!("3"));
    omni_ir::deep::insert(&mut body, "agent_id".into(), json!("agent_common"));
    omni_ir::deep::insert(&mut body, "aliyun_user_type".into(), json!(""));
    omni_ir::deep::insert(
        &mut body,
        "chat_context".into(),
        Value::Object(chat_context),
    );
    omni_ir::deep::insert(&mut body, "session_type".into(), json!("qodercli"));
    omni_ir::deep::insert(&mut body, "task_id".into(), json!("common"));
    omni_ir::deep::insert(&mut body, "system".into(), json!(system));
    omni_ir::deep::insert(&mut body, "messages".into(), Value::Array(messages));
    omni_ir::deep::insert(&mut body, "tools".into(), Value::Array(tools));
    omni_ir::deep::insert(&mut body, "parameters".into(), Value::Object(parameters));
    omni_ir::deep::insert(
        &mut body,
        "model_config".into(),
        Value::Object(model_config),
    );

    Encoded {
        body,
        degradations: notes.0,
    }
}
