//! The wire grok puts on the socket, pinned against literals carried over
//! from the TS adapter's captured bytes (`grokCodec.test.ts`, `grok.test.ts`).
//!
//! Two things here exist nowhere else. Grok is the only provider whose
//! request reads `CodecInput.request_id`, so these are the only assertions
//! that the field arrives at all. And the host pairing is unusually costly to
//! get wrong: an OAuth bearer sent to the API host does not answer 401, it
//! bills against API credits and answers 402 for a healthy subscription.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use bytes::Bytes;
use omni_ir::error::ErrorCode;
use omni_ir::request::ChatRequest;
use omni_ir::stream::{StreamEvent, Usage};
use omni_providers::adapter::{AdapterRequest, SendError, send};
use omni_providers::codec::{CodecInput, CodecRequest, Credentials, ProviderCodec};
use omni_providers::grok::codec::GrokCodec;
use omni_providers::grok::device::{headers as device_headers, mint};
use omni_providers::grok::wire::{Encoded, to_grok_wire};
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};
use serde_json::{Map, Value, json};

const PROXY: &str = "https://cli-chat-proxy.grok.com/v1/responses";
const API: &str = "https://api.x.ai/v1/responses";

const BODY: &str = concat!(
    r#"{"model":"grok-4","stream":true,"input":[{"type":"message","role":"user","#,
    r#""content":[{"type":"input_text","text":"hi"}]}],"store":false,"#,
    r#""prompt_cache_key":"af75e45150ba5505736d80ccdd119119","#,
    r#""include":["reasoning.encrypted_content"]}"#
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

fn oauth(provider_data: Value) -> Credentials {
    Credentials {
        access_token: Some("gr-tok".into()),
        api_key: None,
        provider_data: provider_data.as_object().expect("object").clone(),
    }
}

fn api_key() -> Credentials {
    Credentials {
        access_token: None,
        api_key: Some("xai-key".into()),
        provider_data: Map::new(),
    }
}

fn build(
    req: &ChatRequest,
    model: &str,
    creds: &Credentials,
    id: Option<&str>,
) -> CodecRequest<()> {
    GrokCodec
        .build_request(&CodecInput {
            request: req,
            model,
            credentials: creds,
            request_id: id,
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .expect("build request")
}

fn wire(shape: Value) -> Encoded {
    to_grok_wire(&request(shape), "grok-4.6")
}

/// `base` with extra top-level fields merged in, as the TS `{...base, …}`.
fn base_with(extra: Value) -> Value {
    let mut shape = serde_json::to_value(base()).expect("base");
    if let (Some(dst), Some(src)) = (shape.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    shape
}

fn names(headers: &[(String, String)]) -> Vec<&str> {
    headers.iter().map(|(n, _)| n.as_str()).collect()
}

fn header_of<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// Header values, with the two an installation may override left out.
fn pinned(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| name != "x-grok-client-version" && name != "User-Agent")
        .cloned()
        .collect()
}

/// Records each request and answers with one scripted response.
struct Fake {
    status: u16,
    content_type: &'static str,
    body: &'static str,
    sent: Mutex<Vec<HttpRequest>>,
}

impl Fake {
    fn sse(body: &'static str) -> Fake {
        Fake {
            status: 200,
            content_type: "text/event-stream",
            body,
            sent: Mutex::new(Vec::new()),
        }
    }
}

impl HttpClient for Fake {
    fn send(
        &self,
        req: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        self.sent.lock().expect("lock").push(req);
        let mut headers = Headers::new();
        headers.append_received("content-type", self.content_type);
        let body = ResponseBody::from_chunks(vec![Bytes::from(self.body)]);
        let status = self.status;
        Box::pin(async move {
            Ok(HttpResponse {
                status,
                headers,
                body,
            })
        })
    }
}

#[test]
fn an_oauth_credential_goes_to_the_proxy_with_the_two_proxy_only_headers() {
    // `deviceId` is kimi's field, not grok's: it must not produce an agent
    // header here.
    let built = build(
        &base(),
        "grok-4",
        &oauth(json!({"deviceId": "gdev-1"})),
        Some("req_7"),
    );
    let sent = &built.request;
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.url, PROXY);
    assert_eq!(sent.body, BODY);
    assert_eq!(
        names(&sent.headers),
        [
            "Content-Type",
            "Authorization",
            "X-XAI-Token-Auth",
            "x-authenticateresponse",
            "x-grok-client-identifier",
            "x-grok-client-version",
            "x-grok-client-mode",
            "x-grok-req-id",
            "x-grok-conv-id",
            "x-grok-session-id",
            "x-grok-model-override",
            "User-Agent",
            "Accept",
        ]
    );
    assert_eq!(
        pinned(&sent.headers),
        [
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), "Bearer gr-tok".into()),
            // Proxy-only. The API host has no idea what they mean.
            ("X-XAI-Token-Auth".into(), "xai-grok-cli".into()),
            (
                "x-authenticateresponse".into(),
                "authenticate-response".into()
            ),
            ("x-grok-client-identifier".into(), "grok-shell".into()),
            ("x-grok-client-mode".into(), "headless".into()),
            ("x-grok-req-id".into(), "req_7".into()),
            (
                "x-grok-conv-id".into(),
                "a9db53bc-87e0-5336-a808-245f0e8d847b".into()
            ),
            (
                "x-grok-session-id".into(),
                "a9db53bc-87e0-5336-a808-245f0e8d847b".into()
            ),
            ("x-grok-model-override".into(), "grok-4".into()),
            ("Accept".into(), "text/event-stream".into()),
        ]
    );
    assert!(built.degradations.is_empty());
}

