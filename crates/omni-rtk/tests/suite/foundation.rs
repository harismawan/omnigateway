//! `packages/rtk/test/foundation.test.ts`.

use super::common::*;
use omni_rtk::command::classify_command;
use omni_rtk::{RTK_FILTER_IDS, extract_command, is_rtk_filter_id, transform_request};
use serde_json::{Value, json};
use std::borrow::Cow;

fn request(name: &str, command: Value, content: &str) -> omni_ir::request::ChatRequest {
    tool_request("call", name, command, content)
}

fn long_rows(row: &str, count: usize) -> String {
    vec![row; count].join("\n")
}

#[test]
fn catalog_exports_all_approved_family_ids_and_validates_only_members() {
    assert_eq!(RTK_FILTER_IDS.len(), 15);
    for id in RTK_FILTER_IDS {
        assert!(is_rtk_filter_id(&json!(id.as_str())));
    }
    assert!(!is_rtk_filter_id(&json!("docker-run")));
    assert!(!is_rtk_filter_id(&json!(1)));
}

#[test]
fn recognizes_exact_commands_through_approved_wrappers() {
    let family = |c: &str| classify_command(c).map(|c| c.family.as_str());
    assert_eq!(
        family("cd 'some dir' && NODE_ENV=test timeout -s TERM 30s bun run test:unit"),
        Some("test-output")
    );
    assert_eq!(
        family("env -i CI=1 -- bunx --bun biome check ."),
        Some("lint-output")
    );
    assert_eq!(family("npx -y -- eslint src"), Some("lint-output"));
    assert!(classify_command("git different-command").is_none());
}

#[test]
fn fails_closed_for_shell_composition_malformed_input_and_bounds() {
    for command in [
        "git status | cat".to_owned(),
        "bun test && echo done".to_owned(),
        "docker build . > log".to_owned(),
        "bun run".to_owned(),
        "'unterminated".to_owned(),
        "x ".repeat(257),
        "x".repeat(16_385),
    ] {
        assert!(classify_command(&command).is_none(), "{command:.40}");
    }
}

#[test]
fn extracts_only_primitive_or_own_plain_object_command_fields_in_precedence_order() {
    assert_eq!(extract_command(&json!("git status")), Some("git status"));
    assert_eq!(
        extract_command(&json!({"command": "first", "cmd": "second"})),
        Some("first")
    );
    assert_eq!(
        extract_command(&json!({"command": 1, "cmd": "second"})),
        Some("second")
    );
    // TS: `Object.create({ command: "inherited" })` has no own keys. A JSON
    // value cannot carry a prototype, so the observable equivalent is an
    // object with no own command field.
    assert_eq!(extract_command(&json!({})), None);
    assert_eq!(extract_command(&json!(["git status"])), None);
}

#[test]
fn requires_multiple_anchors_for_unknown_git_output() {
    let weak = request(
        "mystery",
        json!({}),
        &format!("commit deadbeef\n{}", long_rows("prose about code", 100)),
    );
    assert!(matches!(
        transform_request(&weak, &ENABLED).request,
        Cow::Borrowed(_)
    ));
    let strong = request(
        "mystery",
        json!({}),
        &format!(
            "commit deadbeef\nAuthor: Dev <dev@example.test>\nDate: today\n\n    subject\n{}",
            long_rows("detail", 100)
        ),
    );
    assert!(has(&transform_request(&strong, &ENABLED).report, "git-log"));
}

#[test]
fn uses_exact_shell_aliases_and_expanded_non_shell_exclusions() {
    let content = long_rows("duplicate diagnostic", 600);
    let input = request("execute.sql", json!({"command": "echo x"}), &content);
    assert_eq!(
        transform_request(&input, &ENABLED).request.messages,
        request("execute.sql", json!({"command": "echo x"}), &content).messages
    );
    for name in [
        "read_file",
        "list_directory",
        "find_files",
        "code_search",
        "apply_patch",
    ] {
        let input = request(name, json!({"command": "echo x"}), &content);
        assert!(
            !transform_request(&input, &ENABLED).report.applied,
            "{name}"
        );
    }
}

#[test]
fn honors_exact_size_boundaries_and_copy_on_write_identity() {
    let below = request("bash", json!({"command": "echo x"}), &"x".repeat(499));
    assert!(matches!(
        transform_request(&below, &ENABLED).request,
        Cow::Borrowed(_)
    ));
    let over = request("bash", json!({"command": "echo x"}), &"x".repeat(1_000_001));
    assert!(matches!(
        transform_request(&over, &ENABLED).request,
        Cow::Borrowed(_)
    ));

    let mut input = request(
        "bash",
        json!({"command": "echo x"}),
        &long_rows("same", 600),
    );
    input.messages.push(
        serde_json::from_value(
            json!({"role": "user", "content": [{"type": "text", "text": "untouched"}]}),
        )
        .expect("message"),
    );
    let result = transform_request(&input, &ENABLED);
    // TS asserts object identity of the untouched messages and tool input; a
    // copied Rust request can only show they are unchanged in value.
    let Cow::Owned(output) = result.request else {
        panic!("expected a rewritten request");
    };
    assert_eq!(output.messages[0], input.messages[0]);
    assert_eq!(output.messages[2], input.messages[2]);
    assert_ne!(output.messages[1], input.messages[1]);
}
