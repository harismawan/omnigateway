//! Audit regression suite: recursive-ls and grep grouping, exact omissions
//! and near-limit budget rejection.

use super::common::*;

#[test]
fn plain_recursive_ls_groups_newline_entries_and_reports_exact_omissions() {
    let mut lines = Vec::new();
    for group in 0..42 {
        lines.push(format!("./dir-{group}:"));
        let count = match group {
            20 => 3,
            21 => 7,
            0 => 20,
            _ => 1,
        };
        for entry in 0..count {
            lines.push(format!("file-{group}-{entry}.ts"));
        }
        lines.push(String::new());
    }
    let f = run("ls -R .", &lines);
    assert!(has(&f.report, "tree-output"));
    assert!(
        f.content
            .contains("... 2 directories omitted containing 10 entries ...")
    );
    assert!(f.content.contains("... 8 entries omitted from ./dir-0 ..."));
    assert!(f.content.contains("./dir-0:"));
    assert!(f.content.contains("./dir-41:"));
}

#[test]
fn plain_recursive_ls_rejects_ambiguous_or_unassignable_rows() {
    for lines in [
        strs(&["orphan.ts", "./a:", "file.ts"]),
        strs(&["./a:", "file.ts", "./b:", ""]),
        strs(&["./a:", "bad/name.ts"]),
    ] {
        let f = run("ls -R .", &cat(&[lines, vec![String::new(); 30]]));
        assert!(f.unchanged);
    }
}

#[test]
fn package_parser_rejects_before_allocating_near_limit_warning_structures() {
    let warnings: Vec<String> = (0..40_000)
        .flat_map(|i| {
            [
                format!("npm warn [{}/40000] workspace app: W{i} warning {i}", i + 1),
                "npm warn required by package-a".to_owned(),
            ]
        })
        .collect();
    let f = run(
        "npm install",
        &cat(&[warnings, strs(&["installed 1 package"])]),
    );
    assert!(f.unchanged);
}

#[test]
fn unknown_origin_windows_grep_is_recognized_without_colon_ambiguity() {
    let lines = gen_lines(30, |i| {
        format!(
            "C:\\repo\\src\\file.ts:{}:matched descriptive text {i}",
            i + 1
        )
    });
    let f = run_named("ignored", &lines, "mystery");
    assert!(has(&f.report, "grep"));
    assert!(f.content.contains(lines[0].as_str()));
    assert!(f.content.contains(lines[29].as_str()));
    let ambiguous = run_named(
        "ignored",
        &gen_lines(30, |i| format!("key:value:{i}:prose")),
        "mystery",
    );
    assert!(ambiguous.unchanged);
}

#[test]
fn grep_groups_by_filename_and_retains_a_middle_single_match_file() {
    let mut lines = Vec::new();
    for file in 0..42 {
        let count = match file {
            20 => 1,
            21 => 5,
            0 => 20,
            _ => 2,
        };
        for m in 0..count {
            lines.push(format!("src/file-{file}.ts:{}:match-{file}-{m}", m + 1));
        }
    }
    let f = run("rg -n pattern src", &lines);
    assert!(has(&f.report, "grep"));
    assert!(f.content.contains("src/file-20.ts:1:match-20-0"));
    assert!(
        f.content
            .contains("... 8 matches omitted from src/file-0.ts ...")
    );
    assert!(
        f.content
            .contains("... 1 file omitted containing 5 matches ...")
    );
}
