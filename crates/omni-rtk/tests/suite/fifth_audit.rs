//! Audit regression suite: whitespace-prefixed failure retention, directory
//! omission totals and warning/test identity.

use super::common::*;

#[test]
fn preserves_complete_whitespace_prefixed_failures() {
    let cases: Vec<(&str, Vec<&str>)> = vec![
        (
            "vitest run",
            vec![
                " FAIL  test/math.test.ts > adds",
                "AssertionError: expected 1 to be 2",
                "  Expected: 2",
                "  Received: 1",
                "  ❯ test/math.test.ts:10:3",
                "  Attachment: artifacts/failure.png",
                "  Trace: artifacts/trace.zip",
                "Test Files 1 failed",
                "Tests 1 failed",
            ],
        ),
        (
            "jest",
            vec![
                "  ● math > adds",
                "    expect(received).toBe(expected)",
                "    at test/math.test.ts:10:3",
                "Test Suites: 1 failed",
                "Tests: 1 failed",
            ],
        ),
        (
            "bun test",
            vec![
                "  FAIL math > adds",
                "error: expected 1",
                "    at test/math.test.ts:10:3",
                "1 fail",
                "Ran 1 test across 1 file",
            ],
        ),
        (
            "pytest",
            vec![
                "  FAILED test_math.py::test_adds - assert 1 == 2",
                "    test_math.py:10: AssertionError",
                "1 failed in 1.0s",
            ],
        ),
        (
            "go test ./...",
            vec![
                "    --- FAIL: TestAdds (0.00s)",
                "        math_test.go:10: expected 2",
                "FAIL example/math 1.0s",
            ],
        ),
    ];
    for (command, anchors) in cases {
        let f = run(
            command,
            &cat(&[
                strs(&["runner start"]),
                noise(100),
                strs(&anchors),
                noise(100),
            ]),
        );
        assert!(has(&f.report, "test-output"), "{command}");
        for a in anchors {
            assert!(f.content.contains(a), "{command}: {a}");
        }
    }
}

#[test]
fn directory_omission_reports_omitted_group_and_entry_totals() {
    let mut lines = strs(&["root"]);
    for group in 0..42 {
        lines.push(format!(
            "{} dir-{group}/",
            if group == 41 {
                "└──"
            } else {
                "├──"
            }
        ));
        let count = match group {
            20 => 3,
            21 => 7,
            _ => 1,
        };
        for entry in 0..count {
            lines.push(format!(
                "{}├── file-{group}-{entry}.ts",
                if group == 41 { "    " } else { "│   " }
            ));
        }
    }
    lines.push("42 directories, 50 files".to_owned());
    let f = run("tree -F", &lines);
    assert!(
        f.content
            .contains("... 30 directories omitted containing 38 entries ...")
    );
}

#[test]
fn unsupported_repeated_test_output_remains_original_identity() {
    let f = run(
        "bun test",
        &cat(&[
            strs(&["custom reporter v1"]),
            vec!["same unsupported row".to_owned(); 300],
            strs(&["custom end"]),
        ]),
    );
    assert!(f.unchanged);
    assert!(f.report.filters.is_empty());
}

#[test]
fn package_warning_identity_ignores_transient_counters_and_workspace_decorations() {
    let f = run(
        "npm install",
        &cat(&[
            strs(&["npm install"]),
            noise(100),
            strs(&[
                "npm warn [1/25] workspace app: ERESOLVE peer conflict package-a@1",
                "npm warn required by package-b@2",
                "npm warn [25/25] workspace app: ERESOLVE peer conflict package-a@1",
                "npm warn required by package-b@2",
                "installed 1 package",
            ]),
        ]),
    );
    assert!(has(&f.report, "package-output"));
    assert_eq!(count_occurrences(&f.content, "ERESOLVE peer conflict"), 1);
    assert!(!f.content.contains("warnings omitted"));
    assert!(f.content.contains("[1/25]"));
}
