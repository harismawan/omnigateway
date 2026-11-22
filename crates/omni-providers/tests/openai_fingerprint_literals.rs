#![allow(clippy::unwrap_used)]
//! Captured literals: independent of the executable differential oracle.
use omni_providers::codec::{CodecInput, CodecRequest, Credentials, ProviderCodec};
use omni_providers::openai::OpenAiCodec;
use serde_json::{Value, json};

const THREAD: &str = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const START: f64 = 1_792_140_063_816.0;
const META: &str = "internal_chat_message_metadata_passthrough";

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/codex-0.170.0.json")).unwrap()
}
fn request() -> Value {
    serde_json::from_str(r#"{"model":"pool","system":[{"type":"text","text":"be brief"}],"tools":[{"kind":"portable","name":"wait","description":"Waits.","inputSchema":{"type":"object","properties":{"cell_id":{"type":"string"}},"required":["cell_id"],"additionalProperties":false}}],"messages":[{"role":"user","content":[{"type":"text","text":"wait a moment then say hi"}]},{"role":"assistant","content":[{"type":"providerNative","provider":"openai","blockType":"reasoning","data":{"id":"rs_1","summary":[],"encrypted_content":"opaque"}},{"type":"text","text":"Waiting briefly."},{"type":"toolUse","id":"call_1","name":"sleep","input":{"duration_ms":1}}]},{"role":"user","content":[{"type":"toolResult","toolUseId":"call_1","content":"Sleep completed."}]}],"stream":true,"vendor":{"openai":{"prompt_cache_key":"0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b"}}}"#).unwrap()
}
fn build(r: Value, model: &str) -> CodecRequest<bool> {
    build_with(
        r,
        model,
        json!({"accountId":"acct-9"}),
        Some(START),
        "req_1",
    )
}
fn build_with(
    r: Value,
    model: &str,
    data: Value,
    start: Option<f64>,
    id: &str,
) -> CodecRequest<bool> {
    let request = serde_json::from_value(r).unwrap();
    let credentials = Credentials {
        access_token: Some("oa-tok".into()),
        provider_data: serde_json::from_value(data).unwrap(),
        api_key: None,
    };
    OpenAiCodec
        .build_request(&CodecInput {
            request: &request,
            model,
            credentials: &credentials,
            request_id: Some(id),
            request_started_at: start,
            auto_cache_enabled: None,
            max_output_tokens: None,
        })
        .unwrap()
}
fn body(b: &CodecRequest<bool>) -> Value {
    serde_json::from_str(&b.request.body).unwrap()
}
fn header<'a>(b: &'a CodecRequest<bool>, name: &str) -> Option<&'a str> {
    b.request
        .headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}
