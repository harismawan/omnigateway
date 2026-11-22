//! `tree`, `ls -l`, `ls -R`/`-lR`
//! and path lists.
//!
//! The tree is held as an arena and walked with explicit stacks: a `tree`
//! output can nest as deep as it has rows, so the walk is iterative and
//! adversarial depth cannot exhaust the Rust stack. Budget charges happen
//! in the same order a recursive walk would pay them.

use super::shared::{BoundedText, MAX_OUTPUT};
use crate::jsre::js_regex;
use omni_ir::js::{is_js_whitespace, utf16_len};
use std::borrow::Cow;
use std::collections::HashMap;

js_regex!(
    LONG = r"^[bcdlps-][rwxStTs-]{9}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+(?:\d{2}:\d{2}|\d{4})\s+.+$"
);
js_regex!(SUMMARY = r"^\d+ director(?:y|ies), \d+ files?$");
js_regex!(TREE_ROW = r"^((?:│ {3}| {4})*)(├── |└── )(.+)$");
js_regex!(TREE_GLYPH = r"[│├└]");
js_regex!(LINK_TARGET = r" -> .+$");
js_regex!(CLASSIFY_SUFFIX = r"[/@*=>|]$");
js_regex!(GROUP_HEADING = r"^.+:$");
js_regex!(TOTAL = r"^total \d+$");
js_regex!(PLAIN_ENTRY = r"^[^/\\:\n]+$");
js_regex!(
    GATED_PROSE = r"\s(?:is|are|the|this|that|because|and|with|from|into|were)\s",
    "i"
);
js_regex!(GATED_TABLE = r"^\|.*\|$");
js_regex!(GATED_STRUCTURE = r"^(?:```|\{|\[|`|\|)");
js_regex!(GATED_DRIVE = r"^[A-Za-z]:[/\\]");
js_regex!(WHITESPACE = r"\s");
// `RELATIVE_PATH` minus its two leading lookaheads, which `relative_path`
// writes out.
js_regex!(RELATIVE_PATH_BODY = r"^[^\s:\n]+(?:[/\\][^\s:\n]+)*$");

#[derive(Debug)]
struct Group<'a> {
    key: Cow<'a, str>,
    rows: Vec<&'a str>,
    entry_count: usize,
}

fn plural(count: usize, one: &'static str, many: &'static str) -> &'static str {
    if count == 1 { one } else { many }
}

fn render_groups(input: &BoundedText<'_>, groups: &[Group<'_>]) -> Option<String> {
    let mut output: Vec<Cow<'_, str>> = Vec::new();
    let mut omitted_groups = 0;
    let mut omitted_entries = 0;
    let append = |output: &mut Vec<Cow<'_, str>>, fragment: Cow<'_, str>| -> bool {
        if !input.budget.charge_records(1) || !input.budget.charge_code_units(utf16_len(&fragment))
        {
            return false;
        }
        // Lifetimes: every fragment is either input text or owned.
        output.push(Cow::Owned(fragment.into_owned()));
        true
    };
    let flush = |output: &mut Vec<Cow<'_, str>>, groups: &mut usize, entries: &mut usize| -> bool {
        if *groups == 0 {
            return true;
        }
        let marker = format!(
            "... {} {} omitted containing {} {} ...",
            *groups,
            plural(*groups, "directory", "directories"),
            *entries,
            plural(*entries, "entry", "entries")
        );
        *groups = 0;
        *entries = 0;
        append(output, Cow::Owned(marker))
    };
    let total = groups.len();
    for (group_index, group) in groups.iter().enumerate() {
        if !input.budget.charge_records(1) {
            return None;
        }
        let retain = total <= 40 || group_index < 20 || group_index >= total - 20;
        if !retain {
            omitted_groups += 1;
            omitted_entries += group.entry_count;
            continue;
        }
        if !flush(&mut output, &mut omitted_groups, &mut omitted_entries) {
            return None;
        }
        let prefix_count = group.rows.len() - group.entry_count;
        for (row_index, row) in group.rows.iter().enumerate() {
            if !input.budget.charge_records(1) {
                return None;
            }
            let retain_entry = row_index < prefix_count || group.entry_count <= 12 || {
                let entry = row_index - prefix_count;
                entry < 6 || entry >= group.entry_count - 6
            };
            if retain_entry && !append(&mut output, Cow::Borrowed(row)) {
                return None;
            }
        }
        if group.entry_count > 12 {
            let count = group.entry_count - 12;
            let marker = format!(
                "... {count} {} omitted from {} ...",
                plural(count, "entry", "entries"),
                group.key
            );
            if !append(&mut output, Cow::Owned(marker)) {
                return None;
            }
        }
    }
    if !flush(&mut output, &mut omitted_groups, &mut omitted_entries) {
        return None;
    }
    let rendered = output.join("\n");
    (utf16_len(&rendered) <= MAX_OUTPUT).then_some(rendered)
}

