//! `packages/rtk/test/sixteenth-audit.test.ts`.

use super::common::*;

#[test]
fn tsc_output_carrying_a_git_commit_banner_keeps_every_middle_diagnostic() {
    let mut lines = strs(&[
        "commit 4f3a1c9d2b8e7a6f5c4d3b2a1908f7e6d5c4b3a2",
        "Author: CI Bot <ci@example.com>",
    ]);
    for i in 0..40 {
        lines.push(format!(
            "src/mod{i}.ts({},5): error TS2322: Type mismatch in module {i}.",
            i + 1
        ));
    }
    lines.push("Found 40 errors in 12 files.".to_owned());
    let original = join(&lines);
    let f = run("tsc --noEmit", &lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "lint-output"));
    assert!(!has(&f.report, "git-log"));
    assert!(utf16_len(&f.content) < utf16_len(&original));
    assert!(f.content.contains("Found 40 errors in 12 files."));
    for i in 18..=28 {
        assert!(f.content.contains(&format!(
            "src/mod{i}.ts({},5): error TS2322: Type mismatch in module {i}.",
            i + 1
        )));
    }
}

#[test]
fn bun_test_output_containing_a_unified_diff_keeps_every_middle_failure() {
    let mut lines = strs(&[
        "bun test v1.4.0",
        "diff --git a/src/config.ts b/src/config.ts",
        "--- a/src/config.ts",
        "+++ b/src/config.ts",
        "@@ -1,4 +1,4 @@",
        "-const retries = 1;",
        "+const retries = 2;",
    ]);
    for i in 0..60 {
        lines.push(format!(
            "(pass) suite {i} > uninteresting passing test {i} finished"
        ));
    }
    for i in 0..50 {
        lines.push(format!(
            "FAIL test/suite-{i}.test.ts > important failing test {i}"
        ));
    }
    lines.push("51 fail".to_owned());
    lines.push("Ran 101 tests across 12 files.".to_owned());
    let original = join(&lines);
    let f = run("bun test", &lines);
    assert!(f.report.applied);
    assert!(has(&f.report, "test-output"));
    assert!(!has(&f.report, "git-diff"));
    assert!(utf16_len(&f.content) < utf16_len(&original));
    for i in 0..50 {
        assert!(f.content.contains(&format!(
            "FAIL test/suite-{i}.test.ts > important failing test {i}"
        )));
    }
    let retained = f
        .content
        .split('\n')
        .filter(|l| loose_marker(l).is_none())
        .count();
    assert_eq!(
        loose_omitted_total(&f.content),
        (lines.len() - retained) as u64
    );
}

#[test]
fn npm_install_output_containing_a_patch_diff_reports_package_warnings_by_count() {
    let mut lines = strs(&[
        "diff --git a/node_modules/left-pad/index.js b/node_modules/left-pad/index.js",
        "--- a/node_modules/left-pad/index.js",
        "+++ b/node_modules/left-pad/index.js",
        "@@ -1,3 +1,3 @@",
    ]);
    for i in 0..40 {
        lines.push(format!(
            "npm warn deprecated pkg-{i}@1.0.0: package {i} is no longer supported"
        ));
    }
    lines.push("added 120 packages, and audited 900 packages in 12s".to_owned());
    lines.push("found 3 vulnerabilities (1 moderate, 2 high)".to_owned());
    let f = run("npm install", &lines);
    assert!(!has(&f.report, "git-diff"));
    assert!(has(&f.report, "package-output"));
    assert!(f.content.contains("... 20 warnings omitted ..."));
}

