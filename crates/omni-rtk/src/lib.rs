//! RTK: pure tool-result filters.
//!
//! [`transform_request`] compresses eligible tool results in a request and
//! reports what it did. It is copy-on-write: when nothing changes it returns
//! [`Cow::Borrowed`] — the "same object" — and otherwise a new
//! request whose untouched messages equal the input's.
//!
//! All sizes, limits and the acceptance guard are in UTF-16 code units
//! (`string.length` semantics). Patterns are JS `RegExp` sources, matched
//! with JS semantics by `jsre`; the three lookaheads are written out by
//! hand.

pub mod catalog;
pub mod command;
pub mod detect;
pub mod filters;
mod jsre;

pub use catalog::{RTK_FILTER_IDS, RtkFilterId, is_rtk_filter_id};

use command::{CommandClassification, GrepMode, classify_command};
use filters::shared::{BoundedText, render_selection, scan_text};
use jsre::{js_regex, normalize_terminators};
use omni_ir::js::utf16_len;
use omni_ir::request::{ChatRequest, ContentBlock, Message, ToolUseBlock};
use omni_ir::tokens::estimate_input_tokens;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};

/// `RtkConfig`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtkConfig {
    pub enabled: bool,
}

/// `RtkReport`. Code-unit counts are UTF-16; `estimated_tokens_saved` is the
/// JS number `estimateInputTokens` difference.
#[derive(Debug, Clone, PartialEq)]
pub struct RtkReport {
    pub applied: bool,
    pub filter_hits: u64,
    pub original_code_units: u64,
    pub compressed_code_units: u64,
    pub estimated_tokens_saved: f64,
    pub filters: Vec<RtkFilterId>,
    pub skipped_internal_errors: u64,
}

/// `RtkTransformResult`.
#[derive(Debug)]
pub struct RtkTransformResult<'a> {
    pub request: Cow<'a, ChatRequest>,
    pub report: RtkReport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    Shell,
    NonShell,
    Unknown,
}

const MAX_INPUT: usize = 1_000_000;
const MAX_OUTPUT: usize = 250_000;
const SHELL: [&str; 6] = [
    "bash",
    "shell",
    "terminal",
    "exec",
    "run_command",
    "execute_command",
];
const NON_SHELL: [&str; 13] = [
    "read",
    "edit",
    "write",
    "glob",
    "grep_search",
    "search",
    "web_search",
    "web_fetch",
    "read_file",
    "list_directory",
    "find_files",
    "code_search",
    "apply_patch",
];

fn empty_report(errors: u64) -> RtkReport {
    RtkReport {
        applied: false,
        filter_hits: 0,
        original_code_units: 0,
        compressed_code_units: 0,
        estimated_tokens_saved: 0.0,
        filters: Vec::new(),
        skipped_internal_errors: errors,
    }
}

/// `name.toLowerCase().replace(/[-./\s]+/g, "_")`.
fn normalize_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut in_run = false;
    for c in lower.chars() {
        let separator = matches!(c, '-' | '.' | '/') || omni_ir::js::is_js_whitespace(c);
        if separator {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

fn origin_of(tool: Option<&ToolUseBlock>) -> Origin {
    let Some(tool) = tool else {
        return Origin::Unknown;
    };
    let name = normalize_name(&tool.name);
    if SHELL.contains(&name.as_str()) {
        Origin::Shell
    } else if NON_SHELL.contains(&name.as_str()) {
        Origin::NonShell
    } else {
        Origin::Unknown
    }
}

/// `extractCommand`: a non-empty string input, or the first non-empty string
/// among the own `command`, `cmd`, `script` fields of a plain object.
pub fn extract_command(input: &Value) -> Option<&str> {
    match input {
        Value::String(s) => (!s.is_empty()).then_some(s.as_str()),
        Value::Object(object) => ["command", "cmd", "script"]
            .iter()
            .filter_map(|key| object.get(*key))
            .find_map(|value| value.as_str().filter(|s| !s.is_empty())),
        _ => None,
    }
}

/// `lines.slice(0, 64).join("\n").slice(0, 4_096)`. Cutting through a
/// surrogate pair leaves its high half, which [`omni_ir::js::utf16_prefix`]
/// renders as U+FFFD; the probes below treat both as one non-space,
/// non-terminator unit, so the substitution cannot change a match.
fn prefix(lines: &[&str]) -> String {
    let joined = lines[..lines.len().min(64)].join("\n");
    omni_ir::js::utf16_prefix(&joined, 4_096).into_owned()
}

fn sample_rows<'a>(lines: &[&'a str]) -> Vec<&'a str> {
    if lines.len() <= 128 {
        lines.to_vec()
    } else {
        lines[..64]
            .iter()
            .chain(&lines[lines.len() - 64..])
            .copied()
            .collect()
    }
}

