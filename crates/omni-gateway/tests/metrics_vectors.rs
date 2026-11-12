//! The Prometheus registry against frozen TS: every case in
//! `conformance/vectors/metrics.json` (written by `metrics.ts`, which runs the
//! real `createMetricRegistry` and `renderPrometheus`) is replayed and must
//! render the same bytes.

use omni_gateway::telemetry::{Metric, Registry};
use serde_json::Value;

fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => Some(match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => other.parse().expect("numeric string"),
        }),
        _ => panic!("value"),
    }
}

#[test]
fn registry_renders_what_frozen_ts_renders() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/vectors/metrics.json"
    );
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("metrics.json")).expect("json");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 13);
    let mut failed = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let r = Registry::new(case["maxSeries"].as_f64().expect("maxSeries"));
        for op in case["ops"].as_array().expect("ops") {
            let metric = Metric::from_name(op["name"].as_str().expect("metric")).expect("known");
            let labels: Vec<(String, String)> = op["labels"]
                .as_array()
                .expect("labels")
                .iter()
                .map(|p| {
                    (
                        p[0].as_str().expect("k").to_owned(),
                        p[1].as_str().expect("v").to_owned(),
                    )
                })
                .collect();
            let refs: Vec<(&str, &str)> = labels
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            let value = num(op.get("value"));
            match op["op"].as_str().expect("op") {
                "add" => r.add(metric, &refs, value.unwrap_or(1.0)),
                "set" => r.set(metric, &refs, value.expect("set value")),
                "observe" => r.observe(metric, value.expect("observe value"), &refs),
                other => panic!("op {other}"),
            }
        }
        let expected = case["rendered"].as_str().expect("rendered");
        let actual = r.render();
        if actual != expected {
            failed.push(format!("{name}:\n--- ts\n{expected}--- rust\n{actual}"));
        }
    }
    assert!(
        failed.is_empty(),
        "{} of {} cases differ:\n{}",
        failed.len(),
        cases.len(),
        failed.join("\n")
    );
}
