//! A JSON writer that reproduces JavaScript's `JSON.stringify` byte for byte.
//!
//! Bodies sent upstream are hashed (`cch=`), cached by key (`prompt_cache_key`)
//! and fingerprinted, all over these exact bytes — changing them is a wire
//! break. `serde_json` differs from `JSON.stringify` in three observable ways:
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
/// Conversion, `Clone` and `Drop` are stack-safe at any depth, like the rest
/// of `crate::deep`.
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
            Value::Object(map) => object_from_serde(map),
        }
    }
}

pub fn object_from_serde(map: &serde_json::Map<String, serde_json::Value>) -> JsValue {
    crate::deep::grow(|| {
        JsValue::Object(
            map.iter()
                .map(|(k, v)| (k.encode_utf16().collect(), JsValue::from(v)))
                .collect(),
        )
    })
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

    pub fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(Vec<u16>, Self)]> {
        match self {
            Self::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Self> {
        self.as_object()?
            .iter()
            .find_map(|(k, v)| key.encode_utf16().eq(k.iter().copied()).then_some(v))
    }

    pub fn as_text(&self) -> Option<crate::text::Text> {
        match self {
            Self::String(units) => Some(crate::text::Text::from_utf16(units.clone())),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }

    pub fn string_eq(&self, text: &str) -> bool {
        matches!(self, Self::String(units) if text.encode_utf16().eq(units.iter().copied()))
    }

    pub fn object(entries: impl IntoIterator<Item = (&'static str, Self)>) -> Self {
        Self::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.encode_utf16().collect(), value))
                .collect(),
        )
    }

    pub fn into_object(mut self) -> Vec<(Vec<u16>, Self)> {
        match &mut self {
            Self::Object(entries) => std::mem::take(entries),
            _ => Vec::new(),
        }
    }

    pub fn put(&mut self, key: Vec<u16>, value: Self) {
        let Self::Object(entries) = self else {
            return;
        };
        if let Some((_, slot)) = entries.iter_mut().find(|(k, _)| *k == key) {
            *slot = value;
        } else {
            entries.push((key, value));
        }
    }

    pub fn assign_entries(&mut self, source: &Self) {
        let indexed = |i: usize| i.to_string().encode_utf16().collect();
        let entries = match source {
            Self::Object(o) => o
                .iter()
                .filter(|(k, _)| !"__proto__".encode_utf16().eq(k.iter().copied()))
                .cloned()
                .collect(),
            Self::Array(a) => a
                .iter()
                .cloned()
                .enumerate()
                .map(|(i, v)| (indexed(i), v))
                .collect(),
            Self::String(s) => s
                .iter()
                .enumerate()
                .map(|(i, u)| (indexed(i), Self::String(vec![*u])))
                .collect(),
            _ => return,
        };
        self.extend_object(Self::Object(entries));
    }

    pub fn extend_object(&mut self, source: Self) {
        if let Self::Object(entries) = self
            && entries.is_empty()
        {
            *entries = source.into_object();
        } else {
            use std::collections::HashMap;
            if let Self::Object(entries) = self {
                let mut indices: HashMap<_, _> = entries
                    .iter()
                    .enumerate()
                    .map(|(i, (k, _))| (k.clone(), i))
                    .collect();
                for (k, v) in source.into_object() {
                    match indices.entry(k) {
                        std::collections::hash_map::Entry::Occupied(at) => entries[*at.get()].1 = v,
                        std::collections::hash_map::Entry::Vacant(at) => {
                            entries.push((at.key().clone(), v));
                            at.insert(entries.len() - 1);
                        }
                    }
                }
            }
        }
    }
}

impl From<&crate::text::Text> for JsValue {
    fn from(text: &crate::text::Text) -> Self {
        Self::String(text.to_utf16())
    }
}

impl From<&str> for JsValue {
    fn from(text: &str) -> Self {
        Self::String(text.encode_utf16().collect())
    }
}

impl From<f64> for JsValue {
    fn from(n: f64) -> Self {
        Self::Number(n)
    }
}

