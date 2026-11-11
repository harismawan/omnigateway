//! Single huge rows and deep nesting at the 1,000,000-unit input cap. The
//! frozen TS spends minutes on some of these (its `COMPILER` detector
//! backtracks quadratically on `:1:1:…` rows, its `RELATIVE_PATH`
//! exponentially on `a/a/… ` rows); the port must stay linear and stack-safe.

use omni_ir::request::ChatRequest;
use omni_rtk::{RtkConfig, transform_request};
use serde_json::json;
use std::time::{Duration, Instant};

fn request(name: &str, command: &str, content: &str) -> ChatRequest {
    serde_json::from_value(json!({
        "model": "m", "stream": false,
        "messages": [
            {"role": "assistant", "content": [{"type": "toolUse", "id": "x", "name": name, "input": {"command": command}}]},
            {"role": "user", "content": [{"type": "toolResult", "toolUseId": "x", "content": content}]},
        ],
    }))
    .expect("request")
}

#[test]
fn huge_single_rows_stay_fast_for_every_family() {
    let shapes = [
        "a".repeat(999_990),
        ":1".repeat(499_995),
        "a/".repeat(499_990) + "a ",
        "😀".repeat(499_995),
        " ".repeat(999_990),
        "-".repeat(999_990),
        format!("src/a.ts:1:{}", "x:".repeat(499_990)),
        "│   ".repeat(249_990) + "├── x",
    ];
    let commands = [
        ("bash", "find ."),
        ("bash", "tree"),
        ("bash", "rg -n x ."),
        ("bash", "git diff"),
        ("bash", "tsc"),
        ("bash", "bun test"),
        ("bash", "npm install"),
        ("bash", "docker build ."),
        ("bash", "git status"),
        ("bash", "ls -lR"),
        ("mystery", ""),
    ];
    let started = Instant::now();
    for line in &shapes {
        let content = format!("{line}\nabc");
        for (name, command) in commands {
            let request = request(name, command, &content);
            let _ = transform_request(&request, &RtkConfig { enabled: true });
        }
    }
    // Debug build; the TS takes ~5 minutes on the `:1:1` shape alone.
    assert!(
        started.elapsed() < Duration::from_secs(120),
        "{:?}",
        started.elapsed()
    );
}
