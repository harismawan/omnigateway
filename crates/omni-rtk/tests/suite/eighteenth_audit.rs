//! Audit regression suite: patch/log routing by origin and shape, and
//! trailing-row accounting.

use super::common::*;

fn omitted_by_unit(content: &str) -> (u64, u64) {
    let mut lines = 0;
    let mut warnings = 0;
    for (count, unit) in content.split('\n').filter_map(marker) {
        if unit == "warnings" {
            warnings += count;
        } else {
            lines += count;
        }
    }
    (lines, warnings)
}

fn real_omitted(f: &Fixture) -> u64 {
    (f.lines.len() - retained_rows(&f.content)) as u64
}

fn unified_patch(hunks: usize) -> Vec<String> {
    let mut lines = strs(&[
        "diff --git a/src/engine.ts b/src/engine.ts",
        "index 1111111..2222222 100644",
        "--- a/src/engine.ts",
        "+++ b/src/engine.ts",
    ]);
    for h in 0..hunks {
        lines.push(format!(
            "@@ -{0},7 +{0},7 @@ export function region{h}() {{",
            h * 20 + 1
        ));
        for row in 0..3 {
            lines.push(format!("   const beforeContext{h}_{row} = {row};"));
        }
        lines.push(format!("-  const changedCritical{h} = \"old value {h}\";"));
        lines.push(format!("+  const changedCritical{h} = \"new value {h}\";"));
        for row in 0..3 {
            lines.push(format!("   const afterContext{h}_{row} = {row};"));
        }
    }
    lines
}

fn commit_log(commits: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for i in 0..commits {
        lines.push(format!("commit {i:040x}"));
        if i % 3 == 0 {
            lines.push(format!("Merge: {i}aaaaaa {i}bbbbbb"));
        }
        lines.push(format!(
            "gpg: Signature made Mon 10 Aug 2026 07:43:{} PM WIB",
            i % 60
        ));
        lines.push(format!(
            "gpg:                using RSA key {:F>40}",
            format!("{i:x}")
        ));
        lines.push(
            "gpg: Good signature from \"Example Developer <developer@example.com>\" [ultimate]"
                .to_owned(),
        );
        lines.push("Author: Example Developer <developer@example.com>".to_owned());
        lines.push("Date:   Mon Aug 10 19:43:18 2026 +0700".to_owned());
        lines.push(String::new());
        lines.push(format!(
            "    fix(area{i}): the important commit subject number {i}"
        ));
        lines.push("    ".to_owned());
        lines.push(format!(
            "    Body paragraph explaining the change made in commit {i} at some length."
        ));
        lines.push(String::new());
        for file in 0..4 {
            lines.push(format!(
                " packages/module{file}/src/file-{i}-{file}.ts | {} +++--",
                file + 3
            ));
        }
        lines.push(" 4 files changed, 12 insertions(+), 8 deletions(-)".to_owned());
        lines.push(String::new());
    }
    lines
}

