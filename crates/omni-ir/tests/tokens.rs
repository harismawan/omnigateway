//! `estimateInputTokens` / `estimateCachedInputTokens` against the TS
//! functions in `packages/ir/src/tokens.ts`, run under Bun.

use omni_ir::request::ChatRequest;
use omni_ir::tokens::{estimate_cached_input_tokens, estimate_input_tokens};
use serde_json::{Value, json};
use std::io::Write as _;
use std::process::{Command, Stdio};

fn cases() -> Vec<Value> {
    let text = |t: &str| json!({ "type": "text", "text": t });
    vec![
        json!({ "model": "m", "stream": false, "messages": [{ "role": "user", "content": [text("hello")] }] }),
        json!({ "model": "m", "stream": true,
            "system": [text("be terse"), { "type": "image", "mediaType": "image/png", "data": "AAAA", "cacheControl": { "type": "ephemeral" } }],
            "messages": [
                { "role": "user", "content": [text(&"x".repeat(4_001)), { "type": "text", "text": "é😀", "cacheControl": { "type": "ephemeral" } }] },
                { "role": "assistant", "content": [
                    { "type": "thinking", "text": "hmm", "signature": "s" },
                    { "type": "toolUse", "id": "t1", "name": "read", "input": { "path": "/etc/hosts", "n": 1.5, "deep": [1, null, true] } }
                ] },
                { "role": "user", "content": [
                    { "type": "toolResult", "toolUseId": "t1", "content": "a".repeat(999),
                      "images": [{ "type": "image", "mediaType": "image/png", "data": "B", "cacheControl": { "type": "ephemeral" } }],
                      "files": [{ "type": "file", "mediaType": "application/pdf", "data": "Zm9vYmFy" }],
                      "native": [{ "type": "providerNative", "provider": "anthropic", "blockType": "document", "data": { "k": "v" } }] },
                    { "type": "providerNative", "provider": "anthropic", "blockType": "web_search_tool_result", "data": { "content": [{ "u": "https://x" }] } }
                ] }
            ],
            "tools": [
                { "kind": "portable", "name": "f", "description": "does f", "inputSchema": { "type": "object", "properties": { "a": { "type": "string" } } }, "cacheControl": { "type": "ephemeral" } },
                { "kind": "provider", "provider": "anthropic", "type": "web_search_20250305", "name": "web_search", "wire": { "max_uses": 3 } }
            ]
        }),
        json!({ "model": "m", "stream": false, "maxTokens": 100,
            "tools": [{ "kind": "portable", "name": "g", "inputSchema": {} }],
            "messages": [{ "role": "user", "content": [{ "type": "toolResult", "toolUseId": "x", "content": "", "cacheControl": { "type": "ephemeral" } }] }] }),
    ]
}

#[test]
fn estimates_equal_the_ts_estimator() {
    let ok = Command::new("bun")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !ok {
        println!("skipping: bun is not on PATH");
        return;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("root");
    let script = format!(
        r#"
import {{ estimateInputTokens, estimateCachedInputTokens }} from "{}/packages/ir/src/tokens.ts";
const cases = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(cases.map((c) => [estimateInputTokens(c), estimateCachedInputTokens(c)])));
"#,
        root.display()
    );
    let file = std::env::temp_dir().join(format!("omni-tokens-{}.ts", std::process::id()));
    std::fs::write(&file, script).expect("script");
    let mut child = Command::new("bun")
        .arg(&file)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("bun");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(Value::Array(cases()).to_string().as_bytes())
        .expect("write");
    let out = child.wait_with_output().expect("output");
    assert!(out.status.success());
    let ts: Vec<(f64, f64)> = serde_json::from_slice(&out.stdout).expect("ts json");
    for (case, (input, cached)) in cases().into_iter().zip(ts) {
        let req: ChatRequest = serde_json::from_value(case).expect("request");
        assert_eq!(estimate_input_tokens(&req), input);
        assert_eq!(estimate_cached_input_tokens(&req), cached);
    }
}
