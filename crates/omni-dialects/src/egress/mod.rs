//! IR → client dialect: streaming encoders, buffered renderers, error bodies
//! and rate-limit headers (`apps/gateway/src/egress/*.ts`, and the SSE framing
//! and `Retry-After` rule from `routes/proxy.ts`).
//!
//! # Streaming
//!
//! A [`StreamEncoder`] is fed one [`StreamEvent`] at a time and appends the
//! encoded SSE frames (`event: <name>\ndata: <json>\n\n`, exactly as
//! `sseResponse` writes them) to a caller-owned `String`. The caller reuses
//! that buffer across events: write it to the socket, `clear()` it, push the
//! next event. [`StreamEncoder::finish`] writes whatever TS emits after the
//! upstream stream ends (OpenAI's `[DONE]`, the Responses terminal events).
//!
//! JSON is written with `omni_ir::jsjson` rules directly into the buffer;
//! the payload objects that are themselves carried verbatim (native blocks,
//! vendor bags) go through `jsjson::write_value`.

use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::jsjson::{write_number, write_str};
use omni_ir::stream::StreamEvent;
use omni_ratelimit::{Headroom, HeadroomByDimension};
use serde_json::Value;

pub mod anthropic;
pub mod openai;
pub mod responses;

pub use anthropic::AnthropicStream;
pub use openai::OpenAiStream;
pub use responses::{ResponsesRender, ResponsesStream};

/// One client dialect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Anthropic,
    OpenAi,
    Responses,
}

impl Dialect {
    /// The dialect's error body for `code` (`*ErrorBody`).
    pub fn error_body(self, code: ErrorCode, message: &str) -> Value {
        match self {
            Dialect::Anthropic => anthropic::error_body(code, message),
            Dialect::OpenAi => openai::error_body(code, message),
            Dialect::Responses => responses::error_body(code, message),
        }
    }

    /// The dialect's rate-limit headers, in TS insertion order. `now` is the
    /// instant the request arrived (`startedAt`); Anthropic ignores it.
    pub fn rate_limit_headers(
        self,
        headroom: &HeadroomByDimension,
        now: f64,
    ) -> Vec<(String, String)> {
        match self {
            Dialect::Anthropic => anthropic::rate_limit_headers(headroom),
            Dialect::OpenAi | Dialect::Responses => openai::rate_limit_headers(headroom, now),
        }
    }
}

/// `retryAfterHeaders` (`routes/proxy.ts`): `Retry-After` in whole seconds,
/// rounded up and floored at zero, on a refusal whose status is 429 only.
pub fn retry_after(error: &GatewayError) -> Option<String> {
    let ms = error.retry_after_ms?;
    if error.code.http_status() != 429 {
        return None;
    }
    Some(js_string(js_max0((ms / 1000.0).ceil())))
}

/// An incremental encoder for one response stream.
pub enum StreamEncoder {
    Anthropic(AnthropicStream),
    OpenAi(OpenAiStream),
    Responses(Box<ResponsesStream>),
}

impl StreamEncoder {
    /// Encodes one event, appending its frames (possibly none) to `out`.
    pub fn push(&mut self, event: &StreamEvent, out: &mut String) {
        match self {
            StreamEncoder::Anthropic(e) => e.push(event, out),
            StreamEncoder::OpenAi(e) => e.push(event, out),
            StreamEncoder::Responses(e) => e.push(event, out),
        }
    }

    /// [`Self::push`] for an event the caller no longer needs, which lets an
    /// encoder move what it must retain instead of copying it. **5b's stream
    /// loop should call this.**
    pub fn push_owned(&mut self, event: StreamEvent, out: &mut String) {
        match self {
            StreamEncoder::Responses(e) => e.push_owned(event, out),
            other => other.push(&event, out),
        }
    }

    /// The upstream stream ended: appends the frames TS writes after its loop.
    pub fn finish(&mut self, out: &mut String) {
        match self {
            StreamEncoder::Anthropic(_) => {}
            StreamEncoder::OpenAi(e) => e.finish(out),
            StreamEncoder::Responses(e) => e.finish(out),
        }
    }
}

// ------------------------------------------------------------------ writing helpers

/// Opens one SSE frame; the caller writes the data and then [`end_frame`].
pub(crate) fn begin_frame(event: &str, out: &mut String) {
    out.push_str("event: ");
    out.push_str(event);
    out.push_str("\ndata: ");
}

pub(crate) fn end_frame(out: &mut String) {
    out.push_str("\n\n");
}

/// A JSON object written key by key, `JSON.stringify` style.
pub(crate) struct Obj<'a> {
    out: &'a mut String,
    first: bool,
}

impl<'a> Obj<'a> {
    pub(crate) fn new(out: &'a mut String) -> Obj<'a> {
        out.push('{');
        Obj { out, first: true }
    }

    pub(crate) fn key(&mut self, k: &str) -> &mut String {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        write_str(k, self.out);
        self.out.push(':');
        self.out
    }

    pub(crate) fn str(&mut self, k: &str, v: &str) -> &mut Self {
        let out = self.key(k);
        write_str(v, out);
        self
    }

    pub(crate) fn num(&mut self, k: &str, v: f64) -> &mut Self {
        let out = self.key(k);
        write_number(v, out);
        self
    }

    pub(crate) fn raw(&mut self, k: &str, v: &str) -> &mut Self {
        self.key(k).push_str(v);
        self
    }

    pub(crate) fn close(self) {
        self.out.push('}');
    }

    /// Closes through a `&mut` builder chain.
    pub(crate) fn close_ref(&mut self) {
        self.out.push('}');
    }
}

/// `String(n)` for a JS number.
pub(crate) fn js_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let mut s = String::new();
    write_number(n, &mut s);
    s
}

/// `Math.max(0, x)`.
pub(crate) fn js_max0(x: f64) -> f64 {
    omni_ir::js::max0(x)
}

/// `REPORTED_LIMIT_DIMENSIONS`: requests and tokens, never spend.
pub(crate) fn reported(headroom: &HeadroomByDimension) -> [(&'static str, Option<Headroom>); 2] {
    [("requests", headroom.requests), ("tokens", headroom.tokens)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_string_matches_number_to_string() {
        assert_eq!(js_string(60.0), "60");
        assert_eq!(js_string(1234.5), "1234.5");
        assert_eq!(js_string(1e21), "1e+21");
        assert_eq!(js_string(1e-7), "1e-7");
        assert_eq!(js_string(-0.0), "0");
        assert_eq!(js_string(f64::NAN), "NaN");
    }
}
