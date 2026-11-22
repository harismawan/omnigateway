//! Audit regression suite: command-text safety gates and complete-block
//! retention across the docker/lint/test/build parsers.

use super::common::*;
use omni_rtk::command::classify_command;

#[test]
fn rejects_line_breaks_backticks_and_substitutions_in_command_text() {
    for command in [
        "bun test\necho hidden",
        "bun test\r\necho hidden",
        "bun `echo test`",
        "bun $(echo test)",
        "bun \"$(echo test)\"",
        "bun <(echo test)",
    ] {
        assert!(classify_command(command).is_none(), "{command}");
    }
}

#[test]
fn confirmed_malformed_or_structured_commands_never_fall_through_to_output_inference() {
    let fixture = cat(&[
        strs(&["bun test v1.4.0"]),
        noise(300),
        strs(&["FAIL middle", "1 fail", "Ran 1 test across 1 file"]),
    ]);
    for command in ["bun test --json", "bun test | cat", "bun test\necho hidden"] {
        let f = run(command, &fixture);
        assert!(f.unchanged, "{command}");
        assert!(f.report.filters.is_empty());
    }
}

#[test]
fn docker_parser_preserves_independently_placed_identity_and_diagnostic_blocks() {
    let lines = cat(&[
        strs(&["#1 [internal] load build definition from Dockerfile"]),
        vec!["#1 1.0 50% transferring".to_owned(); 80],
        strs(&[
            "#7 [builder 3/5] RUN bun build src/index.ts",
            "#7 1.2 Dockerfile:14",
            "#7 1.2 ERROR: process failed",
            "#7 1.2   caused by missing input",
        ]),
        vec!["#7 2.0 75% transferring".to_owned(); 80],
        strs(&[
            "#9 exporting manifest sha256:manifest",
            "#9 exporting provenance sha256:provenance",
            "#9 naming to docker.io/acme/app:latest",
            "#9 DONE image id sha256:image",
        ]),
    ]);
    let f = run("docker buildx build .", &lines);
    assert!(has(&f.report, "docker-build"));
    for anchor in lines.iter().filter(|l| {
        [
            "builder",
            "Dockerfile",
            "ERROR",
            "caused",
            "manifest",
            "provenance",
            "naming",
            "image id",
        ]
        .iter()
        .any(|k| l.contains(k))
    }) {
        assert!(f.content.contains(anchor.as_str()), "{anchor}");
    }
}

#[test]
fn lint_parser_retains_complete_unique_errors_and_warning_blocks_with_exact_count() {
    let errors = strs(&[
        "src/a.ts(1,2): error TS1001: first",
        "  source one",
        "  ^ caret one",
        "src/b.ts(2,3): error TS1002: second",
        "  source two",
        "  ^ caret two",
    ]);
    let warnings: Vec<String> = (0..25)
        .flat_map(|i| {
            [
                format!("src/w{i}.ts({},1): warning TS2000: warning {i}", i + 1),
                format!("  warning detail {i}"),
            ]
        })
        .collect();
    let f = run(
        "tsc --noEmit",
        &cat(&[
            strs(&["Version 7"]),
            noise(80),
            errors.clone(),
            noise(80),
            warnings,
            strs(&["Found 2 errors and 25 warnings."]),
        ]),
    );
    for line in &errors {
        assert!(f.content.contains(line.as_str()));
    }
    for i in 0..20 {
        assert!(f.content.contains(&format!("warning detail {i}")));
    }
    assert!(f.content.contains("... 5 warnings omitted ..."));
    assert!(f.content.contains("Found 2 errors and 25 warnings."));
}

#[test]
fn test_parser_retains_complete_failures_independently_placed_in_the_middle() {
    let failures = strs(&[
        "FAIL test/first.test.ts > first behavior",
        "AssertionError: expected 1 to be 2",
        "  Expected: 2",
        "  Received: 1",
        "  at test/first.test.ts:10:3",
        "FAIL test/second.test.ts > second behavior",
        "Error: second failure",
        "  at test/second.test.ts:20:4",
    ]);
    let f = run(
        "bun test",
        &cat(&[
            strs(&["bun test v1.4.0"]),
            noise(80),
            failures.clone(),
            noise(80),
            strs(&["0 pass", "2 fail", "Ran 2 tests across 2 files"]),
        ]),
    );
    for line in &failures {
        assert!(f.content.contains(line.as_str()));
    }
    assert!(f.content.contains("Ran 2 tests across 2 files"));
}

#[test]
fn build_parser_retains_complete_diagnostics_artifacts_and_final_summary() {
    let anchors = strs(&[
        "dist/index.js 42 KB",
        "src/index.ts:4:2 error TS2322: mismatch",
        "  source frame",
        "  ^ caret",
        "warning: sourcemap omitted",
        "Build failed with 1 error and 1 warning",
    ]);
    let f = run(
        "bun build src/index.ts",
        &cat(&[
            strs(&["bun build v1.4.0"]),
            noise(80),
            anchors.clone(),
            noise(80),
        ]),
    );
    for line in &anchors {
        assert!(f.content.contains(line.as_str()));
    }
}

#[test]
fn ambiguous_long_listing_and_row_bound_overflow_retain_original_identity() {
    let ambiguous = run(
        "ls -la",
        &cat(&[
            strs(&["total 100"]),
            noise(300),
            strs(&["locale row cannot parse"]),
        ]),
    );
    assert!(ambiguous.unchanged);
    let huge = run("docker build .", &vec!["#1 1.0 downloading"; 100_001]);
    assert!(huge.unchanged);
}
