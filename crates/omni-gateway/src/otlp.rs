//! Span collection and OTLP export. Queue entries are whole encoded traces.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use omni_providers::http::{HttpClient, HttpError, HttpRequest, HttpResponse};
use serde_json::{Value, json};

use crate::telemetry::{Metric, Registry};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, PartialEq, Eq)]
pub struct Traceparent {
    pub trace_id: String,
    pub parent_span_id: String,
    pub sampled: bool,
}

pub fn parse_traceparent(value: &str) -> Option<Traceparent> {
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() < 4
        || parts[..4]
            .iter()
            .zip([2, 32, 16, 2])
            .any(|(p, n)| p.len() != n)
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_hexdigit()))
        || parts[1].bytes().all(|b| b == b'0')
        || parts[2].bytes().all(|b| b == b'0')
    {
        return None;
    }
    Some(Traceparent {
        trace_id: parts[1].to_ascii_lowercase(),
        parent_span_id: parts[2].to_ascii_lowercase(),
        sampled: u8::from_str_radix(parts[3], 16).ok()? & 1 == 1,
    })
}

fn id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// Closed allowlist: never accept a JSON map or upstream error text here.
#[derive(Debug, Default)]
pub struct Attrs {
    pub surface: Option<String>,
    pub requested_model: Option<String>,
    pub api_key_id: Option<String>,
    pub status: Option<i64>,
    pub code: Option<String>,
    pub candidates: Option<usize>,
    pub chosen_provider: Option<String>,
    pub chosen_model: Option<String>,
    pub attempt: Option<u32>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub credential_id: Option<String>,
    pub host: Option<String>,
    pub path: Option<String>,
}

impl Attrs {
    fn encode(&self) -> Vec<Value> {
        let mut out = Vec::new();
        macro_rules! text { ($($k:ident),*) => { $(if let Some(v) = &self.$k { out.push(json!({"key":stringify!($k),"value":{"stringValue":v}})); })* }; }
        macro_rules! number { ($($k:ident),*) => { $(if let Some(v) = self.$k { out.push(json!({"key":stringify!($k),"value":{"intValue":v.to_string()}})); })* }; }
        text!(surface, requested_model, api_key_id);
        if self.host.is_none() {
            number!(status);
        }
        if self.surface.is_some() {
            text!(code);
        }
        number!(candidates);
        text!(chosen_provider, chosen_model);
        number!(attempt);
        text!(provider, model, credential_id, host, path);
        if self.host.is_some() {
            number!(status);
        }
        if self.surface.is_none() {
            text!(code);
        }
        out
    }
}

#[derive(Debug)]
struct Span {
    id: String,
    parent: Option<usize>,
    name: &'static str,
    start: i64,
    end: i64,
    attrs: Attrs,
}

#[derive(Debug)]
pub struct Trace {
    started_at: i64,
    trace_id: String,
    parent: Option<String>,
    spans: Vec<Span>,
    active: Option<usize>,
}

pub type SharedTrace = Arc<Mutex<Trace>>;

impl Trace {
    fn new(started_at: i64, inbound: Option<Traceparent>, surface: &str) -> Self {
        let (trace_id, parent) = inbound.map_or_else(
            || (format!("{}{}", id(), id()), None),
            |p| (p.trace_id, Some(p.parent_span_id)),
        );
        let mut t = Self {
            started_at,
            trace_id,
            parent,
            spans: Vec::new(),
            active: None,
        };
        t.add(
            "gateway.request",
            None,
            started_at,
            started_at,
            Attrs {
                surface: Some(surface.into()),
                ..Attrs::default()
            },
        );
        t
    }

    fn add(
        &mut self,
        name: &'static str,
        parent: Option<usize>,
        start: i64,
        end: i64,
        attrs: Attrs,
    ) -> usize {
        let n = self.spans.len();
        self.spans.push(Span {
            id: id(),
            parent,
            name,
            start,
            end,
            attrs,
        });
        n
    }

    /// Dispatch offsets are relative to dispatch's own startedAt,
    /// then encoded against the outer request trace, unlike HTTP wall time.
    fn dispatch_time(&self, at: i64, origin: i64) -> i64 {
        self.started_at + (at - origin)
    }

    pub fn route(&mut self, origin: i64, start: i64, end: i64, attrs: Attrs) {
        self.add(
            "dispatch.route",
            Some(0),
            self.dispatch_time(start, origin),
            self.dispatch_time(end, origin),
            attrs,
        );
    }

    pub fn attempt(
        trace: &SharedTrace,
        origin: i64,
        at: i64,
        attrs: Attrs,
        now: fn() -> i64,
    ) -> Attempt {
        let mut t = lock(trace);
        let at = t.dispatch_time(at, origin);
        let n = t.add("dispatch.attempt", Some(0), at, at, attrs);
        t.active = Some(n);
        Attempt {
            trace: trace.clone(),
            n,
            now,
            origin,
        }
    }

