//! `packages/rtk/src/filters/status.ts`.

use super::shared::{BoundedText, capped};
use crate::jsre::js_regex;
use omni_ir::js::utf16_len;
use std::borrow::Cow;

js_regex!(HEADER = r"^(?:## .+|On branch .+|HEAD detached at .+|HEAD detached from .+)$");
js_regex!(
    OPERATION = r"^(?:(?:(?:interactive )?rebase|merge|cherry-pick|revert|bisect)(?: in progress| currently|ing|ing in progress| .*)|You are currently rebasing .+|All conflicts fixed but you are still merging\.)",
    "i"
);
js_regex!(
    CHATTER = r"^ {2}\((?:use |fix conflicts|all conflicts|no commands remaining).+\)$",
    "i"
);
js_regex!(
    RELATION = r"^(?:Your branch (?:is ahead of|is behind|and .+ have diverged).*[,.]|and have \d+ and \d+ different commits each, respectively\.)$"
);
js_regex!(
    SECTION = r"^(?:Changes to be committed|Changes not staged for commit|Unmerged paths|Untracked files):$"
);
js_regex!(
    FINAL = r"^(?:nothing to commit, working tree clean|no changes added to commit .+|nothing added to commit but untracked files present .+)$"
);
js_regex!(
    LONG_RECORD = r"^\t(?:modified|deleted|new file|renamed|copied|both modified|both added|added by us|added by them|deleted by us|deleted by them):\s+.+$"
);
js_regex!(UNTRACKED_RECORD = r"^\t\S.+$");
js_regex!(PAIR = r"^.+ -> .+$");

const XY: [&str; 24] = [
    " M", "M ", "MM", " A", "A ", "AM", " D", "D ", "DM", " R", "R ", "RM", " C", "C ", "CM", "??",
    "!!", "DD", "AU", "UD", "UA", "DU", "AA", "UU",
];

fn status_record(line: &str) -> bool {
    let bytes = line.as_bytes();
    // `line.length < 3 || !XY.has(line.slice(0, 2))`: every XY code is two
    // ASCII units, so a match fixes the first two bytes.
    if bytes.len() < 3 || !XY.iter().any(|xy| xy.as_bytes() == &bytes[..2]) {
        return false;
    }
    if bytes[2] != b' ' && bytes[2] != b'\t' {
        return false;
    }
    let path = &line[3..];
    if path.is_empty() {
        return false;
    }
    if matches!(bytes[0], b'R' | b'C') || matches!(bytes[1], b'R' | b'C') {
        return PAIR.test(path);
    }
    true
}

fn append<'a>(input: &BoundedText<'a>, output: &mut Vec<&'a str>, line: &'a str) -> bool {
    if !input.budget.charge_records(1) || !input.budget.charge_code_units(utf16_len(line)) {
        return false;
    }
    output.push(line);
    true
}

#[derive(PartialEq)]
enum Section {
    Tracked,
    Untracked,
}

/// `compressGitStatus`.
pub fn compress_git_status<'a>(input: &BoundedText<'a>) -> Cow<'a, str> {
    let mut output = Vec::new();
    let mut section: Option<Section> = None;
    let mut long = false;
    let mut saw_record = false;
    for &line in &input.lines {
        if line.is_empty() {
            continue;
        }
        if !input.budget.charge_records(1) {
            return input.unchanged();
        }
        if SECTION.test(line) {
            long = true;
            section = Some(if line == "Untracked files:" {
                Section::Untracked
            } else {
                Section::Tracked
            });
            if !append(input, &mut output, line) {
                return input.unchanged();
            }
            continue;
        }
        if HEADER.test(line) || RELATION.test(line) || OPERATION.test(line) || FINAL.test(line) {
            if !append(input, &mut output, line) {
                return input.unchanged();
            }
            continue;
        }
        if CHATTER.test(line) {
            continue;
        }
        let record = if long {
            if section == Some(Section::Untracked) {
                UNTRACKED_RECORD.test(line)
            } else {
                LONG_RECORD.test(line)
            }
        } else {
            status_record(line)
        };
        if !record {
            return input.unchanged();
        }
        saw_record = true;
        if !append(input, &mut output, line) {
            return input.unchanged();
        }
    }
    if !saw_record {
        return input.unchanged();
    }
    capped(input, output.join("\n"))
}
