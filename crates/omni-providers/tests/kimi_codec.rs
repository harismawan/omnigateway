//! The wire kimi puts on the socket, pinned against literals carried over
//! from the TS adapter's captured bytes (`kimiCodec.test.ts`, `kimi.test.ts`).
//!
//! Order is pinned as much as content: the upstream expects a particular
//! client, so a test comparing header *sets* would pass while the wire
//! changed. `X-Msh-Version` and `User-Agent` carry a version an installation
//! may override, so their positions are pinned and their values are not.

use omni_ir::error::ErrorCode;
use omni_ir::request::ChatRequest;
use omni_providers::codec::{CodecInput, CodecRequest, Credentials, ProviderCodec};
use omni_providers::kimi::codec::KimiCodec;
use omni_providers::kimi::wire::to_chat_wire;
use serde_json::{Map, Value, json};

const URL: &str = "https://api.kimi.com/coding/v1/chat/completions";

const BODY: &str = concat!(
    r#"{"model":"kimi-k2","messages":[{"role":"user","content":"hi"}],"#,
    r#""stream":true,"stream_options":{"include_usage":true}}"#
);

/// The device identity as `mint` freezes it onto a credential.
fn device() -> Map<String, Value> {
    serde_json::from_value(json!({
        "deviceId": "dev-1",
        "deviceName": "MacBook-Pro",
        "deviceModel": "MacBookPro18,3",
        "osVersion": "15.3.1"
    }))
    .expect("device map")
}

fn request(shape: Value) -> ChatRequest {
    serde_json::from_value(shape).expect("request")
}

fn base() -> ChatRequest {
    request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true
    }))
}

fn credentials(provider_data: Map<String, Value>) -> Credentials {
    Credentials {
        access_token: Some("kimi-oauth-token".into()),
        api_key: None,
        provider_data,
    }
}

fn build(req: &ChatRequest, creds: &Credentials) -> CodecRequest<()> {
    KimiCodec
        .build_request(&CodecInput {
            request: req,
            model: "kimi-k2",
            credentials: creds,
            request_id: None,
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .expect("build request")
}

/// Header values, with the two an installation may override left out.
fn pinned(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| name != "X-Msh-Version" && name != "User-Agent")
        .cloned()
        .collect()
}

fn names(headers: &[(String, String)]) -> Vec<&str> {
    headers.iter().map(|(n, _)| n.as_str()).collect()
}

#[test]
fn a_credential_with_no_device_identity_sends_the_protocol_headers_alone() {
    let built = build(&base(), &credentials(Map::new()));
    let sent = &built.request;
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.url, URL);
    assert_eq!(sent.body, BODY);
    assert_eq!(
        names(&sent.headers),
        [
            "Content-Type",
            "Authorization",
            "X-Msh-Platform",
            "X-Msh-Version",
            "User-Agent",
            "Accept"
        ]
    );
    assert_eq!(
        pinned(&sent.headers),
        [
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), "Bearer kimi-oauth-token".into()),
            ("X-Msh-Platform".into(), "kimi_code_cli".into()),
            ("Accept".into(), "text/event-stream".into()),
        ]
    );
    assert!(built.degradations.is_empty());
}

#[test]
fn a_device_identity_is_sent_whole_and_in_its_own_place_in_the_order() {
    let built = build(&base(), &credentials(device()));
    // Position, not presence: asserting only that the device headers are
    // somewhere in the list would pass with them appended to the end.
    assert_eq!(
        names(&built.request.headers),
        [
            "Content-Type",
            "Authorization",
            "X-Msh-Platform",
            "X-Msh-Version",
            "X-Msh-Device-Id",
            "X-Msh-Device-Name",
            "X-Msh-Device-Model",
            "X-Msh-Os-Version",
            "User-Agent",
            "Accept"
        ]
    );
    assert_eq!(
        pinned(&built.request.headers),
        [
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), "Bearer kimi-oauth-token".into()),
            ("X-Msh-Platform".into(), "kimi_code_cli".into()),
            ("X-Msh-Device-Id".into(), "dev-1".into()),
            ("X-Msh-Device-Name".into(), "MacBook-Pro".into()),
            ("X-Msh-Device-Model".into(), "MacBookPro18,3".into()),
            ("X-Msh-Os-Version".into(), "15.3.1".into()),
            ("Accept".into(), "text/event-stream".into()),
        ]
    );
}

