//! JS `RegExp` source → Rust `regex` syntax, so every pattern below is the TS
//! source verbatim rather than a hand re-derivation of it.
//!
//! The TS patterns are non-`u` JS regular expressions. Where JS and Rust read
//! the same syntax differently, this rewrites it to the JS meaning:
//!
//! - `\s`/`\S` are the ECMAScript WhiteSpace + LineTerminator set (it has
//!   U+FEFF and lacks U+0085, the opposite of Rust's Unicode `\s`).
//! - `\d` is ASCII `[0-9]`, `\b` the ASCII word boundary.
//! - `.` excludes all four JS line terminators, not just `\n`.
//! - `i` folds ASCII letters only. Non-`u` JS never folds a non-ASCII char to
//!   an ASCII letter (Rust's `(?i)k` would match the Kelvin sign), and a cased
//!   non-ASCII char under `i` is rejected rather than guessed at.
//! - `m` wraps the pattern in `(?m:…)`, whose `^`/`$` only see `\n`; callers
//!   normalize `\r`, U+2028 and U+2029 to `\n` first (see
//!   [`normalize_terminators`]).
//!
//! Lookaround and backreferences have no Rust equivalent and are rejected;
//! the three TS lookaheads are hand-written at their call sites.
//!
//! Rust's leftmost-first semantics pick the same match and captures as a JS
//! backtracker for these (backreference-free) patterns, and its engine is
//! linear-time where the JS one can backtrack exponentially.

use regex::Regex;
use std::borrow::Cow;

const WS: &str =
    r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

/// Stands in for one surrogate half. A non-`u` JS regex reads an astral
/// character as two code units, so `\S.+` accepts a lone emoji and Rust's
/// one-code-point view would not. Each half is non-space, non-word, caseless
/// and matched by `.` and every negated class here — exactly what a private
/// use character is to these patterns.
const HALF: char = '\u{E000}';

/// A translated TS pattern, matched over the input's UTF-16 unit sequence.
#[derive(Debug)]
pub(crate) struct JsRegex(Regex);

/// The input with each astral char as two [`HALF`]s, and the original byte
/// offset of each transcoded char boundary.
fn transcode(text: &str) -> Option<(String, Vec<(usize, usize)>)> {
    if !text.bytes().any(|b| b >= 0xF0) {
        return None;
    }
    let mut out = String::with_capacity(text.len() + 8);
    let mut map = Vec::with_capacity(text.len() + 1);
    for (at, c) in text.char_indices() {
        map.push((out.len(), at));
        if c.len_utf16() == 2 {
            out.push(HALF);
            // A boundary between the halves maps to the char's start.
            map.push((out.len(), at));
            out.push(HALF);
        } else {
            out.push(c);
        }
    }
    map.push((out.len(), text.len()));
    Some((out, map))
}

fn original_offset(map: &[(usize, usize)], transcoded: usize) -> usize {
    match map.binary_search_by_key(&transcoded, |(t, _)| *t) {
        Ok(i) => map[i].1,
        Err(i) => map[i.saturating_sub(1)].1,
    }
}

impl JsRegex {
    /// `RegExp.prototype.test`.
    pub(crate) fn test(&self, text: &str) -> bool {
        match transcode(text) {
            None => self.0.is_match(text),
            Some((units, _)) => self.0.is_match(&units),
        }
    }

    /// `String.prototype.match` without `g`: each group as a slice of `text`.
    pub(crate) fn captures<'t>(&self, text: &'t str) -> Option<Vec<Option<&'t str>>> {
        match transcode(text) {
            None => {
                let caps = self.0.captures(text)?;
                Some(caps.iter().map(|m| m.map(|m| m.as_str())).collect())
            }
            Some((units, map)) => {
                let caps = self.0.captures(&units)?;
                Some(
                    caps.iter()
                        .map(|m| {
                            m.and_then(|m| {
                                let from = original_offset(&map, m.start());
                                let to = original_offset(&map, m.end());
                                text.get(from..to)
                            })
                        })
                        .collect(),
                )
            }
        }
    }

    /// `(text.match(/…/g)?.length ?? 0)`.
    pub(crate) fn count(&self, text: &str) -> usize {
        match transcode(text) {
            None => self.0.find_iter(text).count(),
            Some((units, _)) => self.0.find_iter(&units).count(),
        }
    }

    /// `text.replace(/…/, replacement)` (first match; `$n` as `${n}`).
    pub(crate) fn replace_first<'t>(&self, text: &'t str, replacement: &str) -> Cow<'t, str> {
        match transcode(text) {
            None => self.0.replacen(text, 1, replacement),
            Some((units, map)) => {
                let Some(caps) = self.0.captures(&units) else {
                    return Cow::Borrowed(text);
                };
                let Some(whole) = caps.get(0) else {
                    return Cow::Borrowed(text);
                };
                let mut expanded = String::new();
                caps.expand(replacement, &mut expanded);
                // Group text in `expanded` came from `units`; restore any
                // astral chars by re-reading the original span when the
                // replacement only references groups wholly inside it.
                let from = original_offset(&map, whole.start());
                let to = original_offset(&map, whole.end());
                let restored = restore_groups(&caps, &map, text, replacement).unwrap_or(expanded);
                Cow::Owned(format!("{}{restored}{}", &text[..from], &text[to..]))
            }
        }
    }
}

