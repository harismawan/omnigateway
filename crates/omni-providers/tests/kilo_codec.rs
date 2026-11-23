//! The wire kilo puts on the socket, pinned against literals carried over
//! from the TS codec's own tests (`kiloCodec.test.ts`, `kilo.test.ts`).
//!
//! Order is pinned as much as content: `kiloProfile.order` exists because the
//! upstream fingerprints clients, so a test comparing header *sets* would
//! pass while the wire changed. `User-Agent` carries a version an installation
//! may override, so its position is pinned and its value is not.

use omni_ir::error::ErrorCode;
use omni_ir::request::ChatRequest;
use omni_providers::codec::{CodecInput, CodecRequest, Credentials, ProviderCodec};
use omni_providers::kilo::codec::KiloCodec;
use omni_providers::kilo::wire::to_kilo_wire;
use serde_json::{Map, Value, json};

const OAUTH_URL: &str = "https://api.kilo.ai/api/openrouter/chat/completions";
const API_URL: &str = "https://api.kilo.ai/api/gateway/chat/completions";
const MODEL: &str = "anthropic/claude-sonnet-5";

const BODY: &str = concat!(
    r#"{"model":"anthropic/claude-sonnet-5","messages":[{"role":"user","content":"hi"}],"#,
    r#""stream":true,"stream_options":{"include_usage":true}}"#
);

fn request(shape: Value) -> ChatRequest {
    serde_json::from_value(shape).expect("request")
}

fn base() -> ChatRequest {
    request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true
    }))
}

fn credentials(provider_data: Map<String, Value>) -> Credentials {
    Credentials {
        access_token: Some("kilo-oauth-token".into()),
        api_key: None,
        provider_data,
    }
}

fn build(req: &ChatRequest, creds: &Credentials) -> CodecRequest<()> {
    KiloCodec
        .build_request(&CodecInput {
            request: req,
            model: MODEL,
            credentials: creds,
            request_id: None,
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .expect("build request")
}

fn names(headers: &[(String, String)]) -> Vec<&str> {
    headers.iter().map(|(n, _)| n.as_str()).collect()
}

/// Header values, with the one an installation may override left out.
fn pinned(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| name != "User-Agent")
        .cloned()
        .collect()
}

#[test]
fn an_oauth_credential_goes_to_the_openrouter_path_with_the_editor_identity_behind_it() {
    let built = build(&base(), &credentials(Map::new()));
    let sent = &built.request;
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.url, OAUTH_URL);
    assert_eq!(sent.body, BODY);
    assert_eq!(
        names(&sent.headers),
        [
            "Content-Type",
            "Authorization",
            "X-KILOCODE-EDITORNAME",
            "User-Agent",
            "Accept"
        ]
    );
    assert_eq!(
        pinned(&sent.headers),
        [
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), "Bearer kilo-oauth-token".into()),
            ("X-KILOCODE-EDITORNAME".into(), "vscode".into()),
            ("Accept".into(), "text/event-stream".into()),
        ]
    );
    assert!(built.degradations.is_empty());
}

#[test]
fn an_api_key_goes_to_the_gateway_path_and_is_sent_as_the_same_bearer() {
    // The URL is the *only* difference between the two credential types, and
    // crossing them fails as a billing or entitlement error rather than a
    // routing one — which reads as anything but a routing bug.
    let creds = Credentials {
        access_token: None,
        api_key: Some("kilo-api-key".into()),
        provider_data: Map::new(),
    };
    let built = build(&base(), &creds);
    assert_eq!(built.request.url, API_URL);
    assert_eq!(built.request.body, BODY);
    assert!(
        built
            .request
            .headers
            .contains(&("Authorization".into(), "Bearer kilo-api-key".into()))
    );
}