#[derive(Debug)]
struct TreeNode<'a> {
    key: String,
    line: &'a str,
    classified_directory: bool,
    children: Vec<usize>,
}

#[derive(Debug, Default, Clone, Copy)]
struct TreeCount {
    directories: usize,
    entries: usize,
    ambiguous: bool,
}

/// Subtree counts, iteratively. One record per node, charged in pre-order;
/// a failed charge stops the walk.
fn subtree_counts(
    input: &BoundedText<'_>,
    nodes: &[TreeNode<'_>],
    root: usize,
    classified: bool,
) -> Option<TreeCount> {
    let mut total = TreeCount::default();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        if !input.budget.charge_records(1) {
            return None;
        }
        let node = &nodes[id];
        if node.children.is_empty() {
            if node.classified_directory {
                total.directories += 1;
            } else {
                total.entries += 1;
            }
            total.ambiguous |= !classified;
        } else {
            total.directories += 1;
            stack.extend(node.children.iter().rev());
        }
    }
    Some(total)
}

enum Step {
    /// Emit a node's line, then lay out its children.
    Enter(usize),
    /// One child of `parent`, in order: joins the omitted run, or flushes it
    /// and is entered.
    Child {
        parent: usize,
        child: usize,
        retained: bool,
    },
    /// The parent's final flush.
    Leave(usize),
}

/// Append a subtree, iteratively, keeping the recursive charge order.
fn append_subtree<'a>(
    input: &BoundedText<'a>,
    output: &mut Vec<Cow<'a, str>>,
    nodes: &[TreeNode<'a>],
    root: usize,
    classified: bool,
) -> bool {
    // The omitted run pending for each node on the walk.
    let mut omitted: HashMap<usize, Vec<usize>> = HashMap::new();
    let flush = |omitted: &mut HashMap<usize, Vec<usize>>,
                 output: &mut Vec<Cow<'a, str>>,
                 parent: usize|
     -> bool {
        let Some(run) = omitted.get_mut(&parent) else {
            return true;
        };
        if run.is_empty() {
            return true;
        }
        let mut count = TreeCount::default();
        for &child in run.iter() {
            let Some(c) = subtree_counts(input, nodes, child, classified) else {
                return false;
            };
            count.directories += c.directories;
            count.entries += c.entries;
            count.ambiguous |= c.ambiguous;
        }
        if count.ambiguous {
            return false;
        }
        let marker = if count.directories == 0 {
            format!(
                "... {} {} omitted from {} ...",
                count.entries,
                plural(count.entries, "entry", "entries"),
                nodes[parent].key
            )
        } else {
            format!(
                "... {} {} omitted containing {} {} ...",
                count.directories,
                plural(count.directories, "directory", "directories"),
                count.entries,
                plural(count.entries, "entry", "entries")
            )
        };
        if !input.budget.charge_code_units(utf16_len(&marker)) {
            return false;
        }
        output.push(Cow::Owned(marker));
        run.clear();
        true
    };
    let mut stack = vec![Step::Enter(root)];
    while let Some(step) = stack.pop() {
        match step {
            Step::Enter(id) => {
                let node = &nodes[id];
                if !input.budget.charge_records(1)
                    || !input.budget.charge_code_units(utf16_len(node.line))
                {
                    return false;
                }
                output.push(Cow::Borrowed(node.line));
                let children = &node.children;
                let retained: Vec<usize> = if children.len() <= 12 {
                    children.clone()
                } else {
                    children[..6]
                        .iter()
                        .chain(&children[children.len() - 6..])
                        .copied()
                        .collect()
                };
                if !input.budget.charge_records(retained.len()) {
                    return false;
                }
                omitted.insert(id, Vec::new());
                // Children are visited in order; each one charges a record,
                // then either joins the omitted run or flushes it and is
                // entered. Steps go on the stack in reverse.
                stack.push(Step::Leave(id));
                for &child in children.iter().rev() {
                    stack.push(Step::Child {
                        parent: id,
                        child,
                        retained: retained.contains(&child),
                    });
                }
            }
            Step::Child {
                parent,
                child,
                retained,
            } => {
                if !input.budget.charge_records(1) {
                    return false;
                }
                if !retained {
                    omitted.entry(parent).or_default().push(child);
                    continue;
                }
                if !flush(&mut omitted, output, parent) {
                    return false;
                }
                stack.push(Step::Enter(child));
            }
            Step::Leave(id) => {
                if !flush(&mut omitted, output, id) {
                    return false;
                }
                omitted.remove(&id);
            }
        }
    }
    true
}

