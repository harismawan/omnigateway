//! `packages/rtk/test/third-audit.test.ts`.

use super::common::*;
use omni_rtk::command::classify_command;

#[test]
fn global_row_bound_protects_generic_filtering() {
    assert!(run("echo x", &vec!["x"; 100_001]).unchanged);
}

#[test]
fn tree_groups_entries_by_their_resolved_sibling_parent() {
    let f = run(
        "tree -F",
        &cat(&[
            strs(&["project", "├── src/"]),
            gen_lines(20, |i| format!("│   ├── src-{i}.ts")),
            strs(&["└── test/"]),
            gen_lines(20, |i| format!("    ├── test-{i}.ts")),
            strs(&["2 directories, 40 files"]),
        ]),
    );
    assert!(has(&f.report, "tree-output"));
    assert!(
        f.content
            .contains("... 8 entries omitted from project/src ...")
    );
    assert!(
        f.content
            .contains("... 8 entries omitted from project/test ...")
    );
    for anchor in ["src-0.ts", "src-19.ts", "test-0.ts", "test-19.ts"] {
        assert!(f.content.contains(anchor));
    }
}

#[test]
fn package_warning_duplicates_count_once_and_emit_no_omission_marker() {
    let warning = strs(&[
        "warning: peer conflict package-a@1",
        "  required by package-b@2",
    ]);
    let f = run(
        "bun install",
        &cat(&[
            strs(&["bun install v1.4.0"]),
            (0..25).flat_map(|_| warning.clone()).collect(),
            gen_lines(100, |i| format!("Resolving package {i}")),
            strs(&["installed 1 package"]),
        ]),
    );
    assert!(has(&f.report, "package-output"));
    assert_eq!(count_occurrences(&f.content, "required by package-b"), 1);
    assert!(!f.content.contains("warnings omitted"));
}

#[test]
fn piped_numbered_commands_remain_wholly_ineligible() {
    let f = run(
        "sed -n '1,300p' file.ts | cat",
        &gen_lines(300, |i| format!("{} | source line", i + 1)),
    );
    assert!(f.unchanged);
    assert!(f.report.filters.is_empty());
}

#[test]
fn empty_quoted_wrapper_executables_are_rejected() {
    for command in ["npx '' eslint src", "bun x '' biome check .", "bun run ''"] {
        assert!(classify_command(command).is_none(), "{command}");
    }
}
