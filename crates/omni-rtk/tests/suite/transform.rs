//! `packages/rtk/test/transform.test.ts`.

use super::common::*;
use omni_ir::request::{ChatRequest, ContentBlock};
use omni_rtk::{RtkConfig, transform_request};
use serde_json::json;
use std::borrow::Cow;

fn repeated() -> String {
    (0..600)
        .map(|i| {
            if i < 300 {
                "same output".to_owned()
            } else {
                format!("line {i}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn request(name: &str, content: &str) -> ChatRequest {
    tool_request("call-1", name, json!({"command": "bun test"}), content)
}

fn set_command(request: &mut ChatRequest, command: &str) {
    if let Some(ContentBlock::ToolUse(use_)) = request.messages[0].content.get_mut(0) {
        use_.input = json!({ "command": command });
    }
}

fn borrowed(request: &ChatRequest) -> bool {
    matches!(
        transform_request(request, &ENABLED).request,
        Cow::Borrowed(_)
    )
}

#[test]
fn returns_the_original_request_when_disabled() {
    let input = request("bash", &repeated());
    let result = transform_request(&input, &RtkConfig { enabled: false });
    assert!(matches!(result.request, Cow::Borrowed(_)));
    assert!(!result.report.applied);
}

#[test]
fn immutably_compresses_confirmed_shell_output_and_reports_savings() {
    let mut lines = vec!["bun test v1.4.0".to_owned()];
    lines.extend(vec!["case passed".to_owned(); 300]);
    lines.extend(strs(&[
        "300 pass",
        "0 fail",
        "Ran 300 tests across 10 files",
    ]));
    let content = join(&lines);
    let input = request("bash", &content);
    let result = transform_request(&input, &ENABLED);
    assert!(matches!(result.request, Cow::Owned(_)));
    assert!(utf16_len(&result_content(&result.request, 1, 0)) < utf16_len(&content));
    assert_eq!(result_content(&input, 1, 0), content);
    assert!(result.report.applied);
    assert!(result.report.filter_hits > 0);
    assert!(result.report.estimated_tokens_saved > 0.0);
}

#[test]
fn excludes_known_non_shell_errors_and_cache_controlled_results() {
    for patch in [
        json!({}),
        json!({"isError": true}),
        json!({"cacheControl": {"type": "ephemeral"}}),
    ] {
        let mut value = serde_json::to_value(request("read", &repeated())).expect("value");
        let block = value["messages"][1]["content"][0]
            .as_object_mut()
            .expect("block");
        for (k, v) in patch.as_object().expect("patch") {
            block.insert(k.clone(), v.clone());
        }
        let input = req(value);
        assert!(borrowed(&input), "{patch}");
    }
}

#[test]
fn unknown_origin_permits_recognizable_grep_but_not_generic_logs() {
    let grep = join(&gen_lines(100, |i| {
        format!("src/file.ts:{}:matching text", i + 1)
    }));
    assert!(has(
        &transform_request(&request("mystery", &grep), &ENABLED).report,
        "grep"
    ));
    assert!(borrowed(&request("mystery", &repeated())));
}

#[test]
fn nearest_preceding_duplicate_tool_id_determines_provenance() {
    let mut input = request("bash", &repeated());
    input.messages.insert(
        1,
        serde_json::from_value(json!({
            "role": "assistant",
            "content": [{"type": "toolUse", "id": "call-1", "name": "read", "input": {"command": "ignored"}}],
        }))
        .expect("message"),
    );
    assert!(borrowed(&input));
}

#[test]
fn format_filters_preserve_semantic_anchors_from_the_middle() {
    let padding = gen_lines(100, |i| format!("routine line {i}"));
    let cases: Vec<(&str, Vec<String>, Vec<&str>)> = vec![
        (
            "git diff",
            cat(&[
                strs(&["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts"]),
                padding.clone(),
                strs(&[
                    "@@ -200,2 +200,2 @@",
                    "-old middle value",
                    "+new middle value",
                ]),
                padding.clone(),
                strs(&[" 1 file changed, 1 insertion(+), 1 deletion(-)"]),
            ]),
            vec!["@@ -200,2 +200,2 @@", "+new middle value"],
        ),
        (
            "bun build src/index.ts",
            cat(&[
                strs(&["bun build v1.4.0", "Bundled 100 modules"]),
                gen_lines(100, |i| format!("progress {i}")),
                strs(&[
                    "src/middle.ts:42:7 error: cannot assign string to number",
                    "    at compile (src/compiler.ts:9:2)",
                ]),
                gen_lines(100, |i| format!("progress {}", i + 100)),
                strs(&["Build failed with 1 error"]),
            ]),
            vec![
                "src/middle.ts:42:7 error: cannot assign string to number",
                "at compile",
            ],
        ),
        (
            "bun test",
            cat(&[
                strs(&["bun test v1.4.0", "10 pass"]),
                padding.clone(),
                strs(&[
                    "FAIL middle behavior preserves data",
                    "    at test/middle.test.ts:42:7",
                ]),
                padding.clone(),
                strs(&["1 fail"]),
            ]),
            vec![
                "FAIL middle behavior preserves data",
                "at test/middle.test.ts:42:7",
            ],
        ),
    ];
    for (command, lines, anchors) in cases {
        let content = join(&lines);
        let mut input = request("bash", &content);
        set_command(&mut input, command);
        let output = result_content(&transform_request(&input, &ENABLED).request, 1, 0);
        for anchor in anchors {
            assert!(output.contains(anchor), "{command}: {anchor}");
        }
        assert!(utf16_len(&output) < utf16_len(&content));
    }
}

#[test]
fn unknown_origin_requires_multiple_build_or_test_anchors() {
    let weak = [
        format!(
            "const message = \"error: build failed\";\n{}",
            "source code\n".repeat(80)
        ),
        format!(
            "{}\n{}",
            r#"{"status":"10 pass"}"#,
            "json payload\n".repeat(80)
        ),
        format!(
            "The prose says Compiling is useful.\n{}",
            "paragraph text\n".repeat(80)
        ),
        format!(
            "ordinary log\nwarning: one transient event\n{}",
            "service healthy\n".repeat(80)
        ),
    ];
    for content in weak {
        assert!(borrowed(&request("mystery", &content)));
    }
    let strong = format!(
        "bun test v1.4.0\n{}10 pass\n0 fail\n{}",
        "case passed\n".repeat(30),
        "detail line\n".repeat(50)
    );
    assert!(has(
        &transform_request(&request("mystery", &strong), &ENABLED).report,
        "test-output"
    ));
}

#[test]
fn numbered_read_requires_confirmed_shell_origin() {
    let content = join(&gen_lines(300, |i| format!("{} | source line", i + 1)));
    assert!(borrowed(&request("mystery", &content)));
    let mut shell = request("bash", &content);
    set_command(&mut shell, "sed -n '1,300p' file.ts");
    assert!(has(
        &transform_request(&shell, &ENABLED).report,
        "numbered-read"
    ));
}

#[test]
fn preserves_oversized_input_and_transforms_deterministically() {
    let big = request("bash", &"x".repeat(1_000_001));
    assert!(borrowed(&big));
    let input = request("bash", &repeated());
    let a = transform_request(&input, &ENABLED);
    let b = transform_request(&input, &ENABLED);
    assert_eq!(a.request, b.request);
    assert_eq!(a.report, b.report);
}

fn diff_request(rows: usize) -> ChatRequest {
    let mut lines = strs(&["diff --git a/x b/x", "--- a/x", "+++ b/x"]);
    lines.push(format!("@@ -1,{rows} +1,{rows} @@"));
    lines.extend(gen_lines(rows, |i| format!(" L{i}")));
    tool_request(
        "call-1",
        "bash",
        json!({"command": "git diff"}),
        &join(&lines),
    )
}

#[test]
fn compresses_a_diff_that_is_under_500_code_units_but_long_enough_to_elide() {
    let input = diff_request(40);
    let original = result_content(&input, 1, 0);
    assert!(utf16_len(&original) < 500);
    let result = transform_request(&input, &ENABLED);
    assert!(result.report.applied);
    assert!(has(&result.report, "git-diff"));
    let output = result_content(&result.request, 1, 0);
    assert!(utf16_len(&output) < utf16_len(&original));
    assert!(output.contains(" L0"));
    assert!(output.contains(" L39"));
    assert!(
        output
            .split('\n')
            .any(|l| marker(l).is_some_and(|(_, u)| u == "lines"))
    );
}

#[test]
fn leaves_a_short_diff_untouched_because_no_filter_shrinks_it() {
    let input = diff_request(4);
    assert!(utf16_len(&result_content(&input, 1, 0)) < 500);
    assert!(borrowed(&input));
}
