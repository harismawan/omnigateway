//! The provider codec contract.
//!
//! A codec describes one HTTP request and reads one stream back; the host
//! ([`crate::adapter`]) performs the request, checks the status and owns every
//! retry decision. Nothing here is async: the absence of I/O is a property of
//! the shape.
//!
//! `decodeState` is an associated type rather than an untyped value, so the
//! "host handed back the wrong state" failure cannot be written.

use std::collections::VecDeque;

use omni_ir::error::GatewayError;
use omni_ir::request::ChatRequest;
use omni_ir::stream::StreamEvent;
use serde_json::{Map, Value};

use crate::http::{BodyEncoding, Headers};
use crate::sse::SseMessage;

// A bounded-depth iterator stack, rather than a pending node per sibling.
pub(crate) fn needs_scope(value: &Value) -> bool {
    enum Kids<'a> {
        Arr(std::slice::Iter<'a, Value>),
        Obj(serde_json::map::Values<'a>),
    }
    impl<'a> Iterator for Kids<'a> {
        type Item = &'a Value;
        fn next(&mut self) -> Option<&'a Value> {
            match self {
                Kids::Arr(iter) => iter.next(),
                Kids::Obj(iter) => iter.next(),
            }
        }
    }
    fn children(value: &Value) -> Option<Kids<'_>> {
        match value {
            Value::Array(a) => Some(Kids::Arr(a.iter())),
            Value::Object(m) => Some(Kids::Obj(m.values())),
            _ => None,
        }
    }
    let Some(root) = children(value) else {
        return false;
    };
    let mut stack = vec![root];
    while let Some(iter) = stack.last_mut() {
        if let Some(child) = iter.next() {
            if let Some(iter) = children(child) {
                stack.push(iter);
                if stack.len() > omni_ir::deep::SHALLOW_DEPTH {
                    return true;
                }
            }
        } else {
            stack.pop();
        }
    }
    false
}

/// Whether a content block carries client JSON a wire encoder may clone or
/// serialize into recursive temporaries.
pub(crate) fn deep_block(b: &omni_ir::request::ContentBlock) -> bool {
    use omni_ir::request::ContentBlock;
    match b {
        ContentBlock::ToolUse(t) => needs_scope(&t.input),
        ContentBlock::ProviderNative(n) => n.data.values().any(needs_scope),
        ContentBlock::Text(t) => t.citations.iter().flatten().any(needs_scope),
        ContentBlock::ToolResult(t) => t
            .native
            .iter()
            .flatten()
            .any(|n| n.data.values().any(needs_scope)),
        _ => false,
    }
}

/// Whether any carrier of client JSON in this request can reach a recursive
/// clone, serialization or drop inside a wire encoder: tool input schemas and
/// options, provider tool wire maps, vendor bag values (including the
/// response-format schemas read out of them), and the JSON inside message
/// content and system blocks. A superset scan — when in doubt about a
/// carrier, it is included. `true` means the whole synchronous build
/// (including temporary drops) must run inside `omni_ir::deep::scope`.
pub(crate) fn needs_scope_request(req: &ChatRequest) -> bool {
    req.vendor.iter().flat_map(|m| m.values()).any(needs_scope)
        || req.tools.iter().flatten().any(|t| match t {
            omni_ir::request::ToolDef::Portable(t) => {
                needs_scope(&t.input_schema)
                    || t.options.iter().flat_map(|m| m.values()).any(needs_scope)
            }
            omni_ir::request::ToolDef::Provider(t) => t.wire.values().any(needs_scope),
        })
        || req
            .messages
            .iter()
            .flat_map(|m| &m.content)
            .chain(req.system.iter().flatten())
            .any(deep_block)
}

/// `AdapterCredentials`: decrypted, from the in-memory snapshot.
#[derive(Default)]
pub struct Credentials {
    pub access_token: Option<String>,
    pub api_key: Option<String>,
    /// Durable provider-specific state (custom: `origin`, `basePath`, `protocol`).
    pub provider_data: Map<String, Value>,
}
impl Clone for Credentials {
    fn clone(&self) -> Self {
        Self {
            access_token: self.access_token.clone(),
            api_key: self.api_key.clone(),
            provider_data: omni_ir::deep::clone_map(&self.provider_data),
        }
    }
}
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credentials(<redacted>)")
    }
}

impl Drop for Credentials {
    fn drop(&mut self) {
        omni_ir::deep::drop_map_in_place(&mut self.provider_data);
    }
}

/// What a codec is given to build a request (`CodecInput`).
#[derive(Clone, Copy)]
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
impl std::fmt::Debug for CodecInput<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodecInput(<redacted>)")
    }
}

/// `CodecHttpRequest`: everything but who is sending it and when to give up.
#[derive(Clone, PartialEq)]
pub struct CodecHttpRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub body_encoding: Option<BodyEncoding>,
}
impl std::fmt::Debug for CodecHttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodecHttpRequest(<redacted>)")
    }
}

/// `CodecRequest`.
pub struct CodecRequest<S> {
    pub request: CodecHttpRequest,
    pub decode_state: S,
    /// What the request could not express, in `request_logs` vocabulary.
    pub degradations: Vec<String>,
    /// How many client tool names were renamed outbound. A count, never names.
    pub cloaked_tools: Option<u32>,
}
impl<S> std::fmt::Debug for CodecRequest<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodecRequest(<redacted>)")
    }
}

/// `CodecErrorInput`, for [`ProviderCodec::classify_error`].
pub struct CodecErrorInput<'a, S> {
    pub status: u16,
    pub body: &'a str,
    pub headers: &'a Headers,
    pub degradations: &'a [String],
    pub decode_state: &'a S,
    /// The error the host raises if the hook returns `None`.
    pub fallback: &'a GatewayError,
}
impl<S> std::fmt::Debug for CodecErrorInput<'_, S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodecErrorInput(<redacted>)")
    }
}

/// Whether a decoder wants more of the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    /// The decoder returned: read nothing more, emit nothing more.
    Stop,
}

/// Why a decoder stopped with an error, as the host's stream guard sees it.
#[derive(Debug, Clone, PartialEq)]
pub enum DecodeError {
    /// A thrown `GatewayError`: the decoder's own classification (built with
    /// `fail`, say). The host passes it through **unchanged** — not restamped,
    /// not bounded — whether or not events were already emitted.
    Gateway(GatewayError),
    /// Anything else thrown. The host relabels it as
    /// the gateway-authored `UPSTREAM` `"<id> codec decode threw"`; the text
    /// is for debugging and never reaches the caller.
    Throw(&'static str),
}

/// A classified refusal versus an ordinary throw.
#[derive(Debug, Clone, PartialEq)]
pub enum BuildError {
    Gateway(GatewayError),
    Throw,
}

impl From<GatewayError> for BuildError {
    fn from(error: GatewayError) -> Self {
        Self::Gateway(error)
    }
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

    fn try_build_request(
        &self,
        input: &CodecInput<'_>,
    ) -> Result<CodecRequest<Self::State>, BuildError> {
        self.build_request(input).map_err(BuildError::Gateway)
    }

    /// The decoder for a 2xx response.
    fn decoder(&self, state: Self::State, headers: &Headers) -> Box<dyn StreamDecoder>;

    /// A better error than the host's default, for a failed response.
    fn classify_error(&self, _input: &CodecErrorInput<'_, Self::State>) -> Option<GatewayError> {
        None
    }
}
