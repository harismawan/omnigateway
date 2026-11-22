//! `packages/rtk/test/fourth-audit.test.ts`.

use super::common::*;
use omni_rtk::command::classify_command;

fn labelled(label: &str) -> Vec<String> {
    gen_lines(80, |i| format!("{label} {i}"))
}

#[test]
fn preserves_subtype_summaries_from_the_middle() {
    let cases: Vec<(&str, Vec<&str>)> = vec![
        (
            "bun test",
            vec!["2 skip", "1 todo", "Ran 10 tests across 3 files"],
        ),
        (
            "vitest run",
            vec![
                "Test Files 1 skipped | 2 passed",
                "Tests 2 todo | 3 skipped | 8 passed",
                "Snapshots 1 updated",
                "Projects 2",
                "Shard 1/2",
                "Attachments 3",
                "Retries 1",
            ],
        ),
        (
            "jest",
            vec![
                "Test Suites: 1 skipped, 2 passed",
                "Tests: 2 todo, 3 skipped, 8 passed",
                "Snapshots: 1 updated",
            ],
        ),
        (
            "pytest",
            vec!["8 passed, 3 skipped, 2 xfailed, 1 xpassed in 1.2s"],
        ),
        (
            "go test ./...",
            vec!["--- SKIP: TestOptional (0.00s)", "ok example/pkg 1.2s"],
        ),
    ];
    for (command, summaries) in cases {
        let f = run(
            command,
            &cat(&[
                strs(&["runner start"]),
                labelled("before"),
                strs(&summaries),
                labelled("after"),
                strs(&[
                    if command == "go test ./..." {
                        "    --- FAIL: TestNamed (0.00s)"
                    } else {
                        "FAIL named failure"
                    },
                    "  at test/file.ts:2:3",
                ]),
            ]),
        );
        assert!(has(&f.report, "test-output"), "{command}");
        for s in summaries {
            assert!(f.content.contains(s), "{command}: {s}");
        }
    }
}

#[test]
fn preserves_manager_diagnostics() {
    let cases: Vec<(&str, Vec<&str>)> = vec![
        (
            "npm install",
            vec![
                "npm warn ERESOLVE overriding peer dependency",
                "npm warn While resolving: app@1",
                "npm error code ERESOLVE",
                "npm error unable to resolve dependency tree",
            ],
        ),
        (
            "pnpm install",
            vec![
                "WARN deprecated package@1",
                "ERR_PNPM_PEER_DEP_ISSUES unmet peer",
            ],
        ),
        (
            "yarn install",
            vec![
                "YN0060: peer dependency warning",
                "YN0009: package failed to build",
            ],
        ),
        (
            "cargo fetch",
            vec![
                "warning: spurious network error",
                "error: failed to get crate",
            ],
        ),
        (
            "pip install app",
            vec![
                "WARNING: dependency conflict",
                "ERROR: Could not build wheels",
            ],
        ),
        (
            "uv sync",
            vec!["warning: resolution conflict", "error: Failed to build app"],
        ),
    ];
    for (command, diagnostics) in cases {
        let f = run(
            command,
            &cat(&[
                strs(&["manager start"]),
                labelled("download"),
                strs(&diagnostics),
                strs(&["installed 1 package"]),
            ]),
        );
        assert!(has(&f.report, "package-output"), "{command}");
        for line in diagnostics {
            assert!(f.content.contains(line), "{command}: {line}");
        }
    }
}

#[test]
fn package_parser_rejects_unassignable_diagnostic_looking_rows() {
    let f = run(
        "npm install",
        &cat(&[
            strs(&["npm start"]),
            labelled("download"),
            strs(&["DIAGNOSTIC maybe bad", "installed 1 package"]),
        ]),
    );
    assert!(f.unchanged);
}

#[test]
fn git_pull_parser_preserves_diffstat_refs_divergence_and_final_status() {
    let anchors = strs(&[
        "From github.com:acme/app",
        "abc123..def456 main -> origin/main",
        " src/a.ts | 10 +++++-----",
        " 1 file changed, 5 insertions(+), 5 deletions(-)",
        "Your branch and 'origin/main' have diverged",
        "CONFLICT (content): Merge conflict in src/a.ts",
        "Automatic merge failed; fix conflicts and then commit the result.",
    ]);
    let f = run(
        "git pull",
        &cat(&[
            anchors[..1].to_vec(),
            labelled("remote progress"),
            anchors[1..].to_vec(),
        ]),
    );
    assert!(has(&f.report, "git-operation"));
    for a in &anchors {
        assert!(f.content.contains(a.as_str()), "{a}");
    }
    let unknown = run(
        "git fetch",
        &cat(&[
            strs(&["From origin"]),
            labelled("Counting objects"),
            strs(&["mystery non-progress row"]),
        ]),
    );
    assert!(unknown.unchanged);
}

#[test]
fn warning_identity_ignores_differing_source_frames_for_the_same_tuple() {
    let f = run(
        "tsc --noEmit",
        &cat(&[
            strs(&["Version 7"]),
            labelled("compile"),
            strs(&[
                "src/a.ts(1,2): warning TS1000: duplicate",
                "  const a = 1",
                "  ^ first",
                "src/a.ts(1,2): warning TS1000: duplicate",
                "  const a = 2",
                "  ^ second",
                "Found 0 errors and 2 warnings.",
            ]),
        ]),
    );
    assert!(f.content.contains("const a = 1"));
    assert!(!f.content.contains("const a = 2"));
    assert!(!f.content.contains("warnings omitted"));
}

#[test]
fn execution_wrappers_accept_only_their_own_nonrepeated_options() {
    for command in [
        "bun x -y eslint",
        "bunx --yes eslint",
        "npx --bun eslint",
        "npx -y --yes eslint",
        "bun x --bun --bun eslint",
        "bunx -- --",
        "npx -y",
        "bun x '' biome",
    ] {
        assert!(classify_command(command).is_none(), "{command}");
    }
    let family = |c: &str| classify_command(c).map(|c| c.family.as_str());
    assert_eq!(family("bun x --bun biome check ."), Some("lint-output"));
    assert_eq!(family("bunx -- eslint src"), Some("lint-output"));
    assert_eq!(family("npx -y eslint src"), Some("lint-output"));
}
