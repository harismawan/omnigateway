//! Local socket delivery and fleet fanout. Publishers attach here, never to HTTP dispatch.
use crate::{
    server::{App, Body},
    stream::{self, Ring},
    stream_codec::{self, Codec, Event},
};
use hyper::{Request, Response, body::Incoming};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering::Relaxed},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, watch},
    time::{Duration, Instant},
};

pub struct Hub {
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub console: crate::console::Source,
    pub(crate) console_fleet: Option<crate::console::Fleet>,
    fleet: Option<Fanout>,
    subscribers: [AtomicUsize; RESOURCE_TOPICS.len()],
    state: Arc<Mutex<State>>,
    shutdown: watch::Sender<bool>,
    heartbeat_epoch: Instant,
    outbound: Pending,
    inbound: Pending,
}
impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Hub")
    }
}
impl omni_store::writer::LogObserver for Hub {
    fn committed(&self, logs: usize, finishes: usize) {
        // No allocation, lock or send for an unsubscribed topic. Preserve
        // every call: reducing N calls to one loses the trailing frame.
        if self.fleet.is_some()
            || !self.empty_resource("res:logs")
            || !self.empty_resource("res:usage")
        {
            for _ in 0..logs.saturating_sub(finishes) {
                self.invalidate("res:logs", None);
            }
            for _ in 0..finishes {
                self.invalidate("res:usage", None);
                self.invalidate("res:logs", None);
            }
        }
    }
}
impl Default for Hub {
    fn default() -> Self {
        Self {
            tasks: Mutex::default(),
            console: crate::console::Source::resolve(),
            console_fleet: None,
            fleet: None,
            subscribers: std::array::from_fn(|_| AtomicUsize::new(0)),
            state: Arc::default(),
            shutdown: watch::channel(false).0,
            heartbeat_epoch: Instant::now(),
            outbound: Pending::default(),
            inbound: Pending::default(),
        }
    }
}

impl Hub {
    pub(crate) fn single(node: &str) -> Arc<Self> {
        let mut hub = Self::default();
        hub.console_fleet = Some(crate::console::Fleet::new(
            Arc::new(omni_coord::MemoryCoord::default()),
            node.into(),
            hub.console.clone(),
        ));
        Arc::new(hub)
    }

    pub(crate) fn with_console_fleet(coord: Arc<dyn omni_coord::Coord>, node: &str) -> Arc<Self> {
        let mut hub = Self::default();
        hub.console_fleet = Some(crate::console::Fleet::new(
            coord.clone(),
            node.into(),
            hub.console.clone(),
        ));
        let (tx, mut rx) = tokio::sync::mpsc::channel::<(Value, Option<String>)>(512);
        let fleet_node = node.to_owned();
        let sender = coord.clone();
        let task = tokio::spawn(async move {
            while let Some((wire, seq)) = rx.recv().await {
                let wire = wire.to_string();
                if let Some(seq) = seq {
                    sender.publish_sequenced("broadcast", &wire, &seq).await;
                } else {
                    sender.publish("broadcast", &wire).await;
                }
            }
        });
        let target = Arc::new(std::sync::OnceLock::<std::sync::Weak<Self>>::new());
        let broadcast = coord.subscribe(
            "broadcast",
            Arc::new({
                let target = target.clone();
                move |_, raw| {
                    if let Some(hub) = target.get().and_then(std::sync::Weak::upgrade) {
                        hub.receive(raw);
                    }
                }
            }),
        );
        let reconnected = coord.subscribe(
            omni_coord::RECONNECTED_TOPIC,
            Arc::new({
                let target = target.clone();
                move |_, _| {
                    if let Some(hub) = target.get().and_then(std::sync::Weak::upgrade) {
                        hub.hello();
                    }
                }
            }),
        );
        hub.fleet = Some(Fanout {
            tx,
            task,
            node: fleet_node,
            local: Mutex::default(),
            _broadcast: broadcast,
            _reconnected: reconnected,
        });
        let hub = Arc::new(hub);
        assert!(target.set(Arc::downgrade(&hub)).is_ok());
        hub.hello();
        hub
    }

    fn hello(&self) {
        if let Some(fleet) = &self.fleet {
            fleet.send(json!({"kind":"hello", "nodeId": fleet.node}), None);
        }
    }

    fn receive(&self, raw: &str) {
        let (seq, raw) =
            omni_coord::split_sequenced(raw).map_or((None, raw), |(seq, raw)| (Some(seq), raw));
        let Ok(wire) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        let topic = wire["topic"].as_str().unwrap_or("");
        let payload = || wire.get("payload").cloned().unwrap_or(Value::Null);
        match wire["kind"].as_str() {
            Some("stream") if topic.starts_with("stream:") => {
                if let Some(seq) = seq {
                    #[allow(clippy::cast_precision_loss)]
                    self.deliver_here(topic, payload(), Some(seq as f64));
                }
            }
            Some("res") if topic == "res:*" => self.deliver_here(topic, payload(), None),
            Some("res") if resource_index(topic).is_some() && !self.empty_resource(topic) => {
                let state = self.state.clone();
                coalesce(&self.inbound, topic, payload(), move |topic, payload| {
                    deliver(
                        &mut state.lock().expect("stream state"),
                        topic,
                        payload,
                        None,
                    );
                });
            }
            Some("declare") if topic.starts_with("stream:") => {
                self.state
                    .lock()
                    .expect("stream state")
                    .declared
                    .insert(topic.to_owned());
            }
            Some("hello") => {
                if let Some(fleet) = &self.fleet
                    && wire["nodeId"] != fleet.node
                {
                    for topic in fleet.local.lock().expect("local topics").iter() {
                        fleet.declare(topic);
                    }
                }
            }
            _ => {}
        }
    }
}

