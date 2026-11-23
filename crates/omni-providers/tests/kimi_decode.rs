//! `decodeChat` pinned against the TS decoder's own tests (`kimi.test.ts`):
//! strictly sequential blocks, `[DONE]` as the transport-level success
//! marker, visible failure on an unknown finish reason, and cached-token
//! netting out of the prompt total.

use std::collections::VecDeque;

use omni_ir::error::ErrorCode;
use omni_ir::stream::{
    CollectedBlock, ContentBlockStart, Delta, StopReason, StreamEvent, Usage, collect,
};
use omni_providers::codec::{Flow, StreamDecoder};
use omni_providers::kimi::decode::KimiDecoder;
use omni_providers::sse::SseMessage;
use serde_json::{Value, json};

const DONE: &str = "[DONE]";

/// Drives the decoder the way the host does: `finish` runs only when no
/// message ever returned `Flow::Stop`, and nothing is read after one did.
fn drive(payloads: &[String]) -> Vec<StreamEvent> {
    let mut decoder = KimiDecoder::new();
    let mut out = VecDeque::new();
    let mut stopped = false;
    for data in payloads {
        let flow = decoder
            .message(
                &SseMessage {
                    event: "message".into(),
                    data: data.clone(),
                },
                &mut out,
            )
            .expect("decode");
        if flow == Flow::Stop {
            stopped = true;
            break;
        }
    }
    if !stopped {
        decoder.finish(&mut out);
    }
    out.into_iter().collect()
}

fn chunk(payload: Value) -> String {
    payload.to_string()
}

/// Block open/close events in the order they were emitted. A count of starts
/// and ends survives an overlap unchanged, so the order is what is asserted.
fn block_spans(events: &[StreamEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::BlockStart { index, .. } => Some(format!("open {index}")),
            StreamEvent::BlockEnd { index } => Some(format!("close {index}")),
            _ => None,
        })
        .collect()
}

fn text_delta(index: u32, text: &str) -> StreamEvent {
    StreamEvent::BlockDelta {
        index,
        delta: Delta::Text { text: text.into() },
    }
}

fn end(stop_reason: StopReason, usage: Usage) -> StreamEvent {
    StreamEvent::End {
        stop_reason,
        usage,
        vendor: None,
    }
}

fn usage(input: f64, output: f64, read: f64, write: f64) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: read,
        cache_write_tokens: write,
        ..Usage::default()
    }
}

#[test]
fn decodes_chat_completion_chunks_into_canonical_events() {
    let events = drive(&[
        chunk(
            json!({"id": "c1", "model": "kimi-k2", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hel"}}]}),
        ),
        chunk(json!({"choices": [{"index": 0, "delta": {"content": "lo"}}]})),
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}),
        ),
        DONE.into(),
    ]);
    assert_eq!(
        events,
        [
            StreamEvent::Start {
                id: "c1".into(),
                model: "kimi-k2".into()
            },
            StreamEvent::BlockStart {
                index: 0,
                block: ContentBlockStart::Text
            },
            text_delta(0, "Hel"),
            text_delta(0, "lo"),
            StreamEvent::BlockEnd { index: 0 },
            end(StopReason::EndTurn, usage(10.0, 5.0, 0.0, 0.0)),
        ]
    );
}

#[test]
fn decodes_streamed_tool_calls_indexed_after_text() {
    let events = drive(&[
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "f", "arguments": "{\"a\""}}]}}]}),
        ),
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ":1}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        events,
        [
            StreamEvent::BlockStart {
                index: 0,
                block: ContentBlockStart::ToolUse {
                    id: "c1".into(),
                    name: "f".into()
                }
            },
            StreamEvent::BlockDelta {
                index: 0,
                delta: Delta::ToolJson {
                    partial: "{\"a\"".into()
                }
            },
            StreamEvent::BlockDelta {
                index: 0,
                delta: Delta::ToolJson {
                    partial: ":1}".into()
                }
            },
            StreamEvent::BlockEnd { index: 0 },
            end(StopReason::ToolUse, Usage::default()),
        ]
    );
}

