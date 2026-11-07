//! `api_keys.limits` parsing against `parseLimitConfig` in
//! `packages/ratelimit/src/catalog.ts`: the same rows accepted, the same
//! rows refused, and the accepted ones re-serialized byte-identically.

mod common;

use common::{bun_available, bun_script, ts};
use omni_store::limits::parse_limits;

fn cases() -> Vec<String> {
    let mut cases: Vec<String> = [
        r#"{}"#,
        r#"{"requests":{"1m":100},"tokens":{"5h":1000},"concurrency":5}"#,
        r#"{"concurrency":null,"models":{"b":{"spend":{"1w":1.5}},"10":{"concurrency":2}},"requests":{"5h":null,"1m":1.0}}"#,
        r#"{"requests":{"1m":0}}"#,
        r#"{"requests":{"1m":-5}}"#,
        r#"{"requests":{"1m":1.5}}"#,
        r#"{"requests":{"1m":1e2}}"#,
        r#"{"requests":{"1m":9007199254740991}}"#,
        r#"{"requests":{"1m":9007199254740992}}"#,
        r#"{"requests":{"1m":18446744073709551616}}"#,
        r#"{"requests":{"1m":"60"}}"#,
        r#"{"requests":null}"#,
        r#"{"requests":{}}"#,
        r#"{"requests":{"9m":1}}"#,
        r#"{"requests":{"1m":5,"__proto__":1}}"#,
        r#"{"bogus":1}"#,
        r#"{"spend":{"1m":1}}"#,
        r#"{"spend":{"5h":0.0000001,"1w":12.25}}"#,
        r#"{"spend":{"5h":0}}"#,
        r#"{"spend":{"5h":-1}}"#,
        r#"{"spend":{"5h":1e-400}}"#,
        r#"{"spend":{"5h":1e400}}"#,
        r#"{"tokens":{"1w":null,"5h":5,"1m":7}}"#,
        r#"{"concurrency":"5"}"#,
        r#"{"concurrency":0}"#,
        r#"{"concurrency":3,"concurrency":4}"#,
        r#"{"models":{}}"#,
        r#"{"models":null}"#,
        r#"{"models":[]}"#,
        r#"{"models":{"a":{}}}"#,
        r#"{"models":{"a":{"concurrency":null}}}"#,
        r#"{"models":{"a":{"requests":{"1m":null},"spend":{}}}}"#,
        r#"{"models":{"a":{"models":{}}}}"#,
        r#"{"models":{"":{"concurrency":1}}}"#,
        r#"{"models":{"constructor":{"concurrency":1},"toString":{"tokens":{"1m":2}}}}"#,
        r#"{"models":{"__proto__":{"concurrency":1}}}"#,
        r#"{"models":{"a":{"spend":{"5h":null},"tokens":{"1m":3}}}}"#,
        r#"{"models":{"2":{"concurrency":1},"1":{"concurrency":1},"b":{"concurrency":1},"a":{"concurrency":1},"01":{"concurrency":1}}}"#,
        r#"[]"#,
        r#"null"#,
        r#"5"#,
        r#""{}""#,
        r#"not json"#,
        r#""#,
        r#"{"requests":{"1m":1}} trailing"#,
        " {\"requests\":{\"1m\":1}}\n",
    ]
    .map(str::to_owned)
    .to_vec();
    let overrides = |n: usize, name: &dyn Fn(usize) -> String| -> String {
        let entries: Vec<String> = (0..n)
            .map(|i| format!(r#"{}:{{"concurrency":1}}"#, serde_json::json!(name(i))))
            .collect();
        format!(r#"{{"models":{{{}}}}}"#, entries.join(","))
    };
    cases.push(overrides(64, &|i| format!("m{i}")));
    cases.push(overrides(65, &|i| format!("m{i}")));
    cases.push(overrides(1, &|_| "x".repeat(256)));
    cases.push(overrides(1, &|_| "x".repeat(257)));
    cases.push(overrides(1, &|_| "😀".repeat(256)));
    cases.push(overrides(1, &|_| "😀".repeat(257)));
    cases.push(overrides(1, &|_| "e\u{301}".repeat(128)));
    cases.push(overrides(1, &|_| "e\u{301}".repeat(129)));
    cases
}

#[test]
fn known_rows_parse_as_ts_documents() {
    let ok = parse_limits(r#"{"requests":{"1m":100},"tokens":{"5h":1000},"concurrency":5}"#)
        .expect("valid");
    let requests = ok.base.requests.as_ref().expect("requests");
    assert_eq!(requests.one_minute, Some(Some(100)));
    assert_eq!(requests.five_hours, None);
    assert_eq!(
        ok.base.tokens.as_ref().expect("tokens").five_hours,
        Some(Some(1000))
    );
    assert_eq!(ok.base.concurrency, Some(Some(5)));
    assert!(ok.models.is_none());
    assert!(parse_limits(r#"{"requests":{"1m":0}}"#).is_none());
    assert!(parse_limits("{}").expect("empty").is_unlimited());

    let models = parse_limits(r#"{"models":{"m":{"spend":{"1w":2.5}}}}"#).expect("override");
    let m = models.model_override("m").expect("m");
    assert_eq!(m.spend.as_ref().expect("spend").one_week, Some(Some(2.5)));
    assert!(models.model_override("constructor").is_none());
}

#[test]
fn every_case_matches_parse_limit_config() {
    let cases = cases();
    if !bun_available("every_case_matches_parse_limit_config") {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    // `parseLimits` in packages/store/src/sqlite/keys.ts, minus the logger.
    let script = format!(
        r#"
import {{ parseLimitConfig }} from "{}";
const out = [];
for (const raw of JSON.parse(await Bun.stdin.text())) {{
  try {{ out.push(JSON.stringify(parseLimitConfig(JSON.parse(raw)))); }} catch {{ out.push(null); }}
}}
console.log(JSON.stringify(out));
"#,
        ts("packages/ratelimit/src/catalog.ts")
    );
    let stdin = serde_json::to_string(&cases).expect("cases");
    let expected: Vec<Option<String>> =
        serde_json::from_str(&bun_script(dir.path(), &script, &stdin)).expect("json");
    assert_eq!(expected.len(), cases.len());
    for (raw, want) in cases.iter().zip(expected) {
        let got = parse_limits(raw).map(|l| omni_ir::jsjson::to_string(&l.to_json()));
        assert_eq!(got, want, "limits {raw:?}");
    }
}
