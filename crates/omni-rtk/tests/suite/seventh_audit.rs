//! Audit regression suite: grep context modes, recursive-ls grouping and the
//! shared parser budget.

use super::common::*;
use omni_rtk::command::{GrepMode, classify_command};

#[test]
fn classifies_grep_modes_and_compresses_short_windows_context_output() {
    let c = classify_command("rg -n -C 2 pattern src").expect("classified");
    assert_eq!(c.family.as_str(), "grep");
    assert_eq!(
        c.grep_mode,
        Some(GrepMode {
            heading: false,
            line_number: true,
            before_context: 2.0,
            after_context: 2.0,
        })
    );
    let lines = cat(&[
        strs(&[
            "C:\\repo\\src\\a.ts-8-before",
            "C:\\repo\\src\\a.ts:10:match one",
            "C:\\repo\\src\\a.ts-11-after",
            "--",
            "C:\\repo\\src\\a.ts:20:match two",
        ]),
        gen_lines(30, |i| {
            format!("C:\\repo\\src\\a.ts-{}-long-context", 21 + i)
        }),
    ]);
    let f = run("rg -n -C 2 pattern src", &lines);
    assert!(has(&f.report, "grep"));
    for a in [&lines[0], &lines[1], &lines[4]] {
        assert!(f.content.contains(a.as_str()));
    }
}

#[test]
fn supports_heading_grep_and_rejects_unsupported_grep_forms() {
    let heading = run(
        "rg --heading -n pattern src",
        &cat(&[
            strs(&["src/a.ts", "10:match"]),
            gen_lines(40, |i| {
                format!("{}:other descriptive matched content", i + 11)
            }),
        ]),
    );
    assert!(has(&heading.report, "grep"));
    assert!(heading.content.contains("src/a.ts"));
    for command in [
        "rg --json pattern",
        "rg --files",
        "grep -P pattern file",
        "rg pattern | cat",
        "rg --replace x pattern",
    ] {
        assert!(classify_command(command).is_none(), "{command}");
    }
}

#[test]
fn parses_recursive_ls_groups_with_exact_omitted_directories_and_entries() {
    let mut lines = Vec::new();
    for group in 0..42 {
        lines.push(format!("./dir-{group}:"));
        lines.push(format!("total {}", group + 1));
        let count = match group {
            20 => 3,
            21 => 7,
            _ => 1,
        };
        for entry in 0..count {
            lines.push(format!(
                "-rw-r--r-- 1 u g 10 Aug 10 12:00 file-{group}-{entry}.ts"
            ));
        }
        lines.push(String::new());
    }
    let f = run("ls -lR .", &lines);
    assert!(has(&f.report, "tree-output"));
    assert!(
        f.content
            .contains("... 2 directories omitted containing 10 entries ...")
    );
    assert!(f.content.contains("./dir-0:"));
    assert!(f.content.contains("./dir-41:"));
}

#[test]
fn recursive_ls_malformed_groups_retain_original_identity() {
    for lines in [
        strs(&["total 1", "-rw-r--r-- 1 u g 10 Aug 10 12:00 orphan"]),
        strs(&["./a:", "total 1", "unassignable row"]),
        strs(&["./a:", "./b:", "total 1"]),
    ] {
        let f = run("ls -lR .", &cat(&[lines, vec![String::new(); 40]]));
        assert!(f.unchanged);
    }
}

#[test]
fn near_limit_listing_status_git_and_package_records_share_one_budget() {
    let cases: Vec<(&str, Vec<String>)> = vec![
        ("find .", gen_lines(60_000, |i| format!("./g{i}/file.ts"))),
        (
            "git status --short --branch",
            cat(&[
                strs(&["## main"]),
                gen_lines(60_000, |i| format!(" M file-{i}.ts")),
            ]),
        ),
        (
            "git fetch",
            cat(&[
                strs(&["From origin"]),
                gen_lines(60_000, |i| {
                    format!("abc{i}..def{i} branch{i} -> origin/branch{i}")
                }),
            ]),
        ),
        (
            "npm install",
            cat(&[
                gen_lines(60_000, |i| format!("npm warn W{i} warning {i}")),
                strs(&["installed 1 package"]),
            ]),
        ),
    ];
    for (command, lines) in cases {
        assert!(run(command, &lines).unchanged, "{command}");
    }
}

#[test]
fn legacy_filters_reject_aggregate_budget_overflow() {
    let numbered = run(
        "nl file",
        &gen_lines(60_000, |i| format!("{} | line", i + 1)),
    );
    assert!(numbered.unchanged);
    let log = run("echo x", &gen_lines(60_000, |i| format!("line {i}")));
    assert!(log.unchanged);
}
