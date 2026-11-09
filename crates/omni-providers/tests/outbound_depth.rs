use omni_dialects::ingress::{self, Headers, IngressOptions, Surface};
use omni_ir::deep;
use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
use omni_providers::custom::CustomCodec;

#[test]
fn ingress_to_custom_build_depth() {
    if let Ok(protocol) = std::env::var("OMNI_DEPTH_CHILD") {
        std::thread::Builder::new().stack_size(2 * 1024 * 1024).spawn(move || {
            for bound in [10_005, deep::SHALLOW_DEPTH, deep::MAX_DEPTH] {
                for (above, tail) in [
                    (5, r#""tools":[{"type":"function","function":{"name":"f","parameters":{"x":@}}}]"#),
                    (4, r#""response_format":{"type":"json_schema","json_schema":{"name":"f","schema":{"x":@}}}"#),
                    (1, r#""x":@"#),
                    (4, r#""text":{"format":{"type":"json_schema","name":"f","schema":{"x":@}}}"#),
                ] {
                    let levels = bound - above;
                    let nested = format!("{}0{}", "[".repeat(levels), "]".repeat(levels));
                    let body = format!(r#"{{"model":"m","messages":[{{"role":"user","content":"hi"}}],{}}}"#, tail.replace('@', &nested));
                    assert_eq!(deep::depth_of(&body), bound);
                    let mut ids = ingress::random_tool_use_id;
                    let request = ingress::ingest(Surface::OpenAi, &body, &Headers::new(), &mut IngressOptions {new_tool_use_id: &mut ids}).expect("ingress accepted");
                    eprintln!("accepted {protocol} bound={bound} carrier={tail}");
                    let credentials = Credentials { api_key: Some("k".into()), provider_data: serde_json::json!({"origin":"http://localhost", "protocol":protocol}).as_object().unwrap().clone(), ..Default::default() };
                    let before = deep::grows();
                    let built = CustomCodec.build_request(&CodecInput { request: &request.request, model: "m", credentials: &credentials, request_id: None, auto_cache_enabled: None, max_output_tokens: None, request_started_at: None }).expect("build");
                    assert!(built.request.body.contains(&nested), "deep value lost");
                    drop(built);
                    drop(request);
                    if bound == deep::SHALLOW_DEPTH { assert_eq!(before, deep::grows(), "shallow build grew"); }
                }
            }
        }).unwrap().join().unwrap();
        return;
    }
    for protocol in ["chat_completions", "responses"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ingress_to_custom_build_depth", "--nocapture"])
            .env("OMNI_DEPTH_CHILD", protocol)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{protocol}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
