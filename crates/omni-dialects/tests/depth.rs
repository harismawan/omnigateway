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

// ------------------------------------------------------------------ ingest()
//
// Through the public entry point, with no help from the test: the body text
// goes in and the IR comes back, on a 2 MiB thread. Each payload puts a value
// that is `MAX_DEPTH` containers deep *counted from the body root* at one
// client-JSON position. Accepted results are cloned, serialized with
// `jsjson` and the IR's `Serialize`, then dropped, all on the same thread.

use ingress::{Ingested, Surface};

/// A body `D` deep whose deepest value sits at `{path}` (`levels` above it).
fn at(levels_above: usize, template: &str) -> String {
    template.replace("@", &nest(D - levels_above))
}

fn ingest(surface: Surface, body: &str) -> Result<Ingested, GatewayError> {
    let mut ids = ingress::random_tool_use_id;
    let mut opts = IngressOptions {
        new_tool_use_id: &mut ids,
    };
    ingress::ingest(surface, body, &Headers::new(), &mut opts)
}

fn exercise(i: Ingested) {
    let copy = i.request.clone();
    // The IR's own `Serialize` (recursive), then every jsjson carrier.
    let ir = serde_json::to_value(&copy).expect("serialize");
    let mut wire = String::new();
    omni_ir::jsjson::write_value(&ir, &mut wire);
    assert!(wire.len() > 2 * (D / 2), "the deep value is in the IR");
    deep::drop(ir);
    let _ = omni_ir::tokens::estimate_input_tokens(&copy);
    drop(copy);
    drop(i);
}

/// `(name, surface, levels above the deep value, template, accepted?)`.
fn positions() -> Vec<(&'static str, Surface, usize, &'static str, bool)> {
    vec![
        // outer body, every dialect
        (
            "anthropic body",
            Surface::Anthropic,
            1,
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"x":@}"#,
            true,
        ),
        (
            "chat body",
            Surface::OpenAi,
            1,
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"x":@}"#,
            true,
        ),
        (
            "responses body",
            Surface::Responses,
            1,
            r#"{"model":"m","input":"hi","x":@}"#,
            true,
        ),
        // custom tool input_schema: accepted, and refused on a later field
        (
            "anthropic input_schema",
            Surface::Anthropic,
            4,
            r#"{"model":"m","messages":[{"role":"user","content":"q"}],"tools":[{"name":"f","input_schema":{"a":@}}]}"#,
            true,
        ),
        (
            "anthropic input_schema, refused",
            Surface::Anthropic,
            4,
            r#"{"model":"m","messages":[{"role":"user","content":"q"}],"tools":[{"name":"f","strict":5,"input_schema":{"a":@}}]}"#,
            false,
        ),
        (
            "anthropic input_schema, refused by zod",
            Surface::Anthropic,
            4,
            r#"{"model":"m","messages":[{"role":"user","content":"q"}],"tools":[{"name":"","input_schema":{"a":@}}]}"#,
            false,
        ),
        (
            "chat parameters",
            Surface::OpenAi,
            5,
            r#"{"model":"m","messages":[{"role":"user","content":"q"}],"tools":[{"type":"function","function":{"name":"f","parameters":{"a":@}}}]}"#,
            true,
        ),
        (
            "responses parameters",
            Surface::Responses,
            4,
            r#"{"model":"m","input":"q","tools":[{"type":"function","name":"f","parameters":{"a":@}}]}"#,
            true,
        ),
        (
            "responses hosted tool",
            Surface::Responses,
            3,
            r#"{"model":"m","input":"q","tools":[{"type":"web_search","x":@}]}"#,
            true,
        ),
        // Responses function_call_output, object form
        (
            "responses output object",
            Surface::Responses,
            4,
            r#"{"model":"m","input":[{"role":"user","content":"q"},{"type":"function_call","call_id":"c","name":"f","arguments":"{}"},{"type":"function_call_output","call_id":"c","output":{"a":@}}]}"#,
            true,
        ),
        (
            "responses output array",
            Surface::Responses,
            4,
            r#"{"model":"m","input":[{"role":"user","content":"q"},{"type":"function_call","call_id":"c","name":"f","arguments":"{}"},{"type":"function_call_output","call_id":"c","output":[@]}]}"#,
            true,
        ),
        // raw.type, refused
        (
            "responses raw.type",
            Surface::Responses,
            3,
            r#"{"model":"m","input":[{"type":@}]}"#,
            false,
        ),
        (
            "responses part type",
            Surface::Responses,
            5,
            r#"{"model":"m","input":[{"role":"user","content":[{"type":@}]}]}"#,
            false,
        ),
        // native and vendor carriers
        (
            "responses reasoning item",
            Surface::Responses,
            3,
            r#"{"model":"m","input":[{"role":"user","content":"q"},{"type":"reasoning","x":@}]}"#,
            true,
        ),
        (
            "anthropic native block",
            Surface::Anthropic,
            5,
            r#"{"model":"m","messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"server_tool_use","id":"s","name":"web_search","input":@}]}]}"#,
            true,
        ),
        (
            "anthropic native block, refused",
            Surface::Anthropic,
            5,
            r#"{"model":"m","messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"server_tool_use","id":"s","name":"nope","input":@}]}]}"#,
            false,
        ),
        (
            "anthropic tool_use input",
            Surface::Anthropic,
            6,
            r#"{"model":"m","messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"f","input":{"a":@}}]}]}"#,
            true,
        ),
        (
            "anthropic block refused after deep sibling",
            Surface::Anthropic,
            5,
            r#"{"model":"m","messages":[{"role":"user","content":[{"type":"bogus","x":@}]}]}"#,
            false,
        ),
        (
            "anthropic safeguards system",
            Surface::Anthropic,
            3,
            r#"{"model":"m","messages":[{"role":"user","content":"q"}],"safeguards":[1],"system":[{"type":"text","text":"s","x":@}]}"#,
            true,
        ),
        (
            "chat message refused after deep field",
            Surface::OpenAi,
            3,
            r#"{"model":"m","messages":[{"role":"tool","x":@,"content":"r"}]}"#,
            false,
        ),
    ]
}

