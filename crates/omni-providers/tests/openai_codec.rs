use omni_providers::{
    codec::{CodecInput, Credentials, ProviderCodec},
    http::Headers,
    openai::OpenAiApiKeyCodec,
    sse::SseParser,
};
#[test]
fn request_state_reaches_decoder() {
    let run = std::process::Command::new("bun")
        .arg("tests/openai-codec-reference.ts")
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
        let request = serde_json::from_value(row["request"].clone()).expect("IR");
        let credentials = Credentials {
            api_key: Some("sk".into()),
            ..Default::default()
        };
        let codec = OpenAiApiKeyCodec;
        let built = codec
            .build_request(&CodecInput {
                request: &request,
                model: "gpt-5-codex",
                credentials: &credentials,
                request_id: None,
                auto_cache_enabled: None,
                max_output_tokens: None,
                request_started_at: None,
            })
            .expect("build");
        assert_eq!(built.request.body, row["body"].as_str().expect("body"));
        assert_eq!(serde_json::json!(built.request.headers), row["headers"]);
        let mut decoder = codec.decoder(built.decode_state, &Headers::default());
        let mut parser = SseParser::new();
        let mut messages = Vec::new();
        parser
            .push(
                row["wire"].as_str().expect("wire").as_bytes(),
                &mut messages,
            )
            .expect("parse");
        if let Some(m) = parser.finish() {
            messages.push(m);
        }
        let mut events = std::collections::VecDeque::new();
        for m in messages {
            decoder.message(&m, &mut events).expect("decode");
        }
        decoder.finish(&mut events);
        let actual: Vec<serde_json::Value> = events
            .iter()
            .map(|e| serde_json::from_str(&e.to_json()).expect("event"))
            .collect();
        assert_eq!(serde_json::json!(actual), row["events"]);
    }
}
