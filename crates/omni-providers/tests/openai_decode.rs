use omni_providers::{
    codec::{Flow, StreamDecoder},
    openai::decode::OpenAiDecoder,
    sse::SseParser,
};
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
#[test]
fn frozen_decoder_chunkings() {
    let run = std::process::Command::new("bun")
        .arg("tests/openai-decode-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("corpus");
    for (i, row) in rows.as_array().expect("rows").iter().enumerate() {
        let bytes = row["wire"].as_str().expect("wire").as_bytes();
        for chunk in [bytes.len().max(1), 1, 7] {
            let mut parser = SseParser::new();
            let mut messages = Vec::new();
            for b in bytes.chunks(chunk) {
                parser.push(b, &mut messages).expect("parse");
            }
            if let Some(m) = parser.finish() {
                messages.push(m);
            }
            let mut decoder = OpenAiDecoder::new(row["native"].as_bool().expect("native"));
            let mut out = VecDeque::new();
            let mut stopped = false;
            for m in messages {
                if matches!(decoder.message(&m, &mut out).expect("decode"), Flow::Stop) {
                    stopped = true;
                    break;
                }
            }
            if !stopped {
                decoder.finish(&mut out);
            }
            let events: Vec<_> = out
                .iter()
                .map(|e| serde_json::from_str(&e.to_json()).expect("event"))
                .collect();
            assert_eq!(
                serde_json::Value::Array(events),
                row["events"],
                "case {i}, chunk {chunk}"
            );
            let collected = omni_ir::stream::collect(out);
            use omni_dialects::egress;
            let render = egress::ResponsesRender {
                request_id: "req".into(),
                created: 123,
                custom_tool_names: Default::default(),
            };
            for (j, value) in [
                egress::anthropic::response(&collected, "req"),
                egress::openai::response(&collected, "req", 123),
                egress::responses::response(&collected, &render),
            ]
            .iter()
            .enumerate()
            {
                assert_eq!(
                    omni_ir::jsjson::to_string(&value.0),
                    row["json"][j].as_str().expect("json"),
                    "collected {i}/{chunk}/{j}"
                );
            }
        }
    }
}