#[test]
fn every_finish_reason_the_table_names_still_maps() {
    // The positive control: a decoder refusing all four passes the unknown
    // reason tests below and serves nothing at all.
    for (reason, stop_reason) in [
        ("stop", StopReason::EndTurn),
        ("length", StopReason::MaxTokens),
        ("tool_calls", StopReason::ToolUse),
        ("content_filter", StopReason::ContentFilter),
    ] {
        let events = drive(&[
            chunk(json!({"choices": [{"delta": {}, "finish_reason": reason}]})),
            DONE.into(),
        ]);
        assert_eq!(events, [end(stop_reason, Usage::default())], "{reason}");
    }
}

#[test]
fn fails_visibly_on_a_finish_reason_it_does_not_know() {
    // `endTurn` is the one wrong answer that cannot be noticed: a truncated
    // turn reaches the client as a complete reply.
    let events = drive(&[
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "invented_reason"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        events.last(),
        Some(&StreamEvent::Error {
            code: ErrorCode::Upstream,
            message: "unrecognized Kimi finish reason \"invented_reason\"".into(),
            retryable: false,
        })
    );
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::End { .. })));
}

#[test]
fn a_prototype_key_is_not_a_finish_reason() {
    // `FINISH["constructor"]` in JS answers the Object constructor; the Rust
    // table must refuse it the same way the guarded TS decoder does.
    let events = drive(&[
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "constructor"}]})),
        DONE.into(),
    ]);
    assert!(matches!(
        events.last(),
        Some(StreamEvent::Error {
            code: ErrorCode::Upstream,
            ..
        })
    ));
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::End { .. })));
}

#[test]
fn an_explicit_null_finish_reason_mid_stream_is_not_a_failure() {
    // This wire spells "not finished yet" as `null` on nearly every chunk.
    let events = drive(&[
        chunk(json!({"choices": [{"delta": {"content": "partial"}, "finish_reason": null}]})),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "stop"}]})),
        DONE.into(),
    ]);
    assert!(matches!(
        events.last(),
        Some(StreamEvent::End {
            stop_reason: StopReason::EndTurn,
            ..
        })
    ));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, StreamEvent::Error { .. }))
    );
}

#[test]
fn emits_upstream_when_eof_follows_finish_reason_without_done() {
    let events = drive(&[
        chunk(json!({"choices": [{"delta": {"content": "partial"}}]})),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "stop"}]})),
    ]);
    assert_eq!(
        events.last(),
        Some(&StreamEvent::Error {
            code: ErrorCode::Upstream,
            message: "upstream stream ended before [DONE]".into(),
            retryable: true,
        })
    );
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::End { .. })));
}

#[test]
fn emits_upstream_when_eof_arrives_without_done() {
    let events = drive(&[chunk(
        json!({"choices": [{"delta": {"content": "partial"}}]}),
    )]);
    assert!(matches!(
        events.last(),
        Some(StreamEvent::Error {
            code: ErrorCode::Upstream,
            ..
        })
    ));
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::End { .. })));
}

#[test]
fn done_with_no_finish_reason_still_terminates_the_stream() {
    let events = drive(&[
        chunk(json!({"choices": [{"delta": {"content": "x"}}]})),
        DONE.into(),
    ]);
    assert!(matches!(
        events.last(),
        Some(StreamEvent::End {
            stop_reason: StopReason::EndTurn,
            ..
        })
    ));
}