fn metadata(b: &CodecRequest<bool>) -> Value {
    serde_json::from_str(header(b, "x-codex-turn-metadata").unwrap()).unwrap()
}
fn keys(v: &Value) -> Value {
    json!(v.as_object().unwrap().keys().collect::<Vec<_>>())
}
fn shape(v: &Value) -> Value {
    match v {
        Value::Object(o) => json!(
            o.iter()
                .map(|(k, v)| json!([k, shape(v)]))
                .collect::<Vec<_>>()
        ),
        Value::Array(a) => json!(a.iter().map(shape).collect::<Vec<_>>()),
        Value::Null => json!("null"),
        Value::Bool(_) => json!("boolean"),
        Value::Number(_) => json!("number"),
        Value::String(_) => json!("string"),
    }
}
fn uuid(value: &Value, version: u8) {
    let s = value.as_str().unwrap();
    assert_eq!(s.len(), 36);
    for (i, c) in s.bytes().enumerate() {
        if [8, 13, 18, 23].contains(&i) {
            assert_eq!(c, b'-');
        } else {
            assert!(c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
        }
    }
    assert_eq!(s.as_bytes()[14], b'0' + version);
    assert!(b"89ab".contains(&s.as_bytes()[19]));
}

#[test]
fn captured_headers_and_metadata() {
    // Pinned declarations 1, 2, 3, 5, 25.
    let b = build(request(), "gpt-6-astra");
    let f = fixture();
    let m = metadata(&b);
    let body = body(&b);
    let expected: Vec<_> = f["headerNames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| *n != "content-length")
        .cloned()
        .collect();
    assert_eq!(
        json!(b.request.headers.iter().map(|(n, _)| n).collect::<Vec<_>>()),
        json!(expected)
    );
    for (n, v) in f["headerValues"].as_object().unwrap() {
        assert_eq!(header(&b, n), v.as_str());
    }
    for (n, v) in [
        ("host", "chatgpt.com"),
        ("authorization", "Bearer oa-tok"),
        ("chatgpt-account-id", "acct-9"),
        ("x-codex-routing-hint", "model=gpt-6-astra"),
        ("version", "0.170.0"),
        (
            "user-agent",
            "codex-tui/0.170.0 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.170.0)",
        ),
    ] {
        assert_eq!(header(&b, n), Some(v));
    }
    for n in ["x-client-request-id", "session-id", "thread-id"] {
        assert_eq!(header(&b, n), Some(THREAD));
    }
    assert_eq!(
        header(&b, "x-codex-window-id"),
        Some(format!("{THREAD}:0").as_str())
    );
    assert_eq!(
        b.request.body_encoding,
        Some(omni_providers::http::BodyEncoding::Zstd)
    );
    assert_eq!(keys(&m), keys(&f["turnMetadata"]));
    for (k, v) in f["turnMetadata"].as_object().unwrap() {
        if ![
            "installation_id",
            "session_id",
            "thread_id",
            "turn_id",
            "window_id",
            "context_window_id",
            "root_turn_id",
            "sandbox",
            "turn_started_at_unix_ms",
        ]
        .contains(&k.as_str())
        {
            assert_eq!(&m[k], v, "{k}");
        }
    }
    assert_eq!(m["session_id"], THREAD);
    assert_eq!(m["thread_id"], THREAD);
    assert_eq!(m["window_id"], format!("{THREAD}:0"));
    assert_eq!(m["root_turn_id"], m["turn_id"]);
    assert_eq!(m["turn_started_at_unix_ms"].as_f64(), Some(START));
    assert_eq!(m["sandbox"], "windows_elevated");
    uuid(&m["context_window_id"], 7);
    let c = &body["client_metadata"];
    let mut a = c.as_object().unwrap().keys().collect::<Vec<_>>();
    a.sort();
    let mut e = f["clientMetadata"]
        .as_object()
        .unwrap()
        .keys()
        .collect::<Vec<_>>();
    e.sort();
    assert_eq!(a, e);
    assert_eq!(c["guardian_credits_requested"], "true");
    assert_eq!(c["mcp_attribution"], r#"{"status":"none"}"#);
    assert_eq!(
        c["x-codex-turn-metadata"],
        header(&b, "x-codex-turn-metadata").unwrap()
    );
    for (ck, mk) in [
        ("x-codex-installation-id", "installation_id"),
        ("x-codex-window-id", "window_id"),
        ("session_id", "session_id"),
        ("thread_id", "thread_id"),
        ("turn_id", "turn_id"),
        ("root_turn_id", "turn_id"),
    ] {
        assert_eq!(c[ck], m[mk]);
    }
}

#[test]
fn captured_body_prefix_and_history() {
    // Pinned 4, 6, 7 (prefix vectors), 8, 11, 36, 38, 44.
    let b = build(request(), "gpt-6-astra");
    let body = body(&b);
    let f = fixture();
    assert_eq!(keys(&body), f["bodyKeys"]);
    for (k, v) in f["body"].as_object().unwrap() {
        if k != "prompt_cache_key" {
            assert_eq!(&body[k], v);
        }
    }
    assert_eq!(body["prompt_cache_key"], THREAD);
    let mut expected = f["followUpInput"].clone();
    for item in expected.as_array_mut().unwrap() {
        if item["type"] == "reasoning" {
            item.as_object_mut().unwrap().shift_remove("id");
        } else {
            item.as_object_mut().unwrap().shift_remove("namespace");
        }
    }
    assert_eq!(shape(&body["input"]), shape(&expected));
    let input = body["input"].as_array().unwrap();
    assert_eq!(input[0]["id"], "at_70a59add-2fa0-5d38-a50e-618d1c07a614");
    assert_eq!(input[1]["id"], "msg_8d0d7cab-7b2b-5e76-8ff1-9484d537c418");
    assert_eq!(
        input[0]["tools"],
        json!([{"type":"namespace","name":"functions","description":"","tools":[{"type":"function","name":"wait","description":"Waits.","strict":false,"parameters":request()["tools"][0]["inputSchema"]}]}])
    );
    let history: Vec<_> = input
        .iter()
        .skip(2)
        .filter(|v| v["type"] != "configuration_update")
        .collect();
    assert_eq!(history[0][META]["create_time"], json!(START / 1000.0));
    assert_eq!(
        history[4][META]["create_time"],
        json!((START * 1000.0 + 4.0) / 1_000_000.0)
    );
    assert_eq!(history[0][META]["content_item_kinds"], json!(["user.text"]));
    assert_eq!(history[2][META]["content_item_kinds"], json!(["unknown"]));
    assert_eq!(history[2]["status"], "completed");
    assert_eq!(history[3]["status"], "completed");
    assert_eq!(keys(&history[3][META]), json!(["turn_id"]));
    assert_eq!(keys(&history[4][META]), json!(["turn_id", "create_time"]));
    assert_eq!(
        &metadata(&b)["context_window_id"].as_str().unwrap()[..13],
        &THREAD[..13]
    );
}

#[test]
fn catalog_and_non_lite_literals() {
    // Pinned 28, 29, 30, 33, 34.
    let lite = body(&build(request(), "gpt-6-astra"));
    assert_eq!(
        lite["input"][1][META]["content_item_metadata"],
        json!([{"provenance":{"type":"harness","hook":false}}])
    );
    assert_eq!(
        lite["input"][2][META]["content_item_metadata"],
        json!([{"provenance":{"type":"user"}}])
    );
    for (model, lite, verbosity, effort, review) in [
        ("gpt-6.2-sol", true, "low", "low", true),
        ("gpt-6.2-astra", true, "low", "low", true),
        ("gpt-6-astra", true, "low", "low", true),
        ("gpt-6.1-sol", true, "low", "low", true),
        ("gpt-6.1-terra", true, "low", "low", true),
        ("gpt-6-sol", true, "low", "medium", true),
        ("gpt-6-luna", true, "low", "medium", false),
        ("gpt-5.6-sol", true, "low", "low", false),
        ("gpt-5.6-terra", true, "low", "medium", false),
        ("gpt-5.6-luna", true, "low", "medium", false),
        ("gpt-daybreak-blue-latest", true, "low", "low", false),
        ("gpt-daybreak-red-latest", true, "high", "medium", false),
        ("gpt-5.5", false, "low", "medium", false),
        ("codex-auto-review", true, "low", "medium", false),
    ] {
        let b = build(request(), model);
        let v = body(&b);
        let m = metadata(&b);
        assert_eq!(
            header(&b, "x-openai-internal-codex-responses-lite"),
            lite.then_some("true")
        );
        assert_eq!(v["text"], json!({"verbosity":verbosity}));
        assert_eq!(v["reasoning"]["effort"], effort);
        assert_eq!(m["node_repl_auto_review_required"], review);
        assert_eq!(m["node_repl_disabled"], false);
        if !lite {
            assert_eq!(
                keys(&v),
                json!([
                    "model",
                    "stream",
                    "input",
                    "tools",
                    "tool_choice",
                    "parallel_tool_calls",
                    "reasoning",
                    "store",
                    "include",
                    "prompt_cache_key",
                    "text",
                    "client_metadata"
                ])
            );
            assert_eq!(
                v["tools"],
                json!([{"type":"function","name":"wait","description":"Waits.","strict":false,"parameters":request()["tools"][0]["inputSchema"]}])
            );
            assert_eq!(v["parallel_tool_calls"], true);
            assert_eq!(v["reasoning"], json!({"effort":"medium"}));
            assert_eq!(v["input"][0]["type"], "message");
            assert_eq!(v["input"][0]["role"], "developer");
            assert_eq!(
                v["input"][0]["id"],
                "msg_8d0d7cab-7b2b-5e76-8ff1-9484d537c418"
            );
            for item in v["input"].as_array().unwrap() {
                assert_ne!(item["type"], "additional_tools");
                assert!(item[META].get("content_item_metadata").is_none());
            }
            assert_eq!(header(&b, "x-codex-routing-hint"), Some("model=gpt-5.5"));
        }
    }
    for model in [
        "gpt-6.2-sol",
        "gpt-6.2-astra",
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-6.1-terra",
    ] {
        let mut r = request();
        r["reasoning"] = json!({"mode":"adaptive","effort":"high"});
        let v = body(&build(r, model));
        assert_eq!(
            v["input"][3],
            json!({"type":"configuration_update","reasoning":{"effort":"high"}})
        );
        assert_eq!(
            v["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|i| i["type"] == "configuration_update")
                .count(),
            1
        );
    }
    for model in ["gpt-5.5", "gpt-6-luna", "unlisted"] {
        assert!(
            !body(&build(request(), model))["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["type"] == "configuration_update")
        );
    }
}

#[test]
fn overrides_and_identity_literals() {
    // Pinned 10/14 format portions; 20, 21, 22, 23, 32 OAuth portion, 35.
    let b = build(request(), "gpt-6-astra");
    let v = body(&b);
    uuid(&metadata(&b)["installation_id"], 4);
    for item in v["input"].as_array().unwrap().iter().skip(2) {
        if let Some(id) = item["id"].as_str() {
            let (prefix, tail) = id.split_once('_').unwrap();
            assert!(["msg", "fc", "fco"].contains(&prefix));
            uuid(&json!(tail), 7);
        }
    }
    assert!(!b.decode_state);
    assert_eq!(v["include"], json!(["reasoning.encrypted_content"]));
    let mut r = request();
    r["vendor"]["openai"]["include"] = json!(["reasoning.encrypted_content"]);
    assert!(build(r, "gpt-6-astra").decode_state);
    let mut r = request();
    r["vendor"]["openai"]["client_metadata"] =
        json!({"x-codex-installation-id":"REAL-INSTALLATION"});
    let changed = build(r, "gpt-6-astra");
    assert!(!changed.request.body.contains("REAL-INSTALLATION"));
    assert!(
        changed
            .degradations
            .iter()
            .any(|s| s == "openai:client-metadata-replaced")
    );
    assert!(
        !b.degradations
            .iter()
            .any(|s| s == "openai:client-metadata-replaced")
    );
    let format = json!({"type":"json_schema","name":"out","strict":true,"schema":{"type":"object","properties":{},"additionalProperties":false}});
    let mut r = request();
    r["vendor"]["openai"]["text"] = json!({"format":format});
    r["vendor"]["openai"]["reasoning"] = json!({"effort":"high"});
    r["vendor"]["openai"]["service_tier"] = json!("priority");
    let changed = build(r, "gpt-6-astra");
    let v = body(&changed);
    assert_eq!(v["text"], json!({"verbosity":"low","format":format}));
    assert_eq!(
        v["reasoning"],
        json!({"effort":"high","context":"all_turns"})
    );
    assert_eq!(keys(&v)[2], "service_tier");
    assert_eq!(v["service_tier"], "priority");
    assert_eq!(
        header(&changed, "x-codex-routing-hint"),
        Some("model=gpt-6-astra;tier=priority")
    );
    let mut r = request();
    r["vendor"]["openai"]["reasoning"] = json!({"effort":"max"});
    assert_eq!(
        body(&build(r, "gpt-6-astra"))["input"][3],
        json!({"type":"configuration_update","reasoning":{"effort":"max"}})
    );
    assert_eq!(body(&b)["tool_choice"], "auto");
    let mut r = request();
    r["toolChoice"] = json!({"type":"any"});
    assert_eq!(body(&build(r, "gpt-6-astra"))["tool_choice"], "required");
}

#[test]
fn media_and_system_provenance_literals() {
    // Pinned 31, 37, 39.
    let mut r = request();
    r["messages"][2]["content"][0]["images"] =
        json!([{"type":"image","mediaType":"image/png","data":"aGVsbG8="}]);
    r["messages"][2]["content"][0]["files"] =
        json!([{"type":"file","mediaType":"application/pdf","data":"JVBERi0xLjQK"}]);
    let v = body(&build(r.clone(), "gpt-6-astra"));
    assert_eq!(
        v["input"][3],
        json!({"type":"configuration_update","reasoning":{"effort":"low"}})
    );
    let media = v["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|i| i["role"] == "user")
        .unwrap();
    assert_eq!(
        media[META]["content_item_metadata"],
        json!([{"provenance":{"type":"tool"}},{"provenance":{"type":"tool"}}])
    );
    r["messages"][2]["content"][0]
        .as_object_mut()
        .unwrap()
        .shift_remove("images");
    let v = body(&build(r, "gpt-6-astra"));
    let media = v["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|i| i["role"] == "user")
        .unwrap();
    assert_eq!(media["content"][0]["type"], "input_file");
    assert_eq!(media["content"].as_array().unwrap().len(), 1);
    assert_eq!(
        keys(&media[META]),
        json!(["turn_id", "create_time", "content_item_metadata"])
    );
    let mut r = request();
    r["messages"] = json!([{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","mediaType":"image/png","data":"iVBORw0KGgo="}]}]);
    assert_eq!(
        body(&build(r, "gpt-6-astra"))["input"][2][META]["content_item_kinds"],
        json!(["user.text", "user.image"])
    );
    let mut r = request();
    r["messages"].as_array_mut().unwrap().truncate(1);
    r["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({"role":"system","content":[{"type":"text","text":"operator note"}]}));
    let b = build(r, "gpt-6-astra");
    let v = body(&b);
    let item = v["input"].as_array().unwrap().last().unwrap();
    assert_eq!(item["type"], "message");
    assert_eq!(item["role"], "developer");
    assert!(item["id"].as_str().unwrap().starts_with("msg_"));
    assert_eq!(item[META]["content_item_kinds"], json!(["user.text"]));
    assert_eq!(item[META]["turn_id"], v["input"][2][META]["turn_id"]);
    assert_eq!(metadata(&b)["turn_id"], item[META]["turn_id"]);
}

#[test]
fn stored_and_derived_id_literals() {
    // Pinned 15, 17 UUID literal/format portions; behavior in cache-pairs/identity.
    let installation = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    for key in [THREAD, "another-conversation"] {
        let mut r = request();
        r["vendor"]["openai"]["prompt_cache_key"] = json!(key);
        let b = build_with(
            r,
            "gpt-6-astra",
            json!({"installationId":installation,"idSalt":"ab".repeat(32)}),
            Some(START),
            "req_1",
        );
        assert_eq!(metadata(&b)["installation_id"], installation);
        assert_eq!(
            body(&b)["client_metadata"]["x-codex-installation-id"],
            installation
        );
        if key == THREAD {
            assert_eq!(body(&b)["prompt_cache_key"], THREAD);
        } else {
            uuid(&body(&b)["prompt_cache_key"], 7);
        }
    }
    let mut r = request();
    r["vendor"] = json!({});
    let b = build_with(
        r,
        "gpt-6-astra",
        json!({"idSalt":"ab".repeat(32)}),
        Some(START),
        "req_1",
    );
    uuid(&body(&b)["prompt_cache_key"], 7);
}