#[test]
fn a_u3_patch_read_with_cat_is_a_numbered_read_giving_up_per_hunk_diff_retention() {
    let f = run("cat feature.patch", &unified_patch(60));
    expect_compressed(&f, "numbered-read");
    assert!(!has(&f.report, "git-diff"));
    assert!(
        f.content
            .contains("-  const changedCritical0 = \"old value 0\";")
    );
    assert!(
        f.content
            .contains("+  const changedCritical59 = \"new value 59\";")
    );
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn the_same_u3_patch_from_a_git_diff_command_keeps_every_changed_row() {
    let f = run("git diff", &unified_patch(60));
    expect_compressed(&f, "git-diff");
    for h in 0..60 {
        assert!(
            f.content
                .contains(&format!("-  const changedCritical{h} = \"old value {h}\";"))
        );
        assert!(
            f.content
                .contains(&format!("+  const changedCritical{h} = \"new value {h}\";"))
        );
    }
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn a_git_log_carrying_commit_bodies_routes_to_git_log_and_keeps_every_subject() {
    let f = run("git log", &commit_log(40));
    expect_compressed(&f, "git-log");
    assert!(!has(&f.report, "numbered-read"));
    for i in 0..40 {
        assert!(f.content.contains(&format!(
            "    fix(area{i}): the important commit subject number {i}"
        )));
    }
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn a_log_read_with_cat_is_a_numbered_read_giving_up_per_commit_subject_retention() {
    let f = run("cat /tmp/history.txt", &commit_log(40));
    expect_compressed(&f, "numbered-read");
    assert!(!has(&f.report, "git-log"));
    assert!(
        f.content
            .contains("    fix(area0): the important commit subject number 0")
    );
    assert!(
        f.content
            .contains("    fix(area39): the important commit subject number 39")
    );
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn an_unknown_origin_log_with_no_command_still_routes_to_git_log_from_shape_alone() {
    let f = run_orphan(&commit_log(40));
    assert!(f.report.applied);
    assert!(has(&f.report, "git-log"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    for i in 0..40 {
        assert!(f.content.contains(&format!(
            "    fix(area{i}): the important commit subject number {i}"
        )));
    }
}

#[test]
fn an_unknown_origin_patch_with_no_command_still_routes_to_git_diff_from_shape_alone() {
    let f = run_orphan(&unified_patch(60));
    assert!(f.report.applied);
    assert!(has(&f.report, "git-diff"));
    assert!(utf16_len(&f.content) < utf16_len(&f.original));
    for h in 0..60 {
        assert!(
            f.content
                .contains(&format!("+  const changedCritical{h} = \"new value {h}\";"))
        );
    }
}

#[test]
fn prose_quoting_a_diff_hunk_stays_a_numbered_read() {
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
    let f = run("cat docs/RELEASE.md", &lines);
    expect_compressed(&f, "numbered-read");
    assert!(!has(&f.report, "git-diff"));
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn prose_quoting_a_commit_header_stays_a_numbered_read() {
    let mut lines = strs(&[
        "# Contribution guide",
        "commit 4f3a1c9d2b8e7a6f5c4d3b2a1908f7e6d5c4b3a2",
        "Author: Example Developer <developer@example.com>",
        "Date:   Mon Aug 10 19:43:18 2026 +0700",
    ]);
    for i in 0..300 {
        lines.push(format!(
            "GUIDANCE ROW {i}: contributors must sign every commit before pushing."
        ));
    }
    let f = run("cat docs/CONTRIBUTING.md", &lines);
    expect_compressed(&f, "numbered-read");
    assert!(!has(&f.report, "git-log"));
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
}

#[test]
fn clippy_epilogue_rows_after_the_final_error_are_counted_not_dropped() {
    let mut lines =
        strs(&["    Checking omnigateway v0.1.0 (/work/omnigateway) building the workspace"]);
    for i in 0..30 {
        lines.push(format!(
            "warning: unused variable `value{i}` found in this scope of the crate"
        ));
        lines.push(format!("  --> src/module{i}.rs:{}:9", i + 2));
    }
    lines.extend(strs(&[
        "error[E0308]: mismatched types in the gateway dispatch routine",
        "  --> src/dispatch.rs:42:17",
        "Found 1 error",
    ]));
    for i in 0..38 {
        lines.push(format!(
            "note: epilogue advisory row number {i} that must be counted"
        ));
    }
    lines.push("warning: `omnigateway` (lib) generated 26 warnings".to_owned());
    lines.push(
        "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.34s".to_owned(),
    );
    let f = run("cargo clippy", &lines);
    expect_compressed(&f, "lint-output");
    let (stated_lines, stated_warnings) = omitted_by_unit(&f.content);
    assert_eq!(stated_lines + stated_warnings * 2, real_omitted(&f));
    assert!(stated_lines >= 38);
    assert!(
        f.content
            .contains("error[E0308]: mismatched types in the gateway dispatch")
    );
    assert!(f.content.contains("Found 1 error"));
}

#[test]
fn bun_test_coverage_rows_after_the_summary_are_counted_not_dropped() {
    let mut lines =
        strs(&["bun test v1.4.0 running the omnigateway suite from the repository root"]);
    for i in 0..60 {
        lines.push(format!(
            "(pass) suite alpha > passing scenario number {i} completed successfully"
        ));
    }
    for i in 0..8 {
        lines.push(format!(
            "FAIL test/beta-{i}.test.ts > failing scenario number {i}"
        ));
        lines.push(format!(
            "  at test/beta-{i}.test.ts:{}:7 in the assertion helper",
            i + 10
        ));
    }
    lines.push("8 fail".to_owned());
    lines.push("Ran 68 tests across 4 files.".to_owned());
    for i in 0..30 {
        lines.push(format!(
            "File src/module{i}.ts | 88.10 | 72.40 | line coverage row {i} here"
        ));
    }
    let f = run("bun test", &lines);
    expect_compressed(&f, "test-output");
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
    for i in 0..8 {
        assert!(f.content.contains(&format!(
            "FAIL test/beta-{i}.test.ts > failing scenario number {i}"
        )));
    }
}

#[test]
fn npm_install_funding_rows_after_the_summary_are_counted_not_dropped() {
    let mut lines = gen_lines(55, |i| {
        format!("npm warn deprecated pkg-{i}@1.0.0: package {i} is no longer supported")
    });
    lines.push("added 120 packages, and audited 900 packages in 12s".to_owned());
    lines.push("found 3 vulnerabilities (1 moderate, 2 high)".to_owned());
    for i in 0..13 {
        lines.push(format!(
            "  funding advisory line number {i} describing sponsorship options here"
        ));
    }
    let f = run("npm install", &lines);
    expect_compressed(&f, "package-output");
    let (stated_lines, stated_warnings) = omitted_by_unit(&f.content);
    assert_eq!(stated_lines + stated_warnings, real_omitted(&f));
    assert_eq!(stated_warnings, 35);
    assert_eq!(stated_lines, 13);
    assert!(
        f.content
            .contains("found 3 vulnerabilities (1 moderate, 2 high)")
    );
}

#[test]
fn docker_progress_rows_before_and_after_the_semantic_range_are_counted() {
    let mut lines = strs(&["#1 [internal] load build definition from Dockerfile"]);
    for i in 0..6 {
        lines.push(format!("#1 transferring dockerfile: {i}00B"));
    }
    for i in 0..12 {
        lines.push(format!(
            "#{} [{}/12] RUN build step number {i} of the image",
            i + 2,
            i + 1
        ));
    }
    lines.push("#20 exporting layers to the local image store now".to_owned());
    lines.push("#20 naming to docker.io/library/omnigateway:latest done".to_owned());
    for i in 0..6 {
        lines.push(format!("#21 transferring context: {i}00kB"));
    }
    let f = run("docker build .", &lines);
    expect_compressed(&f, "docker-build");
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
    assert!(
        f.content
            .contains("#20 naming to docker.io/library/omnigateway:latest done")
    );
}

#[test]
fn git_transfer_progress_rows_before_and_after_the_semantic_range_are_counted() {
    let mut lines = gen_lines(5, |i| {
        format!("remote: Counting objects: {}% ({i}/5)", i * 20)
    });
    lines.push("From github.com:example/omnigateway".to_owned());
    for i in 0..12 {
        lines.push(format!(
            "ff{i}0000..aa{i}0000  feature/branch-{i} -> origin/branch-{i}"
        ));
    }
    lines.push("Fast-forward".to_owned());
    for i in 0..5 {
        lines.push(format!("remote: Compressing objects: {}% ({i}/5)", i * 20));
    }
    let f = run("git pull", &lines);
    expect_compressed(&f, "git-operation");
    assert_eq!(omitted_total(&f.content), real_omitted(&f));
    assert!(f.content.contains("From github.com:example/omnigateway"));
    assert!(f.content.contains("Fast-forward"));
}

#[test]
fn real_eslint_output_compresses_and_its_trailing_fixability_row_is_stated() {
    let mut lines = strs(&["/work/src/all.ts"]);
    for i in 0..30 {
        lines.push(format!(
            "  {}:9  warning  'unused{i}' is assigned a value but never used  no-unused-vars",
            i + 1
        ));
    }
    lines.extend(strs(&[
        "  99:3  error  Parsing error: unexpected token in the module body  parse",
        "",
        "✖ 31 problems (1 error, 30 warnings)",
        "  0 errors and 30 warnings potentially fixable with the `--fix` option.",
    ]));
    let f = run("eslint .", &lines);
    expect_compressed(&f, "lint-output");
    let (stated_lines, stated_warnings) = omitted_by_unit(&f.content);
    assert_eq!(stated_lines + stated_warnings, real_omitted(&f));
    assert!(f.content.contains("✖ 31 problems (1 error, 30 warnings)"));
    assert!(
        f.content
            .contains("  99:3  error  Parsing error: unexpected token in the module body  parse")
    );
    assert!(
        f.content
            .ends_with("✖ 31 problems (1 error, 30 warnings)\n... 1 lines omitted ...")
    );
}