#[test]
fn a_credential_minted_before_the_device_fields_exist_still_identifies_itself() {
    // Real stored state: credentials created before the three descriptive
    // fields existed carry only `deviceId`. Dropping the header set entirely
    // would change the device this credential has always claimed to be.
    let mut data = Map::new();
    data.insert("deviceId".into(), json!("dev-2"));
    let built = build(&base(), &credentials(data));
    let headers = &built.request.headers;
    for pair in [
        ("X-Msh-Device-Id", "dev-2"),
        ("X-Msh-Device-Name", "unknown"),
        ("X-Msh-Device-Model", "unknown"),
        ("X-Msh-Os-Version", "unknown"),
    ] {
        assert!(
            headers
                .iter()
                .any(|(n, v)| (n.as_str(), v.as_str()) == pair),
            "{pair:?} missing from {headers:?}"
        );
    }
}

#[test]
fn an_api_key_is_sent_as_the_same_bearer_to_the_same_host() {
    // Kimi serves both credential types from one URL. Asserted so that a
    // future split is a deliberate change rather than a silent one.
    let creds = Credentials {
        access_token: None,
        api_key: Some("kimi-api-key".into()),
        provider_data: device(),
    };
    let built = build(&base(), &creds);
    assert_eq!(built.request.url, URL);
    assert!(
        built
            .request
            .headers
            .contains(&("Authorization".into(), "Bearer kimi-api-key".into()))
    );
}

#[test]
fn an_access_token_wins_over_an_api_key() {
    // `accessToken ?? apiKey`: nullish, not truthy — but a present access
    // token is the one the OAuth flow minted, so it goes on the wire.
    let creds = Credentials {
        access_token: Some("kimi-oauth-token".into()),
        api_key: Some("kimi-api-key".into()),
        provider_data: Map::new(),
    };
    let built = build(&base(), &creds);
    assert!(
        built
            .request
            .headers
            .contains(&("Authorization".into(), "Bearer kimi-oauth-token".into()))
    );
}

#[test]
fn a_non_streaming_client_request_still_asks_the_upstream_to_stream() {
    // Dispatch serves a non-streaming client by collecting the stream, so the
    // request going out is identical either way.
    let mut shape = base();
    shape.stream = false;
    let built = build(&shape, &credentials(device()));
    assert_eq!(built.request.body, BODY);
}

#[test]
fn a_credential_carrying_no_token_is_an_auth_failure_not_a_bare_request() {
    // Dispatch gates its credential-refresh retry on AUTH, so a codec failure
    // flattened to UPSTREAM would fail over instead of refreshing. The pure
    // builder fails before any request exists to send.
    let creds = Credentials {
        access_token: None,
        api_key: None,
        provider_data: Map::new(),
    };
    let error = KimiCodec
        .build_request(&CodecInput {
            request: &base(),
            model: "kimi-k2",
            credentials: &creds,
            request_id: None,
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .expect_err("no token");
    assert_eq!(error.code, ErrorCode::Auth);
    assert_eq!(error.message, "kimi credential has no token");
}

#[test]
fn the_full_body_keeps_the_cli_field_order() {
    // BODY_ORDER first, unlisted keys appended in insertion order:
    // `stream_options` then `stop`.
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "tools": [{"kind": "portable", "name": "f", "description": "d", "inputSchema": {"type": "object"}}],
        "toolChoice": {"type": "auto"},
        "maxTokens": 100,
        "temperature": 0.5,
        "stopSequences": ["x"]
    }));
    let built = build(&req, &credentials(Map::new()));
    assert_eq!(
        built.request.body,
        concat!(
            r#"{"model":"kimi-k2","messages":[{"role":"user","content":"hi"}],"#,
            r#""tools":[{"type":"function","function":{"name":"f","description":"d","parameters":{"type":"object"}}}],"#,
            r#""tool_choice":"auto","max_tokens":100,"temperature":0.5,"stream":true,"#,
            r#""stream_options":{"include_usage":true},"stop":["x"]}"#
        )
    );
}

#[test]
fn collapses_single_text_blocks_and_prepends_the_system_prompt() {
    let encoded = to_chat_wire(&base(), "kimi-k2");
    assert_eq!(
        encoded.body["messages"],
        json!([{"role": "user", "content": "hi"}])
    );
    assert_eq!(encoded.body["model"], json!("kimi-k2"));
    assert_eq!(encoded.body["stream"], json!(true));

    let mut req = base();
    req.system = Some(
        serde_json::from_value(json!([{"type": "text", "text": "be terse"}])).expect("system"),
    );
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.body["messages"][0],
        json!({"role": "system", "content": "be terse"})
    );
}

#[test]
fn a_mid_conversation_system_turn_keeps_its_position() {
    let req = request(json!({
        "model": "m",
        "system": [{"type": "text", "text": "top-level prompt"}],
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            {"role": "system", "content": [{"type": "text", "text": "Write Go."}]}
        ],
        "stream": false
    }));
    let encoded = to_chat_wire(&req, "k3-256k");
    assert_eq!(
        encoded.body["messages"],
        json!([
            {"role": "system", "content": "top-level prompt"},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "Write Go."}
        ])
    );
}

