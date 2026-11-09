//! The JavaScript coercions the TS codecs perform on untrusted JSON.
//!
//! The TS decoders read upstream payloads typed as `unknown` and coerce them
//! with `String(x)`, `Number(x)`, truthiness and `JSON.parse`. A port that
//! narrowed those to "the type the field should have" would decode a sloppy
//! upstream differently, so each coercion here is the ECMAScript one, applied
//! to a [`serde_json::Value`]. `None` stands for `undefined`.
//!
//! # Known differences from TS
//!
//! - **Lone surrogates** become U+FFFD. JS strings can hold a lone surrogate
//!   (a `\udXXX` escape in JSON, or a slice cutting a pair) and TS re-escapes
//!   it as `\udXXX` on output; a Rust `String` cannot hold one. Only
//!   malformed client or upstream input reaches this, and the cost is a
//!   prompt-cache key that differs from the TS gateway's for that input.
//! - **`Number()` coercion of usage counts.** The decoders coerce upstream
//!   usage counts to numbers; TS does arithmetic on whatever arrived, so a
//!   non-numeric string count passes through TS as a string where Rust has a
//!   number (or NaN, rendered `null`).
//! - **Retry-After dates** (in `omni-providers`): the loose free-form date
//!   strings JavaScriptCore's `Date.parse` accepts are not parsed; the HTTP,
//!   RFC 2822 and ISO 8601 forms are.

use serde_json::Value;

use crate::jsjson::write_number;

/// `String(value)`.
pub fn to_string(value: Option<&Value>) -> String {
    let mut out = String::new();
    push_string(value, &mut out);
    out
}

fn push_string(value: Option<&Value>, out: &mut String) {
    match value {
        None => out.push_str("undefined"),
        Some(Value::Null) => out.push_str("null"),
        Some(Value::Bool(b)) => out.push_str(if *b { "true" } else { "false" }),
        Some(Value::Number(n)) => write_number(number_value(n), out),
        Some(Value::String(s)) => out.push_str(s),
        Some(Value::Object(_)) => out.push_str("[object Object]"),
        Some(Value::Array(items)) => {
            // `Array.prototype.join`: null and undefined elements are empty.
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !item.is_null() {
                    push_string(Some(item), out);
                }
            }
        }
    }
}

/// A JSON number as the double `JSON.parse` produces.
pub fn number_value(n: &serde_json::Number) -> f64 {
    // `as` rounds to nearest, which is what JS does with a big integer literal.
    #[allow(clippy::cast_precision_loss)]
    if let Some(i) = n.as_i64() {
        i as f64
    } else if let Some(u) = n.as_u64() {
        u as f64
    } else {
        n.as_f64().unwrap_or(f64::NAN)
    }
}

/// `Number(value)`.
pub fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => number_value(n),
        Some(Value::String(s)) => string_to_number(s),
        // ToPrimitive on an array is its `join`; on an object, "[object Object]".
        Some(v @ Value::Array(_)) => string_to_number(&to_string(Some(v))),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// ECMAScript `WhiteSpace` and `LineTerminator`, which `Number()` and
/// `String.prototype.trim` strip. Not `char::is_whitespace`: that includes
/// U+0085 and excludes U+FEFF, and JS does the opposite.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `Number(string)`: StringToNumber.
pub fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let bytes = t.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            let mut value = 0.0f64;
            for &b in &bytes[2..] {
                match char::from(b).to_digit(radix) {
                    Some(d) => value = value * f64::from(radix) + f64::from(d),
                    None => return f64::NAN,
                }
            }
            return value;
        }
    }
    let (sign, unsigned) = match bytes[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(unsigned.as_bytes()) {
        return f64::NAN;
    }
    // Validated above, so Rust's parser sees only the grammar both share.
    unsigned.parse::<f64>().map_or(f64::NAN, |v| sign * v)
}

/// `StrUnsignedDecimalLiteral` minus `Infinity`.
fn is_decimal_literal(b: &[u8]) -> bool {
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    let int = digits(&mut i);
    let mut frac = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        frac = digits(&mut i);
    }
    if int == 0 && frac == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// JS truthiness. `None` is `undefined`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => {
            let v = number_value(n);
            v != 0.0 && !v.is_nan()
        }
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `value?.[key]` for a named (non-index) key: only an object has one.
///
/// Strings, numbers and arrays answer `undefined` for every key the codecs
/// read, so treating them as having no properties is exact for those reads.
pub fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// `a ?? b`: the first value that is neither `undefined` nor `null`.
pub fn nullish_or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        some => some,
    }
}

/// `Math.max(0, x)`, which propagates NaN where `f64::max` would not.
pub fn max0(x: f64) -> f64 {
    if x.is_nan() || x > 0.0 { x } else { 0.0 }
}

/// `string.length`: UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    // Every char is one unit except the astral ones (4-byte UTF-8), which are
    // two: each non-continuation byte counts one, and a 4-byte lead one more.
    // Branch-free, so it vectorizes.
    s.bytes()
        .map(|b| usize::from(b & 0xc0 != 0x80) + usize::from(b >= 0xf0))
        .sum()
}

