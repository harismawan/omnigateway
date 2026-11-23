//! `toGrokWire`: grok's Responses body.
//!
//! Forked from the OpenAI encoder rather than shared with it: the two
//! surfaces agree today but already differ in reasoning effort, parameter
//! drops and body fields, and a shared file would mean every future xAI quirk
//! lands as another branch inside OpenAI's encoder.
//!
//! Bodies are built as insertion-ordered JSON maps, one object-literal
//! assignment step at a time; `omni_ir::jsjson` serializes them with
//! `JSON.stringify` key-order rules.
use omni_ir::js::object_assign;
use omni_ir::jsjson;
use omni_ir::request::{
    CONTEXT_1M_BETA, ChatRequest, ContentBlock, ReasoningConfig, ReasoningDisplay, Role,
    ToolChoice, ToolDef,
};
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

use crate::response_format::move_to_responses_text;
use crate::system::system_text;
use crate::tool_result_files::{responses_files, with_file_text};

/// Above this the proxy answers `Maximum tools limit reached` and the whole
/// request fails. Truncating loses the tail of a tool list; a 400 loses the turn.
const MAX_TOOLS: usize = 200;

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
        ToolChoice::Tool { name } => json!({"type": "function", "name": name}),
    }
}

/// Derives the cache-affinity key from the conversation's stable prefix.
///
/// The key pins requests to one server, so it has to survive across the turns
/// of a conversation. The instructions plus the opening turn are what a
/// conversation keeps, so that is what is hashed. An empty input omits
/// `firstInput` entirely, exactly as `JSON.stringify` drops `undefined`.
fn prompt_cache_key(instructions: &str, first_input: Option<&Value>) -> String {
    let mut stable = Map::new();
    omni_ir::deep::insert(&mut stable, "instructions".into(), json!(instructions));
    if let Some(first) = first_input {
        omni_ir::deep::insert(
            &mut stable,
            "firstInput".into(),
            omni_ir::deep::clone(first),
        );
    }
    let preimage = jsjson::to_string(&Value::Object(stable));
    let hash = Sha256::digest(preimage.as_bytes());
    hash.iter().map(|b| format!("{b:02x}")).collect::<String>()[..32].to_owned()
}

fn image_part(media_type: &str, data: &str) -> Value {
    // xAI takes the data URL as a plain string here, not OpenAI's
    // `{ url: … }` object — the one shape difference between the two.
    json!({"type": "input_image", "image_url": format!("data:{media_type};base64,{data}")})
}

