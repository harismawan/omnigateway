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
    maybe_grow(RED_ZONE, SEGMENT, f)
}

thread_local! {
    static GROWS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many times this thread has moved to a fresh stack segment through
/// [`grow`] or [`scope`]: a probe for "shallow requests never grow".
pub fn grows() -> usize {
    GROWS.with(std::cell::Cell::get)
}

/// `stacker::maybe_grow`, counting the grow branch.
fn maybe_grow<R>(red_zone: usize, segment: usize, f: impl FnOnce() -> R) -> R {
    if stacker::remaining_stack().is_some_and(|left| left >= red_zone) {
        f()
    } else {
        GROWS.with(|c| c.set(c.get() + 1));
        stacker::grow(segment, f)
    }
}

/// Stack for a whole scope that walks client JSON with ordinary recursion
/// (derived `Drop`, `Clone`, `PartialEq`, `Serialize`, or a helper that
/// forgot [`grow`]).
///
/// Sized by measurement (`omni-dialects/tests/depth.rs`, every client-JSON
/// position at [`MAX_DEPTH`] through `ingress::ingest`): a 2 MiB segment
/// faults in a debug build and suffices in release; 4 MiB faults in debug;
/// 8 MiB passes both. 16 MiB doubles the debug figure. It is virtual memory,
/// mapped once per scope that needs it and committed only as far as the walk
/// actually reaches.
pub const SCOPE_SEGMENT: usize = 16 * 1024 * 1024;

/// Remaining stack below which [`scope`] moves to a fresh segment. A scope
/// that starts on a thread with less than this left always moves.
pub const SCOPE_RED_ZONE: usize = SCOPE_SEGMENT;

/// Runs `f` on a stack with at least [`SCOPE_SEGMENT`] bytes free, so that
/// anything inside may recurse once per level of a [`MAX_DEPTH`]-deep value.
///
/// Use it around every scope that holds client JSON: create, walk *and drop*
/// the values inside, or return them in a type whose `Drop` is iterative
/// ([`Owned`], or the IR types in `crate::request`).
pub fn scope<R>(f: impl FnOnce() -> R) -> R {
    maybe_grow(SCOPE_RED_ZONE, SCOPE_SEGMENT, f)
}

/// The deepest client JSON that runs without [`scope`] on a 2 MiB stack.
///
/// Measured in a **debug** build: every client-JSON position of
/// `omni-dialects/tests/depth.rs` plus Chat and Responses argument strings,
/// through `ingress::ingest` with [`scope`] *and* every [`grow`] disabled, on
/// a 2 MiB thread, ingested, cloned, serialized and dropped. The deepest that
/// survived was 1632 levels (1648 overflowed); release reached 4096. 512 is
/// under a third of the debug figure, and does not rely on [`grow`].
pub const SHALLOW_DEPTH: usize = 512;

/// An upper bound on how deep `text` nests once parsed, *including* JSON held
/// in its strings (tool-call `arguments`), scanned without parsing.
///
/// The result is the outer depth plus the deepest embedded depth of any one
/// string:
/// - **Outside strings** it counts containers exactly, as [`depth_of`] does.
/// - **Inside each string** it decodes the string's escapes (`\"`, `\\`,
///   `\/`, `\u005b`, ...) and tokenizes the *decoded* text as JSON, with its
///   own string and escape state, so brackets inside the embedded JSON's
///   strings never move its depth. On text that is valid JSON this is that
///   JSON's exact depth, which is the only case where a walker ever sees it
///   (`arguments` that fail to parse leave no value behind).
/// - **Embedded text that cannot be valid JSON** (a closer with nothing open,
///   an unterminated string, or containers left open) counts every `[` and
///   `{` it decodes to instead, which bounds any reading of it.
///
/// Only one level of embedding is decoded, matching ingress, which parses
/// `arguments` once: a string inside the embedded JSON stays a string.
pub fn depth_bound(text: &str) -> usize {
    let b = text.as_bytes();
    let (mut depth, mut outer_max) = (0usize, 0usize);
    let mut inner_max = 0usize;
    let mut inner: Option<Embedded> = None;
    let mut i = 0;
    while i < b.len() {
        // Bytes other than `"`, `\` and brackets change no state, except
        // the one byte after an embedded escape: skip runs of them.
        if !inner.as_ref().is_some_and(|e| e.escaped) {
            i = next_special(b, i);
            if i >= b.len() {
                break;
            }
        }
        let c = b[i];
        i += 1;
        let Some(embedded) = inner.as_mut() else {
            match c {
                b'"' => inner = Some(Embedded::default()),
                b'[' | b'{' => {
                    depth += 1;
                    outer_max = outer_max.max(depth);
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
            continue;
        };
        let unit = match c {
            b'"' => {
                inner_max = inner_max.max(embedded.bound());
                inner = None;
                continue;
            }
            b'\\' => {
                let escaped = b.get(i).copied();
                i += 1;
                match escaped {
                    Some(b'u') => {
                        let hex = text
                            .get(i..i + 4)
                            .and_then(|h| u16::from_str_radix(h, 16).ok());
                        if hex.is_some() {
                            i += 4;
                        }
                        // A non-ASCII unit is never JSON punctuation.
                        hex.map_or(b' ', |u| u8::try_from(u).unwrap_or(b'x'))
                    }
                    Some(e @ (b'"' | b'\\' | b'/')) => e,
                    // `\b \f \n \r \t` decode to whitespace; anything else
                    // makes the outer text invalid.
                    _ => b' ',
                }
            }
            other => other,
        };
        embedded.feed(unit);
    }
    // An unterminated outer string is not JSON, but bound it all the same.
    if let Some(embedded) = inner {
        inner_max = inner_max.max(embedded.bound());
    }
    outer_max + inner_max
}

/// `"`, `\\`, `[`, `]`, `{` or `}`: the only bytes [`depth_bound`] reads.
fn special(b: u8) -> bool {
    // `[`/`{` and `]`/`}` differ only in bit 5.
    let folded = b | 0x20;
    b == b'"' || b == b'\\' || folded == b'{' || folded == b'}'
}

/// The first index at or after `from` holding a [`special`] byte, or
/// `b.len()`. Tests 32 bytes at a time, which the compiler vectorizes.
fn next_special(b: &[u8], mut from: usize) -> usize {
    const BLOCK: usize = 32;
    // Fixed-size blocks, so the test below is branch-free and vectorized.
    for block in b[from..].as_chunks::<BLOCK>().0 {
        let mut hit = 0u8;
        for &c in block {
            hit |= u8::from(special(c));
        }
        if hit != 0 {
            break;
        }
        from += BLOCK;
    }
    b[from..]
        .iter()
        .position(|&c| special(c))
        .map_or(b.len(), |at| from + at)
}

/// The JSON tokenizer [`depth_bound`] runs over one decoded string.
#[derive(Default)]
struct Embedded {
    depth: usize,
    max: usize,
    /// Every `[` and `{` decoded, inside embedded strings or not.
    openers: usize,
    in_string: bool,
    escaped: bool,
    /// Seen a closer with nothing open: this text is not JSON.
    broken: bool,
}

impl Embedded {
    fn feed(&mut self, c: u8) {
        if matches!(c, b'[' | b'{') {
            self.openers += 1;
        }
        if self.in_string {
            if self.escaped {
                self.escaped = false;
            } else if c == b'\\' {
                self.escaped = true;
            } else if c == b'"' {
                self.in_string = false;
            }
            return;
        }
        match c {
            b'"' => self.in_string = true,
            b'[' | b'{' => {
                self.depth += 1;
                self.max = self.max.max(self.depth);
            }
            b']' | b'}' => match self.depth.checked_sub(1) {
                Some(d) => self.depth = d,
                None => self.broken = true,
            },
            _ => {}
        }
    }

    /// The exact depth when the text may be JSON, else every opener.
    fn bound(&self) -> usize {
        if self.broken || self.in_string || self.depth != 0 {
            self.openers
        } else {
            self.max
        }
    }
}

/// [`scope`] only when `text` may nest deeper than [`SHALLOW_DEPTH`]; an
/// ordinary request runs on the caller's stack and maps nothing.
pub fn scope_for<R>(text: &str, f: impl FnOnce() -> R) -> R {
    scope_for_bound(depth_bound(text), |_| f())
}

/// [`scope_for`] with the [`depth_bound`] already in hand, which `f` is given
/// (for [`parse_bounded`]).
pub fn scope_for_bound<R>(bound: usize, f: impl FnOnce(usize) -> R) -> R {
    if bound <= SHALLOW_DEPTH {
        f(bound)
    } else {
        scope(|| f(bound))
    }
}

/// `serialize_with` helpers for fields holding client JSON: serde's own
/// `Serialize for Value` recurses once per level, so these run it through a
/// stack-growing serializer.
pub mod ser {
    use serde::{Serialize, Serializer};

    /// Any field.
    pub fn value<T: Serialize, S: Serializer>(v: &T, s: S) -> Result<S::Ok, S::Error> {
        super::grow(|| {
            v.serialize(serde_stacker::Serializer {
                ser: s,
                red_zone: super::RED_ZONE,
                stack_size: super::SEGMENT,
            })
        })
    }

    /// An `Option` field (absent ones are skipped by the caller).
    pub fn opt<T: Serialize, S: Serializer>(v: &Option<T>, s: S) -> Result<S::Ok, S::Error> {
        value(v, s)
    }
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
    parse_within_bound(text)
}

/// [`parse`] given `bound`, the text's [`depth_bound`] (never below its
/// [`depth_of`]), so the depth scan is not repeated. Over [`MAX_DEPTH`] it is
/// [`parse`] itself.
pub fn parse_bounded(text: &str, bound: usize) -> Result<Value, ParseError> {
    if bound > MAX_DEPTH {
        return parse(text);
    }
    if bound <= SHALLOW_DEPTH {
        // Shallow enough for ordinary recursion on any worker stack (the
        // threshold tests in `omni-dialects/tests/depth.rs` ingest bodies at
        // exactly this bound on a 2 MiB thread, in debug): no stacker probe
        // per level.
        let mut de = serde_json::Deserializer::from_str(text);
        de.disable_recursion_limit();
        let value = Value::deserialize(&mut de).map_err(|_| ParseError::Syntax)?;
        return match de.end() {
            Ok(()) => Ok(value),
            Err(_) => {
                drop(value);
                Err(ParseError::Syntax)
            }
        };
    }
    parse_within_bound(text)
}

fn parse_within_bound(text: &str) -> Result<Value, ParseError> {
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
    fn the_bound_counts_json_inside_strings_and_escaped_brackets() {
        assert_eq!(depth_bound(r#"{"a":[1]}"#), 2);
        assert_eq!(depth_bound(r#"{"a":"[[[1]]]"}"#), 1 + 3);
        assert_eq!(depth_bound(r#"{"a":"\u005b\u005B\u007b"}"#), 1 + 3);
        assert_eq!(depth_bound(r#"{"a":"\"[\"","b":"[["}"#), 1 + 2);
        assert_eq!(depth_bound(r#"{"a":"]]]]"}"#), 1);
        // Decoded `\[` is not JSON: every opener counts.
        assert_eq!(depth_bound(r#"{"a":"\\[","b":1}"#), 1 + 1);
    }

    /// The reviewer's case: `{"x":"]","y":` N times, then `0` and N `}`.
    fn closers_in_strings(n: usize) -> String {
        format!("{}0{}", r#"{"x":"]","y":"#.repeat(n), "}".repeat(n))
    }

    #[test]
    fn closers_inside_embedded_strings_do_not_cancel_real_nesting() {
        for n in [1, 2, 513, 40_000] {
            let args = closers_in_strings(n);
            assert_eq!(depth_of(&args), n);
            let body = serde_json::json!({ "arguments": args }).to_string();
            assert_eq!(depth_bound(&body), 1 + n, "n = {n}");
        }
    }

    #[test]
    fn embedded_strings_keep_their_own_escapes() {
        // Closers after `\"` and `\\` inside the embedded JSON's strings, at
        // every level, in both bracket kinds.
        for (piece, close) in [
            (r#"{"x":"\"]}","y":"#, "}"),
            (r#"{"x":"\\","z":"]}","y":"#, "}"),
            (r#"["\\\"]]",["#, "]]"),
        ] {
            for n in [1, 7, 600] {
                let args = format!("{}0{}", piece.repeat(n), close.repeat(n));
                let want = depth_of(&args);
                assert!(want >= n, "{piece}: fixture depth {want}");
                let body = serde_json::json!({ "a": args }).to_string();
                assert_eq!(depth_bound(&body), 1 + want, "{piece} x {n}");
            }
        }
    }

    #[test]
    fn malformed_embedded_text_counts_every_opener() {
        let cases = [
            ("]]]{{{", 3),     // closer with nothing open
            (r#"[["["#, 3),    // unterminated string: opener in it counts
            ("[[[[", 4),       // left open
            (r#"{"a":"]"#, 1), // unterminated
        ];
        for (args, want) in cases {
            let body = serde_json::json!({ "a": args }).to_string();
            assert_eq!(depth_bound(&body), 1 + want, "{args}");
        }
    }

    #[test]
    fn a_double_encoded_argument_is_bounded_by_its_first_decoding() {
        // `arguments` is a JSON string whose content is itself JSON: ingress
        // parses once and keeps a string, so depth 0 inside, and the
        // brackets of the inner text never hide outer nesting.
        let inner = closers_in_strings(50);
        let once = serde_json::to_string(&inner).expect("encode");
        let body = serde_json::json!({ "arguments": once }).to_string();
        assert!(depth_bound(&body) >= 1);
        let wrapped = format!(r#"[{once},{}]"#, closers_in_strings(600));
        let body = serde_json::json!({ "arguments": wrapped }).to_string();
        assert_eq!(depth_bound(&body), 1 + 1 + 600);
    }

    /// A tiny xorshift, so the property test is reproducible.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// A string mixing JSON punctuation, escapes and, sometimes, a whole
    /// encoded JSON value (double encoding).
    fn gen_string(rng: &mut Rng, budget: usize) -> String {
        if budget > 0 && rng.below(4) == 0 {
            return gen_value(rng, budget.min(4)).to_string();
        }
        const ALPHABET: &[char] = &['[', ']', '{', '}', '"', '\\', '/', 'a', ':', ',', '\n'];
        (0..rng.below(8))
            .map(|_| ALPHABET[rng.below(ALPHABET.len() as u64) as usize])
            .collect()
    }

    fn gen_value(rng: &mut Rng, budget: usize) -> Value {
        let kind = if budget == 0 {
            rng.below(3)
        } else {
            rng.below(6)
        };
        match kind {
            0 => Value::from(rng.below(100)),
            1 => Value::Null,
            2 => Value::String(gen_string(rng, budget / 2)),
            3 | 4 => Value::Array(
                (0..=rng.below(3))
                    .map(|_| gen_value(rng, budget - 1))
                    .collect(),
            ),
            _ => Value::Object(
                (0..=rng.below(3))
                    .map(|_| (gen_string(rng, 0), gen_value(rng, budget - 1)))
                    .collect(),
            ),
        }
    }

    /// True container depth, by an explicit-stack walk of the parsed value.
    fn true_depth(v: &Value) -> usize {
        let mut max = 0;
        let mut pending = vec![(v, 0usize)];
        while let Some((v, d)) = pending.pop() {
            let children: Vec<&Value> = match v {
                Value::Array(a) => a.iter().collect(),
                Value::Object(m) => m.values().collect(),
                _ => continue,
            };
            max = max.max(d + 1);
            pending.extend(children.into_iter().map(|c| (c, d + 1)));
        }
        max
    }

    /// The deepest JSON value any string in `v` parses to (one decoding).
    fn embedded_depth(v: &Value) -> usize {
        let mut max = 0;
        let mut pending = vec![v];
        while let Some(v) = pending.pop() {
            match v {
                Value::String(s) => {
                    if let Ok(inner) = parse(s) {
                        max = max.max(true_depth(&inner));
                    }
                }
                Value::Array(a) => pending.extend(a),
                Value::Object(m) => {
                    for (k, v) in m {
                        if let Ok(inner) = parse(k) {
                            max = max.max(true_depth(&inner));
                        }
                        pending.push(v);
                    }
                }
                _ => {}
            }
        }
        max
    }

    #[test]
    fn the_bound_is_never_below_the_true_depth_of_generated_json() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for case in 0..3000 {
            let budget = 1 + rng.below(12) as usize;
            // Arguments: generated JSON, encoded into a string.
            let args = gen_value(&mut rng, budget);
            let args = if rng.below(2) == 0 {
                args.to_string()
            } else {
                // A ragged chain of real nesting with closers in strings.
                let n = rng.below(40) as usize;
                format!("{}{args}{}", r#"{"x":"]}","y":["#.repeat(n), "]}".repeat(n))
            };
            let body = serde_json::json!({
                "o": gen_value(&mut rng, budget),
                "messages": [{ "arguments": args }],
            });
            let text = body.to_string();
            let truth = true_depth(&body) + embedded_depth(&body);
            let bound = depth_bound(&text);
            assert!(bound >= truth, "case {case}: {bound} < {truth}: {text}");
        }
    }

    #[test]
    fn the_skipping_scan_matches_a_byte_at_a_time_one() {
        // Brackets and escapes at every offset around the 32-byte blocks.
        let mut rng = Rng(7);
        for _ in 0..2000 {
            let n = rng.below(200) as usize;
            let text: String = (0..n)
                .map(|_| match rng.below(12) {
                    0 => '[',
                    1 => ']',
                    2 => '{',
                    3 => '}',
                    4 => '"',
                    5 => '\\',
                    6 => 'u',
                    7 => '5',
                    _ => 'a',
                })
                .collect();
            let b = text.as_bytes();
            for from in 0..=b.len() {
                let want = b[from..]
                    .iter()
                    .position(|&c| matches!(c, b'"' | b'\\' | b'[' | b']' | b'{' | b'}'))
                    .map_or(b.len(), |at| from + at);
                assert_eq!(next_special(b, from), want, "{text:?} from {from}");
            }
        }
    }

    #[test]
    fn parse_bounded_still_refuses_past_the_bound() {
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        assert_eq!(
            parse_bounded(&deep, depth_bound(&deep)),
            Err(ParseError::TooDeep)
        );
        assert_eq!(
            parse_bounded("[[1]]", depth_bound("[[1]]")),
            Ok(serde_json::json!([[1]]))
        );
    }

    #[test]
    fn parse_matches_json_parse_on_trailing_and_bad_input() {
        assert_eq!(parse(" [1] "), Ok(serde_json::json!([1])));
        assert_eq!(parse("[1] x"), Err(ParseError::Syntax));
        assert_eq!(parse("{"), Err(ParseError::Syntax));
        assert_eq!(parse(""), Err(ParseError::Syntax));
    }
}