struct Detection {
    id: RtkFilterId,
    classification: Option<CommandClassification>,
}

js_regex!(
    STATUS_EVIDENCE_A = r"^(?:On branch |## |Changes |Untracked files:)",
    "m"
);
js_regex!(
    STATUS_EVIDENCE_B = r"^(?:[ MADRCU?!]{2} |\s+(?:modified|deleted|new file):)",
    "m"
);
js_regex!(INFERRED_GREP = r"^(?:[A-Za-z]:\\.+|[^\n:]+):\d+:.+$");
js_regex!(PATH_BODY = r"^[^\s:\n]+(?:[/\\][^\s:\n]+)*$");
js_regex!(PROSE = r"\s(?:is|are|the|this|that)\s", "i");
js_regex!(STRUCTURE = r"^(?:```|\{|\[)|\|.+\|$");
js_regex!(NUMBERED_ROW = r"^\s*\d+[\t |:].+$", "m");

/// The path-shape probe in `detect`, with its lookaheads written out: the
/// same grammar as listings' `RELATIVE_PATH`.
fn path_shaped(line: &str) -> bool {
    filters::listings::relative_path_shape(line, &PATH_BODY)
}

fn detect(input: &BoundedText<'_>, command: Option<&str>, origin: Origin) -> Option<Detection> {
    let lines = &input.lines;
    let sample = prefix(lines);
    let sample = normalize_terminators(&sample);
    let classification = match (origin, command) {
        (Origin::Shell, Some(command)) => {
            let classification = classify_command(command);
            classification.as_ref()?;
            classification
        }
        _ => None,
    };
    if let Some(classification) = classification {
        return Some(Detection {
            id: classification.family,
            classification: Some(classification),
        });
    }
    let only = |id| {
        Some(Detection {
            id,
            classification: None,
        })
    };
    if filters::git::GIT_DIFF_EVIDENCE_HEADER.test(&sample)
        && filters::git::GIT_DIFF_EVIDENCE_PAIR.test(&sample)
    {
        return only(RtkFilterId::GitDiff);
    }
    if STATUS_EVIDENCE_A.test(&sample) && STATUS_EVIDENCE_B.test(&sample) {
        return only(RtkFilterId::GitStatus);
    }
    if filters::git::GIT_LOG_EVIDENCE_COMMIT.test(&sample)
        && filters::git::GIT_LOG_EVIDENCE_BODY.test(&sample)
    {
        return only(RtkFilterId::GitLog);
    }
    if origin == Origin::Unknown
        && let Some(id) = detect::infer_build_or_test(&sample_rows(lines))
    {
        return only(id);
    }
    if origin == Origin::Unknown {
        let grep_rows = lines.iter().filter(|l| INFERRED_GREP.test(l)).count();
        let nonempty = lines.iter().filter(|l| !l.is_empty()).count().max(1);
        #[allow(clippy::cast_precision_loss)]
        let dense = grep_rows as f64 / nonempty as f64 >= 0.8;
        if grep_rows >= 3 && dense {
            return Some(Detection {
                id: RtkFilterId::Grep,
                classification: Some(CommandClassification {
                    family: RtkFilterId::Grep,
                    executable: "inferred".to_owned(),
                    subcommand: None,
                    grep_mode: Some(GrepMode {
                        heading: false,
                        line_number: true,
                        before_context: 0.0,
                        after_context: 0.0,
                    }),
                }),
            });
        }
    }
    let mut candidates = 0usize;
    let mut path_lines = 0usize;
    let mut conflicts = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        candidates += 1;
        if path_shaped(line) {
            path_lines += 1;
        }
        if PROSE.test(line) || STRUCTURE.test(line) {
            conflicts += 1;
        }
    }
    #[allow(clippy::cast_precision_loss)]
    if candidates >= 10
        && path_lines as f64 / candidates as f64 >= 0.8
        && conflicts as f64 / candidates as f64 <= 0.1
    {
        return only(RtkFilterId::PathList);
    }
    if origin == Origin::Shell && NUMBERED_ROW.count(&sample) >= 10 {
        return only(RtkFilterId::NumberedRead);
    }
    None
}

