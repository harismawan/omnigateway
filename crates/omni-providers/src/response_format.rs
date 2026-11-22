//! The structured-output request in whichever spelling the client used
//! (the parts the OpenAI-shaped encoders use: the reader and the
//! responses-text move).
//!
//! The IR here is parsed JSON, so the cycle and serializability checks needed
//! for in-process plugin values cannot fire and are not implemented; the
//! depth cap, which can, is.
//!
//! Mutation helpers are crate-private; callers use a scoped provider codec.
//! ```compile_fail
//! use omni_providers::response_format::move_to_responses_text;
//! ```

use omni_ir::request::ChatRequest;
use serde_json::{Map, Value, json};

/// The client's schema and its name for it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResponseFormat {
    pub schema: Map<String, Value>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ResponseFormatRead {
    Absent,
    Malformed,
    TooDeep,
    Readable(ResponseFormat),
}

/// `MAX_DEPTH`: the schema levels `JSON.stringify` in every codec is trusted
/// to render.
const MAX_DEPTH: usize = 64;

const SUBSCHEMA: [&str; 12] = [
    "items",
    "additionalItems",
    "additionalProperties",
    "contains",
    "contentSchema",
    "if",
    "then",
    "else",
    "not",
    "propertyNames",
    "unevaluatedItems",
    "unevaluatedProperties",
];
const SUBSCHEMA_LIST: [&str; 5] = ["anyOf", "allOf", "oneOf", "prefixItems", "items"];
const SUBSCHEMA_MAP: [&str; 6] = [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
];

/// `isRecord`: an object that is not an array.
pub(crate) fn is_record(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}

/// `readResponseFormatResult`.
pub(crate) fn read_response_format(req: &ChatRequest) -> ResponseFormatRead {
    let openai = req.vendor_value("openai");
    let chat = omni_ir::js::prop(openai, "response_format");
    if let Some(chat) = chat {
        let Value::Object(chat) = chat else {
            return ResponseFormatRead::Malformed;
        };
        if chat.get("type").and_then(Value::as_str) != Some("json_schema") {
            return ResponseFormatRead::Malformed;
        }
        return from_spec(chat.get("json_schema"));
    }
    let responses = omni_ir::js::prop(openai, "text");
    if let Some(Value::Object(text)) = responses
        && let Some(format) = text.get("format")
    {
        return from_spec(Some(format));
    }
    if responses.is_some() {
        return ResponseFormatRead::Malformed;
    }
    let messages = omni_ir::js::prop(req.vendor_value("anthropic"), "output_config");
    if let Some(Value::Object(config)) = messages
        && let Some(format) = config.get("format")
    {
        return from_spec(Some(format));
    }
    if messages.is_some() {
        return ResponseFormatRead::Malformed;
    }
    ResponseFormatRead::Absent
}

/// `readableFormat`: structural only.
pub(crate) fn readable_format(spec: Option<&Value>) -> bool {
    let Some(Value::Object(spec)) = spec else {
        return false;
    };
    let type_ok = match spec.get("type") {
        None => true,
        Some(t) => t.as_str() == Some("json_schema"),
    };
    type_ok && is_record(spec.get("schema"))
}

fn from_spec(spec: Option<&Value>) -> ResponseFormatRead {
    if !readable_format(spec) {
        return ResponseFormatRead::Malformed;
    }
    let Some(Value::Object(spec)) = spec else {
        return ResponseFormatRead::Malformed;
    };
    let Some(Value::Object(schema)) = spec.get("schema") else {
        return ResponseFormatRead::Malformed;
    };
    if too_deep(schema) {
        return ResponseFormatRead::TooDeep;
    }
    let name = match spec.get("name") {
        Some(Value::String(n)) if !n.is_empty() => n.clone(),
        _ => "response".to_string(),
    };
    ResponseFormatRead::Readable(ResponseFormat {
        schema: omni_ir::deep::clone_map(schema),
        name,
    })
}

/// Every subschema member of `node`, in the positions `forEachSubschema` walks.
fn subschemas<'a>(node: &'a Map<String, Value>, visit: &mut impl FnMut(&'a Map<String, Value>)) {
    for (key, value) in node {
        let key = key.as_str();
        if SUBSCHEMA_MAP.contains(&key)
            && let Value::Object(members) = value
        {
            for member in members.values() {
                if let Value::Object(m) = member {
                    visit(m);
                }
            }
        } else if SUBSCHEMA_LIST.contains(&key)
            && let Value::Array(members) = value
        {
            for member in members {
                if let Value::Object(m) = member {
                    visit(m);
                }
            }
        } else if SUBSCHEMA.contains(&key)
            && let Value::Object(m) = value
        {
            visit(m);
        }
    }
}

/// `tooDeepToSerialize`: whether a chain of [`MAX_DEPTH`] subschema steps
/// exists. Level by level and iterative, so no input can overflow the stack.
fn too_deep(schema: &Map<String, Value>) -> bool {
    let mut level: Vec<&Map<String, Value>> = vec![schema];
    for _ in 0..MAX_DEPTH {
        let mut next = Vec::new();
        for node in &level {
            subschemas(node, &mut |m| next.push(m));
        }
        if next.is_empty() {
            return false;
        }
        level = next;
    }
    true
}

/// Moves a structured-output request onto a
/// Responses-shaped body. Returns the degradation to record, if any.
pub(crate) fn move_to_responses_text(
    req: &ChatRequest,
    body: &mut Map<String, Value>,
    provider: &str,
) -> Option<String> {
    move_to_responses_text_with_prototype(req, body, provider, &Value::Null)
}

