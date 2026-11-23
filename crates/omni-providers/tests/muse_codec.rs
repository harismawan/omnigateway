//! The wire Muse puts on the socket, pinned against literals carried over
//! from `museCodec.test.ts`.
//!
//! Muse arrived on the codec contract, so the literals are written from the
//! dialect rather than quoted from a capture, and the two cache keys are
//! computed **outside** this repository: `sha256` of the stated JSON,
//! truncated to 32 characters. A test that derived them the way the encoder
//! does would agree with any encoder, including one that had started keying
//! on something that moves.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use bytes::Bytes;
use omni_ir::error::ErrorCode;
use omni_ir::jsjson::JsValue;
use omni_ir::request::ChatRequest;
use omni_ir::stream::{ContentBlockStart, Delta, StopReason, StreamEvent};
use omni_providers::adapter::{AdapterRequest, SendError, send};
use omni_providers::codec::{CodecInput, CodecRequest, Credentials, ProviderCodec};
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};
use omni_providers::muse::codec::MuseCodec;
use serde_json::{Map, Value, json};

const URL: &str = "https://api.meta.ai/v1/responses";

/// `sha256('{"instructions":"","firstInput":{…}}')`, first 32 hex characters.
const KEY: &str = "af75e45150ba5505736d80ccdd119119";
/// `sha256('{"conversation":"conv-7"}')`, likewise.
const CONVERSATION_KEY: &str = "1f539b57dc35d78bb9f3b30497db4581";

