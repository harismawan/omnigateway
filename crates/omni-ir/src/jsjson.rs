//! A JSON writer that reproduces JavaScript's `JSON.stringify` byte for byte.
//!
//! Bodies sent upstream are hashed (`cch=`), cached by key (`prompt_cache_key`)
//! and fingerprinted, all over the exact bytes the TS build produced with
//! `JSON.stringify`. `serde_json` differs from it in three observable ways:
//!
//! - **Numbers.** JS prints the shortest round-trip digits using
//!   `Number.prototype.toString` rules: `1e+21`, `1e-7`, `100` for `100.0`, and
//!   `0` for `-0`. `serde_json` prints `1.0`, `1e21`, `-0.0`.
//! - **Key order.** A JS object always enumerates canonical array-index keys
//!   (`"0"`, `"42"`) first, in ascending numeric order, then the remaining keys
//!   in insertion order. `serde_json` with `preserve_order` keeps pure insertion
//!   order.
//! - **Strings.** JS escapes lone surrogates as `\udXXX` and leaves U+2028,
//!   U+2029 and DEL literal; control characters use lowercase `\u00xx`.
//!
//! [`JsValue`] models what `JSON.stringify` can observe, including `undefined`,
//! functions and UTF-16 strings. [`write_value`] is the hot-path entry point
//! for a parsed [`serde_json::Value`], with no intermediate conversion.

/// A JavaScript value, as far as `JSON.stringify` can observe one.
///
/// Used by the conformance tests to model values `serde_json` cannot hold
/// (`undefined`, lone surrogates); the gateway itself writes `serde_json`
/// values. Conversion, `Clone` and `Drop` are stack-safe at any depth, like
/// the rest of `crate::deep`.
#[derive(Debug, PartialEq)]
pub enum JsValue {
    Undefined,
    Function,
    Null,
    Bool(bool),
    Number(f64),
    /// UTF-16 code units, so lone surrogates are representable.
    String(Vec<u16>),
    Array(Vec<JsValue>),
    /// Keys in insertion order, as UTF-16 code units. Enumeration order (array
    /// indices first) is applied when writing, as a JS engine does.
    Object(Vec<(Vec<u16>, JsValue)>),
}

impl From<&serde_json::Value> for JsValue {
    fn from(value: &serde_json::Value) -> Self {
        use serde_json::Value;
        match value {
            Value::Null => JsValue::Null,
            Value::Bool(b) => JsValue::Bool(*b),
            Value::Number(n) => JsValue::Number(number_as_f64(n)),
            Value::String(s) => JsValue::String(s.encode_utf16().collect()),
            Value::Array(items) => {
                crate::deep::grow(|| JsValue::Array(items.iter().map(JsValue::from).collect()))
            }
            Value::Object(map) => crate::deep::grow(|| {
                JsValue::Object(
                    map.iter()
                        .map(|(k, v)| (k.encode_utf16().collect(), JsValue::from(v)))
                        .collect(),
                )
            }),
        }
    }
}

impl Clone for JsValue {
    fn clone(&self) -> Self {
        match self {
            JsValue::Undefined => JsValue::Undefined,
            JsValue::Function => JsValue::Function,
            JsValue::Null => JsValue::Null,
            JsValue::Bool(b) => JsValue::Bool(*b),
            JsValue::Number(n) => JsValue::Number(*n),
            JsValue::String(units) => JsValue::String(units.clone()),
            JsValue::Array(items) => crate::deep::grow(|| JsValue::Array(items.clone())),
            JsValue::Object(entries) => crate::deep::grow(|| JsValue::Object(entries.clone())),
        }
    }
}

impl Drop for JsValue {
    /// Iterative: children are moved onto a heap stack before they drop, so
    /// each one drops with no nested containers left.
    fn drop(&mut self) {
        let mut pending: Vec<JsValue> = match self {
            JsValue::Array(items) if items.iter().any(JsValue::is_container) => {
                std::mem::take(items)
            }
            JsValue::Object(entries) if entries.iter().any(|(_, v)| v.is_container()) => {
                std::mem::take(entries)
                    .into_iter()
                    .map(|(_, v)| v)
                    .collect()
            }
            _ => return,
        };
        while let Some(mut v) = pending.pop() {
            match &mut v {
                JsValue::Array(items) => pending.append(items),
                JsValue::Object(entries) => {
                    pending.extend(std::mem::take(entries).into_iter().map(|(_, v)| v));
                }
                _ => {}
            }
        }
    }
}