impl std::ops::Index<&str> for JsValue {
    type Output = Self;
    fn index(&self, key: &str) -> &Self {
        static NULL: JsValue = JsValue::Null;
        self.get(key).unwrap_or(&NULL)
    }
}

pub fn write_js_value(value: &JsValue, out: &mut String) {
    if !write_js(value, out, None, 0) {
        out.push_str("null");
    }
}

/// UTF-8 JSON text even when the represented string contains lone units.
pub fn render(value: &JsValue) -> String {
    let mut out = String::new();
    write_js_value(value, &mut out);
    out
}

/// Writes the JS object spread without cloning its opaque children.
pub fn write_js_spread(data: &JsValue, key: &str, value: &str, spread: Spread, out: &mut String) {
    let key_units: Vec<_> = key.encode_utf16().collect();
    let data = data.as_object().unwrap_or_default();
    let found = data.iter().position(|(k, _)| *k == key_units);
    let mut order: Vec<_> = data
        .iter()
        .enumerate()
        .filter_map(|(i, (k, _))| array_index_utf16(k).map(|n| (n, i)))
        .collect();
    if !order.is_empty() {
        note_key_order_build();
    }
    order.sort_unstable();
    out.push('{');
    let mut first = true;
    let mut pair = |k: &[u16], v: Option<&JsValue>| {
        if v.is_some_and(is_skipped) {
            return;
        }
        if !first {
            out.push(',');
        }
        first = false;
        write_utf16(k, out);
        out.push(':');
        if let Some(v) = v {
            write_js_value(v, out);
        } else {
            write_str(value, out);
        }
    };
    for (_, i) in order {
        let (k, v) = &data[i];
        pair(
            k,
            (spread != Spread::KeyLast || found != Some(i)).then_some(v),
        );
    }
    if spread == Spread::KeyFirst {
        pair(&key_units, found.map(|i| &data[i].1));
    }
    for (i, (k, v)) in data.iter().enumerate() {
        if array_index_utf16(k).is_some() || (spread == Spread::KeyFirst && found == Some(i)) {
            continue;
        }
        pair(
            k,
            (spread != Spread::KeyLast || found != Some(i)).then_some(v),
        );
    }
    if spread == Spread::KeyLast && found.is_none() {
        pair(&key_units, None);
    }
    out.push('}');
}

/// Explicit projection for APIs that only accept Unicode-scalar JSON.
pub fn to_serde_lossy(value: &JsValue) -> serde_json::Value {
    use serde_json::Value;
    match value {
        JsValue::Undefined | JsValue::Function | JsValue::Null => Value::Null,
        JsValue::Bool(b) => Value::Bool(*b),
        JsValue::Number(n) => crate::stream::number(*n),
        JsValue::String(s) => Value::String(String::from_utf16_lossy(s)),
        JsValue::Array(a) => {
            crate::deep::grow(|| Value::Array(a.iter().map(to_serde_lossy).collect()))
        }
        JsValue::Object(o) => crate::deep::grow(|| {
            Value::Object(
                o.iter()
                    .filter(|(_, v)| !is_skipped(v))
                    .map(|(k, v)| (String::from_utf16_lossy(k), to_serde_lossy(v)))
                    .collect(),
            )
        }),
    }
}

/// A lossless upstream parse under the same depth policy as `deep::parse`.
pub fn parse_bounded(text: &str, depth: usize) -> Result<JsValue, crate::deep::ParseError> {
    if depth > crate::deep::MAX_DEPTH {
        return Err(crate::deep::ParseError::TooDeep);
    }
    parse_js(text).map_err(|_| crate::deep::ParseError::Syntax)
}

