//! `packages/rtk/src/filters/build.ts`.

use super::shared::{BoundedText, MAX_OUTPUT, render_gaps};
use crate::jsre::js_regex;
use omni_ir::js::utf16_len;
use std::borrow::Cow;
use std::collections::BTreeSet;

js_regex!(
    DIAGNOSTIC = r"^(?:[^\n]+:\d+:\d+.*(?:error|warning)|(?:error|warning)(?:\[[^\]]+\])?:|panic:|\s*--> \S+:\d+:\d+)",
    "i"
);
js_regex!(
    SEMANTIC = r"^(?:bun build v|Compiling \S|Checking \S|Downloading \S|Downloaded \S|Running `.+`|Finished .+ target|Build (?:completed|failed)|Bundled |\S*(?:dist|build|target)[/\\]\S+|\S+\.(?:js|css|map|wasm)\s+\d|sourcemap)",
    "i"
);
js_regex!(
    PROGRESS = r"^progress \d+$|^(?:Compiling|Downloading) repeated\b",
    "i"
);
js_regex!(COMPILE_ROW = r"^(?:Compiling|Downloading) repeated");
js_regex!(CONTINUATION = r"^(?:\s|\||\^|~|help:|note:|Caused by:|at\s)");
js_regex!(FINAL = r"^(?:Finished|Build |Bundled )");

/// Rows `from..to` (exclusive) split into collapsed compile/download rows
/// and everything else, each counted once.
fn describe(compile_rows: &BTreeSet<usize>, from: usize, to: usize) -> Option<String> {
    let compile = compile_rows.range(from..to).count();
    let others = to - from - compile;
    let mut parts = Vec::new();
    if compile > 0 {
        parts.push(format!("... {compile} compile/download rows omitted ..."));
    }
    if others > 0 {
        parts.push(format!("... {others} lines omitted ..."));
    }
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// `compressBuild`.
pub fn compress_build<'a>(input: &BoundedText<'a>) -> Cow<'a, str> {
    let lines = &input.lines;
    let mut selected = BTreeSet::new();
    let mut compile_rows = BTreeSet::new();
    let mut in_diagnostic = false;
    for (index, line) in lines.iter().enumerate() {
        if line.is_empty() || PROGRESS.test(line) {
            if COMPILE_ROW.test(line) {
                compile_rows.insert(index);
            }
            continue;
        }
        let diagnostic = DIAGNOSTIC.test(line);
        if diagnostic {
            in_diagnostic = true;
        } else if in_diagnostic && CONTINUATION.test(line) {
            selected.insert(index);
            continue;
        } else {
            in_diagnostic = false;
        }
        if !diagnostic && !SEMANTIC.test(line) {
            return input.unchanged();
        }
        if !input.budget.charge_records(1) {
            return input.unchanged();
        }
        selected.insert(index);
    }
    if selected.is_empty() || !lines.iter().any(|l| FINAL.test(l)) {
        return input.unchanged();
    }
    let Some(mut rendered) = render_gaps(input, &selected, |start, end| {
        describe(&compile_rows, start, end + 1)
    }) else {
        return input.unchanged();
    };
    let (Some(&first), Some(&last)) = (selected.first(), selected.last()) else {
        return input.unchanged();
    };
    if let Some(leading) = describe(&compile_rows, 0, first) {
        rendered = format!("{leading}\n{rendered}");
    }
    if let Some(trailing) = describe(&compile_rows, last + 1, lines.len()) {
        rendered = format!("{rendered}\n{trailing}");
    }
    if utf16_len(&rendered) > MAX_OUTPUT {
        input.unchanged()
    } else {
        Cow::Owned(rendered)
    }
}
