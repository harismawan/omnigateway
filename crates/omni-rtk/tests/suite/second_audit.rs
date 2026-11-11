//! `packages/rtk/test/second-audit.test.ts`.

use super::common::*;
use omni_rtk::command::classify_command;

#[test]
fn git_status_preserves_porcelain_states_paths_pairs_and_operation_markers() {
    let records = strs(&[
        "## HEAD (no branch)",
        "rebase in progress; onto abc1234",
        " M path with spaces.ts",
        "?? untracked file.ts",
        "UU conflicted.ts",
        "R  old name.ts -> new name.ts",
        "C  source.ts -> copy.ts",
    ]);
    let chatter = vec!["  (use git add to update what will be committed)".to_owned(); 100];
    let f = run(
        "git status --short --branch",
        &cat(&[
            records[..1].to_vec(),
            chatter.clone(),
            records[1..].to_vec(),
        ]),
    );
    assert!(has(&f.report, "git-status"));
    for r in &records {
        assert!(f.content.contains(r.as_str()));
    }
    let unknown = run(
        "git status --short",
        &cat(&[strs(&["## main"]), chatter, strs(&["ZZ impossible.ts"])]),
    );
    assert!(unknown.unchanged);
}

#[test]
fn tree_accepts_only_root_hierarchy_and_supported_summary() {
    let children = gen_lines(40, |i| format!("│   ├── descriptive-file-name-{i}.ts"));
    let valid = cat(&[
        strs(&["project", "├── src/"]),
        children,
        strs(&["└── test/", "2 directories, 40 files"]),
    ]);
    let f = run("tree -F", &valid);
    assert!(has(&f.report, "tree-output"));
    for line in [&valid[0], &valid[1], &valid[valid.len() - 1]] {
        assert!(f.content.contains(line.as_str()));
    }
    assert!(
        f.content
            .contains("... 28 entries omitted from project/src ...")
    );
    let prose = run(
        "tree",
        &cat(&[
            strs(&["project", "This prose was previously accepted"]),
            noise(100),
            strs(&["1 directory, 0 files"]),
        ]),
    );
    assert!(prose.unchanged);
    let malformed = run(
        "tree",
        &["project", "│   └── orphan.ts", "0 directories, 1 file"],
    );
    assert!(malformed.unchanged);
}

#[test]
fn unknown_origin_path_lists_use_exact_grouped_omission_units() {
    let paths = gen_lines(50, |i| format!("./src/file-{i}.ts"));
    let f = run_named("ignored", &paths, "mystery");
    assert!(has(&f.report, "path-list"));
    assert!(f.content.contains("... 38 entries omitted from ./src ..."));
    assert!(!f.content.contains("lines omitted"));
}

#[test]
fn unknown_build_and_test_inference_requires_distinct_subtype_rows() {
    let weak = run_named(
        "ignored",
        &cat(&[strs(&["bun test v1.4.0 1 pass"]), noise(100)]),
        "mystery",
    );
    assert!(weak.unchanged);
    let cases = gen_lines(120, |i| {
        format!("descriptive test case {i} completed successfully")
    });
    let strong = run_named(
        "ignored",
        &cat(&[
            strs(&["bun test v1.4.0"]),
            cases,
            strs(&["1 pass", "Ran 1 test across 1 file"]),
        ]),
        "mystery",
    );
    assert!(has(&strong.report, "test-output"));
    let install = run_named(
        "ignored",
        &cat(&[
            strs(&["bun install v1.4.0"]),
            noise(100),
            strs(&["installed 20 packages", "Saved lockfile"]),
        ]),
        "mystery",
    );
    assert!(!has(&install.report, "build-output"));
}

#[test]
fn warning_identity_deduplicates_complete_blocks_before_capping() {
    let duplicate = strs(&[
        "src/a.ts(1,1): warning TS1000: duplicate",
        "  duplicate detail",
    ]);
    let unique: Vec<String> = (0..21)
        .flat_map(|i| {
            [
                format!(
                    "src/u{i}.ts({},1): warning TS{}: unique {i}",
                    i + 1,
                    2000 + i
                ),
                format!("  unique detail {i}"),
            ]
        })
        .collect();
    let f = run(
        "tsc --noEmit",
        &cat(&[
            strs(&["Version 7"]),
            noise(100),
            duplicate.clone(),
            duplicate,
            unique,
            strs(&["Found 0 errors and 23 warnings."]),
        ]),
    );
    assert_eq!(count_occurrences(&f.content, "duplicate detail"), 1);
    assert!(f.content.contains("... 2 warnings omitted ..."));
}

#[test]
fn rejects_separated_and_equals_structured_reporter_options() {
    for command in [
        "eslint --format json src",
        "eslint --format=json src",
        "biome check --reporter json .",
        "biome check --reporter=json .",
        "ruff check --output-format json .",
        "ruff check --output-format=json .",
        "eslint --format sarif src",
        "biome check --reporter custom .",
    ] {
        assert!(classify_command(command).is_none(), "{command}");
    }
}

#[test]
fn ls_preserves_one_total_header_and_rejects_duplicate_or_misplaced_headers() {
    let rows = gen_lines(20, |i| {
        format!("-rw-r--r-- 1 u g 10 Aug 10 12:00 file-{i}.ts")
    });
    let valid = run("ls -la", &cat(&[strs(&["total 200"]), rows.clone()]));
    assert!(valid.content.starts_with("total 200\n"));
    assert!(valid.content.contains("... 8 entries omitted from . ..."));
    for lines in [
        cat(&[strs(&["total 200"]), rows.clone(), strs(&["total 100"])]),
        cat(&[rows.clone(), strs(&["total 200"])]),
    ] {
        assert!(run("ls -la", &lines).unchanged);
    }
}
