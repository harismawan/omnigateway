//! The Cosy-signed chat request pinned against `qoder.test.ts`: the exact
//! URL, the encoded body's field order and history/tool correlation, the
//! newline-joined MD5 signature, and deterministic fallback builds.

use md5::{Digest as _, Md5};
use omni_ir::error::ErrorCode;
use omni_ir::request::ChatRequest;
use omni_providers::codec::{CodecInput, CodecRequest, Credentials, ProviderCodec};
use omni_providers::qoder::codec::QoderCodec;
use serde_json::{Map, Value, json};

const URL: &str = "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const PATH: &str = "/api/v2/service/pro/sse/agent_chat_generation";

/// `qoderBodyOrder`: the envelope's top-level keys in the order the CLI writes.
const BODY_ORDER: [&str; 20] = [
    "request_id",
    "chat_record_id",
    "request_set_id",
    "session_id",
    "stream",
    "chat_task",
    "is_reply",
    "is_retry",
    "source",
    "version",
    "agent_id",
    "aliyun_user_type",
    "chat_context",
    "session_type",
    "task_id",
    "system",
    "messages",
    "tools",
    "parameters",
    "model_config",
];

fn bundle() -> String {
    serde_json::to_string(&json!({
        "version": 1,
        "deviceToken": "dummy-token",
        "uid": "u1",
        "machineId": "synthetic-device",
        "encryptUserInfo": "encrypted",
        "key": "wrapped",
        "issuedAt": 1700000000000.0,
        "origin": "https://api3.qoder.sh",
        "models": [{
            "key": "synthetic",
            "displayName": "Synthetic",
            "images": true,
            "reasoning": true,
            "maxInputTokens": 1234
        }]
    }))
    .expect("bundle")
}

fn request() -> ChatRequest {
    serde_json::from_value(json!({
        "model": "pool",
        "system": [{"type": "text", "text": "top system"}],
        "conversationId": "private-client-conversation",
        "stream": false,
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            {"role": "assistant", "content": [
                {"type": "toolUse", "id": "portable-1", "name": "weather", "input": {"city": "雪"}}
            ]},
            {"role": "user", "content": [
                {"type": "toolResult", "toolUseId": "portable-1", "content": "sunny"}
            ]},
            {"role": "system", "content": [{"type": "text", "text": "mid system"}]}
        ]
    }))
    .expect("request")
}

fn credentials(access_token: String) -> Credentials {
    let mut provider_data = Map::new();
    // A hostile stored origin must never outrank the signed bundle's own.
    provider_data.insert("inferenceOrigin".into(), json!("https://evil.test"));
    Credentials {
        access_token: Some(access_token),
        api_key: None,
        provider_data,
    }
}

fn build(
    req: &ChatRequest,
    creds: &Credentials,
    request_id: Option<&str>,
    started_at: Option<f64>,
) -> CodecRequest<()> {
    QoderCodec
        .build_request(&CodecInput {
            request: req,
            model: "synthetic",
            credentials: creds,
            request_id,
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: started_at,
        })
        .expect("build request")
}

fn wire_body(built: &CodecRequest<()>) -> Value {
    let plain = omni_crypto::qoder::decode_body(&built.request.body).expect("encoded body");
    serde_json::from_str(&plain).expect("body json")
}

fn header<'a>(built: &'a CodecRequest<()>, name: &str) -> &'a str {
    built
        .request
        .headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
        .unwrap_or_else(|| panic!("{name} missing"))
}

