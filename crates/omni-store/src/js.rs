//! The few JavaScript semantics the TS store leans on: whitespace trimming,
//! `Number` coercions of SQLite cells, and how `bun:sqlite` binds a number.

use rusqlite::types::{Value as SqlValue, ValueRef};

pub(crate) fn own_cell(value: ValueRef<'_>) -> SqlValue {
    match value {
        ValueRef::Null => SqlValue::Null,
        ValueRef::Integer(n) => SqlValue::Integer(n),
        ValueRef::Real(n) => SqlValue::Real(n),
        ValueRef::Text(s) => SqlValue::Text(String::from_utf8_lossy(s).into_owned()),
        ValueRef::Blob(b) => SqlValue::Blob(b.to_vec()),
    }
}

pub(crate) fn coerce_cell(value: ValueRef<'_>) -> f64 {
    match value {
        ValueRef::Null => 0.0,
        #[allow(clippy::cast_precision_loss)]
        ValueRef::Integer(n) => n as f64,
        ValueRef::Real(n) => n,
        ValueRef::Text(s) => omni_ir::js::string_to_number(&String::from_utf8_lossy(s)),
        ValueRef::Blob(bytes) => omni_ir::js::string_to_number(
            &bytes
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(","),
        ),
    }
}

/// ECMAScript `WhiteSpace` and `LineTerminator`, which is what
/// `String.prototype.trim` strips. Not Rust's `char::is_whitespace`: that
/// includes U+0085 and excludes U+FEFF, and JS does the opposite.
pub(crate) fn is_js_whitespace(c: char) -> bool {
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
pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String.prototype.trimStart`.
pub(crate) fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

/// A cell as the JS number `bun:sqlite` hands back, or `None` for anything
/// that would not arrive as a number (text, blob, null).
pub(crate) fn number(cell: ValueRef<'_>) -> Option<f64> {
    match cell {
        #[allow(clippy::cast_precision_loss)]
        ValueRef::Integer(v) => Some(v as f64),
        ValueRef::Real(v) => Some(v),
        _ => None,
    }
}

/// `cell === 1`, for the 0/1 flag columns.
pub(crate) fn is_one(cell: ValueRef<'_>) -> bool {
    number(cell) == Some(1.0)
}

/// How `bun:sqlite` binds a JS number: a safe integer (other than `-0`) as an
/// INTEGER, everything else as a REAL.
pub(crate) fn bind_number(v: f64) -> SqlValue {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if v.fract() == 0.0 && v.abs() <= MAX_SAFE && !(v == 0.0 && v.is_sign_negative()) {
        #[allow(clippy::cast_possible_truncation)]
        SqlValue::Integer(v as i64)
    } else {
        SqlValue::Real(v)
    }
}

/// `Number.isInteger(v)` for a finite double.
pub(crate) fn is_integer(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0
}

/// `Number.isSafeInteger(v)`.
pub(crate) fn is_safe_integer(v: f64) -> bool {
    is_integer(v) && v.abs() <= 9_007_199_254_740_991.0
}

/// `String(v)` for a number.
pub(crate) fn number_to_string(v: f64) -> String {
    let mut out = String::new();
    omni_ir::jsjson::write_number(v, &mut out);
    out
}

/// The length JS reports for a string: UTF-16 code units.
pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_follows_ecmascript_not_unicode_white_space() {
        assert_eq!(trim("\u{feff}\u{a0} x \u{3000}\u{2028}"), "x");
        assert_eq!(trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
        assert_eq!(trim_start("\t-- c"), "-- c");
    }

    #[test]
    fn numbers_bind_as_bun_binds_them() {
        assert_eq!(bind_number(1.0), SqlValue::Integer(1));
        assert_eq!(bind_number(-0.0), SqlValue::Real(-0.0));
        assert_eq!(
            bind_number(9_007_199_254_740_992.0),
            SqlValue::Real(9_007_199_254_740_992.0)
        );
        assert_eq!(bind_number(1.5), SqlValue::Real(1.5));
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(1_794_009_600_000.0), "1794009600000");
    }
}
