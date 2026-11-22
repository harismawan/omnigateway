//! Frozen Cloud Code request envelope, in JavaScript insertion order.
use super::cloak::ToolCloak;
use crate::response_format::{ResponseFormatRead, read_response_format};
use omni_ir::{deep, js, jsjson::JsValue as Value, request::*, text::Text};
use std::collections::{HashMap, HashSet};

macro_rules! json {
    ($($tt:tt)+) => { Value::from(&serde_json::json!($($tt)+)) };
}

fn object() -> Value {
    Value::Object(Vec::new())
}

fn put(map: &mut Value, key: &str, value: Value) {
    map.put(key.encode_utf16().collect(), value);
}

fn fingerprints_text(system: &Text, note: &mut impl FnMut(String)) -> Text {
    // Split /(?:\r?\n){2,}/ without changing untouched line endings.
    let bytes = system.to_utf16();
    let mut paragraphs = Vec::new();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        let begin = i;
        let mut count = 0;
        loop {
            if bytes.get(i) == Some(&13) && bytes.get(i + 1) == Some(&10) {
                i += 2;
            } else if bytes.get(i) == Some(&10) {
                i += 1;
            } else {
                break;
            }
            count += 1;
        }
        if count >= 2 {
            paragraphs.push(&bytes[start..begin]);
            start = i;
        }
        if count == 0 {
            i += 1;
        }
    }
    paragraphs.push(&bytes[start..]);
    let (mut preamble, mut billing) = (false, false);
    paragraphs.retain(|p| {
        let p = Text::from_utf16(p.to_vec());
        let utf8 = p.to_utf8_lossy();
        let text = js::trim(&utf8);
        if text == crate::anthropic::body::AGENT_PREAMBLE {
            preamble = true;
            false
        } else if text.starts_with(omni_crypto::cch::BILLING_PREFIX) {
            billing = true;
            false
        } else {
            true
        }
    });
    if !preamble && !billing {
        return system.clone();
    }
    if preamble {
        note("antigravity:agent-preamble-dropped".into());
    }
    if billing {
        note("antigravity:billing-header-dropped".into());
    }
    Text::from_utf16(paragraphs.join(&[10u16, 10][..]))
}

fn at<'a>(value: Option<&'a Value>, key: &str, index: usize) -> Option<&'a Value> {
    value?.get(key)?.as_array()?.get(index)
}

/// `toAntigravityWire`; callers serialize with `jsjson` and deep-drop the body.
pub fn to_wire(
    req: &ChatRequest,
    model: &str,
    project: &str,
    request_id: &str,
    cloak: &ToolCloak,
) -> Result<(Value, Vec<String>), crate::codec::BuildError> {
    to_wire_source(req, None, model, &project.into(), &request_id.into(), cloak)
}