    pub fn commit(&mut self, origin: i64, at: i64, provider: &str, model: &str) {
        if let Some(parent) = self.active {
            let at = self.dispatch_time(at, origin);
            self.add(
                "stream.commit",
                Some(parent),
                at,
                at,
                Attrs {
                    provider: Some(provider.into()),
                    model: Some(model.into()),
                    ..Attrs::default()
                },
            );
        }
    }

    pub fn encode(&self, version: &str) -> Value {
        let spans: Vec<_> = self.spans.iter().map(|s| {
            let mut v = json!({"traceId":self.trace_id,"spanId":s.id,"name":s.name,
                "startTimeUnixNano":(i128::from(s.start)*1_000_000).to_string(),
                "endTimeUnixNano":(i128::from(s.end)*1_000_000).to_string(),
                "attributes":s.attrs.encode(),"status":{"code":if s.attrs.code.is_some(){2}else{0}}});
            if let Some(parent) = s.parent.and_then(|n| self.spans.get(n).map(|s| &s.id)).or(self.parent.as_ref()) {
                v["parentSpanId"] = json!(parent);
            }
            v
        }).collect();
        json!({"resourceSpans":[{"resource":{"attributes":[
            {"key":"service.name","value":{"stringValue":"omnigateway"}},
            {"key":"service.version","value":{"stringValue":version}}]},"scopeSpans":[{"spans":spans}]}]})
    }
}

pub struct Attempt {
    trace: SharedTrace,
    n: usize,
    now: fn() -> i64,
    origin: i64,
}
impl Attempt {
    pub fn code(&self, code: &str) {
        lock(&self.trace).spans[self.n].attrs.code = Some(code.into());
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        let mut t = lock(&self.trace);
        t.spans[self.n].end = t.dispatch_time((self.now)(), self.origin);
        t.active = None;
    }
}

#[derive(Debug)]
pub struct Tracing {
    traces: Mutex<HashMap<String, SharedTrace>>,
    queue: Mutex<VecDeque<Value>>,
    capacity: usize,
    batch_max: usize,
    endpoint: String,
    headers: Vec<(String, String)>,
    version: String,
    sample: f64,
    registry: Arc<Registry>,
    reporting: Mutex<bool>,
    timer: Mutex<Option<tokio::task::AbortHandle>>,
    client: omni_providers::http::Client,
}

