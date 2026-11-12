//! `packages/rtk/test/seventeenth-audit.test.ts`.

use super::common::*;

fn patch_header() -> Vec<String> {
    strs(&[
        "diff --git a/src/big.ts b/src/big.ts",
        "index 1111111..2222222 100644",
        "--- a/src/big.ts",
        "+++ b/src/big.ts",
        "@@ -1,400 +1,400 @@",
    ])
}

#[test]
fn cat_of_a_patch_file_is_a_numbered_read_giving_up_git_anchor_retention_of_its_middle() {
    let mut lines = patch_header();
    for i in 0..400 {
        lines.push(format!("-const removedCriticalLine{i} = {i};"));
        if i % 20 == 19 {
            lines.push("   untouched filler context row".to_owned());
        }
    }
    let f = run("cat patch.diff", &lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "numbered-read"));
    assert!(!has(&f.report, "git-diff"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    assert_eq!(lines.len(), 425);
    assert_eq!(loose_omitted_total(&f.content), 275);
    assert!(f.content.contains("-const removedCriticalLine0 = 0;"));
    assert!(f.content.contains("-const removedCriticalLine399 = 399;"));
}

#[test]
fn the_same_patch_from_a_git_diff_command_still_keeps_every_changed_row() {
    let mut lines = patch_header();
    for i in 0..400 {
        lines.push(format!("-const removedCriticalLine{i} = {i};"));
        if i % 5 == 4 {
            lines.push(format!(
                "   untouched filler context row {i} carrying no marker at all"
            ));
        }
    }
    let f = run("git diff", &lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "git-diff"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    for i in 0..400 {
        assert!(
            f.content
                .contains(&format!("-const removedCriticalLine{i} = {i};"))
        );
    }
}

#[test]
fn cat_of_prose_stays_a_numbered_read_and_accounts_for_every_omitted_row() {
    let lines = gen_lines(300, |i| {
        format!("## 1.{i}.0 - release note {i} describing an operator visible change")
    });
    let f = run("cat CHANGELOG.md", &lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "numbered-read"));
    assert!(!has(&f.report, "git-diff"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    assert_eq!(loose_omitted_total(&f.content), 150);
    assert!(f.content.contains(lines[99].as_str()));
    assert!(f.content.contains(lines[299].as_str()));
}

#[test]
fn non_contiguous_omitted_warnings_are_not_reported_as_both_lines_and_warnings() {
    let mut lines = strs(&["a.ts(1,1): error TS1: boom error anchor here padding padding padding"]);
    for i in 0..25 {
        lines.push(format!(
            "w{i}.ts({},2): warning TS6133: 'unused{i}' is declared but never used okay",
            i + 2
        ));
        lines.push(format!("----- separator row {i} -----"));
    }
    lines.push("Found 1 error".to_owned());
    let f = run("tsc --noEmit", &lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "lint-output"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    let retained = f
        .content
        .split('\n')
        .filter(|l| !l.starts_with("... "))
        .count();
    assert_eq!(retained, 22);
    assert_eq!(loose_omitted_total(&f.content), 30);
    assert!(f.content.contains("... 5 warnings omitted ..."));
    assert!(f.content.ends_with("\nFound 1 error"));
}

#[test]
fn collapsed_rows_before_and_after_the_selected_range_are_stated() {
    let mut lines = strs(&[
        "progress 1",
        "progress 2",
        "",
        "bun build v1.4.0 (production bundle for the gateway release channel)",
    ]);
    for i in 0..5 {
        lines.push(format!(
            "dist/chunk-{i}-with-a-long-descriptive-name.js  {}",
            1024 + i
        ));
    }
    for i in 0..10 {
        lines.push(format!(
            "Compiling repeated crate-{i}-with-a-long-descriptive-name v1.0.0"
        ));
    }
    for i in 5..10 {
        lines.push(format!(
            "dist/chunk-{i}-with-a-long-descriptive-name.js  {}",
            1024 + i
        ));
    }
    lines.extend(strs(&[
        "Build completed in 1200ms with 10 emitted artifacts",
        "progress 98",
        "",
    ]));
    let f = run("bun build", &lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "build-output"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    assert_eq!(loose_omitted_total(&f.content), 15);
    assert!(f.content.starts_with("... 3 lines omitted ...\n"));
    assert!(f.content.ends_with("\n... 2 lines omitted ..."));
}