impl JsValue {
    fn is_container(&self) -> bool {
        matches!(self, JsValue::Array(_) | JsValue::Object(_))
    }
}

/// `JSON.stringify(value)`; `None` where JS returns `undefined`.
pub fn stringify(value: &JsValue) -> Option<String> {
    let mut out = String::new();
    write_js(value, &mut out, None, 0).then_some(out)
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &JsValue) -> Option<String> {
    let mut out = String::new();
    write_js(value, &mut out, Some(2), 0).then_some(out)
}

/// `JSON.stringify(value)` for a parsed JSON value, written into `out`.
pub fn write_value(value: &serde_json::Value, out: &mut String) {
    write_serde(value, out, None, 0);
}

/// `JSON.stringify(value, null, 2)` for a parsed JSON value.
pub fn write_value_pretty(value: &serde_json::Value, out: &mut String) {
    write_serde(value, out, Some(2), 0);
}

/// Where a spread object puts the key written beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Spread {
    /// `{ [key]: value, ...map }`: the key comes first, and the map's own
    /// value for it (if any) wins.
    KeyFirst,
    /// `{ ...map, [key]: value }`: the given value wins, at the map's
    /// position for the key if it has one, else last.
    KeyLast,
}

/// `JSON.stringify` of a spread of `map` with one string key added, written
/// straight into `out` without building the merged object.
pub fn write_spread(
    map: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &str,
    spread: Spread,
    out: &mut String,
) {
    use serde_json::Value;
    enum Item<'a> {
        Map(&'a Value),
        Added,
    }
    let has = map.contains_key(key);
    if array_index(key).is_none() && !map.keys().any(|k| array_index(k).is_some()) {
        // No index keys: insertion order is enumeration order, so the pairs
        // stream straight out with nothing collected.
        out.push('{');
        let mut first = true;
        let mut pair = |k: &str, out: &mut String| {
            if !first {
                out.push(',');
            }
            first = false;
            write_str(k, out);
            out.push(':');
        };
        if spread == Spread::KeyFirst {
            pair(key, out);
            match map.get(key) {
                Some(v) => write_value(v, out),
                None => write_str(value, out),
            }
        }
        for (k, v) in map {
            if k == key {
                if spread == Spread::KeyLast {
                    pair(key, out);
                    write_str(value, out);
                }
                continue;
            }
            pair(k, out);
            write_value(v, out);
        }
        if spread == Spread::KeyLast && !has {
            pair(key, out);
            write_str(value, out);
        }
        out.push('}');
        return;
    }
    let mut items: Vec<(&str, Item<'_>)> = Vec::with_capacity(map.len() + 1);
    if spread == Spread::KeyFirst {
        items.push((
            key,
            if has {
                Item::Map(&map[key])
            } else {
                Item::Added
            },
        ));
    }
    for (k, v) in map {
        if k == key {
            if spread == Spread::KeyLast {
                items.push((key, Item::Added));
            }
            continue;
        }
        items.push((k.as_str(), Item::Map(v)));
    }
    if spread == Spread::KeyLast && !has {
        items.push((key, Item::Added));
    }
    let keys: Vec<&str> = items.iter().map(|(k, _)| *k).collect();
    out.push('{');
    for (n, position) in enumeration_order(&keys, |k| array_index(k))
        .into_iter()
        .enumerate()
    {
        if n > 0 {
            out.push(',');
        }
        let (k, item) = &items[position];
        write_str(k, out);
        out.push(':');
        match item {
            Item::Map(v) => write_value(v, out),
            Item::Added => write_str(value, out),
        }
    }
    out.push('}');
}

/// `JSON.stringify` of an object given as its map, written into `out`.
pub fn write_map(map: &serde_json::Map<String, serde_json::Value>, out: &mut String) {
    write_object(map, out, None, 0);
}

/// `JSON.stringify(value)` for a parsed JSON value, as a new string.
pub fn to_string(value: &serde_json::Value) -> String {
    let mut out = String::with_capacity(128);
    write_value(value, &mut out);
    out
}

/// `JSON.stringify(value, null, 2)` for a parsed JSON value, as a new string.
pub fn to_string_pretty(value: &serde_json::Value) -> String {
    let mut out = String::with_capacity(128);
    write_value_pretty(value, &mut out);
    out
}

fn number_as_f64(n: &serde_json::Number) -> f64 {
    // `as` rounds to nearest, which is what `JSON.parse` does with an integer
    // literal beyond 2^53. A float was already parsed to the nearest double.
    #[allow(clippy::cast_precision_loss)]
    if let Some(i) = n.as_i64() {
        i as f64
    } else if let Some(u) = n.as_u64() {
        u as f64
    } else {
        n.as_f64().unwrap_or(f64::NAN)
    }
}

// ------------------------------------------------------------------ numbers

/// `Number.prototype.toString()` for a finite double; `null` otherwise.
pub fn write_number(value: f64, out: &mut String) {
    if !value.is_finite() {
        out.push_str("null");
        return;
    }
    // ECMAScript's shortest-decimal tie selection differs from Rust Display.
    out.push_str(ryu_js::Buffer::new().format_finite(value));
}

fn write_serde_number(n: &serde_json::Number, out: &mut String) {
    // Integers in the safe range print as themselves without a float detour.
    if let Some(i) = n.as_i64() {
        if i.unsigned_abs() <= (1u64 << 53) {
            if i < 0 {
                out.push('-');
            }
            push_u64(i.unsigned_abs(), out);
            return;
        }
    } else if let Some(u) = n.as_u64()
        && u <= (1u64 << 53)
    {
        push_u64(u, out);
        return;
    }
    write_number(number_as_f64(n), out);
}

// ------------------------------------------------------------------ strings

fn push_escape_unit(unit: u16, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push_str("\\u");
    for shift in [12u16, 8, 4, 0] {
        out.push(char::from(HEX[usize::from((unit >> shift) & 0xf)]));
    }
}

/// Decimal digits of `value`, without going through `fmt`.
fn push_u64(mut value: u64, out: &mut String) {
    let mut buf = [0u8; 20];
    let mut at = buf.len();
    loop {
        at -= 1;
        // `value % 10` is below 10, so the narrowing is exact.
        buf[at] = b'0' + u8::try_from(value % 10).unwrap_or(0);
        value /= 10;
        if value == 0 {
            break;
        }
    }
    for &digit in &buf[at..] {
        out.push(char::from(digit));
    }
}

fn push_escaped_char(c: char, out: &mut String) {
    match c {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        '\u{08}' => out.push_str("\\b"),
        '\u{0c}' => out.push_str("\\f"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        c if (c as u32) < 0x20 => push_escape_unit(c as u16, out),
        c => out.push(c),
    }
}

/// `JSON.stringify` of a well-formed string.
pub fn write_str(s: &str, out: &mut String) {
    out.reserve(s.len() + 2);
    out.push('"');
    let bytes = s.as_bytes();
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        // Every byte needing an escape is ASCII, so a run of other bytes can be
        // copied whole without decoding it.
        if b == b'"' || b == b'\\' || b < 0x20 {
            out.push_str(&s[start..i]);
            push_escaped_char(char::from(b), out);
            start = i + 1;
        }
    }
    out.push_str(&s[start..]);
    out.push('"');
}

/// `JSON.stringify` of a UTF-16 string that may hold lone surrogates.
pub fn write_utf16(units: &[u16], out: &mut String) {
    out.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => push_escaped_char(c, out),
            Err(lone) => push_escape_unit(lone.unpaired_surrogate(), out),
        }
    }
    out.push('"');
}

