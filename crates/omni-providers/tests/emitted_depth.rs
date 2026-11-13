use omni_providers::{anthropic::decode::AnthropicDecoder, codec::StreamDecoder, sse::SseMessage};
use std::collections::VecDeque;
#[test]
fn emitted_depth() {
    if std::env::var_os("OMNI_EMITTED_CHILD").is_some() {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                let nested = format!("{}0{}", "[".repeat(39995), "]".repeat(39995));
                for terminal in [false, true] {
                    for render in [false, true] {
                        let mut decoder = AnthropicDecoder::default();
                        let mut out = VecDeque::new();
                        let (event, data) = if terminal {
                            (
                                "message_delta",
                                format!(r#"{{"safeguard_results":{nested}}}"#),
                            )
                        } else {
                            (
                                "content_block_start",
                                format!(
                                    r#"{{"content_block":{{"type":"document","data":{nested}}}}}"#
                                ),
                            )
                        };
                        decoder
                            .message(
                                &SseMessage {
                                    event: event.into(),
                                    data,
                                },
                                &mut out,
                            )
                            .expect("decode");
                        if terminal {
                            decoder
                                .message(
                                    &SseMessage {
                                        event: "message_stop".into(),
                                        data: "{}".into(),
                                    },
                                    &mut out,
                                )
                                .expect("stop");
                        }
                        assert!(!out.is_empty());
                        if render {
                            for event in &out {
                                let cloned = event.clone();
                                assert!(!cloned.to_json().is_empty());
                                drop(cloned);
                            }
                            use omni_dialects::egress::{
                                AnthropicStream, OpenAiStream, ResponsesRender, ResponsesStream,
                                StreamEncoder,
                            };
                            let config = ResponsesRender {
                                request_id: "req".into(),
                                created: 123,
                                custom_tool_names: Default::default(),
                            };
                            for mut encoder in [
                                StreamEncoder::Anthropic(AnthropicStream::new("req")),
                                StreamEncoder::OpenAi(OpenAiStream::new("req", 123)),
                                StreamEncoder::Responses(Box::new(ResponsesStream::new(config))),
                            ] {
                                eprintln!(
                                    "encoder {}",
                                    match &encoder {
                                        StreamEncoder::Anthropic(_) => "anthropic",
                                        StreamEncoder::OpenAi(_) => "openai",
                                        _ => "responses",
                                    }
                                );
                                let mut wire = String::new();
                                for event in &out {
                                    encoder.push(event, &mut wire);
                                }
                                encoder.finish(&mut wire);
                                eprintln!("rendered");
                            }
                            eprintln!("collect terminal={terminal}");
                            drop(omni_ir::stream::collect(out.clone()));
                        }
                        drop(out);
                    }
                }
            })
            .expect("thread")
            .join()
            .expect("join");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args(["--exact", "emitted_depth", "--nocapture"])
        .env("OMNI_EMITTED_CHILD", "1")
        .output()
        .expect("child");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
