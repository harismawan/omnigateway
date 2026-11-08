//! Shared fixtures: a migrated store seeded the way the TS CLI seeds it, a
//! scripted upstream `HttpClient`, and helpers to read rows back.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use omni_gateway::dispatch::Deps;
use omni_gateway::load::{LoadRegistry, Probes};
use omni_gateway_core::snapshot::SnapshotHolder;
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};
use omni_store::SqliteStore;
use omni_store::writer::{Writer, WriterConfig};
use rusqlite::{Connection, params};

pub const ENC: &str = "gateway-test-encryption-key-0123";

/// PBKDF2 at 210 000 rounds is slow in debug builds: derive once.
pub fn key() -> omni_crypto::field::FieldKey {
    static KEY: std::sync::OnceLock<omni_crypto::field::FieldKey> = std::sync::OnceLock::new();
    KEY.get_or_init(|| omni_crypto::field::derive_key(ENC))
        .clone()
}

/// One scripted upstream answer.
#[derive(Clone)]
pub enum Reply {
    /// Status, extra headers, body chunks.
    Http(u16, Vec<(String, String)>, Vec<String>),
    /// Connection refused.
    Refused,
    /// Never answers (a hang).
    Hang,
}

pub fn sse_ok(chunks: usize) -> Reply {
    let mut body = vec![
        "data: {\"id\":\"u1\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n".to_owned(),
    ];
    for _ in 0..chunks {
        body.push("data: {\"id\":\"u1\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi \"}}]}\n\n".into());
    }
    body.push("data: {\"id\":\"u1\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n".into());
    body.push("data: {\"id\":\"u1\",\"model\":\"up\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14}}\n\n".into());
    body.push("data: [DONE]\n\n".into());
    Reply::Http(
        200,
        vec![("content-type".into(), "text/event-stream".into())],
        body,
    )
}

/// Commits (one delta), then the upstream drops mid-stream (no `[DONE]`).
pub fn sse_breaks_after_commit() -> Reply {
    Reply::Http(
        200,
        vec![("content-type".into(), "text/event-stream".into())],
        vec![
            "data: {\"id\":\"u1\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n".into(),
        ],
    )
}

pub fn status(code: u16, body: &str) -> Reply {
    Reply::Http(code, vec![], vec![body.to_owned()])
}

/// Answers each request with the next reply; records every request.
#[derive(Default)]
pub struct Script {
    pub replies: Mutex<VecDeque<Reply>>,
    pub seen: Mutex<Vec<HttpRequest>>,
}

impl Script {
    pub fn new(replies: Vec<Reply>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            seen: Mutex::new(Vec::new()),
        })
    }
    pub fn calls(&self) -> usize {
        self.seen.lock().expect("seen").len()
    }
}

impl HttpClient for Script {
    fn send(
        &self,
        req: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        self.seen.lock().expect("seen").push(req);
        let reply = self.replies.lock().expect("replies").pop_front();
        Box::pin(async move {
            match reply.unwrap_or(Reply::Refused) {
                Reply::Refused => Err(HttpError::Connect(std::io::Error::new(
                    std::io::ErrorKind::ConnectionRefused,
                    "127.0.0.1:9: Connection refused (os error 111)",
                ))),
                Reply::Hang => std::future::pending().await,
                Reply::Http(code, headers, chunks) => {
                    let mut h = Headers::new();
                    for (k, v) in headers {
                        h.append_received(&k, &v);
                    }
                    Ok(HttpResponse {
                        status: code,
                        headers: h,
                        body: ResponseBody::from_chunks(
                            chunks.into_iter().map(Bytes::from).collect(),
                        ),
                    })
                }
            }
        })
    }
}

/// A migrated database with `n` custom credentials and one priority model
/// `m1` whose targets name them in order, at tiers 1..n.
pub struct Fixture {
    pub dir: tempfile::TempDir,
    pub path: PathBuf,
}

