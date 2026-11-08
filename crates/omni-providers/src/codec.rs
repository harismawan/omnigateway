//! The provider codec contract (`packages/providers/src/codec.ts`).
//!
//! A codec describes one HTTP request and reads one stream back; the host
//! ([`crate::adapter`]) performs the request, checks the status and owns every
//! retry decision. Nothing here is async: the absence of I/O is a property of
//! the shape.
//!
//! `decodeState` is an associated type rather than TS's `unknown`, so the
//! "host handed back the wrong state" failure TS guards against at runtime
//! cannot be written.

use std::collections::VecDeque;

use omni_ir::error::GatewayError;
use omni_ir::request::ChatRequest;
use omni_ir::stream::StreamEvent;
use serde_json::{Map, Value};

use crate::http::{BodyEncoding, Headers};
use crate::sse::SseMessage;

/// `AdapterCredentials`: decrypted, from the in-memory snapshot.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Credentials {
    pub access_token: Option<String>,
    pub api_key: Option<String>,
    /// Durable provider-specific state (custom: `origin`, `basePath`, `protocol`).
    pub provider_data: Map<String, Value>,
}

/// What a codec is given to build a request (`CodecInput`).
#[derive(Debug, Clone, Copy)]
pub struct CodecInput<'a> {
    pub request: &'a ChatRequest,
    /// Concrete upstream model id, already resolved from the virtual model.
    pub model: &'a str,
    pub credentials: &'a Credentials,
    pub request_id: Option<&'a str>,
    pub auto_cache_enabled: Option<bool>,
    pub max_output_tokens: Option<f64>,
    /// Epoch milliseconds dispatch accepted the request.
    pub request_started_at: Option<f64>,
}

/// `CodecHttpRequest`: everything but who is sending it and when to give up.
#[derive(Debug, Clone, PartialEq)]
pub struct CodecHttpRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub body_encoding: Option<BodyEncoding>,
}

/// `CodecRequest`.
#[derive(Debug)]
pub struct CodecRequest<S> {
    pub request: CodecHttpRequest,
    pub decode_state: S,
    /// What the request could not express, in `request_logs` vocabulary.
    pub degradations: Vec<String>,
    /// How many client tool names were renamed outbound. A count, never names.
    pub cloaked_tools: Option<u32>,
}

/// `CodecErrorInput`, for [`ProviderCodec::classify_error`].
#[derive(Debug)]
pub struct CodecErrorInput<'a, S> {
    pub status: u16,
    pub body: &'a str,
    pub headers: &'a Headers,
    pub degradations: &'a [String],
    pub decode_state: &'a S,
    /// The error the host raises if the hook returns `None`.
    pub fallback: &'a GatewayError,
}

/// Whether a decoder wants more of the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    /// The decoder returned: read nothing more, emit nothing more.
    Stop,
}

/// Why a decoder stopped with an error, as `guardStream` in
/// `codecAdapter.ts` sees what a TS decoder throws.
#[derive(Debug, Clone, PartialEq)]
pub enum DecodeError {
    /// A thrown `GatewayError`: the decoder's own classification (built with
    /// `fail`, say). The host passes it through **unchanged** — not restamped,
    /// not bounded — whether or not events were already emitted, exactly as
    /// `guardStream` rethrows `error instanceof GatewayError`.
    Gateway(GatewayError),
    /// Anything else thrown — a `TypeError` in TS. The host relabels it as
    /// the gateway-authored `UPSTREAM` `"<id> codec decode threw"`; the text
    /// is for debugging and never reaches the caller.
    Throw(&'static str),
}

/// An incremental stream decoder: SSE messages in, canonical events out.
pub trait StreamDecoder: Send {
    /// One message. Events are appended to `out` even when this then fails.
    fn message(
        &mut self,
        msg: &SseMessage,
        out: &mut VecDeque<StreamEvent>,
    ) -> Result<Flow, DecodeError>;

    /// The body ended without the decoder stopping.
    fn finish(&mut self, out: &mut VecDeque<StreamEvent>);
}

/// `ProviderCodec`.
pub trait ProviderCodec: Send + Sync {
    type State: Send + 'static;

    /// Pure: the same input describes the same request. Errors are the codec's
    /// classification; the host restamps `provider` and bounds `degradations`.
    fn build_request(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<Self::State>, GatewayError>;

    /// The decoder for a 2xx response.
    fn decoder(&self, state: Self::State, headers: &Headers) -> Box<dyn StreamDecoder>;

    /// A better error than the host's default, for a failed response.
    fn classify_error(&self, _input: &CodecErrorInput<'_, Self::State>) -> Option<GatewayError> {
        None
    }
}
