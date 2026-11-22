//! The bounded line scan, the shared
//! parser budget and the omission-marker renderer.
//!
//! Every length here is a UTF-16 code-unit count, as JS `string.length`
//! counts it, because the budget, `MAX_OUTPUT` and the acceptance guard are
//! all stated in those units.

use crate::jsre::js_regex;
use omni_ir::js::utf16_len;
use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;

pub const MAX_ROWS: usize = 100_000;
pub const MAX_OUTPUT: usize = 250_000;

/// Which counter a [`Charge`] went to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChargeKind {
    Records,
    CodeUnits,
}

/// One budget charge, kept only by a [`ParserBudget::recording`] budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Charge {
    pub kind: ChargeKind,
    pub count: u64,
}

/// `ParserBudget`: one record allowance (100,000) and one allocation
/// allowance (three times the input's code units) shared by every parser that
/// touches one tool result. The two counters are independent: each only
/// grows, so once one allowance is exceeded every later charge *to that
/// counter* fails, while the other counter is unaffected.
#[derive(Debug)]
pub struct ParserBudget {
    records: Cell<u64>,
    code_units: Cell<u64>,
    input_code_units: u64,
    log: Option<RefCell<Vec<Charge>>>,
}

impl ParserBudget {
    pub fn new(input_code_units: usize) -> Self {
        Self {
            records: Cell::new(0),
            code_units: Cell::new(0),
            input_code_units: input_code_units as u64,
            log: None,
        }
    }

    /// A budget that also records each charge, for tests that pin when a
    /// parser pays.
    pub fn recording(input_code_units: usize) -> Self {
        Self {
            log: Some(RefCell::new(Vec::new())),
            ..Self::new(input_code_units)
        }
    }

    pub fn charges(&self) -> Vec<Charge> {
        self.log
            .as_ref()
            .map(|log| log.borrow().clone())
            .unwrap_or_default()
    }

    fn note(&self, kind: ChargeKind, count: usize) {
        if let Some(log) = &self.log {
            log.borrow_mut().push(Charge {
                kind,
                count: count as u64,
            });
        }
    }

    pub fn charge_records(&self, count: usize) -> bool {
        self.note(ChargeKind::Records, count);
        let total = self.records.get().saturating_add(count as u64);
        self.records.set(total);
        total <= MAX_ROWS as u64
    }

    pub fn charge_code_units(&self, count: usize) -> bool {
        self.note(ChargeKind::CodeUnits, count);
        let total = self.code_units.get().saturating_add(count as u64);
        self.code_units.set(total);
        total <= self.input_code_units.saturating_mul(3)
    }
}

/// `BoundedText`: the input, its rows and the budget every parser charges.
#[derive(Debug)]
pub struct BoundedText<'a> {
    pub text: &'a str,
    pub lines: Vec<&'a str>,
    pub budget: ParserBudget,
}

impl<'a> BoundedText<'a> {
    /// `input.lines[index] ?? ""`.
    pub(crate) fn line(&self, index: usize) -> &'a str {
        self.lines.get(index).copied().unwrap_or("")
    }

    pub(crate) fn unchanged(&self) -> Cow<'a, str> {
        Cow::Borrowed(self.text)
    }
}

/// `ParsedBlock`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBlock<'a> {
    pub start: usize,
    pub end: usize,
    pub severity: Severity,
    pub identity: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

/// `scanText`: splits on `\n`, `\r` and `\r\n`, charging one record and the
/// row's code units per row. `None` when the input exceeds either allowance.
pub fn scan_text(text: &str) -> Option<BoundedText<'_>> {
    let budget = ParserBudget::new(utf16_len(text));
    let mut lines = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        let code = bytes[index];
        if code != b'\n' && code != b'\r' {
            index += 1;
            continue;
        }
        if !budget.charge_records(1) {
            return None;
        }
        let line = &text[start..index];
        if !budget.charge_code_units(utf16_len(line)) {
            return None;
        }
        lines.push(line);
        if code == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            index += 1;
        }
        start = index + 1;
        index += 1;
    }
    if !budget.charge_records(1) {
        return None;
    }
    let line = &text[start..];
    if !budget.charge_code_units(utf16_len(line)) {
        return None;
    }
    lines.push(line);
    Some(BoundedText {
        text,
        lines,
        budget,
    })
}

