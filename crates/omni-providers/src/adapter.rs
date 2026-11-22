//! The host side of the codec contract:
//! build → validate → send → classify a failure → decode.
//!
//! The returned [`EventStream`] owns the response body. It reads the body only
//! as fast as the caller pulls events, and dropping it drops the body, which
//! closes the upstream connection.

use std::collections::VecDeque;

use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::js::utf16_prefix;
use omni_ir::request::ChatRequest;
use omni_ir::stream::StreamEvent;

use crate::codec::{
    CodecErrorInput, CodecInput, Credentials, DecodeError, Flow, ProviderCodec, StreamDecoder,
};
use crate::http::{BodyEncoding, HttpClient, HttpError, HttpRequest, ResponseBody};
use crate::http_error::{http_error, now_ms};
use crate::sse::{SseMessage, SseParser};

/// What dispatch hands an adapter for one attempt (`AdapterRequest`).
#[derive(Debug, Clone, Copy)]
pub struct AdapterRequest<'a> {
    pub request: &'a ChatRequest,
    pub model: &'a str,
    pub credentials: &'a Credentials,
    pub request_id: Option<&'a str>,
    /// Whether the codec may add a cache breakpoint the client did not send.
    pub auto_cache: Option<bool>,
    /// The target's saved output ceiling, when the operator set one.
    pub max_output_tokens: Option<f64>,
    /// When dispatch accepted the request, epoch milliseconds.
    pub request_started_at: Option<f64>,
}

impl<'a> AdapterRequest<'a> {
    /// A request with every optional policy field absent.
    pub fn new(request: &'a ChatRequest, model: &'a str, credentials: &'a Credentials) -> Self {
        AdapterRequest {
            request,
            model,
            credentials,
            request_id: None,
            auto_cache: None,
            max_output_tokens: None,
            request_started_at: None,
        }
    }
}

/// `AdapterResult`.
#[derive(Debug)]
pub struct AdapterResult {
    pub events: EventStream,
    pub degradations: Vec<String>,
    pub cloaked_tools: Option<u32>,
}

/// Why `send` produced no stream.
#[derive(Debug, thiserror::Error)]
pub enum SendError {
    /// Classified: a codec refusal, an upstream status, a codec failure.
    #[error(transparent)]
    Gateway(#[from] GatewayError),
    /// The transport failed before a response head; `classify()` decides
    /// the code from the transport error's hints.
    #[error(transparent)]
    Transport(HttpError),
}

impl SendError {
    /// The code `classify()` gives this: a `GatewayError`'s own, `NETWORK` for
    /// a transport failure its hints recognise, `INTERNAL` otherwise.
    pub fn code(&self) -> ErrorCode {
        match self {
            SendError::Gateway(e) => e.code,
            SendError::Transport(e) if e.is_network() => ErrorCode::Network,
            SendError::Transport(_) => ErrorCode::Internal,
        }
    }
}

/// `codecFailure`: retryable, naming the provider, gateway-authored.
fn codec_failure(id: &str, hook: &str, what: &str) -> GatewayError {
    GatewayError::new(ErrorCode::Upstream, format!("{id} codec {hook} {what}"))
        .with_provider(id)
        .gateway_authored()
}

/// `boundedDegradations`: 16 entries of 64 UTF-16 units.
pub fn bounded_degradations(entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .take(16)
        .map(|e| utf16_prefix(e, 64).into_owned())
        .collect()
}

/// `rebound`: the codec's classification, with the host's provider and bounds,
/// and never `gatewayAuthored`.
fn rebound(id: &str, error: GatewayError) -> GatewayError {
    let degradations = bounded_degradations(&error.degradations);
    let mut out = GatewayError::new(error.code, error.message)
        .with_provider(id)
        .with_retry_after_ms(error.retry_after_ms)
        .with_degradations(degradations);
    out.upstream_status = error.upstream_status;
    out
}

const HTTP_METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/// `isSendableUrl`: parses as a WHATWG URL with an http(s) scheme.
pub fn is_sendable_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
}

/// `framingAgrees`.
fn framing_agrees(
    headers: &[(String, String)],
    body: &str,
    encoding: Option<BodyEncoding>,
) -> bool {
    let named = |name: &str| -> Vec<&str> {
        headers
            .iter()
            .filter(|(n, _)| n.to_lowercase() == name)
            .map(|(_, v)| v.as_str())
            .collect()
    };
    let lengths = named("content-length");
    let encodings = named("content-encoding");
    if let Some(BodyEncoding::Zstd) = encoding {
        return lengths.is_empty()
            && encodings.len() == 1
            && omni_ir::js::trim(encodings[0]).to_lowercase() == "zstd";
    }
    if lengths.len() > 1 || encodings.len() > 1 {
        return false;
    }
    if let Some(length) = lengths.first()
        && *length != body.len().to_string()
    {
        return false;
    }
    encodings
        .first()
        .is_none_or(|e| omni_ir::js::trim(e).to_lowercase() == "identity")
}