/// JS String()/Number() and `+` over JSON-derived values.
pub fn coerce_text(value: Option<&JsValue>) -> Result<crate::text::Text, crate::js::Throws> {
    use crate::text::Text;
    Ok(match value {
        None | Some(JsValue::Undefined) => "undefined".into(),
        Some(JsValue::Null) => "null".into(),
        Some(JsValue::Bool(b)) => if *b { "true" } else { "false" }.into(),
        Some(JsValue::Number(n)) if n.is_nan() => "NaN".into(),
        Some(JsValue::Number(n)) if n.is_infinite() => if n.is_sign_positive() {
            "Infinity"
        } else {
            "-Infinity"
        }
        .into(),
        Some(JsValue::Number(n)) => {
            let mut s = String::new();
            write_number(*n, &mut s);
            s.into()
        }
        Some(JsValue::String(units)) => Text::from_utf16(units.clone()),
        Some(JsValue::Array(items)) => crate::deep::grow(|| {
            let mut text = Text::default();
            let comma = Text::from(",");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    text.push(&comma);
                }
                if !matches!(item, JsValue::Null | JsValue::Undefined) {
                    text.push(&coerce_text(Some(item))?);
                }
            }
            Ok(text)
        })?,
        Some(v @ JsValue::Object(_)) => {
            if v.get("toString").is_some() {
                return Err(crate::js::Throws);
            }
            "[object Object]".into()
        }
        Some(JsValue::Function) => return Err(crate::js::Throws),
    })
}

pub fn coerce_number(value: Option<&JsValue>) -> Result<f64, crate::js::Throws> {
    Ok(match value {
        Some(JsValue::Null) => 0.0,
        Some(JsValue::Bool(b)) => f64::from(*b),
        Some(JsValue::Number(n)) => *n,
        _ => coerce_text(value)?
            .as_utf8()
            .map_or(f64::NAN, crate::js::string_to_number),
    })
}