fn tree<'a>(input: &BoundedText<'a>, lines: &[&'a str], classified: bool) -> Cow<'a, str> {
    let (Some(&root), Some(&summary)) = (lines.first(), lines.last()) else {
        return input.unchanged();
    };
    if lines.len() < 3 || TREE_GLYPH.test(root) || !SUMMARY.test(summary) {
        return input.unchanged();
    }
    if !input.budget.charge_records(1) || !input.budget.charge_code_units(utf16_len(root)) {
        return input.unchanged();
    }
    let mut nodes = vec![TreeNode {
        key: root.to_owned(),
        line: root,
        classified_directory: true,
        children: Vec::new(),
    }];
    let mut stack = vec![0usize];
    for &line in &lines[1..lines.len() - 1] {
        let Some(caps) = TREE_ROW.captures(line) else {
            return input.unchanged();
        };
        // `match[1].length / 4` in code units: each `│   ` and `    ` is four.
        let indent = caps.get(1).copied().flatten().map_or(0, utf16_len);
        if indent % 4 != 0 {
            return input.unchanged();
        }
        let depth = indent / 4;
        let (Some(&parent), Some(name)) = (stack.get(depth), caps.get(3).copied().flatten()) else {
            return input.unchanged();
        };
        let plain = LINK_TARGET.replace_first(name, "");
        let plain = CLASSIFY_SUFFIX.replace_first(&plain, "").into_owned();
        let key = format!("{}/{plain}", nodes[parent].key);
        if !input.budget.charge_records(3) || !input.budget.charge_code_units(utf16_len(&key)) {
            return input.unchanged();
        }
        let id = nodes.len();
        nodes.push(TreeNode {
            key,
            line,
            classified_directory: classified && name.ends_with('/'),
            children: Vec::new(),
        });
        nodes[parent].children.push(id);
        stack.truncate(depth + 1);
        stack.push(id);
    }
    let mut output = Vec::new();
    if !append_subtree(input, &mut output, &nodes, 0, classified) {
        return input.unchanged();
    }
    if !input.budget.charge_records(1) || !input.budget.charge_code_units(utf16_len(summary)) {
        return input.unchanged();
    }
    output.push(Cow::Borrowed(summary));
    let rendered = output.join("\n");
    if utf16_len(&rendered) <= MAX_OUTPUT {
        Cow::Owned(rendered)
    } else {
        input.unchanged()
    }
}

fn recursive_ls<'a>(input: &BoundedText<'a>, long: bool) -> Cow<'a, str> {
    let mut groups: Vec<Group<'a>> = Vec::new();
    let mut saw_total = false;
    for &line in &input.lines {
        if line.is_empty() {
            continue;
        }
        if GROUP_HEADING.test(line) {
            if let Some(current) = groups.last()
                && ((long && !saw_total) || current.entry_count == 0)
            {
                return input.unchanged();
            }
            let key = &line[..line.len() - 1];
            if !input.budget.charge_records(3)
                || !input
                    .budget
                    .charge_code_units(utf16_len(key) + utf16_len(line))
            {
                return input.unchanged();
            }
            groups.push(Group {
                key: Cow::Borrowed(key),
                rows: vec![line],
                entry_count: 0,
            });
            saw_total = false;
            continue;
        }
        let Some(current) = groups.last_mut() else {
            return input.unchanged();
        };
        if TOTAL.test(line) {
            if !long || saw_total || current.entry_count > 0 {
                return input.unchanged();
            }
            if !input.budget.charge_records(1) || !input.budget.charge_code_units(utf16_len(line)) {
                return input.unchanged();
            }
            current.rows.push(line);
            saw_total = true;
            continue;
        }
        if (long && (!saw_total || !LONG.test(line))) || (!long && !PLAIN_ENTRY.test(line)) {
            return input.unchanged();
        }
        if !input.budget.charge_records(1) || !input.budget.charge_code_units(utf16_len(line)) {
            return input.unchanged();
        }
        current.rows.push(line);
        current.entry_count += 1;
    }
    match groups.last() {
        None => return input.unchanged(),
        Some(current) if (long && !saw_total) || current.entry_count == 0 => {
            return input.unchanged();
        }
        Some(_) => {}
    }
    match render_groups(input, &groups) {
        Some(rendered) => Cow::Owned(rendered),
        None => input.unchanged(),
    }
}

