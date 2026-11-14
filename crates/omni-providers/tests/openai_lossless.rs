//! Executable comparison for the step-3 public-IR blocker. No lossy expected
//! JSON parsing; events and buffered responses compare their JSON bytes.
use omni_providers::{
    codec::{Flow, StreamDecoder},
    openai::decode::OpenAiDecoder,
    sse::SseParser,
};
use std::collections::VecDeque;

fn compare(surrogates: bool) {
    let run = std::process::Command::new("bun")
        .arg("tests/openai-lossless-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("safe envelope");
    let mut failures = Vec::new();
    for row in rows.as_array().expect("rows") {
        let name = row["name"].as_str().expect("name");
        if name.starts_with("surrogate-") != surrogates {
            continue;
        }
        let bytes: Vec<u8> = serde_json::from_value(row["bytes"].clone()).expect("bytes");
        let chunk = row["chunk"].as_u64().expect("chunk") as usize;
        let mut parser = SseParser::new();
        let mut messages = Vec::new();
        for part in bytes.chunks(chunk) {
            parser.push(part, &mut messages).expect("parse");
        }
        if let Some(m) = parser.finish() {
            messages.push(m);
        }
        let mut decoder = OpenAiDecoder::new(row["native"].as_bool().expect("native"));
        let mut events = VecDeque::new();
        let mut stopped = false;
        for m in messages {
            if matches!(
                decoder.message(&m, &mut events).expect("decode"),
                Flow::Stop
            ) {
                stopped = true;
                break;
            }
        }
        if !stopped {
            decoder.finish(&mut events);
        }
        let actual = serde_json::json!(events.iter().map(|e| e.to_json()).collect::<Vec<_>>());
        if actual != row["events"] {
            eprintln!(
                "{name}/{chunk} events\nRust: {actual}\nTS: {}",
                row["events"]
            );
            failures.push(format!("{name}/{chunk}/events"));
        }
        let collected = omni_ir::stream::collect(events);
        use omni_dialects::egress;
        let render = egress::ResponsesRender {
            request_id: "req".into(),
            created: 123,
            custom_tool_names: Default::default(),
        };
        for (i, v) in [
            egress::anthropic::response(&collected, "req"),
            egress::openai::response(&collected, "req", 123),
            egress::responses::response(&collected, &render),
        ]
        .iter()
        .enumerate()
        {
            let actual = omni_ir::jsjson::to_string(&v.0);
            if actual != row["json"][i].as_str().expect("expected") {
                eprintln!(
                    "{name}/{chunk}/client-{i}\nRust: {actual}\nTS: {}",
                    row["json"][i]
                );
                failures.push(format!("{name}/{chunk}/client-{i}"));
            }
        }
    }
    assert!(failures.is_empty(), "mismatches: {failures:?}");
}
#[test]
fn raw_utf8_matches_ts() {
    compare(false);
}

#[test]
#[ignore = "blocked on public IR String/serde Value carriers; run --ignored for retained RED evidence"]
fn lone_surrogates_match_ts() {
    compare(true);
}
