//! `toMuseWire`: Meta's Responses body.
//!
//! A forked copy of the OpenAI Responses encoder, not an import of one. Meta's
//! Model API serves the Responses dialect, so the two encoders start out
//! near-identical and the temptation to share is real — but the divergences
//! are already here: no Codex parameter bans, a different vendor bag key, a
//! different session header, orphaned-call repair.
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

/// An encoded body, what it could not express, and the session key.
#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub body: Map<String, Value>,
    pub degradations: Vec<String>,
    pub cache_key: String,
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

/// A client-supplied cache key, when it is a usable string.
///
/// `openai`, not `muse`: the key names the **dialect** rather than the
/// provider. Both Responses-shaped ingresses write `vendor = { openai: extras }`
/// and nothing anywhere constructs a `muse` bag, so reading one would drop
/// every passthrough field a client sent — `include` among them, which is what
/// decides whether reasoning items come back replayable.
fn supplied_key(req: &ChatRequest) -> Option<String> {
    let vendor = req.vendor_value("openai")?.as_object()?;
    for name in ["prompt_cache_key", "session_id"] {
        if let Some(value) = vendor.get(name).and_then(Value::as_str)
            && !value.is_empty()
        {
            return Some(value.to_owned());
        }
    }
    None
}

/// Derives the cache-affinity key.
///
/// The key has to survive the turns of one conversation and separate it from
/// the next, which is why the client's own `conversationId` is preferred over
/// anything derived. The fallback hashes the instructions plus the opening
/// item, which is what a conversation keeps while the request id and the
/// history change every turn. An empty input hashes `firstInput: null` rather
/// than omitting it — `JSON.stringify` omits `undefined`, but the TS encoder
/// pins `null` explicitly so the hash never reduces to the instructions alone.
///
/// Hashed rather than forwarded: `conversationId` reaches us from Anthropic's
/// `metadata.user_id`, a client identifier the operator never chose to
/// disclose, so forwarding it raw is the habit not to form.
fn cache_key(req: &ChatRequest, instructions: &str, first_input: Option<&Value>) -> String {
    let stable = match req.conversation_id.as_deref() {
        Some(id) if !id.is_empty() => json!({"conversation": id}),
        _ => json!({
            "instructions": instructions,
            "firstInput": first_input.map(omni_ir::deep::clone).unwrap_or(Value::Null),
        }),
    };
    let preimage = jsjson::to_string(&stable);
    let hash = Sha256::digest(preimage.as_bytes());
    hash.iter().map(|b| format!("{b:02x}")).collect::<String>()[..32].to_owned()
}

