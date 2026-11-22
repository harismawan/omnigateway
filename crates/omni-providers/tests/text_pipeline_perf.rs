//! Run serially with --release --ignored --nocapture. No network or gateway.
use omni_dialects::egress::{
    AnthropicStream, OpenAiStream, ResponsesRender, ResponsesStream, StreamEncoder,
};
use omni_providers::{codec::StreamDecoder, custom::decode::ChatDecoder, sse::SseMessage};
use std::{collections::VecDeque, hint::black_box, time::Instant};

#[test]
#[ignore = "serial release microbenchmark"]
fn text_pipeline() {
    let msg = SseMessage { event: String::new(), data: r#"{"id":"chatcmpl-bench","model":"mock","choices":[{"index":0,"delta":{"content":"lorem ipsum "}}]}"#.into() };
    for dialect in ["openai", "anthropic", "responses"] {
        let mut decoder = ChatDecoder::new();
        let mut encoder = match dialect {
            "openai" => StreamEncoder::OpenAi(OpenAiStream::new("req", 0)),
            "anthropic" => StreamEncoder::Anthropic(AnthropicStream::new("req")),
            _ => StreamEncoder::Responses(Box::new(ResponsesStream::new(ResponsesRender {
                request_id: "req".into(),
                created: 0,
                custom_tool_names: Default::default(),
            }))),
        };
        let mut queue = VecDeque::new();
        let mut wire = String::with_capacity(4096);
        // Initialize start/block state outside the timed steady-state deltas.
        decoder.message(&msg, &mut queue).expect("decode");
        while let Some(event) = queue.pop_front() {
            encoder.push_owned(event, &mut wire);
        }
        for round in 0..5 {
            let start = Instant::now();
            for _ in 0..2_000_000 {
                decoder
                    .message(black_box(&msg), &mut queue)
                    .expect("decode");
                while let Some(event) = queue.pop_front() {
                    encoder.push_owned(event, &mut wire);
                }
                black_box(&wire);
                wire.clear();
            }
            eprintln!(
                "{dialect} round={round} ns/event={:.2}",
                start.elapsed().as_nanos() as f64 / 2_000_000.0
            );
        }
    }
}
