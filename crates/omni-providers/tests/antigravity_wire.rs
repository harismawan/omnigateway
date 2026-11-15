#[test]
fn wire_matches_frozen_ts() {
    let output = std::process::Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_wire-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).expect("rows");
    let rows = rows.as_array().expect("array");
    assert_eq!(rows.len(), 352);
    let mut failures = Vec::new();
    for row in rows {
        let mut request: omni_ir::request::ChatRequest =
            serde_json::from_value(row["request"].clone()).expect("request");
        if let Some(numbers) = row["numbers"].as_object() {
            for (key, value) in numbers {
                let n = match value.as_str().expect("number") {
                    "NaN" => f64::NAN,
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    _ => -0.0,
                };
                match key.as_str() {
                    "maxTokens" => request.max_tokens = Some(n),
                    "temperature" => request.temperature = Some(n),
                    _ => {
                        request.reasoning =
                            Some(omni_ir::request::ReasoningConfig::Budget { budget_tokens: n })
                    }
                }
            }
        }
        let cloak = omni_providers::antigravity::cloak::ToolCloak::build(&request);
        let (body, notes) = omni_providers::antigravity::wire::to_wire(
            &request,
            &request.model,
            "projects/p-1",
            "req-1",
            &cloak,
        );
        if omni_ir::jsjson::to_string(&body) != row["expected"].as_str().expect("expected")
            || serde_json::json!(notes) != row["notes"]
        {
            failures.push(row["label"].as_str().expect("label").to_owned());
        }
        omni_ir::deep::drop(body);
    }
    eprintln!(
        "wire corpus: {} rows; {} green; {} red",
        rows.len(),
        rows.len() - failures.len(),
        failures.len()
    );
    assert!(failures.is_empty(), "mismatches: {failures:#?}");
}

#[test]
#[ignore = "X1: shared Rust string IR cannot represent lone UTF-16 surrogate text"]
fn x1_lone_surrogate_text_retained_red() {
    let input = r#"{"model":"m","stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"\ud800"}]}]}"#;
    let _: omni_ir::request::ChatRequest =
        serde_json::from_str(input).expect("X1: preserve lone surrogate without normalization");
}
