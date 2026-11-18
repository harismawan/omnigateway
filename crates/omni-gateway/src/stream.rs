//! Pure `/api/stream` contracts, ported from frozen stream/{protocol,ring,coalescer}.
//! Transport, sources and coordinator integration intentionally live outside these types.

use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

/// JavaScript number rendering and integer-key enumeration are part of the wire.
pub fn encode(value: &Value) -> String {
    let mut out = String::new();
    omni_ir::jsjson::write_value(value, &mut out);
    out
}

pub fn topic_class(topic: &str) -> Option<&'static str> {
    if topic.starts_with("res:") && topic.len() > 4 {
        Some("res")
    } else if topic.starts_with("stream:") && topic.len() > 7 {
        Some("stream")
    } else if topic.strip_prefix("plugin:").is_some_and(|rest| {
        rest.split_once(':')
            .is_some_and(|(id, name)| !id.is_empty() && !name.is_empty())
    }) {
        Some("plugin")
    } else {
        None
    }
}

/// Rust has no plugin channels; every plugin topic is unopened and refused.
pub fn authorised(principal_kind: &str, topic: &str) -> bool {
    match topic_class(topic) {
        None | Some("plugin") => false,
        _ => match principal_kind {
            "admin" | "viewer" => true,
            "client" => matches!(topic, "res:usage" | "res:logs"),
            _ => false,
        },
    }
}

/// Returns null for a refused frame. Object insertion order is the wire order.
pub fn parse_client_frame(raw: &Value) -> Value {
    let Some(raw) = raw.as_object() else {
        return Value::Null;
    };
    if raw.get("id").is_some_and(|id| !id.is_string()) {
        return Value::Null;
    }
    let Some(topic) = raw.get("topic").and_then(Value::as_str) else {
        return Value::Null;
    };
    if topic.encode_utf16().count() > 128 || topic_class(topic).is_none() {
        return Value::Null;
    }
    let mut out = serde_json::Map::new();
    if let Some(id) = raw.get("id") {
        out.insert("id".into(), id.clone());
    }
    out.insert("topic".into(), topic.into());
    let Some(kind) = raw.get("type").and_then(Value::as_str) else {
        return Value::Null;
    };
    if !matches!(kind, "subscribe" | "unsubscribe" | "send") {
        return Value::Null;
    }
    out.insert("type".into(), kind.into());
    if kind == "send" {
        if let Some(payload) = raw.get("payload") {
            out.insert("payload".into(), payload.clone());
        }
    } else if kind == "subscribe"
        && let Some(seq) = raw.get("sinceSeq")
    {
        let Some(n) = seq.as_f64() else {
            return Value::Null;
        };
        if n < 0.0 || !n.is_finite() || n.fract() != 0.0 {
            return Value::Null;
        }
        out.insert("sinceSeq".into(), seq.clone());
    }
    Value::Object(out)
}

#[derive(Default)]
struct Topic {
    seq: f64,
    bytes: usize,
    entries: VecDeque<(f64, Value, usize)>,
}

pub struct Ring {
    frames: usize,
    bytes: usize,
    topics: HashMap<String, Topic>,
}

impl Default for Ring {
    fn default() -> Self {
        Self::new(500, 2 * 1024 * 1024)
    }
}

impl Ring {
    pub fn new(frames: usize, bytes: usize) -> Self {
        Self {
            frames,
            bytes,
            topics: HashMap::new(),
        }
    }

    pub fn push(&mut self, topic: &str, payload: Value, seq: Option<f64>) -> f64 {
        let state = self.topics.entry(topic.into()).or_default();
        if seq.is_some_and(|seq| seq <= state.seq) {
            return state.seq;
        }
        state.seq = seq.unwrap_or(state.seq + 1.0);
        let bytes = encode(&payload).encode_utf16().count();
        state.bytes += bytes;
        state.entries.push_back((state.seq, payload, bytes));
        while state.entries.len() > self.frames
            || (state.bytes > self.bytes && state.entries.len() > 1)
        {
            if let Some((_, _, size)) = state.entries.pop_front() {
                state.bytes -= size;
            } else {
                break;
            }
        }
        state.seq
    }

