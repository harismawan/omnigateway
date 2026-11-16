use omni_gateway::screening::{self, VerdictCache};
use serde_json::{Value, json};

#[test]
fn pure_screening_matches_frozen_typescript() {
    let run = std::process::Command::new("bun")
        .args(["--no-env-file", "tests/screening-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let doc: Value = serde_json::from_slice(&run.stdout).expect("corpus");
    for row in doc["judged"].as_array().expect("judged") {
        assert_eq!(
            screening::judged_text_json(&row["request"], row["turns"].as_f64().expect("turns")),
            row["expected"]
        );
    }
    let mut events = doc["relabel"]["events"].clone();
    let mut log = doc["relabel"]["log"].clone();
    screening::relabel(&mut events, &mut log, "client", "local");
    assert_eq!(events, doc["relabel"]["expectedEvents"]);
    assert_eq!(log, doc["relabel"]["expectedLog"]);
    for row in doc["extractions"].as_array().expect("extractions") {
        assert_eq!(json!(screening::segments(&row["request"])), row["segments"]);
    }
    for row in doc["prompts"].as_array().expect("prompts") {
        let model = row["model"].as_str().expect("model");
        let policy = row["policy"].as_str().expect("policy");
        let segment = row["segment"].as_str().expect("segment");
        assert_eq!(
            screening::classifier_request(model, policy, &row["judged"]),
            row["guardrail"]
        );
        assert_eq!(
            screening::confidentiality_request(model, policy, segment),
            row["smart"]
        );
        assert_eq!(
            screening::verdict_key("k", policy, model, &row["judged"]),
            row["guardrailKey"]
        );
        assert_eq!(
            screening::segment_key(model, policy, segment),
            row["segmentKey"]
        );
    }
    for row in doc["parses"].as_array().expect("parses") {
        assert_eq!(
            json!(screening::parse_verdict(&row["response"])),
            row["verdict"]
        );
        assert_eq!(
            json!(screening::parse_confidentiality(&row["response"])),
            row["confidentiality"]
        );
    }
    let mut cache = VerdictCache::new(2, 10);
    for (op, expected) in doc["ops"]
        .as_array()
        .expect("ops")
        .iter()
        .zip(doc["cacheResults"].as_array().expect("results"))
    {
        let key = op[1].as_str().expect("key");
        let actual = if op[0] == "set" {
            cache.set(
                key.into(),
                op[2].as_str().expect("verdict").to_owned(),
                op[3].as_i64().expect("now"),
            );
            Value::Null
        } else {
            json!(cache.get(key, op[2].as_i64().expect("now")))
        };
        assert_eq!(&actual, expected, "{op}");
    }
    eprintln!(
        "{} prompt/key tuples, {} response parses, {} cache operations, {} segment extractions, {} guardrail extractions, 1 relabel matched frozen TS",
        doc["prompts"].as_array().expect("prompts").len(),
        doc["parses"].as_array().expect("parses").len(),
        doc["ops"].as_array().expect("ops").len(),
        doc["extractions"].as_array().expect("extractions").len(),
        doc["judged"].as_array().expect("judged").len()
    );
}
