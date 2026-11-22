//! Audit regression suite: failure-block retention across test/build/docker
//! parsers and the aggregate budget.

use super::common::*;

#[test]
fn bun_preserves_unhandled_hook_failure_causes_and_stacks() {
    let anchors = strs(&[
        "UnhandledPromiseRejection: hook failed",
        "Caused by: Error: database unavailable",
        "    at beforeAll (test/setup.ts:12:3)",
        "error: 1 unhandled rejection",
        "1 fail",
        "Ran 1 test across 1 file",
    ]);
    let f = run(
        "bun test",
        &cat(&[
            strs(&["bun test v1.4.0"]),
            noise(100),
            anchors.clone(),
            noise(100),
        ]),
    );
    for a in &anchors {
        assert!(f.content.contains(a.as_str()), "{a}");
    }
}

#[test]
fn go_preserves_package_build_failures_and_compiler_diagnostics() {
    let anchors = strs(&[
        "# example/pkg",
        "pkg/file.go:10:2: undefined: missing",
        "FAIL example/pkg [build failed]",
    ]);
    let f = run(
        "go test ./...",
        &cat(&[strs(&["go test"]), noise(100), anchors.clone(), noise(100)]),
    );
    for a in &anchors {
        assert!(f.content.contains(a.as_str()), "{a}");
    }
}

#[test]
fn nonzero_summary_without_a_complete_failure_block_retains_original() {
    for (command, summary) in [
        ("bun test", "1 fail"),
        ("vitest run", "Tests 1 failed"),
        ("jest", "Tests: 1 failed"),
        ("pytest", "1 failed in 1s"),
        ("go test ./...", "FAIL example/pkg 1s"),
    ] {
        let f = run(
            command,
            &cat(&[strs(&["runner"]), noise(100), strs(&[summary])]),
        );
        assert!(f.unchanged, "{command}");
    }
}

#[test]
fn docker_rejects_unknown_rows_and_preserves_semantic_identities() {
    let unknown = run(
        "docker build .",
        &cat(&[
            strs(&["#1 [1/2] FROM alpine"]),
            noise(100),
            strs(&["CUSTOM artifact maybe", "#2 DONE"]),
        ]),
    );
    assert!(unknown.unchanged);
    let semantic = run(
        "docker build .",
        &cat(&[
            strs(&["#1 [1/2] FROM alpine@sha256:base"]),
            vec!["#1 1.0 50% transferring".to_owned(); 100],
            strs(&[
                "#2 ERROR: process failed",
                "#2   command: bun build",
                "#2   caused by missing.ts",
                "#3 naming to app:latest",
                "#3 digest: sha256:final",
            ]),
        ]),
    );
    for a in [
        "FROM alpine@sha256:base",
        "ERROR: process failed",
        "command: bun build",
        "caused by missing.ts",
        "naming to app:latest",
        "digest: sha256:final",
    ] {
        assert!(semantic.content.contains(a), "{a}");
    }
}

#[test]
fn build_rejects_unknown_rows_and_preserves_counted_recognized_classes() {
    let unknown = run(
        "bun build src/a.ts",
        &cat(&[
            strs(&["bun build v1"]),
            noise(100),
            strs(&["CUSTOM compiler extension", "Build completed in 1s"]),
        ]),
    );
    assert!(unknown.unchanged);
    let cargo = run(
        "cargo build",
        &cat(&[
            strs(&["Compiling a v1", "Compiling b v1"]),
            vec!["Compiling repeated v1".to_owned(); 50],
            strs(&[
                "Running `rustc src/main.rs`",
                "target/debug/app",
                "Finished dev target in 1s",
            ]),
        ]),
    );
    for a in [
        "Compiling a v1",
        "Compiling b v1",
        "Running `rustc",
        "target/debug/app",
        "Finished dev target",
    ] {
        assert!(cargo.content.contains(a), "{a}");
    }
}

#[test]
fn specialized_parsers_do_not_report_generic_post_dedup_hits() {
    let f = run(
        "bun test",
        &cat(&[
            strs(&["bun test v1"]),
            noise(100),
            strs(&[
                "  FAIL case",
                "error: boom",
                "    at test/a.ts:1:1",
                "1 fail",
                "Ran 1 test across 1 file",
            ]),
        ]),
    );
    assert_eq!(filters(&f.report), vec!["test-output"]);
    assert_eq!(f.report.filter_hits, 1);
}

#[test]
fn aggregate_parser_budget_rejects_near_limit_diagnostic_records() {
    let diagnostics: Vec<String> = (0..40_000)
        .flat_map(|i| {
            [
                format!("src/f{i}.ts(1,1): warning TS1000: warning {i}"),
                "  detail".to_owned(),
            ]
        })
        .collect();
    let f = run(
        "tsc --noEmit",
        &cat(&[diagnostics, strs(&["Found 0 errors and 40000 warnings."])]),
    );
    assert!(f.unchanged);
}
