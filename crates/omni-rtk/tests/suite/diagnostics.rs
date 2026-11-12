//! `packages/rtk/test/diagnostics.test.ts`.

use super::common::*;

fn run_diag(command: &str, rows: &[&str]) -> Fixture {
    let rows = strs(rows);
    let lines = cat(&[
        rows[..2.min(rows.len())].to_vec(),
        noise(100),
        rows[2.min(rows.len())..].to_vec(),
    ]);
    run(command, &lines)
}

#[test]
fn routes_lint_commands_to_lint_output() {
    let cases: [(&str, [&str; 3]); 6] = [
        (
            "tsc --noEmit",
            [
                "src/a.ts(2,3): error TS2322: bad",
                "  source",
                "Found 1 error.",
            ],
        ),
        (
            "biome check .",
            [
                "src/a.ts:2:3 lint/suspicious/noFoo ERROR",
                "  detail",
                "Checked 1 file in 1ms. Found 1 error.",
            ],
        ),
        (
            "eslint src",
            [
                "src/a.ts",
                "  2:3 error bad no-foo",
                "✖ 1 problem (1 error, 0 warnings)",
            ],
        ),
        (
            "ruff check .",
            ["src/a.py:2:3: F401 unused", "  detail", "Found 1 error."],
        ),
        (
            "cargo clippy",
            [
                "error[E0308]: mismatch",
                " --> src/a.rs:2:3",
                "error: could not compile",
            ],
        ),
        (
            "golangci-lint run",
            ["a.go:2:3: bad (govet)", "detail", "1 issues"],
        ),
    ];
    for (command, rows) in cases {
        let f = run_diag(command, &rows);
        assert!(has(&f.report, "lint-output"), "{command}");
        for row in rows {
            assert!(f.content.contains(row), "{command}: {row}");
        }
    }
}

#[test]
fn routes_test_commands_to_test_output() {
    for command in [
        "bun test",
        "bunx vitest",
        "npx jest",
        "pytest",
        "go test ./...",
    ] {
        let executable = if command.contains("vitest") {
            "vitest"
        } else if command.contains("jest") {
            "jest"
        } else if command.starts_with("pytest") {
            "pytest"
        } else if command.starts_with("go ") {
            "go"
        } else {
            "bun"
        };
        let failure = match executable {
            "vitest" => " FAIL  test/a.test.ts > named case",
            "jest" => "  ● named case",
            "pytest" => "  FAILED test_a.py::test_named",
            "go" => "    --- FAIL: TestNamed (0.00s)",
            _ => "  FAIL named case",
        };
        let f = run_diag(
            command,
            &[
                failure,
                "  at test/a.test.ts:2:3",
                "1 failed, 2 passed in 1s",
            ],
        );
        assert!(has(&f.report, "test-output"), "{command}");
    }
}

#[test]
fn routes_build_commands_to_build_output() {
    for command in ["bun build src/a.ts", "bun run build", "cargo build"] {
        let f = run_diag(
            command,
            &[
                "Bundled artifact dist/a.js 2KB",
                "warning: middle",
                "Build completed in 1s",
            ],
        );
        assert!(has(&f.report, "build-output"), "{command}");
    }
}

#[test]
fn does_not_command_gate_unknown_origin_lint_prose() {
    let f = run_diag(
        "echo prose",
        &[
            "src/a.ts(2,3): error TS2322: quoted prose",
            "text",
            "Found 1 error.",
        ],
    );
    assert!(!has(&f.report, "lint-output"));
}