#[test]
fn subtracts_kimis_cache_hits_out_of_the_prompt_total() {
    // Kimi reports the whole prompt in `prompt_tokens`, hits as a subset;
    // the IR wants the miss remainder so pricing does not charge a hit twice.
    let events = drive(&[
        chunk(json!({"id": "c1", "model": "kimi-k2", "choices": []})),
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 5, "prompt_cache_hit_tokens": 60}}),
        ),
        DONE.into(),
    ]);
    assert_eq!(
        events.last(),
        Some(&end(StopReason::EndTurn, usage(40.0, 5.0, 60.0, 0.0)))
    );
}

#[test]
fn reads_kimis_cache_hits_from_the_openai_compatible_field() {
    let events = drive(&[
        chunk(json!({"id": "c1", "model": "kimi-k2", "choices": []})),
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 60}}}),
        ),
        DONE.into(),
    ]);
    assert_eq!(
        events.last(),
        Some(&end(StopReason::EndTurn, usage(40.0, 5.0, 60.0, 0.0)))
    );
}

#[test]
fn reads_cache_creation_tokens_when_the_upstream_reports_them() {
    let events = drive(&[
        chunk(json!({"id": "c1", "model": "kimi-k2", "choices": []})),
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 60, "cache_creation_tokens": 10}}}),
        ),
        DONE.into(),
    ]);
    assert_eq!(
        events.last(),
        Some(&end(StopReason::EndTurn, usage(30.0, 5.0, 60.0, 10.0)))
    );
}

#[test]
fn reads_cache_write_tokens_as_the_creation_fallback() {
    let events = drive(&[
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 10}}}),
        ),
        DONE.into(),
    ]);
    assert_eq!(
        events.last(),
        Some(&end(StopReason::EndTurn, usage(30.0, 5.0, 60.0, 10.0)))
    );
}

// --- Block sequencing --------------------------------------------------------
// Blocks must be strictly sequential: one closes before the next opens. The
// Anthropic egress reproduces this sequence verbatim, and an overlapping pair
// makes a real client announce the tool block twice and never announce the
// text block it followed.

#[test]
fn text_closes_before_a_tool_call_opens() {
    let events = drive(&[
        chunk(
            json!({"id": "c1", "model": "kimi-k2", "choices": [{"delta": {"content": "Let me check."}}]}),
        ),
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "f", "arguments": "{}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        block_spans(&events),
        ["open 0", "close 0", "open 1", "close 1"]
    );
}

#[test]
fn each_tool_call_closes_before_the_next_one_opens() {
    let events = drive(&[
        chunk(
            json!({"id": "c1", "model": "kimi-k2", "choices": [{"delta": {"role": "assistant"}}]}),
        ),
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "f", "arguments": "{}"}}]}}]}),
        ),
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "t2", "function": {"name": "g", "arguments": "{}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        block_spans(&events),
        ["open 0", "close 0", "open 1", "close 1"]
    );
}

