use omni_ir::stream::{Delta, StreamEvent};
use omni_providers::codec::StreamDecoder;
use omni_providers::custom::decode::{ChatDecoder, ResponsesDecoder};
use omni_providers::sse::SseMessage;
use std::collections::VecDeque;

#[test]
fn many_small_records_and_large_keys_fail_explicitly_without_eviction() {
    for responses in [false, true] {
        for wide in [false, true] {
            let mut decoder: Box<dyn StreamDecoder> = if responses {
                Box::new(ResponsesDecoder::new())
            } else {
                Box::new(ChatDecoder::new())
            };
            let count = if wide { 1100 } else { 4097 };
            let mut failed = false;
            for i in 0..count {
                let key = if wide {
                    format!("{i}{}", "x".repeat(1024))
                } else {
                    i.to_string()
                };
                let (event, data) = if responses {
                    (
                        "response.output_text.delta",
                        serde_json::json!({"output_index":key,"delta":"x"}),
                    )
                } else {
                    (
                        "message",
                        serde_json::json!({"choices":[{"delta":{"tool_calls":[{"index":key,"function":{"arguments":"0"}}]}}]}),
                    )
                };
                let mut out = VecDeque::new();
                if decoder
                    .message(
                        &SseMessage {
                            event: event.into(),
                            data: data.to_string(),
                        },
                        &mut out,
                    )
                    .is_err()
                {
                    assert!(i > 1000, "ordinary headroom");
                    failed = true;
                    break;
                }
                assert!(!out.is_empty()); // Prior successful content already emitted.
            }
            assert!(failed, "responses={responses} wide={wide}");
        }
    }
}

#[test]
fn fragmented_tool_depth_is_enforced_by_both_public_decoders() {
    for responses in [false, true] {
        for depth in [512, 40_000, 40_001] {
            // Quotes, escaped quotes, and brackets inside strings straddle cuts.
            let raw = format!("{}\"[\\\"]\"{}", "[".repeat(depth), "]".repeat(depth));
            let mut decoder: Box<dyn StreamDecoder> = if responses {
                Box::new(ResponsesDecoder::new())
            } else {
                Box::new(ChatDecoder::new())
            };
            let mut reconstructed = String::new();
            let mut failed = false;
            for chunk in raw.as_bytes().chunks(7) {
                let part = std::str::from_utf8(chunk).expect("ASCII");
                let (event, data) = if responses {
                    (
                        "response.function_call_arguments.delta",
                        serde_json::json!({"output_index":0,"delta":part}),
                    )
                } else {
                    (
                        "message",
                        serde_json::json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":part}}]}}]}),
                    )
                };
                let mut out = VecDeque::new();
                if decoder
                    .message(
                        &SseMessage {
                            event: event.into(),
                            data: data.to_string(),
                        },
                        &mut out,
                    )
                    .is_err()
                {
                    failed = true;
                    break;
                }
                for e in out {
                    if let StreamEvent::BlockDelta {
                        delta: Delta::ToolJson { partial },
                        ..
                    } = e
                    {
                        reconstructed.push_str(&partial);
                    }
                }
            }
            assert_eq!(failed, depth > 40_000);
            if !failed {
                assert_eq!(reconstructed, raw);
            }
            drop(decoder); // Cancellation/error ownership is exercised too.
        }
    }
}

#[test]
fn deep_used_and_ignored_fields_keep_content_and_refuse_over_ceiling() {
    std::thread::Builder::new().stack_size(2 * 1024 * 1024).spawn(|| {
        for bound in [200, 512, 40_000, 40_001] {
            for field in ["usage", "ignored"] {
                let nested = format!("{}0{}", "[".repeat(bound - 2), "]".repeat(bound - 2));
                let data = format!(r#"{{"choices":[{{"delta":{{"content":"hello"}}}}],"{field}":{{"extra":{nested}}}}}"#);
                let mut decoder = ChatDecoder::new();
                let mut out = VecDeque::new();
                let result = decoder.message(&SseMessage {event: String::new(), data}, &mut out);
                assert_eq!(result.is_ok(), bound <= 40_000);
                if result.is_ok() { assert!(out.iter().any(|e| matches!(e, StreamEvent::BlockDelta {delta: Delta::Text {text}, ..} if text == "hello"))); }
                let data = format!(r#"{{"delta":"hello","ignored":{{"extra":{nested}}}}}"#);
                let mut decoder = ResponsesDecoder::new();
                let mut out = VecDeque::new();
                let result = decoder.message(&SseMessage {event: "response.output_text.delta".into(), data}, &mut out);
                assert_eq!(result.is_ok(), bound <= 40_000);
                if result.is_ok() { assert!(out.iter().any(|e| matches!(e, StreamEvent::BlockDelta {delta: Delta::Text {text}, ..} if text == "hello"))); }
            }
        }
    }).expect("thread").join().expect("depth-safe");
}