#[test]
fn an_access_token_wins_over_an_api_key() {
    // `accessToken ?? apiKey`: the OAuth token is the one the flow minted.
    let creds = Credentials {
        access_token: Some("kilo-oauth-token".into()),
        api_key: Some("kilo-api-key".into()),
        provider_data: Map::new(),
    };
    let built = build(&base(), &creds);
    assert_eq!(built.request.url, OAUTH_URL);
    assert!(
        built
            .request
            .headers
            .contains(&("Authorization".into(), "Bearer kilo-oauth-token".into()))
    );
}

#[test]
fn an_organization_is_named_before_the_editor_identity_never_after_it() {
    let mut data = Map::new();
    data.insert("orgId".into(), json!("org-42"));
    let built = build(&base(), &credentials(data));
    // Position, not presence: the organization header is inserted with the
    // protocol headers and ordered by the profile, so asserting only that it
    // is somewhere in the list would pass with it appended to the end.
    assert_eq!(
        names(&built.request.headers),
        [
            "Content-Type",
            "Authorization",
            "X-Kilocode-OrganizationID",
            "X-KILOCODE-EDITORNAME",
            "User-Agent",
            "Accept"
        ]
    );
    assert!(
        built
            .request
            .headers
            .contains(&("X-Kilocode-OrganizationID".into(), "org-42".into()))
    );
}

#[test]
fn an_empty_or_non_string_organization_sends_no_header() {
    for org in [json!(""), json!(42), json!(null)] {
        let mut data = Map::new();
        data.insert("orgId".into(), org.clone());
        let built = build(&base(), &credentials(data));
        assert!(
            !names(&built.request.headers).contains(&"X-Kilocode-OrganizationID"),
            "{org}"
        );
    }
}

#[test]
fn a_non_streaming_client_request_still_asks_the_upstream_to_stream() {
    // Dispatch serves a non-streaming client by collecting the stream, so the
    // request going out is identical either way.
    let mut shape = base();
    shape.stream = false;
    let built = build(&shape, &credentials(Map::new()));
    assert_eq!(built.request.body, BODY);
}

#[test]
fn a_credential_carrying_no_token_is_an_auth_failure_not_a_bare_request() {
    // Dispatch gates its credential-refresh retry on AUTH, so a codec failure
    // flattened to UPSTREAM would fail over instead of refreshing.
    let creds = Credentials {
        access_token: None,
        api_key: None,
        provider_data: Map::new(),
    };
    let error = KiloCodec
        .build_request(&CodecInput {
            request: &base(),
            model: MODEL,
            credentials: &creds,
            request_id: None,
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .expect_err("no token");
    assert_eq!(error.code, ErrorCode::Auth);
    assert_eq!(error.message, "kilo credential has no token");
}

#[test]
fn the_full_body_keeps_the_declared_field_order() {
    // BODY_ORDER first, unlisted keys appended in insertion order:
    // `stream_options` then `stop`.
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "tools": [{"kind": "portable", "name": "f", "description": "d", "inputSchema": {"type": "object"}}],
        "toolChoice": {"type": "auto"},
        "maxTokens": 100,
        "temperature": 0.5,
        "reasoning": {"mode": "adaptive", "effort": "high"},
        "stopSequences": ["x"]
    }));
    let built = build(&req, &credentials(Map::new()));
    assert_eq!(
        built.request.body,
        concat!(
            r#"{"model":"anthropic/claude-sonnet-5","messages":[{"role":"user","content":"hi"}],"#,
            r#""tools":[{"type":"function","function":{"name":"f","description":"d","parameters":{"type":"object"}}}],"#,
            r#""tool_choice":"auto","max_tokens":100,"temperature":0.5,"reasoning":{"effort":"high"},"stream":true,"#,
            r#""stream_options":{"include_usage":true},"stop":["x"]}"#
        )
    );
}