const BODY: &str = concat!(
    r#"{"model":"muse-spark-1.3","stream":true,"input":[{"type":"message","role":"user","#,
    r#""content":[{"type":"input_text","text":"hi"}]}],"store":false,"#,
    r#""prompt_cache_key":"af75e45150ba5505736d80ccdd119119"}"#
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

/// `base` with extra top-level fields merged in, as the TS `{...request, …}`.
fn base_with(extra: Value) -> Value {
    let mut shape = serde_json::to_value(base()).expect("base");
    if let (Some(dst), Some(src)) = (shape.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    shape
}

fn creds(over: Value) -> Credentials {
    let mut c = Credentials {
        access_token: None,
        api_key: None,
        provider_data: Map::new(),
    };
    if let Some(o) = over.as_object() {
        if let Some(v) = o.get("accessToken").and_then(Value::as_str) {
            c.access_token = Some(v.to_owned());
        }
        if let Some(v) = o.get("apiKey").and_then(Value::as_str) {
            c.api_key = Some(v.to_owned());
        }
        if let Some(v) = o.get("providerData").and_then(Value::as_object) {
            c.provider_data = v.clone();
        }
    }
    c
}

fn build(req: &ChatRequest, creds: &Credentials) -> CodecRequest<bool> {
    MuseCodec
        .build_request(&CodecInput {
            request: req,
            model: "muse-spark-1.3",
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

fn header_of<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
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

async fn events_with(
    req: &ChatRequest,
    creds: &Credentials,
    sse: &'static str,
) -> Vec<StreamEvent> {
    let fake = Fake::sse(sse);
    let mut result = send(
        &MuseCodec,
        "muse",
        AdapterRequest::new(req, "muse-spark-1.3", creds),
        &fake,
    )
    .await
    .expect("send");
    assert_eq!(fake.sent.lock().expect("lock").len(), 1);
    let mut events = Vec::new();
    while let Some(event) = result.events.next().await {
        events.push(event.expect("stream event"));
    }
    events
}

#[test]
fn a_minted_key_goes_to_the_model_api_front_door_as_a_bearer() {
    let built = build(&base(), &creds(json!({"apiKey": "meta-key"})));
    let sent = &built.request;
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.url, URL);
    assert_eq!(sent.body, BODY);
    assert_eq!(
        names(&sent.headers),
        [
            "Content-Type",
            "Authorization",
            "x-meta-ai-gateway-session-id",
            "x-api-version",
            "Accept",
            "User-Agent",
        ]
    );
    assert_eq!(
        header_of(&sent.headers, "Authorization"),
        Some("Bearer meta-key")
    );
    assert_eq!(header_of(&sent.headers, "x-api-version"), Some("1.0.0"));
}

#[test]
fn an_oauth_credential_sends_its_minted_key_never_the_device_flow_token() {
    // The whole shape of this provider: the OAuth grant buys a key and the
    // key is what the front door accepts. A credential carrying both must not
    // send the token — that request 401s, and the 401 names nothing.
    let built = build(
        &base(),
        &creds(json!({"accessToken": "oauth-tok", "apiKey": "meta-key"})),
    );
    assert_eq!(
        header_of(&built.request.headers, "Authorization"),
        Some("Bearer meta-key")
    );
    assert!(
        !built
            .request
            .headers
            .iter()
            .any(|(_, v)| v.contains("oauth-tok"))
    );
}

#[tokio::test]
async fn an_oauth_credential_whose_mint_never_ran_is_refused_here_not_upstream() {
    // Deliberately not falling back to `accessToken`: sending the token would
    // turn a diagnosable local state into an opaque upstream 401.
    let fake = Fake::sse("");
    let req = base();
    let err = send(
        &MuseCodec,
        "muse",
        AdapterRequest::new(
            &req,
            "muse-spark-1.3",
            &creds(json!({"accessToken": "oauth-tok"})),
        ),
        &fake,
    )
    .await
    .expect_err("no api key must fail");
    match err {
        SendError::Gateway(g) => {
            assert_eq!(g.code, ErrorCode::Auth);
            assert_eq!(g.message, "muse credential has no model api key");
        }
        SendError::Transport(t) => panic!("transport reached: {t}"),
    }
    assert!(fake.sent.lock().expect("lock").is_empty());
}

#[test]
fn the_session_header_and_the_bodys_cache_key_are_one_value() {
    // Derived at different layers, so the two can drift apart — and a backend
    // handed two names for one session caches under neither.
    let built = build(&base(), &creds(json!({"apiKey": "meta-key"})));
    assert_eq!(
        header_of(&built.request.headers, "x-meta-ai-gateway-session-id"),
        Some(KEY)
    );
    assert!(
        built
            .request
            .body
            .contains(&format!("\"prompt_cache_key\":\"{KEY}\""))
    );
}

#[test]
fn a_clients_own_conversation_id_decides_the_key_hashed_rather_than_forwarded() {
    let req = request(base_with(json!({"conversationId": "conv-7"})));
    let built = build(&req, &creds(json!({"apiKey": "meta-key"})));
    assert_eq!(
        header_of(&built.request.headers, "x-meta-ai-gateway-session-id"),
        Some(CONVERSATION_KEY)
    );
    assert!(
        built
            .request
            .body
            .contains(&format!("\"prompt_cache_key\":\"{CONVERSATION_KEY}\""))
    );
    // `conversationId` reaches us from Anthropic's `metadata.user_id`, which
    // on Claude Code carries a device id and an account uuid. It must not
    // appear.
    assert!(!built.request.body.contains("conv-7"));
}

#[test]
fn a_non_streaming_client_request_still_asks_upstream_for_a_stream() {
    let req = request(base_with(json!({"stream": false})));
    let built = build(&req, &creds(json!({"apiKey": "meta-key"})));
    assert!(built.request.body.contains("\"stream\":true"));
}

#[test]
fn the_vendor_bag_cannot_put_back_a_cache_key_the_encoder_rejected() {
    // The merge copies the client's bag verbatim, so assigning the resolved
    // key before it would let an empty string win.
    let req = request(base_with(
        json!({"vendor": {"openai": {"prompt_cache_key": ""}}}),
    ));
    let built = build(&req, &creds(json!({"apiKey": "meta-key"})));
    assert!(
        built
            .request
            .body
            .contains(&format!("\"prompt_cache_key\":\"{KEY}\""))
    );
}

#[test]
fn passthrough_rides_the_dialects_bag_which_is_openai_and_not_muse() {
    let req = request(base_with(
        json!({"vendor": {"openai": {"service_tier": "priority"}}}),
    ));
    let built = build(&req, &creds(json!({"apiKey": "meta-key"})));
    assert!(built.request.body.contains("\"service_tier\":\"priority\""));
}

#[test]
fn a_clients_own_cache_key_is_taken_from_the_dialects_bag() {
    // The *other* read of the bag: `supplied_key` looks there before deriving
    // one, and it is a separate line from the merge.
    let req = request(base_with(
        json!({"vendor": {"openai": {"prompt_cache_key": "client-chosen"}}}),
    ));
    let built = build(&req, &creds(json!({"apiKey": "meta-key"})));
    assert!(
        built
            .request
            .body
            .contains("\"prompt_cache_key\":\"client-chosen\"")
    );
    assert_eq!(
        header_of(&built.request.headers, "x-meta-ai-gateway-session-id"),
        Some("client-chosen")
    );
}

#[test]
fn a_muse_bag_is_ignored_so_a_stray_one_cannot_smuggle_fields_onto_the_wire() {
    let req = request(base_with(
        json!({"vendor": {"muse": {"service_tier": "priority"}}}),
    ));
    let built = build(&req, &creds(json!({"apiKey": "meta-key"})));
    assert!(!built.request.body.contains("service_tier"));
}

#[tokio::test]
async fn include_from_the_client_is_what_turns_native_reasoning_on() {
    let sse = concat!(
        "event: response.output_item.added\n",
        "data: {\"output_index\":0,\"item\":{\"type\":\"reasoning\"}}\n\n",
        "event: response.reasoning_summary_text.delta\n",
        "data: {\"output_index\":0,\"delta\":\"weighing it\"}\n\n",
        "event: response.output_item.done\n",
        "data: {\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"encrypted_content\":\"opaque\"}}\n\n",
        "event: response.completed\n",
        "data: {\"response\":{\"status\":\"completed\"}}\n\n",
    );
    let req = request(base_with(
        json!({"vendor": {"openai": {"include": ["reasoning.encrypted_content"]}}}),
    ));
    let events = events_with(&req, &creds(json!({"apiKey": "meta-key"})), sse).await;

    let start = events
        .iter()
        .find(|e| matches!(e, StreamEvent::BlockStart { .. }))
        .expect("blockStart");
    assert_eq!(
        start,
        &StreamEvent::BlockStart {
            index: 0,
            block: ContentBlockStart::ProviderNative {
                provider: "muse".into(),
                block_type: "reasoning".into(),
                data: JsValue::Object(Vec::new()),
            },
        }
    );
    // Tagged `muse`, never `openai`: the block's `provider` is what the router
    // reads to decide which targets may receive this history. **Every**
    // provider-native delta, not the first — the streaming summary and the
    // fold that carries `encrypted_content` are tagged separately.
    let tags: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::BlockDelta {
                delta: Delta::ProviderNative { provider, .. },
                ..
            } => Some(provider.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(tags, ["muse", "muse"]);
}

#[tokio::test]
async fn a_tool_call_ends_the_turn_as_tool_use_not_end_turn() {
    // `endTurn` on a turn that asked for a tool is the one wrong answer
    // nobody notices: the client reads a finished reply and stops.
    let sse = concat!(
        "event: response.output_item.added\n",
        "data: {\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"ls\"}}\n\n",
        "event: response.completed\n",
        "data: {\"response\":{\"status\":\"completed\"}}\n\n",
    );
    let events = events_with(&base(), &creds(json!({"apiKey": "meta-key"})), sse).await;
    let end = events
        .iter()
        .find(|e| matches!(e, StreamEvent::End { .. }))
        .expect("end");
    assert!(matches!(
        end,
        StreamEvent::End {
            stop_reason: StopReason::ToolUse,
            ..
        }
    ));
}

#[tokio::test]
async fn cached_input_is_subtracted_so_it_is_not_billed_as_ordinary_input_too() {
    let sse = concat!(
        "event: response.completed\n",
        "data: {\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":100,",
        "\"output_tokens\":5,\"input_tokens_details\":{\"cached_tokens\":80}}}}\n\n",
    );
    let events = events_with(&base(), &creds(json!({"apiKey": "meta-key"})), sse).await;
    let end = events
        .iter()
        .find(|e| matches!(e, StreamEvent::End { .. }))
        .expect("end");
    match end {
        StreamEvent::End { usage, .. } => {
            assert_eq!(usage.input_tokens, 20.0);
            assert_eq!(usage.cache_read_tokens, 80.0);
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn an_upstream_error_keeps_its_class_and_an_unknown_event_names_muse() {
    let authed = concat!(
        "event: error\n",
        "data: {\"error\":{\"code\":\"invalid_api_key\",\"message\":\"bad key\"}}\n\n",
    );
    let first = events_with(&base(), &creds(json!({"apiKey": "meta-key"})), authed).await;
    // AUTH, not UPSTREAM: the breaker and the retry policy read this, and a
    // dead key retried as a transient fault burns every attempt.
    assert!(first.iter().any(|e| matches!(
        e,
        StreamEvent::Error {
            code: ErrorCode::Auth,
            ..
        }
    )));

    let unknown = "event: response.hallucinated\ndata: {}\n\n";
    let second = events_with(&base(), &creds(json!({"apiKey": "meta-key"})), unknown).await;
    // Fails visibly rather than skipping, and says whose stream it was.
    assert!(second.iter().any(|e| matches!(
        e,
        StreamEvent::Error { message, .. }
            if message == "unrecognized muse stream event \"response.hallucinated\""
    )));
}

#[tokio::test]
async fn what_this_dialect_cannot_express_is_recorded_not_dropped_in_silence() {
    let fake = Fake::sse("data: [DONE]\n\n");
    let req = request(base_with(json!({
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": "be brief"}]},
            {"role": "assistant", "content": [
                {"type": "thinking", "text": "hmm", "signature": "sig"},
                {"type": "providerNative", "provider": "anthropic", "blockType": "reasoning", "data": {}}
            ]},
            {"role": "user", "content": [{"type": "text", "text": "hi"}]}
        ],
        "tools": [{
            "kind": "provider", "provider": "anthropic", "family": "webSearch",
            "type": "web_search_20250305", "name": "web_search", "wire": {}
        }],
        "reasoning": {"mode": "budget", "budgetTokens": 4096}
    })));
    let c = creds(json!({"apiKey": "meta-key"}));
    let mut result = send(
        &MuseCodec,
        "muse",
        AdapterRequest::new(&req, "muse-spark-1.3", &c),
        &fake,
    )
    .await
    .expect("send");
    while let Some(event) = result.events.next().await {
        drop(event.expect("stream event"));
    }
    assert_eq!(
        result.degradations,
        [
            "muse:system-turn-as-developer",
            "muse:thinking-dropped",
            "muse:foreign-native-block-dropped",
            "muse:provider-tool-dropped",
            "muse:reasoning-budget-dropped",
        ]
    );
    // The mid-conversation system turn keeps its position and its standing.
    let sent = fake.sent.lock().expect("lock");
    assert!(sent[0].body.contains("\"role\":\"developer\""));
}

#[test]
fn its_own_reasoning_item_goes_home_without_the_id_it_cannot_resolve() {
    let req = request(base_with(json!({
        "messages": [
            {"role": "assistant", "content": [{
                "type": "providerNative", "provider": "muse", "blockType": "reasoning",
                "data": {"id": "rs_1", "encrypted_content": "opaque"}
            }]},
            {"role": "user", "content": [{"type": "text", "text": "hi"}]}
        ]
    })));
    let built = build(&req, &creds(json!({"apiKey": "meta-key"})));
    // Under `store: false` no server-assigned id resolves, and an item still
    // carrying one is rejected outright.
    assert!(
        built
            .request
            .body
            .contains("\"encrypted_content\":\"opaque\"")
    );
    assert!(!built.request.body.contains("rs_1"));
}

#[test]
fn an_unanswered_tool_call_is_completed_rather_than_removed() {
    // Removing it would rewrite what the model said; leaving it bare is
    // refused by the API.
    let req = request(base_with(json!({
        "messages": [
            {"role": "assistant", "content": [
                {"type": "toolUse", "id": "call_1", "name": "ls", "input": {}}
            ]}
        ]
    })));
    let built = build(&req, &creds(json!({"apiKey": "meta-key"})));
    assert!(
        built
            .request
            .body
            .contains("{\"type\":\"function_call\",\"call_id\":\"call_1\"")
    );
    assert!(
        built
            .request
            .body
            .contains("{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"\"}")
    );
}

#[tokio::test]
async fn a_stream_decodes_to_text_and_usage() {
    let sse = concat!(
        "event: response.content_part.added\n",
        "data: {\"output_index\":0,\"content_index\":0,\"part\":{\"type\":\"output_text\"}}\n\n",
        "event: response.output_text.delta\n",
        "data: {\"output_index\":0,\"content_index\":0,\"delta\":\"he\"}\n\n",
        "event: response.output_text.delta\n",
        "data: {\"output_index\":0,\"content_index\":0,\"delta\":\"llo\"}\n\n",
        "event: response.completed\n",
        "data: {\"response\":{\"status\":\"completed\",\"usage\":",
        "{\"input_tokens\":11,\"output_tokens\":2,\"total_tokens\":13}}}\n\n",
        "data: [DONE]\n\n",
    );
    let events = events_with(&base(), &creds(json!({"apiKey": "meta-key"})), sse).await;
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::BlockDelta {
                delta: Delta::Text { text },
                ..
            } => Some(text.to_utf8_lossy().into_owned()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "hello");
    let end = events
        .iter()
        .find(|e| matches!(e, StreamEvent::End { .. }))
        .expect("end");
    match end {
        StreamEvent::End {
            stop_reason, usage, ..
        } => {
            assert_eq!(*stop_reason, StopReason::EndTurn);
            assert_eq!(usage.input_tokens, 11.0);
            assert_eq!(usage.output_tokens, 2.0);
        }
        _ => unreachable!(),
    }
}

#[test]
fn the_base_url_the_mint_stated_is_where_inference_goes() {
    // Muse's own client follows `base_url` from the login rather than a
    // compiled constant.
    let built = build(
        &base(),
        &creds(
            json!({"apiKey": "meta-key", "providerData": {"baseUrl": "https://api.meta.ai/v2"}}),
        ),
    );
    assert_eq!(built.request.url, "https://api.meta.ai/v2/responses");
}

#[test]
fn a_stored_base_url_is_validated_at_the_read_that_attaches_the_key() {
    // `providerData` is parsed back out of the database with a bare
    // `JSON.parse`, so the mint-time check is not a guarantee this read may
    // lean on. Each of these would otherwise send the minted key to a host
    // Meta does not control.
    for base_url in [
        json!("https://evil.example/v1"),
        json!("https://api.meta.ai@evil.example/v1"),
        json!("https://evilmeta.ai/v1"),
        json!("https://api.meta.ai.attacker.example/v1"),
        json!("http://api.meta.ai/v1"),
        json!("https://api.meta.ai/v1?x=1"),
        json!("https://api.meta.ai/v1#f"),
        json!(""),
        json!(7),
        json!("ftp://api.meta.ai/v1"),
    ] {
        let built = build(
            &base(),
            &creds(json!({"apiKey": "meta-key", "providerData": {"baseUrl": base_url}})),
        );
        assert_eq!(built.request.url, URL, "{base_url}");
    }
}

#[test]
fn a_base_url_meta_really_could_have_published_is_honoured() {
    for (base_url, url) in [
        ("https://api.meta.ai/v1", "https://api.meta.ai/v1/responses"),
        (
            "https://api.meta.ai/v1/",
            "https://api.meta.ai/v1/responses",
        ),
        (
            "https://eu.api.meta.ai/v2",
            "https://eu.api.meta.ai/v2/responses",
        ),
    ] {
        let built = build(
            &base(),
            &creds(json!({"apiKey": "meta-key", "providerData": {"baseUrl": base_url}})),
        );
        assert_eq!(built.request.url, url, "{base_url}");
    }
}