#[test]
fn an_api_key_goes_to_the_api_host_and_carries_neither_proxy_header() {
    let built = build(&base(), "grok-4", &api_key(), None);
    let sent = &built.request;
    assert_eq!(sent.url, API);
    assert_eq!(sent.body, BODY);
    assert_eq!(
        header_of(&sent.headers, "Authorization"),
        Some("Bearer xai-key")
    );
    assert_eq!(header_of(&sent.headers, "X-XAI-Token-Auth"), None);
    assert_eq!(header_of(&sent.headers, "x-authenticateresponse"), None);
}

#[test]
fn the_gateway_request_id_is_reused_and_the_conversation_derived_from_it() {
    let creds = oauth(json!({}));
    let built = build(&base(), "grok-4.6", &creds, Some("req-abc"));
    let headers = &built.request.headers;
    // One value joins stdout, `request_logs` and the upstream rather than three.
    assert_eq!(header_of(headers, "x-grok-req-id"), Some("req-abc"));
    let conv = header_of(headers, "x-grok-conv-id").expect("conv id");
    // Conversation and session are equal, which is what xAI's client sends
    // for a main turn.
    assert_eq!(header_of(headers, "x-grok-session-id"), Some(conv));
    // The v5 shape: version nibble 5 and the RFC 4122 variant bits.
    let hex = |c: char| c.is_ascii_hexdigit();
    assert_eq!(conv.len(), 36);
    assert!(
        conv.chars()
            .all(|c| c == '-' || (hex(c) && !c.is_ascii_uppercase()))
    );
    assert_eq!(conv.as_bytes()[14], b'5');
    assert!(matches!(conv.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    assert_eq!(
        header_of(headers, "x-grok-model-override"),
        Some("grok-4.6")
    );

    // Derived, never minted: the host may build once per attempt, so the same
    // request id has to produce the same ids, and a different one must not.
    let again = build(&base(), "grok-4.6", &creds, Some("req-abc"));
    assert_eq!(
        header_of(&again.request.headers, "x-grok-conv-id"),
        Some(conv)
    );
    let other = build(&base(), "grok-4.6", &creds, Some("req-xyz"));
    assert_ne!(
        header_of(&other.request.headers, "x-grok-conv-id"),
        Some(conv)
    );

    // The exact vector grokCodec.test.ts pins, so the derivation is checked
    // against an independently computed hash rather than only its shape.
    let pinned = build(&base(), "grok-4.6", &creds, Some("req_7"));
    assert_eq!(
        header_of(&pinned.request.headers, "x-grok-conv-id"),
        Some("a9db53bc-87e0-5336-a808-245f0e8d847b")
    );
    assert_eq!(
        header_of(&pinned.request.headers, "x-grok-session-id"),
        Some("a9db53bc-87e0-5336-a808-245f0e8d847b")
    );
}

#[test]
fn without_a_request_id_the_three_identifiers_are_omitted_never_invented() {
    // Every path outside dispatch has no request id. Minting one here would
    // make the codec non-deterministic, which is the property retries depend on.
    let built = build(&base(), "grok-4", &oauth(json!({})), None);
    for name in ["x-grok-req-id", "x-grok-conv-id", "x-grok-session-id"] {
        assert_eq!(header_of(&built.request.headers, name), None, "{name}");
    }
    // The model override is not part of that set and is always sent.
    assert_eq!(
        header_of(&built.request.headers, "x-grok-model-override"),
        Some("grok-4")
    );
}

#[test]
fn a_non_streaming_client_request_still_asks_the_upstream_to_stream() {
    // The failure this guards is silent and total: a non-streaming upstream
    // answers JSON, the SSE parser yields nothing, and the client gets an
    // empty response. The wire encoder copies the client's own `stream` flag,
    // so with a streaming request the codec's override is a no-op and deleting
    // it survives every other assertion here.
    let req = request(base_with(json!({"stream": false})));
    let built = build(&req, "grok-4", &api_key(), None);
    assert_eq!(built.request.body, BODY);
    assert_eq!(
        header_of(&built.request.headers, "Accept"),
        Some("text/event-stream")
    );
}

#[tokio::test]
async fn a_credential_with_neither_token_is_an_auth_failure_and_sends_nothing() {
    let fake = Fake::sse("");
    let creds = Credentials {
        access_token: None,
        api_key: None,
        provider_data: Map::new(),
    };
    let req = base();
    let err = send(
        &GrokCodec,
        "grok",
        AdapterRequest::new(&req, "grok-4", &creds),
        &fake,
    )
    .await
    .expect_err("no token must fail");
    match err {
        SendError::Gateway(g) => {
            assert_eq!(g.code, ErrorCode::Auth);
            assert!(g.message.contains("token"), "{}", g.message);
        }
        SendError::Transport(t) => panic!("transport reached: {t}"),
    }
    assert!(fake.sent.lock().expect("lock").is_empty());
}

#[test]
fn maps_messages_onto_responses_input_items() {
    let encoded = wire(serde_json::to_value(base()).expect("base"));
    assert_eq!(encoded.body["model"], json!("grok-4.6"));
    assert_eq!(
        encoded.body["input"],
        json!([{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}])
    );
    assert_eq!(encoded.body["stream"], json!(true));
}

#[test]
fn sets_the_three_fields_xais_own_client_sets_on_every_request() {
    let encoded = wire(serde_json::to_value(base()).expect("base"));
    // `store` defaults to true upstream, which breaks zero-data-retention and
    // is separately advised against for image requests.
    assert_eq!(encoded.body["store"], json!(false));
    assert_eq!(
        encoded.body["include"],
        json!(["reasoning.encrypted_content"])
    );
    let key = encoded.body["prompt_cache_key"].as_str().expect("key");
    assert!(!key.is_empty());
    // Pinned: the key is a hash of the stable prefix, not a random token.
    assert_eq!(key, "af75e45150ba5505736d80ccdd119119");
}

#[test]
fn keys_the_prompt_cache_on_the_stable_prefix_not_on_the_turn() {
    let first = wire(base_with(
        json!({"system": [{"type": "text", "text": "be terse"}]}),
    ));
    let later = wire(base_with(json!({
        "system": [{"type": "text", "text": "be terse"}],
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
            {"role": "user", "content": [{"type": "text", "text": "more"}]}
        ]
    })));
    let other = wire(base_with(
        json!({"system": [{"type": "text", "text": "be verbose"}]}),
    ));

    // Affinity only pays off if a follow-up turn lands on the same server.
    assert_eq!(
        later.body["prompt_cache_key"],
        first.body["prompt_cache_key"]
    );
    assert_ne!(
        other.body["prompt_cache_key"],
        first.body["prompt_cache_key"]
    );
}

#[test]
fn asks_for_a_concise_reasoning_summary() {
    let encoded = wire(base_with(
        json!({"reasoning": {"mode": "adaptive", "effort": "low"}}),
    ));
    assert_eq!(
        encoded.body["reasoning"],
        json!({"effort": "low", "summary": "concise"})
    );
}

#[test]
fn forwards_xhigh_effort_unclamped() {
    let encoded = wire(base_with(
        json!({"reasoning": {"mode": "adaptive", "effort": "xhigh"}}),
    ));
    // xAI clamps server-side on models that lack the level; a second clamp
    // here could only get it wrong as the model line moves.
    assert_eq!(
        encoded.body["reasoning"],
        json!({"effort": "xhigh", "summary": "concise"})
    );
    assert!(encoded.degradations.is_empty());
}

#[test]
fn forwards_max_effort_unclamped() {
    let encoded = wire(base_with(
        json!({"reasoning": {"mode": "adaptive", "effort": "max"}}),
    ));
    assert_eq!(
        encoded.body["reasoning"],
        json!({"effort": "max", "summary": "concise"})
    );
    assert!(encoded.degradations.is_empty());
}

#[test]
fn a_display_the_client_did_not_ask_for_sends_no_summary() {
    for display in ["omitted", "updates"] {
        let encoded = wire(base_with(
            json!({"reasoning": {"mode": "adaptive", "display": display}}),
        ));
        assert_eq!(
            encoded.body["reasoning"],
            json!({"effort": "medium"}),
            "{display}"
        );
    }
}

#[test]
fn records_a_lost_budget_instead_of_inventing_an_effort() {
    let encoded = wire(base_with(
        json!({"reasoning": {"mode": "budget", "budgetTokens": 8000}}),
    ));
    // These models think by default; mapping a budget onto an effort would
    // tune thinking to a depth no client asked for. Recorded, not mapped.
    assert!(encoded.body.get("reasoning").is_none());
    assert!(
        encoded
            .degradations
            .contains(&"grok:reasoning-budget-dropped".to_owned())
    );
}

#[test]
fn sends_no_reasoning_at_all_when_the_client_turned_it_off() {
    let encoded = wire(base_with(json!({"reasoning": {"mode": "off"}})));
    assert!(encoded.body.get("reasoning").is_none());
    let between = wire(base_with(json!({"reasoning": {"mode": "betweenTools"}})));
    assert!(between.body.get("reasoning").is_none());
    assert!(
        between
            .degradations
            .contains(&"grok:reasoning-between-tools-as-off".to_owned())
    );
}

#[test]
fn keeps_max_output_tokens_and_temperature_on_both_routes() {
    // The OpenAI encoder drops these under OAuth because the *Codex* backend
    // rejects them. That has nothing to do with xAI, and the fork exists so
    // the constraint does not travel.
    let req = request(base_with(json!({"maxTokens": 2048, "temperature": 0.4})));
    let encoded = to_grok_wire(&req, "grok-4.6");
    assert_eq!(encoded.body["max_output_tokens"].as_f64(), Some(2048.0));
    assert_eq!(encoded.body["temperature"].as_f64(), Some(0.4));
    assert!(encoded.degradations.is_empty());
    for creds in [oauth(json!({})), api_key()] {
        let built = build(&req, "grok-4.6", &creds, None);
        let body: Map<String, Value> = serde_json::from_str(&built.request.body).expect("body");
        assert_eq!(body["max_output_tokens"].as_f64(), Some(2048.0));
        assert_eq!(body["temperature"].as_f64(), Some(0.4));
    }
}

#[test]
fn never_emits_the_parameters_the_proxy_400s_on() {
    let encoded = wire(base_with(json!({
        "temperature": 0.4, "stopSequences": ["STOP"], "maxTokens": 10
    })));
    for field in [
        "presence_penalty",
        "frequency_penalty",
        "logprobs",
        "top_logprobs",
        "stop",
    ] {
        assert!(encoded.body.get(field).is_none(), "{field}");
    }
}

fn tools(n: usize) -> Value {
    Value::Array(
        (0..n)
            .map(|i| json!({"kind": "portable", "name": format!("f{i}"), "inputSchema": {"type": "object"}}))
            .collect(),
    )
}

#[test]
fn truncates_a_tool_list_past_the_proxys_ceiling() {
    let encoded = wire(base_with(json!({"tools": tools(250)})));
    // Above 200 the proxy answers "Maximum tools limit reached", which is far
    // harder to diagnose than a recorded degradation.
    assert_eq!(encoded.body["tools"].as_array().expect("tools").len(), 200);
    assert!(
        encoded
            .degradations
            .contains(&"grok:tools-truncated".to_owned())
    );
}

#[test]
fn records_nothing_when_the_tool_list_fits() {
    let encoded = wire(base_with(json!({"tools": tools(200)})));
    assert_eq!(encoded.body["tools"].as_array().expect("tools").len(), 200);
    assert!(
        !encoded
            .degradations
            .contains(&"grok:tools-truncated".to_owned())
    );
}

#[test]
fn round_trips_a_tool_call_and_its_result_as_top_level_input_items() {
    let encoded = wire(base_with(json!({
        "messages": [
            {"role": "assistant", "content": [
                {"type": "text", "text": "looking"},
                {"type": "toolUse", "id": "call_1", "name": "search", "input": {"q": "x"}}
            ]},
            {"role": "user", "content": [{"type": "toolResult", "toolUseId": "call_1", "content": "found"}]}
        ]
    })));
    // Both halves are siblings of the message items, not content inside one,
    // and the call has to be flushed out of the surrounding message in order.
    // Losing the result half leaves the model an unanswered call it retries.
    assert_eq!(
        encoded.body["input"],
        json!([
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "looking"}]},
            {"type": "function_call", "call_id": "call_1", "name": "search", "arguments": "{\"q\":\"x\"}"},
            {"type": "function_call_output", "call_id": "call_1", "output": "found"}
        ])
    );
    assert!(encoded.degradations.is_empty());
}

