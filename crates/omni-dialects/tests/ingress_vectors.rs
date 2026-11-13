//! Ingress parity: every client body in `dialects.json` was run through the
//! real TS `parseAnthropicRequest` / `parseOpenAIRequest` /
//! `parseResponsesRequest`. Rust must accept exactly what TS accepted,
//! producing the same IR, and refuse exactly what TS refused, with the same
//! code, status and message.

mod common;

use common::{s, same_ir, vectors};
use omni_dialects::ingress::{
    self, Headers, IngressOptions, custom_tool_names, normalize_client_model,
};
use omni_ir::request::ChatRequest;
use serde_json::Value;

/// The TS exporter replaces `crypto.randomUUID` with this counter, reset per case.
fn counter_ids() -> impl FnMut() -> String {
    let mut n = 0u32;
    move || {
        n += 1;
        format!("tu_00000000-0000-4000-8000-{n:012}")
    }
}

fn headers(case: &Value) -> Headers {
    let mut h = Headers::new();
    if let Some(pairs) = case.get("headers").and_then(Value::as_array) {
        for p in pairs {
            h.append(s(&p[0]), s(&p[1]));
        }
    }
    h
}

fn check(
    dialect: &str,
    parse: fn(
        &Value,
        &Headers,
        &mut IngressOptions<'_>,
    ) -> Result<ChatRequest, omni_ir::error::GatewayError>,
) {
    let cases = vectors()["ingress"][dialect].as_array().expect("cases");
    let mut failures = Vec::new();
    for case in cases {
        let name = s(&case["name"]);
        let body = ingress::parse_body(s(&case["body"])).expect("vector bodies are JSON");
        let h = headers(case);
        let mut ids = counter_ids();
        let mut opts = IngressOptions {
            new_tool_use_id: &mut ids,
        };
        let got = parse(&body, &h, &mut opts);
        match (got, case.get("ok"), case.get("error")) {
            (Ok(req), Some(want), _) => {
                let actual = serde_json::to_value(&req).expect("serialize");
                if let Err(e) = same_ir(&actual, want, "ir") {
                    failures.push(format!("{dialect}/{name}: IR differs: {e}"));
                }
            }
            (Err(err), _, Some(want)) => {
                let got = (
                    err.code.as_str(),
                    err.code.http_status(),
                    err.message.as_str(),
                );
                let want = (
                    s(&want["code"]),
                    u16::try_from(want["status"].as_u64().expect("status")).expect("u16"),
                    s(&want["message"]),
                );
                if got != want {
                    failures.push(format!("{dialect}/{name}: error {got:?} != {want:?}"));
                }
            }
            (Ok(_), None, Some(want)) => {
                failures.push(format!("{dialect}/{name}: accepted, TS refused: {want}"));
            }
            (Err(err), Some(_), _) => {
                failures.push(format!("{dialect}/{name}: refused ({err}), TS accepted"));
            }
            _ => unreachable!("a case is ok or error"),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} {dialect} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn anthropic_ingress_matches_ts() {
    check("anthropic", ingress::anthropic::parse);
}

#[test]
fn openai_ingress_matches_ts() {
    check("openai", ingress::openai::parse);
}

#[test]
fn responses_ingress_matches_ts() {
    check("responses", ingress::responses::parse);
}

#[test]
fn every_dialect_has_broad_valid_and_invalid_coverage() {
    for dialect in ["anthropic", "openai", "responses"] {
        let cases = vectors()["ingress"][dialect].as_array().expect("cases");
        let ok = cases.iter().filter(|c| c.get("ok").is_some()).count();
        assert!(ok >= 50, "{dialect}: {ok} valid");
        assert!(
            cases.len() - ok >= 150,
            "{dialect}: {} invalid",
            cases.len() - ok
        );
    }
}

#[test]
fn custom_tool_names_match_ts() {
    for case in vectors()["customToolNames"].as_array().expect("cases") {
        let mut got: Vec<String> = custom_tool_names(&case["body"]).into_iter().collect();
        let mut want: Vec<String> = case["names"]
            .as_array()
            .expect("names")
            .iter()
            .map(|n| s(n).to_string())
            .collect();
        got.sort();
        want.sort();
        assert_eq!(got, want, "{}", case["body"]);
    }
}

#[test]
fn normalize_client_model_matches_ts() {
    for case in vectors()["normalizeClientModel"].as_array().expect("cases") {
        let betas: Vec<String> = case["betas"]
            .as_array()
            .expect("betas")
            .iter()
            .map(|b| s(b).to_string())
            .collect();
        let (model, merged) = normalize_client_model(s(&case["raw"]), &betas);
        assert_eq!(model, s(&case["output"]["model"]), "{}", case["raw"]);
        let want: Vec<&str> = case["output"]["betas"]
            .as_array()
            .expect("betas")
            .iter()
            .map(s)
            .collect();
        assert_eq!(merged, want, "{}", case["raw"]);
    }
}

#[test]
fn model_allowlist_refuses_with_the_ts_message() {
    let allow = vec!["a".to_string(), "b".to_string()];
    assert!(ingress::check_model_allowlist("a", Some(&allow)).is_ok());
    assert!(ingress::check_model_allowlist("anything", None).is_ok());
    let err = ingress::check_model_allowlist("c", Some(&allow)).expect_err("refused");
    assert_eq!(err.code.as_str(), "AUTH");
    assert_eq!(err.message, r#"model "c" is not allowed for this API key"#);
    let err = ingress::check_model_allowlist("has space", Some(&[])).expect_err("refused");
    assert_eq!(
        err.message,
        r#"model "(unprintable)" is not allowed for this API key"#
    );
}

#[test]
fn parse_body_is_none_exactly_where_json_parse_throws() {
    // `request.json()` throws a SyntaxError in TS, which the route renders as
    // INTERNAL; 5b decides that status. Here only the parse result matters.
    assert!(ingress::parse_body("{").is_none());
    assert!(ingress::parse_body("").is_none());
    assert!(ingress::parse_body(" {\"a\":1} ").is_some());
}

/// Review A5-I1: the request model's exact UTF-16 where it holds a lone
/// surrogate (after JS trim and `[1m]` folding), on every surface; `None`
/// for a well-formed model, a surrogate pair, or a lone surrogate elsewhere.
#[test]
fn a_lone_surrogate_model_is_kept_as_exact_utf16() {
    let h = Headers::default();
    let lone = |surface: ingress::Surface, body: &str| {
        let mut ids = counter_ids();
        let mut opts = IngressOptions {
            new_tool_use_id: &mut ids,
        };
        let got = ingress::ingest(surface, body, &h, &mut opts).expect("ingests");
        (got.request.model.clone(), got.model_lone)
    };
    let chat = |m: &str| {
        format!(r#"{{"model":"{m}","max_tokens":5,"messages":[{{"role":"user","content":"hi"}}]}}"#)
    };
    for surface in [ingress::Surface::OpenAi, ingress::Surface::Anthropic] {
        assert_eq!(
            lone(surface, &chat(r"\ud800")),
            ("\u{fffd}".into(), Some(vec![0xd800]))
        );
        assert_eq!(
            lone(surface, &chat(r" \udc00x[1M] ")),
            ("\u{fffd}x".into(), Some(vec![0xdc00, 0x78]))
        );
        assert_eq!(lone(surface, &chat(r"\ufffd")), ("\u{fffd}".into(), None));
        assert_eq!(
            lone(surface, &chat(r"\ud83d\ude00")),
            ("\u{1f600}".into(), None)
        );
        assert_eq!(
            lone(
                surface,
                r#"{"model":"\ud800","model":"m","max_tokens":5,"messages":[{"role":"user","content":"\ud800"}]}"#
            ),
            ("m".into(), None)
        );
    }
    assert_eq!(
        lone(
            ingress::Surface::Responses,
            r#"{"model":"\ud801","input":"hi"}"#
        ),
        ("\u{fffd}".into(), Some(vec![0xd801]))
    );
}

/// Review A5-R3: recovering the exact model of a body whose model reads as
/// U+FFFD is linear in the body, however wide an unrelated object in it is.
/// 20,000 distinct keys cost at most a small constant per byte (the old
/// duplicate-key search alone took ~2·10⁸ key comparisons); a literal U+FFFD
/// model is not a lone surrogate.
#[test]
fn recovering_a_lone_model_is_linear_in_a_wide_body() {
    let h = Headers::default();
    let wide: Vec<String> = (0..20_000).map(|i| format!(r#""k{i}":{i}"#)).collect();
    let body = |m: &str| {
        format!(
            r#"{{"model":"{m}","x":{{{}}},"messages":[{{"role":"user","content":"hi"}}]}}"#,
            wide.join(",")
        )
    };
    for (m, want) in [
        (r"\ufffd", None),
        ("\u{fffd}", None),
        (r"\ud800", Some(vec![0xd800])),
    ] {
        let text = body(m);
        let mut ids = counter_ids();
        let mut opts = IngressOptions {
            new_tool_use_id: &mut ids,
        };
        let before = omni_ir::jsjson::scan_steps();
        let got = ingress::ingest(ingress::Surface::OpenAi, &text, &h, &mut opts).expect("ingests");
        let steps = omni_ir::jsjson::scan_steps() - before;
        assert_eq!(got.model_lone, want, "{m}");
        assert!(
            steps <= 4 * text.len() as u64,
            "{steps} scan steps for a {}-byte body",
            text.len()
        );
    }
}

/// The lossless parser's duplicate-key handling is linear too (a stored row
/// or an operator file can be as wide), and keeps `JSON.parse`'s semantics:
/// the last value in the first one's position, UTF-16 keys distinct.
#[test]
fn the_lossless_parser_handles_wide_objects_and_duplicates_linearly() {
    let wide: Vec<String> = (0..20_000).map(|i| format!(r#""k{i}":{i}"#)).collect();
    let text = format!(
        r#"{{{},"k5":"last","\ud800":1,"\ufffd":2,"\ud800":3}}"#,
        wide.join(",")
    );
    let before = omni_ir::jsjson::scan_steps();
    let v = omni_ir::jsjson::parse_js(&text).expect("parses");
    let steps = omni_ir::jsjson::scan_steps() - before;
    assert!(
        steps <= 4 * text.len() as u64,
        "{steps} steps for {} bytes",
        text.len()
    );
    let omni_ir::jsjson::JsValue::Object(fields) = &v else {
        panic!("object")
    };
    assert_eq!(fields.len(), 20_002);
    assert_eq!(
        fields[5].1,
        omni_ir::jsjson::JsValue::String("last".encode_utf16().collect())
    );
    assert_eq!(
        fields[20_000],
        (vec![0xd800], omni_ir::jsjson::JsValue::Number(3.0))
    );
    assert_eq!(
        fields[20_001],
        (vec![0xfffd], omni_ir::jsjson::JsValue::Number(2.0))
    );
}
