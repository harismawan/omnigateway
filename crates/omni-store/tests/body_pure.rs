use omni_ir::jsjson::{parse_js, stringify};
use std::io::Write as _;
use std::process::{Command, Stdio};

fn reference(input: serde_json::Value) -> serde_json::Value {
    let mut child = Command::new("bun")
        .args(["--no-env-file", "conformance/store/body-reference.ts"])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("bun reference");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input.to_string().as_bytes())
        .expect("write");
    let out = child.wait_with_output().expect("reference");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("reference JSON")
}

#[test]
fn masking_and_bounding_match_frozen() {
    let mut values = vec!["null".to_owned(), r#"{"headers":{"Authorization":"bEaReR abc+/=", "x-api-key":"sk-12345678"},"tool":{"arguments":"{\"secret\":\"ghp_12345678\"}"},"\ud800":"\ud800 secret sk-abcdefgh \udfff"}"#.into()];
    for prefix in [
        "sk-",
        "ak-",
        "pk-",
        "ghp_",
        "gho_",
        "ghs_",
        "ghu_",
        "github_pat_",
        "AIza",
        "GOCSPX-",
        "xai-",
    ] {
        for n in [7, 8, 9, 40, 41, 43] {
            for left in ["", "a-", "!", "é", "_"] {
                values.push(
                    serde_json::to_string(&format!("{left}{prefix}{}", "a".repeat(n)))
                        .expect("json"),
                );
            }
        }
    }
    for s in [
        "Bearer\u{feff}abc",
        "éBearer abc",
        "aBearer abc",
        "Bearer\nabc",
        "xai-grok-4-latest",
        "req_00000000-0000-0000-0000-000000000000",
    ] {
        values.push(serde_json::to_string(s).expect("json"));
    }
    for n in [65535, 65536, 65537] {
        for ch in ["a", "中", "😀"] {
            let text = ch.repeat(n / ch.len()) + &"!".repeat(n % ch.len());
            assert_eq!(text.len(), n);
            values.push(serde_json::to_string(&text).expect("json"));
        }
    }
    values
        .push(serde_json::to_string(&("\u{feff}".to_owned() + &"!".repeat(65536))).expect("json"));
    for n in [23, 24, 25, 79, 80, 81] {
        values.push(serde_json::to_string(&(0..n).collect::<Vec<_>>()).expect("json"));
        values.push(format!(
            "{{{}}}",
            (0..n)
                .rev()
                .map(|i| format!("\"{i}\":{i}"))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    for n in [5, 6, 7, 8] {
        values.push(format!("{}0{}", "[".repeat(n), "]".repeat(n)));
    }
    let expected = reference(serde_json::json!({"op":"pure", "values":values}));
    for (i, text) in values.iter().enumerate() {
        let value = parse_js(text).expect("parse");
        let masked = omni_store::bodies::mask_secrets(&value);
        assert_eq!(
            stringify(&masked).expect("stringify"),
            expected[i]["masked"],
            "mask case {i}"
        );
        let (bounded, truncated) = omni_store::bodies::bound_value(&value);
        let want =
            parse_js(expected[i]["bounded"].as_str().expect("bounded")).expect("parse bounded");
        let got = parse_js(&format!(
            "{{\"value\":{},\"truncated\":{truncated}}}",
            stringify(&bounded).expect("stringify")
        ))
        .expect("parse got");
        assert_eq!(got, want, "bound case {i}");
    }
    println!("{} masking + bounding cases", values.len());
}

#[test]
fn frozen_envelope_corpus_agrees() {
    let corpus = reference(serde_json::json!({"op":"corpus"}));
    let key = omni_crypto::field::derive_key(corpus["secret"].as_str().expect("secret"));
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(cases.len() >= 300);
    for c in cases {
        let hex = c["bytes"].as_str().expect("hex");
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect::<Vec<_>>();
        let got = omni_store::pg::bodies::decode(&key, &bytes, c["digest"].as_str());
        assert_eq!(
            got.is_some(),
            c["ok"].as_bool().expect("ok"),
            "{}",
            c["name"]
        );
        if let Some(got) = got {
            assert_eq!(got, (&c["artifact"]).into());
        }
    }
    println!("{} frozen envelope verdicts", cases.len());
}

#[test]
fn artifacts_cross_read_both_directions() {
    let secret = "a3-body-cross-read";
    let key = omni_crypto::field::derive_key(secret);
    let json = r#"{"text":"中😀","n":1,"nested":{"a":true}}"#;
    let sealed = omni_store::pg::bodies::seal(&key, json).expect("seal");
    assert_eq!(
        &sealed.bytes[..10],
        &[79, 71, 66, 65, 1, 0, 0, 0, 0, json.len() as u8]
    );
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let read = reference(
        serde_json::json!({"op":"decode","secret":secret,"bytes":hex(&sealed.bytes),"sha256":sealed.sha256}),
    );
    assert_eq!(read["plaintext"], json);
    assert_eq!(
        read["artifact"],
        serde_json::from_str::<serde_json::Value>(json).expect("json")
    );
    let frozen = reference(serde_json::json!({"op":"seal","secret":secret,"json":json}));
    let text = frozen["bytes"].as_str().expect("hex");
    let bytes = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect::<Vec<_>>();
    assert_eq!(
        omni_store::pg::bodies::decode(&key, &bytes, frozen["sha256"].as_str()),
        Some(parse_js(json).expect("json"))
    );
    for bad in [
        &bytes[..20],
        &bytes[..bytes.len() - 1],
        b"foreign".as_slice(),
    ] {
        assert_eq!(omni_store::pg::bodies::decode(&key, bad, None), None);
        assert_eq!(
            reference(serde_json::json!({"op":"decode","secret":secret,"bytes":hex(bad)}))["failure"],
            "corrupt"
        );
    }
    assert_eq!(
        omni_store::pg::bodies::decode(&omni_crypto::field::derive_key("wrong"), &bytes, None),
        None
    );
}

#[test]
fn prepared_artifacts_match_frozen_bytes() {
    let mut values = Vec::new();
    for n in [0, 24, 25, 80] {
        let body = serde_json::json!({"message":"Bearer secret", "frames": vec!["frame"; n]});
        values.push(serde_json::json!({"schemaVersion":99,"requestId":"req_a","at":0,"client":{"request":body,"response":null,"truncated":false},"attempts":[{"attempt":1,"provider":"openai","request":"sk-12345678","response":body,"streamChunks":vec!["frame";n],"truncated":false}],"error":null}).to_string());
    }
    let huge: serde_json::Map<String, serde_json::Value> = (0..80)
        .map(|i| {
            (
                format!("k{i}"),
                serde_json::Value::String("!".repeat(65536)),
            )
        })
        .collect();
    for error in [
        serde_json::Value::Null,
        serde_json::Value::Object(huge.clone()),
    ] {
        values.push(serde_json::json!({"requestId":"req_big","at":0,"client":{"request":huge,"response":null},"attempts":[],"error":error}).to_string());
    }
    values.push(r#"{"requestId":"req_surrogate","at":0,"client":{"request":"\ud800","response":null},"attempts":[],"error":null}"#.into());
    let expected = reference(serde_json::json!({"op":"prepare","values":values}));
    for (i, text) in values.iter().enumerate() {
        let (_, json) = omni_store::bodies::prepare_artifact(&parse_js(text).expect("parse"));
        assert_eq!(json, expected[i], "prepare case {i}");
    }
}

#[test]
#[allow(clippy::unwrap_used)] // Fixture setup/assertions only.
fn lossless_cross_reads_and_artifact_ceiling() {
    let secret = "a3-lossless";
    let key = omni_crypto::field::derive_key(secret);
    let mut cases = vec![
        r#"{"s":"\ud800\udfff\ud800","n":9007199254740993,"z":-0,"big":1e400}"#.to_owned(),
        "\u{feff}{\"bom\":true}".into(),
        r#"{"a":[{"b":[{"c":{}}]}]}"#.into(),
    ];
    for n in [65535, 65536, 65537] {
        cases.push(format!("{{\"s\":\"{}\"}}", "!".repeat(n)));
    }
    for json in &cases {
        let sealed = omni_store::pg::bodies::seal(&key, json).expect("seal");
        let hex = sealed
            .bytes
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let frozen =
            reference(serde_json::json!({"op":"cross", "secret":secret,"json":json,"bytes":hex}));
        assert_eq!(
            frozen["plaintext"].as_str().unwrap().as_bytes(),
            json.as_bytes()
        );
        let hex = frozen["bytes"].as_str().unwrap();
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            omni_store::pg::bodies::decode_plaintext(&key, &bytes, None)
                .unwrap()
                .as_bytes(),
            json.as_bytes()
        );
        assert_eq!(
            omni_store::pg::bodies::decode(&key, &bytes, None),
            Some(parse_js(json.trim_start_matches('\u{feff}')).unwrap())
        );
        assert_eq!(
            stringify(&omni_store::pg::bodies::decode(&key, &bytes, None).unwrap()).unwrap(),
            frozen["artifactJson"]
        );
    }
    let base = r#"{"requestId":"limit","at":0,"client":{"request":{},"response":null},"attempts":[],"error":null}"#;
    let (_, empty) = omni_store::bodies::prepare_artifact(&parse_js(base).unwrap());
    let mut values = Vec::new();
    for size in [524287, 524288, 524289] {
        let mut value: serde_json::Value = serde_json::from_str(base).unwrap();
        // Eight separately bounded strings; punctuation avoids secret masking.
        for i in 0..8 {
            value["client"]["request"][format!("k{i}")] = "!".repeat(65000).into();
        }
        let (_, json) =
            omni_store::bodies::prepare_artifact(&parse_js(&value.to_string()).unwrap());
        let delta = size - json.len();
        value["client"]["request"]["extra"] = "!".repeat(delta - 11).into();
        let text = value.to_string();
        let (_, prepared) = omni_store::bodies::prepare_artifact(&parse_js(&text).unwrap());
        if size <= 524288 {
            assert_eq!(prepared.len(), size);
        } else {
            assert!(prepared.contains("omitted"));
        }
        values.push(text);
    }
    assert!(empty.len() < 1000);
    let expected = reference(serde_json::json!({"op":"prepare","values":values}));
    for (i, text) in values.iter().enumerate() {
        assert_eq!(
            omni_store::bodies::prepare_artifact(&parse_js(text).unwrap()).1,
            expected[i]
        );
    }
    println!("6 lossless bidirectional cases + 3 total-size boundaries");
}