#[test]
fn serializes_a_tool_result_carrying_a_broken_escape_sequence_as_valid_json() {
    // The proxy answers `input[N].output: unexpected end of hex escape` when
    // the body is not strictly valid JSON, so a tool result holding a bare
    // backslash or a truncated \u sequence has to survive the serializer.
    let content = "path C:\\temp and a truncated \\u00 tail";
    let encoded = wire(base_with(json!({
        "messages": [{"role": "user", "content": [
            {"type": "toolResult", "toolUseId": "call_1", "content": content}
        ]}]
    })));
    let serialized = omni_ir::jsjson::to_string(&Value::Object(encoded.body));
    let reparsed: Value = serde_json::from_str(&serialized).expect("valid JSON body");
    let output = reparsed["input"]
        .as_array()
        .expect("input")
        .iter()
        .find(|item| item["type"] == json!("function_call_output"))
        .expect("output item");
    assert_eq!(output["output"], json!(content));
}

#[test]
fn encodes_every_tool_choice_form_in_the_proxys_own_spelling() {
    let encoded =
        |choice: Value| wire(base_with(json!({"toolChoice": choice}))).body["tool_choice"].clone();
    // The IR uses neither vendor's word, so `any` -> `required` is a
    // translation and not a rename: sending `auto` instead lets the model
    // answer with prose where the client demanded a call.
    assert_eq!(encoded(json!({"type": "auto"})), json!("auto"));
    assert_eq!(encoded(json!({"type": "any"})), json!("required"));
    assert_eq!(encoded(json!({"type": "none"})), json!("none"));
    assert_eq!(
        encoded(json!({"type": "tool", "name": "search"})),
        json!({"type": "function", "name": "search"})
    );
    assert!(
        wire(serde_json::to_value(base()).expect("base"))
            .body
            .get("tool_choice")
            .is_none()
    );
}

