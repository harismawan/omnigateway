//! Regression suite: package and git-operation compression. Here the tool
//! input is the bare command string, not `{ command }`.

use super::common::*;
use serde_json::json;

fn filter(command: &str, anchors: &[&str]) -> Fixture {
    let lines = cat(&[
        strs(&anchors[..1]),
        gen_lines(120, |i| format!("progress {i}")),
        strs(&anchors[1..]),
    ]);
    transform(tool_request("x", "bash", json!(command), &join(&lines)), 1)
}

#[test]
fn compresses_package_output_while_preserving_mutations_and_summary() {
    for command in [
        "bun install",
        "npm update",
        "pnpm install",
        "yarn up foo",
        "cargo fetch",
        "pip install foo",
        "uv sync",
    ] {
        let manager = command.split(' ').next().unwrap_or_default();
        let warning = match manager {
            "npm" => "npm warn peer conflict",
            "pnpm" => "WARN peer conflict",
            "yarn" => "YN0060: peer conflict",
            "pip" => "WARNING: peer conflict",
            _ => "warning: peer conflict",
        };
        let anchors = [
            "added package@1.2.3",
            warning,
            "Saved lockfile",
            "installed 1 package",
        ];
        let f = filter(command, &anchors);
        assert!(has(&f.report, "package-output"), "{command}");
        for a in anchors {
            assert!(f.content.contains(a), "{command}: {a}");
        }
    }
}

#[test]
fn leaves_unsupported_inventory_unchanged() {
    for command in ["pip list", "bun pm ls", "npm view foo"] {
        let f = filter(command, &["Package Version", "foo 1.0", "2 packages"]);
        assert!(!has(&f.report, "package-output"), "{command}");
    }
}

#[test]
fn retains_at_most_20_warnings_with_an_exact_omitted_count() {
    let warnings = gen_lines(25, |i| format!("warning: package conflict {}", i + 1));
    let mut anchors = vec!["Resolving packages"];
    anchors.extend(warnings.iter().map(String::as_str));
    anchors.push("installed 1 package");
    let f = filter("bun install", &anchors);
    assert!(f.content.contains("... 5 warnings omitted ..."));
    assert!(!f.content.contains("warning: package conflict 25"));
}

#[test]
fn compresses_git_operations_and_preserves_refs_and_failures() {
    for command in [
        "git branch",
        "git switch feat/x",
        "git checkout main",
        "git push",
        "git pull",
        "git fetch",
    ] {
        let anchors = [
            "* feat/x",
            "! [rejected] main -> main (non-fast-forward)",
            "error: failed to push some refs",
            "Everything up-to-date",
        ];
        let f = filter(command, &anchors);
        assert!(has(&f.report, "git-operation"), "{command}");
        for a in anchors {
            assert!(f.content.contains(a), "{command}: {a}");
        }
    }
}

#[test]
fn keeps_git_status_rename_and_operation_markers() {
    let lines = cat(&[
        strs(&[
            "## feat/x",
            "rebase in progress; onto abc1234",
            "R  old.ts -> new.ts",
        ]),
        vec!["  (use git add to update what will be committed)".to_owned(); 80],
    ]);
    let f = transform(
        tool_request(
            "status",
            "bash",
            json!("git status --short --branch"),
            &join(&lines),
        ),
        1,
    );
    assert!(has(&f.report, "git-status"));
    assert!(f.content.contains("R  old.ts -> new.ts"));
}