#[test]
fn collapses_single_text_blocks_and_prepends_the_system_prompt() {
    let encoded = to_kilo_wire(&base(), MODEL);
    assert_eq!(
        encoded.body["messages"],
        json!([{"role": "user", "content": "hi"}])
    );
    assert_eq!(encoded.body["model"], json!(MODEL));
    assert_eq!(encoded.body["stream"], json!(true));

    let mut req = base();
    req.system = Some(
        serde_json::from_value(json!([{"type": "text", "text": "be terse"}])).expect("system"),
    );
    let encoded = to_kilo_wire(&req, MODEL);
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
            {"role": "system", "content": [{"type": "text", "text": "Write Go."}]},
            {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}
        ],
        "stream": false
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(
        encoded.body["messages"],
        json!([
            {"role": "system", "content": "top-level prompt"},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "Write Go."},
            {"role": "assistant", "content": "ok"}
        ])
    );
}

#[test]
fn emits_assistant_tool_calls_and_a_tool_role_result() {
    let req = request(json!({
        "model": "pool",
        "messages": [
            {"role": "assistant", "content": [{"type": "toolUse", "id": "c1", "name": "f", "input": {"a": 1}}]},
            {"role": "user", "content": [{"type": "toolResult", "toolUseId": "c1", "content": "ok", "isError": false}]}
        ],
        "stream": true,
        "tools": [{"kind": "portable", "name": "f", "description": "does f", "inputSchema": {"type": "object", "properties": {}}}],
        "toolChoice": {"type": "any"}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
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
    assert_eq!(
        encoded.body["tools"],
        json!([{"type": "function", "function": {"name": "f", "description": "does f", "parameters": {"type": "object", "properties": {}}}}])
    );
    assert_eq!(encoded.body["tool_choice"], json!("required"));
}

#[test]
fn sends_images_as_chat_image_parts_rather_than_dropping_them() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "look"},
            {"type": "image", "mediaType": "image/png", "data": "AAAA"}
        ]}],
        "stream": true
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(
        encoded.body["messages"][0],
        json!({"role": "user", "content": [
            {"type": "text", "text": "look"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
        ]})
    );
    assert!(encoded.degradations.is_empty());
}

#[test]
fn a_tool_results_images_and_pdfs_move_to_a_user_message_after_the_tool_messages() {
    // A tool message takes text only, and nothing may sit between the tool
    // messages answering one assistant turn.
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{
            "type": "toolResult", "toolUseId": "c1", "content": "ok",
            "images": [{"mediaType": "image/png", "data": "AAAA"}],
            "files": [
                {"mediaType": "text/plain", "data": "aGk="},
                {"mediaType": "application/pdf", "data": "JVBER", "filename": "doc.pdf"},
                {"mediaType": "application/zip", "data": "UEs="}
            ]
        }]}],
        "stream": true
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(
        encoded.body["messages"],
        json!([
            {"role": "tool", "tool_call_id": "c1", "content": "ok\n\nhi"},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                {"type": "file", "file": {"filename": "doc.pdf", "file_data": "data:application/pdf;base64,JVBER"}}
            ]}
        ])
    );
    for note in [
        "kilo:tool-result-files-inlined",
        "kilo:files-dropped",
        "kilo:tool-result-images-moved",
        "kilo:tool-result-files-moved",
    ] {
        assert!(encoded.degradations.contains(&note.to_owned()), "{note}");
    }
}

// --- Degradations --------------------------------------------------------------

