use omni_ir::stream::{Delta, StreamEvent};
use omni_providers::codec::StreamDecoder;
use omni_providers::custom::decode::{ChatDecoder, ResponsesDecoder};
use omni_providers::sse::SseMessage;
use std::collections::VecDeque;

#[test]
fn exact_identity_limits_preserve_late_fragments() {
    let mut decoder = ChatDecoder::new();
    let mut out = VecDeque::new();
    let mut feed = |key: &str, part: &str| {
        out.clear();
        decoder.message(&SseMessage { event:"message".into(), data:serde_json::json!({"choices":[{"delta":{"tool_calls":[{"index":key,"function":{"arguments":part}}]}}]}).to_string() }, &mut out)
    };
    // 4096 distinct keys, exactly 1 MiB retained string bytes.
    let key = |i: usize| format!("{i:0256}");
    for i in 0..4096 {
        assert!(feed(&key(i), " ").is_ok());
    }
    assert!(
        feed(&key(0), "0").is_ok(),
        "late original identity retained at both limits"
    );
    assert!(feed("new", "0").is_err());
}

#[test]
fn deep_syntax_errors_and_ignored_native_payloads_drop_on_worker_stack() {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            let nested = format!("{}0{}", "[".repeat(39_996), "]".repeat(39_996));
            let mut decoder = ResponsesDecoder::new();
            for data in [
                format!(r#"{{"item":{{"type":"unknown_native","data":{nested}}}}}"#),
                format!(r#"{{"item":{{"type":"unknown_native","data":{nested}}}}} trailing"#),
            ] {
                let mut out = VecDeque::new();
                assert!(
                    decoder
                        .message(
                            &SseMessage {
                                event: "response.output_item.added".into(),
                                data
                            },
                            &mut out
                        )
                        .is_ok()
                );
                assert!(out.is_empty());
            }
            drop(decoder);
        })
        .expect("thread")
        .join()
        .expect("teardown");
}

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
