//! Streaming egress writes each delta straight into the caller's reused buffer.
//!
//! There is no counting allocator here: one needs `unsafe impl GlobalAlloc`,
//! and the workspace forbids `unsafe`. Instead:
//!
//! - after warm-up, a long run of deltas never grows the reused buffer past
//!   the capacity one delta frame needed. The buffer is cleared after every
//!   push, as the server does after each write;
//! - the per-delta input is borrowed: `push` takes `&StreamEvent` (checked by
//!   the signature below), so no delta is moved or cloned in.
//!
//! - the Responses terminal snapshot copies each completed item's bytes once;
//!   it never re-serializes the item (checked by `item_bytes_are_reused`).
//!
//! Capacity alone cannot see allocations that never touch the buffer (an
//! intermediate `Value` built and dropped per delta), so the per-delta paths
//! were rewritten to write borrowed data with no intermediates, and these
//! tests pin the buffer half of the contract. The Task 6 benchmark is the
//! real check on allocation.

use std::collections::HashSet;

use omni_dialects::egress::{
    AnthropicStream, OpenAiStream, ResponsesRender, ResponsesStream, StreamEncoder,
};
use omni_ir::stream::{ContentBlockStart, Delta, StreamEvent};
use serde_json::{Map, json};

/// The per-event entry point takes the event by reference.
const _BORROWED: fn(&mut StreamEncoder, &StreamEvent, &mut String) = StreamEncoder::push;

fn encoders() -> Vec<(&'static str, StreamEncoder)> {
    vec![
        (
            "anthropic",
            StreamEncoder::Anthropic(AnthropicStream::new("req_1")),
        ),
        (
            "openai",
            StreamEncoder::OpenAi(OpenAiStream::new("req_1", 1)),
        ),
        (
            "responses",
            StreamEncoder::Responses(Box::new(ResponsesStream::new(ResponsesRender {
                request_id: "req_1".into(),
                created: 1,
                custom_tool_names: HashSet::new(),
            }))),
        ),
    ]
}

fn native_map() -> Map<String, serde_json::Value> {
    json!({ "text": "a reasoning summary chunk", "extra": { "n": [1, 2, 3] } })
        .as_object()
        .expect("object")
        .clone()
}

/// Opens block 0 as `block`, warms up with ten `delta`s, then pushes 10 000
/// more and checks the buffer never needed more room than after warm-up.
fn steady(block: ContentBlockStart, delta: Delta) {
    for (name, mut enc) in encoders() {
        let mut buf = String::new();
        let start = StreamEvent::Start {
            id: "u".into(),
            model: "m".into(),
        };
        enc.push(&start, &mut buf);
        buf.clear();
        enc.push(
            &StreamEvent::BlockStart {
                index: 0,
                block: block.clone(),
            },
            &mut buf,
        );
        buf.clear();
        let ev = StreamEvent::BlockDelta {
            index: 0,
            delta: delta.clone(),
        };
        for _ in 0..10 {
            enc.push(&ev, &mut buf);
            buf.clear();
        }
        let warmed = buf.capacity();
        for i in 0..10_000 {
            enc.push(&ev, &mut buf);
            assert!(
                buf.capacity() == warmed,
                "{name}: delta {i} grew the buffer from {warmed} to {}",
                buf.capacity()
            );
            buf.clear();
        }
    }
}

#[test]
fn text_deltas_reuse_one_frame_of_buffer() {
    steady(
        ContentBlockStart::Text,
        Delta::Text {
            text: "some streamed text \u{1f600} \"quoted\"".into(),
        },
    );
}

#[test]
fn argument_deltas_reuse_one_frame_of_buffer() {
    steady(
        ContentBlockStart::ToolUse {
            id: "call_1".into(),
            name: "f".into(),
        },
        Delta::ToolJson {
            partial: r#"{"path":"src/main.rs","#.into(),
        },
    );
}

#[test]
fn thinking_deltas_reuse_one_frame_of_buffer() {
    steady(
        ContentBlockStart::Thinking { signed: Some(true) },
        Delta::Thinking {
            text: "considering the options".into(),
        },
    );
}

#[test]
fn native_deltas_reuse_one_frame_of_buffer() {
    steady(
        ContentBlockStart::ProviderNative {
            provider: "openai".into(),
            block_type: "reasoning".into(),
            data: Map::new(),
        },
        Delta::ProviderNative {
            provider: "openai".into(),
            delta_type: "reasoning_summary_text.delta".into(),
            fold: None,
            data: native_map(),
        },
    );
}

#[test]
fn a_streamed_item_is_written_once_and_reused_by_the_terminal_snapshot() {
    use omni_ir::stream::{StopReason, Usage};
    let mut enc = ResponsesStream::new(ResponsesRender {
        request_id: "req_1".into(),
        created: 1,
        custom_tool_names: HashSet::new(),
    });
    let mut buf = String::new();
    let mut all = String::new();
    for ev in [
        StreamEvent::Start {
            id: "u".into(),
            model: "m".into(),
        },
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        },
        StreamEvent::BlockDelta {
            index: 0,
            delta: Delta::Text {
                text: "hello".into(),
            },
        },
        StreamEvent::BlockEnd { index: 0 },
        StreamEvent::End {
            stop_reason: StopReason::EndTurn,
            usage: Usage::default(),
            vendor: None,
        },
    ] {
        enc.push(&ev, &mut buf);
        all.push_str(&buf);
        buf.clear();
    }
    let item = r#"{"id":"msg_req_1_0","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}"#;
    assert_eq!(all.matches(item).count(), 2, "{all}");
    assert!(all.contains(&format!(r#""output":[{item}]"#)));
}