#[test]
fn records_a_degradation_for_cache_breakpoints_this_wire_cannot_express() {
    let req = request(json!({
        "model": "pool",
        "system": [{"type": "text", "text": "be terse", "cacheControl": {"type": "ephemeral", "ttl": "1h"}}],
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert!(
        encoded
            .degradations
            .contains(&"kilo:cache-control-dropped".to_owned())
    );

    // A breakpoint on a message block counts too.
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi", "cacheControl": {"type": "ephemeral"}}]}],
        "stream": true
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert!(
        encoded
            .degradations
            .contains(&"kilo:cache-control-dropped".to_owned())
    );

    // And none is recorded when the caller placed no breakpoint.
    let mut req = base();
    req.system = Some(
        serde_json::from_value(json!([{"type": "text", "text": "be terse"}])).expect("system"),
    );
    let encoded = to_kilo_wire(&req, MODEL);
    assert!(
        !encoded
            .degradations
            .contains(&"kilo:cache-control-dropped".to_owned())
    );
}

#[test]
fn degradations_name_kilo_rather_than_the_provider_this_encoder_was_forked_from() {
    let req = request(json!({
        "model": "pool",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            {"role": "assistant", "content": [{"type": "thinking", "text": "prior turn"}]}
        ],
        "stream": true
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    // Without this the `every` below passes on an encoder recording nothing.
    assert!(!encoded.degradations.is_empty());
    assert!(encoded.degradations.iter().all(|d| d.starts_with("kilo:")));
}

#[test]
fn records_a_degradation_for_a_1m_context_beta() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "betas": ["context-1m-2025-08-07"]
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert!(
        encoded
            .degradations
            .contains(&"kilo:context-1m-dropped".to_owned())
    );
    let encoded = to_kilo_wire(&base(), MODEL);
    assert!(
        !encoded
            .degradations
            .contains(&"kilo:context-1m-dropped".to_owned())
    );
}

#[test]
fn drops_thinking_blocks_with_a_degradation() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "assistant", "content": [
            {"type": "thinking", "text": "hmm", "signature": "sig"},
            {"type": "text", "text": "ok"}
        ]}],
        "stream": true
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(
        encoded.body["messages"],
        json!([{"role": "assistant", "content": "ok"}])
    );
    assert!(
        encoded
            .degradations
            .contains(&"kilo:thinking-dropped".to_owned())
    );
}

#[test]
fn drops_an_anthropic_native_history_block_with_a_degradation() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "assistant", "content": [
            {"type": "providerNative", "provider": "anthropic", "blockType": "server_tool_use", "data": {"id": "srvtoolu_1"}},
            {"type": "text", "text": "ok"}
        ]}],
        "stream": true
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(
        encoded.body["messages"],
        json!([{"role": "assistant", "content": "ok"}])
    );
    assert!(
        encoded
            .degradations
            .contains(&"kilo:anthropic-native-block-dropped".to_owned())
    );
}

#[test]
fn drops_an_anthropic_defined_tool_rather_than_forwarding_a_malformed_function() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "tools": [
            {"kind": "portable", "name": "f", "description": "does f", "inputSchema": {"type": "object", "properties": {}}},
            {"kind": "provider", "provider": "anthropic", "type": "web_search_20250305", "name": "web_search", "wire": {"max_uses": 3}}
        ]
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(
        encoded.body["tools"],
        json!([{"type": "function", "function": {"name": "f", "description": "does f", "parameters": {"type": "object", "properties": {}}}}])
    );
    assert!(
        encoded
            .degradations
            .contains(&"kilo:anthropic-tool-dropped".to_owned())
    );

    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "tools": [{"kind": "portable", "name": "f", "inputSchema": {"type": "object"}}]
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert!(
        !encoded
            .degradations
            .contains(&"kilo:anthropic-tool-dropped".to_owned())
    );
    // A tool without a description omits the field.
    assert_eq!(
        encoded.body["tools"],
        json!([{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}])
    );
}

