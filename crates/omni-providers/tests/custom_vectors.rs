//! The custom provider end to end against vectors produced by calling the real
//! TS `customAdapter.send` (codecAdapter → wire encoders → parseSse →
//! decoders), plus `httpError` / `parseRetryAfter` and the literals pinned in
//! `packages/providers/test/customCodec.test.ts`.

mod common;

use std::sync::Mutex;

use common::{chunks, describe_error};
use omni_ir::request::ChatRequest;
use omni_providers::adapter::{AdapterRequest, send};
use omni_providers::codec::Credentials;
use omni_providers::custom::CustomCodec;
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};
use serde_json::{Value, json};

/// Records each request and answers with one scripted response.
struct Fake {
    status: u16,
    headers: Vec<(String, String)>,
    chunks: Vec<bytes::Bytes>,
    sent: Mutex<Vec<HttpRequest>>,
}

impl Fake {
    fn new(response: &Value) -> Fake {
        Fake {
            status: u16::try_from(response["status"].as_u64().expect("status")).expect("u16"),
            headers: response["headers"]
                .as_array()
                .expect("headers")
                .iter()
                .map(|p| {
                    (
                        p[0].as_str().expect("n").into(),
                        p[1].as_str().expect("v").into(),
                    )
                })
                .collect(),
            chunks: chunks(&response["chunks"]),
            sent: Mutex::new(Vec::new()),
        }
    }
}

impl HttpClient for Fake {
    fn send(
        &self,
        req: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
    > {
        self.sent.lock().expect("lock").push(req);
        let mut headers = Headers::new();
        for (n, v) in &self.headers {
            headers.append_received(n, v);
        }
        let body = ResponseBody::from_chunks(self.chunks.clone());
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

/// Runs the Rust adapter and renders the result the way the exporter does.
async fn run(request: &ChatRequest, creds: Credentials, fake: &Fake) -> Value {
    let outcome = send(
        &CustomCodec,
        "custom",
        AdapterRequest::new(request, "m1", &creds),
        fake,
    )
    .await;
    let sent: Vec<Value> = fake
        .sent
        .lock()
        .expect("lock")
        .iter()
        .map(|r| {
            json!({
                "url": r.url,
                "method": r.method,
                "headers": r.headers.iter().map(|(n, v)| json!([n, v])).collect::<Vec<_>>(),
                "body": r.body,
                "provider": r.provider,
            })
        })
        .collect();
    match outcome {
        Err(e) => json!({
            "sent": sent,
            "sendError": match &e {
                omni_providers::SendError::Gateway(g) => describe_error(g),
                omni_providers::SendError::Transport(t) => panic!("fake transport failed: {t}"),
            },
            "degradations": null,
            "events": null,
            "streamError": null,
        }),
        Ok(mut result) => {
            let mut events = Vec::new();
            let mut stream_error = Value::Null;
            while let Some(item) = result.events.next().await {
                match item {
                    // This older corpus projects its tagged UTF-16 strings
                    // to scalar JSON via `normalize` on the expected side.
                    Ok(ev) => events.push(omni_ir::jsjson::to_serde_lossy(&ev.to_value())),
                    Err(e) => {
                        stream_error = describe_error(&e);
                        break;
                    }
                }
            }
            json!({
                "sent": sent,
                "sendError": null,
                "degradations": result.degradations,
                "events": events,
                "streamError": stream_error,
            })
        }
    }
}

/// The literals `customCodec.test.ts` pins, restated here so a regenerated
/// vector file cannot silently move them.
#[tokio::test]
async fn custom_codec_test_literals() {
    let request: ChatRequest = serde_json::from_value(json!({
        "model": "pool",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true
    }))
    .expect("request");
    let endpoint = |extra: Value| {
        let mut data = json!({"origin": "https://host.test", "protocol": "chat_completions"});
        if let (Some(d), Some(e)) = (data.as_object_mut(), extra.as_object()) {
            d.extend(e.clone());
        }
        Credentials {
            access_token: None,
            api_key: Some("ck".into()),
            provider_data: data.as_object().expect("object").clone(),
        }
    };
    let done = json!({"status": 200, "headers": [], "chunks": ["data: [DONE]\n\n"]});
    let cases = [
        (
            json!({}),
            "https://host.test/v1/chat/completions",
            Some(
                r#"{"model":"m1","messages":[{"role":"user","content":"hi"}],"stream":true,"stream_options":{"include_usage":true}}"#,
            ),
        ),
        (
            json!({"protocol": "responses"}),
            "https://host.test/v1/responses",
            Some(
                r#"{"model":"m1","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"stream":true,"store":false}"#,
            ),
        ),
        (
            json!({"basePath": "/api/v1", "protocol": "responses"}),
            "https://host.test/api/v1/responses",
            None,
        ),
        (
            json!({"basePath": "/api/coding/paas/v4"}),
            "https://host.test/api/coding/paas/v4/chat/completions",
            None,
        ),
        (
            json!({"basePath": "/api"}),
            "https://host.test/api/v1/chat/completions",
            None,
        ),
    ];
    for (extra, url, body) in cases {
        let fake = Fake::new(&done);
        let _ = run(&request, endpoint(extra), &fake).await;
        let sent = fake.sent.lock().expect("lock");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].url, url);
        assert_eq!(
            sent[0].headers,
            [
                ("Content-Type".to_string(), "application/json".to_string()),
                ("Authorization".to_string(), "Bearer ck".to_string())
            ]
        );
        if let Some(body) = body {
            assert_eq!(sent[0].body, body);
        }
    }
}
