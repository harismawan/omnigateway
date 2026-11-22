//! Responses-lite assembly, with positional provenance in place of WeakMap identity.
#![allow(dead_code)] // Connected by the OAuth wire builder in the next checkpoint.
use omni_crypto::codex;
use omni_ir::{deep, js, jsjson};
use serde::Deserialize;
use serde_json::{Value, json};
const META: &str = "internal_chat_message_metadata_passthrough";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiteArgs {
    pub(crate) thread_id: String,
    pub(crate) input: Vec<Value>,
    pub(crate) tools: Option<Vec<Value>>,
    pub(crate) instructions: Option<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) started_at: Option<f64>,
    pub(crate) id_salt: Option<String>,
    pub(crate) lite: bool,
    pub(crate) effort_update: Option<String>,
}
impl Drop for LiteArgs {
    fn drop(&mut self) {
        for v in std::mem::take(&mut self.input) {
            deep::drop(v);
        }
        for v in self.tools.take().into_iter().flatten() {
            deep::drop(v);
        }
    }
}
fn put(v: &mut Value, key: &str, value: Value) {
    if let Some(m) = v.as_object_mut() {
        deep::insert(m, key.into(), value);
    }
}

pub(crate) fn to_lite(
    args: &LiteArgs,
    turns: &[Option<usize>],
    tool_parts: &[Vec<usize>],
) -> deep::Owned {
    deep::scope(|| {
        let at = codex::thread_instant(&args.thread_id, args.started_at.unwrap_or(f64::INFINITY));
        let started = args.started_at.unwrap_or(at);
        let salt = args.id_salt.as_deref();
        let turn_id = |index: usize| {
            #[allow(clippy::cast_precision_loss)]
            codex::uuid_v7_from(
                &codex::keyed(salt, &format!("{}:turn:{index}", args.thread_id)),
                at + index as f64,
            )
        };
        let namespace = codex::prefix_namespace(&args.thread_id);
        let mut out = Vec::new();
        if let Some(tools) = &args.tools
            && !tools.is_empty()
        {
            let mut namespace_tools =
                json!({"type":"namespace","name":"functions","description":""});
            put(
                &mut namespace_tools,
                "tools",
                Value::Array(tools.iter().map(deep::clone).collect()),
            );
            let tools = deep::Owned(Value::Array(vec![namespace_tools]));
            let mut prefix = json!({"type":"additional_tools","id":format!("at_{}",codex::uuid_v5(&namespace,&jsjson::to_string(&tools.0))),"role":"developer"});
            put(&mut prefix, "tools", deep::clone(&tools.0));
            out.push(prefix);
        }
        if let Some(text) = &args.instructions
            && !text.is_empty()
        {
            let mut metadata = json!({"turn_id":turn_id(0),"create_time":started / 1000.0,"content_item_kinds":["model.base_instructions"]});
            if args.lite {
                put(
                    &mut metadata,
                    "content_item_metadata",
                    json!([{"provenance":{"type":"harness","hook":false}}]),
                );
            }
            out.push(json!({"type":"message","id":format!("msg_{}",codex::uuid_v5(&namespace,text)),"role":"developer","content":[{"type":"input_text","text":text}],META:metadata}));
        }
        let mut history = Vec::new();
        let mut turn = 0;
        let mut after = 0;
        for (index, item) in args.input.iter().enumerate() {
            turn = turns.get(index).copied().flatten().unwrap_or(turn);
            let tid = turn_id(turn);
            let fresh = |prefix: &str| {
                format!(
                    "{prefix}_{}",
                    codex::uuid_v7_from(
                        &codex::keyed(
                            salt,
                            &format!(
                                "{}:item:{index}",
                                args.request_id.as_deref().unwrap_or(&args.thread_id)
                            )
                        ),
                        started
                    )
                )
            };
            #[allow(clippy::cast_precision_loss)]
            let time = (started * 1000.0 + index as f64) / 1_000_000.0;
            let is_tool = |j: usize| tool_parts.get(index).is_some_and(|v| v.contains(&j));
            let v = match item["type"].as_str() {
                Some("message") => {
                    let role = js::to_string(item.get("role"));
                    let assistant = role == "assistant";
                    let parts = item["content"].as_array();
                    if role == "user"
                        && parts.is_some_and(|p| p.iter().enumerate().any(|(j, _)| !is_tool(j)))
                    {
                        after = index + 1;
                    }
                    let kinds = parts.and_then(|parts| {
                        parts
                            .iter()
                            .map(|p| {
                                if assistant {
                                    Some("unknown")
                                } else {
                                    match p["type"].as_str() {
                                        Some("input_text") => Some("user.text"),
                                        Some("input_image") => Some("user.image"),
                                        _ => None,
                                    }
                                }
                            })
                            .collect::<Option<Vec<_>>>()
                    });
                    let mut meta = json!({"turn_id":tid});
                    if !assistant {
                        put(&mut meta, "create_time", json!(time));
                    }
                    if let Some(k) = kinds {
                        put(&mut meta, "content_item_kinds", json!(k));
                    }
                    if args.lite
                        && !assistant
                        && let Some(parts) = parts
                    {
                        put(&mut meta,"content_item_metadata",Value::Array(parts.iter().enumerate().map(|(j,_)|json!({"provenance":if is_tool(j){json!({"type":"tool"})}else if role=="user"{json!({"type":"user"})}else{json!({"type":"harness","hook":false})}})).collect()));
                    }
                    let mut content = deep::clone(&item["content"]);
                    if assistant && let Some(parts) = content.as_array_mut() {
                        for part in parts {
                            if part["type"] == "output_text" {
                                put(part, "annotations", json!([]));
                            }
                        }
                    }
                    let mut v = json!({"type":"message"});
                    if assistant {
                        put(&mut v, "status", json!("completed"));
                    }
                    put(&mut v, "id", json!(fresh("msg")));
                    put(&mut v, "role", json!(role));
                    if item.get("content").is_some() {
                        put(&mut v, "content", content);
                    }
                    put(&mut v, META, meta);
                    v
                }
                Some("function_call") => {
                    let mut v =
                        json!({"type":"function_call","status":"completed","id":fresh("fc")});
                    for key in ["name", "arguments", "call_id"] {
                        if let Some(value) = item.get(key) {
                            put(&mut v, key, deep::clone(value));
                        }
                    }
                    put(&mut v, META, json!({"turn_id":tid}));
                    v
                }
                Some("function_call_output") => {
                    let mut v = json!({"type":"function_call_output","id":fresh("fco")});
                    for key in ["call_id", "output"] {
                        if let Some(value) = item.get(key) {
                            put(&mut v, key, deep::clone(value));
                        }
                    }
                    put(&mut v, META, json!({"turn_id":tid,"create_time":time}));
                    v
                }
                Some("reasoning") => {
                    let mut v = deep::clone(item);
                    if let Some(m) = v.as_object_mut()
                        && let Some(old) = m.remove(META)
                    {
                        deep::drop(old);
                    }
                    put(&mut v, META, json!({"turn_id":tid}));
                    v
                }
                _ => deep::clone(item),
            };
            history.push(v);
        }
        if let Some(effort) = &args.effort_update {
            history.insert(
                after,
                json!({"type":"configuration_update","reasoning":{"effort":effort}}),
            );
        }
        out.extend(history);
        let mut result = json!({"input":null,"turnId":turn_id(turn),"startedAt":started});
        put(&mut result, "input", Value::Array(out));
        deep::Owned(result)
    })
}