pub fn fixture(credentials: &[&str]) -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let store = SqliteStore::open(&path, 0).expect("store");
    drop(store);
    let key = key();
    let c = Connection::open(&path).expect("open");
    let mut targets = Vec::new();
    for (i, id) in credentials.iter().enumerate() {
        c.execute(
            "INSERT INTO credentials (id, provider, label, auth_type, enabled, tier, weight,
                provider_data, api_key, created_at, updated_at)
             VALUES (?,'custom',?,'apiKey',1,1,1,?,?,0,0)",
            params![
                id,
                format!("label-{i}"),
                format!(
                    "{{\"endpointId\":\"e{i}\",\"origin\":\"http://127.0.0.1:9\",\"protocol\":\"chat_completions\"}}"
                ),
                omni_crypto::field::encrypt(&key, "sk-up")
            ],
        )
        .expect("credential");
        targets.push(format!(
            "{{\"provider\":\"custom\",\"endpointId\":\"e{i}\",\"model\":\"up{i}\",\"tier\":{},\"weight\":1,\
             \"costPerMTok\":{{\"input\":1,\"output\":2}},\"capabilities\":{{\"tools\":true,\"images\":true,\"reasoning\":true}}}}",
            i + 1
        ));
    }
    c.execute(
        "INSERT INTO virtual_models (id, targets, strategy) VALUES ('m1', ?, 'priority')",
        params![format!("[{}]", targets.join(","))],
    )
    .expect("model");
    Fixture { dir, path }
}

pub fn set_setting(path: &Path, key: &str, value: &str) {
    let c = Connection::open(path).expect("open");
    let current: String = c
        .query_row("SELECT value FROM settings WHERE key='settings'", [], |r| {
            r.get(0)
        })
        .unwrap_or_else(|_| "{}".into());
    let mut v: serde_json::Value = serde_json::from_str(&current).expect("json");
    v[key] = serde_json::from_str(value).expect("value");
    c.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)",
        params![v.to_string()],
    )
    .expect("setting");
}

pub struct Harness {
    pub deps: Arc<Deps>,
    pub writer: Writer,
    pub script: Arc<Script>,
}

pub fn harness(f: &Fixture, replies: Vec<Reply>) -> Harness {
    let store = SqliteStore::open(&f.path, 0).expect("store");
    let holder = Arc::new(SnapshotHolder::build(&store, key(), 0.0).expect("build"));
    let writer = Writer::spawn(&f.path, WriterConfig::default()).expect("writer");
    let script = Script::new(replies);
    let deps = Arc::new(Deps {
        http: script.clone(),
        writer: writer.handle(),
        holder,
        load: LoadRegistry::new(),
        probes: Probes::new(),
        providers: omni_router::Providers::builtin(),
        health_lock: Mutex::new(()),
        now: omni_gateway::clock::now_ms,
        rand: || 0.0,
    });
    Harness {
        deps,
        writer,
        script,
    }
}

pub fn rows(path: &Path, sql: &str) -> Vec<Vec<String>> {
    use rusqlite::types::ValueRef;
    let c = Connection::open(path).expect("open");
    let mut stmt = c.prepare(sql).expect("prepare");
    let width = stmt.column_count();
    stmt.query_map([], |r| {
        (0..width)
            .map(|i| {
                Ok(match r.get_ref(i)? {
                    ValueRef::Null => "null".to_owned(),
                    ValueRef::Integer(v) => v.to_string(),
                    ValueRef::Real(v) => format!("{v:?}"),
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                    ValueRef::Blob(_) => "blob".into(),
                })
            })
            .collect()
    })
    .expect("query")
    .collect::<Result<_, _>>()
    .expect("rows")
}

pub fn chat(model: &str, stream: bool) -> omni_ir::request::ChatRequest {
    serde_json::from_value(serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
        "stream": stream
    }))
    .expect("request")
}
