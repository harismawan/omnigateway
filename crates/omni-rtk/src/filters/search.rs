//! grep/rg output grouped by file.

use super::shared::{BoundedText, MAX_OUTPUT};
use crate::command::GrepMode;
use crate::jsre::js_regex;
use omni_ir::js::utf16_len;
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Heading,
    Match,
    Context,
    Separator,
}

#[derive(Debug, Clone, Copy)]
struct Record<'a> {
    kind: Kind,
    text: &'a str,
}

#[derive(Debug)]
struct MatchGroup<'a> {
    file: &'a str,
    records: Vec<Record<'a>>,
    matches: usize,
}

js_regex!(FULL = r"^((?:[A-Za-z]:\\[^\n:]+|[^\n:]+)):(\d+):(.+)$");
js_regex!(CONTEXT = r"^((?:[A-Za-z]:\\[^\n]+|[^\n]+))-(\d+)-(.+)$");
js_regex!(HEADING_MATCH = r"^\d+:.+$");
js_regex!(HEADING_CONTEXT = r"^\d+-.+$");
js_regex!(PATH = r"^(?:[A-Za-z]:\\|[./~])?[^\n:]+$");

/// `context > 0` for a JS number (NaN and 0 are not).
fn positive(context: f64) -> bool {
    context > 0.0
}

fn retained_records<'a>(group: &MatchGroup<'a>, mode: &GrepMode) -> (Vec<Record<'a>>, usize) {
    let records = &group.records;
    let matches: Vec<usize> = records
        .iter()
        .enumerate()
        .filter_map(|(i, r)| (r.kind == Kind::Match).then_some(i))
        .collect();
    let retained: BTreeSet<usize> = if matches.len() <= 12 {
        matches.iter().copied().collect()
    } else {
        matches[..6]
            .iter()
            .chain(&matches[matches.len() - 6..])
            .copied()
            .collect()
    };
    let mut selected = HashSet::new();
    for &m in &retained {
        selected.insert(m);
        for index in (0..m).rev() {
            match records[index].kind {
                Kind::Match => break,
                Kind::Separator => {
                    selected.insert(index);
                }
                _ => {}
            }
        }
        for (index, record) in records.iter().enumerate().skip(m + 1) {
            match record.kind {
                Kind::Match => break,
                Kind::Separator => {
                    selected.insert(index);
                }
                _ => {}
            }
        }
        // `let before = mode.beforeContext; … before > 0; … before--`: a JS
        // number counted down by one per context row.
        let mut before = mode.before_context;
        let mut index = m;
        while index > 0 && before > 0.0 {
            index -= 1;
            let record = records[index];
            if record.kind == Kind::Match {
                break;
            }
            if record.kind == Kind::Context {
                before -= 1.0;
            }
            selected.insert(index);
        }
        let mut after = mode.after_context;
        let mut index = m + 1;
        while index < records.len() && after > 0.0 {
            let record = records[index];
            if record.kind == Kind::Match {
                break;
            }
            if record.kind == Kind::Context {
                after -= 1.0;
            }
            selected.insert(index);
            index += 1;
        }
    }
    for (index, record) in records.iter().enumerate() {
        if record.kind == Kind::Heading {
            selected.insert(index);
        }
    }
    let kept = records
        .iter()
        .enumerate()
        .filter_map(|(i, r)| selected.contains(&i).then_some(*r))
        .collect();
    (kept, matches.len() - retained.len())
}

fn plural(count: usize, one: &'static str, many: &'static str) -> &'static str {
    if count == 1 { one } else { many }
}

