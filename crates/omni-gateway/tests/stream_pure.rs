use omni_gateway::stream::{Coalescer, Ring, authorised, encode, parse_client_frame, topic_class};
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn frozen_pure_bytes() {
    let mut frames = vec![
        Value::Null,
        json!([]),
        json!({}),
        json!({"id":null,"type":"subscribe","topic":"res:a"}),
    ];
    let topics = vec![
        "",
        "res:",
        "stream:",
        "plugin:p",
        "plugin::x",
        "plugin:p:",
        "plugin:p:x",
        "plugin:p:x:y",
        "res:*",
        "res:usage",
        "res:logs",
        "res:secret",
        "stream:console",
        "other:x",
    ];
    for topic in &topics {
        for kind in ["subscribe", "unsubscribe", "send", "other"] {
            for seq in [
                json!(null),
                json!(-1),
                json!(0),
                json!(1.5),
                json!("1"),
                json!(9007199254740992_u64),
            ] {
                frames.push(json!({"topic":topic,"type":kind,"id":"a","sinceSeq":seq,"payload":null,"extra":true}));
            }
            frames.push(json!({"topic":topic,"type":kind}));
        }
    }
    for n in [124, 125] {
        frames.push(json!({"type":"subscribe","topic":format!("res:{}", "x".repeat(n))}));
    }
    frames.push(json!({"type":"subscribe","topic":format!("res:{}", "😀".repeat(63))}));
    frames.push(
        json!({"type":"send","topic":"res:a","payload":{"10":1.0,"2":-0.0,"z":1e21,"a":1e-7}}),
    );
    frames.push(json!({"type":"subscribe","topic":"res:a","sinceSeq":-0.0}));
    let mut ring = vec![json!(["since", "a", 0]), json!(["since", "a", 1])];
    for n in 0..30 {
        ring.push(json!(["push","a", {"n":n,"unicode":"😀é"}]));
        for cursor in [0, n, n + 1, n + 2] {
            ring.push(json!(["since", "a", cursor]));
        }
    }
    ring.extend([
        json!(["push", "a", 0, 29]),
        json!(["push", "a", 0, 40]),
        json!(["since", "a", 30]),
        json!(["reset", "a"]),
        json!(["head", "a"]),
        json!(["since", "a", 39]),
        json!(["since", "a", 40]),
        json!([
            "push",
            "a",
            "oversized payload with unicode 😀😀😀😀😀😀😀😀😀😀"
        ]),
        json!(["since", "a", 40]),
        json!(["drop", "a"]),
        json!(["head", "a"]),
        json!(["since", "a", 0]),
    ]);
    let coalescer = json!([
        ["emit", "res:logs", 1],
        ["advance", 100],
        ["emit", "res:logs", 2],
        ["emit", "res:logs", 3],
        ["emit", "res:quota", 1],
        ["advance", 999],
        ["emit", "res:logs", 4],
        ["advance", 1000],
        ["emit", "res:logs", 5],
        ["advance", 1500],
        ["emit", "res:quota", 2],
        ["flush"],
        ["emit", "res:logs", 6],
        ["stop"],
        ["advance", 9000],
        ["emit", "res:logs"],
        ["emit", "res:logs", null],
        ["advance", 10000],
        ["emit", "res:logs", 7],
        ["advance", 12500],
        ["emit", "res:logs", 8],
        ["advance", 13500]
    ]);
    for (count, bytes) in [(0, 0), (1, 0), (3, 70), (3, 10000)] {
        check(
            json!({"frames":frames,"topics":topics,"limits":{"frames":count,"bytes":bytes},"ring":ring,"coalescer":coalescer}),
        );
    }
}

fn check(input: Value) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("/home/homebrew/.bun/bin/bun")
        .args(["--no-env-file", "conformance/stream/pure-reference.ts"])
        .current_dir(root)
        .env_clear()
        .env("HOME", "/tmp/opencode/a9/home")
        .env(
            "PATH",
            "/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Bun");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input.to_string().as_bytes())
        .expect("input");
    let output = child.wait_with_output().expect("reference");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<String> = serde_json::from_slice(&output.stdout).expect("oracle JSON");
    let mut actual = Vec::new();
    for raw in input["frames"].as_array().expect("frames") {
        actual.push(encode(&parse_client_frame(raw)));
    }
    for topic in input["topics"].as_array().expect("topics") {
        let topic = topic.as_str().expect("topic");
        actual.push(serde_json::to_string(&topic_class(topic)).expect("class"));
        for kind in ["admin", "viewer", "client", "machine"] {
            actual.push(authorised(kind, topic).to_string());
        }
    }
    let mut ring = Ring::new(
        input["limits"]["frames"].as_u64().expect("frame cap") as usize,
        input["limits"]["bytes"].as_u64().expect("byte cap") as usize,
    );
    for op in input["ring"].as_array().expect("ring") {
        let topic = op[1].as_str().expect("topic");
        match op[0].as_str().expect("operation") {
            "push" => actual.push(
                ring.push(topic, op[2].clone(), op.get(3).and_then(Value::as_f64))
                    .to_string(),
            ),
            "since" => actual.push(encode(&ring.since(topic, op[2].as_f64().expect("seq")))),
            "head" => actual.push(ring.head(topic).to_string()),
            "reset" => ring.reset(topic),
            "drop" => ring.drop_topic(topic),
            _ => unreachable!(),
        }
    }
    let mut coalescer = Coalescer::new(1000, [("res:quota".into(), 5000)].into());
    let mut now = 0;
    for op in input["coalescer"].as_array().expect("coalescer") {
        let emitted = match op[0].as_str().expect("op") {
            "emit" => coalescer.emit(now, op[1].as_str().expect("topic"), op.get(2).cloned()),
            "advance" => {
                now = op[1].as_u64().expect("time");
                coalescer.advance(now)
            }
            "flush" => coalescer.flush(now),
            "stop" => {
                coalescer.stop();
                vec![]
            }
            _ => unreachable!(),
        };
        actual.extend(emitted.into_iter().map(|v| encode(&v)));
    }
    assert_eq!(actual.len(), expected.len());
    for (i, (a, e)) in actual.iter().zip(&expected).enumerate() {
        assert_eq!(a, e, "row {i}");
    }
    eprintln!("{} exact-byte oracle rows", actual.len());
}

#[test]
fn transport_text_keeps_valid_discarded_json() {
    for extra in [
        "1e999".to_owned(),
        format!("{}0{}", "[".repeat(150), "]".repeat(150)),
    ] {
        let text = format!(r#"{{"type":"subscribe","topic":"res:logs","extra":{extra}}}"#);
        assert_eq!(
            omni_gateway::stream_transport::parse_text(&text)["topic"],
            "res:logs"
        );
    }
}
