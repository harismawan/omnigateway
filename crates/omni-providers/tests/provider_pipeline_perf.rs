//! Run serially with --release --ignored --nocapture. No network or gateway.
use omni_dialects::egress::{
    AnthropicStream, OpenAiStream, ResponsesRender, ResponsesStream, StreamEncoder,
};
use omni_ir::stream::StreamEvent;
use omni_providers::{
    codec::{Flow, StreamDecoder},
    grok::decode::GrokDecoder,
    kilo::decode::KiloDecoder,
    kimi::decode::KimiDecoder,
    muse::decode::MuseDecoder,
    qoder::decode::QoderDecoder,
    sse::SseMessage,
};
use std::{collections::VecDeque, hint::black_box, time::Instant};

fn msg(event: &str, data: &str) -> SseMessage {
    SseMessage {
        event: event.into(),
        data: data.into(),
    }
}

struct Provider {
    name: &'static str,
    decoder: fn() -> Box<dyn StreamDecoder>,
    init: Vec<SseMessage>,
    steady: SseMessage,
    terminal: SseMessage,
}

fn chat_provider(name: &'static str, decoder: fn() -> Box<dyn StreamDecoder>) -> Provider {
    Provider {
        name,
        decoder,
        init: vec![msg(
            "",
            r#"{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"lorem ipsum "}}]}"#,
        )],
        steady: msg(
            "",
            r#"{"choices":[{"index":0,"delta":{"content":"lorem ipsum "}}]}"#,
        ),
        terminal: msg("", "[DONE]"),
    }
}

fn responses_provider(name: &'static str, decoder: fn() -> Box<dyn StreamDecoder>) -> Provider {
    Provider {
        name,
        decoder,
        init: vec![
            msg(
                "response.created",
                r#"{"response":{"id":"r1","model":"m"}}"#,
            ),
            msg(
                "response.output_item.added",
                r#"{"output_index":0,"item":{"id":"m1","type":"message","role":"assistant","content":[]}}"#,
            ),
            msg(
                "response.content_part.added",
                r#"{"output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}"#,
            ),
        ],
        steady: msg(
            "response.output_text.delta",
            r#"{"output_index":0,"content_index":0,"delta":"lorem ipsum "}"#,
        ),
        terminal: msg(
            "response.completed",
            r#"{"response":{"status":"completed","usage":{}}}"#,
        ),
    }
}

fn encoder_for(dialect: &str) -> StreamEncoder {
    match dialect {
        "openai" => StreamEncoder::OpenAi(OpenAiStream::new("req", 0)),
        "anthropic" => StreamEncoder::Anthropic(AnthropicStream::new("req")),
        _ => StreamEncoder::Responses(Box::new(ResponsesStream::new(ResponsesRender {
            request_id: "req".into(),
            created: 0,
            custom_tool_names: Default::default(),
        }))),
    }
}

/// Drive like the host: finish() only when no message returned Flow::Stop.
fn drive(
    decoder: &mut dyn StreamDecoder,
    messages: &[SseMessage],
    out: &mut VecDeque<StreamEvent>,
) {
    for m in messages {
        if decoder.message(m, out).expect("decode") == Flow::Stop {
            return;
        }
    }
    decoder.finish(out);
}

#[test]
#[ignore = "serial release microbenchmark"]
fn provider_pipeline() {
    let providers = [
        chat_provider("kimi", || Box::new(KimiDecoder::new())),
        chat_provider("kilo", || Box::new(KiloDecoder::new())),
        responses_provider("grok", || Box::new(GrokDecoder::new())),
        responses_provider("muse", || Box::new(MuseDecoder::new(false))),
        Provider {
            name: "qoder",
            decoder: || Box::new(QoderDecoder::new()),
            init: vec![msg(
                "message",
                r#"{"id":"c1","model":"m","choices":[{"delta":{"content":"lorem ipsum "}}]}"#,
            )],
            steady: msg(
                "message",
                r#"{"choices":[{"delta":{"content":"lorem ipsum "}}]}"#,
            ),
            terminal: msg("message", "[DONE]"),
        },
    ];
    for provider in &providers {
        let mut events = VecDeque::new();
        let mut messages = provider.init.clone();
        messages.push(provider.steady.clone());
        messages.push(provider.terminal.clone());
        drive((provider.decoder)().as_mut(), &messages, &mut events);
        assert!(
            matches!(events.back(), Some(StreamEvent::End { .. })),
            "{} preflight did not end cleanly: {:?}",
            provider.name,
            events.back()
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, StreamEvent::Error { .. })),
            "{} preflight emitted an error",
            provider.name
        );
        for dialect in ["openai", "anthropic", "responses"] {
            let mut decoder = (provider.decoder)();
            let mut encoder = encoder_for(dialect);
            let mut queue = VecDeque::new();
            let mut wire = String::with_capacity(4096);
            // Initialize start/block state outside the timed steady-state deltas.
            for m in &provider.init {
                decoder.message(m, &mut queue).expect("decode");
                while let Some(event) = queue.pop_front() {
                    encoder.push_owned(event, &mut wire);
                }
            }
            for round in 0..5 {
                let start = Instant::now();
                for _ in 0..500_000 {
                    decoder
                        .message(black_box(&provider.steady), &mut queue)
                        .expect("decode");
                    while let Some(event) = queue.pop_front() {
                        encoder.push_owned(event, &mut wire);
                    }
                    black_box(&wire);
                    wire.clear();
                }
                eprintln!(
                    "{}/{dialect} round={round} ns/event={:.2}",
                    provider.name,
                    start.elapsed().as_nanos() as f64 / 500_000.0
                );
            }
        }
    }
}
