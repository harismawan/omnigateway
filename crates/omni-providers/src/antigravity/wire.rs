//! Frozen Cloud Code request envelope, in JavaScript insertion order.
use super::cloak::ToolCloak;
use crate::response_format::{ResponseFormatRead, read_response_format};
use omni_ir::{deep, js, request::*};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

fn put(map: &mut Map<String, Value>, key: &str, value: Value) {
    deep::insert(map, key.into(), value);
}

fn fingerprints(system: &str, note: &mut impl FnMut(String)) -> String {
    // Split /(?:\r?\n){2,}/ without changing untouched line endings.
    let bytes = system.as_bytes();
    let mut paragraphs = Vec::new();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        let begin = i;
        let mut count = 0;
        loop {
            if bytes.get(i) == Some(&b'\r') && bytes.get(i + 1) == Some(&b'\n') {
                i += 2;
            } else if bytes.get(i) == Some(&b'\n') {
                i += 1;
            } else {
                break;
            }
            count += 1;
        }
        if count >= 2 {
            paragraphs.push(&system[start..begin]);
            start = i;
        }
        if count == 0 {
            i += 1;
        }
    }
    paragraphs.push(&system[start..]);
    let (mut preamble, mut billing) = (false, false);
    paragraphs.retain(|p| {
        let text = js::trim(p);
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
        return system.into();
    }
    if preamble {
        note("antigravity:agent-preamble-dropped".into());
    }
    if billing {
        note("antigravity:billing-header-dropped".into());
    }
    paragraphs.join("\n\n")
}

/// `toAntigravityWire`; callers serialize with `jsjson` and deep-drop the body.
pub fn to_wire(
    req: &ChatRequest,
    model: &str,
    project: &str,
    request_id: &str,
    cloak: &ToolCloak,
) -> Result<(Value, Vec<String>), crate::codec::BuildError> {
    let mut notes = Vec::new();
    let mut note = |s: String| {
        if !notes.contains(&s) {
            notes.push(s);
        }
    };
    let mut names = HashMap::new();
    for block in req.messages.iter().flat_map(|m| &m.content) {
        if let ContentBlock::ToolUse(t) = block {
            names.extend([(t.id.as_str(), t.name.as_str())]);
        }
    }
    let mut contents: Vec<(&str, Vec<Value>)> = Vec::new();
    for message in &req.messages {
        let mut parts = Vec::new();
        if message.role == Role::System {
            note("antigravity:system-turn-as-user".into());
        }
        let mut role = if message.role == Role::Assistant {
            "model"
        } else {
            "user"
        };
        for block in &message.content {
            if block.cache_control().is_some() {
                note("antigravity:cache-control-dropped".into());
            }
            match block {
                ContentBlock::Text(t) => parts.push(json!({"text":t.text})),
                ContentBlock::Image(t) => {
                    parts.push(json!({"inlineData":{"mimeType":t.media_type,"data":t.data}}))
                }
                ContentBlock::Thinking(_) => note("antigravity:thinking-dropped".into()),
                ContentBlock::ProviderNative(_) => {
                    note("antigravity:provider-native-block-dropped".into())
                }
                ContentBlock::ToolUse(t) => {
                    let mut call = Map::new();
                    put(&mut call, "name", json!(cloak.name(&t.name)));
                    put(&mut call, "args", deep::clone(&t.input));
                    let mut part = Map::new();
                    put(
                        &mut part,
                        "thoughtSignature",
                        json!("skip_thought_signature_validator"),
                    );
                    put(&mut part, "functionCall", Value::Object(call));
                    parts.push(Value::Object(part));
                }
                ContentBlock::ToolResult(t) => {
                    if t.native.is_some() {
                        note("antigravity:provider-native-block-dropped".into());
                    }
                    let name = names.get(t.tool_use_id.as_str());
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
                    parts.push(json!({"functionResponse":{"name":cloak.name(name.copied().unwrap_or(&t.tool_use_id)),"response":{"output":crate::tool_result_files::with_file_text(&t.content,&files.text)}}}));
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
            let mut m = Map::new();
            put(&mut m, "role", json!(role));
            put(&mut m, "parts", Value::Array(parts));
            Value::Object(m)
        })
        .collect();
    let mut request = Map::new();
    put(&mut request, "contents", Value::Array(contents));
    if let Some(system) =
        crate::system::system_text(req.system.as_deref(), "antigravity", &mut note)
    {
        let system = fingerprints(&system, &mut note);
        if !js::trim(&system).is_empty() {
            put(
                &mut request,
                "systemInstruction",
                json!({"parts":[{"text":system}]}),
            );
        }
    }
    let mut config = Map::new();
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
            let schema = deep::Owned(Value::Object(f.schema));
            let (pruned, notes) = match super::schema::try_prune(&schema) {
                Ok(result) => result,
                Err(error) => {
                    deep::drop_map(request);
                    deep::drop_map(config);
                    return Err(error);
                }
            };
            for n in notes {
                note(n);
            }
            put(&mut config, "responseSchema", pruned);
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
    if !config.is_empty() {
        put(&mut request, "generationConfig", Value::Object(config));
    }
    if let Some(tools) = &req.tools {
        if tools.iter().any(|t| !matches!(t, ToolDef::Portable(_))) {
            note("antigravity:provider-tool-dropped".into());
        }
        let mut seen = HashSet::new();
        let mut named = Vec::new();
        for tool in tools {
            if let ToolDef::Portable(t) = tool {
                let name = cloak.name(&t.name);
                if seen.contains(name) {
                    note("antigravity:duplicate-tool-dropped".into());
                } else {
                    seen.extend([name]);
                    named.push((name, t));
                }
            }
        }
        if !cloak.to_wire.is_empty() {
            note("antigravity:tool-name-renamed".into());
        }
        let mut declarations = Vec::new();
        for (name, t) in named {
            let mut m = Map::new();
            put(&mut m, "name", json!(name));
            if let Some(d) = &t.description {
                put(&mut m, "description", json!(d));
            }
            let (schema, notes) = match super::schema::try_prune(&t.input_schema) {
                Ok(result) => result,
                Err(error) => {
                    // Earlier messages, response schemas and declarations may
                    // contain opaque client values at the full ingress depth.
                    deep::drop_map(request);
                    deep::drop(Value::Array(declarations));
                    return Err(error);
                }
            };
            for n in notes {
                note(n);
            }
            put(&mut m, "parameters", schema);
            declarations.push(Value::Object(m));
        }
        if !declarations.is_empty() {
            let mut m = Map::new();
            put(&mut m, "functionDeclarations", Value::Array(declarations));
            put(&mut request, "tools", Value::Array(vec![Value::Object(m)]));
        }
    }
    if let Some(choice) = &req.tool_choice {
        let config = match choice {
            ToolChoice::Auto => json!({"mode":"AUTO"}),
            ToolChoice::Any => json!({"mode":"ANY"}),
            ToolChoice::None => json!({"mode":"NONE"}),
            ToolChoice::Tool { name } => {
                json!({"mode":"ANY","allowedFunctionNames":[cloak.name(name)]})
            }
        };
        put(
            &mut request,
            "toolConfig",
            json!({"functionCallingConfig":config}),
        );
    }
    js::object_assign(&mut request, req.vendor_value("antigravity"));
    let mut body = Map::new();
    for (k, v) in [
        ("project", project),
        ("requestId", request_id),
        ("model", model),
        ("userAgent", "antigravity"),
        ("requestType", "agent"),
    ] {
        put(&mut body, k, json!(v));
    }
    put(&mut body, "request", Value::Object(request));
    Ok((Value::Object(body), notes))
}
