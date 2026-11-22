//! `decodeKiloChat` pinned against the TS decoder's own tests (`kilo.test.ts`):
//! strictly sequential blocks across reasoning, text and tool calls, the three
//! reasoning spellings read first-non-empty-wins, never a proxied signature,
//! `[DONE]` as the transport-level success marker, visible failure on an
//! unknown finish reason, and cached-token netting out of the prompt total.

use std::collections::VecDeque;

use omni_ir::error::ErrorCode;
use omni_ir::stream::{
    CollectedBlock, ContentBlockStart, Delta, StopReason, StreamEvent, Usage, collect,
};
use omni_providers::codec::{Flow, StreamDecoder};
use omni_providers::kilo::decode::KiloDecoder;
use omni_providers::sse::SseMessage;
use serde_json::{Value, json};

const DONE: &str = "[DONE]";

/// Drives the decoder the way the host does: `finish` runs only when no
/// message ever returned `Flow::Stop`, and nothing is read after one did.
fn drive(payloads: &[String]) -> Vec<StreamEvent> {
    let mut decoder = KiloDecoder::new();
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

fn thinking_delta(index: u32, text: &str) -> StreamEvent {
    StreamEvent::BlockDelta {
        index,
        delta: Delta::Thinking { text: text.into() },
    }
}

fn thinking_start(index: u32) -> StreamEvent {
    StreamEvent::BlockStart {
        index,
        block: ContentBlockStart::Thinking { signed: None },
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

/// A stream that thinks under the given delta shape, then answers, then
/// reports usage — the shape every proxied vendor's reasoning turn takes.
fn reasoning_reply(delta: Value) -> Vec<String> {
    let mut first = json!({"role": "assistant"});
    if let (Some(base), Some(extra)) = (first.as_object_mut(), delta.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
    vec![
        chunk(
            json!({"id": "gen-r", "model": "anthropic/claude-sonnet-5", "choices": [{"index": 0, "delta": first}]}),
        ),
        chunk(json!({"choices": [{"index": 0, "delta": {"content": "answer"}}]})),
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 40}}),
        ),
        DONE.into(),
    ]
}

#[test]
fn decodes_chat_completion_chunks_into_canonical_events() {
    let events = drive(&[
        chunk(
            json!({"id": "c1", "model": "anthropic/claude-sonnet-5", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hel"}}]}),
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
                model: "anthropic/claude-sonnet-5".into()
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
fn a_stream_with_no_usage_payload_ends_reporting_zeros() {
    let events = drive(&[
        chunk(json!({"id": "c1", "model": "m", "choices": [{"delta": {"content": "hi"}}]})),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "stop"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        events.last(),
        Some(&end(StopReason::EndTurn, Usage::default()))
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

// --- Reasoning response --------------------------------------------------------

#[test]
fn decodes_openrouters_reasoning_field_into_a_thinking_block() {
    let events = drive(&reasoning_reply(json!({"reasoning": "step one"})));
    assert_eq!(events[1], thinking_start(0));
    assert_eq!(events[2], thinking_delta(0, "step one"));
    // Sequential blocks: the thinking closes before the answer opens, which
    // is what an Anthropic-shaped egress renders.
    assert_eq!(events[3], StreamEvent::BlockEnd { index: 0 });
    assert_eq!(
        events[4],
        StreamEvent::BlockStart {
            index: 1,
            block: ContentBlockStart::Text
        }
    );
}

#[test]
fn decodes_the_deepseek_family_reasoning_content_spelling_too() {
    let events = drive(&reasoning_reply(json!({"reasoning_content": "step one"})));
    assert_eq!(events[2], thinking_delta(0, "step one"));
}

#[test]
fn falls_back_to_reasoning_details_when_no_plain_reasoning_string_arrives() {
    let events = drive(&reasoning_reply(json!({"reasoning_details": [
        {"type": "reasoning.text", "text": "detailed "},
        {"type": "reasoning.summary", "summary": "thought"}
    ]})));
    assert_eq!(events[2], thinking_delta(0, "detailed thought"));
}

#[test]
fn reads_a_delta_carrying_both_spellings_once_not_twice() {
    // OpenRouter sends `reasoning` and `reasoning_details` in the same delta
    // describing the same tokens. Reading both doubles the thinking.
    let events = drive(&reasoning_reply(json!({
        "reasoning": "step one",
        "reasoning_details": [{"type": "reasoning.text", "text": "step one"}]
    })));
    let thinking: Vec<&StreamEvent> = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                StreamEvent::BlockDelta {
                    delta: Delta::Thinking { .. },
                    ..
                }
            )
        })
        .collect();
    assert_eq!(thinking, [&thinking_delta(0, "step one")]);
}

#[test]
fn never_claims_a_proxied_signature() {
    // The signature was minted over the request Kilo made, on Kilo's account.
    // Replaying it to Anthropic through this gateway fails the whole turn, so
    // the block is reported unsigned — displayable, not replayable.
    let events = drive(&reasoning_reply(json!({
        "reasoning": "step one",
        "reasoning_details": [{
            "type": "reasoning.text",
            "text": "step one",
            "signature": "ErUBCkYIBxgCIkA",
            "format": "anthropic-claude-v1"
        }]
    })));
    assert_eq!(events[1], thinking_start(0));
    assert!(!events.iter().any(|e| matches!(
        e,
        StreamEvent::BlockDelta {
            delta: Delta::ThinkingSignature { .. },
            ..
        }
    )));
}

#[test]
fn an_unreadable_reasoning_shape_costs_the_text_not_the_response() {
    // No thinking block, because there is no text to show — but the answer,
    // the stop reason and the usage all still arrive. Erroring here would
    // throw away a good response every time a proxied vendor adds a field.
    let events = drive(&reasoning_reply(json!({
        "reasoning_details": [{"type": "reasoning.encrypted", "data": "b3BhcXVl"}]
    })));
    assert!(!events.iter().any(|e| matches!(
        e,
        StreamEvent::BlockStart {
            block: ContentBlockStart::Thinking { .. },
            ..
        }
    )));
    assert_eq!(
        events[1],
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::Text
        }
    );
    assert_eq!(
        events.last(),
        Some(&end(StopReason::EndTurn, usage(10.0, 40.0, 0.0, 0.0)))
    );
}

#[test]
fn a_non_streaming_request_collects_the_reasoning_into_the_response_content() {
    let events = drive(&[
        chunk(
            json!({"id": "gen-r", "model": "m", "choices": [{"index": 0, "delta": {"role": "assistant", "reasoning": "step "}}]}),
        ),
        chunk(json!({"choices": [{"index": 0, "delta": {"reasoning": "two"}}]})),
        chunk(json!({"choices": [{"index": 0, "delta": {"content": "answer"}}]})),
        chunk(
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 40}}),
        ),
        DONE.into(),
    ]);
    let folded = collect(events);
    assert_eq!(
        folded.content,
        [
            CollectedBlock::Thinking {
                text: "step two".into(),
                signature: None
            },
            CollectedBlock::Text {
                text: "answer".into(),
                citations: vec![]
            },
        ]
    );
    assert_eq!(folded.usage.output_tokens, 40.0);
}

#[test]
fn reasoning_that_resumes_after_text_opens_a_second_block() {
    let events = drive(&[
        chunk(
            json!({"id": "gen-r", "model": "m", "choices": [{"index": 0, "delta": {"reasoning": "first"}}]}),
        ),
        chunk(json!({"choices": [{"index": 0, "delta": {"content": "partial"}}]})),
        chunk(json!({"choices": [{"index": 0, "delta": {"reasoning": "second"}}]})),
        chunk(json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})),
        DONE.into(),
    ]);
    let folded = collect(events.clone());
    assert_eq!(
        folded.content,
        [
            CollectedBlock::Thinking {
                text: "first".into(),
                signature: None
            },
            CollectedBlock::Text {
                text: "partial".into(),
                citations: vec![]
            },
            CollectedBlock::Thinking {
                text: "second".into(),
                signature: None
            },
        ]
    );
    assert_eq!(
        block_spans(&events),
        [
            "open 0", "close 0", "open 1", "close 1", "open 2", "close 2"
        ]
    );
}

