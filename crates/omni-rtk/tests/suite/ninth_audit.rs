//! Audit regression suite: grep/listing omission quotas and context-separator
//! placement.

use super::common::*;

#[test]
fn retained_middle_exception_is_excluded_from_omitted_grep_totals() {
    let mut lines = Vec::new();
    for file in 0..42 {
        let count = match file {
            20 => 1,
            21 => 5,
            _ => 2,
        };
        for m in 0..count {
            lines.push(format!("src/file-{file}.ts:{}:match-{file}-{m}", m + 1));
        }
    }
    let f = run("rg -n pattern src", &lines);
    assert!(f.content.contains("src/file-20.ts:1:match-20-0"));
    assert!(
        f.content
            .contains("... 1 file omitted containing 5 matches ...")
    );
    assert!(!f.content.contains("2 files omitted"));
}

#[test]
fn context_separator_survives_between_adjacent_retained_regions() {
    let f = run(
        "rg -n -C 1 pattern src",
        &cat(&[
            strs(&[
                "src/a.ts:1:first",
                "src/a.ts-2-context",
                "--",
                "src/a.ts-20-context",
                "src/a.ts:21:second",
            ]),
            gen_lines(30, |i| format!("src/a.ts-{}-long-context-tail", 22 + i)),
        ]),
    );
    assert!(has(&f.report, "grep"));
    assert!(f.content.contains("--"));
    for line in [
        "src/a.ts:1:first",
        "src/a.ts-2-context",
        "src/a.ts-20-context",
        "src/a.ts:21:second",
    ] {
        assert!(f.content.contains(line));
    }
}

#[test]
fn ambiguous_context_separator_assignment_retains_original() {
    let f = run(
        "rg -n -C 1 pattern src",
        &cat(&[
            strs(&["src/a.ts:1:first", "--", "src/b.ts-2-context"]),
            gen_lines(20, |i| format!("src/b.ts-{}-tail", 3 + i)),
        ]),
    );
    assert!(f.unchanged);
}

#[test]
fn grep_match_quota_excludes_heading_and_context_rows() {
    let mut lines = strs(&["src/a.ts"]);
    for m in 0..13 {
        let text = if m == 6 {
            format!("match-{m}-{}", "detail-".repeat(12))
        } else {
            format!("match-{m}")
        };
        lines.push(format!("{}:{text}", m * 3 + 1));
        lines.push(format!("{}-context-a", m * 3 + 2));
        lines.push(format!("{}-context-b", m * 3 + 3));
    }
    let f = run("rg --heading -n -C 2 pattern src", &lines);
    assert!(f.content.contains("src/a.ts"));
    assert!(f.content.contains("... 1 match omitted from src/a.ts ..."));
    assert!(!f.content.contains("entries omitted"));
}

#[test]
fn listing_entry_quota_excludes_heading_and_total_structures() {
    let rows = gen_lines(13, |i| {
        format!("-rw-r--r-- 1 u g 10 Aug 10 12:00 file-{i}.ts")
    });
    let f = run("ls -lR .", &cat(&[strs(&["./src:", "total 13"]), rows]));
    assert!(f.content.contains("./src:"));
    assert!(f.content.contains("total 13"));
    assert!(f.content.contains("... 1 entry omitted from ./src ..."));
}