#[test]
fn keeps_a_mid_conversation_system_turn_where_the_client_put_it() {
    let encoded = wire(base_with(json!({
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            {"role": "system", "content": [{"type": "text", "text": "be brief"}]},
            {"role": "user", "content": [{"type": "text", "text": "more"}]}
        ]
    })));
    // A system turn applies from its position forward, so folding it into
    // `instructions` would move it to the front of the history and change
    // when it takes effect. It keeps its slot as a `developer` turn.
    assert_eq!(
        encoded.body["input"],
        json!([
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "be brief"}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "more"}]}
        ])
    );
    assert!(encoded.body.get("instructions").is_none());
    assert!(
        encoded
            .degradations
            .contains(&"grok:system-turn-as-developer".to_owned())
    );
}

#[test]
fn encodes_an_image_with_image_url_as_a_plain_string() {
    let encoded = wire(base_with(json!({
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "look"},
            {"type": "image", "mediaType": "image/jpeg", "data": "AAAA"}
        ]}]
    })));
    // xAI takes the data URL directly; OpenAI's `{ url: … }` object shape is
    // the one difference a copy-paste fork could silently get wrong.
    assert_eq!(
        encoded.body["input"][0],
        json!({"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": "look"},
            {"type": "input_image", "image_url": "data:image/jpeg;base64,AAAA"}
        ]})
    );
    assert!(encoded.body["input"][0]["content"][1]["image_url"].is_string());
    assert!(encoded.degradations.is_empty());
}

