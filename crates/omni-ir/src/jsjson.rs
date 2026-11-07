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
#[derive(Debug, Clone, PartialEq)]
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
            Value::Array(items) => JsValue::Array(items.iter().map(JsValue::from).collect()),
            Value::Object(map) => JsValue::Object(
                map.iter()
                    .map(|(k, v)| (k.encode_utf16().collect(), JsValue::from(v)))
                    .collect(),
            ),
        }
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
    if value == 0.0 {
        // Covers -0 as well: JSON.stringify(-0) is "0".
        out.push('0');
        return;
    }
    if value < 0.0 {
        out.push('-');
    }
    // Rust's `{:e}` prints the shortest digits that round-trip, which is the
    // digit string ECMA-262 Number::toString starts from.
    let sci = format!("{:e}", value.abs());
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let n = exponent + 1;

    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        let split = usize::try_from(n).unwrap_or(0);
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        let e = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        push_u64(u64::from(e.unsigned_abs()), out);
    }
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
fn enumeration_order<K>(keys: &[K], index_of: impl Fn(&K) -> Option<u32>) -> Vec<usize> {
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
                if !write_js(item, out, indent, depth + 1) {
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
                write_js(item, out, indent, depth + 1);
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
                write_serde(item, out, indent, depth + 1);
            }
            newline_indent(out, indent, depth);
            out.push(']');
        }
        Value::Object(map) => {
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
                write_serde(item, out, indent, depth + 1);
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
    }
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