/// Plain reads of the merged OpenAI body see its JSON prototype; spreads and
/// serialization still use only the own map. JSON arrays have no named fields
/// used here (neither indices nor `length` are read). Default Object.prototype
/// and a null prototype likewise have none of the fields read by these callers.
pub(crate) fn prototype_get<'a>(
    body: &'a Map<String, Value>,
    prototype: &'a Value,
    key: &str,
) -> Option<&'a Value> {
    body.get(key).or_else(|| prototype.as_object()?.get(key))
}

pub(crate) fn move_to_responses_text_with_prototype(
    req: &ChatRequest,
    body: &mut Map<String, Value>,
    provider: &str,
    prototype: &Value,
) -> Option<String> {
    // Internal helper: CustomCodec scopes deep request assembly. Keeping this
    // private avoids repeating its carrier scan on every ordinary request.
    let raw = body.shift_remove("response_format").or_else(|| {
        prototype
            .as_object()?
            .get("response_format")
            .map(omni_ir::deep::clone)
    });

    let malformed_text = prototype_get(body, prototype, "text").is_some_and(|t| !t.is_object());
    if malformed_text {
        body.shift_remove("text");
    }

    let read = read_response_format(req);
    let client_text = prototype_get(body, prototype, "text")
        .and_then(Value::as_object)
        .map(omni_ir::deep::clone_map);
    let client_format = client_text.as_ref().and_then(|t| t.get("format"));
    if readable_format(client_format) && matches!(read, ResponseFormatRead::Readable(_)) {
        return None;
    }
    let malformed_format = client_text.is_some() && client_format.is_some();
    let text = client_text.as_ref().map(|t| {
        let mut copy = omni_ir::deep::clone_map(t);
        copy.shift_remove("format");
        copy
    });
    if malformed_format && let Some(text) = &text {
        omni_ir::deep::insert(
            body,
            "text".into(),
            Value::Object(omni_ir::deep::clone_map(text)),
        );
    }

    match read {
        ResponseFormatRead::Readable(format) => {
            let mut next = text.unwrap_or_default();
            let mut spec = Map::new();
            omni_ir::deep::insert(&mut spec, "type".into(), json!("json_schema"));
            omni_ir::deep::insert(&mut spec, "name".into(), json!(format.name));
            omni_ir::deep::insert(&mut spec, "schema".into(), Value::Object(format.schema));
            omni_ir::deep::insert(&mut spec, "strict".into(), Value::Bool(true));
            omni_ir::deep::insert(&mut next, "format".into(), Value::Object(spec));
            omni_ir::deep::insert(body, "text".into(), Value::Object(next));
            Some(format!("{provider}:response-format-translated"))
        }
        _ if raw
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|r| r.get("type").and_then(Value::as_str) == Some("json_object")) =>
        {
            let mut next = text.unwrap_or_default();
            omni_ir::deep::insert(&mut next, "format".into(), json!({ "type": "json_object" }));
            omni_ir::deep::insert(body, "text".into(), Value::Object(next));
            Some(format!("{provider}:response-format-translated"))
        }
        ResponseFormatRead::TooDeep => Some(format!("{provider}:response-schema-too-deep")),
        _ if raw.is_some() || malformed_text || malformed_format => {
            Some(format!("{provider}:response-format-dropped"))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_json_on_small_stack() {
        const CHILD: &str = "OMNI_RESPONSE_FORMAT_DEPTH_CHILD";
        if std::env::var_os(CHILD).is_some() {
            std::thread::Builder::new()
                .stack_size(2 * 1024 * 1024)
                .spawn(|| {
                    let req = serde_json::from_str::<ChatRequest>(
                        r#"{"model":"m","messages":[],"stream":true}"#,
                    )
                    .expect("request");
                    let mut value = Value::Null;
                    for _ in 0..39_990 {
                        value = Value::Array(vec![value]);
                    }
                    let mut body = Map::new();
                    omni_ir::deep::insert(&mut body, "text".into(), value);
                    assert_eq!(
                        omni_ir::deep::scope(|| move_to_responses_text(&req, &mut body, "custom")),
                        Some("custom:response-format-dropped".into())
                    );
                    omni_ir::deep::drop_map(body);
                })
                .expect("spawn")
                .join()
                .expect("join");
            return;
        }
        let status = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args([
                "--exact",
                "response_format::tests::removed_json_on_small_stack",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .status()
            .expect("child");
        assert!(status.success(), "deep removal child: {status}");
    }

    fn nested(levels: usize) -> Value {
        let mut node = json!({"type": "string"});
        for _ in 0..levels {
            node = json!({"type": "object", "properties": {"n": node}});
        }
        node
    }

    #[test]
    fn the_depth_cap_sits_at_sixty_four_subschema_levels() {
        let deep = nested(64);
        let shallow = nested(63);
        assert!(too_deep(deep.as_object().expect("object")));
        assert!(!too_deep(shallow.as_object().expect("object")));
    }

    #[test]
    fn a_property_named_like_a_position_is_data_not_a_schema() {
        // `properties.items` is a property *named* items: it is still visited
        // as a member of `properties`, but its own `items` key is not a list.
        let schema = json!({"properties": {"items": {"type": "string", "items": 5}}});
        assert!(!too_deep(schema.as_object().expect("object")));
    }
}
