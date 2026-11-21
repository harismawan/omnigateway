use omni_providers::{codec::StreamDecoder, openai::decode::OpenAiDecoder};
use std::collections::VecDeque;
#[test]
fn decoder_depth() {
    if let Ok(case) = std::env::var("OPENAI_DECODE_DEPTH") {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                use omni_providers::sse::SseMessage;
                let nested = format!("{}0{}", "[".repeat(39990), "]".repeat(39990));
                let mut decoder = OpenAiDecoder::new(true);
                let mut out = VecDeque::new();
                let messages = match case.as_str() {
                    "arguments" => vec![
                        (
                            "response.output_item.added",
                            r#"{"item":{"type":"function_call","call_id":"c","name":"f"}}"#.into(),
                        ),
                        (
                            "response.function_call_arguments.delta",
                            format!(
                                "{{\"delta\":{}}}",
                                serde_json::to_string(&nested).expect("string")
                            ),
                        ),
                    ],
                    "native" => vec![
                        (
                            "response.output_item.added",
                            r#"{"item":{"type":"reasoning"}}"#.into(),
                        ),
                        (
                            "response.output_item.done",
                            format!("{{\"item\":{{\"type\":\"reasoning\",\"payload\":{nested}}}}}"),
                        ),
                    ],
                    "unknown" => vec![(
                        "response.output_item.added",
                        format!("{{\"item\":{{\"type\":\"unknown\",\"payload\":{nested}}}}}"),
                    )],
                    _ => vec![("error", format!("{{\"error\":{{\"message\":{nested}}}}}"))],
                };
                for (event, data) in messages {
                    decoder
                        .message(
                            &SseMessage {
                                event: event.into(),
                                data,
                            },
                            &mut out,
                        )
                        .expect("decode");
                }
                decoder.finish(&mut out);
                drop(decoder);
                let collected = omni_ir::stream::collect(out);
                drop(collected);
            })
            .expect("thread")
            .join()
            .expect("join");
        return;
    }
    for case in ["arguments", "native", "unknown", "error"] {
        let run = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", "decoder_depth"])
            .env("OPENAI_DECODE_DEPTH", case)
            .output()
            .expect("child");
        assert!(
            run.status.success(),
            "{case}: {}",
            String::from_utf8_lossy(&run.stderr)
        );
    }
}
