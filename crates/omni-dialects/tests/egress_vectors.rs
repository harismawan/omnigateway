//! Egress parity: every IR event sequence in `dialects.json` was rendered by
//! the real TS `anthropicStream` / `openaiStream` / `responsesStream` (frames
//! serialized exactly as `sseResponse` in `routes/proxy.ts` writes them) and by
//! the buffered renderers over TS `collect()`, recorded as the exact bytes TS
//! sends. The Rust encoders and renderers must write the same bytes.

mod common;

use std::collections::HashSet;

use common::{events, s, vectors};
use omni_dialects::egress::{
    self, AnthropicStream, Dialect, OpenAiStream, ResponsesRender, ResponsesStream, StreamEncoder,
};
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::jsjson;
use omni_ir::stream::{StreamEvent, collect};
use omni_ratelimit::{Headroom, HeadroomByDimension, Window};
use serde_json::Value;

fn egress_root() -> &'static Value {
    &vectors()["egress"]
}

fn request_id() -> &'static str {
    s(&egress_root()["requestId"])
}

fn created() -> i64 {
    egress_root()["created"].as_i64().expect("created")
}

fn render() -> ResponsesRender {
    ResponsesRender {
        request_id: request_id().to_string(),
        created: created(),
        custom_tool_names: egress_root()["customToolNames"]
            .as_array()
            .expect("names")
            .iter()
            .map(|n| s(n).to_string())
            .collect::<HashSet<_>>(),
    }
}

/// Feeds the events one at a time, clearing a reused buffer after each, and
/// returns everything written.
fn encode(mut enc: StreamEncoder, evs: &[StreamEvent]) -> String {
    let mut buf = String::new();
    let mut all = String::new();
    for e in evs {
        enc.push(e, &mut buf);
        all.push_str(&buf);
        buf.clear();
    }
    enc.finish(&mut buf);
    all.push_str(&buf);
    all
}

fn check(
    dialect: &str,
    make: impl Fn() -> StreamEncoder,
    respond: impl Fn(&[StreamEvent]) -> omni_ir::deep::Owned,
) {
    let cases = egress_root()[dialect].as_array().expect("cases");
    assert!(cases.len() >= 30, "{dialect}: {} sequences", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let name = s(&case["name"]);
        let evs = events(&case["events"]);
        let got = encode(make(), &evs);
        let want = s(&case["bytes"]);
        if got != want {
            failures.push(format!(
                "{dialect}/{name}: stream\n got: {got}\nwant: {want}"
            ));
        }
        let got = jsjson::to_string(&respond(&evs));
        let want = s(&case["responseJson"]);
        if got != want {
            failures.push(format!(
                "{dialect}/{name}: response\n got: {got}\nwant: {want}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn anthropic_egress_matches_ts() {
    check(
        "anthropic",
        || StreamEncoder::Anthropic(AnthropicStream::new(request_id())),
        |evs| egress::anthropic::response(&collect(evs.iter().cloned()), request_id()),
    );
}

#[test]
fn openai_egress_matches_ts() {
    check(
        "openai",
        || StreamEncoder::OpenAi(OpenAiStream::new(request_id(), created())),
        |evs| egress::openai::response(&collect(evs.iter().cloned()), request_id(), created()),
    );
}

#[test]
fn responses_egress_matches_ts() {
    check(
        "responses",
        || StreamEncoder::Responses(Box::new(ResponsesStream::new(render()))),
        |evs| egress::responses::response(&collect(evs.iter().cloned()), &render()),
    );
}

#[test]
fn frames_are_written_one_event_at_a_time_into_the_callers_buffer() {
    // The encoder appends; it never clears or reallocates what is already there.
    let mut enc = StreamEncoder::Anthropic(AnthropicStream::new("r"));
    let mut buf = String::from("prefix|");
    enc.push(
        &StreamEvent::Start {
            id: "u".into(),
            model: "m".into(),
        },
        &mut buf,
    );
    assert!(buf.starts_with("prefix|event: message_start\ndata: {"));
    assert!(buf.ends_with("}\n\n"));
}

fn dialect(name: &str) -> Dialect {
    match name {
        "anthropic" => Dialect::Anthropic,
        "openai" => Dialect::OpenAi,
        "responses" => Dialect::Responses,
        other => panic!("dialect {other}"),
    }
}

#[test]
fn error_bodies_match_ts() {
    for case in vectors()["errorBodies"].as_array().expect("cases") {
        let code = ErrorCode::parse(s(&case["code"])).expect("code");
        let message = s(&case["message"]);
        assert_eq!(
            u64::from(code.http_status()),
            case["status"].as_u64().expect("status")
        );
        for d in ["anthropic", "openai", "responses"] {
            assert_eq!(
                jsjson::to_string(&dialect(d).error_body(code, message)),
                s(&case[d]),
                "{d} {code}"
            );
        }
    }
}

fn headroom(v: &Value) -> Option<Headroom> {
    let v = v.as_object()?;
    let f = |k: &str| v[k].as_f64().expect("number");
    Some(Headroom {
        window: match s(&v["window"]) {
            "1m" => Window::M1,
            "5h" => Window::H5,
            "1w" => Window::W1,
            other => panic!("window {other}"),
        },
        limit: f("limit"),
        used: f("used"),
        remaining: f("remaining"),
        reset_at: f("resetAt"),
    })
}

#[test]
fn rate_limit_headers_match_ts() {
    let cases = vectors()["rateLimitHeaders"].as_array().expect("cases");
    assert!(cases.len() >= 10);
    for case in cases {
        let h = &case["headroom"];
        let headroom = HeadroomByDimension {
            requests: headroom(&h["requests"]),
            tokens: headroom(&h["tokens"]),
            spend: headroom(&h["spend"]),
        };
        let now = case["now"].as_f64().expect("now");
        for d in ["anthropic", "openai", "responses"] {
            let got = dialect(d).rate_limit_headers(&headroom, now);
            let want: Vec<(String, String)> = case[d]
                .as_object()
                .expect("headers")
                .iter()
                .map(|(k, v)| (k.clone(), s(v).to_string()))
                .collect();
            assert_eq!(got, want, "{d} {h}");
        }
    }
}

#[test]
fn retry_after_is_rendered_on_429s_only_in_whole_seconds_rounded_up() {
    let e = |code, ms| GatewayError::new(code, "x").with_retry_after_ms(ms);
    assert_eq!(
        egress::retry_after(&e(ErrorCode::RateLimit, Some(1500.0))).as_deref(),
        Some("2")
    );
    assert_eq!(
        egress::retry_after(&e(ErrorCode::QuotaExhausted, Some(1000.0))).as_deref(),
        Some("1")
    );
    assert_eq!(
        egress::retry_after(&e(ErrorCode::RateLimit, Some(-5.0))).as_deref(),
        Some("0")
    );
    assert_eq!(
        egress::retry_after(&e(ErrorCode::RateLimit, Some(0.4))).as_deref(),
        Some("1")
    );
    assert_eq!(egress::retry_after(&e(ErrorCode::RateLimit, None)), None);
    assert_eq!(
        egress::retry_after(&e(ErrorCode::Upstream, Some(1000.0))),
        None
    );
    assert_eq!(
        egress::retry_after(&e(ErrorCode::Overloaded, Some(1000.0))),
        None
    );
}
