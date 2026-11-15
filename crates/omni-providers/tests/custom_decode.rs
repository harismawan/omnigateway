use omni_providers::{
    codec::{DecodeError, Flow, StreamDecoder},
    custom::decode::{ChatDecoder, ResponsesDecoder},
    sse::SseParser,
};
use std::collections::VecDeque;
#[test]
fn coercions() {
    compare(None);
}
#[test]
#[ignore = "parked: roadmap X1 (upstream numbers beyond the double range)"]
fn chat_overflow() {
    compare(Some("chat"));
}
#[test]
#[ignore = "parked: roadmap X1 (upstream numbers beyond the double range)"]
fn responses_overflow() {
    compare(Some("responses"));
}
fn compare(overflow: Option<&str>) {
    let run = std::process::Command::new("bun")
        .arg("tests/custom-decode-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("rows");
    for (i, row) in rows.as_array().expect("rows").iter().enumerate() {
        if row["overflow"].as_bool().unwrap_or(false) != overflow.is_some()
            || overflow.is_some_and(|p| row["protocol"] != p)
        {
            continue;
        }
        let wire: String = row["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .map(|m| {
                format!(
                    "event: {}\ndata: {}\n\n",
                    m["event"].as_str().expect("event"),
                    m["data"].as_str().expect("data")
                )
            })
            .collect();
        for chunk in [wire.len().max(1), 1, 7, 64, 4096] {
            let mut parser = SseParser::new();
            let mut messages = vec![];
            for b in wire.as_bytes().chunks(chunk) {
                parser.push(b, &mut messages).expect("parse");
            }
            let mut decoder: Box<dyn StreamDecoder> = if row["protocol"] == "chat" {
                Box::new(ChatDecoder::new())
            } else {
                Box::new(ResponsesDecoder::new())
            };
            let mut out = VecDeque::new();
            let mut threw = false;
            let mut stopped = false;
            for m in messages {
                match decoder.message(&m, &mut out) {
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
                decoder.finish(&mut out)
            }
            let actual: Vec<serde_json::Value> = out
                .iter()
                .map(|e| serde_json::from_str(&e.to_json()).expect("event"))
                .collect();
            assert_eq!(
                (serde_json::json!(actual), threw),
                (
                    row["events"].clone(),
                    row["throws"].as_bool().expect("throws")
                ),
                "row {i} chunk {chunk}"
            );
        }
    }
}
