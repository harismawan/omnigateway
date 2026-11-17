//! Request-local capture primitives, following frozen `bodyCapture.ts`.
//! No headers enter this API. Collection is opt-in; the route must not create
//! a collector or decorate its transport when any capture gate is closed.
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use omni_ir::jsjson::{JsValue, parse_js};

pub const MAX_CAPTURED_BODY_BYTES: usize = 512 * 1024;

fn string(s: &str) -> JsValue {
    JsValue::String(s.encode_utf16().collect())
}

fn object(fields: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    JsValue::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}

fn as_body(s: &[u16]) -> JsValue {
    if s.is_empty() {
        return JsValue::Null;
    }
    String::from_utf16(s)
        .ok()
        .and_then(|s| parse_js(&s).ok())
        .unwrap_or_else(|| JsValue::String(s.to_vec()))
}

fn frames(s: &[u16]) -> JsValue {
    // Split records, not network chunks, preserving lone UTF-16 units.
    let mut normalized = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i..].starts_with(&[13, 10]) {
            i += 1;
        }
        normalized.push(s[i]);
        i += 1;
    }
    let mut result = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i + 1 < normalized.len() {
        if normalized[i..].starts_with(&[10, 10]) {
            if i > start {
                result.push(JsValue::String(normalized[start..i].to_vec()));
            }
            i += 2;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < normalized.len() {
        result.push(JsValue::String(normalized[start..].to_vec()));
    }
    JsValue::Array(result)
}

/// The client sink retains the most recent *writes*, even when a single write
/// exceeds the soft cap. The budget is JS string.length, not UTF-8 bytes.
#[derive(Debug, Default)]
pub struct FrameSink {
    pub frames: Vec<String>,
    pub truncated: bool,
    units: usize,
}

impl FrameSink {
    pub fn write(&mut self, frame: &str) {
        self.units += frame.encode_utf16().count();
        self.frames.push(frame.to_owned());
        while self.units > MAX_CAPTURED_BODY_BYTES && self.frames.len() > 1 {
            self.units -= self.frames.remove(0).encode_utf16().count();
            self.truncated = true;
        }
    }
}

#[derive(Default)]
struct Decoder {
    pending: Vec<u8>,
    started: bool,
}

impl Decoder {
    /// WHATWG's non-fatal UTF-8 streaming decoder, including initial BOM
    /// suppression. An incomplete suffix is held until another chunk or EOF.
    fn decode(&mut self, bytes: &[u8], end: bool, out: &mut Vec<u16>) {
        self.pending.extend_from_slice(bytes);
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(s) => {
                    out.extend(s.encode_utf16());
                    consumed = self.pending.len();
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // This prefix was checked by from_utf8 above.
                    if let Ok(s) = std::str::from_utf8(&self.pending[consumed..consumed + valid]) {
                        out.extend(s.encode_utf16());
                    }
                    consumed += valid;
                    match e.error_len() {
                        Some(n) => {
                            out.push(0xfffd);
                            consumed += n;
                        }
                        None if end => {
                            out.push(0xfffd);
                            consumed = self.pending.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        if !self.started && !out.is_empty() {
            self.started = true;
            if out[0] == 0xfeff {
                out.remove(0);
            }
        }
    }
}

struct Attempt {
    provider: String,
    request: JsValue,
    response: Vec<u16>,
    responded: bool,
    frames: JsValue,
    truncated: bool,
    bytes: usize,
    decoder: Decoder,
}

struct State {
    request: JsValue,
    response: JsValue,
    truncated: bool,
    attempts: Vec<Attempt>,
    capture_stream_chunks: bool,
}

/// Shared with independent provider drains and the completion callback. All
/// locks cover only in-memory updates; no network or persistence await holds one.
#[derive(Clone)]
pub struct Collector(Arc<Mutex<State>>);

impl Collector {
    pub fn new(capture_stream_chunks: bool) -> Self {
        Self(Arc::new(Mutex::new(State {
            request: JsValue::Null,
            response: JsValue::Null,
            truncated: false,
            attempts: Vec::new(),
            capture_stream_chunks,
        })))
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn request(&self, request: JsValue) {
        self.lock().request = request;
    }

    pub fn response(&self, response: JsValue) {
        self.lock().response = response;
    }

    pub fn truncated(&self) {
        self.lock().truncated = true;
    }

    /// Called before transport.send, including every auth retry. A throw still
    /// leaves this request in the story, with a null response.
    pub fn attempt(&self, provider: &str, body: &str) -> usize {
        let units: Vec<_> = body.encode_utf16().collect();
        let truncated = units.len() > MAX_CAPTURED_BODY_BYTES;
        let request = if truncated {
            JsValue::String(units[..MAX_CAPTURED_BODY_BYTES].to_vec())
        } else {
            as_body(&units)
        };
        let mut s = self.lock();
        let index = s.attempts.len();
        s.attempts.push(Attempt {
            provider: provider.to_owned(),
            request,
            response: Vec::new(),
            responded: false,
            frames: JsValue::Null,
            truncated,
            bytes: 0,
            decoder: Decoder::default(),
        });
        index
    }

    /// The buffered transport view: slices code units, then parses the kept
    /// text regardless of whether slicing occurred.
    pub fn text(&self, index: usize, text: &str) {
        let mut s = self.lock();
        let capture_frames = s.capture_stream_chunks;
        let a = &mut s.attempts[index];
        let units: Vec<_> = text.encode_utf16().collect();
        a.responded = true;
        a.truncated |= units.len() > MAX_CAPTURED_BODY_BYTES;
        a.response = units.into_iter().take(MAX_CAPTURED_BODY_BYTES).collect();
        if capture_frames {
            a.frames = frames(&a.response);
        }
    }

    /// Provider tee reader. Once over cap it must KEEP READING the source but
    /// drop bytes here, independently of the adapter's consumption.
    pub fn chunk(&self, index: usize, bytes: &[u8]) {
        let mut s = self.lock();
        let a = &mut s.attempts[index];
        a.responded = true;
        if a.bytes >= MAX_CAPTURED_BODY_BYTES {
            a.truncated = true;
            return;
        }
        a.bytes += bytes.len();
        a.decoder.decode(bytes, false, &mut a.response);
        a.truncated |= a.bytes > MAX_CAPTURED_BODY_BYTES;
    }

    pub fn end(&self, index: usize, failed: bool) {
        let mut s = self.lock();
        let capture_frames = s.capture_stream_chunks;
        let a = &mut s.attempts[index];
        a.truncated |= failed;
        // Frozen catch does not flush an incomplete decoder suffix.
        if !failed {
            a.decoder.decode(&[], true, &mut a.response);
        }
        if capture_frames {
            a.frames = frames(&a.response);
        }
    }

    pub fn artifact(&self, id: &str, at: i64, error: Option<(&str, u16)>) -> JsValue {
        let s = self.lock();
        let attempts = s
            .attempts
            .iter()
            .enumerate()
            .map(|(i, a)| {
                object([
                    ("attempt", JsValue::Number((i + 1) as f64)),
                    ("provider", string(&a.provider)),
                    ("request", a.request.clone()),
                    (
                        "response",
                        if a.responded {
                            as_body(&a.response)
                        } else {
                            JsValue::Null
                        },
                    ),
                    ("streamChunks", a.frames.clone()),
                    ("truncated", JsValue::Bool(a.truncated)),
                ])
            })
            .collect();
        object([
            ("schemaVersion", JsValue::Number(1.0)),
            ("requestId", string(id)),
            ("at", JsValue::Number(at as f64)),
            (
                "client",
                object([
                    ("request", s.request.clone()),
                    ("response", s.response.clone()),
                    ("truncated", JsValue::Bool(s.truncated)),
                ]),
            ),
            ("attempts", JsValue::Array(attempts)),
            (
                "error",
                error.map_or(JsValue::Null, |(code, status)| {
                    object([
                        ("code", string(code)),
                        ("status", JsValue::Number(f64::from(status))),
                    ])
                }),
            ),
        ])
    }
}