fn keep_regions<'a>(input: &BoundedText<'a>, head: usize, tail: usize) -> Cow<'a, str> {
    if !input.budget.charge_records(head + tail) {
        return input.unchanged();
    }
    let len = input.lines.len();
    let mut selected: BTreeSet<usize> = (0..head.min(len)).collect();
    selected.extend(head.max(len.saturating_sub(tail))..len);
    match render_selection(input, &selected, "lines") {
        Some(rendered) => Cow::Owned(rendered),
        None => input.unchanged(),
    }
}

fn deduplicate<'a>(input: &BoundedText<'a>) -> Cow<'a, str> {
    let mut selected = BTreeSet::new();
    let mut previous: Option<&str> = None;
    for (index, &line) in input.lines.iter().enumerate() {
        if previous == Some(line) {
            continue;
        }
        if !input.budget.charge_records(1) {
            return input.unchanged();
        }
        selected.insert(index);
        previous = Some(line);
    }
    match render_selection(input, &selected, "lines") {
        Some(rendered) => Cow::Owned(rendered),
        None => input.unchanged(),
    }
}

fn keep_anchors<'a>(
    input: &BoundedText<'a>,
    is_anchor: impl Fn(&str) -> bool,
    head: usize,
    tail: usize,
) -> Cow<'a, str> {
    let len = input.lines.len();
    let mut selected = BTreeSet::new();
    for (index, line) in input.lines.iter().enumerate() {
        if index < head || index + tail >= len || is_anchor(line) {
            if !input.budget.charge_records(1) {
                return input.unchanged();
            }
            selected.insert(index);
        }
    }
    match render_selection(input, &selected, "lines") {
        Some(rendered) => Cow::Owned(rendered),
        None => input.unchanged(),
    }
}

fn specialized<'a>(
    input: &BoundedText<'a>,
    id: RtkFilterId,
    classification: Option<&CommandClassification>,
) -> Cow<'a, str> {
    use RtkFilterId as F;
    use filters::{build, diagnostics, docker, git, listings, packages, search, status, tests};
    let executable = classification.map(|c| c.executable.as_str());
    match id {
        F::GitStatus => return status::compress_git_status(input),
        F::LintOutput => return diagnostics::compress_diagnostics(input),
        F::BuildOutput => return build::compress_build(input),
        F::TestOutput => return tests::compress_tests(input, executable.unwrap_or("unknown")),
        F::PackageOutput => {
            return packages::compress_packages(input, executable.unwrap_or("unknown"));
        }
        F::GitOperation => return git::compress_git_operation(input),
        F::DockerBuild => return docker::compress_docker(input),
        F::TreeOutput | F::PathList => {
            return listings::compress_listing(
                input,
                executable.unwrap_or("find"),
                classification.and_then(|c| c.subcommand.as_deref()),
                classification.is_some(),
            );
        }
        F::Grep => {
            if let Some(mode) = classification.and_then(|c| c.grep_mode.as_ref()) {
                return search::compress_grep(input, mode);
            }
        }
        _ => {}
    }
    if !input.budget.charge_records(input.lines.len()) {
        return input.unchanged();
    }
    match id {
        F::GitDiff => keep_anchors(input, |l| git::GIT_DIFF_ANCHOR.test(l), 20, 12),
        F::GitLog => keep_anchors(input, |l| git::GIT_LOG_ANCHOR.test(l), 20, 12),
        F::Grep => keep_regions(input, 40, 20),
        F::NumberedRead => {
            if input.lines.len() >= 250 {
                keep_regions(input, 100, 50)
            } else {
                input.unchanged()
            }
        }
        F::DeduplicateLog => deduplicate(input),
        F::SmartTruncate => keep_regions(input, 200, 100),
        // Handled above; the switch is exhaustive over the remaining ids.
        _ => input.unchanged(),
    }
}

fn accept(original: &str, candidate: Cow<'_, str>) -> Option<String> {
    let units = utf16_len(&candidate);
    (units > 0 && units < utf16_len(original) && units <= MAX_OUTPUT)
        .then(|| candidate.into_owned())
}

struct FilterResult {
    content: String,
    filters: Vec<RtkFilterId>,
}