pub fn add(left: &JsValue, right: &JsValue) -> Result<JsValue, crate::js::Throws> {
    let primitive_string = |v: &JsValue| {
        matches!(
            v,
            JsValue::String(_) | JsValue::Object(_) | JsValue::Array(_)
        )
    };
    if primitive_string(left) || primitive_string(right) {
        let mut left = coerce_text(Some(left))?;
        left.push(&coerce_text(Some(right))?);
        Ok(JsValue::from(&left))
    } else {
        Ok(JsValue::Number(
            coerce_number(Some(left))? + coerce_number(Some(right))?,
        ))
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

/// Values that can write the gateway's client JSON byte contract.
pub trait JsonOutput {
    fn write_json(&self, out: &mut String);
}

impl JsonOutput for serde_json::Value {
    fn write_json(&self, out: &mut String) {
        write_value(self, out);
    }
}

impl JsonOutput for crate::deep::Owned {
    fn write_json(&self, out: &mut String) {
        write_value(self, out);
    }
}

impl JsonOutput for JsValue {
    fn write_json(&self, out: &mut String) {
        write_js_value(self, out);
    }
}

/// `JSON.stringify(value)`, as a new string.
pub fn to_string<T: JsonOutput>(value: &T) -> String {
    let mut out = String::with_capacity(128);
    value.write_json(&mut out);
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
            write_u64(i.unsigned_abs(), out);
            return;
        }
    } else if let Some(u) = n.as_u64()
        && u <= (1u64 << 53)
    {
        write_u64(u, out);
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

/// Decimal digits of `value`, without going through `fmt`. The exact bytes
/// `JSON.stringify` prints for an integer below 2^53.
pub fn write_u64(mut value: u64, out: &mut String) {
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
    let zero = u16::from(b'0');
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == zero) {
        return None;
    }
    let mut n = 0u32;
    for &unit in key {
        let digit = unit.checked_sub(zero).filter(|d| *d <= 9)?;
        n = n.checked_mul(10)?.checked_add(u32::from(digit))?;
    }
    (n != u32::MAX).then_some(n)
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
            let order = entries
                .iter()
                .any(|(k, _)| array_index_utf16(k).is_some())
                .then(|| enumeration_order(entries, |(k, _)| array_index_utf16(k)));
            let mut wrote = false;
            out.push('{');
            let mut pair = |(key, item): &(Vec<u16>, JsValue)| {
                if is_skipped(item) {
                    return;
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
            };
            if let Some(order) = order {
                for i in order {
                    pair(&entries[i]);
                }
            } else {
                entries.iter().for_each(pair);
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

// ------------------------------------------------------------------ parsing

enum Frame {
    Array(Vec<JsValue>),
    /// The members so far, the key awaiting its value, and (once the object
    /// is wide enough to need one) an index from key to position, so a
    /// duplicate is found in amortized constant time rather than by a scan
    /// of every earlier key.
    Object(
        Vec<(Vec<u16>, JsValue)>,
        Option<Vec<u16>>,
        Option<std::collections::HashMap<Vec<u16>, usize>>,
    ),
}

/// Objects up to this many members find a duplicate key by scanning them.
const INDEX_FROM: usize = 8;

thread_local! {
    static SCAN_STEPS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Work counted by this module's parsers on this thread: one step per byte
/// scanned and per key compared. For complexity tests.
pub fn scan_steps() -> u64 {
    SCAN_STEPS.with(std::cell::Cell::get)
}

fn count_steps(n: usize) {
    SCAN_STEPS.with(|c| c.set(c.get() + n as u64));
}

/// `JSON.parse(text)` as a [`JsValue`]: lossless (lone surrogate escapes
/// kept as the UTF-16 units they are, numbers as `f64` including
/// out-of-range `±Infinity`, duplicate keys last-wins in first position),
/// iterative at any depth. `Err` carries JavaScriptCore's message.
pub fn parse_js(text: &str) -> Result<JsValue, String> {
    if text.is_empty() {
        return Err("JSON Parse error: Unexpected EOF".into());
    }
    if let Some(error) = crate::jsc_json::parse_error(text) {
        return Err(error);
    }
    let mut frames = Vec::new();
    let mut root = JsValue::Null;
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < bytes.len() {
        let value = match bytes[i] {
            b' ' | b'\t' | b'\r' | b'\n' | b',' | b':' => {
                i += 1;
                continue;
            }
            b'[' => {
                frames.push(Frame::Array(Vec::new()));
                i += 1;
                continue;
            }
            b'{' => {
                frames.push(Frame::Object(Vec::new(), None, None));
                i += 1;
                continue;
            }
            b']' | b'}' => {
                i += 1;
                match frames.pop().expect("validated container") {
                    Frame::Array(a) => JsValue::Array(a),
                    Frame::Object(o, _, _) => JsValue::Object(o),
                }
            }
            b'"' => {
                let start = i;
                i += 1;
                while bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
                let units = string_units(&text[start + 1..i - 1]);
                if let Some(Frame::Object(_, key @ None, _)) = frames.last_mut() {
                    *key = Some(units);
                    continue;
                }
                JsValue::String(units)
            }
            b't' => {
                i += 4;
                JsValue::Bool(true)
            }
            b'f' => {
                i += 5;
                JsValue::Bool(false)
            }
            b'n' => {
                i += 4;
                JsValue::Null
            }
            _ => {
                let start = i;
                while i < bytes.len()
                    && matches!(bytes[i], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
                {
                    i += 1;
                }
                JsValue::Number(text[start..i].parse::<f64>().expect("validated number"))
            }
        };
        match frames.last_mut() {
            None => root = value,
            Some(Frame::Array(a)) => a.push(value),
            Some(Frame::Object(o, key, index)) => {
                let key = key.take().expect("validated property");
                // `JSON.parse`: a duplicate's value replaces the first one's,
                // which keeps its position.
                let at = match index {
                    Some(index) => {
                        count_steps(1);
                        index.get(&key).copied()
                    }
                    None => {
                        count_steps(o.len());
                        o.iter().position(|(k, _)| *k == key)
                    }
                };
                match at {
                    Some(at) => o[at].1 = value,
                    None => {
                        if let Some(index) = index {
                            index.insert(key.clone(), o.len());
                        }
                        o.push((key, value));
                        if index.is_none() && o.len() > INDEX_FROM {
                            *index = Some(
                                o.iter()
                                    .enumerate()
                                    .map(|(i, (k, _))| (k.clone(), i))
                                    .collect(),
                            );
                        }
                    }
                }
            }
        }
    }
    count_steps(bytes.len());
    Ok(root)
}

/// The last `key` member of the top-level object of `text` (valid JSON, as
/// `JSON.parse` reads it: the last duplicate wins), as exact UTF-16 when it
/// is a string. `None` when `text` is not an object, has no such member, or
/// the member is not a string. One linear pass: other values are skipped by
/// bracket depth without being built.
///
/// Meant for text a parser already accepted. It does not validate: on text
/// that is not JSON it returns `None` or whatever a member-shaped prefix
/// held, and never panics.
pub fn top_level_string(text: &str, key: &str) -> Option<Vec<u16>> {
    let b = text.as_bytes();
    let ws = |i: &mut usize| {
        while matches!(b.get(*i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            *i += 1;
        }
    };
    // The end of the string opening at `i` (its quote), after the closing
    // one; `None` for a string that never closes (text no parser accepted).
    let end_of_string = |mut i: usize| {
        i += 1;
        while let Some(&c) = b.get(i) {
            match c {
                b'\\' => i += 2,
                b'"' => return Some(i + 1),
                _ => i += 1,
            }
        }
        None
    };
    let mut i = 0;
    ws(&mut i);
    if b.get(i) != Some(&b'{') {
        count_steps(i);
        return None;
    }
    i += 1;
    let mut found: Option<Option<Vec<u16>>> = None;
    loop {
        ws(&mut i);
        if b.get(i) != Some(&b'"') {
            break;
        }
        let Some(key_end) = end_of_string(i) else {
            i = b.len();
            break;
        };
        let Some(name) = try_string_units(&text[i + 1..key_end - 1]) else {
            break;
        };
        let wanted = name.iter().copied().eq(key.encode_utf16());
        i = key_end;
        ws(&mut i);
        i += 1; // ':'
        ws(&mut i);
        if b.get(i) == Some(&b'"') {
            let Some(end) = end_of_string(i) else {
                i = b.len();
                break;
            };
            if wanted {
                let Some(value) = try_string_units(&text[i + 1..end - 1]) else {
                    break;
                };
                found = Some(Some(value));
            }
            i = end;
        } else {
            if wanted {
                found = Some(None);
            }
            // A container, a number or a literal: to the `,` or `}` at depth 0.
            let mut depth = 0usize;
            while let Some(&c) = b.get(i) {
                match c {
                    b'"' => {
                        i = end_of_string(i).unwrap_or(b.len());
                        continue;
                    }
                    b'[' | b'{' => depth += 1,
                    b']' | b'}' if depth > 0 => depth -= 1,
                    b',' | b'}' if depth == 0 => break,
                    _ => {}
                }
                i += 1;
            }
        }
        ws(&mut i);
        if b.get(i) == Some(&b',') {
            i += 1;
        } else {
            break;
        }
    }
    count_steps(i.min(b.len()));
    found.flatten()
}

/// JSON string contents after syntax validation. Escaped UTF-16 units are data,
/// including unpaired surrogates; only literal UTF-8 needs transcoding.
fn string_units(text: &str) -> Vec<u16> {
    try_string_units(text).expect("validated string")
}

/// [`string_units`] for contents nothing validated: `None` on an escape
/// `JSON.parse` would refuse (cut short, or not hexadecimal).
fn try_string_units(text: &str) -> Option<Vec<u16>> {
    let mut units = Vec::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            units.extend_from_slice(c.encode_utf16(&mut [0; 2]));
            continue;
        }
        let c = chars.next()?;
        units.push(match c {
            'u' => {
                let mut unit = 0;
                for _ in 0..4 {
                    unit = unit * 16 + chars.next()?.to_digit(16)? as u16;
                }
                unit
            }
            'b' => 8,
            'f' => 12,
            'n' => 10,
            'r' => 13,
            't' => 9,
            _ => c as u16,
        });
    }
    Some(units)
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