/// `renderGaps`: the selected rows in order, with `describe(start, end)`
/// (inclusive) labelling each gap; `None` from `describe` emits no marker.
pub fn render_gaps(
    input: &BoundedText<'_>,
    selected: &BTreeSet<usize>,
    mut describe: impl FnMut(usize, usize) -> Option<String>,
) -> Option<String> {
    if !input.budget.charge_records(selected.len()) {
        return None;
    }
    let mut output: Vec<Cow<'_, str>> = Vec::new();
    let mut previous: Option<usize> = None;
    for &index in selected {
        if let Some(previous) = previous
            && index > previous + 1
            && let Some(marker) = describe(previous + 1, index - 1)
        {
            if !input.budget.charge_code_units(utf16_len(&marker)) {
                return None;
            }
            output.push(Cow::Owned(marker));
        }
        if let Some(line) = input.lines.get(index) {
            if !input.budget.charge_code_units(utf16_len(line)) {
                return None;
            }
            output.push(Cow::Borrowed(line));
        }
        previous = Some(index);
    }
    Some(output.join("\n"))
}

/// `renderSelection`: [`render_gaps`] with `... N {unit} omitted ...`.
pub fn render_selection(
    input: &BoundedText<'_>,
    selected: &BTreeSet<usize>,
    unit: &str,
) -> Option<String> {
    render_gaps(input, selected, |start, end| {
        Some(format!("... {} {unit} omitted ...", end - start + 1))
    })
}

/// Charges `end - start + 1` records, then selects the rows.
///
/// Total over every `ParsedBlock`, including ones no parser produces. The
/// count is computed without unchecked arithmetic:
/// - `start == end + 1`: charges 0 and returns true, selecting nothing.
/// - `start > end + 1`: charges 0. A *negative* count would credit the shared
///   budget, letting a malformed helper call widen every later parser's
///   allowance, and the budget only ever shrinks here. No internal caller
///   can build such a block, so this case is unreachable from
///   `transform_request`.
/// - a span too long for `usize` (`start = 0, end = usize::MAX`) saturates,
///   fails the charge and selects nothing.
pub fn select_block(
    input: &BoundedText<'_>,
    selected: &mut BTreeSet<usize>,
    block: &ParsedBlock<'_>,
) -> bool {
    let count = block
        .end
        .checked_sub(block.start)
        .map_or(0, |span| span.saturating_add(1));
    if !input.budget.charge_records(count) {
        return false;
    }
    selected.extend(block.start..=block.end);
    true
}

js_regex!(CONTINUATION = r"^(?:\s|\||\^|~|help:|note:|=|-->|Caused by:|at\s|detail$)");
js_regex!(WARNING_WORD = r"\bwarning\b", "i");

/// `diagnosticBlocks`.
pub(crate) fn diagnostic_blocks<'a>(
    input: &BoundedText<'a>,
    primary: &crate::jsre::JsRegex,
) -> Option<Vec<ParsedBlock<'a>>> {
    let mut starts = Vec::new();
    for (index, line) in input.lines.iter().enumerate() {
        if !primary.test(line) {
            continue;
        }
        if !input.budget.charge_records(1) {
            return None;
        }
        starts.push(index);
    }
    let mut blocks = Vec::with_capacity(starts.len());
    for (offset, &start) in starts.iter().enumerate() {
        if !input.budget.charge_records(1) {
            return None;
        }
        let next = starts.get(offset + 1).copied().unwrap_or(input.lines.len());
        let mut end = start;
        while end + 1 < next {
            if !CONTINUATION.test(input.line(end + 1)) {
                break;
            }
            end += 1;
        }
        let header = input.line(start);
        blocks.push(ParsedBlock {
            start,
            end,
            severity: if WARNING_WORD.test(header) {
                Severity::Warning
            } else {
                Severity::Error
            },
            identity: header,
        });
    }
    Some(blocks)
}

