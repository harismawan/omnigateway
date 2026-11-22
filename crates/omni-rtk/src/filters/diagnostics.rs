//! Compiler-diagnostics output compression.

use super::shared::{
    BoundedText, MAX_OUTPUT, ParsedBlock, Severity, diagnostic_blocks, render_gaps, select_block,
};
use crate::jsre::js_regex;
use omni_ir::js::utf16_len;
use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};

js_regex!(
    PRIMARY = r"^(?:[^\n]+\(\d+,\d+\):\s+(?:error|warning)\s+TS\d+:|[^\n]+:\d+:\d+(?::|\s).+|[^\n]+\n\s*\d+:\d+\s+(?:error|warning)\s|\s*\d+:\d+\s+(?:error|warning)\s|(?:error|warning)(?:\[[^\]]+\])?:)",
    "i"
);
js_regex!(
    SUMMARY = r"(?:Found \d+ errors?(?: and \d+ warnings?)?(?: in \d+ files?)?|\d+ problems?(?: \([^)\n]*\))?|Checked \d+ files?|could not compile|\d+ issues?)\.?$",
    "i"
);

/// Counts rows `from..to` as whole omitted warning blocks (by first row) and
/// every other omitted row, each exactly once. Shared with `packages`.
pub(crate) struct WarningGaps {
    pub rows: HashSet<usize>,
    pub starts: HashSet<usize>,
}

impl WarningGaps {
    pub(crate) fn describe(&self, from: usize, to: usize) -> Option<String> {
        let mut warning_blocks = 0;
        let mut other_rows = 0;
        for index in from..to {
            if self.starts.contains(&index) {
                warning_blocks += 1;
            }
            if !self.rows.contains(&index) {
                other_rows += 1;
            }
        }
        let mut parts = Vec::new();
        if warning_blocks > 0 {
            parts.push(format!("... {warning_blocks} warnings omitted ..."));
        }
        if other_rows > 0 {
            parts.push(format!("... {other_rows} lines omitted ..."));
        }
        (!parts.is_empty()).then(|| parts.join("\n"))
    }

    /// The cap-dropped unique warnings: a block counts only when no selected
    /// row splits it. `None` when the budget runs out.
    pub(crate) fn build(
        input: &BoundedText<'_>,
        selected: &BTreeSet<usize>,
        dropped: &[(usize, usize)],
    ) -> Option<Self> {
        let mut rows = HashSet::new();
        let mut starts = HashSet::new();
        for &(start, end) in dropped {
            if !input.budget.charge_records(end - start + 1) {
                return None;
            }
            if (start..=end).any(|i| selected.contains(&i)) {
                continue;
            }
            starts.insert(start);
            rows.extend(start..=end);
        }
        Some(Self { rows, starts })
    }

    /// Gap markers plus the rows outside the selected range.
    pub(crate) fn render(
        &self,
        input: &BoundedText<'_>,
        selected: &BTreeSet<usize>,
    ) -> Option<String> {
        let mut rendered =
            render_gaps(input, selected, |start, end| self.describe(start, end + 1))?;
        let first = *selected.first()?;
        let last = *selected.last()?;
        if let Some(leading) = self.describe(0, first) {
            rendered = format!("{leading}\n{rendered}");
        }
        if let Some(trailing) = self.describe(last + 1, input.lines.len()) {
            rendered = format!("{rendered}\n{trailing}");
        }
        Some(rendered)
    }
}

/// `compressDiagnostics`.
pub fn compress_diagnostics<'a>(input: &BoundedText<'a>) -> Cow<'a, str> {
    let lines = &input.lines;
    let Some(blocks) = diagnostic_blocks(input, &PRIMARY) else {
        return input.unchanged();
    };
    if blocks.is_empty() {
        return input.unchanged();
    }
    let Some(summary) = lines.iter().rposition(|l| SUMMARY.test(l)) else {
        return input.unchanged();
    };
    let mut selected = BTreeSet::from([0, summary]);
    let errors: Vec<&ParsedBlock<'_>> = blocks
        .iter()
        .filter(|b| b.severity == Severity::Error)
        .collect();
    let mut seen = HashSet::new();
    let warnings: Vec<&ParsedBlock<'_>> = blocks
        .iter()
        .filter(|b| b.severity == Severity::Warning && seen.insert(b.identity))
        .collect();
    for block in errors.iter().chain(warnings.iter().take(20)) {
        if !select_block(input, &mut selected, block) {
            return input.unchanged();
        }
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
