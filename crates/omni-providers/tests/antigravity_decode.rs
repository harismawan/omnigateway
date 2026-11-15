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
        .expect("spawn depth worker")
        .join()
        .expect("depth worker");
}

#[test]
fn bounded_depth_expected_divergence() {
    let run = std::process::Command::new("bun")
        .args([
            "--no-env-file",
            "tests/antigravity_decode-reference.ts",
            "--bounded-depth",
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
    let rows = rows.as_array().expect("rows");
    assert_eq!(rows.len(), 10);
    for row in rows {
        let name = row["name"].as_str().expect("name");
        let mut parser = SseParser::new();
        let mut messages = Vec::new();
        for chunk in row["chunks"].as_array().expect("chunks") {
            let bytes: Vec<_> = chunk
                .as_array()
                .expect("bytes")
                .iter()
                .map(|b| b.as_u64().expect("byte") as u8)
                .collect();
            parser.push(&bytes, &mut messages).expect("SSE");
        }
        assert_eq!(
            omni_ir::deep::depth_of(&messages.last().expect("frame").data),
            if name.contains("args-stringify") {
                40_009
            } else {
                40_001
            },
            "{name}"
        );
        let mut decoder = AntigravityDecoder::default();
        let mut out = VecDeque::new();
        let mut refusal = None;
        for message in messages {
            match decoder.message(&message, &mut out) {
                Ok(Flow::Continue) => (),
                Err(DecodeError::Throw(message)) => {
                    refusal = Some(message);
                    break;
                }
                result => panic!("{name}: unexpected {result:?}"),
            }
        }
        assert_eq!(
            refusal,
            Some("upstream JSON exceeds depth 40000"),
            "{name}"
        );
        let actual = serde_json::Value::Array(
            out.iter()
                .map(|e| serde_json::from_str(&e.to_json()).expect("event"))
                .collect(),
        );
        let prefix = if name.ends_with("after-text") {
            serde_json::json!([
                {"type":"start","id":"","model":""},
                {"type":"blockStart","index":0,"block":{"type":"text"}},
                {"type":"blockDelta","index":0,"delta":{"type":"text","text":"before"}}
            ])
        } else {
            serde_json::json!([])
        };
        assert_eq!(
            actual, prefix,
            "{name}: Rust must preserve exactly earlier events"
        );
        let frozen = row["events"].as_array().expect("events");
        let prefix = prefix.as_array().expect("prefix");
        assert_eq!(&frozen[..prefix.len()], prefix, "{name}: frozen prefix");
        let mut expected = prefix.clone();
        let after = name.ends_with("after-text");
        if after {
            expected.push(serde_json::json!({"type":"blockEnd","index":0}));
        } else if !name.contains("/error/") {
            expected.push(serde_json::json!({"type":"start","id":"","model":""}));
        }
        if name.contains("/error/") {
            expected.push(serde_json::json!({"type":"error","code":"UPSTREAM","message":"upstream error","retryable":true}));
        } else {
            if name.contains("/args") {
                let index = u32::from(after);
                expected.push(serde_json::json!({"type":"blockStart","index":index,"block":{"type":"toolUse","id":"fc_0","name":"x"}}));
                if !name.contains("args-stringify") {
                    let partial = format!("{}0{}", "[".repeat(39_993), "]".repeat(39_993));
                    expected.push(serde_json::json!({"type":"blockDelta","index":index,"delta":{"type":"toolJson","partial":partial}}));
                    expected.push(serde_json::json!({"type":"blockEnd","index":index}));
                }
            }
            if !name.contains("args-stringify") {
                expected.push(serde_json::json!({"type":"end","stopReason":if name.contains("/args/") {"toolUse"} else {"endTurn"},"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}}));
            }
        }
        assert_eq!(frozen, &expected, "{name}: exact frozen result");
        assert!(
            frozen.len() > prefix.len(),
            "{name}: must be a real divergence"
        );
        assert_eq!(
            row["thrown"].is_null(),
            !name.contains("args-stringify"),
            "{name}: frozen stringify timing"
        );
        if name.contains("args-stringify") {
            assert_eq!(frozen.last().expect("tool start")["type"], "blockStart");
            assert_eq!(
                frozen.last().expect("tool start")["block"]["type"],
                "toolUse"
            );
            assert_eq!(row["thrown"]["name"], "RangeError");
        }
        eprintln!(
            "EXPECTED-DIVERGENCE {name}: frozen events={} thrown={}; Rust={actual} Throw({})",
            frozen.len(),
            row["thrown"],
            refusal.expect("refusal")
        );
    }
    eprintln!("bounded-parser expected-divergence: 10 rows asserted");
}
#[test]
fn request_cloak_round_trip() {
    use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
    let request=serde_json::from_value(serde_json::json!({"model":"test","stream":true,"messages":[],"tools":[{"kind":"portable","name":"original / tool","description":"test","inputSchema":{"type":"object"}}]})).expect("request");
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
    let built = ProviderCodec::build_request(&codec, &input).expect("build request");
    let wire = built.decode_state.cloak.name("original / tool").to_owned();
    assert_ne!(wire, "original / tool");
    assert!(built.request.body.contains(&wire));
    let mut decoder = codec.decoder(built.decode_state, &Default::default());
    let mut out = VecDeque::new();
    decoder.message(&omni_providers::sse::SseMessage{event:"message".into(),data:serde_json::json!({"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":wire}}]},"finishReason":"STOP"}]}}).to_string()},&mut out).expect("decode");
    assert!(out.iter().any(|e|matches!(e,omni_ir::stream::StreamEvent::BlockStart{block:omni_ir::stream::ContentBlockStart::ToolUse{name,..},..} if name=="original / tool")));
}
#[test]
#[ignore = "X1: lone UTF-16 text surrogate"]
fn x1_text_retained_red() {
    compare("X1/text-surrogate");
}
#[test]
#[ignore = "X1: lone UTF-16 tool JSON surrogate"]
fn x1_args_retained_red() {
    compare("X1/args-surrogate");
}
#[test]
#[ignore = "X1: number beyond double range"]
fn x1_overflow_retained_red() {
    compare("X1/overflow");
}
fn compare(mode: &str) {
    let run = std::process::Command::new("bun")
        .args([
            "--no-env-file",
            "tests/antigravity_decode-reference.ts",
            mode,
            if mode.starts_with("X1/") { "--x1" } else { "" },
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
    for row in rows.as_array().expect("rows") {
        let mut decoder = AntigravityDecoder::default();
        for pair in row["cloak"].as_array().expect("cloak") {
            decoder.cloak.from_wire.insert(
                pair[0].as_str().expect("wire").into(),
                pair[1].as_str().expect("original").into(),
            );
        }
        let mut parser = SseParser::new();
        let mut messages = Vec::new();
        for chunk in row["chunks"].as_array().expect("chunks") {
            parser
                .push(
                    &chunk
                        .as_array()
                        .expect("bytes")
                        .iter()
                        .map(|v| v.as_u64().expect("byte") as u8)
                        .collect::<Vec<_>>(),
                    &mut messages,
                )
                .expect("SSE");
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
                .map(|e| serde_json::from_str(&e.to_json()).expect("event"))
                .collect(),
        );
        if actual != row["events"] || threw == row["thrown"].is_null() {
            red += 1;
            eprintln!(
                "RED {}: actual {actual} threw={threw}; expected {}",
                row["name"], row["events"]
            );
        }
    }
    let total = rows.as_array().expect("rows").len();
    eprintln!(
        "decoder corpus: {} green / {red} red / {total} total",
        total - red
    );
    assert_eq!(red, 0);
}