    pub fn since(&self, topic: &str, since: f64) -> Value {
        let Some(state) = self.topics.get(topic) else {
            return if since == 0.0 {
                json!({"kind":"frames","frames":[]})
            } else {
                json!({"kind":"gap","seq":0})
            };
        };
        if since > state.seq
            || (since != state.seq
                && state
                    .entries
                    .front()
                    .is_none_or(|(seq, _, _)| *seq > since + 1.0))
        {
            return json!({"kind":"gap","seq":seq_json(state.seq)});
        }
        let frames: Vec<Value> = state
            .entries
            .iter()
            .filter(|(seq, _, _)| *seq > since)
            .map(|(seq, payload, _)| json!({"seq":seq_json(*seq),"payload":payload}))
            .collect();
        json!({"kind":"frames","frames":frames})
    }

    pub fn head(&self, topic: &str) -> f64 {
        self.topics.get(topic).map_or(0.0, |s| s.seq)
    }
    pub fn reset(&mut self, topic: &str) {
        if let Some(state) = self.topics.get_mut(topic) {
            state.entries.clear();
            state.bytes = 0;
        }
    }
    pub fn drop_topic(&mut self, topic: &str) {
        self.topics.remove(topic);
    }
}

fn seq_json(seq: f64) -> Value {
    omni_ir::stream::number(seq)
}

struct Pending {
    topic: String,
    payload: Option<Value>,
    due: u64,
}

/// Deterministic clock seam: the transport drives `advance` at the next deadline.
pub struct Coalescer {
    default_floor: u64,
    floors: HashMap<String, u64>,
    last: HashMap<String, u64>,
    pending: Vec<Pending>,
}

impl Coalescer {
    pub fn new(default_floor: u64, floors: HashMap<String, u64>) -> Self {
        Self {
            default_floor,
            floors,
            last: HashMap::new(),
            pending: Vec::new(),
        }
    }
    fn send(&mut self, now: u64, topic: &str, payload: Option<Value>) -> Value {
        self.last.insert(topic.into(), now);
        let mut frame = json!({"at":now,"topic":topic});
        if let Some(payload) = payload {
            frame["payload"] = payload;
        }
        frame
    }
    pub fn emit(&mut self, now: u64, topic: &str, payload: Option<Value>) -> Vec<Value> {
        if let Some(pending) = self.pending.iter_mut().find(|p| p.topic == topic) {
            pending.payload = payload;
            return vec![];
        }
        let floor = self
            .floors
            .get(topic)
            .copied()
            .unwrap_or(self.default_floor);
        let Some(previous) = self.last.get(topic).copied() else {
            return vec![self.send(now, topic, payload)];
        };
        if now.saturating_sub(previous) >= floor {
            return vec![self.send(now, topic, payload)];
        }
        self.pending.push(Pending {
            topic: topic.into(),
            payload,
            due: previous.saturating_add(floor),
        });
        vec![]
    }
    pub fn next_deadline(&self) -> Option<u64> {
        self.pending.iter().map(|p| p.due).min()
    }
    pub fn advance(&mut self, now: u64) -> Vec<Value> {
        let mut out = Vec::new();
        while let Some((i, _)) = self
            .pending
            .iter()
            .enumerate()
            .filter(|(_, p)| p.due <= now)
            .min_by_key(|(_, p)| p.due)
        {
            let pending = self.pending.remove(i);
            // A delayed timer starts the next floor at the observed clock.
            out.push(self.send(now, &pending.topic, pending.payload));
        }
        out
    }
    pub fn flush(&mut self, now: u64) -> Vec<Value> {
        std::mem::take(&mut self.pending)
            .into_iter()
            .map(|p| self.send(now, &p.topic, p.payload))
            .collect()
    }
    pub fn stop(&mut self) {
        self.pending.clear();
        self.last.clear();
    }
}