// ------------------------------------------------------------------ key order

/// Whether `key` is a canonical array index: `0`, or digits with no leading
/// zero, below 2^32 - 1. Such keys enumerate first in a JS object.
pub fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    let value: u64 = key.parse().ok()?;
    u32::try_from(value).ok().filter(|v| *v != u32::MAX)
}

fn array_index_utf16(key: &[u16]) -> Option<u32> {
    let digits = u16::from(b'0')..=u16::from(b'9');
    if key.iter().all(|u| digits.contains(u)) {
        array_index(&String::from_utf16_lossy(key))
    } else {
        None
    }
}

/// Indices of `keys` in JS enumeration order.
/// How many key-order vectors this thread has built: a probe for the claim
/// that only objects with array-index keys pay for one.
pub fn key_order_builds() -> usize {
    KEY_ORDER_BUILDS.with(std::cell::Cell::get)
}

thread_local! {
    static KEY_ORDER_BUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn note_key_order_build() {
    KEY_ORDER_BUILDS.with(|c| c.set(c.get() + 1));
}

/// JS own-property traversal, including numeric array-index keys first.
pub fn own_entries(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Vec<(&String, &serde_json::Value)> {
    let entries: Vec<_> = map.iter().collect();
    enumeration_order(&entries, |(k, _)| array_index(k))
        .into_iter()
        .map(|i| entries[i])
        .collect()
}

fn enumeration_order<K>(keys: &[K], index_of: impl Fn(&K) -> Option<u32>) -> Vec<usize> {
    note_key_order_build();
    let mut indexed: Vec<(u32, usize)> = Vec::new();
    let mut named: Vec<usize> = Vec::with_capacity(keys.len());
    for (position, key) in keys.iter().enumerate() {
        match index_of(key) {
            Some(index) => indexed.push((index, position)),
            None => named.push(position),
        }
    }
    if indexed.is_empty() {
        return named;
    }
    indexed.sort_unstable_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, position)| position)
        .chain(named)
        .collect()
}

