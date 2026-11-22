//! Request-local capture primitives.
//! No headers enter this API. Collection is opt-in; the route must not create
//! a collector or decorate its transport when any capture gate is closed.
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use omni_ir::jsjson::{JsValue, parse_js};

pub struct CaptureCompletion {
    pub collector: Collector,
    pub sink: FrameSink,
    pub store: Arc<omni_store::Store>,
    pub key: omni_crypto::field::FieldKey,
}

impl CaptureCompletion {
    pub fn frame(&mut self, frame: &str) {
        // onFrame runs before the wire delimiter is appended.
        for frame in frame.split("\n\n") {
            if !frame.is_empty() {
                self.sink.write(frame);
            }
        }
    }

    pub async fn persist(self, log: &omni_store::writer::RequestLog) {
        self.collector.terminate();
        self.collector.settle().await;
        if self.sink.truncated {
            self.collector.truncated();
        }
        let artifact = self.collector.artifact(
            &log.id,
            log.at,
            log.error_code
                .as_deref()
                .map(|code| (code, u16::try_from(log.status).unwrap_or(500))),
        );
        let key = self.key;
        let result = match self.store.as_ref() {
            omni_store::Store::Postgres(store) => {
                store.put_body_artifact(&key, &artifact).await.map(|_| ())
            }
            omni_store::Store::Sqlite { store, .. } => {
                let store = store.clone();
                tokio::task::spawn_blocking(move || {
                    store
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .put_body(&key, &artifact)
                        .map(|_| ())
                })
                .await
                .unwrap_or_else(|e| Err(omni_store::StoreError::Writer(e.to_string())))
            }
        };
        if let Err(error) = result {
            tracing::warn!(requestId = %log.id, reason = %error, "failed to persist request bodies");
        }
    }
}

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
    pending: usize,
    request: JsValue,
    response: JsValue,
    truncated: bool,
    attempts: Vec<Attempt>,
    capture_stream_chunks: bool,
}

/// Shared with independent provider drains and the completion callback. All
/// locks cover only in-memory updates; no network or persistence await holds one.
#[derive(Clone)]
pub struct Collector(
    Arc<Mutex<State>>,
    Arc<tokio::sync::Notify>,
    tokio::sync::watch::Sender<bool>,
);

impl Collector {
    pub fn new(capture_stream_chunks: bool) -> Self {
        Self(
            Arc::new(Mutex::new(State {
                pending: 0,
                request: JsValue::Null,
                response: JsValue::Null,
                truncated: false,
                attempts: Vec::new(),
                capture_stream_chunks,
            })),
            Arc::new(tokio::sync::Notify::new()),
            tokio::sync::watch::channel(false).0,
        )
    }

    fn terminate(&self) {
        self.2.send_replace(true);
    }

    pub async fn settle(&self) {
        // Pending drains can finish before this waiter is created.
        loop {
            let notified = self.1.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.lock().pending == 0 {
                return;
            }
            notified.await;
        }
    }

    pub fn wrap(
        &self,
        inner: Arc<dyn omni_providers::http::HttpClient>,
    ) -> Arc<dyn omni_providers::http::HttpClient> {
        Arc::new(CaptureHttp {
            inner,
            collector: self.clone(),
            request_id: None,
        })
    }

    /// Classifier requests have their own ids and must not enter the parent's
    /// artifact even though screening shares its dependency bundle.
    pub fn wrap_for(
        &self,
        inner: Arc<dyn omni_providers::http::HttpClient>,
        request_id: String,
    ) -> Arc<dyn omni_providers::http::HttpClient> {
        Arc::new(CaptureHttp {
            inner,
            collector: self.clone(),
            request_id: Some(request_id),
        })
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
        // A failed attempt does not flush an incomplete decoder suffix.
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

struct CaptureHttp {
    request_id: Option<String>,
    inner: Arc<dyn omni_providers::http::HttpClient>,
    collector: Collector,
}

struct Observer {
    collector: Collector,
    index: usize,
}

struct DispatchScope(Collector);

impl Drop for DispatchScope {
    fn drop(&mut self) {
        self.0.terminate();
    }
}

impl Drop for Observer {
    fn drop(&mut self) {
        self.collector.lock().pending -= 1;
        self.collector.1.notify_waiters();
    }
}

impl omni_providers::http::BodyObserver for Observer {
    fn cancelled(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let mut signal = self.collector.2.subscribe();
        Box::pin(async move {
            while !*signal.borrow_and_update() {
                if signal.changed().await.is_err() {
                    break;
                }
            }
        })
    }
    fn chunk(&self, bytes: &[u8]) {
        self.collector.chunk(self.index, bytes);
    }
    fn end(&self, failed: bool) {
        self.collector.end(self.index, failed);
    }
    fn text(&self, text: &str) {
        self.collector.text(self.index, text);
    }
}

impl omni_providers::http::HttpClient for CaptureHttp {
    fn dispatch_scope(&self, request_id: &str) -> Option<Box<dyn Send>> {
        if self.request_id.as_ref().is_some_and(|id| id != request_id) {
            return None;
        }
        Some(Box::new(DispatchScope(self.collector.clone())))
    }
    fn send(
        &self,
        req: omni_providers::http::HttpRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        omni_providers::http::HttpResponse,
                        omni_providers::http::HttpError,
                    >,
                > + Send
                + '_,
        >,
    > {
        Box::pin(async move {
            if self
                .request_id
                .as_ref()
                .is_some_and(|id| req.request_id.as_ref() != Some(id))
            {
                return self.inner.send(req).await;
            }
            let index = self.collector.attempt(&req.provider, &req.body);
            let mut response = self.inner.send(req).await?;
            self.collector.lock().pending += 1;
            response.body.observe(Arc::new(Observer {
                collector: self.collector.clone(),
                index,
            }));
            Ok(response)
        })
    }
}