#[test]
fn drops_thinking_blocks_with_a_degradation() {
    let encoded = wire(base_with(json!({
        "messages": [{"role": "assistant", "content": [
            {"type": "thinking", "text": "hmm", "signature": "sig"},
            {"type": "text", "text": "ok"}
        ]}]
    })));
    assert_eq!(
        encoded.body["input"],
        json!([{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}])
    );
    assert!(
        encoded
            .degradations
            .contains(&"grok:thinking-dropped".to_owned())
    );
}

#[test]
fn records_an_anthropic_native_block_the_router_should_never_have_sent_here() {
    let encoded = wire(base_with(json!({
        "messages": [{"role": "assistant", "content": [
            {"type": "providerNative", "provider": "anthropic", "blockType": "server_tool_use", "data": {}}
        ]}]
    })));
    assert!(
        encoded
            .degradations
            .contains(&"grok:anthropic-native-block-dropped".to_owned())
    );
}

#[test]
fn merges_the_vendor_passthrough_last() {
    let encoded = wire(base_with(json!({
        "vendor": {"grok": {"store": true, "search_parameters": {"mode": "auto"}}}
    })));
    // The operator's own escape hatch, deliberately unfiltered.
    assert_eq!(encoded.body["store"], json!(true));
    assert_eq!(encoded.body["search_parameters"], json!({"mode": "auto"}));
}

