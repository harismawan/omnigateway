//! Structured output and final vendor merge, in TS wire assembly order.
use crate::response_format::{ResponseFormatRead, read_response_format, readable_format};
use omni_ir::request::ChatRequest;
use serde_json::{Value, json};

pub(super) fn merge(
    body: &mut Value,
    req: &ChatRequest,
    budget: bool,
    preserve: bool,
    notes: &mut Vec<String>,
) {
    let mut note = |s: &str| {
        let s = format!("anthropic:{s}");
        if !notes.contains(&s) {
            notes.push(s);
        }
    };
    let mut vendor = req
        .vendor_bag("anthropic")
        .map(omni_ir::deep::clone_map)
        .unwrap_or_default();
    let original_system = vendor.get("system").cloned();
    let current_system = body
        .get("system")
        .cloned()
        .or_else(|| req.system.as_ref().map(|_| json!([])));
    let native = vendor.get("output_config").and_then(|v| v.get("format"));
    if !readable_format(native) {
        match read_response_format(req) {
            ResponseFormatRead::Readable(f) => {
                if !body["output_config"].is_object() {
                    omni_ir::deep::replace(&mut body["output_config"], json!({}));
                }
                omni_ir::deep::replace(
                    &mut body["output_config"]["format"],
                    json!({"type":"json_schema","schema":f.schema}),
                );
                note("response-format-translated");
            }
            ResponseFormatRead::TooDeep => note("response-schema-too-deep"),
            _ => (),
        }
    }
    if let Some(Value::Object(mut extras)) = vendor.shift_remove("thinking")
        && let Some(thinking) = body.get("thinking").and_then(Value::as_object)
    {
        extras.extend(thinking.clone());
        omni_ir::deep::replace(&mut body["thinking"], Value::Object(extras));
    }
    let mut unreadable = false;
    if let Some(encoder) = body
        .get("output_config")
        .and_then(Value::as_object)
        .cloned()
        && let Some(config) = vendor.get("output_config").map(omni_ir::deep::clone)
    {
        if let Value::Object(mut config) = config {
            if !readable_format(config.get("format")) {
                unreadable = config.shift_remove("format").is_some();
            }
            let mut merged = encoder;
            merged.extend(config);
            omni_ir::deep::insert(&mut vendor, "output_config".into(), Value::Object(merged));
        } else {
            vendor.shift_remove("output_config");
            unreadable = true;
        }
    }
    if budget
        && let Some(config) = vendor
            .get_mut("output_config")
            .and_then(Value::as_object_mut)
        && config.shift_remove("effort").is_some()
    {
        note("effort-unsupported");
        if config.is_empty() {
            vendor.shift_remove("output_config");
        }
    }
    body.as_object_mut().expect("body").extend(vendor);
    if preserve && let (Some(original), Some(system)) = (original_system, current_system) {
        let unchanged = original.is_string()
            && system.as_array().is_some_and(|s| {
                s.len() == 1 && s[0]["text"] == original && s[0].get("cache_control").is_none()
            });
        if !unchanged {
            omni_ir::deep::replace(&mut body["system"], system);
        }
    }
    if unreadable {
        note("response-format-dropped");
    }
    if let Some(schema) = body
        .pointer_mut("/output_config/format/schema")
        .filter(|v| v.is_object())
    {
        let mut changed = false;
        let mut truncated = false;
        close(schema, 0, &mut changed, &mut truncated);
        if truncated {
            body["output_config"]
                .as_object_mut()
                .expect("config")
                .shift_remove("format");
            note("response-schema-too-deep");
        } else if changed {
            note("response-schema-closed");
        }
    }
    let off = body
        .get("thinking")
        .is_some_and(|t| !matches!(t["type"].as_str(), Some("adaptive" | "enabled")));
    if off
        && let Some(config) = body
            .get_mut("context_management")
            .and_then(Value::as_object_mut)
        && let Some(edits) = config.get_mut("edits").and_then(Value::as_array_mut)
    {
        let len = edits.len();
        edits.retain(|e| e["type"] != "clear_thinking_20251015");
        if len != edits.len() {
            note("clear-thinking-unsupported");
            if edits.is_empty() && config.len() == 1 {
                body.as_object_mut()
                    .expect("body")
                    .shift_remove("context_management");
            }
        }
    }
}

fn close(value: &mut Value, depth: usize, changed: &mut bool, truncated: &mut bool) {
    let Some(schema) = value.as_object_mut() else {
        return;
    };
    if depth >= 64 {
        *truncated = true;
        return;
    }
    for (key, v) in schema.iter_mut() {
        match key.as_str() {
            "properties" | "patternProperties" | "$defs" | "definitions" | "dependentSchemas"
            | "dependencies" => {
                if let Some(m) = v.as_object_mut() {
                    for child in m.values_mut() {
                        close(child, depth + 1, changed, truncated);
                    }
                }
            }
            "items"
            | "additionalItems"
            | "additionalProperties"
            | "contains"
            | "contentSchema"
            | "if"
            | "then"
            | "else"
            | "not"
            | "propertyNames"
            | "unevaluatedItems"
            | "unevaluatedProperties"
            | "anyOf"
            | "allOf"
            | "oneOf"
            | "prefixItems" => {
                if let Some(a) = v.as_array_mut() {
                    if ["items", "anyOf", "allOf", "oneOf", "prefixItems"].contains(&key.as_str()) {
                        for child in a {
                            close(child, depth + 1, changed, truncated);
                        }
                    }
                } else if !["anyOf", "allOf", "oneOf", "prefixItems"].contains(&key.as_str()) {
                    close(v, depth + 1, changed, truncated);
                }
            }
            _ => (),
        }
    }
    if schema.get("type").and_then(Value::as_str) == Some("object")
        && schema.get("additionalProperties") != Some(&Value::Bool(false))
    {
        omni_ir::deep::insert(schema, "additionalProperties".into(), Value::Bool(false));
        *changed = true;
    }
}
