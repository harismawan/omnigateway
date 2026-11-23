//! `decodeQoder` pinned against the TS decoder's own tests (`qoder.test.ts`):
//! enveloped control frames, business-code rejection without leaking upstream
//! messages, buffered tool identities, disjoint cache usage, and visible
//! failure on malformed or truncated streams.

use std::collections::VecDeque;

use omni_ir::error::ErrorCode;
use omni_ir::stream::{ContentBlockStart, Delta, StopReason, StreamEvent, Usage};
use omni_providers::codec::{DecodeError, Flow, StreamDecoder};
use omni_providers::qoder::decode::QoderDecoder;
use omni_providers::sse::SseMessage;
use serde_json::{Value, json};

const DONE: &str = "[DONE]";

/// Drives the decoder the way the host does: `finish` runs only when no
/// message ever returned `Flow::Stop`, and nothing is read after one did.
fn drive(payloads: &[String]) -> Result<Vec<StreamEvent>, DecodeError> {
    let mut decoder = QoderDecoder::new();
    let mut out = VecDeque::new();
    let mut stopped = false;
    for data in payloads {
        let flow = decoder.message(
            &SseMessage {
                event: "message".into(),
                data: data.clone(),
            },
            &mut out,
        )?;
        if flow == Flow::Stop {
            stopped = true;
            break;
        }
    }
    if !stopped {
        decoder.finish(&mut out);
    }
    Ok(out.into_iter().collect())
}

fn frame(v: Value) -> String {
    v.to_string()
}

fn envelope(body: &str) -> String {
    frame(json!({"statusCodeValue": 200, "body": body}))
}

fn gateway(err: DecodeError, code: ErrorCode, message: &str) {
    match err {
        DecodeError::Gateway(e) => {
            assert_eq!(e.code, code);
            assert_eq!(e.message, message);
        }
        other => panic!("expected GatewayError {code:?} {message:?}, got {other:?}"),
    }
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
fn business_codes_reject_empty_or_partial_success_without_leaking_upstream_messages() {
    let partial = frame(json!({"choices": [{"delta": {"content": "partial"}}]}));
    for prefix in [vec![], vec![partial.clone()]] {
        for code in [json!(403), json!("403")] {
            let mut payloads = prefix.clone();
            payloads.push(frame(
                json!({"code": code, "message": "sensitive-upstream", "usage": {}}),
            ));
            payloads.push(DONE.into());
            gateway(
                drive(&payloads).expect_err("business code must fail"),
                ErrorCode::Upstream,
                "Qoder business error",
            );
        }
    }
    let events = drive(&[
        frame(json!({"code": "0", "choices": [], "usage": {}})),
        DONE.into(),
    ])
    .expect("code 0 with choices is success");
    assert!(matches!(events.last(), Some(StreamEvent::End { .. })));
}

#[test]
fn enveloped_control_frames_behave_like_direct_controls() {
    let events = drive(&[
        envelope("[NOT_EXCEED_QUOTA]"),
        envelope(r#"[NOTIFICATIONS]#{"notifications":[]}"#),
        frame(json!({"choices": [{"delta": {"content": "ok"}}]})),
        envelope(DONE),
    ])
    .expect("controls");
    assert!(matches!(events.last(), Some(StreamEvent::End { .. })));
    gateway(
        drive(&[envelope("[EXCEED_QUOTA]")]).expect_err("quota"),
        ErrorCode::RateLimit,
        "Qoder quota exceeded",
    );
}

#[test]
fn accumulates_split_tool_identities_before_emitting_complete_correlated_blocks() {
    let events = drive(&[
        frame(json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-split"}]}}]})),
        frame(json!({"choices": [{
            "delta": {"tool_calls": [{"index": 0, "function": {"name": "weather", "arguments": "{}"}}]},
            "finish_reason": "tool_calls"
        }]})),
        DONE.into(),
    ])
    .expect("split identity");
    assert_eq!(
        events,
        [
            StreamEvent::Start {
                id: "".into(),
                model: "".into()
            },
            StreamEvent::BlockStart {
                index: 0,
                block: ContentBlockStart::ToolUse {
                    id: "call-split".into(),
                    name: "weather".into()
                }
            },
            StreamEvent::BlockDelta {
                index: 0,
                delta: Delta::ToolJson {
                    partial: "{}".into()
                }
            },
            StreamEvent::BlockEnd { index: 0 },
            end(StopReason::ToolUse, usage(0.0, 0.0, 0.0, 0.0)),
        ]
    );
    gateway(
        drive(&[
            frame(
                json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "incomplete"}]}}]}),
            ),
            DONE.into(),
        ])
        .expect_err("missing name"),
        ErrorCode::Upstream,
        "Qoder tool call missing identity",
    );
}

#[test]
fn top_level_cache_creation_is_disjoint_from_ordinary_prompt_usage() {
    let events = drive(&[
        frame(json!({
            "choices": [],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 3,
                "cache_creation_input_tokens": 40,
                "prompt_tokens_details": {"cached_tokens": 10}
            }
        })),
        DONE.into(),
    ])
    .expect("usage");
    assert_eq!(
        events.last(),
        Some(&end(StopReason::EndTurn, usage(50.0, 3.0, 10.0, 40.0)))
    );
}