#[test]
fn records_that_a_1m_request_could_not_be_honoured_here() {
    let encoded = wire(base_with(json!({"betas": ["context-1m-2025-08-07"]})));
    assert!(
        encoded
            .degradations
            .contains(&"grok:context-1m-dropped".to_owned())
    );
}

#[test]
fn sends_the_device_identity_frozen_onto_the_credential() {
    let built = build(
        &base(),
        "grok-4.6",
        &oauth(json!({"agentId": "agent-1"})),
        None,
    );
    assert_eq!(
        header_of(&built.request.headers, "x-grok-agent-id"),
        Some("agent-1")
    );
    // A credential that predates the field emits no device header.
    let older = build(&base(), "grok-4.6", &oauth(json!({})), None);
    assert_eq!(header_of(&older.request.headers, "x-grok-agent-id"), None);
}

#[test]
fn mints_a_synthetic_but_stable_agent_id() {
    let a = mint();
    assert_eq!(a.agent_id.len(), 36);
    assert!(
        a.agent_id
            .chars()
            .all(|c| c == '-' || (c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
    );
    assert_ne!(mint().agent_id, a.agent_id);
    let mut data = Map::new();
    data.insert("agentId".into(), json!(a.agent_id));
    assert_eq!(
        device_headers(&data),
        [("x-grok-agent-id".to_owned(), a.agent_id.clone())]
    );
    assert!(device_headers(&Map::new()).is_empty());
}

#[test]
fn serializes_the_body_in_the_profiles_field_order() {
    let req = request(base_with(
        json!({"system": [{"type": "text", "text": "s"}]}),
    ));
    let built = build(&req, "grok-4.6", &oauth(json!({})), None);
    let body: Map<String, Value> = serde_json::from_str(&built.request.body).expect("body");
    // `reasoning` sits between `store` and `prompt_cache_key` when present;
    // this request asks for none, and an absent field is skipped.
    assert_eq!(
        body.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "model",
            "stream",
            "input",
            "instructions",
            "store",
            "prompt_cache_key",
            "include"
        ]
    );
}

#[test]
fn orders_the_grok_headers_ahead_of_the_appended_ones() {
    let built = build(
        &base(),
        "grok-4.6",
        &oauth(json!({"agentId": "agent-1"})),
        Some("req-abc"),
    );
    let names: Vec<String> = names(&built.request.headers)
        .iter()
        .map(|n| n.to_lowercase())
        .collect();
    let at = |name: &str| names.iter().position(|n| n == name).expect(name);
    assert!(at("authorization") < at("x-xai-token-auth"));
    assert!(at("x-grok-client-identifier") < at("user-agent"));
    for name in [
        "x-grok-agent-id",
        "x-grok-req-id",
        "x-grok-conv-id",
        "x-grok-session-id",
    ] {
        assert!(at(name) < at("user-agent"), "{name}");
    }
}

#[tokio::test]
async fn decodes_the_stream_the_adapter_returns() {
    let sse = concat!(
        "event: response.created\ndata: {\"response\":{\"id\":\"r1\",\"model\":\"grok-4.6\"}}\n\n",
        "event: response.completed\ndata: {\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n",
    );
    let fake = Fake::sse(sse);
    let req = base();
    let mut result = send(
        &GrokCodec,
        "grok",
        AdapterRequest::new(&req, "grok-4.6", &api_key()),
        &fake,
    )
    .await
    .expect("send");
    assert!(result.degradations.is_empty());
    let mut events = Vec::new();
    while let Some(event) = result.events.next().await {
        events.push(event.expect("stream event"));
    }
    assert_eq!(
        events[0],
        StreamEvent::Start {
            id: "r1".into(),
            model: "grok-4.6".into()
        }
    );
    assert_eq!(
        events.last().expect("last"),
        &StreamEvent::End {
            stop_reason: omni_ir::stream::StopReason::EndTurn,
            usage: Usage {
                input_tokens: 3.0,
                output_tokens: 2.0,
                cache_read_tokens: 0.0,
                cache_write_tokens: 0.0,
                ..Usage::default()
            },
            vendor: None,
        }
    );
}

#[tokio::test]
async fn surfaces_an_upstream_rejection_as_a_typed_error() {
    let fake = Fake {
        status: 402,
        content_type: "application/json",
        body: r#"{"error":{"message":"payment required"}}"#,
        sent: Mutex::new(Vec::new()),
    };
    let req = base();
    let err = send(
        &GrokCodec,
        "grok",
        AdapterRequest::new(&req, "grok-4.6", &api_key()),
        &fake,
    )
    .await
    .expect_err("402 must fail");
    // An OAuth bearer sent to the API host bills credits and answers 402 even
    // on a healthy subscription — the symptom the host pairing prevents.
    assert_eq!(err.code(), ErrorCode::QuotaExhausted);
}
