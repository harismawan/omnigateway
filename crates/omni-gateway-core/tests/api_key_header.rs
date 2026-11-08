//! `apiKeyHeader` and `extractToken` against `apps/gateway/src/auth/apiKey.ts`.

use omni_gateway_core::snapshot::{api_key_header, extract_token};
use serde_json::{Value, json};
use std::io::Write as _;
use std::process::{Command, Stdio};

const SCRIPT: &str = r#"
import { apiKeyHeader } from "ROOT/apps/gateway/src/auth/apiKey.ts";
const cases = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(cases.map(([a, x]) => {
  const h = new Headers();
  if (a !== null) h.set("authorization", a);
  if (x !== null) h.set("x-api-key", x);
  try { return { ok: apiKeyHeader(h) }; } catch (e) { return { err: e.message }; }
})));
"#;

/// Header values as `Headers` stores them: leading/trailing HTTP whitespace
/// is stripped on set, so the cases use only interior variety.
fn values() -> Vec<Option<&'static str>> {
    vec![
        None,
        Some("sk-1"),
        Some("Bearer sk-1"),
        Some("bearer   sk-1"),
        Some("BEARER\tsk-1"),
        Some("Bearer"),
        Some("Bearer sk-1 extra"),
        Some("Bearersk-1"),
        Some("Bearer \u{a0}sk-1"),
        Some("sk-2"),
        Some("Basic abc"),
    ]
}

#[test]
fn api_key_header_equals_the_ts_one() {
    if !Command::new("bun")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        println!("skipping: bun is not on PATH");
        return;
    }
    let mut pairs = Vec::new();
    for a in values() {
        for x in values() {
            pairs.push((a, x));
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("root");
    let file = std::env::temp_dir().join(format!("omni-akh-{}.ts", std::process::id()));
    std::fs::write(&file, SCRIPT.replace("ROOT", &root.display().to_string())).expect("script");
    let mut child = Command::new("bun")
        .arg(&file)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("bun");
    let input: Vec<Value> = pairs.iter().map(|(a, x)| json!([a, x])).collect();
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(Value::Array(input).to_string().as_bytes())
        .expect("w");
    let out = child.wait_with_output().expect("out");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ts: Vec<Value> = serde_json::from_slice(&out.stdout).expect("json");
    for ((a, x), expected) in pairs.into_iter().zip(ts) {
        let got = match api_key_header(a, x) {
            Ok(v) => json!({ "ok": v }),
            Err(e) => json!({ "err": e.message }),
        };
        assert_eq!(got, expected, "{a:?} {x:?}");
        // When both are the same non-null value, TS returns extractToken(a).
        if let (Some(a), Some(x)) = (a, x)
            && a == x
        {
            assert_eq!(json!(extract_token(Some(a))), expected["ok"], "{a:?}");
        }
    }
}
