use omni_providers::antigravity::decode::AntigravityDecoder;
use omni_providers::{
    codec::{DecodeError, Flow, StreamDecoder},
    sse::SseParser,
};
use std::collections::VecDeque;
#[test]
fn frozen_corpus() {
    compare("");
}
#[test]
fn depth_on_two_mib_stack() {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| compare("--depth"))
        .unwrap()
        .join()
        .unwrap();
}
#[test]
fn request_cloak_round_trip() {
    use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
    let request=serde_json::from_value(serde_json::json!({"model":"test","stream":true,"messages":[],"tools":[{"kind":"portable","name":"original / tool","description":"test","inputSchema":{"type":"object"}}]})).unwrap();
    let mut credentials = Credentials::default();
    credentials.access_token = Some("token".into());
    credentials
        .provider_data
        .insert("projectId".into(), serde_json::json!("project"));
    let input = CodecInput {
        request: &request,
        model: "test",
        credentials: &credentials,
        request_id: None,
        auto_cache_enabled: None,
        max_output_tokens: None,
        request_started_at: None,
    };
    let codec = omni_providers::antigravity::codec::AntigravityCodec;
    let built = codec.build_request(&input).unwrap();
    let wire = built.decode_state.cloak.name("original / tool").to_owned();
    assert_ne!(wire, "original / tool");
    assert!(built.request.body.contains(&wire));
    let mut decoder = codec.decoder(built.decode_state, &Default::default());
    let mut out = VecDeque::new();
    decoder.message(&omni_providers::sse::SseMessage{event:"message".into(),data:serde_json::json!({"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":wire}}]},"finishReason":"STOP"}]}}).to_string()},&mut out).unwrap();
    assert!(out.iter().any(|e|matches!(e,omni_ir::stream::StreamEvent::BlockStart{block:omni_ir::stream::ContentBlockStart::ToolUse{name,..},..} if name=="original / tool")));
}
#[test]
#[ignore = "X1: lone UTF-16 text/tool JSON surrogates and overflow numbers"]
fn x1_retained_red() {
    compare("--x1");
}
fn compare(mode: &str) {
    let run = std::process::Command::new("bun")
        .args([
            "--no-env-file",
            "tests/antigravity_decode-reference.ts",
            mode,
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("rows");
    let mut red = 0;
    for row in rows.as_array().unwrap() {
        let mut decoder = AntigravityDecoder::default();
        for pair in row["cloak"].as_array().unwrap() {
            decoder.cloak.from_wire.insert(
                pair[0].as_str().unwrap().into(),
                pair[1].as_str().unwrap().into(),
            );
        }
        let mut parser = SseParser::new();
        let mut messages = Vec::new();
        for chunk in row["chunks"].as_array().unwrap() {
            parser
                .push(
                    &chunk
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u8)
                        .collect::<Vec<_>>(),
                    &mut messages,
                )
                .unwrap();
        }
        if let Some(m) = parser.finish() {
            messages.push(m);
        }
        let mut out = VecDeque::new();
        let mut stopped = false;
        let mut threw = false;
        for msg in messages {
            match decoder.message(&msg, &mut out) {
                Ok(Flow::Continue) => {}
                Ok(Flow::Stop) => {
                    stopped = true;
                    break;
                }
                Err(DecodeError::Throw(_)) => {
                    threw = true;
                    stopped = true;
                    break;
                }
                Err(e) => panic!("{e:?}"),
            }
        }
        if !stopped {
            decoder.finish(&mut out);
        }
        let actual = serde_json::Value::Array(
            out.iter()
                .map(|e| serde_json::from_str(&e.to_json()).unwrap())
                .collect(),
        );
        if actual != row["events"] || threw != !row["thrown"].is_null() {
            red += 1;
            eprintln!(
                "RED {}: actual {actual} threw={threw}; expected {}",
                row["name"], row["events"]
            );
        }
    }
    let total = rows.as_array().unwrap().len();
    eprintln!(
        "decoder corpus: {} green / {red} red / {total} total",
        total - red
    );
    assert_eq!(red, 0);
}