#[test]
fn emits_assistant_tool_calls_and_a_tool_role_result() {
    let req = request(json!({
        "model": "cheap",
        "messages": [
            {"role": "assistant", "content": [{"type": "toolUse", "id": "c1", "name": "f", "input": {"a": 1}}]},
            {"role": "user", "content": [{"type": "toolResult", "toolUseId": "c1", "content": "ok", "isError": false}]}
        ],
        "stream": true
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.body["messages"][0],
        json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{\"a\":1}"}}]
        })
    );
    assert_eq!(
        encoded.body["messages"][1],
        json!({"role": "tool", "tool_call_id": "c1", "content": "ok"})
    );
}

#[test]
fn drops_images_with_a_degradation() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "look"},
            {"type": "image", "mediaType": "image/png", "data": "AAAA"}
        ]}],
        "stream": true
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.body["messages"][0],
        json!({"role": "user", "content": "look"})
    );
    assert!(
        encoded
            .degradations
            .contains(&"kimi:images-dropped".to_owned())
    );
}

#[test]
fn drops_thinking_blocks_with_a_degradation() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "assistant", "content": [
            {"type": "thinking", "text": "hmm"},
            {"type": "text", "text": "answer"}
        ]}],
        "stream": true
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.body["messages"][0],
        json!({"role": "assistant", "content": "answer"})
    );
    assert!(
        encoded
            .degradations
            .contains(&"kimi:thinking-dropped".to_owned())
    );
}

#[test]
fn drops_non_text_system_blocks_with_a_typed_degradation() {
    let req = request(json!({
        "model": "cheap",
        "system": [{"type": "image", "mediaType": "image/png", "data": "AAAA"}],
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.body["messages"],
        json!([{"role": "user", "content": "hi"}])
    );
    assert!(
        encoded
            .degradations
            .contains(&"kimi:system-image-dropped".to_owned())
    );
}

#[test]
fn drops_reasoning_config_with_a_degradation() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "reasoning": {"mode": "adaptive", "effort": "high"}
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert!(encoded.body.get("reasoning").is_none());
    assert!(
        encoded
            .degradations
            .contains(&"kimi:reasoning-dropped".to_owned())
    );

    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "reasoning": {"mode": "betweenTools"}
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.degradations,
        [
            "kimi:reasoning-between-tools-as-off".to_owned(),
            "kimi:reasoning-dropped".to_owned()
        ]
    );
}

#[test]
fn records_a_1m_request_only_when_one_was_made() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "betas": ["context-1m-2025-08-07"]
    }));
    let encoded = to_chat_wire(&req, "k2");
    assert!(
        encoded
            .degradations
            .contains(&"kimi:context-1m-dropped".to_owned())
    );
    let encoded = to_chat_wire(&base(), "k2");
    assert!(
        !encoded
            .degradations
            .contains(&"kimi:context-1m-dropped".to_owned())
    );
}

#[test]
fn asks_for_usage_on_the_stream_the_only_way_kimi_reports_any() {
    let encoded = to_chat_wire(&base(), "kimi-k2");
    assert_eq!(
        encoded.body["stream_options"],
        json!({"include_usage": true})
    );
}

#[test]
fn inlines_text_files_and_records_what_a_tool_result_cannot_carry() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{
            "type": "toolResult", "toolUseId": "c1", "content": "ok",
            "images": [],
            "files": [
                {"mediaType": "text/plain", "data": "aGk="},
                {"mediaType": "image/png", "data": "AAAA"}
            ]
        }]}],
        "stream": true
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.body["messages"][0],
        json!({"role": "tool", "tool_call_id": "c1", "content": "ok\n\nhi"})
    );
    for note in [
        "kimi:images-dropped",
        "kimi:tool-result-files-inlined",
        "kimi:files-dropped",
    ] {
        assert!(encoded.degradations.contains(&note.to_owned()), "{note}");
    }
}

#[test]
fn drops_provider_owned_tools_and_native_blocks_with_degradations() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [
            {"type": "providerNative", "provider": "anthropic", "blockType": "x", "data": {}}
        ]}],
        "stream": true,
        "tools": [{"kind": "provider", "provider": "anthropic", "type": "web_search_20250305", "name": "web_search", "wire": {}}]
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(encoded.body["messages"], json!([]));
    assert_eq!(encoded.body["tools"], json!([]));
    assert!(
        encoded
            .degradations
            .contains(&"kimi:anthropic-tool-dropped".to_owned())
    );
    assert!(
        encoded
            .degradations
            .contains(&"kimi:anthropic-native-block-dropped".to_owned())
    );
}

