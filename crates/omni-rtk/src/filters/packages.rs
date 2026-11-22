//! `packages/rtk/src/filters/packages.ts`.

use super::diagnostics::WarningGaps;
use super::shared::{BoundedText, MAX_OUTPUT, Severity};
use crate::jsre::js_regex;
use omni_ir::js::utf16_len;
use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};

#[derive(Debug)]
struct PackageBlock {
    start: usize,
    end: usize,
    severity: Severity,
    identity: String,
}

js_regex!(
    MUTATION = r"(?:^|\s)(?:added|removed|updated|upgraded|downgraded|installed)\s+\S|lockfile|package-lock|blocked.*script|postinstall|lifecycle|vulnerabilit|peer.*conflict|resolution.*conflict|generated\s+\S",
    "i"
);
js_regex!(
    SUMMARY = r"(?:installed|added|removed|updated|audited) \d+ packages?|found \d+ vulnerabilities|Saved lockfile",
    "i"
);
js_regex!(
    PROGRESS = r"^(?:download|Resolving|Progress:|Packages:|Fetching|Downloaded|Using cached|Collecting)\b",
    "i"
);
js_regex!(NPM_START = r"^npm (?:warn|warning|error)\b");
js_regex!(PNPM_START = r"^(?:warn(?:ing)?\b|err_pnpm_|error\b)", "i");
js_regex!(PNPM_ERROR = r"^(?:err_pnpm_|error\b)", "i");
js_regex!(YARN_START = r"^YN\d{4}:");
js_regex!(YARN_ERROR = r"^YN(?:0009|0018|0028):");
js_regex!(PLAIN_START = r"^(?:warning|error):", "i");
js_regex!(PLAIN_ERROR = r"^error:", "i");
js_regex!(PIP_START = r"^(?:WARNING|ERROR):");

js_regex!(NPM_PREFIX = r"^npm (?:warn|warning|error)\s+", "i");
js_regex!(NPM_COUNTER = r"^\[\d+\/\d+\]\s+");
js_regex!(NPM_WORKSPACE = r"^workspace\s+[^:]+:\s*", "i");
js_regex!(
    PNPM_PREFIX = r"^(?:WARN(?:ING)?|ERR_PNPM_[A-Z_]+|ERROR)\s+",
    "i"
);
js_regex!(YARN_PREFIX = r"^(YN\d{4}:)\s*(?:\[[^\]]+\]\s*)?");
js_regex!(PLAIN_PREFIX = r"^(?:warning|error):\s*", "i");

js_regex!(
    UNASSIGNABLE = r"^(?:DIAGNOSTIC|WARN(?:ING)?|ERR(?:OR)?|npm |YN\d{4}:)",
    "i"
);
js_regex!(NPM_INSTALL_AFTER = r"^npm install\b", "i");
js_regex!(CONTINUATION_PREFIX = r"^npm (?:warn|error)\s+", "i");
js_regex!(
    CONTINUATION_MESSAGE = r"^(?:required by|While resolving|Found:|Could not resolve)",
    "i"
);
js_regex!(CONTINUATION = r"^(?:\s|Caused by:|note:|help:)", "i");

fn diagnostic_start(line: &str, executable: &str) -> Option<Severity> {
    let pick = |error: bool| {
        if error {
            Severity::Error
        } else {
            Severity::Warning
        }
    };
    match executable {
        "npm" => {
            // `line.toLowerCase()`: full Unicode default lowercasing, which
            // `str::to_lowercase` also implements (U+0130 becomes `i̇`).
            let lower = line.to_lowercase();
            NPM_START
                .test(&lower)
                .then(|| pick(lower.starts_with("npm error")))
        }
        "pnpm" => PNPM_START.test(line).then(|| pick(PNPM_ERROR.test(line))),
        "yarn" => YARN_START.test(line).then(|| pick(YARN_ERROR.test(line))),
        "cargo" | "uv" | "bun" => PLAIN_START.test(line).then(|| pick(PLAIN_ERROR.test(line))),
        "pip" => PIP_START
            .test(line)
            .then(|| pick(line.starts_with("ERROR"))),
        _ => None,
    }
}

fn stable_identity(line: &str, executable: &str, severity: Severity) -> String {
    let normalized: String = match executable {
        "npm" => {
            let a = NPM_PREFIX.replace_first(line, "");
            let b = NPM_COUNTER.replace_first(&a, "").into_owned();
            NPM_WORKSPACE.replace_first(&b, "").into_owned()
        }
        "pnpm" => PNPM_PREFIX.replace_first(line, "").into_owned(),
        "yarn" => YARN_PREFIX.replace_first(line, "${1} ").into_owned(),
        _ => PLAIN_PREFIX.replace_first(line, "").into_owned(),
    };
    let severity = match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
    };
    format!("{executable}\u{0}{severity}\u{0}{normalized}")
}