/// Build, validate and send one codec request.
pub async fn send<C: ProviderCodec>(
    codec: &C,
    id: &str,
    req: AdapterRequest<'_>,
    http: &dyn HttpClient,
) -> Result<AdapterResult, SendError> {
    let input = CodecInput {
        request: req.request,
        model: req.model,
        credentials: req.credentials,
        request_id: req.request_id,
        auto_cache_enabled: req.auto_cache,
        max_output_tokens: req.max_output_tokens,
        request_started_at: req.request_started_at,
    };
    let built = codec.try_build_request(&input).map_err(|e| match e {
        crate::codec::BuildError::Gateway(e) => rebound(id, e),
        crate::codec::BuildError::Throw => codec_failure(id, "buildRequest", "threw"),
    })?;
    let request = built.request;
    let usable = is_sendable_url(&request.url)
        && HTTP_METHODS.contains(&request.method.as_str())
        && framing_agrees(&request.headers, &request.body, request.body_encoding);
    if !usable {
        return Err(codec_failure(id, "buildRequest", "did not return a usable request").into());
    }
    let degradations = bounded_degradations(&built.degradations);

    let mut res = http
        .send(HttpRequest {
            provider: id.to_string(),
            url: request.url,
            method: request.method,
            headers: request.headers,
            body: request.body,
            body_encoding: request.body_encoding,
            request_id: req.request_id.map(str::to_string),
        })
        .await
        .map_err(SendError::Transport)?;

    if !(200..300).contains(&res.status) {
        // Read once; a body that fails mid-read is "" (`.catch(() => "")`).
        let text = res.body.text().await.unwrap_or_default();
        let fallback = http_error(res.status, &res.headers, &text, id, now_ms());
        let classified = codec.classify_error(&CodecErrorInput {
            status: res.status,
            body: &text,
            headers: &res.headers,
            degradations: &degradations,
            decode_state: &built.decode_state,
            fallback: &fallback,
        });
        return Err(match classified {
            Some(e) => rebound(id, e),
            None => fallback,
        }
        .into());
    }

    res.body.start_stream();
    Ok(AdapterResult {
        events: EventStream {
            id: id.to_string(),
            body: Some(res.body),
            parser: SseParser::new(),
            decoder: codec.decoder(built.decode_state, &res.headers),
            pending: VecDeque::new(),
            failure: None,
            finished: false,
        },
        degradations,
        cloaked_tools: built.cloaked_tools,
    })
}

/// The decoded event stream, guarded by the host.
///
/// Yields events, then at most one error, then `None`. An unclassified decoder
/// throw ([`DecodeError::Throw`]) and a body transport failure become
/// `"<id> codec decode threw"`; a decoder's classified
/// [`DecodeError::Gateway`] and an oversized SSE record (the parser's own
/// `GatewayError`) pass through unchanged.
pub struct EventStream {
    id: String,
    body: Option<ResponseBody>,
    parser: SseParser,
    decoder: Box<dyn StreamDecoder>,
    pending: VecDeque<StreamEvent>,
    failure: Option<GatewayError>,
    finished: bool,
}

impl std::fmt::Debug for EventStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventStream")
            .field("id", &self.id)
            .field("pending", &self.pending.len())
            .field("finished", &self.finished)
            .finish_non_exhaustive()
    }
}

impl EventStream {
    /// The next event, the stream's error, or `None` at the end.
    pub async fn next(&mut self) -> Option<Result<StreamEvent, GatewayError>> {
        loop {
            if let Some(ev) = self.pending.pop_front() {
                return Some(Ok(ev));
            }
            if let Some(e) = self.failure.take() {
                // A failed stream's connection is never salvaged: dropped, closed.
                self.body = None;
                self.finished = true;
                return Some(Err(e));
            }
            if self.finished {
                return None;
            }
            self.advance().await;
        }
    }

    /// Reads one body chunk and decodes it, or finishes the stream.
    async fn advance(&mut self) {
        let Some(body) = self.body.as_mut() else {
            self.finished = true;
            return;
        };
        match body.next_chunk().await {
            Some(Ok(chunk)) => {
                let mut messages = Vec::new();
                let parsed = self.parser.push(&chunk, &mut messages);
                let stopped = self.decode_all(&messages);
                // A decoder that stopped never read past its last message, so
                // a parse error later in the same chunk was never reached.
                if let (Err(e), false) = (parsed, stopped) {
                    self.failure = Some(e);
                }
            }
            Some(Err(_transport)) => {
                self.failure = Some(codec_failure(&self.id, "decode", "threw"));
            }
            None => {
                self.body = None;
                let parser = std::mem::take(&mut self.parser);
                let last: Vec<SseMessage> = parser.finish().into_iter().collect();
                if !self.decode_all(&last) {
                    self.decoder.finish(&mut self.pending);
                }
                self.finished = true;
            }
        }
    }

    /// Feeds messages to the decoder; `true` if it stopped (or threw).
    fn decode_all(&mut self, messages: &[SseMessage]) -> bool {
        let mut terminal = false;
        for msg in messages {
            let start = self.pending.len();
            match self.decoder.message(msg, &mut self.pending) {
                Ok(Flow::Continue) => {
                    // Dispatch stops at End. Finish the body before delivering
                    // it even when a decoder leaves its own parser running.
                    if self
                        .pending
                        .iter()
                        .skip(start)
                        .any(|event| matches!(event, StreamEvent::End { .. }))
                    {
                        self.stop();
                        terminal = true;
                    }
                }
                Ok(Flow::Stop) => {
                    self.stop();
                    return true;
                }
                // A `GatewayError` passes through as it is; only
                // an unclassified throw is relabelled.
                Err(DecodeError::Gateway(e)) => {
                    self.failure = Some(e);
                    return true;
                }
                Err(DecodeError::Throw(_)) => {
                    self.failure = Some(codec_failure(&self.id, "decode", "threw"));
                    return true;
                }
            }
        }
        // Preserve decoder output from messages already parsed in this chunk
        // (including post-End events).
        terminal
    }

    /// Reads nothing more. A body whose remainder is already buffered goes
    /// back to the pool; anything else is closed.
    fn stop(&mut self) {
        self.finished = true;
        if let Some(body) = self.body.take() {
            body.finish_if_ready();
        }
    }
}
