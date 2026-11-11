//! Differential parity against `conformance/vectors/rtk.json.gz`, exported
//! from the frozen TS build by `conformance/vectors/rtk-export.ts`.
//!
//! Every case is checked and every mismatch is collected before failing, so
//! one run reports the whole divergence rather than the first case.

use flate2::read::GzDecoder;
use omni_ir::request::{ChatRequest, ContentBlock};
use omni_rtk::command::{CommandClassification, GrepMode, classify_command};
use omni_rtk::filters::shared::{BoundedText, ParserBudget, scan_text};
use omni_rtk::filters::{
    build, diagnostics, docker, git, listings, packages, search, status, tests,
};
use omni_rtk::{RtkConfig, extract_command, transform_request};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::io::Read;
use std::sync::LazyLock;

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/vectors/rtk.json.gz"
    );
    let file = std::fs::File::open(path).expect("rtk vectors");
    let mut json = String::new();
    GzDecoder::new(file)
        .read_to_string(&mut json)
        .expect("gunzip");
    serde_json::from_str(&json).expect("json")
});

fn section(name: &str) -> &'static [Value] {
    VECTORS[name].as_array().expect("section")
}

fn report_failures(name: &str, total: usize, failures: &[String]) {
    assert!(total > 0, "{name}: empty section");
    assert!(
        failures.is_empty(),
        "{name}: {} of {total} cases diverge from TS:\n{}",
        failures.len(),
        failures
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn classification_json(c: &CommandClassification) -> Value {
    let mut out = json!({ "family": c.family.as_str(), "executable": c.executable });
    if let Some(sub) = &c.subcommand {
        out["subcommand"] = json!(sub);
    }
    if let Some(mode) = &c.grep_mode {
        out["grepMode"] = json!({
            "heading": mode.heading,
            "lineNumber": mode.line_number,
            "beforeContext": mode.before_context,
            "afterContext": mode.after_context,
        });
    }
    out
}

#[test]
fn transform_request_matches_ts() {
    let cases = section("transform");
    let mut failures = Vec::new();
    for case in cases {
        let id = case["id"].as_str().unwrap_or("?");
        let request: ChatRequest = match serde_json::from_value(case["request"].clone()) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{id}: request does not deserialize: {e}"));
                continue;
            }
        };
        let expected = &case["expected"];
        let result = transform_request(&request, &RtkConfig { enabled: true });
        let unchanged = matches!(result.request, Cow::Borrowed(_));
        if unchanged != expected["unchanged"].as_bool().unwrap_or(false) {
            failures.push(format!(
                "{id}: unchanged {unchanged}, TS {}",
                expected["unchanged"]
            ));
            continue;
        }
        let mut changes = Vec::new();
        for (m, (out, inp)) in result
            .request
            .messages
            .iter()
            .zip(&request.messages)
            .enumerate()
        {
            for (b, (ob, ib)) in out.content.iter().zip(&inp.content).enumerate() {
                if let (ContentBlock::ToolResult(o), ContentBlock::ToolResult(i)) = (ob, ib)
                    && o.content != i.content
                {
                    changes.push(json!([m, b, o.content]));
                }
            }
        }
        if Value::Array(changes) != expected["changes"] {
            failures.push(format!("{id}: rewritten tool results differ"));
            continue;
        }
        let r = &result.report;
        let report = json!({
            "applied": r.applied,
            "filterHits": r.filter_hits,
            "originalCodeUnits": r.original_code_units,
            "compressedCodeUnits": r.compressed_code_units,
            "estimatedTokensSaved": r.estimated_tokens_saved,
            "filters": r.filters.iter().map(|f| f.as_str()).collect::<Vec<_>>(),
            "skippedInternalErrors": r.skipped_internal_errors,
        });
        let mut ts = expected["report"].clone();
        // JSON numbers: TS writes integral doubles without a fraction.
        if let Some(saved) = ts["estimatedTokensSaved"].as_f64() {
            ts["estimatedTokensSaved"] = json!(saved);
        }
        if report != ts {
            failures.push(format!("{id}: report {report} != TS {ts}"));
        }
    }
    report_failures("transform", cases.len(), &failures);
}

