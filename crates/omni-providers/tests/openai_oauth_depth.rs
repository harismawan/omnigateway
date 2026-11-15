//! OAuth vendor ownership boundaries, independently isolated per carrier.
use omni_ir::{deep, request::ChatRequest};
use omni_providers::{
    codec::{CodecInput, Credentials, ProviderCodec},
    openai::OpenAiCodec,
};
use serde_json::{Value, json};

fn exercise(case: &str) {
    let mut req: ChatRequest = serde_json::from_value(
        json!({"model":"m","stream":false,"messages":[],"vendor":{"openai":{}}}),
    )
    .expect("shallow fixture");
    let mut value = Value::Null;
    for _ in 0..39_990 {
        value = Value::Array(vec![value]);
    }
    let bag = req
        .vendor
        .as_mut()
        .expect("vendor")
        .get_mut("openai")
        .expect("bag")
        .as_object_mut()
        .expect("object");
    match case {
        "text_merge" | "reasoning_merge" => {
            let mut fields = serde_json::Map::new();
            deep::insert(&mut fields, "extension".into(), value);
            deep::insert(
                bag,
                case.trim_end_matches("_merge").into(),
                Value::Object(fields),
            );
        }
        "scalar" => {
            deep::insert(bag, "reasoning".into(), value);
        }
        "metadata" => {
            deep::insert(bag, "client_metadata".into(), value);
        }
        "input_replace" => {
            deep::insert(bag, "input".into(), value);
        }
        "stream_replace" => {
            deep::insert(bag, "stream".into(), value);
        }
        _ => panic!("unknown carrier"),
    }
    let credentials = Credentials {
        access_token: Some("token".into()),
        ..Default::default()
    };
    let built = OpenAiCodec
        .build_request(&CodecInput {
            request: &req,
            model: "gpt-6-astra",
            credentials: &credentials,
            request_id: Some("depth"),
            request_started_at: Some(1794000000123.0),
            auto_cache_enabled: None,
            max_output_tokens: None,
        })
        .expect("OAuth build");
    if matches!(case, "metadata" | "input_replace" | "stream_replace") {
        assert!(built.request.body.len() < 4000);
    } else {
        assert!(built.request.body.len() > 79_000);
    }
    drop(built);
    drop(req);
}

#[test]
fn vendor_carriers_on_small_stack() {
    if let Ok(case) = std::env::var("OPENAI_OAUTH_CARRIER") {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || exercise(&case))
            .expect("thread")
            .join()
            .expect("join");
        return;
    }
    for case in [
        "text_merge",
        "reasoning_merge",
        "scalar",
        "metadata",
        "input_replace",
        "stream_replace",
    ] {
        let output = std::process::Command::new(std::env::current_exe().expect("exe"))
            .arg("--exact")
            .arg("vendor_carriers_on_small_stack")
            .arg("--nocapture")
            .env("OPENAI_OAUTH_CARRIER", case)
            .output()
            .expect("child");
        assert!(
            output.status.success(),
            "{case}: {:?}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        eprintln!("{case}: passed (39990 levels, 2 MiB)");
    }
}