fn filter(input: &BoundedText<'_>, origin: Origin, command: Option<&str>) -> Option<FilterResult> {
    let content = input.text;
    if let Some(Detection { id, classification }) = detect(input, command, origin) {
        let first = accept(content, specialized(input, id, classification.as_ref()))?;
        return Some(FilterResult {
            content: first,
            filters: vec![id],
        });
    }
    if origin != Origin::Shell {
        return None;
    }
    let lines = input.lines.len();
    if lines >= 20
        && let Some(compact) = accept(content, deduplicate(input))
    {
        return Some(FilterResult {
            content: compact,
            filters: vec![RtkFilterId::DeduplicateLog],
        });
    }
    if lines >= 500
        && let Some(compact) = accept(
            content,
            specialized(input, RtkFilterId::SmartTruncate, None),
        )
    {
        return Some(FilterResult {
            content: compact,
            filters: vec![RtkFilterId::SmartTruncate],
        });
    }
    None
}

/// `skippedInternalErrors` counts blocks whose compression threw; nothing
/// here can throw (no indexing panics, no allocation-failure recovery), so
/// that counter is always zero.
pub fn transform_request<'a>(
    request: &'a ChatRequest,
    config: &RtkConfig,
) -> RtkTransformResult<'a> {
    if !config.enabled {
        return RtkTransformResult {
            request: Cow::Borrowed(request),
            report: empty_report(0),
        };
    }
    let mut uses: HashMap<&str, &ToolUseBlock> = HashMap::new();
    let mut changed = false;
    let mut original_code_units = 0u64;
    let mut compressed_code_units = 0u64;
    let mut filter_hits = 0u64;
    let mut filter_order: Vec<RtkFilterId> = Vec::new();
    // Per message, the rewritten blocks (by index) when any block changed.
    let mut rewrites: Vec<Option<Vec<(usize, String)>>> =
        Vec::with_capacity(request.messages.len());
    for message in &request.messages {
        let mut message_rewrites = Vec::new();
        for (block_index, block) in message.content.iter().enumerate() {
            let result = match block {
                ContentBlock::ToolUse(use_) => {
                    uses.insert(use_.id.as_str(), use_);
                    continue;
                }
                ContentBlock::ToolResult(result) => result,
                _ => continue,
            };
            if result.is_error == Some(true)
                || result.cache_control.is_some()
                || utf16_len(&result.content) > MAX_INPUT
            {
                continue;
            }
            let use_ = uses.get(result.tool_use_id.as_str()).copied();
            let origin = origin_of(use_);
            if origin == Origin::NonShell {
                continue;
            }
            let command = match (origin, use_) {
                (Origin::Shell, Some(use_)) => extract_command(&use_.input),
                _ => None,
            };
            let Some(bounded) = scan_text(&result.content) else {
                continue;
            };
            let Some(filtered) = filter(&bounded, origin, command) else {
                continue;
            };
            changed = true;
            original_code_units += utf16_len(&result.content) as u64;
            compressed_code_units += utf16_len(&filtered.content) as u64;
            filter_hits += filtered.filters.len() as u64;
            for id in filtered.filters {
                if !filter_order.contains(&id) {
                    filter_order.push(id);
                }
            }
            message_rewrites.push((block_index, filtered.content));
        }
        rewrites.push((!message_rewrites.is_empty()).then_some(message_rewrites));
    }
    if !changed {
        return RtkTransformResult {
            request: Cow::Borrowed(request),
            report: empty_report(0),
        };
    }
    let mut transformed = request.clone();
    for (message, rewrite) in transformed.messages.iter_mut().zip(rewrites) {
        apply(message, rewrite.unwrap_or_default());
    }
    let saved = (estimate_input_tokens(request) - estimate_input_tokens(&transformed)).max(0.0);
    RtkTransformResult {
        request: Cow::Owned(transformed),
        report: RtkReport {
            applied: true,
            filter_hits,
            original_code_units,
            compressed_code_units,
            estimated_tokens_saved: saved,
            filters: filter_order,
            skipped_internal_errors: 0,
        },
    }
}

fn apply(message: &mut Message, rewrite: Vec<(usize, String)>) {
    for (index, content) in rewrite {
        if let Some(ContentBlock::ToolResult(block)) = message.content.get_mut(index) {
            block.content = content;
        }
    }
}