#[test]
fn ingest_is_stack_safe_at_every_client_json_position() {
    on_small_stack(|| {
        let only = std::env::var("ONLY").ok();
        for (name, surface, above, template, accepted) in positions() {
            if only.as_deref().is_some_and(|o| o != name) {
                continue;
            }
            let body = at(above, template);
            assert_eq!(
                omni_ir::deep::depth_of(&body),
                D,
                "{name}: payload is not D deep"
            );
            match ingest(surface, &body) {
                Ok(i) => {
                    assert!(accepted, "{name}: accepted");
                    exercise(i);
                }
                Err(e) => {
                    assert!(!accepted, "{name}: refused: {e}");
                    assert_eq!(e.code.as_str(), "BAD_REQUEST", "{name}");
                    assert_ne!(e.message, ingress::TOO_DEEP, "{name}: at the bound");
                }
            }
            // One level deeper is refused, whatever the position.
            let deeper = template.replace("@", &nest(D - above + 1));
            let e = ingest(surface, &deeper).expect_err(name);
            assert_eq!(e.message, ingress::TOO_DEEP, "{name}");
        }
    });
}

#[test]
fn ingest_keeps_deep_argument_strings_in_every_dialect() {
    on_small_stack(|| {
        for levels in [D - 1, D] {
            let chat = ingest(Surface::OpenAi, &chat_args(levels)).expect("chat");
            assert_eq!(depth(tool_input(&chat.request).expect("tool")), levels);
            exercise(chat);
            let resp = ingest(Surface::Responses, &responses_args(levels)).expect("responses");
            assert_eq!(depth(tool_input(&resp.request).expect("tool")), levels);
            exercise(resp);
        }
        for (surface, body) in [
            (Surface::OpenAi, chat_args(D + 1)),
            (Surface::Responses, responses_args(D + 1)),
        ] {
            let e = ingest(surface, &body).expect_err("too deep");
            assert_eq!(e.message, ingress::TOO_DEEP);
        }
    });
}

#[test]
fn a_deep_js_value_converts_clones_and_drops_on_a_small_stack() {
    on_small_stack(|| {
        let v = deep::Owned(deep::parse(&nest(D)).expect("parse"));
        let js = omni_ir::jsjson::JsValue::from(&*v);
        let copy = js.clone();
        assert_eq!(
            omni_ir::jsjson::stringify(&copy).map(|s| s.len()),
            Some(2 * D + 1)
        );
        drop(copy);
        drop(js);
    });
}
