//! Shared fixtures for the RTK regression suite.
//!
//! The suite asserts whether `transform_request(...).request` is the input
//! object. The API returns `Cow::Borrowed` exactly when the request is
//! unchanged, so `unchanged` tests that identity, not a value comparison.

#![allow(dead_code)]

use omni_ir::request::{ChatRequest, ContentBlock};
use omni_rtk::{RtkConfig, RtkFilterId, RtkReport, transform_request};
use serde_json::{Value, json};
use std::borrow::Cow;

pub const ENABLED: RtkConfig = RtkConfig { enabled: true };

pub fn req(value: Value) -> ChatRequest {
    serde_json::from_value(value).expect("fixture request")
}

/// `{ assistant: toolUse(id, name, input), user: toolResult(id, content) }`.
pub fn tool_request(id: &str, name: &str, input: Value, content: &str) -> ChatRequest {
    req(json!({
        "model": "fast",
        "stream": false,
        "messages": [
            {"role": "assistant", "content": [{"type": "toolUse", "id": id, "name": name, "input": input}]},
            {"role": "user", "content": [{"type": "toolResult", "toolUseId": id, "content": content}]},
        ],
    }))
}

/// A lone tool result whose `toolUseId` matches no tool use: unknown origin.
pub fn orphan_request(content: &str) -> ChatRequest {
    req(json!({
        "model": "fast",
        "stream": false,
        "messages": [
            {"role": "user", "content": [{"type": "toolResult", "toolUseId": "orphan", "content": content}]},
        ],
    }))
}

pub fn result_content(request: &ChatRequest, message: usize, block: usize) -> String {
    match request
        .messages
        .get(message)
        .and_then(|m| m.content.get(block))
    {
        Some(ContentBlock::ToolResult(b)) => b.content.clone(),
        _ => panic!("expected tool result"),
    }
}

pub struct Fixture {
    pub input: ChatRequest,
    pub output: ChatRequest,
    /// `output.request === input`.
    pub unchanged: bool,
    pub report: RtkReport,
    pub content: String,
    pub original: String,
    pub lines: Vec<String>,
}

pub fn transform(input: ChatRequest, message: usize) -> Fixture {
    let result = transform_request(&input, &ENABLED);
    let unchanged = matches!(result.request, Cow::Borrowed(_));
    let report = result.report;
    let output = result.request.into_owned();
    let content = result_content(&output, message, 0);
    let original = result_content(&input, message, 0);
    let lines = original.split('\n').map(str::to_owned).collect();
    Fixture {
        input,
        output,
        unchanged,
        report,
        content,
        original,
        lines,
    }
}

/// The common `run(command, lines, name = "bash")` helper: `input: { command }`.
pub fn run_named<S: AsRef<str>>(command: &str, lines: &[S], name: &str) -> Fixture {
    let joined = join(lines);
    transform(
        tool_request("x", name, json!({ "command": command }), &joined),
        1,
    )
}

pub fn run<S: AsRef<str>>(command: &str, lines: &[S]) -> Fixture {
    run_named(command, lines, "bash")
}

pub fn run_orphan<S: AsRef<str>>(lines: &[S]) -> Fixture {
    transform(orphan_request(&join(lines)), 0)
}

pub fn join<S: AsRef<str>>(lines: &[S]) -> String {
    lines
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn has(report: &RtkReport, id: &str) -> bool {
    report.filters.iter().any(|f| f.as_str() == id)
}

pub fn filters(report: &RtkReport) -> Vec<&'static str> {
    report
        .filters
        .iter()
        .map(|f| RtkFilterId::as_str(*f))
        .collect()
}

pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `Array.from({ length }, (_, i) => f(i))`.
pub fn gen_lines(count: usize, f: impl Fn(usize) -> String) -> Vec<String> {
    (0..count).map(f).collect()
}

pub fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

/// Lines matching `^\.\.\. (\d+) ([^\n]*?) omitted \.\.\.$` (the 18th/19th
/// audit `MARKER`): `(count, unit)`.
pub fn marker(line: &str) -> Option<(u64, &str)> {
    let rest = line.strip_prefix("... ")?;
    let rest = rest.strip_suffix(" omitted ...")?;
    let (digits, unit) = rest.split_once(' ')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((digits.parse().ok()?, unit))
}

/// The 16th/17th audit form `^\.\.\. (\d+) [^\n]*omitted[^\n]*\.\.\.$`
/// (multiline): a line that starts `... N ` and ends `...` with `omitted`
/// between.
pub fn loose_marker(line: &str) -> Option<u64> {
    let rest = line.strip_prefix("... ")?;
    let (digits, tail) = rest.split_once(' ')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let omitted = tail.find("omitted")?;
    tail[omitted + "omitted".len()..]
        .ends_with("...")
        .then_some(())?;
    digits.parse().ok()
}

pub fn omitted_total(content: &str) -> u64 {
    content.split('\n').filter_map(marker).map(|(n, _)| n).sum()
}

pub fn loose_omitted_total(content: &str) -> u64 {
    content.split('\n').filter_map(loose_marker).sum()
}

pub fn loose_marker_count(content: &str) -> usize {
    content.split('\n').filter_map(loose_marker).count()
}

pub fn retained_rows(content: &str) -> usize {
    content.split('\n').filter(|l| marker(l).is_none()).count()
}

pub fn count_occurrences(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

pub fn noise(count: usize) -> Vec<String> {
    gen_lines(count, |i| format!("progress {i}"))
}

pub fn cat(parts: &[Vec<String>]) -> Vec<String> {
    parts.concat()
}

pub fn expect_compressed(f: &Fixture, id: &str) {
    assert!(f.report.applied, "applied");
    assert!(
        has(&f.report, id),
        "filters {:?} contain {id}",
        filters(&f.report)
    );
    assert!(
        utf16_len(&f.content) < utf16_len(&f.original),
        "compressed shorter"
    );
}