/// Answers any tool call the history left unanswered.
///
/// A Responses `input` array holding a `function_call` with no matching
/// `function_call_output` is rejected, and a turn interrupted after the model
/// asked for a tool but before the client ran it produces exactly that. The
/// call is real history, so it is completed with an empty output rather than
/// dropped — removing it would rewrite what the model said.
///
/// IR strips orphaned tool *results* in `validateRequest`; nothing strips or
/// completes an orphaned *call*, which is why this sits here.
fn repair_orphaned_calls(input: &mut Vec<Value>) {
    let mut answered: Vec<String> = Vec::new();
    for item in input.iter() {
        if item.get("type").and_then(Value::as_str) == Some("function_call_output")
            && let Some(call_id) = item.get("call_id").and_then(Value::as_str)
            && !answered.iter().any(|a| a == call_id)
        {
            answered.push(call_id.to_owned());
        }
    }
    for i in (0..input.len()).rev() {
        let Some(record) = input.get(i) else { continue };
        if record.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let Some(call_id) = record.get("call_id").and_then(Value::as_str) else {
            continue;
        };
        if answered.iter().any(|a| a == call_id) {
            continue;
        }
        let output = json!({"type": "function_call_output", "call_id": call_id, "output": ""});
        input.insert(i + 1, output);
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

fn image_part(media_type: &str, data: &str) -> Value {
    // The data URL as a plain string, not OpenAI's `{ url: … }` object.
    json!({"type": "input_image", "image_url": format!("data:{media_type};base64,{data}")})
}

/// Flattens IR messages into Responses input items.
///
/// There is no `oauth` option here, and its absence is the substantive
/// difference from the OpenAI encoder: that flag names the Codex backend,
/// which rejects `max_output_tokens` and `temperature` outright. Muse has one
/// host — the OAuth grant is spent minting a Model API key, and every
/// inference request carries that key against the same front door.
pub fn to_muse_wire(req: &ChatRequest, model: &str) -> Encoded {
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
        notes.note("muse:context-1m-dropped");
    }

    for message in &req.messages {
        let mut parts: Vec<Value> = Vec::new();

        // `developer` is this dialect's role for a mid-conversation operator
        // turn. It keeps both its position and its operator standing, inside
        // the cacheable prefix. Recorded: the role is not the one the client
        // wrote.
        let as_developer = message.role == Role::System;
        if as_developer {
            notes.note("muse:system-turn-as-developer");
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
                    // Anthropic thinking blocks carry a provider-specific
                    // signature that is meaningless here. Dropping them is
                    // lossless for the model.
                    notes.note("muse:thinking-dropped");
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
                        notes.note("muse:foreign-native-block-dropped");
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
                        notes.note("muse:tool-result-images-moved");
                        for image in images {
                            parts.push(image_part(&image.media_type, &image.data));
                        }
                    }
                    // Its files go the same way, as `input_file` data URLs.
                    if !files.parts.is_empty() {
                        notes.note("muse:tool-result-files-moved");
                        parts.extend(files.parts);
                    }
                    if !files.text.is_empty() {
                        notes.note("muse:tool-result-files-inlined");
                    }
                    if files.dropped {
                        notes.note("muse:files-dropped");
                    }
                }
                ContentBlock::ProviderNative(n) => {
                    if n.provider == "muse" {
                        // This provider's own item, going home. `id` is
                        // deliberately left behind: under `store: false` no
                        // server-assigned id can be resolved, and an item
                        // still carrying one is rejected outright. What
                        // continuity needs is the payload — for a reasoning
                        // item, `encrypted_content` — which is never
                        // decrypted, inspected or regenerated on the way
                        // through.
                        flush(&mut parts, &mut input);
                        let mut item = Map::new();
                        omni_ir::deep::insert(&mut item, "type".into(), json!(n.block_type));
                        for (k, v) in &n.data {
                            if k != "id" {
                                omni_ir::deep::insert(
                                    &mut item,
                                    k.clone(),
                                    omni_ir::deep::clone(v),
                                );
                            }
                        }
                        input.push(Value::Object(item));
                    } else {
                        // Another provider's. Unreachable in practice, since
                        // the router excludes this provider from any request
                        // carrying one, and recorded rather than ignored.
                        notes.note("muse:foreign-native-block-dropped");
                    }
                }
            }
        }
        flush(&mut parts, &mut input);
    }

    repair_orphaned_calls(&mut input);

    // `store: false` for the reason this gateway's own Responses surface is
    // stateless: nothing here ever resolves a server-side id, so retention
    // would buy the operator nothing and leave prompts sitting upstream.
    let mut body = Map::new();
    omni_ir::deep::insert(&mut body, "model".into(), json!(model));
    omni_ir::deep::insert(&mut body, "input".into(), Value::Array(input));
    omni_ir::deep::insert(&mut body, "stream".into(), json!(req.stream));
    omni_ir::deep::insert(&mut body, "store".into(), json!(false));

    let instructions = system_text(req.system.as_deref(), "muse", &mut |d| notes.note(d));
    if let Some(instructions) = instructions.as_deref().filter(|s| !s.is_empty()) {
        omni_ir::deep::insert(&mut body, "instructions".into(), json!(instructions));
    }

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
        // router never routes one here. No tool-count cap: none is documented
        // for this front door, and inventing one would truncate silently.
        let portable: Vec<_> = tools
            .iter()
            .filter_map(|t| match t {
                ToolDef::Portable(p) => Some(p),
                ToolDef::Provider(_) => None,
            })
            .collect();
        if portable.len() != tools.len() {
            notes.note("muse:provider-tool-dropped");
        }
        let encoded: Vec<Value> = portable
            .iter()
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
        notes.note("muse:reasoning-between-tools-as-off");
    }
    match &req.reasoning {
        Some(ReasoningConfig::Budget { .. }) => {
            // This API takes a coarse effort level, not a token budget. A
            // budget request is recorded as lost rather than mapped onto an
            // invented medium nobody chose.
            notes.note("muse:reasoning-budget-dropped");
        }
        Some(ReasoningConfig::Adaptive { effort, display }) => {
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
                omni_ir::deep::insert(&mut reasoning, "summary".into(), json!("auto"));
            }
            omni_ir::deep::insert(&mut body, "reasoning".into(), Value::Object(reasoning));
        }
        _ => {}
    }

    let key = supplied_key(req).unwrap_or_else(|| {
        cache_key(
            req,
            instructions.as_deref().unwrap_or(""),
            body.get("input")
                .and_then(Value::as_array)
                .and_then(|a| a.first()),
        )
    });

    // Last, so an operator can override anything above. Deliberately
    // unfiltered: it is the escape hatch.
    object_assign(&mut body, req.vendor_value("openai"));

    // The Chat Completions spelling, which this API refuses. Same bag, same
    // backend shape, same translation as the OpenAI encoder's.
    if let Some(moved) = move_to_responses_text(req, &mut body, "muse") {
        notes.note(moved);
    }

    // Written **after** the vendor merge, and the order is the whole point:
    // the merge copies the client's bag verbatim, including a
    // `prompt_cache_key` that `supplied_key` already rejected — an empty
    // string, a number — so assigning first would let the merge put the
    // rejected value back.
    omni_ir::deep::insert(&mut body, "prompt_cache_key".into(), json!(key));
    Encoded {
        body,
        degradations: notes.0,
        cache_key: key,
    }
}
