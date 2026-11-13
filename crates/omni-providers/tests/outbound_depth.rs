use omni_dialects::ingress::{self, Headers, IngressOptions, Surface};
use omni_ir::deep;
use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
use omni_providers::custom::CustomCodec;

#[test]
fn anthropic_outbound_depth() {
    if std::env::var_os("OMNI_ANTHROPIC_DEPTH_CHILD").is_some() {
        std::thread::Builder::new().stack_size(2*1024*1024).spawn(|| {
            for depth in [10_000,40_000] {
                for carrier in ["schema","input","vendor","default"] {
                    eprintln!("start {depth} {carrier}");
                    let nested=format!("{}0{}","[".repeat(depth-8),"]".repeat(depth-8));
                    let tail=match carrier {
                        "schema"=>format!(r#", "tools":[{{"kind":"portable","name":"f","inputSchema":{{"x":{nested}}}}}]"#),
                        "input"=>String::new(),
                        "vendor"=>format!(r#", "vendor":{{"anthropic":{{"x":{nested}}}}}"#),
                        _=>format!(r#", "vendor":{{"anthropic":{{"output_config":{{"format":{{"type":"json_schema","schema":{{"default":{nested}}}}}}}}}}}"#),
                    };
                    let content=if carrier=="input" {format!(r#"{{"type":"toolUse","id":"t","name":"f","input":{nested}}}"#)} else {r#"{"type":"text","text":"hi"}"#.into()};
                    let raw=format!(r#"{{"model":"m","stream":true,"messages":[{{"role":"user","content":[{content}]}}]{tail}}}"#);
                    let value=deep::Owned(deep::parse(&raw).expect("json"));
                    let mut shallow=deep::clone(&value.0);
                    let path=match carrier {"schema"=>"/tools/0/inputSchema/x","input"=>"/messages/0/content/0/input","vendor"=>"/vendor/anthropic/x",_=>"/vendor/anthropic/output_config/format/schema/default"};
                    let payload=shallow.pointer_mut(path).expect("payload").take();
                    let mut request:omni_ir::request::ChatRequest=serde_json::from_value(shallow).expect("IR");
                    match carrier {
                        "schema"=>if let omni_ir::request::ToolDef::Portable(t)=&mut request.tools.as_mut().expect("tools")[0]{t.input_schema["x"]=payload;},
                        "input"=>if let omni_ir::request::ContentBlock::ToolUse(t)=&mut request.messages[0].content[0]{t.input=payload;},
                        "vendor"=>request.vendor.as_mut().expect("vendor")["anthropic"]["x"]=payload,
                        _=>request.vendor.as_mut().expect("vendor")["anthropic"]["output_config"]["format"]["schema"]["default"]=payload,
                    }
                    let creds=Credentials{api_key:Some("k".into()),..Default::default()};
                    eprintln!("parsed {depth} {carrier}");
                    let built=omni_providers::anthropic::codec::AnthropicCodec.build_request(&CodecInput{request:&request,model:"m",credentials:&creds,request_id:None,auto_cache_enabled:Some(true),max_output_tokens:None,request_started_at:None}).expect("build");
                    assert!(built.request.body.contains(&nested),"lost {carrier} depth {depth}");
                    drop(built);drop(request);drop(value);
                }
            }
        }).expect("thread").join().expect("child");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args(["--exact", "anthropic_outbound_depth", "--nocapture"])
        .env("OMNI_ANTHROPIC_DEPTH_CHILD", "1")
        .output()
        .expect("child");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[allow(clippy::unwrap_used)] // Child-process fixture setup; every failure aborts the regression.
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