// ------------------------------------------------------------------ writers

fn newline_indent(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(width) = indent {
        out.push('\n');
        for _ in 0..width * depth {
            out.push(' ');
        }
    }
}

fn is_skipped(value: &JsValue) -> bool {
    matches!(value, JsValue::Undefined | JsValue::Function)
}

/// Returns false where `JSON.stringify` would produce `undefined`.
fn write_js(value: &JsValue, out: &mut String, indent: Option<usize>, depth: usize) -> bool {
    match value {
        JsValue::Undefined | JsValue::Function => return false,
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Number(n) => write_number(*n, out),
        JsValue::String(units) => write_utf16(units, out),
        JsValue::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return true;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline_indent(out, indent, depth + 1);
                if !crate::deep::grow(|| write_js(item, out, indent, depth + 1)) {
                    out.push_str("null");
                }
            }
            newline_indent(out, indent, depth);
            out.push(']');
        }
        JsValue::Object(entries) => {
            let order = enumeration_order(entries, |(k, _)| array_index_utf16(k));
            let mut wrote = false;
            out.push('{');
            for position in order {
                let (key, item) = &entries[position];
                if is_skipped(item) {
                    continue;
                }
                if wrote {
                    out.push(',');
                }
                wrote = true;
                newline_indent(out, indent, depth + 1);
                write_utf16(key, out);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                crate::deep::grow(|| write_js(item, out, indent, depth + 1));
            }
            if wrote {
                newline_indent(out, indent, depth);
            }
            out.push('}');
        }
    }
    true
}

fn write_serde(value: &serde_json::Value, out: &mut String, indent: Option<usize>, depth: usize) {
    use serde_json::Value;
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_serde_number(n, out),
        Value::String(s) => write_str(s, out),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline_indent(out, indent, depth + 1);
                crate::deep::grow(|| write_serde(item, out, indent, depth + 1));
            }
            newline_indent(out, indent, depth);
            out.push(']');
        }
        Value::Object(map) => write_object(map, out, indent, depth),
    }
}

fn write_object(
    map: &serde_json::Map<String, serde_json::Value>,
    out: &mut String,
    indent: Option<usize>,
    depth: usize,
) {
    use serde_json::Value;
    if map.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push('{');
    let mut first = true;
    let mut entry = |key: &str, item: &Value, out: &mut String| {
        if !first {
            out.push(',');
        }
        first = false;
        newline_indent(out, indent, depth + 1);
        write_str(key, out);
        out.push(':');
        if indent.is_some() {
            out.push(' ');
        }
        crate::deep::grow(|| write_serde(item, out, indent, depth + 1));
    };
    if map.keys().any(|k| array_index(k).is_some()) {
        let keys: Vec<&String> = map.keys().collect();
        for position in enumeration_order(&keys, |k| array_index(k)) {
            let key = keys[position];
            if let Some(item) = map.get(key) {
                entry(key, item, out);
            }
        }
    } else {
        for (key, item) in map {
            entry(key, item, out);
        }
    }
    newline_indent(out, indent, depth);
    out.push('}');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(v: f64) -> String {
        let mut s = String::new();
        write_number(v, &mut s);
        s
    }

    #[test]
    fn number_edge_cases() {
        assert_eq!(num(1e21), "1e+21");
        assert_eq!(num(1e-7), "1e-7");
        assert_eq!(num(1.5e-7), "1.5e-7");
        assert_eq!(num(0.000001), "0.000001");
        assert_eq!(num(123e-20), "1.23e-18");
        assert_eq!(num(-0.0), "0");
        assert_eq!(num(100.0), "100");
        assert_eq!(num(f64::NAN), "null");
    }

    #[test]
    fn array_index_rules() {
        assert_eq!(array_index("0"), Some(0));
        assert_eq!(array_index("4294967294"), Some(4_294_967_294));
        assert_eq!(array_index("4294967295"), None);
        assert_eq!(array_index("01"), None);
        assert_eq!(array_index("-1"), None);
        assert_eq!(array_index(""), None);
    }
}
