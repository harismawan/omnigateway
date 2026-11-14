use omni_ir::{
    deep, jsjson,
    request::{
        CONTEXT_1M_BETA, ChatRequest, ContentBlock, ReasoningConfig, ReasoningDisplay, Role,
        ToolChoice, ToolDef,
    },
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
fn note(notes: &mut Vec<String>, s: impl Into<String>) {
    let s = s.into();
    if !notes.contains(&s) {
        notes.push(s);
    }
}
fn uuid(s: &str) -> bool {
    super::identity::is_uuid(s)
}
fn thread(seed: &str) -> String {
    let hash = Sha256::digest(format!("thread:{seed}"));
    let offset = hash[..6].iter().fold(0u64, |v, b| v * 256 + u64::from(*b)) % 31_536_000_000;
    let ts = 1_790_812_800_000u64 - 31_536_000_000 + offset;
    let hash = Sha256::digest(seed);
    let hex = format!(
        "{ts:012x}{:04x}{:04x}{}",
        (u16::from_be_bytes([hash[6], hash[7]]) & 0x0fff) | 0x7000,
        (u16::from_be_bytes([hash[8], hash[9]]) & 0x3fff) | 0x8000,
        hash[10..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
pub(crate) fn encode(req: &ChatRequest, model: &str) -> (Map<String, Value>, Vec<String>, String) {
    let mut notes = Vec::new();
    let mut input = Vec::new();
    if req
        .betas
        .as_ref()
        .is_some_and(|b| b.iter().any(|x| x == CONTEXT_1M_BETA))
    {
        note(&mut notes, "openai:context-1m-dropped");
    }
    for message in &req.messages {
        let role = if message.role == Role::System {
            note(&mut notes, "openai:system-turn-as-developer");
            "developer"
        } else {
            message.role.as_str()
        };
        let mut parts = Vec::new();
        let flush = |parts: &mut Vec<Value>, input: &mut Vec<Value>| {
            if !parts.is_empty() {
                let mut m = Map::new();
                deep::insert(&mut m, "type".into(), json!("message"));
                deep::insert(&mut m, "role".into(), json!(role));
                deep::insert(
                    &mut m,
                    "content".into(),
                    Value::Array(std::mem::take(parts)),
                );
                input.push(Value::Object(m));
            }
        };
        for block in &message.content {
            match block {
 ContentBlock::Text(t)=>parts.push(json!({"type":if role=="assistant"{"output_text"}else{"input_text"},"text":t.text})),
 ContentBlock::Image(i)=>parts.push(json!({"type":"input_image","image_url":format!("data:{};base64,{}",i.media_type,i.data)})),
 ContentBlock::Thinking(_)=>note(&mut notes,"openai:thinking-dropped"),
 ContentBlock::ToolUse(u)=>{flush(&mut parts,&mut input);input.push(json!({"type":"function_call","call_id":u.id,"name":u.name,"arguments":jsjson::to_string(&u.input)}));},
 ContentBlock::ToolResult(r)=>{
 if r.native.is_some(){note(&mut notes,"openai:anthropic-native-block-dropped");}flush(&mut parts,&mut input);
 let files=crate::tool_result_files::responses_files(r.files.as_deref().unwrap_or_default());
 input.push(json!({"type":"function_call_output","call_id":r.tool_use_id,"output":crate::tool_result_files::with_file_text(&r.content,&files.text)}));
 if let Some(images)=&r.images{note(&mut notes,"openai:tool-result-images-moved");for i in images{parts.push(json!({"type":"input_image","image_url":format!("data:{};base64,{}",i.media_type,i.data)}));}}
 if !files.parts.is_empty(){note(&mut notes,"openai:tool-result-files-moved");parts.extend(files.parts);}
 if !files.text.is_empty(){note(&mut notes,"openai:tool-result-files-inlined");}
 if files.dropped{note(&mut notes,"openai:files-dropped");}
 },
 ContentBlock::ProviderNative(n)=>{if n.provider=="openai"{flush(&mut parts,&mut input);let mut m=Map::new();deep::insert(&mut m,"type".into(),json!(n.block_type));for(k,v)in &n.data{if k!="id"{deep::insert(&mut m,k.clone(),deep::clone(v));}}input.push(Value::Object(m));}else{note(&mut notes,"openai:anthropic-native-block-dropped");}}
 }
        }
        flush(&mut parts, &mut input);
    }
    let answered: Vec<String> = input
        .iter()
        .filter(|v| v["type"] == "function_call_output")
        .filter_map(|v| v["call_id"].as_str().map(str::to_owned))
        .collect();
    let mut repaired = Vec::new();
    for item in input {
        let missing = (item["type"] == "function_call")
            .then(|| item["call_id"].as_str())
            .flatten()
            .filter(|id| !answered.iter().any(|a| a == id))
            .map(str::to_owned);
        repaired.push(item);
        if let Some(id) = missing {
            repaired.push(json!({"type":"function_call_output","call_id":id,"output":""}));
        }
    }
    let instructions = crate::system::system_text(req.system.as_deref(), "openai", &mut |s| {
        note(&mut notes, s)
    });
    let supplied = req.vendor_bag("openai").and_then(|v| {
        ["prompt_cache_key", "session_id"]
            .into_iter()
            .find_map(|k| {
                v.get(k).and_then(Value::as_str).filter(|s| {
                    !s.is_empty() && s.len() <= 1024 && s.bytes().all(|b| (33..=126).contains(&b))
                })
            })
    });
    let seed = if let Some(s) = supplied {
        jsjson::to_string(&json!({"key":s}))
    } else if let Some(c) = req.conversation_id.as_ref().filter(|c| !c.is_empty()) {
        jsjson::to_string(&json!({"conversation":c}))
    } else {
        let mut m = Map::new();
        deep::insert(
            &mut m,
            "instructions".into(),
            json!(instructions.as_deref().unwrap_or("")),
        );
        deep::insert(
            &mut m,
            "firstInput".into(),
            repaired.first().map(deep::clone).unwrap_or(Value::Null),
        );
        let v = deep::Owned(Value::Object(m));
        jsjson::to_string(&v.0)
    };
    let key = supplied
        .filter(|s| uuid(s))
        .map(str::to_owned)
        .unwrap_or_else(|| thread(&seed));
    let mut body = Map::new();
    deep::insert(&mut body, "model".into(), json!(model));
    deep::insert(&mut body, "input".into(), Value::Array(repaired));
    deep::insert(&mut body, "stream".into(), json!(req.stream));
    deep::insert(&mut body, "store".into(), json!(false));
    if let Some(s) = instructions.filter(|s| !s.is_empty()) {
        deep::insert(&mut body, "instructions".into(), json!(s));
    }
    if let Some(n) = req.max_tokens {
        deep::insert(
            &mut body,
            "max_output_tokens".into(),
            omni_ir::stream::number(n),
        );
    }
    if let Some(n) = req.temperature {
        deep::insert(&mut body, "temperature".into(), omni_ir::stream::number(n));
    }
    if let Some(tools) = &req.tools {
        let mut out = Vec::new();
        for t in tools {
            if let ToolDef::Portable(t) = t {
                let mut m = Map::new();
                deep::insert(&mut m, "type".into(), json!("function"));
                deep::insert(&mut m, "name".into(), json!(t.name));
                if let Some(d) = &t.description {
                    deep::insert(&mut m, "description".into(), json!(d));
                }
                deep::insert(&mut m, "parameters".into(), deep::clone(&t.input_schema));
                out.push(Value::Object(m));
            }
        }
        if out.len() != tools.len() {
            note(&mut notes, "openai:anthropic-tool-dropped");
        }
        deep::insert(&mut body, "tools".into(), Value::Array(out));
    }
    if let Some(c) = &req.tool_choice {
        deep::insert(
            &mut body,
            "tool_choice".into(),
            match c {
                ToolChoice::Auto => json!("auto"),
                ToolChoice::Any => json!("required"),
                ToolChoice::None => json!("none"),
                ToolChoice::Tool { name } => json!({"type":"function","name":name}),
            },
        );
    }
    match &req.reasoning {
        Some(ReasoningConfig::BetweenTools) => {
            note(&mut notes, "openai:reasoning-between-tools-as-off")
        }
        Some(ReasoningConfig::Budget { .. }) => note(&mut notes, "openai:reasoning-budget-dropped"),
        Some(ReasoningConfig::Adaptive {
            effort, display, ..
        }) => {
            let mut r = Map::new();
            deep::insert(
                &mut r,
                "effort".into(),
                json!(effort.map_or("medium", |e| e.as_str())),
            );
            if !matches!(
                display,
                Some(ReasoningDisplay::Omitted | ReasoningDisplay::Updates)
            ) {
                deep::insert(&mut r, "summary".into(), json!("auto"));
            }
            deep::insert(&mut body, "reasoning".into(), Value::Object(r));
        }
        _ => {}
    }
    omni_ir::js::object_assign(&mut body, req.vendor_value("openai"));
    if let Some(n) = crate::response_format::move_to_responses_text(req, &mut body, "openai") {
        note(&mut notes, n);
    }
    deep::insert(&mut body, "prompt_cache_key".into(), json!(key));
    (body, notes, key)
}
#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    #[test]
    fn wire_order_matches_real_ts() {
        let run = std::process::Command::new("bun")
            .arg("tests/openai-request-reference.ts")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .unwrap();
        assert!(run.status.success());
        let rows: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap();
        for row in rows.as_array().unwrap() {
            let req = serde_json::from_value(row["request"].clone()).unwrap();
            omni_ir::deep::scope(|| {
                let (body, notes, key) = super::encode(&req, row["model"].as_str().unwrap());
                let body = omni_ir::deep::Owned(serde_json::Value::Object(body));
                assert_eq!(
                    omni_ir::jsjson::to_string(&body.0),
                    row["wire"].as_str().unwrap()
                );
                assert_eq!(serde_json::json!(notes), row["notes"]);
                assert_eq!(key, row["key"].as_str().unwrap());
            });
        }
    }
}