#[test]
fn a_tool_call_closes_the_thinking_block_before_its_own_opens() {
    let events = drive(&[
        chunk(
            json!({"id": "gen-r", "model": "m", "choices": [{"index": 0, "delta": {"reasoning": "which tool"}}]}),
        ),
        chunk(
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "f", "arguments": "{}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert_eq!(events[1], thinking_start(0));
    assert_eq!(events[3], StreamEvent::BlockEnd { index: 0 });
    assert_eq!(
        events[4],
        StreamEvent::BlockStart {
            index: 1,
            block: ContentBlockStart::ToolUse {
                id: "c1".into(),
                name: "f".into()
            }
        }
    );
}

// --- Finish reasons ------------------------------------------------------------

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
    // turn reaches the client as a complete reply. A proxied upstream makes
    // an unknown reason likelier here — the vocabulary belongs to whatever
    // model the proxy routed to.
    let events = drive(&[
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "invented_reason"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        events.last(),
        Some(&StreamEvent::Error {
            code: ErrorCode::Upstream,
            message: "unrecognized Kilo finish reason \"invented_reason\"".into(),
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

// --- Usage spellings -----------------------------------------------------------

#[test]
fn subtracts_cache_hits_and_writes_out_of_the_prompt_total() {
    let events = drive(&[
        chunk(json!({"id": "c1", "model": "m", "choices": []})),
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
fn reads_the_deepseek_family_cache_hit_spelling_as_a_fallback() {
    let events = drive(&[
        chunk(json!({"id": "c1", "model": "m", "choices": []})),
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

// --- Block sequencing, text and tool calls --------------------------------------

#[test]
fn text_closes_before_a_tool_call_opens() {
    let events = drive(&[
        chunk(
            json!({"id": "c1", "model": "m", "choices": [{"delta": {"content": "Let me check."}}]}),
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
        chunk(json!({"id": "c1", "model": "m", "choices": [{"delta": {"role": "assistant"}}]})),
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
        chunk(json!({"id": "c1", "model": "m", "choices": [{"delta": {"content": "Checking."}}]})),
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
fn reasoning_text_and_a_tool_call_in_one_turn_stay_a_flat_sequence() {
    let events = drive(&[
        chunk(
            json!({"id": "c1", "model": "m", "choices": [{"delta": {"reasoning": "think", "content": "say", "tool_calls": [{"index": 0, "id": "t1", "function": {"name": "f", "arguments": "{}"}}]}}]}),
        ),
        chunk(json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})),
        DONE.into(),
    ]);
    assert_eq!(
        block_spans(&events),
        [
            "open 0", "close 0", "open 1", "close 1", "open 2", "close 2"
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
