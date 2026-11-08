//! `collect()` parity, ported from `packages/ir/test/stream.test.ts`, plus the
//! canonical JSON form the vector suites compare against.

use omni_ir::request::{ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock};
use omni_ir::stream::{ContentBlockStart, Delta, StopReason, StreamEvent, Usage, collect};
use serde_json::json;

fn usage(input: f64, output: f64) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        ..Usage::default()
    }
}

fn tool_use(input: serde_json::Value) -> ContentBlock {
    ContentBlock::ToolUse(ToolUseBlock {
        id: "t1".into(),
        name: "get".into(),
        input,
        cache_control: None,
    })
}

fn start() -> StreamEvent {
    StreamEvent::Start {
        id: "m".into(),
        model: "x".into(),
    }
}

fn delta(index: u32, delta: Delta) -> StreamEvent {
    StreamEvent::BlockDelta { index, delta }
}

fn end(stop: StopReason) -> StreamEvent {
    StreamEvent::End {
        stop_reason: stop,
        usage: Usage::default(),
        vendor: None,
    }
}

#[test]
fn collect_assembles_text_deltas_into_one_block() {
    let r = collect([
        StreamEvent::Start {
            id: "msg_1".into(),
            model: "claude-opus-4".into(),
        },
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        },
        delta(0, Delta::Text { text: "Hel".into() }),
        delta(0, Delta::Text { text: "lo".into() }),
        StreamEvent::BlockEnd { index: 0 },
        StreamEvent::End {
            stop_reason: StopReason::EndTurn,
            usage: usage(10.0, 2.0),
            vendor: None,
        },
    ]);
    assert_eq!(
        r.content,
        vec![ContentBlock::Text(TextBlock {
            text: "Hello".into(),
            cache_control: None,
            citations: None
        })]
    );
    assert_eq!(r.stop_reason, StopReason::EndTurn);
    assert_eq!(r.usage, usage(10.0, 2.0));
    assert_eq!(r.id, "msg_1");
    assert_eq!(r.model, "claude-opus-4");
}

#[test]
fn collect_assembles_tool_json_deltas_into_tool_use_input() {
    let r = collect([
        start(),
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::ToolUse {
                id: "t1".into(),
                name: "get".into(),
            },
        },
        delta(
            0,
            Delta::ToolJson {
                partial: "{\"a\":".into(),
            },
        ),
        delta(
            0,
            Delta::ToolJson {
                partial: "1}".into(),
            },
        ),
        StreamEvent::BlockEnd { index: 0 },
        end(StopReason::ToolUse),
    ]);
    assert_eq!(r.content, vec![tool_use(json!({"a": 1}))]);
}

#[test]
fn collect_preserves_thinking_text_and_concatenates_signature() {
    let r = collect([
        start(),
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::Thinking { signed: Some(true) },
        },
        delta(0, Delta::Thinking { text: "hmm".into() }),
        delta(
            0,
            Delta::ThinkingSignature {
                signature: "sig".into(),
            },
        ),
        delta(
            0,
            Delta::ThinkingSignature {
                signature: "123".into(),
            },
        ),
        StreamEvent::BlockEnd { index: 0 },
        end(StopReason::EndTurn),
    ]);
    assert_eq!(
        r.content,
        vec![ContentBlock::Thinking(ThinkingBlock {
            text: "hmm".into(),
            signature: Some("sig123".into())
        })]
    );
}

#[test]
fn collect_orders_blocks_by_index_not_arrival() {
    let r = collect([
        start(),
        StreamEvent::BlockStart {
            index: 1,
            block: ContentBlockStart::Text,
        },
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        },
        delta(
            1,
            Delta::Text {
                text: "second".into(),
            },
        ),
        delta(
            0,
            Delta::Text {
                text: "first".into(),
            },
        ),
        end(StopReason::EndTurn),
    ]);
    let texts: Vec<_> = r
        .content
        .iter()
        .map(|b| match b {
            ContentBlock::Text(t) => t.text.as_str(),
            _ => "?",
        })
        .collect();
    assert_eq!(texts, ["first", "second"]);
}

#[test]
fn collect_tolerates_truncated_tool_json_and_missing_end() {
    let r = collect([
        start(),
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::ToolUse {
                id: "t1".into(),
                name: "get".into(),
            },
        },
        delta(
            0,
            Delta::ToolJson {
                partial: "{not json".into(),
            },
        ),
    ]);
    assert_eq!(r.content, vec![tool_use(json!({}))]);
    // No `end` means no usage was reported: zero, and the default stop.
    assert_eq!(r.usage, Usage::default());
    assert_eq!(r.stop_reason, StopReason::EndTurn);
}

#[test]
fn events_render_in_the_ts_shape() {
    let events = [
        StreamEvent::Start {
            id: "a".into(),
            model: String::new(),
        },
        StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::Thinking { signed: None },
        },
        StreamEvent::BlockStart {
            index: 1,
            block: ContentBlockStart::ToolUse {
                id: "c".into(),
                name: "n".into(),
            },
        },
        delta(
            1,
            Delta::ToolJson {
                partial: "{}".into(),
            },
        ),
        StreamEvent::BlockEnd { index: 1 },
        StreamEvent::End {
            stop_reason: StopReason::MaxTokens,
            usage: Usage {
                input_tokens: f64::NAN,
                output_tokens: 1e21,
                cache_read_tokens: 0.5,
                cache_write_tokens: 0.0,
                ..Usage::default()
            },
            vendor: None,
        },
        StreamEvent::Error {
            code: omni_ir::error::ErrorCode::Upstream,
            message: "m".into(),
            retryable: false,
        },
    ];
    let rendered: Vec<String> = events.iter().map(StreamEvent::to_json).collect();
    assert_eq!(
        rendered,
        [
            r#"{"type":"start","id":"a","model":""}"#,
            r#"{"type":"blockStart","index":0,"block":{"type":"thinking"}}"#,
            r#"{"type":"blockStart","index":1,"block":{"type":"toolUse","id":"c","name":"n"}}"#,
            r#"{"type":"blockDelta","index":1,"delta":{"type":"toolJson","partial":"{}"}}"#,
            r#"{"type":"blockEnd","index":1}"#,
            r#"{"type":"end","stopReason":"maxTokens","usage":{"inputTokens":null,"outputTokens":1e+21,"cacheReadTokens":0.5,"cacheWriteTokens":0}}"#,
            r#"{"type":"error","code":"UPSTREAM","message":"m","retryable":false}"#,
        ]
    );
}

#[test]
fn tool_result_entries_serialize_with_their_ts_discriminants() {
    let block: omni_ir::request::ContentBlock = serde_json::from_value(serde_json::json!({
        "type": "toolResult", "toolUseId": "t", "content": "",
        "images": [{"type": "image", "mediaType": "image/png", "data": "A"}],
        "files": [{"mediaType": "application/pdf", "data": "B", "filename": "f"}],
        "native": [{"type": "providerNative", "provider": "anthropic", "blockType": "document", "data": {"x": 1}}]
    }))
    .expect("deserialize");
    assert_eq!(
        serde_json::to_string(&block).expect("serialize"),
        r#"{"type":"toolResult","toolUseId":"t","content":"","images":[{"type":"image","mediaType":"image/png","data":"A"}],"files":[{"type":"file","mediaType":"application/pdf","data":"B","filename":"f"}],"native":[{"type":"providerNative","provider":"anthropic","blockType":"document","data":{"x":1}}]}"#
    );
}
