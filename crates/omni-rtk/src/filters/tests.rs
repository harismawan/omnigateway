//! `packages/rtk/src/filters/tests.ts`.

use super::shared::{BoundedText, MAX_OUTPUT, plain_edges, render_selection};
use crate::jsre::js_regex;
use omni_ir::js::utf16_len;
use std::borrow::Cow;
use std::collections::BTreeSet;

js_regex!(FAIL_VITEST = r"^\s*FAIL\s{2}\S.+\s>\s");
js_regex!(FAIL_JEST = r"^\s*●\s");
js_regex!(
    FAIL_BUN = r"^\s*(?:FAIL\s|UnhandledPromiseRejection|Uncaught exception|panic:|error:.*(?:hook|unhandled rejection))"
);
js_regex!(FAIL_PYTEST = r"^\s*(?:FAILED\s|={2,} FAILURES ={2,}|ERROR collecting)");
js_regex!(FAIL_GO = r"^\s*(?:--- FAIL:|# \S|FAIL\s+\S+\s+\[build failed\])");
js_regex!(
    FAIL_ANY = r"^\s*(?:FAIL\b|--- FAIL:|FAILED\b|={2,} FAILURES ={2,}|panic:|ERROR collecting|● )"
);

js_regex!(SUM_BUN = r"^(?:\d+ (?:pass|fail|skip|todo)|Ran \d+ tests?|error: \d+ unhandled)");
js_regex!(
    SUM_VITEST =
        r"^(?:Test Files|Tests |Snapshots |Snapshots:|Projects? |Shards? |Attachments? |Retries? )",
    "i"
);
js_regex!(SUM_JEST = r"^(?:Test Suites:|Tests:|Snapshots:)");
js_regex!(SUM_PYTEST_A = r"(?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed))(?:,| in|$)");
js_regex!(SUM_PYTEST_B = r"^=+ short test summary");
js_regex!(SUM_GO = r"^(?:--- SKIP:|(?:ok|FAIL)\s+\S)");
js_regex!(
    SUM_ANY = r"^(?:\d+ (?:pass|fail|skip|todo)|Ran \d+ tests?|Tests?:|Test Files|Snapshots:|test result:|(?:ok|FAIL)\s+\S|=+ .* (?:passed|failed|error|skipped))",
    "i"
);

js_regex!(FS_BUN = r"^(?:[1-9]\d* fail|error: [1-9]\d* unhandled)");
js_regex!(FS_VITEST_JEST = r"(?:^|\s)[1-9]\d* failed");
js_regex!(FS_PYTEST = r"[1-9]\d* (?:failed|errors?)");
js_regex!(FS_GO = r"^FAIL\s+\S");
js_regex!(FS_ANY = r"(?:[1-9]\d* fail|[1-9]\d* failed|FAIL\s+\S)");
js_regex!(PROGRESS = r"^progress \d+$");

fn is_failure_start(line: &str, executable: &str) -> bool {
    match executable {
        "vitest" => FAIL_VITEST.test(line),
        "jest" => FAIL_JEST.test(line),
        "bun" => FAIL_BUN.test(line),
        "pytest" => FAIL_PYTEST.test(line),
        "go" => FAIL_GO.test(line),
        _ => FAIL_ANY.test(line),
    }
}

fn is_summary(line: &str, executable: &str) -> bool {
    match executable {
        "bun" => SUM_BUN.test(line),
        "vitest" => SUM_VITEST.test(line),
        "jest" => SUM_JEST.test(line),
        "pytest" => SUM_PYTEST_A.test(line) || SUM_PYTEST_B.test(line),
        "go" => SUM_GO.test(line),
        _ => SUM_ANY.test(line),
    }
}

fn is_failure_summary(line: &str, executable: &str) -> bool {
    match executable {
        "bun" => FS_BUN.test(line),
        "vitest" | "jest" => FS_VITEST_JEST.test(line),
        "pytest" => FS_PYTEST.test(line),
        "go" => FS_GO.test(line),
        _ => FS_ANY.test(line),
    }
}

/// `compressTests`. `executable` defaults to `"unknown"` in TS.
pub fn compress_tests<'a>(input: &BoundedText<'a>, executable: &str) -> Cow<'a, str> {
    let lines = &input.lines;
    let mut selected = BTreeSet::new();
    let mut starts = Vec::new();
    let mut has_failure_summary = false;
    for (index, line) in lines.iter().enumerate() {
        if is_failure_start(line, executable) {
            starts.push(index);
        }
        if is_summary(line, executable) {
            selected.insert(index);
        }
        if is_failure_summary(line, executable) {
            has_failure_summary = true;
        }
    }
    if has_failure_summary && starts.is_empty() {
        return input.unchanged();
    }
    for (offset, &start) in starts.iter().enumerate() {
        if !input.budget.charge_records(1) {
            return input.unchanged();
        }
        let next_failure = starts.get(offset + 1).copied().unwrap_or(lines.len());
        let mut end = start;
        while end + 1 < next_failure {
            let line = input.line(end + 1);
            if PROGRESS.test(line) || is_summary(line, executable) {
                break;
            }
            end += 1;
        }
        if !input.budget.charge_records(end - start + 1) {
            return input.unchanged();
        }
        selected.extend(start..=end);
    }
    if selected.is_empty() {
        return input.unchanged();
    }
    let Some(rendered) = render_selection(input, &selected, "lines") else {
        return input.unchanged();
    };
    let rendered = plain_edges(input, &selected, rendered);
    if utf16_len(&rendered) > MAX_OUTPUT {
        return input.unchanged();
    }
    if starts.iter().any(|&s| !rendered.contains(input.line(s))) {
        return input.unchanged();
    }
    Cow::Owned(rendered)
}