#[test]
fn split_sse_decodes_envelopes_reasoning_tools_and_disjoint_cache_usage() {
    let events = drive(&[
        "[NOT_EXCEED_QUOTA]".into(),
        "[NOTIFICATIONS]#info".into(),
        frame(json!({"choices": [{"delta": {"reasoning_content": "think"}}]})),
        envelope(&frame(json!({"choices": [{"delta": {"content": "hello 雪"}}]}))),
        frame(json!({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "call-1", "function": {"name": "weather", "arguments": "{\"city\":"}}
        ]}}]})),
        frame(json!({"choices": [{
            "delta": {"tool_calls": [{"index": 0, "function": {"arguments": "\"雪\"}"}}]},
            "finish_reason": "tool_calls"
        }]})),
        frame(json!({
            "usage": {"prompt_tokens": 10, "completion_tokens": 3, "prompt_tokens_details": {"cached_tokens": 4}},
            "choices": []
        })),
        DONE.into(),
    ])
    .expect("split stream");
    assert_eq!(
        events,
        [
            StreamEvent::Start {
                id: "".into(),
                model: "".into()
            },
            StreamEvent::BlockStart {
                index: 0,
                block: ContentBlockStart::Thinking {
                    signed: Some(false)
                }
            },
            StreamEvent::BlockDelta {
                index: 0,
                delta: Delta::Thinking {
                    text: "think".into()
                }
            },
            StreamEvent::BlockEnd { index: 0 },
            StreamEvent::BlockStart {
                index: 1,
                block: ContentBlockStart::Text
            },
            text_delta(1, "hello 雪"),
            // The text block stays open across buffered tool deltas and
            // closes only at the flush, before the tool blocks emit.
            StreamEvent::BlockEnd { index: 1 },
            StreamEvent::BlockStart {
                index: 2,
                block: ContentBlockStart::ToolUse {
                    id: "call-1".into(),
                    name: "weather".into()
                }
            },
            StreamEvent::BlockDelta {
                index: 2,
                delta: Delta::ToolJson {
                    partial: "{\"city\":\"雪\"}".into()
                }
            },
            StreamEvent::BlockEnd { index: 2 },
            end(StopReason::ToolUse, usage(6.0, 3.0, 4.0, 0.0)),
        ]
    );
}

#[test]
fn malformed_quota_business_error_and_truncated_streams_never_silently_succeed() {
    gateway(
        drive(&["[EXCEED_QUOTA]".into()]).expect_err("quota"),
        ErrorCode::RateLimit,
        "Qoder quota exceeded",
    );
    gateway(
        drive(&["not-json".into()]).expect_err("malformed"),
        ErrorCode::Upstream,
        "Malformed Qoder stream",
    );
    gateway(
        drive(&[frame(json!({"statusCodeValue": 403, "body": "sensitive"}))])
            .expect_err("rejected envelope"),
        ErrorCode::Upstream,
        "Qoder stream rejected",
    );
    gateway(
        drive(&[frame(
            json!({"error": {"code": "bad", "message": "sensitive"}}),
        )])
        .expect_err("error record"),
        ErrorCode::Upstream,
        "Qoder business error",
    );
    // Truncation surfaces as the host-visible error event, never a clean end.
    let partial = frame(json!({"choices": [{"delta": {"content": "partial"}}]}));
    let events = drive(std::slice::from_ref(&partial)).expect("truncated stream");
    assert_eq!(
        events.last(),
        Some(&StreamEvent::Error {
            code: ErrorCode::Upstream,
            message: "Truncated Qoder stream".into(),
            retryable: ErrorCode::Upstream.retryable(),
        })
    );
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::End { .. })));
    gateway(
        drive(&[partial, "[EXCEED_QUOTA]".into()]).expect_err("quota after partial"),
        ErrorCode::RateLimit,
        "Qoder quota exceeded",
    );
}

#[test]
fn interleaved_tool_deltas_stay_inside_their_own_open_content_blocks() {
    let events = drive(&[
        frame(json!({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "a", "function": {"name": "one", "arguments": "{"}},
            {"index": 1, "id": "b", "function": {"name": "two", "arguments": "{"}}
        ]}}]})),
        frame(json!({"choices": [{
            "delta": {"tool_calls": [
                {"index": 1, "function": {"arguments": "}"}},
                {"index": 0, "function": {"arguments": "}"}}
            ]},
            "finish_reason": "tool_calls"
        }]})),
        DONE.into(),
    ])
    .expect("interleaved");
    let mut current: Option<u32> = None;
    for event in &events {
        match event {
            StreamEvent::BlockStart { index, .. } => {
                assert_eq!(current, None);
                current = Some(*index);
            }
            StreamEvent::BlockDelta { index, .. } => assert_eq!(current, Some(*index)),
            StreamEvent::BlockEnd { index } => {
                assert_eq!(current, Some(*index));
                current = None;
            }
            _ => {}
        }
    }
    assert_eq!(current, None);
    // First-seen order survives the reversed argument deltas.
    let starts: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::BlockStart {
                block: ContentBlockStart::ToolUse { id, name },
                ..
            } => Some((id.as_utf8(), name.as_utf8())),
            _ => None,
        })
        .collect();
    assert_eq!(starts, [(Some("a"), Some("one")), (Some("b"), Some("two"))]);
}

#[test]
fn error_presence_short_circuits_before_code_coercion() {
    // TS's `||` checks `"error" in chunk` (and `success === false`) before
    // `String(chunk.code)` ever runs, so a hostile `code` object cannot turn
    // a business error into a coercion throw.
    for record in [
        json!({"error": "boom", "code": {"toString": 1}}),
        json!({"success": false, "code": {"toString": 1}}),
    ] {
        gateway(
            drive(&[frame(record)]).expect_err("business error must fail"),
            ErrorCode::Upstream,
            "Qoder business error",
        );
    }
    // Without an error or success flag the coercion still runs, and still
    // throws as `String({toString: 1})` does in JS.
    let err = drive(&[frame(json!({"code": {"toString": 1}}))]).expect_err("coercion must throw");
    assert!(matches!(err, DecodeError::Throw(_)), "{err:?}");
}
