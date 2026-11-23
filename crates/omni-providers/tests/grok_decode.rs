//! `decodeGrokResponses` pinned against the TS decoder's own tests
//! (`grok.test.ts`): an allowlist of known events, visible failure on any
//! incomplete reason it does not recognize, `[DONE]` as a skipped sentinel
//! rather than a completion, and cached-token netting out of the prompt total.

use std::collections::VecDeque;

use omni_ir::error::ErrorCode;
use omni_ir::stream::{ContentBlockStart, Delta, StopReason, StreamEvent, Usage};
use omni_providers::codec::{Flow, StreamDecoder};
use omni_providers::grok::decode::GrokDecoder;
use omni_providers::sse::SseMessage;
use serde_json::{Value, json};

/// Drives the decoder the way the host does: `finish` runs only when no
/// message ever returned `Flow::Stop`, and nothing is read after one did.
fn drive(messages: &[(&str, String)]) -> Vec<StreamEvent> {
    let mut decoder = GrokDecoder::new();
    let mut out = VecDeque::new();
    let mut stopped = false;
    for (event, data) in messages {
        let flow = decoder
            .message(
                &SseMessage {
                    event: (*event).into(),
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

fn msg(event: &str, payload: Value) -> (&str, String) {
    (event, payload.to_string())
}

fn completed() -> (&'static str, String) {
    msg(
        "response.completed",
        json!({"response": {"status": "completed", "usage": {}}}),
    )
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

fn error(code: ErrorCode, message: &str, retryable: bool) -> StreamEvent {
    StreamEvent::Error {
        code,
        message: message.into(),
        retryable,
    }
}

fn text_delta(index: u32, text: &str) -> StreamEvent {
    StreamEvent::BlockDelta {
        index,
        delta: Delta::Text { text: text.into() },
    }
}

#[test]
fn decodes_a_text_response_stream() {
    let events = drive(&[
        msg(
            "response.created",
            json!({"response": {"id": "resp_1", "model": "grok-4.6"}}),
        ),
        msg(
            "response.content_part.added",
            json!({"output_index": 0, "content_index": 0, "part": {"type": "output_text"}}),
        ),
        msg(
            "response.output_text.delta",
            json!({"output_index": 0, "content_index": 0, "delta": "Hel"}),
        ),
        msg(
            "response.output_text.delta",
            json!({"output_index": 0, "content_index": 0, "delta": "lo"}),
        ),
        msg(
            "response.content_part.done",
            json!({"output_index": 0, "content_index": 0}),
        ),
        completed(),
    ]);
    assert_eq!(
        events,
        [
            StreamEvent::Start {
                id: "resp_1".into(),
                model: "grok-4.6".into()
            },
            StreamEvent::BlockStart {
                index: 0,
                block: ContentBlockStart::Text
            },
            text_delta(0, "Hel"),
            text_delta(0, "lo"),
            StreamEvent::BlockEnd { index: 0 },
            end(StopReason::EndTurn, usage(0.0, 0.0, 0.0, 0.0)),
        ]
    );
}

#[test]
fn decodes_reasoning_deltas_onto_thinking_blocks() {
    // Both spellings land on the same block: a model that reports only raw
    // reasoning would otherwise think into a block that stays empty.
    for spelling in [
        "response.reasoning_summary_text.delta",
        "response.reasoning_text.delta",
    ] {
        let events = drive(&[
            msg(
                "response.output_item.added",
                json!({"output_index": 0, "item": {"type": "reasoning"}}),
            ),
            msg(spelling, json!({"output_index": 0, "delta": "thinking"})),
            msg("response.output_item.done", json!({"output_index": 0})),
            completed(),
        ]);
        assert_eq!(
            events[..3],
            [
                StreamEvent::BlockStart {
                    index: 0,
                    block: ContentBlockStart::Thinking { signed: None }
                },
                StreamEvent::BlockDelta {
                    index: 0,
                    delta: Delta::Thinking {
                        text: "thinking".into()
                    }
                },
                StreamEvent::BlockEnd { index: 0 },
            ],
            "{spelling}"
        );
    }
}

#[test]
fn decodes_function_call_items_with_argument_deltas() {
    let events = drive(&[
        msg(
            "response.output_item.added",
            json!({"output_index": 0, "item": {"type": "function_call", "call_id": "call_1", "name": "f"}}),
        ),
        msg(
            "response.function_call_arguments.delta",
            json!({"output_index": 0, "delta": "{\"a\":1}"}),
        ),
        msg("response.output_item.done", json!({"output_index": 0})),
        completed(),
    ]);
    assert_eq!(
        events[..2],
        [
            StreamEvent::BlockStart {
                index: 0,
                block: ContentBlockStart::ToolUse {
                    id: "call_1".into(),
                    name: "f".into()
                }
            },
            StreamEvent::BlockDelta {
                index: 0,
                delta: Delta::ToolJson {
                    partial: "{\"a\":1}".into()
                }
            },
        ]
    );
    assert_eq!(
        events.last().expect("last"),
        &end(StopReason::ToolUse, usage(0.0, 0.0, 0.0, 0.0))
    );
}

#[test]
fn maps_an_incomplete_response_with_a_token_cap_onto_max_tokens() {
    let events = drive(&[msg(
        "response.incomplete",
        json!({"response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "usage": {}}}),
    )]);
    assert_eq!(
        events,
        [end(StopReason::MaxTokens, usage(0.0, 0.0, 0.0, 0.0))]
    );
}

#[test]
fn fails_visibly_on_an_incomplete_response_with_an_unrecognized_reason() {
    let events = drive(&[msg(
        "response.incomplete",
        json!({"response": {"status": "incomplete", "incomplete_details": {"reason": "ran_out_of_goodwill"}, "usage": {}}}),
    )]);
    assert_eq!(
        events,
        [error(
            ErrorCode::Upstream,
            "unrecognized xAI incomplete reason \"ran_out_of_goodwill\"",
            false
        )]
    );
}

#[test]
fn fails_visibly_on_an_incomplete_response_that_names_no_reason() {
    let events = drive(&[msg(
        "response.incomplete",
        json!({"response": {"status": "incomplete", "usage": {}}}),
    )]);
    assert_eq!(
        events,
        [error(
            ErrorCode::Upstream,
            "xAI reported the response incomplete without a reason",
            false
        )]
    );
}

#[test]
fn fails_visibly_on_a_bare_incomplete_event_with_an_empty_payload() {
    // The payload arms cannot see this one: no status, no details, no
    // `response` at all. The event's own name is the only thing left saying
    // the turn was cut, which is why the guard keeps it as a backstop.
    let events = drive(&[("response.incomplete", "{}".into())]);
    assert_eq!(
        events,
        [error(
            ErrorCode::Upstream,
            "xAI reported the response incomplete without a reason",
            false
        )]
    );
}

#[test]
fn fails_visibly_on_a_terminal_status_that_is_neither_completed_nor_incomplete() {
    let events = drive(&[msg(
        "response.completed",
        json!({"response": {"status": "cancelled", "usage": {}}}),
    )]);
    assert_eq!(
        events,
        [error(
            ErrorCode::Upstream,
            "xAI reported terminal response status \"cancelled\"",
            false
        )]
    );
}

#[test]
fn an_unrecognized_reason_fails_even_when_the_status_claims_completed() {
    // What keeps the reason arm load-bearing: every other unknown-reason
    // fixture also says `status: "incomplete"`, so the status arm alone would
    // satisfy all of them and deleting the reason check would go unnoticed.
    let events = drive(&[msg(
        "response.completed",
        json!({"response": {"status": "completed", "incomplete_details": {"reason": "weird"}, "usage": {}}}),
    )]);
    assert_eq!(
        events,
        [error(
            ErrorCode::Upstream,
            "unrecognized xAI incomplete reason \"weird\"",
            false
        )]
    );
}

#[test]
fn a_known_event_the_decoder_ignores_does_not_end_the_stream() {
    // What makes the set an allowlist rather than a restatement of the switch.
    // Written from the switch instead, every one of these would fail — and
    // the failure would be a real xAI turn refused by its own gateway.
    let ignored = [
        "response.queued",
        "response.in_progress",
        "response.output_text.done",
        "response.output_text.annotation.added",
        "response.refusal.delta",
        "response.refusal.done",
        "response.reasoning_summary_part.added",
        "response.reasoning_summary_part.done",
        "response.reasoning_summary_text.done",
        "response.reasoning_text.done",
        "response.function_call_arguments.done",
    ];
    for event in ignored {
        let events = drive(&[msg(event, json!({"output_index": 0})), completed()]);
        assert!(
            matches!(events.last(), Some(StreamEvent::End { .. })),
            "{event}: {events:?}"
        );
    }
}

#[test]
fn a_prototype_key_error_code_still_classifies_as_upstream() {
    // `code: "constructor"` must not read a prototype member back out: the
    // lookup is own-property only, so the fallback UPSTREAM fires.
    let events = drive(&[msg(
        "error",
        json!({"error": {"code": "constructor", "message": "boom"}}),
    )]);
    assert_eq!(events, [error(ErrorCode::Upstream, "boom", true)]);
}

#[test]
fn a_done_sentinel_alone_is_skipped_never_read_as_completion() {
    // The skip guard is byte-identical to the openai fork's; a mutant making
    // the sentinel terminal reports a clean short stream.
    let events = drive(&[("message", "[DONE]".into())]);
    assert_eq!(
        events,
        [error(
            ErrorCode::Upstream,
            "upstream stream ended before response completion",
            true
        )]
    );
}

#[test]
fn a_completed_with_no_status_at_all_still_ends_clean() {
    // Pins the guard's deliberate leniency: absent-status streams from
    // compatible proxies must not become refusals.
    let events = drive(&[msg(
        "response.completed",
        json!({"response": {"usage": {}}}),
    )]);
    assert_eq!(
        events.last().expect("last"),
        &end(StopReason::EndTurn, usage(0.0, 0.0, 0.0, 0.0))
    );
}

#[test]
fn subtracts_xais_cached_tokens_out_of_the_prompt_total() {
    let events = drive(&[msg(
        "response.completed",
        json!({"response": {"status": "completed", "usage": {
            "input_tokens": 10, "output_tokens": 5,
            "input_tokens_details": {"cached_tokens": 4}
        }}}),
    )]);
    // xAI counts cached tokens *inside* input_tokens, the reverse of
    // Anthropic's disjoint classes. Leaving them in bills them twice.
    assert_eq!(
        events,
        [end(StopReason::EndTurn, usage(6.0, 5.0, 4.0, 0.0))]
    );
}

#[test]
fn fails_visibly_on_an_sse_event_it_does_not_know() {
    let events = drive(&[
        msg(
            "response.created",
            json!({"response": {"id": "resp_1", "model": "grok-4.6"}}),
        ),
        msg("response.tool_call.invented", json!({"output_index": 0})),
        completed(),
    ]);
    // No authoritative enumeration of xAI's event set exists, so a surprise
    // is reported rather than skipped: skipping would drop content silently.
    assert_eq!(
        events.last().expect("last"),
        &error(
            ErrorCode::Upstream,
            "unrecognized xAI stream event \"response.tool_call.invented\"",
            false
        )
    );
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::End { .. })));
}

#[test]
fn fails_visibly_on_an_unknown_sse_event_whose_data_is_not_json() {
    let events = drive(&[
        msg(
            "response.created",
            json!({"response": {"id": "resp_1", "model": "grok-4.6"}}),
        ),
        ("response.tool_call.invented", "not json at all".into()),
        completed(),
    ]);
    // Parsing before checking the event name would let an unrecognized event
    // hide behind its own payload: the stream would end clean and short.
    assert_eq!(
        events.last().expect("last"),
        &error(
            ErrorCode::Upstream,
            "unrecognized xAI stream event \"response.tool_call.invented\"",
            false
        )
    );
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::End { .. })));
}

#[test]
fn accepts_the_done_sentinel_after_completion_instead_of_an_unknown_event() {
    let events = drive(&[completed(), ("message", "[DONE]".into())]);
    assert_eq!(
        events.last().expect("last"),
        &end(StopReason::EndTurn, usage(0.0, 0.0, 0.0, 0.0))
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, StreamEvent::Error { .. }))
    );
}

#[test]
fn emits_upstream_when_eof_arrives_before_response_completion() {
    let events = drive(&[msg(
        "response.output_text.delta",
        json!({"output_index": 0, "content_index": 0, "delta": "partial"}),
    )]);
    assert_eq!(
        events.last().expect("last"),
        &error(
            ErrorCode::Upstream,
            "upstream stream ended before response completion",
            true
        )
    );
}

#[test]
fn turns_a_response_failed_event_into_an_error_event() {
    let events = drive(&[msg(
        "response.failed",
        json!({"response": {"error": {"code": "rate_limit_exceeded", "message": "slow down"}}}),
    )]);
    assert_eq!(events, [error(ErrorCode::RateLimit, "slow down", true)]);
}