fn md5_hex(input: &str) -> String {
    Md5::digest(input.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn signs_encoded_chat_using_fresh_secret_origin_and_preserves_history_tool_correlation() {
    let req = request();
    let creds = credentials(bundle());
    let before = serde_json::to_string(&req).expect("request json");
    let built = build(&req, &creds, Some("req-1"), Some(1_700_000_001_000.0));
    let again = build(&req, &creds, Some("req-1"), Some(1_700_000_001_000.0));
    assert_eq!(built.request, again.request);
    assert_eq!(built.degradations, again.degradations);
    assert_eq!(serde_json::to_string(&req).expect("request json"), before);
    assert_eq!(built.request.method, "POST");
    assert_eq!(built.request.url, URL);

    let body = wire_body(&built);
    assert_eq!(
        body.as_object().expect("body").keys().collect::<Vec<_>>(),
        BODY_ORDER
    );
    assert_eq!(body["stream"], json!(true));
    assert_eq!(body["chat_task"], json!("FREE_INPUT"));
    assert_eq!(body["session_type"], json!("qodercli"));
    assert_eq!(body["task_id"], json!("common"));
    assert_eq!(body["system"], json!("top system"));
    assert_eq!(
        body["model_config"],
        json!({
            "key": "synthetic", "display_name": "Synthetic", "model": "",
            "is_vl": true, "is_reasoning": true, "max_input_tokens": 1234,
            "source": "system", "format": "openai", "api_key": "", "url": ""
        })
    );
    assert_eq!(
        body["messages"],
        json!([
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "", "tool_calls": [{
                "id": "portable-1", "type": "function",
                "function": {"name": "weather", "arguments": "{\"city\":\"雪\"}"}
            }]},
            {"role": "tool", "tool_call_id": "portable-1", "content": "sunny"},
            {"role": "system", "content": "mid system"}
        ])
    );
    assert_ne!(body["session_id"], json!("private-client-conversation"));

    assert_eq!(header(&built, "Cosy-Date"), "1700000001");
    let authorization = header(&built, "Authorization");
    let parts: Vec<&str> = authorization.split('.').collect();
    assert_eq!(parts[0], "Bearer COSY");
    assert_eq!(
        parts[2],
        md5_hex(&[parts[1], "wrapped", "1700000001", &built.request.body, PATH].join("\n"))
    );
    // The protocol headers keep their positions; only the version-carrying
    // values are installation-overridable.
    let names: Vec<&str> = built
        .request
        .headers
        .iter()
        .map(|(n, _)| n.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "Content-Type",
            "Authorization",
            "Accept",
            "User-Agent",
            "Cosy-Key",
            "Cosy-Date",
            "Cosy-User",
            "Cosy-Version",
            "Cosy-MachineId",
            "Cosy-MachineToken",
            "Cosy-ClientIp",
            "Cosy-ClientType",
            "Cosy-MachineType",
            "Cosy-Business-Product",
            "Cosy-Business-Type",
            "Cosy-Scene",
            "Cosy-Data-Policy",
            "Login-Version"
        ]
    );
    for (name, value) in [
        ("Content-Type", "application/json"),
        ("Accept", "text/event-stream"),
        ("Cosy-Key", "wrapped"),
        ("Cosy-User", "u1"),
        ("Cosy-MachineId", "synthetic-device"),
        ("Cosy-MachineToken", "synthetic-device"),
        ("Cosy-ClientIp", "synthetic-device"),
        ("Cosy-ClientType", "5"),
        ("Cosy-MachineType", "5"),
        ("Cosy-Business-Product", "cli"),
        ("Cosy-Business-Type", "agent"),
        ("Cosy-Scene", "assistant"),
        ("Cosy-Data-Policy", "disagree"),
        ("Login-Version", "v2"),
    ] {
        assert_eq!(header(&built, name), value, "{name}");
    }
    assert!(built.degradations.is_empty());

    // The session id derives from the conversation, not the request id.
    let next = build(&req, &creds, Some("req-2"), Some(1_700_000_001_000.0));
    assert_eq!(wire_body(&next)["session_id"], body["session_id"]);
}

#[test]
fn missing_credential_fails_auth_and_fallback_builds_remain_deterministic() {
    let req = request();
    let bad = credentials("raw-invalid-token".into());
    let err = QoderCodec
        .build_request(&CodecInput {
            request: &req,
            model: "synthetic",
            credentials: &bad,
            request_id: Some("req-1"),
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: Some(1_700_000_001_000.0),
        })
        .expect_err("raw token must fail");
    assert_eq!(err.code, ErrorCode::Auth);
    assert_eq!(err.message, "Invalid Qoder credential; reconnect required");

    let creds = credentials(bundle());
    let built = build(&req, &creds, None, None);
    let again = build(&req, &creds, None, None);
    assert_eq!(built.request, again.request);
    assert_eq!(header(&built, "Cosy-Date"), "1700000000");
    let body = wire_body(&built);
    let id = body["request_id"].as_str().expect("request_id");
    assert_eq!(id.len(), 36);
    assert!(
        id.chars()
            .enumerate()
            .all(|(i, c)| if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit() && !c.is_ascii_uppercase()
            }),
        "not a synthetic uuid: {id}"
    );
}

#[test]
fn wire_exposes_supported_vision_tools_and_records_unsupported_features() {
    let mut req = request();
    req.tools = serde_json::from_value(json!([
        {"kind": "portable", "name": "weather", "inputSchema": {"type": "object"}}
    ]))
    .expect("tools");
    req.max_tokens = Some(777.0);
    req.temperature = Some(0.2);
    req.tool_choice = Some(
        serde_json::from_value(json!({"type": "tool", "name": "weather"})).expect("tool choice"),
    );
    req.reasoning = Some(
        serde_json::from_value(json!({"mode": "adaptive", "effort": "high"})).expect("reasoning"),
    );
    req.messages.push(
        serde_json::from_value(json!({
            "role": "user",
            "content": [
                {"type": "image", "mediaType": "image/png", "data": "synthetic-base64"},
                {"type": "text", "text": "look", "cacheControl": {"type": "ephemeral"}}
            ]
        }))
        .expect("message"),
    );
    let creds = credentials(bundle());
    let built = build(&req, &creds, Some("req-1"), Some(1_700_000_001_000.0));
    let wire = wire_body(&built);
    assert_eq!(
        wire["tools"],
        json!([{
            "type": "function",
            "function": {"name": "weather", "description": "", "parameters": {"type": "object"}}
        }])
    );
    assert_eq!(wire["parameters"]["max_tokens"], json!(777));
    assert_eq!(wire["parameters"]["temperature"], json!(0.2));
    assert_eq!(
        wire["parameters"]["tool_choice"],
        json!({"type": "function", "function": {"name": "weather"}})
    );
    let last = wire["messages"]
        .as_array()
        .expect("messages")
        .last()
        .expect("last");
    assert_eq!(
        last["content"][0],
        json!({"type": "image_url", "image_url": {"url": "data:image/png;base64,synthetic-base64"}})
    );
    // A vision message repeats its parts under `contents` for the CLI.
    assert_eq!(last["contents"], last["content"]);
    assert!(
        built
            .degradations
            .contains(&"qoder:cache-control-dropped".to_owned())
    );
    assert!(
        built
            .degradations
            .contains(&"qoder:reasoning-config-dropped".to_owned())
    );
}