type Pending = Arc<Mutex<HashMap<String, Option<Value>>>>;
struct Fanout {
    tx: tokio::sync::mpsc::Sender<(Value, Option<String>)>,
    task: tokio::task::JoinHandle<()>,
    node: String,
    local: Mutex<HashSet<String>>,
    _broadcast: omni_coord::Subscription,
    _reconnected: omni_coord::Subscription,
}
impl Fanout {
    fn send(&self, wire: Value, seq: Option<String>) {
        offer(&self.tx, wire, seq);
    }
    fn declare(&self, topic: &str) {
        self.send(
            json!({"kind":"declare", "topic":topic, "nodeId":self.node}),
            None,
        );
    }
}
impl Drop for Fanout {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn offer(
    tx: &tokio::sync::mpsc::Sender<(Value, Option<String>)>,
    wire: Value,
    seq: Option<String>,
) {
    if tx.try_send((wire, seq)).is_err() {
        tracing::debug!(
            reason = "fanout queue unavailable",
            "stream publish dropped"
        );
    }
}

fn coalesce(
    pending: &Pending,
    topic: &str,
    payload: Value,
    send: impl Fn(&str, Value) + Send + 'static,
) {
    {
        let mut state = pending.lock().expect("pending invalidations");
        if let Some(queued) = state.get_mut(topic) {
            *queued = Some(payload);
            return;
        }
        state.insert(topic.into(), None);
        send(topic, payload);
    }
    let pending = pending.clone();
    let topic = topic.to_owned();
    tokio::spawn(async move {
        let floor = if matches!(topic.as_str(), "res:credentials" | "res:quota") {
            5000
        } else {
            1000
        };
        loop {
            tokio::time::sleep(Duration::from_millis(floor)).await;
            let mut state = pending.lock().expect("pending invalidations");
            if let Some(payload) = state.get_mut(&topic).and_then(Option::take) {
                send(&topic, payload);
            } else {
                state.remove(&topic);
                break;
            }
        }
    });
}
// All resource publisher topics; arbitrary extension topics retain normal delivery.
const RESOURCE_TOPICS: [&str; 8] = [
    "res:credentials",
    "res:quota",
    "res:models",
    "res:keys",
    "res:settings",
    "res:usage",
    "res:logs",
    "res:*",
];
fn resource_index(topic: &str) -> Option<usize> {
    RESOURCE_TOPICS
        .iter()
        .position(|candidate| *candidate == topic)
}
#[derive(Default)]
struct State {
    next: u64,
    sockets: HashMap<u64, Entry>,
    ring: Ring,
    declared: HashSet<String>,
    invalidations: HashMap<String, Option<Value>>,
    dropped: u64,
    dropped_since_report: u64,
}
struct Entry {
    topics: HashSet<Vec<u16>>,
    queue: VecDeque<String>,
    notify: Arc<Notify>,
}

impl Hub {
    #[cfg(test)]
    pub(crate) fn replay_for_test(&self, topic: &str, since: f64) -> Value {
        self.state
            .lock()
            .expect("stream state")
            .ring
            .since(topic, since)
    }
    fn register(&self, notify: Arc<Notify>) -> u64 {
        let mut state = self.state.lock().expect("stream state");
        state.next += 1;
        let id = state.next;
        state.sockets.insert(
            id,
            Entry {
                topics: HashSet::from(["res:*".encode_utf16().collect()]),
                queue: VecDeque::new(),
                notify,
            },
        );
        self.subscribers[resource_index("res:*").expect("global resource")].fetch_add(1, Relaxed);
        id
    }
    fn empty_resource(&self, topic: &str) -> bool {
        resource_index(topic).is_some_and(|index| self.subscribers[index].load(Relaxed) == 0)
    }
    fn remove(&self, id: u64) {
        let mut state = self.state.lock().expect("stream state");
        if let Some(entry) = state.sockets.remove(&id) {
            for topic in entry.topics {
                if let Some(index) = String::from_utf16(&topic)
                    .ok()
                    .as_deref()
                    .and_then(resource_index)
                {
                    self.subscribers[index].fetch_sub(1, Relaxed);
                }
            }
        }
    }
    pub fn stats(&self) -> (usize, usize, u64) {
        let state = self.state.lock().expect("stream state");
        (
            state.sockets.len(),
            state.sockets.values().map(|entry| entry.queue.len()).sum(),
            state.dropped,
        )
    }
    fn report_drops(&self) {
        let count = {
            let mut state = self.state.lock().expect("stream state");
            std::mem::take(&mut state.dropped_since_report)
        };
        if count > 0 {
            tracing::warn!(count, "stream queue overflowed");
        }
    }
    /// Leading/trailing latest-value invalidation; empty resource topics do no work.
    pub fn invalidate(&self, topic: &str, keys: Option<Value>) {
        if let Some(fleet) = &self.fleet {
            let tx = fleet.tx.clone();
            coalesce(
                &self.outbound,
                topic,
                keys.map_or(Value::Null, |keys| json!({"keys":keys})),
                move |topic, payload| {
                    offer(
                        &tx,
                        json!({"kind":"res","topic":topic,"payload":payload}),
                        None,
                    );
                },
            );
            return;
        }
        if self.empty_resource(topic) {
            return;
        }
        let payload = keys.map_or(Value::Null, |keys| json!({"keys":keys}));
        {
            let mut state = self.state.lock().expect("stream state");
            if let Some(pending) = state.invalidations.get_mut(topic) {
                *pending = Some(payload);
                return;
            }
            state.invalidations.insert(topic.into(), None);
        }
        self.publish(topic, payload, None);
        let state = self.state.clone();
        let topic = topic.to_owned();
        tokio::spawn(async move {
            let floor = if matches!(topic.as_str(), "res:credentials" | "res:quota") {
                5000
            } else {
                1000
            };
            loop {
                tokio::time::sleep(Duration::from_millis(floor)).await;
                let mut state = state.lock().expect("stream state");
                let pending = state.invalidations.get_mut(&topic).and_then(Option::take);
                let Some(payload) = pending else {
                    state.invalidations.remove(&topic);
                    break;
                };
                deliver(&mut state, &topic, payload, None);
            }
        });
    }
    pub fn declare(&self, topic: &str) {
        self.state
            .lock()
            .expect("stream state")
            .declared
            .insert(topic.into());
        if let Some(fleet) = &self.fleet {
            fleet
                .local
                .lock()
                .expect("local topics")
                .insert(topic.to_owned());
            fleet.declare(topic);
        }
    }
    /// External sequence is the D4 coordinator seam. Local numbering otherwise.
    pub fn publish(&self, topic: &str, payload: Value, seq: Option<f64>) {
        if let Some(fleet) = &self.fleet
            && seq.is_none()
        {
            let stream = !topic.starts_with("res:");
            fleet.send(
                json!({"kind": if stream {"stream"} else {"res"},"topic":topic,"payload":payload}),
                stream.then(|| format!("seq:{topic}")),
            );
            return;
        }
        self.deliver_here(topic, payload, seq);
    }

