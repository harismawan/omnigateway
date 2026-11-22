//! `packages/rtk/src/detect.ts`: unknown-origin build/test inference. Each
//! family needs two anchors on *distinct* rows.

use crate::catalog::RtkFilterId;
use crate::jsre::{JsRegex, js_regex};

js_regex!(BUN_BUILD_A1 = r"^\$?\s*bun (?:run|build)\b");
js_regex!(BUN_BUILD_A2 = r"^bun build v");
js_regex!(BUN_BUILD_B = r"^(?:Bundled |Build (?:completed|failed)|\S+\.(?:js|css|map)\s+\d)");
js_regex!(CARGO_A = r"^(?:Compiling |Checking |\$?\s*cargo (?:build|check)\b)");
js_regex!(CARGO_B1 = r"^Finished .+ target");
js_regex!(CARGO_B2 = r"^(?:error|warning)\[[A-Z]\d+\]:");
js_regex!(CARGO_B3 = r"^\s*--> \S+:\d+:\d+");
js_regex!(COMPILER = r"^\S.+:\d+:\d+.*(?:error|warning).*(?:TS\d+|[A-Z]\d+)");
js_regex!(BUILD_SUMMARY = r"^(?:Build|Compilation).*(?:failed|completed|errors?)");
js_regex!(
    BUN_TEST_A = r"^(?:bun test v|vitest|jest|PASS |FAIL |Test Files)",
    "i"
);
js_regex!(BUN_TEST_B = r"^(?:\d+ (?:pass|fail)|Ran \d+ tests?|Tests?:|Test Files)");
js_regex!(PYTEST_A1 = r"^={2,} test session starts");
js_regex!(PYTEST_A2 = r"^collected \d+ items");
js_regex!(PYTEST_B1 = r"^={2,} short test summary");
js_regex!(PYTEST_B2 = r"\d+ (?:passed|failed|error)");
js_regex!(GO_A1 = r"^=== RUN ");
js_regex!(GO_A2 = r"^\$?\s*go test\b");
js_regex!(GO_B1 = r"^--- (?:PASS|FAIL):");
js_regex!(GO_B2 = r"^(?:ok|FAIL)\s+\S");

/// `distinctRows`: indexes of rows any pattern matches, ascending.
fn rows(lines: &[&str], patterns: &[&JsRegex]) -> Vec<usize> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| patterns.iter().any(|p| p.test(l)).then_some(i))
        .collect()
}

/// Some row in `a` differs from some row in `b`.
fn distinct(a: &[usize], b: &[usize]) -> bool {
    a.iter().any(|row| b.iter().any(|other| other != row))
}

fn pair(lines: &[&str], a: &[&JsRegex], b: &[&JsRegex]) -> bool {
    distinct(&rows(lines, a), &rows(lines, b))
}

/// `inferBuildOrTest`.
pub fn infer_build_or_test(lines: &[&str]) -> Option<RtkFilterId> {
    if pair(lines, &[&BUN_BUILD_A1, &BUN_BUILD_A2], &[&BUN_BUILD_B]) {
        return Some(RtkFilterId::BuildOutput);
    }
    if pair(lines, &[&CARGO_A], &[&CARGO_B1, &CARGO_B2, &CARGO_B3]) {
        return Some(RtkFilterId::BuildOutput);
    }
    let compiler = rows(lines, &[&COMPILER]);
    if compiler.len() >= 2 || distinct(&compiler, &rows(lines, &[&BUILD_SUMMARY])) {
        return Some(RtkFilterId::BuildOutput);
    }
    if pair(lines, &[&BUN_TEST_A], &[&BUN_TEST_B]) {
        return Some(RtkFilterId::TestOutput);
    }
    if pair(lines, &[&PYTEST_A1, &PYTEST_A2], &[&PYTEST_B1, &PYTEST_B2]) {
        return Some(RtkFilterId::TestOutput);
    }
    if pair(lines, &[&GO_A1, &GO_A2], &[&GO_B1, &GO_B2]) {
        return Some(RtkFilterId::TestOutput);
    }
    None
}
