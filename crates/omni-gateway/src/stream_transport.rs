//! Single-node stream transport. Publishers attach here, never to HTTP dispatch.
use crate::{
    server::{App, Body},
    stream::{self, Ring},
    stream_codec::{self, Codec, Event},
};
use hyper::{Request, Response, body::Incoming};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, watch},
    time::{Duration, Instant},
};

pub struct Hub {
    state: Arc<Mutex<State>>,
    shutdown: watch::Sender<bool>,
    heartbeat_epoch: Instant,
}
impl Default for Hub {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            shutdown: watch::channel(false).0,
            heartbeat_epoch: Instant::now(),
        }
    }
}
#[derive(Default)]
struct State {
    next: u64,
    sockets: HashMap<u64, Entry>,
    ring: Ring,
    declared: HashSet<String>,
    invalidations: HashMap<String, Option<Value>>,
    dropped: u64,
}
struct Entry {
    topics: HashSet<String>,
    queue: VecDeque<String>,
    notify: Arc<Notify>,
}

impl Hub {
    pub fn stats(&self) -> (usize, usize, u64) {
        let state = self.state.lock().expect("stream state");
        (
            state.sockets.len(),
            state.sockets.values().map(|entry| entry.queue.len()).sum(),
            state.dropped,
        )
    }
    /// Leading/trailing latest-value invalidation. No inference hook is installed here.
    pub fn invalidate(&self, topic: &str, keys: Option<Value>) {
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
    }
    /// External sequence is the D4 coordinator seam. Local numbering otherwise.
    pub fn publish(&self, topic: &str, payload: Value, seq: Option<f64>) {
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
    fn message(&self, id: u64, kind: &str, raw: Value) -> Vec<String> {
        let frame = stream::parse_client_frame(&raw);
        if frame.is_null() {
            return vec!["{\"type\":\"error\",\"message\":\"malformed frame\"}".into()];
        }
        let topic = frame["topic"].as_str().expect("parsed topic");
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
            if let Some(e) = state.sockets.get_mut(&id) {
                e.topics.remove(topic);
            }
            None
        } else if topic.starts_with("stream:") && !state.declared.contains(topic) {
            Some("no source")
        } else if let Some(e) = state.sockets.get_mut(&id) {
            if !e.topics.contains(topic) && e.topics.len() >= 256 {
                Some("too many topics")
            } else {
                e.topics.insert(topic.into());
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
            let slice = state.ring.since(topic, since);
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
    for entry in state
        .sockets
        .values_mut()
        .filter(|e| e.topics.contains(topic))
    {
        if entry.queue.len() == 1000 {
            entry.queue.pop_front();
            state.dropped += 1;
        }
        entry.queue.push_back(wire.clone());
        entry.notify.notify_one();
    }
}

// Elysia only JSON-parses a text message whose first character is one of
// these prefixes. Leading whitespace is not stripped by its ws adapter.
fn parse_text(text: &str) -> Value {
    if matches!(text.as_bytes().first(), Some(b'"' | b'/' | b'[' | b'{')) {
        serde_json::from_str(text).unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

pub async fn route(app: Arc<App>, mut req: Request<Incoming>) -> Response<Body> {
    use omni_ir::error::ErrorCode;
    if req
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
    let principal = match principal {
        Ok(Some(p)) => p,
        Ok(None) => return crate::api::error_response(ErrorCode::Auth, "a session is required"),
        Err(_) => return crate::api::error_response(ErrorCode::Internal, "internal error"),
    };
    let Some(key) = req
        .headers()
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
    else {
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
    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        if let Ok(io) = upgrade.await {
            run(
                app,
                hyper_util::rt::TokioIo::new(io),
                principal.kind().as_str(),
                cookie.expect("verified cookie"),
            )
            .await;
        }
    });
    Response::builder()
        .status(101)
        .header("upgrade", "websocket")
        .header("connection", "Upgrade")
        .header("sec-websocket-accept", accept)
        .body(crate::server::full(""))
        .expect("upgrade response")
}

async fn run(
    app: Arc<App>,
    io: hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>,
    kind: &str,
    token: String,
) {
    let hub = &app.stream;
    let notify = Arc::new(Notify::new());
    let id = {
        let mut s = hub.state.lock().expect("stream state");
        s.next += 1;
        let id = s.next;
        s.sockets.insert(
            id,
            Entry {
                topics: HashSet::from(["res:*".into()]),
                queue: VecDeque::new(),
                notify: notify.clone(),
            },
        );
        id
    };
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
    // Frozen starts the registry timer at application construction, not open.
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
        tokio::select! {
            result=async { match validation.as_mut() { Some(v)=>v.await, None=>std::future::pending().await } }=>{
                validation=None;
                if matches!(result,Ok(false)){close=Some((4401,"session expired"));break;}
            }
            _=stop.changed()=>{close=Some((1001,"restart"));break;}
            _=heartbeat.tick()=>{
                // Date.now() has millisecond precision in the frozen registry.
                if last_pong.elapsed().as_millis()>60_000 {close=Some((1001,"pong deadline"));break;}
                if tx.try_send((stream_codec::encode(9,b""),0)).is_err(){close=Some((1001,"ping failed"));break;}
                if validation.is_some() && validation_started.elapsed()>=Duration::from_secs(60) { validation.take().expect("validation").abort(); }
                if validation.is_none(){ let auth=app.clone(); let token=token.clone(); validation_started=Instant::now(); validation=Some(tokio::spawn(async move{ !matches!(auth.admin.verify(&token).await,Ok(None)) })); }
            }
            _=notify.notified()=>{
                let mut state=hub.state.lock().expect("stream state");
                if let Some(e)=state.sockets.get_mut(&id) { while buffered.load(std::sync::atomic::Ordering::Relaxed)<512*1024 { let Some(wire)=e.queue.pop_front() else {break;};let bytes=stream_codec::encode(1,wire.as_bytes());let len=bytes.len();buffered.fetch_add(len,std::sync::atomic::Ordering::Relaxed);if tx.try_send((bytes,len)).is_err(){buffered.fetch_sub(len,std::sync::atomic::Ordering::Relaxed);e.queue.push_front(wire); break;}} }
            }
            read=reader.read(&mut buf)=>{
                let Ok(n)=read else {break;}; if n==0 {break;}
                if let Err(code)=codec.feed(&buf[..n]){close=Some((code,"Received too big message"));break;}
                loop {
                    let event=match codec.next_event(){Ok(Some(e))=>e,Ok(None)=>break,Err(code)=>{close=Some((code,if code==1009 {"Received too big message"} else {""}));break 'connection;}};
                    let wire=match event {
                        Event::Ping(p)=>Some(stream_codec::encode(10,&p)),
                        // Frozen Elysia passes a raw socket to pong(), whereas
                        // routes/stream.ts looks up ws.raw. Thus no registry
                        // pong is recorded, even for a compliant client.
                        Event::Pong(_)=>None,
                        Event::Close(p)=>{drop(tx.send((stream_codec::encode(8,&p),0)).await);break 'connection;},
                        Event::Text(text)=>{for wire in hub.message(id,kind,parse_text(&text)){if tx.send((stream_codec::encode(1,wire.as_bytes()),0)).await.is_err(){break 'connection;}} None},
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
    hub.state.lock().expect("stream state").sockets.remove(&id);
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
    use super::*;
    fn hub() -> Hub {
        let hub = Hub::default();
        hub.state.lock().unwrap().sockets.insert(
            1,
            Entry {
                topics: HashSet::from(["res:*".into()]),
                queue: VecDeque::new(),
                notify: Arc::new(Notify::new()),
            },
        );
        hub
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
                .contains("stream:console")
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
