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
    compare_decoder(false);
}

#[test]
#[ignore = "parked: roadmap X1 (non-numeric upstream usage counts)"]
fn malformed_usage_matches_ts() {
    compare_decoder(true);
}

fn compare_decoder(malformed_usage: bool) {
    compare_decoder_mode(malformed_usage, false);
}

#[test]
fn oauth_codec_decoder_chunkings() {
    compare_decoder_mode(false, true);
}

fn compare_decoder_mode(malformed_usage: bool, codec: bool) {
    let run = std::process::Command::new("bun")
        .arg(if codec {
            "tests/openai-oauth-decode-reference.ts"
        } else {
            "tests/openai-decode-reference.ts"
        })
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("corpus");
    let mut mismatches = Vec::new();
    for (i, row) in rows.as_array().expect("rows").iter().enumerate() {
        let usage_only = row["category"] == "coercion-usage"
            && ["outputTokens", "cacheReadTokens"].iter().any(|field| {
                let value = &row["events"][0]["usage"][field];
                !value.is_number() && !value.is_null()
            });
        if usage_only != malformed_usage {
            continue;
        }
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
            let mut decoder: Box<dyn StreamDecoder> = if codec {
                use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
                use omni_providers::openai::OpenAiCodec;
                let request = serde_json::from_value(row["request"].clone()).expect("request");
                let credentials = Credentials {
                    access_token: Some("oauth-token".into()),
                    api_key: None,
                    provider_data: Default::default(),
                };
                let built = OpenAiCodec
                    .build_request(&CodecInput {
                        request: &request,
                        model: "gpt-6-astra",
                        credentials: &credentials,
                        request_id: Some("req"),
                        request_started_at: Some(123.0),
                        auto_cache_enabled: None,
                        max_output_tokens: None,
                    })
                    .expect("OAuth build");
                assert_eq!(built.decode_state, row["native"].as_bool().expect("native"));
                OpenAiCodec.decoder(built.decode_state, &Default::default())
            } else {
                Box::new(OpenAiDecoder::new(row["native"].as_bool().expect("native")))
            };
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
            let actual = serde_json::Value::Array(events);
            if actual != row["events"] {
                eprintln!(
                    "case {i} {} chunk {chunk} events\nRust: {actual}\nTS: {}",
                    row["category"], row["events"]
                );
                mismatches.push(format!("{i}/{chunk}/events"));
            }
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
                let actual = omni_ir::jsjson::to_string(&value.0);
                if actual != row["json"][j].as_str().expect("json") {
                    eprintln!(
                        "case {i} {} chunk {chunk} client {j}\nRust: {actual}\nTS: {}",
                        row["category"], row["json"][j]
                    );
                    mismatches.push(format!("{i}/{chunk}/client-{j}"));
                }
            }
        }
    }
    assert!(mismatches.is_empty(), "mismatches: {mismatches:?}");
}