#[test]
fn classify_command_matches_ts() {
    let cases = section("classify");
    let mut failures = Vec::new();
    for case in cases {
        let command = case["command"].as_str().expect("command");
        let actual = classify_command(command).map_or(Value::Null, |c| classification_json(&c));
        let mut expected = case["expected"].clone();
        if let Some(mode) = expected.get_mut("grepMode") {
            for key in ["beforeContext", "afterContext"] {
                if let Some(n) = mode[key].as_f64() {
                    mode[key] = json!(n);
                }
            }
        }
        if actual != expected {
            failures.push(format!("{command:?}: {actual} != TS {expected}"));
        }
    }
    report_failures("classify", cases.len(), &failures);
}

#[test]
fn extract_command_matches_ts() {
    let cases = section("extract");
    let mut failures = Vec::new();
    for case in cases {
        let actual = extract_command(&case["input"]).map_or(Value::Null, |s| json!(s));
        if actual != case["expected"] {
            failures.push(format!(
                "{}: {actual} != TS {}",
                case["input"], case["expected"]
            ));
        }
    }
    report_failures("extract", cases.len(), &failures);
}

#[test]
fn scan_text_matches_ts() {
    let cases = section("scan");
    let mut failures = Vec::new();
    for case in cases {
        let text = case["text"].as_str().expect("text");
        let actual = scan_text(text).map_or(Value::Null, |s| json!(s.lines));
        if actual != case["expected"] {
            failures.push(format!("{text:?}: {actual} != TS {}", case["expected"]));
        }
    }
    report_failures("scan", cases.len(), &failures);
}

fn grep_mode(value: &Value) -> GrepMode {
    GrepMode {
        heading: value["heading"].as_bool().unwrap_or(false),
        line_number: value["lineNumber"].as_bool().unwrap_or(false),
        before_context: value["beforeContext"].as_f64().unwrap_or(0.0),
        after_context: value["afterContext"].as_f64().unwrap_or(0.0),
    }
}

fn run_filter<'a>(call: &Value, input: &BoundedText<'a>) -> Cow<'a, str> {
    let executable = call["executable"].as_str();
    match call["fn"].as_str().expect("fn") {
        "build" => build::compress_build(input),
        "diagnostics" => diagnostics::compress_diagnostics(input),
        "docker" => docker::compress_docker(input),
        "gitOperation" => git::compress_git_operation(input),
        "gitStatus" => status::compress_git_status(input),
        "listing" => listings::compress_listing(
            input,
            executable.unwrap_or("find"),
            call["subcommand"].as_str(),
            call["gated"].as_bool().unwrap_or(false),
        ),
        "packages" => packages::compress_packages(input, executable.unwrap_or("unknown")),
        "grep" => search::compress_grep(input, &grep_mode(&call["mode"])),
        "tests" => tests::compress_tests(input, executable.unwrap_or("unknown")),
        other => panic!("unknown filter {other}"),
    }
}

#[test]
fn filters_match_ts_including_mid_parse_budget_failures() {
    let cases = section("filters");
    let mut failures = Vec::new();
    let mut calls = 0;
    for case in cases {
        let text = case["text"].as_str().expect("text");
        let lines = scan_text(text).expect("scannable").lines;
        for call in case["calls"].as_array().expect("calls") {
            calls += 1;
            let units = usize::try_from(call["units"].as_u64().expect("units")).expect("usize");
            let budget = ParserBudget::new(units);
            let pre = usize::try_from(call["preCharge"].as_u64().unwrap_or(0)).expect("usize");
            if pre > 0 {
                budget.charge_records(pre);
            }
            let input = BoundedText {
                text,
                lines: lines.clone(),
                budget,
            };
            let out = run_filter(call, &input);
            let actual = if out == text { Value::Null } else { json!(out) };
            if actual != call["expected"] {
                failures.push(format!(
                    "{} {}: {} (units {units}, preCharge {pre})",
                    case["id"],
                    call["fn"],
                    if call["expected"].is_null() {
                        "TS returned the input, Rust compressed"
                    } else {
                        "output differs"
                    }
                ));
            }
        }
    }
    report_failures("filters", calls, &failures);
}