/// `/^(?:DIAGNOSTIC|WARN(?:ING)?|ERR(?:OR)?|npm (?!install\b)|YN\d{4}:)/i`,
/// with the lookahead written out: `npm ` counts only when `install\b` does
/// not follow it (case-insensitively).
fn unassignable(line: &str) -> bool {
    if !UNASSIGNABLE.test(line) {
        return false;
    }
    let npm = line
        .get(..4)
        .is_some_and(|p| p.eq_ignore_ascii_case("npm "));
    if !npm {
        return true;
    }
    // `npm ` is the only alternative that can match a line starting `npm `,
    // except `npm ` lines that also begin like another alternative (none do).
    !NPM_INSTALL_AFTER.test(line)
}

fn blocks(input: &BoundedText<'_>, executable: &str) -> Option<Vec<PackageBlock>> {
    let lines = &input.lines;
    let mut result = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = input.line(index);
        let Some(severity) = diagnostic_start(line, executable) else {
            if unassignable(line) && !PROGRESS.test(line) {
                return None;
            }
            index += 1;
            continue;
        };
        let mut end = index;
        while end + 1 < lines.len() {
            let continuation = input.line(end + 1);
            if SUMMARY.test(continuation) || PROGRESS.test(continuation) {
                break;
            }
            if diagnostic_start(continuation, executable).is_some() {
                let message = CONTINUATION_PREFIX.replace_first(continuation, "");
                if !CONTINUATION_MESSAGE.test(&message) {
                    break;
                }
            } else if !CONTINUATION.test(continuation) {
                break;
            }
            end += 1;
        }
        if !input.budget.charge_records(1) {
            return None;
        }
        let identity = stable_identity(line, executable, severity);
        if !input.budget.charge_code_units(utf16_len(&identity)) {
            return None;
        }
        result.push(PackageBlock {
            start: index,
            end,
            severity,
            identity,
        });
        index = end + 1;
    }
    Some(result)
}

/// `compressPackages`.
pub fn compress_packages<'a>(input: &BoundedText<'a>, executable: &str) -> Cow<'a, str> {
    let lines = &input.lines;
    let Some(parsed) = blocks(input, executable) else {
        return input.unchanged();
    };
    let mut seen = HashSet::new();
    let mut unique: Vec<&PackageBlock> = Vec::new();
    for block in &parsed {
        if seen.contains(block.identity.as_str()) {
            continue;
        }
        if !input.budget.charge_records(1) {
            return input.unchanged();
        }
        seen.insert(block.identity.as_str());
        unique.push(block);
    }
    if !input.budget.charge_records(unique.len()) {
        return input.unchanged();
    }
    let errors: Vec<&PackageBlock> = unique
        .iter()
        .copied()
        .filter(|b| b.severity == Severity::Error)
        .collect();
    let warnings: Vec<&PackageBlock> = unique
        .iter()
        .copied()
        .filter(|b| b.severity == Severity::Warning)
        .collect();
    let mut selected = BTreeSet::new();
    for block in errors.iter().chain(warnings.iter().take(20)) {
        for index in block.start..=block.end {
            if !input.budget.charge_records(1) {
                return input.unchanged();
            }
            selected.insert(index);
        }
    }
    let mut diagnostic_rows = HashSet::new();
    for block in &parsed {
        for index in block.start..=block.end {
            if !input.budget.charge_records(1) {
                return input.unchanged();
            }
            diagnostic_rows.insert(index);
        }
    }
    for (index, line) in lines.iter().enumerate() {
        if !diagnostic_rows.contains(&index) && (MUTATION.test(line) || SUMMARY.test(line)) {
            selected.insert(index);
        }
    }
    if selected.is_empty() || !lines.iter().any(|l| SUMMARY.test(l)) {
        return input.unchanged();
    }
    let dropped: Vec<(usize, usize)> = warnings.iter().skip(20).map(|b| (b.start, b.end)).collect();
    let Some(gaps) = WarningGaps::build(input, &selected, &dropped) else {
        return input.unchanged();
    };
    let Some(rendered) = gaps.render(input, &selected) else {
        return input.unchanged();
    };
    if utf16_len(&rendered) > MAX_OUTPUT {
        return input.unchanged();
    }
    for block in &errors {
        for index in block.start..=block.end {
            if !rendered.contains(input.line(index)) {
                return input.unchanged();
            }
        }
    }
    Cow::Owned(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_install_lookahead() {
        assert!(!unassignable("npm install x"));
        assert!(!unassignable("NPM INSTALL"));
        assert!(unassignable("npm installs"));
        assert!(unassignable("npm start"));
        assert!(unassignable("WARN x"));
        assert!(!unassignable("installed"));
    }
}