fn render(input: &BoundedText<'_>, groups: &[MatchGroup<'_>], mode: &GrepMode) -> Option<String> {
    if !input.budget.charge_records(groups.len()) {
        return None;
    }
    let total = groups.len();
    let retain =
        |i: usize, g: &MatchGroup<'_>| total <= 40 || i < 20 || i >= total - 20 || g.matches == 1;
    let mut output: Vec<Cow<'_, str>> = Vec::new();
    let mut omitted_files = 0;
    let mut omitted_matches = 0;
    let flush = |output: &mut Vec<Cow<'_, str>>, files: &mut usize, matches: &mut usize| {
        if *files == 0 {
            return;
        }
        output.push(Cow::Owned(format!(
            "... {} {} omitted containing {} {} ...",
            *files,
            plural(*files, "file", "files"),
            *matches,
            plural(*matches, "match", "matches")
        )));
        *files = 0;
        *matches = 0;
    };
    for (i, group) in groups.iter().enumerate() {
        if !retain(i, group) {
            omitted_files += 1;
            omitted_matches += group.matches;
            continue;
        }
        flush(&mut output, &mut omitted_files, &mut omitted_matches);
        let (records, omitted) = retained_records(group, mode);
        if !input.budget.charge_records(records.len()) {
            return None;
        }
        output.extend(records.iter().map(|r| Cow::Borrowed(r.text)));
        if omitted > 0 {
            output.push(Cow::Owned(format!(
                "... {omitted} {} omitted from {} ...",
                plural(omitted, "match", "matches"),
                group.file
            )));
        }
    }
    flush(&mut output, &mut omitted_files, &mut omitted_matches);
    let content = output.join("\n");
    let units = utf16_len(&content);
    (input.budget.charge_code_units(units) && units <= MAX_OUTPUT).then_some(content)
}

/// `compressGrep`.
pub fn compress_grep<'a>(input: &BoundedText<'a>, mode: &GrepMode) -> Cow<'a, str> {
    // A `Map` keyed by file, iterated in insertion order.
    let mut groups: Vec<MatchGroup<'a>> = Vec::new();
    let mut by_file: HashMap<&'a str, usize> = HashMap::new();
    let mut heading: Option<&'a str> = None;
    let mut active_file: Option<&'a str> = None;
    let mut pending_separator = false;
    let any_context = positive(mode.before_context) || positive(mode.after_context);
    let mut group_for = |groups: &mut Vec<MatchGroup<'a>>, file: &'a str| -> usize {
        *by_file.entry(file).or_insert_with(|| {
            groups.push(MatchGroup {
                file,
                records: Vec::new(),
                matches: 0,
            });
            groups.len() - 1
        })
    };
    for &line in &input.lines {
        if line == "--" {
            if active_file.is_none() || pending_separator {
                return input.unchanged();
            }
            pending_separator = true;
            continue;
        }
        if mode.heading
            && PATH.test(line)
            && !HEADING_MATCH.test(line)
            && !HEADING_CONTEXT.test(line)
        {
            heading = Some(line);
            active_file = Some(line);
            if !input.budget.charge_records(1) {
                return input.unchanged();
            }
            let at = group_for(&mut groups, line);
            groups[at].records.push(Record {
                kind: Kind::Heading,
                text: line,
            });
            continue;
        }
        let full = FULL.captures(line);
        let context = if any_context {
            CONTEXT.captures(line)
        } else {
            None
        };
        let file = if mode.heading {
            heading
        } else {
            full.as_ref()
                .and_then(|c| c.get(1).copied().flatten())
                .or_else(|| context.as_ref().and_then(|c| c.get(1).copied().flatten()))
        };
        let matched = if mode.heading {
            HEADING_MATCH.test(line)
        } else {
            full.is_some()
        };
        let valid_context = if mode.heading {
            any_context && HEADING_CONTEXT.test(line)
        } else {
            context.is_some()
        };
        let Some(file) = file else {
            return input.unchanged();
        };
        if !matched && !valid_context {
            return input.unchanged();
        }
        if pending_separator && Some(file) != active_file {
            return input.unchanged();
        }
        let added = if pending_separator { 2 } else { 1 };
        if !input.budget.charge_records(added) {
            return input.unchanged();
        }
        let at = group_for(&mut groups, file);
        let group = &mut groups[at];
        if pending_separator {
            group.records.push(Record {
                kind: Kind::Separator,
                text: "--",
            });
        }
        group.records.push(Record {
            kind: if matched { Kind::Match } else { Kind::Context },
            text: line,
        });
        if matched {
            group.matches += 1;
        }
        active_file = Some(file);
        pending_separator = false;
    }
    if groups.is_empty() || pending_separator {
        return input.unchanged();
    }
    match render(input, &groups, mode) {
        Some(content) => Cow::Owned(content),
        None => input.unchanged(),
    }
}
