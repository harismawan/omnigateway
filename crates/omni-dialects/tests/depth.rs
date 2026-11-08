//! Deep JSON: bodies and embedded tool arguments nested up to
//! `omni_ir::deep::MAX_DEPTH` are accepted and carried, one level more is
//! refused deterministically, and every step runs on a 2 MiB stack (tokio's
//! default worker stack).

use omni_dialects::ingress::{self, Headers, IngressOptions};
use omni_ir::deep::{self, MAX_DEPTH};
use omni_ir::error::GatewayError;
use omni_ir::request::{ChatRequest, ContentBlock};
use serde_json::Value;

const STACK: usize = 2 * 1024 * 1024;
const D: usize = MAX_DEPTH;

/// A JSON array `levels` containers deep around `0`.
fn nest(levels: usize) -> String {
    format!("{}0{}", "[".repeat(levels), "]".repeat(levels))
}

fn on_small_stack<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    std::thread::Builder::new()
        .stack_size(STACK)
        .spawn(f)
        .expect("spawn")
        .join()
        .expect("no stack overflow")
}

type Parse = fn(&Value, &Headers, &mut IngressOptions<'_>) -> Result<ChatRequest, GatewayError>;

/// Parses `body` as the route would and runs the request through clone,
/// serialization, the token estimate and drop.
fn route(body: String, parse: Parse) -> Result<ChatRequest, GatewayError> {
    let value = ingress::parse_body_checked(&body)?;
    let mut ids = ingress::random_tool_use_id;
    let mut opts = IngressOptions {
        new_tool_use_id: &mut ids,
    };
    let result = parse(&value, &Headers::new(), &mut opts);
    // `value` is a `deep::Owned`: it drops iteratively.
    drop(value);
    let req = result?;
    let copy = req.clone();
    let mut wire = String::new();
    for v in copy.vendor.iter().flat_map(|m| m.values()) {
        omni_ir::jsjson::write_value(v, &mut wire);
    }
    for b in copy.messages.iter().flat_map(|m| &m.content) {
        if let ContentBlock::ToolUse(t) = b {
            omni_ir::jsjson::write_value(&t.input, &mut wire);
        }
    }
    let _ = omni_ir::tokens::estimate_input_tokens(&copy);
    drop(copy);
    Ok(req)
}

/// The first `toolUse` input in the request.
fn tool_input(req: &ChatRequest) -> Option<&Value> {
    req.messages
        .iter()
        .flat_map(|m| &m.content)
        .find_map(|b| match b {
            ContentBlock::ToolUse(t) => Some(&t.input),
            _ => None,
        })
}

fn depth(v: &Value) -> usize {
    let mut d = 0;
    let mut cur = v;
    while let Some(next) = cur.as_array().and_then(|a| a.first()) {
        d += 1;
        cur = next;
    }
    d
}

fn too_deep(e: &GatewayError) -> bool {
    e.code.as_str() == "BAD_REQUEST" && e.message == ingress::TOO_DEEP
}

/// Chat: a vendor field nested `levels` deep. The body adds one level.
fn chat_vendor(levels: usize) -> String {
    format!(
        r#"{{"model":"m","messages":[{{"role":"user","content":"hi"}}],"x":{}}}"#,
        nest(levels)
    )
}

fn chat_args(levels: usize) -> String {
    serde_json::json!({
        "model": "m",
        "messages": [
            {"role": "user", "content": "q"},
            {"role": "assistant", "tool_calls": [{"id": "c", "type": "function", "function": {"name": "f", "arguments": nest(levels)}}]},
        ]
    })
    .to_string()
}

fn responses_args(levels: usize) -> String {
    serde_json::json!({
        "model": "m",
        "input": [
            {"role": "user", "content": "q"},
            {"type": "function_call", "call_id": "c", "name": "f", "arguments": nest(levels)},
        ]
    })
    .to_string()
}

fn anthropic_vendor(levels: usize) -> String {
    format!(
        r#"{{"model":"m","messages":[{{"role":"user","content":"hi"}}],"x":{}}}"#,
        nest(levels)
    )
}

#[test]
fn an_outer_body_at_the_bound_is_carried_and_one_deeper_is_refused() {
    on_small_stack(|| {
        // The body object is one level; `x` adds the rest.
        for (parse, name) in [
            (ingress::openai::parse as Parse, "chat"),
            (ingress::anthropic::parse as Parse, "anthropic"),
        ] {
            let ok = route(chat_vendor(D - 2), parse).expect("D-1");
            assert!(ok.vendor.is_some(), "{name}");
            route(anthropic_vendor(D - 1), parse).unwrap_or_else(|e| panic!("{name} D: {e}"));
            let err = route(chat_vendor(D), parse).expect_err("D+1");
            assert!(too_deep(&err), "{name}: {err}");
        }
    });
}

#[test]
fn chat_tool_arguments_at_the_bound_are_kept_and_never_replaced_by_an_empty_object() {
    on_small_stack(|| {
        for levels in [D - 1, D] {
            let req = route(chat_args(levels), ingress::openai::parse).expect("accepted");
            assert_eq!(depth(tool_input(&req).expect("tool use")), levels);
        }
        let err = route(chat_args(D + 1), ingress::openai::parse).expect_err("D+1");
        assert!(too_deep(&err), "{err}");
    });
}

#[test]
fn responses_tool_arguments_at_the_bound_are_kept() {
    on_small_stack(|| {
        for levels in [D - 1, D] {
            let req = route(responses_args(levels), ingress::responses::parse).expect("accepted");
            assert_eq!(depth(tool_input(&req).expect("tool use")), levels);
        }
        let err = route(responses_args(D + 1), ingress::responses::parse).expect_err("D+1");
        assert!(too_deep(&err), "{err}");
    });
}

#[test]
fn an_anthropic_tool_input_at_the_bound_survives_the_zod_port() {
    on_small_stack(|| {
        let body = |levels: usize| {
            format!(
                r#"{{"model":"m","messages":[{{"role":"user","content":"q"}},{{"role":"assistant","content":[{{"type":"tool_use","id":"t","name":"f","input":{{"a":{}}}}}]}}]}}"#,
                nest(levels)
            )
        };
        // body, messages, message, content, block, input = 6 levels around `a`.
        let req = route(body(D - 6), ingress::anthropic::parse).expect("D");
        let input = tool_input(&req).expect("tool use");
        assert_eq!(depth(&input["a"]), D - 6);
        let err = route(body(D - 5), ingress::anthropic::parse).expect_err("D+1");
        assert!(too_deep(&err), "{err}");
    });
}

#[test]
fn deep_values_clone_serialize_and_drop_on_a_small_stack() {
    on_small_stack(|| {
        let v = deep::parse(&nest(D)).expect("parse");
        let c = deep::clone(&v);
        let s = omni_ir::jsjson::to_string(&c);
        assert_eq!(s.len(), 2 * D + 1);
        deep::drop(c);
        let owned = deep::Owned(v);
        drop(owned);
        assert_eq!(deep::parse(&nest(D + 1)), Err(deep::ParseError::TooDeep));
    });
}

#[test]
fn the_bound_is_the_depth_bun_can_still_stringify() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/vectors/dialects.json"
    );
    let v: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("json");
    assert_eq!(v["depth"]["bound"].as_u64(), Some(D as u64));
    for case in v["depth"]["cases"].as_array().expect("cases") {
        let d = case["depth"].as_u64().expect("depth");
        // TS parses and carries every one of these into the IR.
        assert_eq!(case["chatArgumentsDepth"].as_u64(), Some(d));
        assert_eq!(case["responsesArgumentsDepth"].as_u64(), Some(d));
        // ...but can stringify a bare value only up to the bound.
        assert_eq!(case["stringifyValue"].is_null(), d <= D as u64, "depth {d}");
    }
}