/// `lines omitted` markers for rows before the first and after the last
/// selected index (several filters append these). `None` when nothing lies
/// outside the selection.
pub(crate) fn plain_edges(
    input: &BoundedText<'_>,
    selected: &BTreeSet<usize>,
    rendered: String,
) -> String {
    let (Some(&first), Some(&last)) = (selected.first(), selected.last()) else {
        return rendered;
    };
    let trailing = input.lines.len() - 1 - last;
    let mut out = rendered;
    if first > 0 {
        out = format!("... {first} lines omitted ...\n{out}");
    }
    if trailing > 0 {
        out = format!("{out}\n... {trailing} lines omitted ...");
    }
    out
}

/// `rendered.length <= MAX_OUTPUT ? rendered : text`.
pub(crate) fn capped<'a>(input: &BoundedText<'a>, rendered: String) -> Cow<'a, str> {
    if utf16_len(&rendered) <= MAX_OUTPUT {
        Cow::Owned(rendered)
    } else {
        input.unchanged()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_splits_every_terminator_form_once() {
        let input = scan_text("a\r\nb\rc\n\nd").expect("bounded");
        assert_eq!(input.lines, ["a", "b", "c", "", "d"]);
    }

    #[test]
    fn budgets_count_code_units_not_bytes() {
        let budget = ParserBudget::new(1);
        assert!(budget.charge_code_units(3));
        assert!(!budget.charge_code_units(1));
        assert!(scan_text("😀").is_some());
    }

    fn block(start: usize, end: usize) -> ParsedBlock<'static> {
        ParsedBlock {
            start,
            end,
            severity: Severity::Error,
            identity: "",
        }
    }

    fn records(budget: &ParserBudget) -> u64 {
        budget
            .charges()
            .iter()
            .filter(|c| c.kind == ChargeKind::Records)
            .map(|c| c.count)
            .sum()
    }

    /// `select_block` on `{start: 1, end: 0}` charges `0` and returns true
    /// with nothing selected; on `{start: 0, end: MAX}` it charges a huge
    /// count and returns false. Neither may panic here.
    #[test]
    fn select_block_handles_reversed_and_overflowing_ranges_without_panicking() {
        let input = BoundedText {
            text: "x",
            lines: vec!["x"],
            budget: ParserBudget::recording(1),
        };
        let mut selected = BTreeSet::new();
        assert!(select_block(&input, &mut selected, &block(1, 0)));
        assert!(selected.is_empty());
        assert_eq!(records(&input.budget), 0);

        assert!(!select_block(&input, &mut selected, &block(0, usize::MAX)));
        assert!(selected.is_empty());

        // Deeper reversals select nothing and charge nothing.
        let fresh = BoundedText {
            text: "x",
            lines: vec!["x"],
            budget: ParserBudget::recording(1),
        };
        assert!(select_block(&fresh, &mut selected, &block(7, 2)));
        assert!(selected.is_empty());
        assert_eq!(records(&fresh.budget), 0);

        // A valid block is unchanged.
        assert!(select_block(&fresh, &mut selected, &block(0, 0)));
        assert_eq!(selected, BTreeSet::from([0]));
        assert_eq!(records(&fresh.budget), 1);
    }

    #[test]
    fn render_selection_labels_gaps() {
        let text = ["a".repeat(20), "b".into(), "c".into(), "d".repeat(20)].join("\n");
        let input = scan_text(&text).expect("bounded");
        let selected = BTreeSet::from([0, 3]);
        assert_eq!(
            render_selection(&input, &selected, "lines"),
            Some(format!(
                "{}\n... 2 lines omitted ...\n{}",
                "a".repeat(20),
                "d".repeat(20)
            ))
        );
        // The marker is charged to the same 3x allocation allowance.
        let tight = scan_text("a\nb\nc\nd").expect("bounded");
        assert_eq!(render_selection(&tight, &selected, "lines"), None);
    }
}
