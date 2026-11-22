//! How the host's stream guard treats a decoder's failure: a thrown
//! `GatewayError` passes through unchanged, before the first event or after
//! events were emitted; anything else becomes `"<id> codec decode threw"`.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;

use bytes::Bytes;
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::request::ChatRequest;
use omni_ir::stream::StreamEvent;
use omni_providers::adapter::{AdapterRequest, send};
use omni_providers::codec::{
    CodecHttpRequest, CodecInput, CodecRequest, Credentials, DecodeError, Flow, ProviderCodec,
    StreamDecoder,
};
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};
use omni_providers::sse::SseMessage;
use serde_json::json;

/// Answers every request 200 with the given SSE body.
struct Fake(&'static str);

impl HttpClient for Fake {
    fn send(
        &self,
        _req: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        let body = self.0;
        Box::pin(async move {
            Ok(HttpResponse {
                status: 200,
                headers: Headers::new(),
                body: ResponseBody::from_chunks(vec![Bytes::from_static(body.as_bytes())]),
            })
        })
    }
}

/// The classified error the decoder raises, deliberately unlike what the host
/// would build: another provider, authored, a status and a retry hint.
fn classified() -> GatewayError {
    let mut e = GatewayError::new(ErrorCode::Auth, "token revoked mid-stream")
        .with_provider("somebody-else")
        .with_status(401)
        .with_retry_after_ms(Some(1500.0))
        .with_degradations(vec!["d".repeat(100); 20]);
    e.gateway_authored = true;
    e
}

/// `data: ev` emits a start event; `data: fail` raises [`classified`];
/// `data: throw` raises a plain throw.
struct Scripted;

impl StreamDecoder for Scripted {
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError> {
        match msg.data.as_str() {
            "ev" => {
                out.push_back(StreamEvent::Start {
                    id: "r".into(),
                    model: "m".into(),
                });
                Ok(Flow::Continue)
            }
            "fail" => Err(DecodeError::Gateway(classified())),
            _ => Err(DecodeError::Throw("not iterable")),
        }
    }

    fn finish(&mut self, _out: &mut VecDeque<StreamEvent>) {}
}

struct Codec;

impl ProviderCodec for Codec {
    type State = ();

    fn build_request(&self, _input: &CodecInput<'_>) -> Result<CodecRequest<()>, GatewayError> {
        Ok(CodecRequest {
            request: CodecHttpRequest {
                url: "http://127.0.0.1:9/".into(),
                method: "POST".into(),
                headers: vec![],
                body: "{}".into(),
                body_encoding: None,
            },
            decode_state: (),
            degradations: vec![],
            cloaked_tools: None,
        })
    }

    fn decoder(&self, _state: (), _headers: &Headers) -> Box<dyn StreamDecoder> {
        Box::new(Scripted)
    }
}

async fn run(body: &'static str) -> Vec<Result<StreamEvent, GatewayError>> {
    let request: ChatRequest = serde_json::from_value(json!({
        "model": "m",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": true
    }))
    .expect("request");
    let creds = Credentials::default();
    let mut result = send(
        &Codec,
        "plug",
        AdapterRequest::new(&request, "m", &creds),
        &Fake(body),
    )
    .await
    .expect("sent");
    let mut seen = Vec::new();
    while let Some(item) = result.events.next().await {
        seen.push(item);
    }
    seen
}

#[tokio::test]
async fn a_classified_failure_before_any_event_passes_through_unchanged() {
    let seen = run("data: fail\n\ndata: ev\n\n").await;
    assert_eq!(seen, vec![Err(classified())]);
}

#[tokio::test]
async fn a_classified_failure_after_events_passes_through_unchanged() {
    let seen = run("data: ev\n\ndata: ev\n\ndata: fail\n\ndata: ev\n\n").await;
    assert_eq!(seen.len(), 3, "{seen:?}");
    assert!(matches!(seen[0], Ok(StreamEvent::Start { .. })));
    assert!(matches!(seen[1], Ok(StreamEvent::Start { .. })));
    assert_eq!(seen[2], Err(classified()));
}

#[tokio::test]
async fn an_unclassified_throw_is_relabelled_as_a_codec_failure() {
    let seen = run("data: ev\n\ndata: throw\n\n").await;
    assert_eq!(seen.len(), 2, "{seen:?}");
    let expected = GatewayError::new(ErrorCode::Upstream, "plug codec decode threw")
        .with_provider("plug")
        .gateway_authored();
    assert_eq!(seen[1], Err(expected));
}
