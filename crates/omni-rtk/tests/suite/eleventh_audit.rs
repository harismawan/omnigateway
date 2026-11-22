//! Audit regression suite: deep-subtree counts, exact grep context, long
//! git-status sections and budget fail-open.

use super::common::*;
use omni_rtk::command::{GrepMode, classify_command};
use omni_rtk::filters::diagnostics::compress_diagnostics;
use omni_rtk::filters::shared::scan_text;

#[test]
fn tree_selects_or_omits_complete_deep_subtrees_with_recursive_counts() {
    let mut lines = strs(&["project"]);
    for d in 0..42 {
        lines.push(format!("{} dir-{d}/", if d == 41 { "└──" } else { "├──" }));
        lines.push("│   └── nested/".to_owned());
        lines.push(format!("│       └── leaf-{d}.ts"));
    }
    lines.push("84 directories, 42 files".to_owned());
    let content = run("tree -F", &lines).content;
    assert!(content.contains("... 60 directories omitted containing 30 entries ..."));
    for d in 0..42 {
        if !content.contains(&format!("leaf-{d}.ts")) {
            continue;
        }
        assert!(content.contains(&format!("dir-{d}")));
        assert!(content.contains("nested"));
    }
}

#[test]
fn grep_preserves_exact_requested_before_and_after_context() {
    assert_eq!(
        classify_command("rg -n -C 10 pattern src").and_then(|c| c.grep_mode),
        Some(GrepMode {
            heading: false,
            line_number: true,
            before_context: 10.0,
            after_context: 10.0,
        })
    );
    let mut lines = strs(&["src/a.ts:50:first"]);
    for line in 51..=90 {
        lines.push(format!("src/a.ts-{line}-context-{line}"));
    }
    lines.push("src/a.ts:91:second".to_owned());
    for line in 92..=130 {
        lines.push(format!("src/a.ts-{line}-context-{line}"));
    }
    for m in 0..11 {
        lines.push(format!("src/a.ts:{}:extra-{m}", 200 + m));
    }
    let content = run("rg -n -C 10 pattern src", &lines).content;
    for line in (51..=60).chain(81..=90) {
        assert!(content.contains(&format!("context-{line}")), "{line}");
    }
}

#[test]
fn long_git_status_preserves_known_sections_and_middle_paths() {
    let f = run(
        "git status",
        &cat(&[
            strs(&[
                "On branch main",
                "Changes to be committed:",
                "  (use \"git restore --staged <file>...\" to unstage)",
                "\tnew file:   src/first.ts",
            ]),
            gen_lines(40, |i| format!("\tmodified:   src/middle-{i}.ts")),
            strs(&[
                "Changes not staged for commit:",
                "  (use \"git add <file>...\" to update what will be committed)",
                "\tdeleted:    src/deleted.ts",
                "Untracked files:",
                "  (use \"git add <file>...\" to include in what will be committed)",
                "\tnew-file.ts",
                "no changes added to commit (use \"git add\" and/or \"git commit -a\")",
            ]),
        ]),
    );
    assert!(has(&f.report, "git-status"));
    assert!(f.content.contains("\tmodified:   src/middle-20.ts"));
    assert!(f.content.contains("\tdeleted:    src/deleted.ts"));
    assert!(f.content.contains("\tnew-file.ts"));
}

#[test]
fn diagnostics_fail_open_when_selecting_a_later_error_exceeds_budget() {
    let text = [
        "lint start",
        "src/a.ts:1:1 error identical error",
        "src/a.ts:1:1 error identical error",
        "  detail one",
        "  detail two",
        "  detail three",
        "Found 2 errors.",
    ]
    .join("\n");
    let input = scan_text(&text).expect("bounded text");
    assert!(input.budget.charge_records(99_985));
    assert_eq!(compress_diagnostics(&input), text);
}