    fn deliver_here(&self, topic: &str, payload: Value, seq: Option<f64>) {
        if self.empty_resource(topic) {
            return;
        }
        let mut state = self.state.lock().expect("stream state");
        deliver(&mut state, topic, payload, seq);
    }
    pub fn reset(&self, topic: &str) {
        self.state.lock().expect("stream state").ring.reset(topic);
    }
    pub fn invalidate_all(&self) {
        self.publish("res:*", json!({"keys":[]}), None);
    }
    pub fn stop(&self) {
        self.shutdown.send_replace(true);
    }
    pub async fn drain_connections(&self) {
        // Accepted upgrades outlive hyper's HTTP connection future. Keep them
        // owned until their close frames and writers have actually drained.
        let tasks = std::mem::take(&mut *self.tasks.lock().expect("stream tasks"));
        for task in tasks {
            drop(task.await);
        }
    }
    #[cfg(test)]
    fn message(&self, id: u64, kind: &str, raw: Value) -> Vec<String> {
        self.message_topic(id, kind, raw, None)
    }
    fn message_topic(&self, id: u64, kind: &str, raw: Value, units: Option<&[u16]>) -> Vec<String> {
        let frame = stream::parse_client_frame(&raw);
        if frame.is_null() {
            return vec!["{\"type\":\"error\",\"message\":\"malformed frame\"}".into()];
        }
        let topic = frame["topic"].as_str().expect("parsed topic");
        // Lossless UTF16 is the authoritative registry identity. The scalar
        // projection is used only for ASCII prefix/role checks, never keys or
        // declaration lookup of an ill-formed UTF16 string.
        let key: Vec<u16> = units.map_or_else(|| topic.encode_utf16().collect(), <[u16]>::to_vec);
        let mut result = serde_json::Map::new();
        if let Some(id) = frame.get("id") {
            result.insert("id".into(), id.clone());
        }
        result.insert("type".into(), json!("ack"));
        result.insert("topic".into(), json!(topic));
        let mut state = self.state.lock().expect("stream state");
        let error = if !stream::authorised(kind, topic) {
            Some("not permitted")
        } else if frame["type"] == "send" {
            Some("topic is read-only")
        } else if frame["type"] == "unsubscribe" {
            if let Some(e) = state.sockets.get_mut(&id)
                && e.topics.remove(&key)
                && let Some(index) = resource_index(topic)
            {
                self.subscribers[index].fetch_sub(1, Relaxed);
            }
            None
        } else if topic.starts_with("stream:")
            && (units.is_some() || !state.declared.contains(topic))
        {
            Some("no source")
        } else if let Some(e) = state.sockets.get_mut(&id) {
            if !e.topics.contains(&key) && e.topics.len() >= 256 {
                Some("too many topics")
            } else {
                if e.topics.insert(key)
                    && let Some(index) = resource_index(topic)
                {
                    self.subscribers[index].fetch_add(1, Relaxed);
                }
                None
            }
        } else {
            return vec![];
        };
        if let Some(error) = error {
            result.insert("type".into(), json!("error"));
            result.insert("message".into(), json!(error));
        }
        let mut out = vec![stream::encode(&Value::Object(result))];
        if error.is_none()
            && frame["type"] == "subscribe"
            && let Some(since) = frame["sinceSeq"].as_f64()
        {
            let slice = if units.is_some() {
                // No local publisher can name an ill-formed UTF16 topic through
                // its Rust str API. Its replay is empty, never another topic's
                // projected key. D4 lossless publication remains separate.
                Ring::default().since("", since)
            } else {
                state.ring.since(topic, since)
            };
            if slice["kind"] == "gap" {
                out.push(stream::encode(
                    &json!({"type":"gap","topic":topic,"seq":slice["seq"]}),
                ));
            } else if let Some(frames) = slice["frames"].as_array() {
                for item in frames {
                    out.push(stream::encode(&json!({"type":"event","topic":topic,"seq":item["seq"],"payload":item["payload"]})));
                }
            }
        }
        out
    }
}

fn deliver(state: &mut State, topic: &str, payload: Value, seq: Option<f64>) {
    let frame = if topic.starts_with("res:") {
        if topic == "res:*" || payload.is_null() {
            json!({"type":"event","topic":topic})
        } else {
            json!({"type":"event","topic":topic,"payload":payload})
        }
    } else {
        let seq = state.ring.push(topic, payload.clone(), seq);
        json!({"type":"event","topic":topic,"seq":seq,"payload":payload})
    };
    let wire = stream::encode(&frame);
    let topic_key: Vec<u16> = topic.encode_utf16().collect();
    for entry in state
        .sockets
        .values_mut()
        .filter(|e| e.topics.contains(&topic_key))
    {
        if entry.queue.len() == 1000 {
            entry.queue.pop_front();
            state.dropped += 1;
            state.dropped_since_report += 1;
        }
        entry.queue.push_back(wire.clone());
        entry.notify.notify_one();
    }
}

// The 16 MiB backpressure limit never closes the socket.
// Stop feeding at the registry's lower 512 KiB watermark; never close on it.
fn drain(
    entry: &mut Entry,
    buffered: &std::sync::atomic::AtomicUsize,
    tx: &tokio::sync::mpsc::Sender<(Vec<u8>, usize)>,
) {
    use std::sync::atomic::Ordering::Relaxed;
    while buffered.load(Relaxed) < 512 * 1024 {
        let Some(wire) = entry.queue.pop_front() else {
            break;
        };
        let bytes = stream_codec::encode(1, wire.as_bytes());
        let len = bytes.len();
        buffered.fetch_add(len, Relaxed);
        if tx.try_send((bytes, len)).is_err() {
            buffered.fetch_sub(len, Relaxed);
            entry.queue.push_front(wire);
            break;
        }
    }
}

// A text message is JSON-parsed only when its first character is one of
// these prefixes. Leading whitespace is not stripped.
pub fn parse_text(text: &str) -> Value {
    parse_text_parts(text).0
}
fn parse_text_parts(text: &str) -> (Value, Option<Vec<u16>>, Option<Vec<u16>>) {
    use omni_ir::jsjson::{JsValue, parse_js, stringify};
    if !matches!(text.as_bytes().first(), Some(b'"' | b'/' | b'[' | b'{')) {
        return (Value::Null, None, None);
    }
    let Ok(parsed) = parse_js(text) else {
        return (Value::Null, None, None);
    };
    let JsValue::Object(entries) = &parsed else {
        return (Value::Null, None, None);
    };
    let mut object = serde_json::Map::new();
    let mut id = None;
    let mut topic_units = None;
    for (key, value) in entries {
        let Ok(key) = String::from_utf16(key) else {
            continue;
        };
        if !matches!(key.as_str(), "type" | "topic" | "id" | "sinceSeq") {
            continue;
        }
        if key == "topic" {
            topic_units = None;
        }
        if key == "topic"
            && let JsValue::String(units) = value
        {
            if String::from_utf16(units).is_err() {
                let carrier: String = units
                    .iter()
                    .map(|u| char::from_u32(u32::from(*u)).unwrap_or('x'))
                    .collect();
                object.insert(key, json!(carrier));
                topic_units = Some(units.clone());
                continue;
            }
            topic_units = None;
        }
        if key == "id" {
            id = if let JsValue::String(units) = value {
                Some(units.clone())
            } else {
                None
            };
            if id.is_some() {
                object.insert(key, json!(""));
                continue;
            }
        }
        // Only scalar protocol fields matter. Never serialize discarded deep
        // extras or recursively convert them through serde.
        let scalar = match value {
            JsValue::String(_) | JsValue::Number(_) | JsValue::Bool(_) | JsValue::Null => {
                stringify(value)
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or(Value::Null)
            }
            _ => Value::Null,
        };
        object.insert(key, scalar);
    }
    (Value::Object(object), id, topic_units)
}
impl Hub {
    fn text_message(&self, socket: u64, kind: &str, text: &str) -> Vec<String> {
        let (raw, id, topic) = parse_text_parts(text);
        let mut frames = self.message_topic(socket, kind, raw, topic.as_deref());
        if let Some(topic) = topic {
            for frame in &mut frames {
                if let Ok(mut value) = omni_ir::jsjson::parse_js(frame) {
                    if let omni_ir::jsjson::JsValue::Object(entries) = &mut value {
                        for (key, value) in entries {
                            if key == &"topic".encode_utf16().collect::<Vec<_>>() {
                                *value = omni_ir::jsjson::JsValue::String(topic.clone());
                            }
                        }
                    }
                    *frame = omni_ir::jsjson::stringify(&value).expect("frame JSON");
                }
            }
        }
        if let Some(id) = id
            && let Some(first) = frames.first_mut()
            && first.starts_with("{\"id\":\"\",")
        {
            let mut encoded = String::new();
            omni_ir::jsjson::write_utf16(&id, &mut encoded);
            first.replace_range(6..8, &encoded);
        }
        frames
    }
}

fn upgrade_principal(
    result: Result<Option<crate::admin_auth::Principal>, crate::admin_auth::AuthError>,
) -> Result<crate::admin_auth::Principal, Box<Response<Body>>> {
    use omni_ir::error::ErrorCode;
    match result {
        Ok(Some(p)) => Ok(p),
        Ok(None) => Err(Box::new(crate::api::error_response(
            ErrorCode::Auth,
            "a session is required",
        ))),
        Err(_) => Err(Box::new(crate::api::error_response(
            ErrorCode::Internal,
            "internal error",
        ))),
    }
}

type Revalidate = Arc<
    dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

pub async fn route(app: Arc<App>, mut req: Request<Incoming>) -> Response<Body> {
    use omni_ir::error::ErrorCode;
    if req.method() == hyper::Method::HEAD
        || req
            .headers()
            .get("upgrade")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| !v.eq_ignore_ascii_case("websocket"))
    {
        return crate::api::json(
            426,
            "{\"error\":{\"code\":\"BAD_REQUEST\",\"message\":\"websocket upgrade required\"}}"
                .into(),
            None,
        );
    }
    let cookie = crate::api::read_cookie(req.headers(), crate::admin_auth::ADMIN_COOKIE);
    if cookie.is_some() && req.headers().contains_key("authorization") {
        return crate::api::error_response(ErrorCode::Auth, "present one credential, not two");
    }
    let principal = match cookie.as_ref() {
        Some(token) => app.admin.verify(token).await,
        None => Ok(None),
    };
    let principal = match upgrade_principal(principal) {
        Ok(p) => p,
        Err(response) => return *response,
    };
    let key = req
        .headers()
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok());
    use base64::Engine;
    let key = key.filter(|key| {
        base64::engine::general_purpose::STANDARD
            .decode(key)
            .is_ok_and(|bytes| bytes.len() == 16)
    });
    let Some(key) = key else {
        return Response::builder()
            .status(400)
            .header("content-type", "text/plain;charset=utf-8")
            .body(crate::server::full("Expected a websocket connection"))
            .expect("bad upgrade");
    };
    if req
        .headers()
        .get("sec-websocket-version")
        .is_none_or(|v| v != "13")
    {
        let mut response = Response::builder()
            .status(426)
            .header("sec-websocket-version", "13")
            .header("connection", "close")
            .body(crate::server::full(""))
            .expect("bad version");
        response.extensions_mut().insert(crate::api::NoDate);
        return response;
    }
    let accept = stream_codec::accept(key);
    let protocol = req
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    let upgrade = hyper::upgrade::on(&mut req);
    let hub = app.stream.clone();
    let task = tokio::spawn(async move {
        if let Ok(io) = upgrade.await {
            let auth = app.clone();
            let verify: Revalidate = Arc::new(move |token| {
                let auth = auth.clone();
                Box::pin(async move { !matches!(auth.admin.verify(&token).await, Ok(None)) })
            });
            run(
                &app.stream,
                verify,
                hyper_util::rt::TokioIo::new(io),
                principal.kind().as_str(),
                cookie.expect("verified cookie"),
            )
            .await;
        }
    });
    let mut tasks = hub.tasks.lock().expect("stream tasks");
    tasks.retain(|task| !task.is_finished());
    tasks.push(task);
    let mut response = Response::builder()
        .status(101)
        .header("upgrade", "websocket")
        .header("connection", "Upgrade")
        .header("sec-websocket-accept", accept);
    if let Some(protocol) = protocol {
        response = response.header("sec-websocket-protocol", protocol);
    }
    response
        .body(crate::server::full(""))
        .expect("upgrade response")
}