#[test]
fn drops_non_text_system_blocks_with_a_typed_degradation() {
    let req = request(json!({
        "model": "pool",
        "system": [{"type": "image", "mediaType": "image/png", "data": "AAAA"}],
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(
        encoded.body["messages"],
        json!([{"role": "user", "content": "hi"}])
    );
    assert!(
        encoded
            .degradations
            .contains(&"kilo:system-image-dropped".to_owned())
    );
}

// --- Reasoning request -----------------------------------------------------------

#[test]
fn encodes_a_token_budget_as_openrouters_max_tokens_form() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "reasoning": {"mode": "budget", "budgetTokens": 8000}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    // The budget rides the wire as a JS number; `JSON.stringify` renders it
    // without a fraction, which the body-order test pins.
    assert_eq!(encoded.body["reasoning"], json!({"max_tokens": 8000.0}));
    assert!(encoded.degradations.is_empty());
}

#[test]
fn encodes_an_adaptive_effort_as_openrouters_effort_form() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "reasoning": {"mode": "adaptive", "effort": "low"}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(encoded.body["reasoning"], json!({"effort": "low"}));
    assert!(encoded.degradations.is_empty());
}

#[test]
fn defaults_an_adaptive_request_with_no_effort_to_medium() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "reasoning": {"mode": "adaptive"}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(encoded.body["reasoning"], json!({"effort": "medium"}));
}

#[test]
fn forwards_the_full_official_effort_ladder_unclamped() {
    // Model support varies, and an unsupported value is the upstream's error
    // to raise, not ours to pre-clamp into a different depth.
    for effort in ["none", "minimal", "xhigh", "max"] {
        let req = request(json!({
            "model": "pool",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
            "stream": true,
            "reasoning": {"mode": "adaptive", "effort": effort}
        }));
        let encoded = to_kilo_wire(&req, MODEL);
        assert_eq!(encoded.body["reasoning"], json!({"effort": effort}));
        assert!(encoded.degradations.is_empty());
    }
}

#[test]
fn sends_no_reasoning_field_when_the_caller_opted_out() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "reasoning": {"mode": "off"}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert!(encoded.body.get("reasoning").is_none());
}

#[test]
fn between_tools_reasoning_reads_as_off_with_a_degradation() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "reasoning": {"mode": "betweenTools"}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert!(encoded.body.get("reasoning").is_none());
    assert_eq!(
        encoded.degradations,
        ["kilo:reasoning-between-tools-as-off".to_owned()]
    );
}

#[test]
fn asks_for_usage_on_the_stream_the_only_way_this_surface_reports_any() {
    let encoded = to_kilo_wire(&base(), MODEL);
    assert_eq!(
        encoded.body["stream_options"],
        json!({"include_usage": true})
    );
}

#[test]
fn translates_the_clients_response_format_into_a_json_schema_spec() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "vendor": {"openai": {"response_format": {"type": "json_schema", "json_schema": {"name": "out", "schema": {"type": "object"}}}}}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(
        encoded.body["response_format"],
        json!({"type": "json_schema", "json_schema": {"name": "out", "schema": {"type": "object"}, "strict": true}})
    );
    assert!(
        encoded
            .degradations
            .contains(&"kilo:response-format-translated".to_owned())
    );
}

#[test]
fn a_schema_too_deep_to_serialize_is_dropped_with_a_named_degradation() {
    // 64 subschema levels is one past the serialization cap (MAX_DEPTH): the
    // reader refuses, the wire drops response_format, and the drop is named
    // verbatim as TS kilo/wire.ts notes it — never silently.
    let mut schema = json!({"type": "string"});
    for _ in 0..64 {
        schema = json!({"type": "object", "properties": {"n": schema}});
    }
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "vendor": {"openai": {"response_format": {"type": "json_schema", "json_schema": {"name": "out", "schema": schema}}}}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert!(encoded.body.get("response_format").is_none());
    assert_eq!(
        encoded.degradations,
        ["kilo:response-schema-too-deep".to_owned()]
    );
}

#[test]
fn the_kilo_vendor_bag_overrides_in_place_and_appends_the_rest() {
    let req = request(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true,
        "temperature": 0.5,
        "vendor": {"kilo": {"temperature": 0.9, "user": "u"}}
    }));
    let encoded = to_kilo_wire(&req, MODEL);
    assert_eq!(encoded.body["temperature"], json!(0.9));
    assert_eq!(encoded.body["user"], json!("u"));
    let keys: Vec<&str> = encoded.body.keys().map(String::as_str).collect();
    assert_eq!(keys.last(), Some(&"user"));
}

