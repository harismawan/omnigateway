use omni_providers::{anthropic::decode::AnthropicDecoder, codec::StreamDecoder, sse::SseMessage};
use std::collections::VecDeque;
#[test]
fn emitted_depth() {
    if std::env::var_os("OMNI_EMITTED_CHILD").is_some() {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                let nested = format!("{}0{}", "[".repeat(39990), "]".repeat(39990));
                replacement_matrix(&nested);
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
                                StreamEncoder::Responses(Box::new(ResponsesStream::new(
                                    config.clone(),
                                ))),
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
                                    encoder.push_owned(event.clone(), &mut wire);
                                }
                                encoder.finish(&mut wire);
                                eprintln!("rendered");
                            }
                            eprintln!("collect terminal={terminal}");
                            let collected = omni_ir::stream::collect(out.clone());
                            let mut repeated = out.clone();
                            repeated.extend(out.clone());
                            drop(omni_ir::stream::collect(repeated));
                            for value in [
                                omni_dialects::egress::anthropic::response(&collected, "req"),
                                omni_dialects::egress::openai::response(&collected, "req", 123),
                                omni_dialects::egress::responses::response(&collected, &config),
                            ] {
                                assert!(!omni_ir::jsjson::to_string(&value.0).is_empty());
                            }
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

fn replacement_matrix(nested: &str) {
    use omni_dialects::egress::*;
    let config = ResponsesRender {
        request_id: "req".into(),
        created: 0,
        custom_tool_names: Default::default(),
    };
    for kind in [
        "text",
        "thinking",
        "tool_use",
        "server_tool_use",
        "web_search_tool_result",
        "web_fetch_tool_result",
        "code_execution_tool_result",
        "bash_code_execution_tool_result",
        "text_editor_code_execution_tool_result",
        "mcp_tool_use",
        "mcp_tool_result",
        "tool_search_tool_result",
        "tool_reference",
        "advisor_tool_result",
        "advisor_result",
        "advisor_redacted_result",
        "container_upload",
        "compaction",
        "search_result",
        "document",
        "mid_conv_system",
        "tool_addition",
        "tool_removal",
        "fallback",
        "redacted_thinking",
    ] {
        for field in ["content", "encrypted_content", "citation"] {
            for mode in ["start", "merge", "input", "error"] {
                eprintln!("matrix {kind}/{field}/{mode}");
                let delta_type = if field == "citation" {
                    "citations_delta"
                } else {
                    "compaction_delta"
                };
                let mut decoder = AnthropicDecoder::default();
                let mut queue = VecDeque::new();
                let mut send = |event: &str, data: String| {
                    decoder
                        .message(
                            &SseMessage {
                                event: event.into(),
                                data,
                            },
                            &mut queue,
                        )
                        .expect("decode replacement fixture");
                };
                send(
                    "content_block_start",
                    format!(
                        r#"{{"index":0,"content_block":{{"type":"{kind}","content":{nested},"encrypted_content":{nested},"citations":[{nested}],"input":{nested}}}}}"#
                    ),
                );
                if mode == "merge" {
                    send(
                        "content_block_delta",
                        format!(
                            r#"{{"index":0,"delta":{{"type":"{delta_type}","{field}":{nested}}}}}"#
                        ),
                    );
                }
                if mode == "input" || mode == "error" {
                    if matches!(kind, "text" | "thinking") {
                        send(
                            "content_block_delta",
                            format!(
                                r#"{{"index":0,"delta":{{"type":"{delta_type}","{field}":{nested}}}}}"#
                            ),
                        );
                        send(
                            "content_block_start",
                            format!(
                                r#"{{"index":1,"content_block":{{"type":"document","input":{nested}}}}}"#
                            ),
                        );
                    }
                    let json = if mode == "error" {
                        format!("{}0{}", "[".repeat(40001), "]".repeat(40001))
                    } else {
                        format!("{}0{}", "[".repeat(39990), "]".repeat(39990))
                    };
                    let index = u32::from(matches!(kind, "text" | "thinking"));
                    send("content_block_delta", serde_json::json!({"index":index,"delta":{"type":"input_json_delta","partial_json":json}}).to_string());
                } else {
                    send(
                        "content_block_delta",
                        format!(
                            r#"{{"index":0,"delta":{{"type":"{delta_type}","{field}":{nested}}}}}"#
                        ),
                    );
                }
                assert!(queue.len() >= 2);
                for mut encoder in [
                    StreamEncoder::Anthropic(AnthropicStream::new("req")),
                    StreamEncoder::OpenAi(OpenAiStream::new("req", 0)),
                    StreamEncoder::Responses(Box::new(ResponsesStream::new(config.clone()))),
                ] {
                    let mut wire = String::new();
                    for event in &queue {
                        encoder.push_owned(event.clone(), &mut wire);
                    }
                    encoder.finish(&mut wire);
                }
                let result = omni_ir::stream::try_collect(queue);
                if mode == "error" {
                    assert!(result.is_err());
                    continue;
                }
                let collected = result.expect("collect replacement fixture");
                for value in [
                    anthropic::response(&collected, "req"),
                    openai::response(&collected, "req", 0),
                    responses::response(&collected, &config),
                ] {
                    drop(value);
                }
            }
        }
    }
}
