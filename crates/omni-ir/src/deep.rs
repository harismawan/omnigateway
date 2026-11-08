//! Deeply nested JSON, handled without overflowing the stack.
//!
//! `JSON.parse` in Bun accepts more than a million levels of nesting, and the
//! TS gateway carries a client's value that deep until it re-serializes it:
//! `JSON.stringify` throws `RangeError` past [`MAX_DEPTH`] levels (measured on
//! Bun 1.4.4, see the Task 5a report). So this crate accepts JSON up to
//! [`MAX_DEPTH`] containers deep and refuses anything deeper, deterministically,
//! before building a single value.
//!
//! `serde_json`'s own parse, `Clone`, `Drop` and `Serialize` recurse once per
//! level, which overflows a 2 MiB stack long before [`MAX_DEPTH`]. The helpers
//! here replace the first three on every path that can hold a client value:
//! - [`parse`] parses on a growable stack (`serde_stacker`);
//! - [`clone`] grows the stack as it descends ([`grow`]);
//! - [`drop`] and [`Owned`] tear a value down iteratively;
//! - every recursive function in this workspace that walks a client value
//!   wraps its descent in [`grow`].

use serde::Deserialize;
use serde_json::{Map, Value};

/// The deepest JSON value accepted, counted in nested arrays and objects.
///
/// `JSON.stringify` in Bun 1.4.4 writes a value 40000 containers deep and
/// throws `RangeError: Maximum call stack size exceeded` at 40001.
pub const MAX_DEPTH: usize = 40_000;

/// Remaining stack below which [`grow`] switches to a fresh segment.
const RED_ZONE: usize = 256 * 1024;
/// The size of each fresh segment.
const SEGMENT: usize = 4 * 1024 * 1024;

/// Runs `f` with at least [`RED_ZONE`] bytes of stack, moving to a new
/// segment first when the current one is nearly used. Wrap each level of a
/// recursion over client data in this.
pub fn grow<R>(f: impl FnOnce() -> R) -> R {
    stacker::maybe_grow(RED_ZONE, SEGMENT, f)
}

/// Why [`parse`] refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// Not JSON: where `JSON.parse` throws.
    Syntax,
    /// Valid JSON nested more than [`MAX_DEPTH`] containers deep.
    TooDeep,
}

/// The container depth of a JSON text, scanned without parsing it.
///
/// Brackets inside strings are skipped. Malformed input gets some number back;
/// the parse that follows decides whether it is JSON.
pub fn depth_of(text: &str) -> usize {
    let (mut depth, mut max) = (0usize, 0usize);
    let mut in_string = false;
    let mut escaped = false;
    for &b in text.as_bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                max = max.max(depth);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    max
}

/// `JSON.parse`, bounded at [`MAX_DEPTH`] and safe on any stack.
pub fn parse(text: &str) -> Result<Value, ParseError> {
    if depth_of(text) > MAX_DEPTH {
        return Err(ParseError::TooDeep);
    }
    let mut de = serde_json::Deserializer::from_str(text);
    de.disable_recursion_limit();
    let value = {
        let stacked = serde_stacker::Deserializer {
            de: &mut de,
            red_zone: RED_ZONE,
            stack_size: SEGMENT,
        };
        Value::deserialize(stacked).map_err(|_| ParseError::Syntax)?
    };
    match de.end() {
        Ok(()) => Ok(value),
        Err(_) => {
            drop(value);
            Err(ParseError::Syntax)
        }
    }
}

/// `value.clone()`, safe on any stack.
pub fn clone(value: &Value) -> Value {
    match value {
        Value::Array(items) => grow(|| Value::Array(items.iter().map(clone).collect())),
        Value::Object(map) => grow(|| Value::Object(clone_map(map))),
        other => other.clone(),
    }
}

/// `map.clone()`, safe on any stack.
pub fn clone_map(map: &Map<String, Value>) -> Map<String, Value> {
    map.iter().map(|(k, v)| (k.clone(), clone(v))).collect()
}

fn has_nested(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(|v| v.is_array() || v.is_object()),
        Value::Object(map) => map.values().any(|v| v.is_array() || v.is_object()),
        _ => false,
    }
}

/// Drops `value` iteratively, so its depth costs heap rather than stack.
pub fn drop(value: Value) {
    if !has_nested(&value) {
        return;
    }
    let mut pending = vec![value];
    while let Some(v) = pending.pop() {
        match v {
            Value::Array(items) => pending.extend(items),
            Value::Object(map) => pending.extend(map.into_iter().map(|(_, v)| v)),
            _ => {}
        }
    }
}

/// [`drop`] for a map.
pub fn drop_map(map: Map<String, Value>) {
    drop(Value::Object(map));
}

/// Takes the value out of `slot` and drops it with [`drop`].
pub fn drop_in_place(slot: &mut Value) {
    drop(std::mem::take(slot));
}

/// Takes the map out of `slot` and drops it with [`drop`].
pub fn drop_map_in_place(slot: &mut Map<String, Value>) {
    drop_map(std::mem::take(slot));
}

/// A value that drops itself with [`drop`]: hold a client body in one.
#[derive(Debug, Default)]
pub struct Owned(pub Value);

impl Owned {
    /// The value, which the caller now has to drop with [`drop`].
    pub fn into_inner(mut self) -> Value {
        std::mem::take(&mut self.0)
    }
}

impl std::ops::Deref for Owned {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.0
    }
}

impl std::ops::DerefMut for Owned {
    fn deref_mut(&mut self) -> &mut Value {
        &mut self.0
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        drop_in_place(&mut self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn depth_skips_strings_and_escapes() {
        assert_eq!(depth_of(r#"{"a":[1,{"b":"[[[\"]]"}]}"#), 3);
        assert_eq!(depth_of("0"), 0);
        assert_eq!(depth_of(r#""\\""#), 0);
    }

    #[test]
    fn parse_matches_json_parse_on_trailing_and_bad_input() {
        assert_eq!(parse(" [1] "), Ok(serde_json::json!([1])));
        assert_eq!(parse("[1] x"), Err(ParseError::Syntax));
        assert_eq!(parse("{"), Err(ParseError::Syntax));
        assert_eq!(parse(""), Err(ParseError::Syntax));
    }
}