impl Tracing {
    pub fn new(
        endpoint: &str,
        headers: Option<&str>,
        sample: f64,
        version: &str,
        registry: Arc<Registry>,
    ) -> Arc<Self> {
        let mut parsed = vec![("content-type".into(), "application/json".into())];
        for entry in headers.unwrap_or("").split(',') {
            if let Some((key, value)) = entry.split_once('=') {
                let key = key.trim();
                if key.is_empty() {
                    continue;
                }
                if let Some((_, v)) = parsed.iter_mut().find(|(k, _)| k == key) {
                    *v = value.trim().into();
                } else {
                    parsed.push((key.into(), value.trim().into()));
                }
            }
        }
        let t = Arc::new(Self {
            traces: Mutex::default(),
            queue: Mutex::default(),
            capacity: 10_000,
            batch_max: 512,
            endpoint: format!("{}/v1/traces", endpoint.trim_end_matches('/')),
            headers: parsed,
            version: version.into(),
            sample,
            registry,
            reporting: Mutex::new(false),
            timer: Mutex::new(None),
            client: omni_providers::http::Client::new(),
        });
        let weak = Arc::downgrade(&t);
        let timer = tokio::spawn(async move {
            let mut ticks = tokio::time::interval_at(
                tokio::time::Instant::now() + std::time::Duration::from_secs(5),
                std::time::Duration::from_secs(5),
            );
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                let Some(t) = weak.upgrade() else {
                    break;
                };
                // A tick does not wait for a previous flush.
                tokio::spawn(async move {
                    t.flush().await;
                });
            }
        });
        *lock(&t.timer) = Some(timer.abort_handle());
        t
    }

    pub fn start(
        &self,
        request_id: &str,
        at: i64,
        inbound: Option<&str>,
        surface: &str,
        rand: f64,
    ) {
        let inbound = inbound.and_then(parse_traceparent);
        if inbound.as_ref().map_or(rand >= self.sample, |p| !p.sampled) {
            return;
        }
        lock(&self.traces).insert(
            request_id.into(),
            Arc::new(Mutex::new(Trace::new(at, inbound, surface))),
        );
    }

    pub fn get(&self, request_id: &str) -> Option<SharedTrace> {
        lock(&self.traces).get(request_id).cloned()
    }

    pub fn finish(&self, log: &omni_store::writer::RequestLog) {
        let Some(trace) = lock(&self.traces).remove(&log.id) else {
            return;
        };
        let mut t = lock(&trace);
        let end = t.started_at + log.duration_ms;
        let root = &mut t.spans[0];
        root.end = end;
        root.attrs.requested_model = Some(log.requested_model.clone());
        root.attrs.api_key_id = Some(log.api_key_id.clone().unwrap_or_default());
        root.attrs.status = Some(log.status);
        root.attrs.code = log
            .error_code
            .as_ref()
            .filter(|v| {
                v.as_str() == "interrupted"
                    || (!v.is_empty()
                        && v.len() <= 32
                        && v.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
            })
            .cloned();
        self.enqueue(t.encode(&self.version));
    }

    fn enqueue(&self, encoded: Value) {
        let mut queue = lock(&self.queue);
        if queue.len() >= self.capacity {
            self.registry.add(
                Metric::OtlpSpansDroppedTotal,
                &[("reason", "queue_full")],
                1.0,
            );
        } else {
            queue.push_back(encoded);
        }
    }

    async fn flush(&self) {
        let batch: Vec<_> = {
            let mut q = lock(&self.queue);
            let n = q.len().min(self.batch_max);
            q.drain(..n).collect()
        };
        if batch.is_empty() {
            return;
        }
        let resources: Vec<_> = batch
            .into_iter()
            .flat_map(|mut v| {
                v["resourceSpans"]
                    .take()
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .collect();
        let result = self
            .client
            .send(HttpRequest {
                provider: "otlp".into(),
                url: self.endpoint.clone(),
                method: "POST".into(),
                headers: self.headers.clone(),
                body: json!({"resourceSpans":resources}).to_string(),
                body_encoding: None,
                request_id: None,
            })
            .await;
        let ok = result
            .as_ref()
            .is_ok_and(|r| (200..300).contains(&r.status));
        let mut reporting = lock(&self.reporting);
        if !ok && !*reporting {
            tracing::warn!(reason = "collector unavailable", "trace export failed");
        }
        *reporting = !ok;
    }

    pub fn stop(&self) {
        if let Some(timer) = lock(&self.timer).take() {
            timer.abort();
        }
    }
}
impl Drop for Tracing {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Observe only inference sends carrying a registered request id. Refresh and
/// classifier requests without a trace remain outside the parent trace.
pub struct TraceHttp {
    pub inner: Arc<dyn HttpClient>,
    pub traces: Arc<Tracing>,
    pub now: fn() -> i64,
}
impl HttpClient for TraceHttp {
    fn dispatch_scope(&self, request_id: &str) -> Option<Box<dyn Send>> {
        self.inner.dispatch_scope(request_id)
    }
    fn send(
        &self,
        req: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
    > {
        Box::pin(async move {
            let trace = req.request_id.as_deref().and_then(|r| self.traces.get(r));
            let mut guard = trace.and_then(|trace| {
                url::Url::parse(&req.url).ok().map(|url| Head {
                    trace,
                    start: (self.now)(),
                    now: self.now,
                    provider: req.provider.clone(),
                    host: url.host_str().unwrap_or("").to_owned()
                        + &url.port().map_or(String::new(), |p| format!(":{p}")),
                    path: url.path().to_owned(),
                    status: None,
                })
            });
            let result = self.inner.send(req).await;
            if let Some(g) = &mut guard {
                g.status = result.as_ref().ok().map(|r| i64::from(r.status));
            }
            result
        })
    }
}
struct Head {
    trace: SharedTrace,
    start: i64,
    now: fn() -> i64,
    provider: String,
    host: String,
    path: String,
    status: Option<i64>,
}
impl Drop for Head {
    fn drop(&mut self) {
        let mut t = lock(&self.trace);
        let parent = t.active;
        let end = (self.now)().max(t.started_at);
        let start = self.start.max(t.started_at);
        t.add(
            "provider.http",
            parent,
            start,
            end,
            Attrs {
                provider: Some(self.provider.clone()),
                host: Some(self.host.clone()),
                path: Some(self.path.clone()),
                status: self.status,
                ..Attrs::default()
            },
        );
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn sampling_parenting_encoding_and_closed_attrs() {
        let t = Tracing::new(
            "http://127.0.0.1:1///",
            Some("x-test=a=b,ignored"),
            0.0,
            "fixture",
            Arc::new(Registry::new(20.0)),
        );
        let parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        t.start("sampled", 1000, Some(parent), "openai", 1.0);
        t.start("local-off", 1000, None, "openai", 0.0);
        t.start(
            "inbound-off",
            1000,
            Some(&parent.replace("-01", "-00")),
            "openai",
            0.0,
        );
        assert!(t.get("local-off").is_none());
        assert!(t.get("inbound-off").is_none());
        let trace = t.get("sampled").unwrap();
        lock(&trace).route(
            1250,
            1251,
            1252,
            Attrs {
                candidates: Some(1),
                ..Attrs::default()
            },
        );
        let attempt = Trace::attempt(
            &trace,
            1250,
            1252,
            Attrs {
                attempt: Some(1),
                ..Attrs::default()
            },
            || 1260,
        );
        lock(&trace).commit(1250, 1255, "anthropic", "fixture");
        attempt.code("NETWORK");
        drop(attempt);
        let mut log = omni_store::writer::RequestLog::new("sampled", 1000, 200);
        log.duration_ms = 10;
        log.status = 200;
        log.requested_model = "fixture".into();
        t.finish(&log);
        assert!(t.get("sampled").is_none());
        let q = lock(&t.queue);
        let spans = q[0]["resourceSpans"][0]["scopeSpans"][0]["spans"]
            .as_array()
            .unwrap();
        assert_eq!(spans[0]["parentSpanId"], "00f067aa0ba902b7");
        assert_eq!(spans[1]["parentSpanId"], spans[0]["spanId"]);
        assert_eq!(spans[2]["parentSpanId"], spans[0]["spanId"]);
        assert_eq!(spans[3]["parentSpanId"], spans[2]["spanId"]);
        assert_eq!(spans[2]["status"]["code"], 2);
        assert_eq!(spans[0]["startTimeUnixNano"], "1000000000");
        assert_eq!(spans[0]["endTimeUnixNano"], "1010000000");
        assert_eq!(spans[1]["startTimeUnixNano"], "1001000000");
        assert_eq!(spans[1]["endTimeUnixNano"], "1002000000");
        assert_eq!(spans[2]["startTimeUnixNano"], "1002000000");
        assert_eq!(spans[2]["endTimeUnixNano"], "1010000000");
        assert_eq!(spans[3]["startTimeUnixNano"], "1005000000");
        assert_eq!(spans[0]["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(t.endpoint, "http://127.0.0.1:1/v1/traces");
        assert!(t.headers.contains(&("x-test".into(), "a=b".into())));
        t.stop();
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_fifo_failure_discards_and_stop_does_not_drain() {
        let t = Tracing::new(
            "http://127.0.0.1:1",
            None,
            1.0,
            "fixture",
            Arc::new(Registry::new(20.0)),
        );
        t.stop();
        let mut owned = Arc::try_unwrap(t).unwrap();
        owned.capacity = 2;
        owned.batch_max = 1;
        for n in 0..3 {
            owned.enqueue(json!({"resourceSpans":[{"n":n}]}));
        }
        assert_eq!(lock(&owned.queue).len(), 2);
        assert!(owned.registry.render().contains("reason=\"queue_full\"} 1"));
        owned.flush().await;
        assert_eq!(lock(&owned.queue)[0]["resourceSpans"][0]["n"], 1);
        assert!(*lock(&owned.reporting));
        owned.stop();
        assert_eq!(lock(&owned.queue).len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_cancels_periodic_flush_without_draining() {
        let t = Tracing::new(
            "http://127.0.0.1:1",
            None,
            1.0,
            "fixture",
            Arc::new(Registry::new(20.0)),
        );
        t.enqueue(json!({"resourceSpans":[]}));
        t.stop();
        tokio::time::advance(std::time::Duration::from_secs(15)).await;
        tokio::task::yield_now().await;
        assert_eq!(lock(&t.queue).len(), 1);
        assert!(!*lock(&t.reporting));
    }

    #[tokio::test]
    async fn collector_failure_suppression_resets_on_success() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for status in [503, 503, 200] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buf = [0; 4096];
                    let n = socket.read(&mut buf).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(at) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..at]);
                        let length: usize = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= at + 4 + length {
                            break;
                        }
                    }
                }
                socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            }
        });
        let t = Tracing::new(
            &endpoint,
            None,
            1.0,
            "fixture",
            Arc::new(Registry::new(20.0)),
        );
        t.stop();
        for failed in [true, true, false] {
            t.enqueue(json!({"resourceSpans":[]}));
            t.flush().await;
            assert_eq!(*lock(&t.reporting), failed);
            assert!(lock(&t.queue).is_empty());
        }
        server.await.unwrap();
    }

    #[test]
    fn standard_traceparent_and_disabled_fast_path() {
        assert!(parse_traceparent("garbage").is_none());
        assert!(
            parse_traceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01").is_none()
        );
        assert!(
            parse_traceparent("FF-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-03-ab")
                .unwrap()
                .sampled
        );
        let t = crate::telemetry::Telemetry::disabled();
        assert!(t.trace("no-trace").is_none());
        assert!(t.tracing.is_none());
    }
}