/// `string.slice(0, units)`.
///
/// A cut through a surrogate pair leaves the high half, which a Rust string
/// cannot hold, so it becomes U+FFFD — what the TS string turns into the moment
/// it is encoded as UTF-8 anywhere.
pub fn utf16_prefix(s: &str, units: usize) -> std::borrow::Cow<'_, str> {
    let mut used = 0;
    for (at, c) in s.char_indices() {
        let width = c.len_utf16();
        if used + width > units {
            if used < units {
                let mut out = s[..at].to_string();
                out.push('\u{fffd}');
                return out.into();
            }
            return s[..at].into();
        }
        used += width;
    }
    s.into()
}

/// `JSON.parse(text)`, or `None` where it throws.
///
/// One deliberate difference: JS keeps a lone surrogate escape (`"\ud83d"`) as
/// a lone surrogate, which a Rust `String` cannot hold, and `serde_json` refuses
/// it — dropping the whole payload. Each lone escape becomes U+FFFD instead,
/// which is what the TS string becomes as soon as it is encoded as UTF-8.
pub fn parse_json(text: &str) -> Option<Value> {
    match serde_json::from_str(text) {
        Ok(v) => Some(v),
        Err(_) if text.contains("\\u") => {
            serde_json::from_str(&replace_lone_surrogate_escapes(text)?).ok()
        }
        Err(_) => None,
    }
}

/// Rewrites every `\uD8xx`–`\uDFxx` escape that is not half of a valid pair
/// to `\ufffd`, inside strings only. `None` if nothing changed.
/// The lone-surrogate rewrite [`parse_json`] retries with, for callers that
/// parse through `deep::parse`.
pub fn replace_lone_surrogates(text: &str) -> Option<String> {
    replace_lone_surrogate_escapes(text)
}

fn replace_lone_surrogate_escapes(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut changed = false;
    let mut in_string = false;
    let mut i = 0;
    let hex = |at: usize| -> Option<u16> {
        let digits = text.get(at..at + 4)?;
        u16::from_str_radix(digits, 16).ok()
    };
    while i < b.len() {
        match b[i] {
            b'"' => {
                in_string = !in_string;
                i += 1;
            }
            b'\\' if in_string => {
                if b.get(i + 1) == Some(&b'u')
                    && let Some(unit) = hex(i + 2)
                {
                    if (0xd800..=0xdbff).contains(&unit) {
                        let low = (b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u'))
                            .then(|| hex(i + 8))
                            .flatten();
                        if low.is_some_and(|l| (0xdc00..=0xdfff).contains(&l)) {
                            i += 12;
                            continue;
                        }
                    }
                    if (0xd800..=0xdfff).contains(&unit) {
                        out.push_str(&text[copied..i]);
                        out.push_str("\\ufffd");
                        changed = true;
                        i += 6;
                        copied = i;
                        continue;
                    }
                    i += 6;
                } else {
                    i += 2;
                }
            }
            _ => i += 1,
        }
    }
    out.push_str(&text[copied..]);
    changed.then_some(out)
}

/// `Object.assign(target, source)` for a JSON source.
///
/// An object's own keys are copied (`__proto__` excepted: assignment to it sets
/// the prototype instead of creating a property). An array or string source
/// contributes its indices; anything else contributes nothing.
pub fn object_assign(target: &mut serde_json::Map<String, Value>, source: Option<&Value>) {
    match source {
        Some(Value::Object(map)) => {
            for (k, v) in map {
                if k != "__proto__"
                    && let Some(old) = target.insert(k.clone(), crate::deep::clone(v))
                {
                    crate::deep::drop(old);
                }
            }
        }
        Some(Value::Array(items)) => {
            for (i, v) in items.iter().enumerate() {
                if let Some(old) = target.insert(i.to_string(), crate::deep::clone(v)) {
                    crate::deep::drop(old);
                }
            }
        }
        Some(Value::String(s)) => {
            let units: Vec<u16> = s.encode_utf16().collect();
            for (i, unit) in units.iter().enumerate() {
                target.insert(
                    i.to_string(),
                    Value::String(String::from_utf16_lossy(std::slice::from_ref(unit))),
                );
            }
        }
        _ => {}
    }
}

/// `safeToken` (`packages/ir/src/logger.ts`): a client-supplied token an
/// error message may quote, or `(unprintable)`. 1–64 of `[A-Za-z0-9_.:/+-]`.
pub fn safe_token(value: &str) -> &str {
    let ok = (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:/+-".contains(&b));
    if ok { value } else { "(unprintable)" }
}

/// `Math.min(a, b)`: NaN if either is NaN, where `f64::min` would drop it.
pub fn math_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `Math.max(a, b)`, NaN-propagating.
pub fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.round(x)`: the nearest integer, halves toward +∞, exact for every
/// double. `-0` and inputs in `[-0.5, 0)` give `-0`; NaN and ±∞ pass through.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    // `floor` is exact, and so is `x - floor(x)` for |x| < 2^52 (both share
    // an exponent range); past 2^52 every double is already an integer.
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}