#[test]
fn cat_of_a_document_containing_a_diff_hunk_keeps_every_middle_note() {
    let mut lines = strs(&[
        "# Release notes",
        "diff --git a/deploy.sh b/deploy.sh",
        "--- a/deploy.sh",
        "+++ b/deploy.sh",
        "@@ -10,6 +10,6 @@",
    ]);
    for i in 0..300 {
        lines.push(format!(
            "IMPORTANT MIDDLE NOTE {i}: operators must rotate the key."
        ));
    }
    let original = join(&lines);
    let f = run("cat docs/RELEASE.md", &lines);
    assert!(f.report.applied);
    assert!(utf16_len(&f.content) < utf16_len(&original));
    assert!(!has(&f.report, "git-diff"));
    assert!(has(&f.report, "numbered-read"));
    assert!(
        f.content
            .contains("IMPORTANT MIDDLE NOTE 94: operators must rotate the key.")
    );
    assert!(
        !f.content
            .contains("IMPORTANT MIDDLE NOTE 95: operators must rotate the key.")
    );
    assert_eq!(loose_omitted_total(&f.content), 155);
    assert_eq!(loose_marker_count(&f.content), 1);
}

fn warning_rows(range: std::ops::Range<usize>) -> Vec<String> {
    range
        .map(|i| {
            format!(
                "w{i}.ts({},2): warning TS6133: 'unused{i}' is declared.",
                i + 2
            )
        })
        .collect()
}

#[test]
fn an_error_whose_message_embeds_the_summary_text_survives_intact() {
    let lines = cat(&[
        strs(&["a.ts(1,1): error TS1: Expected message: Found 2 problems in config."]),
        warning_rows(0..12),
        strs(&["mid.ts(50,7): error TS2322: middle anchor must survive."]),
        warning_rows(12..25),
        strs(&["Found 2 problems"]),
    ]);
    let f = run("tsc --noEmit", &lines);
    assert!(has(&f.report, "lint-output"));
    assert!(
        f.content
            .contains("a.ts(1,1): error TS1: Expected message: Found 2 problems in config.")
    );
    assert!(
        f.content
            .contains("mid.ts(50,7): error TS2322: middle anchor must survive.")
    );
    assert!(
        f.content
            .ends_with("... 5 warnings omitted ...\nFound 2 problems")
    );
}

#[test]
fn a_decoy_summary_row_does_not_attract_the_omission_marker_to_the_top() {
    let lines = cat(&[
        strs(&["Found 2 problems"]),
        warning_rows(0..12),
        strs(&["mid.ts(50,7): error TS2322: middle anchor must survive."]),
        warning_rows(12..25),
        strs(&["Found 2 problems"]),
    ]);
    let f = run("tsc --noEmit", &lines);
    assert!(has(&f.report, "lint-output"));
    assert!(!f.content.starts_with("... 5 warnings omitted ..."));
    assert!(
        f.content
            .contains("mid.ts(50,7): error TS2322: middle anchor must survive.")
    );
    assert!(
        f.content
            .ends_with("... 5 warnings omitted ...\nFound 2 problems")
    );
}

#[test]
fn build_output_counts_collapsed_compile_rows_under_a_single_unit() {
    let mut lines = strs(&["bun build v1.4.0 (production bundle for the gateway release channel)"]);
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
    lines.push("Build completed in 1200ms with 10 emitted artifacts".to_owned());
    let f = run("bun build", &lines);
    assert!(has(&f.report, "build-output"));
    assert_eq!(loose_marker_count(&f.content), 1);
    assert_eq!(loose_omitted_total(&f.content), 10);
}

#[test]
fn prose_rows_carrying_a_slash_are_not_grouped_as_listing_entries() {
    let mut valid = Vec::new();
    for d in 0..12 {
        for file in 0..20 {
            valid.push(format!("docs/section-{d}/chapter-{file}.md"));
        }
    }
    for invalid in [
        "Permission denied for /var/log",
        "warning cannot read /etc/shadow",
        "Operation not permitted on data/private",
    ] {
        let middled = cat(&[
            valid[..120].to_vec(),
            strs(&[invalid]),
            valid[120..].to_vec(),
        ]);
        let f = run("find . -type f", &middled);
        assert!(f.unchanged, "{invalid}");
        assert!(f.content.contains(invalid));
    }
    let control = run("find . -type f", &valid);
    assert!(!control.unchanged);
    assert!(has(&control.report, "path-list"));
    assert!(utf16_len(&control.content) < utf16_len(&join(&valid)));
}