async fn run(
    hub: &Hub,
    verify: Revalidate,
    io: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    kind: &str,
    token: String,
) {
    let notify = Arc::new(Notify::new());
    let id = hub.register(notify.clone());
    let (mut reader, mut writer) = tokio::io::split(io);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(Vec<u8>, usize)>(1000);
    let buffered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let buffered_writer = buffered.clone();
    let drained = notify.clone();
    let mut writer = tokio::spawn(async move {
        while let Some((bytes, count)) = rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
            buffered_writer.fetch_sub(count, std::sync::atomic::Ordering::Relaxed);
            drained.notify_one();
        }
        drop(writer.shutdown().await);
    });
    let mut codec = Codec::new(stream_codec::MAX_PAYLOAD);
    let mut buf = [0; 8192];
    // The registry timer starts at application construction, not socket open.
    // Every socket therefore shares the same phase, including revalidation.
    let next_tick = hub.heartbeat_epoch
        + Duration::from_secs((hub.heartbeat_epoch.elapsed().as_secs() / 20 + 1) * 20);
    let mut heartbeat = tokio::time::interval_at(next_tick, Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let last_pong = Instant::now();
    let mut stop = hub.shutdown.subscribe();
    let mut validation: Option<tokio::task::JoinHandle<bool>> = None;
    let mut validation_started = Instant::now();
    let mut close = None;
    'connection: loop {
        // subscribe() considers the current watch value seen. An upgrade may
        // finish after shutdown was signalled, so changed() alone misses it.
        if *stop.borrow() {
            close = Some((1001, "restart"));
            break;
        }
        tokio::select! {
            result=async { match validation.as_mut() { Some(v)=>v.await, None=>std::future::pending().await } }=>{
                validation=None;
                if matches!(result,Ok(false)){close=Some((4401,"session expired"));break;}
            }
            _=stop.changed()=>{close=Some((1001,"restart"));break;}
            _=heartbeat.tick()=>{
                hub.report_drops();
                // The pong deadline has millisecond precision.
                if last_pong.elapsed().as_millis()>60_000 {close=Some((1001,"pong deadline"));break;}
                if tx.try_send((stream_codec::encode(9,b""),0)).is_err(){close=Some((1001,"ping failed"));break;}
                if validation.is_some() && validation_started.elapsed()>=Duration::from_secs(60) { validation.take().expect("validation").abort(); }
                if validation.is_none(){ let verify=verify.clone(); let token=token.clone(); validation_started=Instant::now(); validation=Some(tokio::spawn(async move{ verify(token).await })); }
            }
            _=notify.notified()=>{
                let mut state=hub.state.lock().expect("stream state");
                if let Some(e)=state.sockets.get_mut(&id) { drain(e, &buffered, &tx); }
            }
            read=reader.read(&mut buf)=>{
                let Ok(n)=read else {break;}; if n==0 {break;}
                if let Err(code)=codec.feed(&buf[..n]){close=Some((code,"Received too big message"));break;}
                loop {
                    let event=match codec.next_event(){Ok(Some(e))=>e,Ok(None)=>break,Err(code)=>{close=Some((code,if code==1009 {"Received too big message"} else {codec.error_reason}));break 'connection;}};
                    let wire=match event {
                        Event::Ping(p)=>Some(stream_codec::encode(10,&p)),
                        // No registry pong is recorded, even for a compliant
                        // client: the pong path never looks up the registry
                        // entry. A kept wire behavior.
                        Event::Pong(_)=>None,
                        Event::Close(p)=>{drop(tx.send((stream_codec::encode(8,&p),0)).await);break 'connection;},
                        Event::Text(text)=>{for wire in hub.text_message(id,kind,&text){if tx.send((stream_codec::encode(1,wire.as_bytes()),0)).await.is_err(){break 'connection;}} None},
                        Event::Binary(_)=>Some(stream_codec::encode(1,b"{\"type\":\"error\",\"message\":\"malformed frame\"}")),
                    };
                    if let Some(wire)=wire && tx.send((wire,0)).await.is_err(){break 'connection;}
                }
            }
        }
    }
    if let Some(v) = validation {
        v.abort();
    }
    hub.remove(id);
    if let Some((code, reason)) = close {
        let mut payload = code.to_be_bytes().to_vec();
        payload.extend_from_slice(reason.as_bytes());
        drop(tx.try_send((stream_codec::encode(8, &payload), 0)));
    }
    drop(tx);
    if tokio::time::timeout(Duration::from_secs(1), &mut writer)
        .await
        .is_err()
    {
        writer.abort();
        drop(writer.await);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    #[tokio::test]
    async fn fleet_replays_streams_from_both_replicas_with_shared_sequence() {
        let coord: Arc<dyn omni_coord::Coord> =
            Arc::new(omni_coord::MemoryCoord::new(omni_coord::system_clock()));
        let a = Hub::with_console_fleet(coord.clone(), "a");
        let b = Hub::with_console_fleet(coord, "b");
        let topic = "stream:console:a";
        a.declare(topic);
        a.publish(topic, json!("a"), None);
        tokio::time::timeout(Duration::from_secs(1), async {
            while b.replay_for_test(topic, 0.0)["frames"][0]["payload"] != "a" {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("foreign declaration and first stream publish");
        b.publish(topic, json!("b"), None);
        tokio::time::timeout(Duration::from_secs(1), async {
            while a.replay_for_test(topic, 1.0)["frames"][0]["payload"] != "b" {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("second replica advances fleet sequence");
        for hub in [&a, &b] {
            assert!(hub.state.lock().unwrap().declared.contains(topic));
            assert_eq!(
                hub.replay_for_test(topic, 1.0)["frames"][0]["seq"].as_f64(),
                Some(2.0)
            );
        }
    }

    #[tokio::test]
    async fn redis_fleet_hello_redeclares_existing_topics_and_replay_uses_shared_sequence() {
        use omni_coord::{Coord as _, RedisCoord};
        let Ok(url) = std::env::var("OMNI_TEST_REDIS_URL") else {
            return;
        };
        let coord_a = Arc::new(RedisCoord::connect(&url, Default::default()).await.unwrap());
        let node = crate::clock::uuid_v4();
        let topic = format!("stream:console:{node}");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let watched = node.clone();
        let _watch = coord_a.subscribe(
            "broadcast",
            Arc::new(move |_, raw| {
                if let Ok(frame) = serde_json::from_str::<Value>(raw)
                    && frame["kind"] == "declare"
                    && frame["nodeId"] == watched
                {
                    drop(tx.send(frame));
                }
            }),
        );
        let a = Hub::with_console_fleet(coord_a.clone(), &node);
        a.declare(&topic);
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first["topic"], topic);
        // B missed the original declaration. Its hello makes the existing
        // owner resend, so the topic resolves without a local console source.
        let coord_b = Arc::new(RedisCoord::connect(&url, Default::default()).await.unwrap());
        let b = Hub::with_console_fleet(coord_b.clone(), &crate::clock::uuid_v4());
        tokio::time::timeout(Duration::from_secs(2), async {
            while !b.state.lock().unwrap().declared.contains(&topic) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("hello restores the foreign declaration");
        for (publisher, receiver, after, seq, line) in
            [(&a, &b, 0.0, 1.0, "from A"), (&b, &a, 1.0, 2.0, "from B")]
        {
            publisher.publish(&topic, json!(line), None);
            let frame = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let frame = receiver.replay_for_test(&topic, after)["frames"][0].clone();
                    if !frame.is_null() {
                        break frame;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("cross-node Redis stream");
            assert_eq!(frame["payload"], line);
            assert_eq!(frame["seq"].as_f64(), Some(seq));
        }
        drop((a, b));
        coord_a.shutdown().await;
        coord_b.shutdown().await;
    }

    #[tokio::test]
    async fn fleet_redis_reconnect_restores_a_missed_declaration() {
        use omni_coord::{Coord as _, RedisCoord};
        use tokio::net::{TcpListener, TcpStream};
        // Keep this test's fault scoped to B's own sockets. The relay does not
        // inspect Redis traffic or change the disposable server's state.
        let Ok(url) = std::env::var("OMNI_TEST_REDIS_URL") else {
            return;
        };
        if url != "redis://127.0.0.1:6379/0" {
            return;
        }
        let a_coord = Arc::new(RedisCoord::connect(&url, Default::default()).await.unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_url = format!("redis://{}/0", listener.local_addr().unwrap());
        let (cut, mut cuts) = tokio::sync::mpsc::channel::<tokio::sync::oneshot::Sender<()>>(1);
        let (resume, mut resumes) = tokio::sync::oneshot::channel();
        let relay = tokio::spawn(async move {
            let mut links = tokio::task::JoinSet::new();
            let mut paused = false;
            loop {
                tokio::select! {
                    Some(ack) = cuts.recv() => {
                        paused = true;
                        links.shutdown().await;
                        let _sent = ack.send(());
                    }
                    _ = &mut resumes, if paused => paused = false,
                    Ok((mut incoming, _)) = listener.accept(), if !paused => {
                        links.spawn(async move {
                            let mut outgoing = TcpStream::connect("127.0.0.1:6379").await.unwrap();
                            drop(tokio::io::copy_bidirectional(&mut incoming, &mut outgoing).await);
                        });
                    }
                    _ = links.join_next(), if !links.is_empty() => {}
                }
            }
        });
        let b_coord = Arc::new(
            RedisCoord::connect(&relay_url, Default::default())
                .await
                .unwrap(),
        );
        assert!(b_coord.remote().listening());
        let node = crate::clock::uuid_v4();
        let topic = format!("stream:console:{node}");
        let a = Hub::with_console_fleet(a_coord.clone(), &node);
        let peer = crate::clock::uuid_v4();
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let watched = topic.clone();
        let watched_peer = peer.clone();
        let watch = a_coord.subscribe(
            "broadcast",
            Arc::new(move |_, raw| {
                if let Ok(frame) = serde_json::from_str::<Value>(raw) {
                    if frame["kind"] == "hello" && frame["nodeId"] == watched_peer {
                        let _sent = tx.try_send("hello");
                    } else if frame["kind"] == "declare" && frame["topic"] == watched {
                        let _sent = tx.try_send("declare");
                    }
                }
            }),
        );
        let b = Hub::with_console_fleet(b_coord.clone(), &peer);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap(),
            Some("hello")
        );
        let (ack, cut_done) = tokio::sync::oneshot::channel();
        cut.send(ack).await.unwrap();
        cut_done.await.unwrap();
        a.declare(&topic);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap(),
            Some("declare")
        );
        assert!(!b.state.lock().unwrap().declared.contains(&topic));
        let (tx, mut reconnect) = tokio::sync::mpsc::channel(1);
        let observed = b_coord.clone();
        let reconnect_watch = b_coord.subscribe(
            omni_coord::RECONNECTED_TOPIC,
            Arc::new(move |_, _| {
                let _sent = tx.try_send((observed.healthy(), observed.faults()));
            }),
        );
        resume.send(()).unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(2), reconnect.recv())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !b.state.lock().unwrap().declared.contains(&topic) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("B resubscribe must send hello and A redeclare; reconnect={ready:?}, listening={}, healthy={}, faults={}, frames={:?}", b_coord.remote().listening(), b_coord.healthy(), b_coord.faults(), rx.try_recv()));
        drop((watch, reconnect_watch, a, b));
        b_coord.shutdown().await;
        a_coord.shutdown().await;
        relay.abort();
        drop(relay.await);
    }
    #[test]
    fn utf16_registry_keys_do_not_collide() {
        let hub = hub();
        for topic in [r"res:\ud800", r"res:\udc00", "res:�", "res:😀"] {
            let raw = format!(r#"{{"type":"subscribe","topic":"{topic}"}}"#);
            assert!(hub.text_message(1, "admin", &raw)[0].contains("ack"));
        }
        assert_eq!(hub.state.lock().expect("state").sockets[&1].topics.len(), 5);
        hub.text_message(1, "admin", r#"{"type":"unsubscribe","topic":"res:\ud800"}"#);
        let state = hub.state.lock().expect("state");
        assert_eq!(state.sockets[&1].topics.len(), 4);
        assert!(
            state.sockets[&1]
                .topics
                .contains(&vec![114, 101, 115, 58, 0xdc00])
        );
    }
    #[test]
    fn text_id_utf16_roundtrip() {
        let hub = hub();
        assert_eq!(
            hub.text_message(
                1,
                "admin",
                r#"{"type":"subscribe","topic":"res:logs","id":"\ud800"}"#
            ),
            vec![r#"{"id":"\ud800","type":"ack","topic":"res:logs"}"#]
        );
    }
    #[test]
    fn empty_resource_publish_never_locks_even_with_other_subscribers() {
        let hub = hub();
        hub.message(1, "admin", json!({"type":"subscribe","topic":"res:logs"}));
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _guard = hub.state.lock().expect("stream state");
                panic!("poison state to detect any empty-path locking");
            }))
            .is_err()
        );
        hub.invalidate("res:usage", None);
        hub.publish("res:usage", Value::Null, None);
    }
    use super::*;
    #[test]
    fn resource_counts_follow_unique_subscriptions_and_disconnect() {
        let hub = hub();
        for _ in 0..2 {
            hub.message(1, "admin", json!({"type":"subscribe","topic":"res:usage"}));
        }
        let index = resource_index("res:usage").unwrap();
        assert_eq!(hub.subscribers[index].load(Relaxed), 1);
        assert!(hub.empty_resource("res:logs"));
        for _ in 0..2 {
            hub.message(
                1,
                "admin",
                json!({"type":"unsubscribe","topic":"res:usage"}),
            );
        }
        assert!(hub.empty_resource("res:usage"));
        hub.message(1, "admin", json!({"type":"subscribe","topic":"res:usage"}));
        hub.remove(1);
        hub.remove(1);
        assert!(hub.empty_resource("res:usage"));
        assert!(hub.empty_resource("res:*"));
        // Unknown resources and sequenced topics must not lose their semantics.
        assert!(!hub.empty_resource("res:extension"));
        assert!(!hub.empty_resource("stream:console"));
    }
    fn hub() -> Hub {
        let hub = Hub::default();
        assert_eq!(hub.register(Arc::new(Notify::new())), 1);
        hub
    }
    #[tokio::test(start_paused = true)]
    async fn expired_session_upgrade_and_next_shared_heartbeat() {
        use crate::admin_auth::{AdminAuth, Clock, MemoryKv, SessionKv};
        use std::sync::atomic::{AtomicI64, Ordering::SeqCst};
        let dir = tempfile::tempdir().unwrap();
        let store = omni_store::SqliteStore::open(dir.path().join("auth.db"), 0).unwrap();
        let now = Arc::new(AtomicI64::new(1000));
        let clock: Clock = {
            let now = now.clone();
            Arc::new(move || now.load(SeqCst))
        };
        let kv = Arc::new(MemoryKv::new(clock.clone()));
        let auth = Arc::new(AdminAuth::new(store, kv.clone(), clock, 100));
        let key = omni_crypto::session::key("admin", "short");
        kv.set(
            &key,
            "{\"expiresAt\":1100,\"principal\":{\"kind\":\"admin\"}}",
            100,
        )
        .await
        .unwrap();
        assert!(upgrade_principal(auth.verify("short").await).is_ok());
        // A distinct record lets upgrade discover one expiry without deleting
        // the live connection's record before heartbeat discovers its expiry.
        let live_key = omni_crypto::session::key("admin", "live");
        kv.set(
            &live_key,
            "{\"expiresAt\":1100,\"principal\":{\"kind\":\"admin\"}}",
            100,
        )
        .await
        .unwrap();
        let hub = Arc::new(Hub::default());
        tokio::time::advance(Duration::from_secs(7)).await;
        let (io, mut peer) = tokio::io::duplex(4096);
        let verify: Revalidate = {
            let auth = auth.clone();
            Arc::new(move |token| {
                let auth = auth.clone();
                Box::pin(async move { !matches!(auth.verify(&token).await, Ok(None)) })
            })
        };
        let h = hub.clone();
        let task = tokio::spawn(async move { run(&h, verify, io, "admin", "live".into()).await });
        tokio::task::yield_now().await;
        now.store(1100, SeqCst);
        let rejected = upgrade_principal(auth.verify("short").await).err().unwrap();
        assert_eq!(rejected.status(), 401);
        assert_eq!(kv.len(), 1);
        tokio::time::advance(Duration::from_secs(12)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes).await.unwrap();
        task.await.unwrap();
        assert!(kv.is_empty());
        assert_eq!(&bytes[..4], &[0x89, 0, 0x88, 17]);
        assert_eq!(&bytes[4..6], &4401_u16.to_be_bytes());
        assert_eq!(&bytes[6..], b"session expired");
        assert_eq!(hub.stats().0, 0);
    }

    #[tokio::test]
    async fn slow_queue_drops_oldest_counts_and_resumes_without_close() {
        use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
        let hub = hub();
        hub.declare("stream:test");
        hub.message(
            1,
            "admin",
            json!({"type":"subscribe","topic":"stream:test"}),
        );
        for n in 1..=1100 {
            hub.publish("stream:test", json!(n), None);
        }
        assert_eq!(hub.stats(), (1, 1000, 100));
        let buffered = AtomicUsize::new(16 * 1024 * 1024);
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let mut state = hub.state.lock().unwrap();
        let entry = state.sockets.get_mut(&1).unwrap();
        drain(entry, &buffered, &tx);
        assert_eq!(entry.queue.len(), 1000);
        for seq in 101..=1100 {
            buffered.store(0, Relaxed);
            drain(entry, &buffered, &tx);
            let (bytes, _) = rx.try_recv().unwrap();
            assert_eq!(bytes[0], 0x81);
            let offset = if bytes[1] == 126 { 4 } else { 2 };
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes[offset..]).unwrap()["seq"],
                seq
            );
        }
        assert!(entry.queue.is_empty());
        assert_eq!(state.dropped, 100);
        assert_eq!(state.sockets.len(), 1);
        assert!(!*hub.shutdown.borrow());
        assert_eq!(state.dropped_since_report, 100);
        drop(state);
        hub.report_drops();
        hub.report_drops();
        assert_eq!(hub.state.lock().unwrap().dropped_since_report, 0);
        assert_eq!(hub.stats(), (1, 0, 100));
    }
    #[test]
    fn messages_replay_and_caps() {
        let hub = hub();
        assert!(parse_text(" {\"type\":\"subscribe\",\"topic\":\"res:logs\"}").is_null());
        assert!(parse_text("{\"type\":\"subscribe\",\"topic\":\"res:logs\"}").is_object());
        for (raw, kind, error) in [
            (json!(null), "admin", "malformed frame"),
            (
                json!({"type":"subscribe","topic":"stream:console"}),
                "admin",
                "no source",
            ),
            (
                json!({"type":"subscribe","topic":"res:settings"}),
                "client",
                "not permitted",
            ),
            (
                json!({"type":"send","topic":"res:logs"}),
                "admin",
                "topic is read-only",
            ),
        ] {
            assert!(hub.message(1, kind, raw)[0].contains(error));
        }
        hub.declare("stream:console");
        hub.publish("stream:console", json!({"lines":[]}), None);
        let out = hub.message(
            1,
            "viewer",
            json!({"type":"subscribe","topic":"stream:console","sinceSeq":0,"id":"x"}),
        );
        assert_eq!(
            out[0],
            "{\"id\":\"x\",\"type\":\"ack\",\"topic\":\"stream:console\"}"
        );
        assert!(out[1].contains("\"seq\":1"));
        let out = hub.message(
            1,
            "admin",
            json!({"type":"subscribe","topic":"stream:console","sinceSeq":9}),
        );
        assert!(out[1].contains("\"type\":\"gap\""));
        for n in 0..254 {
            assert!(
                hub.message(
                    1,
                    "admin",
                    json!({"type":"subscribe","topic":format!("res:{n}")})
                )[0]
                .contains("ack")
            );
        }
        assert!(
            hub.message(
                1,
                "admin",
                json!({"type":"subscribe","topic":"res:overflow"})
            )[0]
            .contains("too many topics")
        );
        hub.message(
            1,
            "admin",
            json!({"type":"unsubscribe","topic":"stream:console"}),
        );
        assert!(
            !hub.state.lock().unwrap().sockets[&1]
                .topics
                .contains(&"stream:console".encode_utf16().collect::<Vec<_>>())
        );
    }
    #[tokio::test(start_paused = true)]
    async fn bounded_fanout_and_coalescing() {
        let hub = hub();
        hub.message(1, "admin", json!({"type":"subscribe","topic":"res:logs"}));
        hub.invalidate("res:logs", None);
        hub.invalidate("res:logs", Some(json!(["last"])));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(hub.state.lock().unwrap().sockets[&1].queue.len(), 2);
        for _ in 0..1100 {
            hub.invalidate_all();
        }
        assert_eq!(hub.state.lock().unwrap().sockets[&1].queue.len(), 1000);
        hub.stop();
        assert!(*hub.shutdown.borrow());
    }
}