/// `RELATIVE_PATH`:
/// `^(?![[{`|])(?!.+:\d+(?::|$))[^\s:\n]+(?:[/\\][^\s:\n]+)*$`.
///
/// The second lookahead rejects a row that, past at least one char of its
/// first line, holds `:digits` followed by `:` or end-of-line. The body
/// already forbids `:`, so any row the body accepts has no colon and the
/// lookahead can only fail on rows the body rejects anyway; it is still
/// evaluated first so the two match identically. The body is linear here
/// where the JS backtracker is exponential on `a/a/…/a ` rows.
fn relative_path(line: &str) -> bool {
    relative_path_shape(line, &RELATIVE_PATH_BODY)
}

/// The shared `RELATIVE_PATH` shape (also `detect`'s path probe), given its
/// compiled body.
pub(crate) fn relative_path_shape(line: &str, body: &crate::jsre::JsRegex) -> bool {
    if line.starts_with(['[', '{', '`', '|']) {
        return false;
    }
    if coordinate_after_first_char(line) {
        return false;
    }
    body.test(line)
}

/// `(?=.+:\d+(?::|$))` at position 0, without `m`: some colon at code-unit
/// offset >= 1 inside the first line, followed by digits then `:` or the end
/// of the first line... `$` without `m` means end of input, so the digits must
/// run to the end of the whole string unless a `:` follows them.
fn coordinate_after_first_char(line: &str) -> bool {
    let first_line_end = line
        .find(['\n', '\r', '\u{2028}', '\u{2029}'])
        .unwrap_or(line.len());
    let first = &line[..first_line_end];
    for (at, c) in first.char_indices() {
        if c != ':' || at == 0 {
            continue;
        }
        let rest = &line[at + 1..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            continue;
        }
        let after = &rest[digits..];
        if after.starts_with(':') || after.is_empty() {
            return true;
        }
    }
    false
}

/// Tab is the only control character legal as filename data.
fn has_illegal_control(line: &str) -> bool {
    line.chars().any(|c| {
        let code = u32::from(c);
        code != 9 && (code < 32 || code == 127)
    })
}

fn gated_path(line: &str) -> bool {
    if line.is_empty() || has_illegal_control(line) {
        return false;
    }
    if line != line.trim_matches(is_js_whitespace) {
        return false;
    }
    if GATED_STRUCTURE.test(line) || GATED_TABLE.test(line) || GATED_PROSE.test(line) {
        return false;
    }
    let drive = GATED_DRIVE.test(line);
    // `line.indexOf(":", drive ? 2 : 0)`: the drive prefix is two ASCII units.
    let from = if drive { 2 } else { 0 };
    if line[from..].contains(':') {
        return false;
    }
    match line.find(['/', '\\']) {
        None => !WHITESPACE.test(line),
        Some(separator) => !WHITESPACE.test(&line[..separator]),
    }
}

