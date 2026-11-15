//! Cloud Code's protobuf Schema vocabulary, not general JSON Schema.
use omni_ir::{deep, js};
use serde_json::{Map, Value};
const TYPES: &[&str] = &[
    "string",
    "number",
    "integer",
    "boolean",
    "array",
    "object",
    "null",
    "type_unspecified",
];

/// Prunes schema positions to depth 24; free-value fields remain opaque.
pub fn prune(node: &Value) -> (Value, Vec<String>) {
    try_prune(node).expect("Object.entries requires a non-null schema root")
}

/// Object.entries throws for null roots; nested schema positions are guarded.
pub fn try_prune(node: &Value) -> Result<(Value, Vec<String>), crate::codec::BuildError> {
    if node.is_null() {
        return Err(crate::codec::BuildError::Throw);
    }
    let mut dropped = false;
    let out = walk(node, 0, &mut dropped);
    Ok((
        out,
        if dropped {
            vec!["antigravity:tool-schema-pruned".into()]
        } else {
            vec![]
        },
    ))
}
fn put(out: &mut Map<String, Value>, key: &str, value: Value) {
    deep::insert(out, key.into(), value);
}
fn sub(v: &Value, depth: usize, dropped: &mut bool) -> Option<Value> {
    if !v.is_object() || depth >= 24 {
        *dropped = true;
        None
    } else {
        Some(walk(v, depth + 1, dropped))
    }
}
fn walk(node: &Value, depth: usize, dropped: &mut bool) -> Value {
    // Array indices and string UTF-16 indices are all unknown keywords.
    if node.as_array().is_some_and(|a| !a.is_empty())
        || node.as_str().is_some_and(|s| !s.is_empty())
    {
        *dropped = true;
    }
    let mut out = Map::new();
    for (key, v) in node.as_object().into_iter().flatten() {
        match key.as_str() {
            "const" => {
                *dropped = true;
                if v.is_string() && node.get("enum").is_none() {
                    put(&mut out, "enum", Value::Array(vec![deep::clone(v)]));
                }
            }
            "type" => {
                let valid = |s: &str| TYPES.contains(&s.to_lowercase().as_str());
                if let Some(s) = v.as_str() {
                    if valid(s) {
                        put(&mut out, key, deep::clone(v));
                    } else {
                        *dropped = true;
                    }
                } else {
                    let named: Vec<_> = v
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .filter(|s| valid(s))
                        .collect();
                    let real: Vec<_> = named
                        .iter()
                        .filter(|s| !s.eq_ignore_ascii_case("null"))
                        .collect();
                    if v.as_array().is_none_or(|a| a.len() != named.len()) || real.len() != 1 {
                        *dropped = true;
                    }
                    if let Some(s) = real.first() {
                        put(&mut out, "type", Value::String((***s).into()));
                    }
                    if named.len() != real.len() {
                        put(&mut out, "nullable", Value::Bool(true));
                    }
                }
            }
            "properties" => {
                if let Some(m) = v.as_object() {
                    let mut props = Map::new();
                    for (name, member) in m {
                        if name.is_empty() {
                            *dropped = true;
                        } else if let Some(p) = sub(member, depth, dropped) {
                            put(&mut props, name, p);
                        }
                    }
                    put(&mut out, key, Value::Object(props));
                } else {
                    *dropped = true;
                }
            }
            "items" => {
                let member = if let Some(a) = v.as_array() {
                    *dropped = true;
                    a.first().unwrap_or(&Value::Null)
                } else {
                    v
                };
                if let Some(p) = sub(member, depth, dropped) {
                    put(&mut out, key, p);
                }
            }
            "anyOf" | "allOf" => {
                if let Some(a) = v.as_array() {
                    let arms = a.iter().filter_map(|v| sub(v, depth, dropped)).collect();
                    put(&mut out, key, Value::Array(arms));
                } else {
                    *dropped = true;
                }
            }
            "additionalProperties" => {
                if v.is_boolean() {
                    put(&mut out, key, deep::clone(v));
                } else if let Some(p) = sub(v, depth, dropped) {
                    put(&mut out, key, p);
                }
            }
            "format" | "title" | "description" | "pattern" => {
                if v.is_string() {
                    put(&mut out, key, deep::clone(v));
                } else {
                    *dropped = true;
                }
            }
            "enum" | "required" | "propertyOrdering" => {
                if v.is_string() {
                    put(&mut out, key, deep::clone(v));
                } else if let Some(a) = v.as_array() {
                    let kept: Vec<_> = a
                        .iter()
                        .filter(|v| v.is_string())
                        .map(deep::clone)
                        .collect();
                    if kept.len() != a.len() || kept.is_empty() {
                        *dropped = true;
                    }
                    if !kept.is_empty() {
                        put(&mut out, key, Value::Array(kept));
                    }
                } else {
                    *dropped = true;
                }
            }
            "minItems" | "maxItems" | "minLength" | "maxLength" | "minProperties"
            | "maxProperties" | "minimum" | "maximum" => {
                let whole = key != "minimum" && key != "maximum";
                let valid = if let Some(n) = v.as_f64() {
                    n.is_finite() && (!whole || n.fract() == 0.0)
                } else if let Some(s) = v.as_str() {
                    if whole {
                        let digits = s.strip_prefix('-').unwrap_or(s);
                        !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                    } else {
                        !js::trim(s).is_empty()
                            && js::try_to_number(Some(v)).is_ok_and(|n| n.is_finite())
                    }
                } else {
                    false
                };
                if valid {
                    put(&mut out, key, deep::clone(v));
                } else {
                    *dropped = true;
                }
            }
            "default" | "example" | "nullable" => put(&mut out, key, deep::clone(v)),
            _ => {
                *dropped = true;
            }
        }
    }
    let declared = out
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    for (want, fields) in [
        (
            "object",
            &["properties", "required", "propertyOrdering"][..],
        ),
        ("array", &["items"][..]),
    ] {
        if !fields.iter().any(|f| out.contains_key(*f)) || declared.as_deref() == Some(want) {
            continue;
        }
        if declared.is_none() {
            put(&mut out, "type", Value::String(want.into()));
        } else {
            *dropped = true;
            for f in fields {
                if let Some(v) = out.shift_remove(*f) {
                    deep::drop(v);
                }
            }
        }
    }
    for key in ["required", "propertyOrdering"] {
        if let Some(Value::Array(names)) = out.get(key) {
            let kept: Vec<_> = names
                .iter()
                .filter(|n| {
                    n.as_str().is_some_and(|n| {
                        out.get("properties")
                            .and_then(Value::as_object)
                            .is_some_and(|p| p.contains_key(n))
                    })
                })
                .map(deep::clone)
                .collect();
            if kept.len() != names.len() {
                *dropped = true;
                if kept.is_empty() {
                    if let Some(v) = out.shift_remove(key) {
                        deep::drop(v);
                    }
                } else {
                    put(&mut out, key, Value::Array(kept));
                }
            }
        }
    }
    if out.get("type").and_then(Value::as_str) == Some("array") && !out.contains_key("items") {
        *dropped = true;
        out.shift_remove("type");
    }
    Value::Object(out)
}
