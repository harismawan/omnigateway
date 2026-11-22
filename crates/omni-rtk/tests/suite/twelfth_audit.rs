//! Audit regression suite: tree budget aborts, fail-open ambiguity and long
//! git-status relation retention.

use super::common::*;
use omni_rtk::command::classify_command;
use omni_rtk::filters::listings::compress_listing;
use omni_rtk::filters::shared::scan_text;

fn broad_tree(classified: bool) -> Vec<String> {
    let suffix = if classified { "/" } else { "" };
    let mut lines = strs(&["project"]);
    for d in 0..42 {
        lines.push(format!(
            "{} dir-{d}{suffix}",
            if d == 41 { "└──" } else { "├──" }
        ));
        lines.push(format!("│   └── file-{d}.ts"));
    }
    lines.push("42 directories, 42 files".to_owned());
    lines
}

#[test]
fn tree_aborts_before_near_limit_node_and_allocation_budgets_overflow() {
    let text = join(&broad_tree(true));
    let input = scan_text(&text).expect("bounded text");
    assert!(input.budget.charge_records(99_850));
    assert_eq!(
        compress_listing(&input, "tree", Some("classified"), false),
        text
    );
}

#[test]
fn plain_ambiguous_omitted_leaves_fail_open_while_classified_tree_counts_exactly() {
    let mut plain = broad_tree(false);
    plain.insert(43, "│   ├── empty-middle".to_owned());
    assert!(run("tree", &plain).unchanged);

    assert_eq!(
        classify_command("tree -F").and_then(|c| c.subcommand),
        Some("classified".to_owned())
    );
    assert_eq!(
        classify_command("tree --classify").and_then(|c| c.subcommand),
        Some("classified".to_owned())
    );
    let classified = run("tree -F", &broad_tree(true));
    assert!(has(&classified.report, "tree-output"));
    assert!(
        classified
            .content
            .contains("... 30 directories omitted containing 30 entries ...")
    );
}

#[test]
fn long_git_status_preserves_relation_operation_conflicts_and_state_records() {
    let relations = strs(&[
        "Your branch is ahead of 'origin/main' by 2 commits.",
        "Your branch is behind 'origin/main' by 3 commits, and can be fast-forwarded.",
        "Your branch and 'origin/main' have diverged,",
        "and have 2 and 3 different commits each, respectively.",
    ]);
    let f = run(
        "git status",
        &cat(&[
            strs(&["HEAD detached at abc1234"]),
            relations.clone(),
            strs(&[
                "You are currently rebasing branch 'main' on 'abc1234'.",
                "All conflicts fixed but you are still merging.",
                "Unmerged paths:",
                "  (use \"git add <file>...\" to mark resolution)",
                "\tboth modified:   src/conflict.ts",
                "Changes to be committed:",
                "\trenamed:    src/old.ts -> src/new.ts",
                "\tcopied:     src/source.ts -> src/copy.ts",
            ]),
            gen_lines(35, |i| format!("\tmodified:   src/file-{i}.ts")),
            strs(&["no changes added to commit (use \"git add\" and/or \"git commit -a\")"]),
        ]),
    );
    assert!(has(&f.report, "git-status"));
    for line in relations.iter().map(String::as_str).chain([
        "You are currently rebasing branch 'main' on 'abc1234'.",
        "All conflicts fixed but you are still merging.",
        "\tboth modified:   src/conflict.ts",
        "\trenamed:    src/old.ts -> src/new.ts",
        "\tcopied:     src/source.ts -> src/copy.ts",
        "\tmodified:   src/file-20.ts",
    ]) {
        assert!(f.content.contains(line), "{line}");
    }
}