fn paths<'a>(input: &BoundedText<'a>, command_gated: bool) -> Cow<'a, str> {
    let mut by_key: HashMap<&'a str, usize> = HashMap::new();
    let mut ordered: Vec<Group<'a>> = Vec::new();
    for &line in &input.lines {
        if line.is_empty() {
            continue;
        }
        let ok = if command_gated {
            gated_path(line)
        } else {
            relative_path(line)
        };
        if !ok {
            return input.unchanged();
        }
        let key = match line.rfind(['/', '\\']) {
            None | Some(0) => ".",
            Some(separator) => &line[..separator],
        };
        let at = match by_key.get(key) {
            Some(&at) => at,
            None => {
                if !input.budget.charge_records(2)
                    || !input.budget.charge_code_units(utf16_len(key))
                {
                    return input.unchanged();
                }
                ordered.push(Group {
                    key: Cow::Borrowed(key),
                    rows: Vec::new(),
                    entry_count: 0,
                });
                by_key.insert(key, ordered.len() - 1);
                ordered.len() - 1
            }
        };
        if !input.budget.charge_records(1) {
            return input.unchanged();
        }
        ordered[at].rows.push(line);
        ordered[at].entry_count += 1;
    }
    if ordered.is_empty() {
        return input.unchanged();
    }
    match render_groups(input, &ordered) {
        Some(rendered) => Cow::Owned(rendered),
        None => input.unchanged(),
    }
}

fn long_ls<'a>(input: &BoundedText<'a>) -> Cow<'a, str> {
    let mut header: Option<&'a str> = None;
    let mut rows = Vec::new();
    for &line in &input.lines {
        if line.is_empty() {
            continue;
        }
        if TOTAL.test(line) {
            if header.is_some() || !rows.is_empty() {
                return input.unchanged();
            }
            if !input.budget.charge_records(1) || !input.budget.charge_code_units(utf16_len(line)) {
                return input.unchanged();
            }
            header = Some(line);
            continue;
        }
        if header.is_none() || !LONG.test(line) {
            return input.unchanged();
        }
        if !input.budget.charge_records(1) {
            return input.unchanged();
        }
        rows.push(line);
    }
    let Some(header) = header else {
        return input.unchanged();
    };
    if rows.is_empty() {
        return input.unchanged();
    }
    let entry_count = rows.len();
    let group = Group {
        key: Cow::Borrowed("."),
        rows,
        entry_count,
    };
    let Some(rendered) = render_groups(input, &[group]) else {
        return input.unchanged();
    };
    let output = format!("{header}\n{rendered}");
    if utf16_len(&output) <= MAX_OUTPUT {
        Cow::Owned(output)
    } else {
        input.unchanged()
    }
}

fn nonempty_lines<'a>(input: &BoundedText<'a>) -> Option<Vec<&'a str>> {
    let mut lines = Vec::new();
    for &line in &input.lines {
        if line.is_empty() {
            continue;
        }
        if !input.budget.charge_records(1) {
            return None;
        }
        lines.push(line);
    }
    Some(lines)
}

/// `compressListing`.
pub fn compress_listing<'a>(
    input: &BoundedText<'a>,
    executable: &str,
    subcommand: Option<&str>,
    command_gated: bool,
) -> Cow<'a, str> {
    match (executable, subcommand) {
        ("ls", Some("recursive-long")) => recursive_ls(input, true),
        ("ls", Some("recursive-plain")) => recursive_ls(input, false),
        ("ls", _) => long_ls(input),
        ("tree", _) => match nonempty_lines(input) {
            None => input.unchanged(),
            Some(lines) => tree(input, &lines, subcommand == Some("classified")),
        },
        _ => paths(input, command_gated),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filters::shared::scan_text;

    #[test]
    fn relative_path_lookaheads() {
        assert!(relative_path("src/a.ts"));
        assert!(!relative_path("[x"));
        assert!(!relative_path("a:12"));
        assert!(!relative_path("a b"));
        assert!(relative_path(".\\a\\b"));
    }

    #[test]
    fn relative_path_is_linear_on_backtracking_input() {
        let line = format!("{}a ", "a/".repeat(50_000));
        assert!(!relative_path(&line));
    }

    #[test]
    fn deepest_tree_under_the_input_cap_compresses_without_recursion() {
        // Depth costs four code units per level per row, so ~700 levels is the
        // deepest a 1,000,000-unit input can nest.
        let mut lines = vec!["root".to_owned()];
        for depth in 0..700 {
            lines.push(format!("{}└── d{depth}/", "    ".repeat(depth)));
            for leaf in 0..13 {
                lines.push(format!("{}├── f{leaf}", "    ".repeat(depth + 1)));
            }
        }
        lines.push("700 directories, 0 files".to_owned());
        let text = lines.join("\n");
        let input = scan_text(&text).expect("bounded");
        let _ = compress_listing(&input, "tree", Some("classified"), true);
    }
}
