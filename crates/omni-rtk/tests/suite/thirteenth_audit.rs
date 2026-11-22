//! Audit regression suite: relative-path gates and near-budget fail-open for
//! listing and git-status parsers.

use super::common::*;
use omni_rtk::filters::listings::compress_listing;
use omni_rtk::filters::shared::scan_text;
use omni_rtk::filters::status::compress_git_status;

#[test]
fn command_gated_relative_paths_accept_files_and_reject_ambiguous_content() {
    let valid = cat(&[
        strs(&["README.md", "src/index.ts", "packages/rtk/src/index.ts"]),
        gen_lines(100, |i| {
            format!("descriptive-relative-file-{i}-{}.ts", "detail-".repeat(3))
        }),
    ]);
    assert!(has(&run("git ls-files", &valid).report, "path-list"));
    for invalid in [
        "Build failed because dependency missing",
        "src/index.ts:10:error",
        "NAME VALUE",
        r#"{"path":"src/index.ts"}"#,
        "```",
    ] {
        let lines = cat(&[strs(&[invalid]), valid.clone()]);
        assert!(run("git ls-files", &lines).unchanged, "{invalid}");
    }
}

#[test]
fn unknown_origin_relative_paths_require_density_and_conflict_gates() {
    let relative = gen_lines(30, |i| format!("src/descriptive-relative-file-{i}.ts"));
    assert!(has(
        &run_named("ignored", &relative, "mystery").report,
        "path-list"
    ));
    let conflicted = cat(&[
        relative[..20].to_vec(),
        vec!["This is prose".to_owned(); 10],
    ]);
    assert!(run_named("ignored", &conflicted, "mystery").unchanged);
}

#[test]
fn listing_parsers_fail_open_at_near_limit_allocation_budgets() {
    let cases: Vec<(&str, &str, String)> = vec![
        (
            "git",
            "ls-files",
            join(&gen_lines(100, |i| format!("dir-{i}/file.ts"))),
        ),
        (
            "git",
            "ls-files",
            join(&gen_lines(100, |i| format!("src/file-{i}.ts"))),
        ),
        (
            "ls",
            "recursive-plain",
            join(&gen_lines(50, |i| format!("./dir-{i}:\nfile.ts"))),
        ),
        (
            "ls",
            "recursive-long",
            join(&gen_lines(50, |i| {
                format!("./dir-{i}:\ntotal 1\n-rw-r--r-- 1 u g 1 Aug 10 12:00 file.ts")
            })),
        ),
    ];
    for (executable, subcommand, text) in cases {
        let input = scan_text(&text).expect("bounded text");
        assert!(input.budget.charge_records(99_700));
        assert_eq!(
            compress_listing(&input, executable, Some(subcommand), false),
            text
        );
    }
}

#[test]
fn git_status_fails_open_near_budget_for_long_and_porcelain_forms() {
    for text in [
        join(&cat(&[
            strs(&["On branch main", "Changes to be committed:"]),
            gen_lines(80, |i| format!("\tmodified:   src/file-{i}.ts")),
            strs(&["no changes added to commit (use \"git add\" and/or \"git commit -a\")"]),
        ])),
        join(&cat(&[
            strs(&["## main"]),
            gen_lines(80, |i| format!(" M src/file-{i}.ts")),
        ])),
    ] {
        let input = scan_text(&text).expect("bounded text");
        assert!(input.budget.charge_records(99_850));
        assert_eq!(compress_git_status(&input), text);
    }
}