pub(super) fn to_wire_source(
    req: &ChatRequest,
    source: Option<&Value>,
    model: &str,
    project: &Text,
    request_id: &Text,
    cloak: &ToolCloak,
) -> Result<(Value, Vec<String>), crate::codec::BuildError> {
    let text = |value: Option<&Value>, key: &str, fallback: &str| {
        value
            .and_then(|v| v.get(key))
            .and_then(Value::as_text)
            .unwrap_or_else(|| fallback.into())
    };
    let mut notes = Vec::new();
    let mut note = |s: String| {
        if !notes.contains(&s) {
            notes.push(s);
        }
    };
    let mut names = HashMap::new();
    for (mi, message) in req.messages.iter().enumerate() {
        let original = at(source, "messages", mi);
        for (bi, block) in message.content.iter().enumerate() {
            if let ContentBlock::ToolUse(t) = block {
                let b = at(original, "content", bi);
                names.insert(text(b, "id", &t.id), text(b, "name", &t.name));
            }
        }
    }
    let mut contents: Vec<(&str, Vec<Value>)> = Vec::new();
    for (mi, message) in req.messages.iter().enumerate() {
        let original = at(source, "messages", mi);
        let mut parts = Vec::new();
        if message.role == Role::System {
            note("antigravity:system-turn-as-user".into());
        }
        let mut role = if message.role == Role::Assistant {
            "model"
        } else {
            "user"
        };
        for (bi, block) in message.content.iter().enumerate() {
            let b = at(original, "content", bi);
            if block.cache_control().is_some() {
                note("antigravity:cache-control-dropped".into());
            }
            match block {
                ContentBlock::Text(t) => parts.push(Value::object([(
                    "text",
                    (&text(b, "text", &t.text)).into(),
                )])),
                ContentBlock::Image(t) => {
                    parts.push(json!({"inlineData":{"mimeType":t.media_type,"data":t.data}}))
                }
                ContentBlock::Thinking(_) => note("antigravity:thinking-dropped".into()),
                ContentBlock::ProviderNative(_) => {
                    note("antigravity:provider-native-block-dropped".into())
                }
                ContentBlock::ToolUse(t) => {
                    let mut call = object();
                    let name = cloak.wire_text(&text(b, "name", &t.name));
                    put(&mut call, "name", (&name).into());
                    put(
                        &mut call,
                        "args",
                        b.and_then(|b| b.get("input"))
                            .cloned()
                            .unwrap_or_else(|| Value::from(&t.input)),
                    );
                    let mut part = object();
                    put(
                        &mut part,
                        "thoughtSignature",
                        json!("skip_thought_signature_validator"),
                    );
                    put(&mut part, "functionCall", call);
                    parts.push(part);
                }
                ContentBlock::ToolResult(t) => {
                    if t.native.is_some() {
                        note("antigravity:provider-native-block-dropped".into());
                    }
                    let id = text(b, "toolUseId", &t.tool_use_id);
                    let name = names.get(&id);
                    if name.is_none() {
                        note("antigravity:tool-result-unmatched".into());
                    }
                    if t.is_error == Some(true) {
                        note("antigravity:tool-result-error-flag-dropped".into());
                    }
                    let files = crate::tool_result_files::split_files(
                        t.files.as_deref().unwrap_or_default(),
                        |_| true,
                    );
                    if !files.text.is_empty() {
                        note("antigravity:tool-result-files-inlined".into());
                    }
                    parts.push(Value::object([("functionResponse", Value::object([
                        ("name", (&cloak.wire_text(name.unwrap_or(&id))).into()),
                        ("response", json!({"output":crate::tool_result_files::with_file_text(&t.content,&files.text)})),
                    ]))]));
                    for image in t.images.iter().flatten() {
                        parts.push(
                            json!({"inlineData":{"mimeType":image.media_type,"data":image.data}}),
                        );
                    }
                    for file in files.carried {
                        parts.push(
                            json!({"inlineData":{"mimeType":file.media_type,"data":file.data}}),
                        );
                    }
                    role = "user";
                }
            }
        }
        if !parts.is_empty() {
            if let Some((last_role, last_parts)) = contents.last_mut()
                && *last_role == role
            {
                last_parts.extend(parts);
            } else {
                contents.push((role, parts));
            }
        }
    }
    if contents.first().is_some_and(|(r, p)| {
        *r == "model"
            || p.first()
                .is_some_and(|p| p.get("functionResponse").is_some())
    }) {
        note("antigravity:opening-turn-added".into());
        contents = std::iter::once(("user", vec![json!({"text":""})]))
            .chain(contents)
            .collect();
    }
    if contents.last().is_some_and(|(r, _)| *r == "model") {
        note("antigravity:closing-turn-added".into());
        contents.push(("user", vec![json!({"text":" "})]));
    }
    let contents = contents
        .into_iter()
        .map(|(role, parts)| {
            let mut m = object();
            put(&mut m, "role", json!(role));
            put(&mut m, "parts", Value::Array(parts));
            m
        })
        .collect();
    let mut request = object();
    put(&mut request, "contents", Value::Array(contents));
    if let Some(blocks) = &req.system {
        let mut system = Text::default();
        let mut first = true;
        for (i, block) in blocks.iter().enumerate() {
            if let ContentBlock::Text(t) = block {
                if !first {
                    system.push(&"\n\n".into());
                }
                let b = at(source, "system", i);
                system.push(&text(b, "text", &t.text));
                first = false;
            } else {
                note(format!("antigravity:system-{}-dropped", block.type_name()));
            }
        }
        let system = fingerprints_text(&system, &mut note);
        if !js::trim(&system.to_utf8_lossy()).is_empty() {
            put(
                &mut request,
                "systemInstruction",
                Value::object([(
                    "parts",
                    Value::Array(vec![Value::object([("text", (&system).into())])]),
                )]),
            );
        }
    }
    let mut config = object();
    if let Some(max) = req.max_tokens {
        if max > 0.0 {
            put(&mut config, "maxOutputTokens", json!(max));
        } else {
            note("antigravity:max-tokens-dropped".into());
        }
    }
    if let Some(t) = req.temperature {
        let clamped = js::math_min(js::math_max(t, 0.0), 2.0);
        if clamped != t {
            note("antigravity:temperature-clamped".into());
        }
        put(&mut config, "temperature", json!(clamped));
    }
    if let Some(stops) = &req.stop_sequences {
        put(
            &mut config,
            "stopSequences",
            json!(&stops[..stops.len().min(5)]),
        );
        if stops.len() > 5 {
            note("antigravity:stop-sequences-dropped".into());
        }
    }
    let mut budget = None;
    if let Some(reasoning) = &req.reasoning {
        let thinking = match reasoning {
            ReasoningConfig::BetweenTools | ReasoningConfig::Off => {
                if matches!(reasoning, ReasoningConfig::BetweenTools) {
                    note("antigravity:reasoning-between-tools-as-off".into());
                }
                json!({"thinkingBudget":0,"includeThoughts":false})
            }
            ReasoningConfig::Budget { budget_tokens } => {
                let b = js::math_min(js::math_max(*budget_tokens, -1.0), 65535.0);
                if b != *budget_tokens {
                    note("antigravity:thinking-budget-clamped".into());
                }
                budget = Some(b);
                json!({"thinkingBudget":b,"includeThoughts":b != 0.0})
            }
            ReasoningConfig::Adaptive { effort, display } => {
                if effort.is_some() {
                    note("antigravity:reasoning-effort-dropped".into());
                }
                json!({"includeThoughts":!matches!(display,Some(ReasoningDisplay::Omitted | ReasoningDisplay::Updates))})
            }
        };
        put(&mut config, "thinkingConfig", thinking);
    }
    match read_response_format(req) {
        ResponseFormatRead::Readable(f) => {
            let schema = deep::Owned(serde_json::Value::Object(f.schema));
            let (pruned, notes) = match super::schema::try_prune(&schema) {
                Ok(result) => result,
                Err(error) => {
                    return Err(error);
                }
            };
            for n in notes {
                note(n);
            }
            let pruned = deep::Owned(pruned);
            put(&mut config, "responseSchema", Value::from(&pruned.0));
            note("antigravity:response-format-translated".into());
        }
        ResponseFormatRead::TooDeep => note("antigravity:response-schema-too-deep".into()),
        _ => (),
    }
    if req.max_tokens.is_some_and(|m| m > 65536.0) {
        put(&mut config, "maxOutputTokens", json!(65536));
        note("antigravity:max-tokens-clamped".into());
    }
    if let Some(b) = budget
        && b > 0.0
        && config
            .get("maxOutputTokens")
            .and_then(Value::as_f64)
            .is_none_or(|m| m <= b)
    {
        put(
            &mut config,
            "maxOutputTokens",
            json!((b + 1.0).min(65536.0)),
        );
    }
    if config.as_object().is_some_and(|o| !o.is_empty()) {
        put(&mut request, "generationConfig", config);
    }
    if let Some(tools) = &req.tools {
        if tools.iter().any(|t| !matches!(t, ToolDef::Portable(_))) {
            note("antigravity:provider-tool-dropped".into());
        }
        let mut seen = HashSet::new();
        let mut named = Vec::new();
        for (i, tool) in tools.iter().enumerate() {
            if let ToolDef::Portable(t) = tool {
                let original = at(source, "tools", i);
                let name = cloak.wire_text(&text(original, "name", &t.name));
                if !seen.insert(name.clone()) {
                    note("antigravity:duplicate-tool-dropped".into());
                } else {
                    named.push((name, t));
                }
            }
        }
        if !cloak.to_wire.is_empty() {
            note("antigravity:tool-name-renamed".into());
        }
        let mut declarations = Vec::new();
        for (name, t) in named {
            let mut m = object();
            put(&mut m, "name", (&name).into());
            if let Some(d) = &t.description {
                put(&mut m, "description", json!(d));
            }
            let (schema, notes) = match super::schema::try_prune(&t.input_schema) {
                Ok(result) => result,
                Err(error) => {
                    // Earlier messages, response schemas and declarations may
                    // contain opaque client values at the full ingress depth.
                    return Err(error);
                }
            };
            for n in notes {
                note(n);
            }
            let schema = deep::Owned(schema);
            put(&mut m, "parameters", Value::from(&schema.0));
            declarations.push(m);
        }
        if !declarations.is_empty() {
            let mut m = object();
            put(&mut m, "functionDeclarations", Value::Array(declarations));
            put(&mut request, "tools", Value::Array(vec![m]));
        }
    }
    if let Some(choice) = &req.tool_choice {
        let config = match choice {
            ToolChoice::Auto => json!({"mode":"AUTO"}),
            ToolChoice::Any => json!({"mode":"ANY"}),
            ToolChoice::None => json!({"mode":"NONE"}),
            ToolChoice::Tool { name } => {
                let name = cloak.wire_text(&text(
                    source.and_then(|v| v.get("toolChoice")),
                    "name",
                    name,
                ));
                Value::object([
                    ("mode", "ANY".into()),
                    ("allowedFunctionNames", Value::Array(vec![(&name).into()])),
                ])
            }
        };
        put(
            &mut request,
            "toolConfig",
            Value::object([("functionCallingConfig", config)]),
        );
    }
    if let Some(v) = source
        .and_then(|v| v.get("vendor"))
        .and_then(|v| v.get("antigravity"))
    {
        request.assign_entries(v);
    } else if let Some(v) = req.vendor_value("antigravity") {
        request.assign_entries(&Value::from(v));
    }
    Ok((
        Value::object([
            ("project", project.into()),
            ("requestId", request_id.into()),
            ("request", request),
            ("model", model.into()),
            ("userAgent", "antigravity".into()),
            ("requestType", "agent".into()),
        ]),
        notes,
    ))
}
