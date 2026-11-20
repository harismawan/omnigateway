use omni_dialects::egress::{
    self, AnthropicStream, OpenAiStream, ResponsesRender, ResponsesStream, StreamEncoder,
};
use omni_providers::{anthropic::decode::AnthropicDecoder, codec::StreamDecoder, sse::SseMessage};
#[test]
fn decoded_client_json_and_sse_bytes_match_ts() {
    let run = std::process::Command::new("bun")
        .arg("tests/anthropic-output-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("corpus");
    for row in rows.as_array().expect("rows") {
        let mut decoder = AnthropicDecoder::default();
        let mut events = std::collections::VecDeque::new();
        for m in row["messages"].as_array().expect("messages") {
            decoder
                .message(
                    &SseMessage {
                        event: m["event"].as_str().expect("event").into(),
                        data: m["data"].as_str().expect("data").into(),
                    },
                    &mut events,
                )
                .expect("decode");
        }
        decoder.finish(&mut events);
        let render = ResponsesRender {
            request_id: "req".into(),
            created: 123,
            custom_tool_names: Default::default(),
        };
        let mut encoders = [
            StreamEncoder::Anthropic(AnthropicStream::new("req")),
            StreamEncoder::OpenAi(OpenAiStream::new("req", 123)),
            StreamEncoder::Responses(Box::new(ResponsesStream::new(render.clone()))),
        ];
        for (i, encoder) in encoders.iter_mut().enumerate() {
            let mut out = String::new();
            for e in &events {
                encoder.push(e, &mut out);
            }
            encoder.finish(&mut out);
            assert_eq!(out, row["streams"][i].as_str().expect("stream"));
        }
        let collected = omni_ir::stream::collect(events);
        for (i, value) in [
            egress::anthropic::response(&collected, "req"),
            egress::openai::response(&collected, "req", 123),
            egress::responses::response(&collected, &render),
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(
                omni_ir::jsjson::to_string(value),
                row["json"][i].as_str().expect("JSON")
            );
        }
    }
}