#[test]
fn text_after_a_tool_call_opens_a_second_text_block() {
    let events = drive(&[
        chunk(
            json!({"id": "c1", "model": "kimi-k2", "choices": [{"delta": {"content": "Checking."}}]}),
        ),
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "f", "arguments": "{}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {"content": "All done."}}]})),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "stop"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        block_spans(&events),
        [
            "open 0", "close 0", "open 1", "close 1", "open 2", "close 2"
        ]
    );
    // The non-streaming fold keeps the trailing text after the tool call it
    // followed, rather than hoisting it in front of the call.
    let folded = collect(events);
    assert_eq!(
        folded.content,
        [
            CollectedBlock::Text {
                text: "Checking.".into(),
                citations: vec![]
            },
            CollectedBlock::ToolUse {
                id: "t1".into(),
                name: "f".into(),
                input: omni_ir::jsjson::parse_js("{}").expect("input"),
            },
            CollectedBlock::Text {
                text: "All done.".into(),
                citations: vec![]
            },
        ]
    );
}

#[test]
fn content_and_tool_calls_in_one_chunk_still_produce_a_flat_sequence() {
    let events = drive(&[
        chunk(
            json!({"id": "c1", "model": "kimi-k2", "choices": [{"delta": {"content": "Calling now.", "tool_calls": [{"index": 0, "id": "t1", "function": {"name": "f", "arguments": "{\"a\":1}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        block_spans(&events),
        ["open 0", "close 0", "open 1", "close 1"]
    );
    let folded = collect(events);
    assert_eq!(
        folded.content,
        [
            CollectedBlock::Text {
                text: "Calling now.".into(),
                citations: vec![]
            },
            CollectedBlock::ToolUse {
                id: "t1".into(),
                name: "f".into(),
                input: omni_ir::jsjson::parse_js(r#"{"a":1}"#).expect("input"),
            },
        ]
    );
}

#[test]
fn a_tool_call_without_an_id_is_named_after_its_wire_index() {
    let events = drive(&[
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 2, "function": {"name": "f", "arguments": "{}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert!(matches!(
        &events[0],
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::ToolUse { id, name }
        } if id == "call_2" && name == "f"
    ));

    // An absent index is `?? 0`, so the synthesized id is `call_0`.
    let events = drive(&[
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"function": {"name": "f", "arguments": "{}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert!(matches!(
        &events[0],
        StreamEvent::BlockStart {
            block: ContentBlockStart::ToolUse { id, .. },
            ..
        } if id == "call_0"
    ));
}

#[test]
fn a_late_fragment_targets_its_own_index_without_reopening_the_block() {
    // Splitting one JSON document across two blocks would hand the client
    // arguments it cannot parse.
    let events = drive(&[
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "f", "arguments": "{\"a\""}}]}}]}),
        ),
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "t2", "function": {"name": "g", "arguments": "{}"}}]}}]}),
        ),
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ":1}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        block_spans(&events),
        ["open 0", "close 0", "open 1", "close 1"]
    );
    assert_eq!(
        events
            .iter()
            .rev()
            .find(|e| matches!(e, StreamEvent::BlockDelta { .. })),
        Some(&StreamEvent::BlockDelta {
            index: 0,
            delta: Delta::ToolJson {
                partial: ":1}".into()
            }
        })
    );
}

#[test]
fn a_malformed_or_non_object_payload_is_skipped_not_fatal() {
    let events = drive(&["not json".into(), "5".into(), DONE.into()]);
    assert_eq!(events, [end(StopReason::EndTurn, Usage::default())]);
}

#[test]
fn non_numeric_usage_counters_reach_the_client_verbatim() {
    let events = drive(&[
        chunk(json!({"id": "c1", "model": "kimi-k2", "choices": []})),
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": "42", "prompt_tokens_details": {"cached_tokens": "60"}}}),
        ),
        DONE.into(),
    ]);
    let Some(StreamEvent::End { usage, .. }) = events.last() else {
        panic!("no end event");
    };
    // The subtraction runs on the coerced numbers...
    assert_eq!(usage.input_tokens, 40.0);
    assert_eq!(usage.output_tokens, 42.0);
    assert_eq!(usage.cache_read_tokens, 60.0);
    // ...but the client sees the upstream's own values, as TS passes them.
    assert_eq!(
        usage.client_output(),
        omni_ir::jsjson::JsValue::String("42".encode_utf16().collect())
    );
    assert_eq!(
        usage.client_cache_read(),
        omni_ir::jsjson::JsValue::String("60".encode_utf16().collect())
    );
}

#[test]
fn an_object_valued_output_counter_is_kept_raw_not_dropped() {
    let events = drive(&[
        chunk(json!({"id": "c1", "model": "kimi-k2", "choices": []})),
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": {"n": 1}}}),
        ),
        DONE.into(),
    ]);
    let Some(StreamEvent::End { usage, .. }) = events.last() else {
        panic!("no end event");
    };
    assert!(usage.output_tokens.is_nan());
    assert_eq!(
        usage.client_output(),
        omni_ir::jsjson::JsValue::from(&json!({"n": 1}))
    );
}
