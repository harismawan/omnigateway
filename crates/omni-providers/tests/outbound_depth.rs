use omni_dialects::ingress::{self, Headers, IngressOptions, Surface};
use omni_ir::deep;
use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
use omni_providers::custom::CustomCodec;
use serde_json::json;

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
                    let creds=Credentials{api_key:Some("k".into()),access_token:None,provider_data:Default::default()};
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
                    let credentials = Credentials { api_key: Some("k".into()), provider_data: serde_json::json!({"origin":"http://localhost", "protocol":protocol}).as_object().unwrap().clone(), access_token: None };
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

/// The five ported codecs must build client-controlled deep JSON without a
/// stack overflow on a 2 MiB worker: deep tool `inputSchema`s, deep toolUse
/// `input`s and deep vendor bag values, at the ingress ceiling
/// (`deep::MAX_DEPTH`) and just above the shallow gate. Mirrors
/// `anthropic_outbound_depth`'s harness.
#[test]
fn five_provider_outbound_depth() {
    if std::env::var_os("OMNI_FIVE_DEPTH_CHILD").is_some() {
        std::thread::Builder::new().stack_size(2*1024*1024).spawn(|| {
            for depth in [10_005, deep::MAX_DEPTH] {
                for provider in ["kimi", "kilo", "grok", "muse", "qoder"] {
                    for carrier in ["schema", "vendor", "input"] {
                        eprintln!("start {provider} {depth} {carrier}");
                        let nested = format!("{}0{}", "[".repeat(depth-8), "]".repeat(depth-8));
                        // Every ingress writes the bag named after the surface;
                        // muse reads `openai`, the others their own name.
                        let bag = if provider == "muse" { "openai" } else { provider };
                        let tail = match carrier {
                            "schema" => format!(r#", "tools":[{{"kind":"portable","name":"f","inputSchema":{{"x":{nested}}}}}]"#),
                            "input" => String::new(),
                            _ => format!(r#", "vendor":{{"{bag}":{{"x":{nested}}}}}"#),
                        };
                        let content = if carrier == "input" {
                            format!(r#"{{"type":"toolUse","id":"t","name":"f","input":{nested}}}"#)
                        } else {
                            r#"{"type":"text","text":"hi"}"#.into()
                        };
                        let raw = format!(r#"{{"model":"m","stream":true,"messages":[{{"role":"user","content":[{content}]}}]{tail}}}"#);
                        let value = deep::Owned(deep::parse(&raw).expect("json"));
                        let mut shallow = deep::clone(&value.0);
                        let path = match carrier {
                            "schema" => "/tools/0/inputSchema/x".to_owned(),
                            "input" => "/messages/0/content/0/input".to_owned(),
                            _ => format!("/vendor/{bag}/x"),
                        };
                        let payload = shallow.pointer_mut(&path).expect("payload").take();
                        let mut request: omni_ir::request::ChatRequest = serde_json::from_value(shallow).expect("IR");
                        match carrier {
                            "schema" => if let omni_ir::request::ToolDef::Portable(t) = &mut request.tools.as_mut().expect("tools")[0] { t.input_schema["x"] = payload; },
                            "input" => if let omni_ir::request::ContentBlock::ToolUse(t) = &mut request.messages[0].content[0] { t.input = payload; },
                            _ => request.vendor.as_mut().expect("vendor")[bag]["x"] = payload,
                        }
                        let creds = if provider == "qoder" {
                            Credentials {
                                access_token: Some(serde_json::to_string(&json!({
                                    "version": 1, "deviceToken": "t", "uid": "u1",
                                    "machineId": "synthetic-device", "encryptUserInfo": "e",
                                    "key": "k", "issuedAt": 1700000000000.0,
                                    "origin": "https://api3.qoder.sh", "models": []
                                })).expect("bundle")),
                                api_key: None,
                                provider_data: Default::default(),
                            }
                        } else {
                            Credentials { api_key: Some("k".into()), access_token: None, provider_data: Default::default() }
                        };
                        // No request id: qoder's fallback seed serializes the
                        // whole deep request, which must stay scoped too.
                        let input = CodecInput { request: &request, model: "m", credentials: &creds, request_id: None, auto_cache_enabled: None, max_output_tokens: None, request_started_at: None };
                        let built = match provider {
                            "kimi" => omni_providers::kimi::codec::KimiCodec.build_request(&input).expect("build").request,
                            "kilo" => omni_providers::kilo::codec::KiloCodec.build_request(&input).expect("build").request,
                            "grok" => omni_providers::grok::codec::GrokCodec.build_request(&input).expect("build").request,
                            "muse" => omni_providers::muse::codec::MuseCodec.build_request(&input).expect("build").request,
                            _ => omni_providers::qoder::codec::QoderCodec.build_request(&input).expect("build").request,
                        };
                        if provider == "qoder" {
                            let plain = omni_crypto::qoder::decode_body(&built.body).expect("encoded body");
                            if carrier != "vendor" {
                                assert!(plain.contains(&nested), "lost {carrier} depth {depth}");
                            }
                            // The vendor bag is dropped on this wire; the
                            // build surviving its depth is the assertion.
                        } else {
                            assert!(built.body.contains(&nested), "lost {carrier} depth {depth} for {provider}");
                        }
                        drop(built); drop(request); drop(value);
                    }
                }
            }
        }).expect("thread").join().expect("child");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args(["--exact", "five_provider_outbound_depth", "--nocapture"])
        .env("OMNI_FIVE_DEPTH_CHILD", "1")
        .output()
        .expect("child");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