/// Expands `${n}` references from the original text rather than the
/// transcoded one. `None` for any other `$` syntax.
fn restore_groups(
    caps: &regex::Captures<'_>,
    map: &[(usize, usize)],
    text: &str,
    replacement: &str,
) -> Option<String> {
    let mut out = String::new();
    let mut rest = replacement;
    while let Some(at) = rest.find('$') {
        out.push_str(&rest[..at]);
        let tail = rest[at..].strip_prefix("${")?;
        let close = tail.find('}')?;
        let index: usize = tail[..close].parse().ok()?;
        if let Some(m) = caps.get(index) {
            out.push_str(text.get(original_offset(map, m.start())..original_offset(map, m.end()))?);
        }
        rest = &tail[close + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// Compiles a static TS pattern. Every call site is covered by a test, so a
/// failure here is a programming error in a literal, not a runtime input.
#[allow(clippy::panic)]
pub(crate) fn compile(src: &str, flags: &str) -> JsRegex {
    let translated = translate(src, flags).unwrap_or_else(|e| panic!("pattern {src}: {e}"));
    JsRegex(Regex::new(&translated).unwrap_or_else(|e| panic!("pattern {src}: {e}")))
}

/// `\r`, U+2028 and U+2029 become `\n`: every JS line terminator one
/// `(?m:…)` pattern can see. Only for boolean tests and match counts, where
/// positions do not matter.
pub(crate) fn normalize_terminators(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains(['\r', '\u{2028}', '\u{2029}']) {
        text.replace(['\r', '\u{2028}', '\u{2029}'], "\n").into()
    } else {
        text.into()
    }
}

macro_rules! js_regex {
    ($vis:vis $name:ident = $src:expr) => {
        $vis static $name: std::sync::LazyLock<$crate::jsre::JsRegex> =
            std::sync::LazyLock::new(|| $crate::jsre::compile($src, ""));
    };
    ($vis:vis $name:ident = $src:expr, $flags:expr) => {
        $vis static $name: std::sync::LazyLock<$crate::jsre::JsRegex> =
            std::sync::LazyLock::new(|| $crate::jsre::compile($src, $flags));
    };
}
pub(crate) use js_regex;

pub(crate) fn translate(src: &str, flags: &str) -> Result<String, String> {
    let icase = flags.contains('i');
    let multiline = flags.contains('m');
    if let Some(flag) = flags.chars().find(|f| !matches!(f, 'i' | 'm' | 'g')) {
        return Err(format!("unsupported flag {flag}"));
    }
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        match c {
            '\\' => {
                let e = *chars.get(i).ok_or("trailing backslash")?;
                i += 1;
                match e {
                    'd' => out.push_str("[0-9]"),
                    'D' => out.push_str("[^0-9]"),
                    's' => {
                        out.push('[');
                        out.push_str(WS);
                        out.push(']');
                    }
                    'S' => {
                        out.push_str("[^");
                        out.push_str(WS);
                        out.push(']');
                    }
                    'w' => out.push_str("[A-Za-z0-9_]"),
                    'W' => out.push_str("[^A-Za-z0-9_]"),
                    'b' => out.push_str(r"(?-u:\b)"),
                    'B' => out.push_str(r"(?-u:\B)"),
                    _ => {
                        let (ch, used) = simple_escape(e, &chars[i..])?;
                        i += used;
                        literal(ch, icase, &mut out)?;
                    }
                }
            }
            '[' => i = class(&chars, i, icase, &mut out)?,
            '(' => {
                if chars.get(i) == Some(&'?') {
                    if chars.get(i + 1) == Some(&':') {
                        out.push_str("(?:");
                        i += 2;
                    } else {
                        return Err("lookaround is not supported".into());
                    }
                } else {
                    out.push('(');
                }
            }
            ')' | '|' | '*' | '+' | '?' | '^' | '$' => out.push(c),
            '{' => {
                let end = quantifier_end(&chars, i);
                if let Some(end) = end {
                    out.push('{');
                    out.extend(&chars[i..end]);
                    i = end;
                } else {
                    literal('{', icase, &mut out)?;
                }
            }
            '.' => out.push_str(DOT),
            _ => literal(c, icase, &mut out)?,
        }
    }
    Ok(if multiline {
        format!("(?m:{out})")
    } else {
        out
    })
}

/// `{n}`, `{n,}` or `{n,m}` starting after the `{`: the index past `}`.
fn quantifier_end(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start;
    let digits = |i: &mut usize| {
        let from = *i;
        while chars.get(*i).is_some_and(char::is_ascii_digit) {
            *i += 1;
        }
        *i > from
    };
    if !digits(&mut i) {
        return None;
    }
    if chars.get(i) == Some(&',') {
        i += 1;
        digits(&mut i);
    }
    (chars.get(i) == Some(&'}')).then_some(i + 1)
}

/// An escape that denotes one character: the char and how many extra source
/// chars it consumed.
fn simple_escape(e: char, rest: &[char]) -> Result<(char, usize), String> {
    let hex = |n: usize| -> Result<(char, usize), String> {
        let digits: String = rest.iter().take(n).collect();
        if digits.chars().count() != n {
            return Err("short hex escape".into());
        }
        let value = u32::from_str_radix(&digits, 16).map_err(|e| e.to_string())?;
        let ch = char::from_u32(value).ok_or("surrogate escape")?;
        Ok((ch, n))
    };
    match e {
        'n' => Ok(('\n', 0)),
        't' => Ok(('\t', 0)),
        'r' => Ok(('\r', 0)),
        'f' => Ok(('\u{c}', 0)),
        'v' => Ok(('\u{b}', 0)),
        '0' => Ok(('\0', 0)),
        'x' => hex(2),
        'u' => hex(4),
        '1'..='9' => Err("backreference".into()),
        c if c.is_ascii_punctuation() => Ok((c, 0)),
        c => Err(format!("unsupported escape \\{c}")),
    }
}

fn push_char(c: char, out: &mut String) {
    if c.is_ascii_alphanumeric() {
        out.push(c);
    } else {
        out.push_str(&format!(r"\x{{{:X}}}", u32::from(c)));
    }
}

fn literal(c: char, icase: bool, out: &mut String) -> Result<(), String> {
    if icase && c.is_ascii_alphabetic() {
        out.push('[');
        out.push(c.to_ascii_lowercase());
        out.push(c.to_ascii_uppercase());
        out.push(']');
    } else if icase && !c.is_ascii() && has_case(c) {
        return Err(format!("non-ASCII cased {c} under i"));
    } else {
        push_char(c, out);
    }
    Ok(())
}

fn has_case(c: char) -> bool {
    c.to_lowercase().ne(c.to_uppercase())
}

enum Atom {
    Char(char),
    Set(&'static str),
    Owned(String),
}

/// Parses a class whose `[` is just before `start`; returns the index past `]`.
fn class(chars: &[char], start: usize, icase: bool, out: &mut String) -> Result<usize, String> {
    let mut i = start;
    let negated = chars.get(i) == Some(&'^');
    if negated {
        i += 1;
    }
    let mut body = String::new();
    let mut empty = true;
    loop {
        let c = *chars.get(i).ok_or("unterminated class")?;
        i += 1;
        if c == ']' {
            break;
        }
        empty = false;
        let atom = if c == '\\' {
            let e = *chars.get(i).ok_or("trailing backslash")?;
            i += 1;
            match e {
                'd' => Atom::Set("0-9"),
                's' => Atom::Owned(WS.to_owned()),
                'w' => Atom::Set("A-Za-z0-9_"),
                'b' => Atom::Char('\u{8}'),
                'D' | 'S' | 'W' => return Err("negated escape inside class".into()),
                _ => {
                    let (ch, used) = simple_escape(e, &chars[i..])?;
                    i += used;
                    Atom::Char(ch)
                }
            }
        } else {
            Atom::Char(c)
        };
        let Atom::Char(lo) = atom else {
            match atom {
                Atom::Set(s) => body.push_str(s),
                Atom::Owned(s) => body.push_str(&s),
                Atom::Char(_) => {}
            }
            continue;
        };
        let range_hi = if chars.get(i) == Some(&'-') && chars.get(i + 1).is_some_and(|n| *n != ']')
        {
            let h = chars[i + 1];
            i += 2;
            if h == '\\' {
                let e = *chars.get(i).ok_or("trailing backslash")?;
                i += 1;
                if matches!(e, 'd' | 's' | 'w' | 'D' | 'S' | 'W') {
                    return Err("class escape as range end".into());
                }
                let (ch, used) = simple_escape(e, &chars[i..])?;
                i += used;
                Some(ch)
            } else {
                Some(h)
            }
        } else {
            None
        };
        let hi = range_hi.unwrap_or(lo);
        if hi < lo {
            return Err("reversed range".into());
        }
        push_char(lo, &mut body);
        if hi != lo {
            body.push('-');
            push_char(hi, &mut body);
        }
        if icase {
            for ch in lo..=hi {
                if ch.is_ascii_alphabetic() {
                    let other = if ch.is_ascii_lowercase() {
                        ch.to_ascii_uppercase()
                    } else {
                        ch.to_ascii_lowercase()
                    };
                    body.push(other);
                } else if !ch.is_ascii() && has_case(ch) {
                    return Err("non-ASCII cased class member under i".into());
                }
            }
        }
    }
    if empty {
        return Err("empty class".into());
    }
    out.push('[');
    if negated {
        out.push('^');
    }
    out.push_str(&body);
    out.push(']');
    Ok(i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(src: &str, flags: &str, hay: &str) -> bool {
        compile(src, flags).test(hay)
    }

    #[test]
    fn astral_chars_are_two_units() {
        assert!(m(r"^\t\S.+$", "", "\t😀"));
        assert!(!m(r"^\t\S.+$", "", "\té"));
        assert!(m(r"^.{2}$", "", "😀"));
        let caps = compile(r"^([^:]+):(\d+):(.+)$", "")
            .captures("😀a.ts:1:x😀")
            .expect("match");
        assert_eq!(caps[1], Some("😀a.ts"));
        assert_eq!(caps[3], Some("x😀"));
        assert_eq!(
            compile(r"^(YN\d{4}:)\s*", "").replace_first("YN0001:  😀", "${1} "),
            "YN0001: 😀"
        );
        assert_eq!(compile(r"\d+", "").count("1 😀 22 3"), 3);
    }

    #[test]
    fn whitespace_digit_dot_and_boundary_follow_js() {
        assert!(m(r"^\s$", "", "\u{feff}"));
        assert!(!m(r"^\s$", "", "\u{85}"));
        assert!(m(r"^\S$", "", "\u{85}"));
        assert!(!m(r"^\d$", "", "\u{663}"));
        assert!(!m(r"^.$", "", "\u{2028}"));
        assert!(m(r"^.$", "", "é"));
        assert!(m(r"a\b", "", "aé"));
    }

    #[test]
    fn icase_folds_ascii_only() {
        assert!(m("^kind$", "i", "KIND"));
        assert!(!m("^k$", "i", "\u{212a}"));
        assert!(!m("^s$", "i", "\u{17f}"));
        assert!(m("^[A-Z_]+$", "i", "ab_C"));
        assert!(translate("é", "i").is_err());
    }

    #[test]
    fn classes_escape_rust_set_operators() {
        assert!(m("^[[{`|]", "", "[x"));
        assert!(m("^[ +-]*[-+]", "", " +"));
        assert!(m(r"^[^\s:\n]+$", "", "a/b"));
        assert!(!m(r"^[^\s:\n]+$", "", "a b"));
        assert!(m(r"^[/@*=>|]$", "", "|"));
    }

    #[test]
    fn braces_are_literal_unless_quantifiers() {
        assert!(m(r"^a{2}$", "", "aa"));
        assert!(m(r"^HEAD@\{0}$", "", "HEAD@{0}"));
        assert!(m(r"^[0-9a-f]{4,}$", "", "beef"));
    }

    #[test]
    fn multiline_wraps_and_lookaround_is_rejected() {
        assert!(m("^b", "m", "a\nb"));
        assert!(translate("(?!x)", "").is_err());
        assert!(translate(r"(a)\1", "").is_err());
    }
}