// --- Profile environment ---------------------------------------------------------
// The environment is captured once per process, so each override runs in a child.

fn in_child(test: &str, envs: &[(&str, &str)]) {
    let mut command = std::process::Command::new(std::env::current_exe().expect("exe"));
    command
        .args([test, "--exact", "--nocapture"])
        .env("OMNI_ORDER_CHILD", "1");
    for (k, v) in envs {
        command.env(k, v);
    }
    let out = command.output().expect("child");
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
}

#[test]
fn a_partial_kilo_order_override_leaves_the_rest_in_captured_order() {
    if std::env::var_os("OMNI_ORDER_CHILD").is_some() {
        omni_providers::kilo::profile::initialize();
        let mut data = Map::new();
        data.insert("orgId".into(), json!("org-42"));
        let built = build(&base(), &credentials(data));
        assert_eq!(
            names(&built.request.headers),
            [
                "Authorization",
                "X-Kilocode-OrganizationID",
                "User-Agent",
                "X-KILOCODE-EDITORNAME",
                "Accept",
                "Content-Type"
            ]
        );
        return;
    }
    in_child(
        "a_partial_kilo_order_override_leaves_the_rest_in_captured_order",
        &[(
            "OMNI_ORDER_KILO",
            "Authorization, X-Kilocode-OrganizationID",
        )],
    );
}

#[test]
fn kilo_profile_env_overrides_version_user_agent_and_editor() {
    if std::env::var_os("OMNI_ORDER_CHILD").is_some() {
        omni_providers::kilo::profile::initialize();
        let built = build(&base(), &credentials(Map::new()));
        let headers = &built.request.headers;
        assert!(headers.contains(&("User-Agent".into(), "custom-agent/1".into())));
        assert!(headers.contains(&("X-KILOCODE-EDITORNAME".into(), "zed".into())));
        return;
    }
    in_child(
        "kilo_profile_env_overrides_version_user_agent_and_editor",
        &[
            ("OMNI_KILO_CLI_VERSION", "9.9.9"),
            ("OMNI_UA_KILO", "custom-agent/1"),
            ("OMNI_KILO_EDITOR_NAME", "zed"),
        ],
    );
}

#[test]
fn the_cli_version_feeds_the_default_user_agent() {
    if std::env::var_os("OMNI_ORDER_CHILD").is_some() {
        omni_providers::kilo::profile::initialize();
        let built = build(&base(), &credentials(Map::new()));
        assert!(
            built
                .request
                .headers
                .contains(&("User-Agent".into(), "Kilo-Code/9.9.9".into()))
        );
        return;
    }
    in_child(
        "the_cli_version_feeds_the_default_user_agent",
        &[("OMNI_KILO_CLI_VERSION", "9.9.9")],
    );
}

#[test]
fn an_unsafe_kilo_profile_override_falls_back_to_the_default() {
    if std::env::var_os("OMNI_ORDER_CHILD").is_some() {
        omni_providers::kilo::profile::initialize();
        let built = build(&base(), &credentials(Map::new()));
        let headers = &built.request.headers;
        assert!(headers.contains(&("User-Agent".into(), "Kilo-Code/4.140.0".into())));
        assert!(headers.contains(&("X-KILOCODE-EDITORNAME".into(), "vscode".into())));
        return;
    }
    in_child(
        "an_unsafe_kilo_profile_override_falls_back_to_the_default",
        &[
            ("OMNI_KILO_CLI_VERSION", "bad\nversion"),
            ("OMNI_UA_KILO", "bad\nagent"),
            ("OMNI_KILO_EDITOR_NAME", "bad\neditor"),
        ],
    );
}
