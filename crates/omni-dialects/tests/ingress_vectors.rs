//! Ingress parity: every client body in `dialects.json` was run through the
//! real TS `parseAnthropicRequest` / `parseOpenAIRequest` /
//! `parseResponsesRequest`. Rust must accept exactly what TS accepted,
//! producing the same IR, and refuse exactly what TS refused, with the same
//! code, status and message.

use omni_dialects::ingress::{self, Headers, IngressOptions};
/// The TS exporter replaces `crypto.randomUUID` with this counter, reset per case.
fn counter_ids() -> impl FnMut() -> String {
    let mut n = 0u32;
    move || {
        n += 1;
        format!("tu_00000000-0000-4000-8000-{n:012}")
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
