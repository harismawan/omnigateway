use omni_ir::stream::{Delta, StreamEvent};
use omni_providers::codec::StreamDecoder;
use omni_providers::custom::decode::{ChatDecoder, ResponsesDecoder};
use omni_providers::sse::SseMessage;
use std::collections::VecDeque;

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