#[test]
fn a_tool_without_a_description_omits_the_field() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "tools": [{"kind": "portable", "name": "f", "inputSchema": {"type": "object"}}]
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.body["tools"],
        json!([{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}])
    );
}

#[test]
fn translates_the_clients_response_format_into_a_json_schema_spec() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "vendor": {"openai": {"response_format": {"type": "json_schema", "json_schema": {"name": "out", "schema": {"type": "object"}}}}}
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(
        encoded.body["response_format"],
        json!({"type": "json_schema", "json_schema": {"name": "out", "schema": {"type": "object"}, "strict": true}})
    );
    assert!(
        encoded
            .degradations
            .contains(&"kimi:response-format-translated".to_owned())
    );
}

#[test]
fn the_kimi_vendor_bag_overrides_in_place_and_appends_the_rest() {
    let req = request(json!({
        "model": "cheap",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "temperature": 0.5,
        "vendor": {"kimi": {"temperature": 0.9, "user": "u"}}
    }));
    let encoded = to_chat_wire(&req, "kimi-k2");
    assert_eq!(encoded.body["temperature"], json!(0.9));
    assert_eq!(encoded.body["user"], json!("u"));
    let keys: Vec<&str> = encoded.body.keys().map(String::as_str).collect();
    assert_eq!(keys.last(), Some(&"user"));
}

/// A partial `OMNI_ORDER_KIMI`: the named headers move first and the rest keep
/// the builder's pre-sort order. The order is captured once per process, so
/// the check runs in a child.
#[test]
fn a_partial_kimi_order_override_leaves_the_rest_in_captured_order() {
    if std::env::var_os("OMNI_ORDER_CHILD").is_some() {
        omni_providers::kimi::profile::initialize();
        let built = build(&base(), &credentials(device()));
        assert_eq!(
            names(&built.request.headers),
            [
                "Authorization",
                "X-Msh-Device-Id",
                "User-Agent",
                "X-Msh-Platform",
                "X-Msh-Version",
                "Accept",
                "Content-Type",
                "X-Msh-Device-Name",
                "X-Msh-Device-Model",
                "X-Msh-Os-Version"
            ]
        );
        return;
    }
    let out = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args([
            "a_partial_kimi_order_override_leaves_the_rest_in_captured_order",
            "--exact",
            "--nocapture",
        ])
        .env("OMNI_ORDER_CHILD", "1")
        .env("OMNI_ORDER_KIMI", "Authorization, X-Msh-Device-Id")
        .output()
        .expect("child");
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
}

/// `OMNI_KIMI_CLI_VERSION` and `OMNI_UA_KIMI` replace the version and the
/// whole user-agent; captured once, so checked in a child.
#[test]
fn kimi_profile_env_overrides_version_and_user_agent() {
    if std::env::var_os("OMNI_ORDER_CHILD").is_some() {
        omni_providers::kimi::profile::initialize();
        let built = build(&base(), &credentials(Map::new()));
        let headers = &built.request.headers;
        assert!(headers.contains(&("X-Msh-Version".into(), "9.9.9".into())));
        assert!(headers.contains(&("User-Agent".into(), "custom-agent/1".into())));
        assert!(headers.contains(&("X-Msh-Platform".into(), "kimi_code_cli".into())));
        return;
    }
    let out = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args([
            "kimi_profile_env_overrides_version_and_user_agent",
            "--exact",
            "--nocapture",
        ])
        .env("OMNI_ORDER_CHILD", "1")
        .env("OMNI_KIMI_CLI_VERSION", "9.9.9")
        .env("OMNI_UA_KIMI", "custom-agent/1")
        .output()
        .expect("child");
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
}

/// An override outside the printable-ASCII safe set is ignored, not sent.
#[test]
fn an_unsafe_kimi_profile_override_falls_back_to_the_default() {
    if std::env::var_os("OMNI_ORDER_CHILD").is_some() {
        omni_providers::kimi::profile::initialize();
        let built = build(&base(), &credentials(Map::new()));
        let headers = &built.request.headers;
        assert!(headers.contains(&("X-Msh-Version".into(), "0.26.0".into())));
        assert!(headers.contains(&("User-Agent".into(), "kimi-code-cli/0.26.0".into())));
        return;
    }
    let out = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args([
            "an_unsafe_kimi_profile_override_falls_back_to_the_default",
            "--exact",
            "--nocapture",
        ])
        .env("OMNI_ORDER_CHILD", "1")
        .env("OMNI_KIMI_CLI_VERSION", "bad\nversion")
        .env("OMNI_UA_KIMI", "bad\nagent")
        .output()
        .expect("child");
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
}