pub fn to_grok_wire(req: &ChatRequest, model: &str) -> Encoded {
    let mut notes = Notes::default();
    let mut input: Vec<Value> = Vec::new();

    // No beta mechanism here, so a client asking for the 1M window is not
    // refused, it is simply not honoured — recorded, because the silence is
    // the dangerous part.
    if req
        .betas
        .as_ref()
        .is_some_and(|b| b.iter().any(|x| x == CONTEXT_1M_BETA))
    {
        notes.note("grok:context-1m-dropped");
    }

    for message in &req.messages {
        let mut parts: Vec<Value> = Vec::new();

        // The backend refuses a `system` turn inside `input` — it supplies
        // its own — so a mid-conversation operator turn goes as `developer`,
        // which keeps both its position and its operator standing, inside the
        // cacheable prefix. Recorded still: the role is not the one the client
        // wrote.
        let as_developer = message.role == Role::System;
        if as_developer {
            notes.note("grok:system-turn-as-developer");
        }
        let role = if as_developer {
            "developer"
        } else {
            message.role.as_str()
        };

        let flush = |parts: &mut Vec<Value>, input: &mut Vec<Value>| {
            if !parts.is_empty() {
                input.push(json!({
                    "type": "message",
                    "role": role,
                    "content": std::mem::take(parts),
                }));
            }
        };

        for block in &message.content {
            match block {
                ContentBlock::Text(t) => parts.push(json!({
                    "type": if role == "assistant" { "output_text" } else { "input_text" },
                    "text": t.text,
                })),
                ContentBlock::Image(i) => parts.push(image_part(&i.media_type, &i.data)),
                ContentBlock::Thinking(_) => {
                    // xAI's own encrypted reasoning could round-trip, but that
                    // needs an IR representation for an opaque provider-owned
                    // blob. Anthropic's signed thinking is meaningless here.
                    notes.note("grok:thinking-dropped");
                }
                ContentBlock::ToolUse(u) => {
                    flush(&mut parts, &mut input);
                    input.push(json!({
                        "type": "function_call",
                        "call_id": u.id,
                        "name": u.name,
                        "arguments": jsjson::to_string(&u.input),
                    }));
                }
                ContentBlock::ToolResult(r) => {
                    // Unreachable: the router pins a result's native parts to
                    // their producer.
                    if r.native.is_some() {
                        notes.note("grok:anthropic-native-block-dropped");
                    }
                    flush(&mut parts, &mut input);
                    let files = responses_files(r.files.as_deref().unwrap_or_default());
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": r.tool_use_id,
                        "output": with_file_text(&r.content, &files.text),
                    }));
                    // `output` stays text; the result's images go as input
                    // parts of the following Responses message, and the move
                    // is recorded.
                    if let Some(images) = &r.images {
                        notes.note("grok:tool-result-images-moved");
                        for image in images {
                            parts.push(image_part(&image.media_type, &image.data));
                        }
                    }
                    // Its files go the same way, as `input_file` data URLs.
                    if !files.parts.is_empty() {
                        notes.note("grok:tool-result-files-moved");
                        parts.extend(files.parts);
                    }
                    if !files.text.is_empty() {
                        notes.note("grok:tool-result-files-inlined");
                    }
                    if files.dropped {
                        notes.note("grok:files-dropped");
                    }
                }
                ContentBlock::ProviderNative(_) => {
                    // Unreachable in practice: the router excludes this
                    // provider from any request carrying another provider's
                    // native history. Recorded rather than ignored.
                    notes.note("grok:anthropic-native-block-dropped");
                }
            }
        }
        flush(&mut parts, &mut input);
    }

    let instructions = system_text(req.system.as_deref(), "grok", &mut |d| notes.note(d));
    let cache_key = prompt_cache_key(instructions.as_deref().unwrap_or(""), input.first());

    let mut body = Map::new();
    omni_ir::deep::insert(&mut body, "model".into(), json!(model));
    omni_ir::deep::insert(&mut body, "input".into(), Value::Array(input));
    omni_ir::deep::insert(&mut body, "stream".into(), json!(req.stream));
    // Defaults to true upstream, which breaks zero-data-retention
    // expectations; xAI's image documentation independently advises against
    // storing, so this stays set for two unrelated reasons.
    omni_ir::deep::insert(&mut body, "store".into(), json!(false));
    omni_ir::deep::insert(
        &mut body,
        "include".into(),
        json!(["reasoning.encrypted_content"]),
    );
    omni_ir::deep::insert(&mut body, "prompt_cache_key".into(), json!(cache_key));

    if let Some(instructions) = instructions.filter(|s| !s.is_empty()) {
        omni_ir::deep::insert(&mut body, "instructions".into(), json!(instructions));
    }

    // Sent on both routes. The OpenAI encoder drops these under OAuth because
    // the Codex backend rejects them, which is a constraint of that product
    // and not of xAI's proxy.
    if let Some(max_tokens) = req.max_tokens {
        omni_ir::deep::insert(
            &mut body,
            "max_output_tokens".into(),
            omni_ir::stream::number(max_tokens),
        );
    }
    if let Some(temperature) = req.temperature {
        omni_ir::deep::insert(
            &mut body,
            "temperature".into(),
            omni_ir::stream::number(temperature),
        );
    }

    if let Some(tools) = &req.tools {
        // A provider-defined tool has no function schema to send, and the
        // router never routes one here.
        let custom: Vec<_> = tools
            .iter()
            .filter_map(|t| match t {
                ToolDef::Portable(p) => Some(p),
                ToolDef::Provider(_) => None,
            })
            .collect();
        if custom.len() != tools.len() {
            notes.note("grok:anthropic-tool-dropped");
        }
        if custom.len() > MAX_TOOLS {
            notes.note("grok:tools-truncated");
        }
        let encoded: Vec<Value> = custom
            .iter()
            .take(MAX_TOOLS)
            .map(|t| {
                let mut tool = Map::new();
                omni_ir::deep::insert(&mut tool, "type".into(), json!("function"));
                omni_ir::deep::insert(&mut tool, "name".into(), json!(t.name));
                // `description: undefined` is dropped by JSON.stringify.
                if let Some(d) = &t.description {
                    omni_ir::deep::insert(&mut tool, "description".into(), json!(d));
                }
                omni_ir::deep::insert(
                    &mut tool,
                    "parameters".into(),
                    omni_ir::deep::clone(&t.input_schema),
                );
                Value::Object(tool)
            })
            .collect();
        omni_ir::deep::insert(&mut body, "tools".into(), Value::Array(encoded));
    }
    if let Some(choice) = &req.tool_choice {
        omni_ir::deep::insert(&mut body, "tool_choice".into(), encode_tool_choice(choice));
    }
    if matches!(req.reasoning, Some(ReasoningConfig::BetweenTools)) {
        notes.note("grok:reasoning-between-tools-as-off");
    }
    match &req.reasoning {
        Some(ReasoningConfig::Budget { .. }) => {
            // A budget has no expression here. These models think by default,
            // so sending nothing leaves them at their own depth instead of
            // fabricating an effort nobody chose; the loss is recorded.
            notes.note("grok:reasoning-budget-dropped");
        }
        Some(ReasoningConfig::Adaptive { effort, display }) => {
            // Forwarded unclamped: xAI clamps server-side — `xhigh` is treated
            // as `high` on models that lack it — so a second clamp here could
            // only get it wrong as the model line moves.
            let mut reasoning = Map::new();
            omni_ir::deep::insert(
                &mut reasoning,
                "effort".into(),
                json!(effort.map_or("medium", |e| e.as_str())),
            );
            if !matches!(
                display,
                Some(ReasoningDisplay::Omitted | ReasoningDisplay::Updates)
            ) {
                omni_ir::deep::insert(&mut reasoning, "summary".into(), json!("concise"));
            }
            omni_ir::deep::insert(&mut body, "reasoning".into(), Value::Object(reasoning));
        }
        _ => {}
    }

    // Last, so an operator can override anything above. Deliberately
    // unfiltered: it is the escape hatch. The proxy 400s on `presence_penalty`,
    // `frequency_penalty`, `logprobs`, `top_logprobs` and `stop`, which the
    // encoder never emits — a passthrough carrying one is the likely cause.
    object_assign(&mut body, req.vendor_value("grok"));

    // A structured-output request rides `vendor.openai`, which nothing above
    // reads: every ingress writes the bag named after the *surface* the client
    // spoke. This is a Responses endpoint, so the spelling is `text.format`.
    if let Some(moved) = move_to_responses_text(req, &mut body, "grok") {
        notes.note(moved);
    }
    Encoded {
        body,
        degradations: notes.0,
    }
}
