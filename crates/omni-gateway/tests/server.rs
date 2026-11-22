//! The server end to end, in process: a real listener, a real local SSE
//! upstream, every route, exactly-one-row logging, 499 on hang-up,
//! keepalives, the body limit and graceful shutdown.

mod common;

use std::time::Duration;

use common::*;
use omni_gateway::{Options, start};
use omni_gateway_core::config::{LogLevel, load_config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A chat-completions SSE upstream: `mock-c<n>-d<ms>` streams n deltas
/// `ms` apart, as `bench-gateway-upstream.ts` does.
async fn upstream() -> u16 {
    upstream_with_key(None).await
}

async fn upstream_with_key(expected_key: Option<&'static str>) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = l.local_addr().expect("addr").port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = Vec::new();
                loop {
                    let mut chunk = [0u8; 8192];
                    let Ok(n) = s.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    if let Some(key) = expected_key
                        && !text[..end].lines().any(|line| {
                            line.split_once(':').is_some_and(|(name, value)| {
                                name.eq_ignore_ascii_case("authorization")
                                    && value.trim().strip_prefix("Bearer ") == Some(key)
                            })
                        })
                    {
                        drop(s.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await);
                        return;
                    }
                    let len: usize = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if buf.len() < end + 4 + len {
                        continue;
                    }
                    let body = &text[end + 4..end + 4 + len];
                    let model = body
                        .split("\"model\":\"")
                        .nth(1)
                        .and_then(|r| r.split('"').next())
                        .unwrap_or("")
                        .to_owned();
                    if model == "mock-unavailable" {
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        drop(s.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await);
                        return;
                    }
                    let parts: Vec<&str> = model.trim_start_matches("mock-c").split("-d").collect();
                    let chunks: usize = parts.first().and_then(|c| c.parse().ok()).unwrap_or(1);
                    let delay: u64 = parts.get(1).and_then(|c| c.parse().ok()).unwrap_or(0);
                    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
                    if s.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    let send = |d: String| format!("{:x}\r\n{d}\r\n", d.len());
                    let frame = |c: &str| {
                        format!(
                            "data: {{\"id\":\"x\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"{model}\",\"choices\":[{c}]}}\n\n"
                        )
                    };
                    let mut out = send(frame(
                        "{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}",
                    ));
                    for _ in 0..chunks {
                        out.push_str(&send(frame(
                            "{\"index\":0,\"delta\":{\"content\":\"lorem ipsum \"}}",
                        )));
                        if delay > 0 {
                            if s.write_all(out.as_bytes()).await.is_err() {
                                return;
                            }
                            out.clear();
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                    }
                    out.push_str(&send(frame(
                        "{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}",
                    )));
                    out.push_str(&send(format!(
                        "data: {{\"id\":\"x\",\"model\":\"{model}\",\"choices\":[],\"usage\":{{\"prompt_tokens\":64,\"completion_tokens\":{}}}}}\n\n",
                        chunks * 2
                    )));
                    out.push_str(&send("data: [DONE]\n\n".into()));
                    out.push_str("0\r\n\r\n");
                    if s.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                    buf.drain(..end + 4 + len);
                }
            });
        }
    });
    port
}

struct Gw {
    f: Fixture,
    base: String,
    running: Option<omni_gateway::Running>,
    key: String,
}

const KEY: &str = "sk-omni-test-key-plain";

async fn cluster_socket(base: &str, cookie: &str) -> TcpStream {
    let mut socket = TcpStream::connect(base).await.expect("websocket TCP");
    socket.write_all(format!("GET /api/stream HTTP/1.1\r\nHost: {base}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: {cookie}\r\n\r\n").as_bytes()).await.expect("upgrade");
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(socket.read_u8().await.expect("upgrade byte"));
        assert!(head.len() < 8192);
    }
    assert!(head.starts_with(b"HTTP/1.1 101"));
    socket
}

async fn cluster_subscribe(
    socket: &mut TcpStream,
    topic: &str,
    since: Option<u64>,
) -> serde_json::Value {
    let mut text = serde_json::json!({"type":"subscribe", "topic":topic});
    if let Some(seq) = since {
        text["sinceSeq"] = seq.into();
    }
    let text = text.to_string();
    let mask = [1, 2, 3, 4];
    let mut msg = vec![
        0x81,
        0x80 | u8::try_from(text.len()).expect("short payload"),
    ];
    msg.extend(mask);
    msg.extend(text.bytes().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    socket.write_all(&msg).await.expect("subscribe");
    cluster_frame(socket).await
}

async fn cluster_frame(socket: &mut TcpStream) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        assert_eq!(socket.read_u8().await.expect("server frame"), 0x81);
        let n = match socket.read_u8().await.expect("server frame length") {
            n @ 0..=125 => usize::from(n),
            126 => usize::from(socket.read_u16().await.expect("extended frame length")),
            n => panic!("unexpected server frame length tag: {n}"),
        };
        let mut body = vec![0; n];
        socket
            .read_exact(&mut body)
            .await
            .expect("server frame body");
        serde_json::from_slice(&body).expect("websocket JSON")
    })
    .await
    .expect("websocket message deadline")
}

fn add_key(path: &std::path::Path, id: &str, raw: &str, extra: &str, value: &str) {
    let c = rusqlite::Connection::open(path).expect("open");
    c.execute(
        &format!("INSERT INTO api_keys (id, label, prefix, hash, created_at{extra}) VALUES (?,?,?,?,0{value})"),
        rusqlite::params![id, id, omni_crypto::apikey::prefix(raw), omni_crypto::apikey::hash(raw)],
    )
    .expect("key");
}

async fn boot_with(models: &[(&str, &str)], keepalive: Duration) -> Gw {
    boot_opts(
        models,
        Options {
            keepalive,
            stop_deadline: Duration::from_secs(5),
            ..Options::default()
        },
    )
    .await
}

async fn boot_opts(models: &[(&str, &str)], options: Options) -> Gw {
    boot_on(fixture(&["c0"]), models, options, &[]).await
}

/// `boot_opts` on a prepared fixture, with extra environment.
async fn boot_on(
    f: Fixture,
    models: &[(&str, &str)],
    options: Options,
    extra_env: &[(&str, &str)],
) -> Gw {
    let port = upstream().await;
    let c = rusqlite::Connection::open(&f.path).expect("open");
    c.execute(
        "UPDATE credentials SET provider_data=? WHERE id='c0'",
        rusqlite::params![format!(
            "{{\"endpointId\":\"e0\",\"origin\":\"http://127.0.0.1:{port}\",\"protocol\":\"chat_completions\"}}"
        )],
    )
    .expect("origin");
    for (id, up) in models {
        c.execute(
            "INSERT OR REPLACE INTO virtual_models (id, targets, strategy) VALUES (?, ?, 'priority')",
            rusqlite::params![id, format!(
                "[{{\"provider\":\"custom\",\"endpointId\":\"e0\",\"model\":\"{up}\",\"tier\":1,\"weight\":1,\
                 \"costPerMTok\":{{\"input\":1,\"output\":2}},\"capabilities\":{{\"tools\":true,\"images\":true,\"reasoning\":true}}}}]"
            )],
        )
        .expect("model");
    }
    drop(c);
    add_key(&f.path, "kp", KEY, "", "");
    let env: std::collections::HashMap<String, String> = [
        ("OMNI_ENCRYPTION_KEY", ENC),
        ("OMNI_DB_PATH", f.path.to_str().expect("path")),
        ("OMNI_PORT", "1"),
        ("OMNI_DAY_OFFSET_MINUTES", "0"),
    ]
    .into_iter()
    .chain(extra_env.iter().copied())
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    assert_eq!(config.log_level, LogLevel::Info);
    let running = start(config, options).await.expect("start");
    Gw {
        f,
        base: format!("127.0.0.1:{}", running.addr.port()),
        running: Some(running),
        key: KEY.into(),
    }
}

async fn boot() -> Gw {
    boot_with(
        &[("m1", "mock-c3-d0"), ("slow", "mock-c40-d50")],
        Duration::from_secs(10),
    )
    .await
}

#[tokio::test]
async fn cluster_listener_uses_postgres_without_opening_a_sqlite_shadow() {
    let (Ok(pg), Ok(redis)) = (
        std::env::var("OMNI_TEST_DATABASE_URL"),
        std::env::var("OMNI_TEST_REDIS_URL"),
    ) else {
        assert_ne!(std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(), Ok("1"));
        return;
    };
    // Keep the disposable base unchanged and leave this run's database as evidence.
    let admin = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(pg.clone()), 0)
        .await
        .expect("disposable PG fixture");
    let database = format!(
        "d4_listener_{}",
        omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate()).replace('-', "")
    );
    admin
        .client()
        .await
        .expect("admin connection")
        .batch_execute(&format!("CREATE DATABASE {database}"))
        .await
        .expect("fresh database");
    drop(admin);
    let mut url = url::Url::parse(&pg).expect("fixture URL");
    url.set_path(&format!("/{database}"));
    let pg = url.to_string();
    let dir = tempfile::tempdir().expect("private root");
    let path = dir.path().join("no-shadow.db");
    let env = [
        ("OMNI_ENCRYPTION_KEY".into(), ENC.into()),
        ("OMNI_DB_PATH".into(), path.to_str().expect("path").into()),
        ("OMNI_CLUSTER_MODE".into(), "1".into()),
        ("OMNI_DATABASE_URL".into(), pg.clone()),
        ("OMNI_REDIS_URL".into(), redis.clone()),
        ("OMNI_BODY_LOGGING_ALLOWED".into(), "true".into()),
        ("OMNI_METRICS_TOKEN".into(), "d4-private-metrics".into()),
    ]
    .into_iter()
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(
        config.clone(),
        Options {
            stop_deadline: Duration::from_millis(500),
            ..Options::default()
        },
    )
    .await
    .expect("cluster boot");
    let peer = start(config.clone(), Options::default())
        .await
        .expect("peer boot");
    let base = format!("127.0.0.1:{}", running.addr.port());
    let peer_base = format!("127.0.0.1:{}", peer.addr.port());
    let (status, _, response) = call(&base, "GET", "/health", &[], "").await;
    assert_eq!(status, 200);
    let health: serde_json::Value = serde_json::from_str(&response).expect("health JSON");
    assert_eq!(health["mode"], "cluster");
    assert_eq!(health["coord"], "ok");
    assert!(!path.exists(), "cluster created a SQLite shadow");
    let store = omni_store::Store::open(
        omni_store::StoreConfig::Postgres(omni_store::pg::PgConfig::new(&pg)),
        0,
    )
    .await
    .expect("fixture store");
    let store = std::sync::Arc::new(store);
    let (status, headers, response) = call(
        &base,
        "POST",
        "/api/setup",
        &[],
        r#"{"password":"private-test-password"}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let initial = format!(
        "omni_admin={}",
        token_of(&set_cookie(&headers).expect("setup cookie"))
    );
    assert_eq!(
        call(&peer_base, "GET", "/api/nodes", &[("cookie", &initial)], "")
            .await
            .0,
        200
    );
    assert_eq!(
        call(
            &peer_base,
            "POST",
            "/api/setup",
            &[],
            r#"{"password":"another-private-password"}"#
        )
        .await
        .0,
        409
    );
    let (status, headers, response) = call(
        &peer_base,
        "POST",
        "/api/login",
        &[],
        r#"{"password":"private-test-password"}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let cookie = format!(
        "omni_admin={}",
        token_of(&set_cookie(&headers).expect("login cookie"))
    );
    let auth = [("cookie", cookie.as_str())];
    let (status, _, body) = call(&peer_base, "GET", "/api/database", &auth, "").await;
    assert_eq!(status, 200, "PG database overview: {body}");
    let overview: serde_json::Value = serde_json::from_str(&body).expect("overview");
    assert_eq!(overview["engine"], "postgres");
    assert_eq!(overview["location"], omni_store::pg::redacted(&pg));
    assert!(
        overview["stats"]["pageCount"]
            .as_i64()
            .is_some_and(|n| n > 0)
    );
    assert_eq!(overview["freeDiskBytes"], serde_json::Value::Null);
    assert_eq!(overview["fileBytes"], 0);
    assert_eq!(overview["walBytes"], 0);
    let tables = overview["tables"].as_array().expect("tables");
    assert_eq!(
        overview["bodiesBytes"],
        tables
            .iter()
            .find(|t| t["name"] == "request_bodies")
            .expect("bodies table")["bytes"]
    );
    let omni_store::Store::Postgres(primary) = store.as_ref() else {
        panic!("PG fixture")
    };
    let row = omni_store::writer::RequestLog::new("d4-database-bodies", 1, 200);
    let writer = omni_store::writer::Writer::spawn_postgres(primary.clone(), Default::default())
        .expect("writer");
    let writes = writer.handle();
    let [slot] = writes
        .reserve_finishes::<1>()
        .await
        .expect("terminal credit")
        .into_slots();
    assert!(writes.finish(slot, row));
    writer.close().await.expect("seed log");
    primary
        .put_body(
            &omni_crypto::field::derive_key(ENC),
            "d4-database-bodies",
            1,
            "{}",
            false,
        )
        .await
        .expect("seed body");
    for (method, path, payload) in [
        ("GET", "/api/database/snapshots", ""),
        ("DELETE", "/api/database/bodies", ""),
        (
            "PUT",
            "/api/database/retention",
            r#"{"keepLatest":5,"maxAgeDays":42}"#,
        ),
    ] {
        let (status, _, body) = call(&peer_base, method, path, &auth, payload).await;
        let expected = match method {
            "GET" => serde_json::json!({"snapshots":[]}),
            "DELETE" => serde_json::json!({"ok":true,"removed":1,"orphans":0}),
            _ => serde_json::json!({"keepLatest":5.0,"maxAgeDays":42.0}),
        };
        assert_eq!(status, 200, "{method} {path}: {body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).expect("JSON"),
            expected
        );
    }
    let c = primary.client().await.expect("PG fixture connection");
    let row = c.query_one("SELECT EXISTS (SELECT 1 FROM request_logs WHERE id = 'd4-database-bodies'), EXISTS (SELECT 1 FROM request_bodies WHERE request_id = 'd4-database-bodies')", &[]).await.expect("body and log");
    assert_eq!(
        (row.get::<_, bool>(0), row.get::<_, bool>(1)),
        (true, false)
    );
    drop(c);
    let (_, _, body) = call(&base, "GET", "/api/database", &auth, "").await;
    let retention = serde_json::from_str::<serde_json::Value>(&body).expect("overview");
    assert_eq!(retention["retention"]["keepLatest"].as_f64(), Some(5.0));
    assert_eq!(retention["retention"]["maxAgeDays"].as_f64(), Some(42.0));
    let (status, _, response) = call(
        &base,
        "POST",
        "/api/connect/start",
        &auth,
        r#"{"provider":"openai"}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let flow: serde_json::Value = serde_json::from_str(&response).expect("authorization flow");
    let finish =
        serde_json::json!({"flowId":flow["flowId"], "code":"http://127.0.0.1:1/not-a-callback"})
            .to_string();
    let (status, _, response) =
        call(&peer_base, "POST", "/api/connect/finish", &auth, &finish).await;
    assert_eq!(status, 400, "{response}");
    assert!(
        response.contains("callback URL"),
        "peer must validate the shared flow: {response}"
    );
    let (status, _, response) = call(&base, "POST", "/api/connect/finish", &auth, &finish).await;
    assert_eq!(status, 400, "{response}");
    assert!(
        response.contains("unknown or expired"),
        "peer must consume the shared flow: {response}"
    );
    let (status, _, response) = call(&peer_base, "GET", "/api/nodes", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    let report: serde_json::Value = serde_json::from_str(&response).expect("node report");
    let nodes = report["nodes"].as_array().expect("nodes");
    assert!(
        nodes
            .iter()
            .any(|n| n["id"] == health["nodeId"] && n["self"] == false)
    );
    assert_eq!(nodes.iter().filter(|n| n["self"] == true).count(), 1);
    let seen = nodes
        .iter()
        .find(|n| n["id"] == health["nodeId"])
        .expect("first node in peer report")["seenAt"]
        .as_i64()
        .expect("boot heartbeat");
    let heartbeat = tokio::spawn({
        let peer_base = peer_base.clone();
        let cookie = cookie.clone();
        let node = health["nodeId"].clone();
        async move {
            tokio::time::timeout(Duration::from_secs(13), async {
                loop {
                    let (status, _, response) =
                        call(&peer_base, "GET", "/api/nodes", &[("cookie", &cookie)], "").await;
                    assert_eq!(status, 200, "{response}");
                    let report: serde_json::Value =
                        serde_json::from_str(&response).expect("node report");
                    if report["nodes"]
                        .as_array()
                        .expect("node rows")
                        .iter()
                        .any(|n| {
                            n["id"] == node && n["seenAt"].as_i64().is_some_and(|at| at > seen)
                        })
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            })
            .await
            .expect("cluster heartbeat advances after boot");
        }
    });
    let (status, _, response) = call(
        &peer_base,
        "GET",
        "/api/requests/no-such-request/body",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let body: serde_json::Value = serde_json::from_str(&response).expect("body JSON");
    assert_eq!(body["detailState"], "none");
    let (status, _, response) = call(&base, "GET", "/api/settings", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    let mut settings: serde_json::Value = serde_json::from_str(&response).expect("settings JSON");
    settings["settings"]["bodyLoggingEnabled"] = serde_json::json!(true);
    let (status, _, response) = call(
        &base,
        "PUT",
        "/api/settings",
        &auth,
        &settings["settings"].to_string(),
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let api_secret = "d4-private-upstream-key";
    let upstream_port = upstream_with_key(Some(api_secret)).await;
    let create = serde_json::json!({"provider":"custom", "apiKey":api_secret,
        "endpointId":format!("d4-{}", std::process::id()), "endpointLabel":"D4 stub",
        "origin":format!("http://127.0.0.1:{upstream_port}"), "protocol":"chat_completions"})
    .to_string();
    let (status, _, response) = call(&base, "POST", "/api/credentials", &auth, &create).await;
    assert_eq!(status, 200, "{response}");
    assert!(!response.contains(api_secret));
    let credential: serde_json::Value = serde_json::from_str(&response).expect("credential JSON");
    let id = credential["credential"]["id"]
        .as_str()
        .expect("credential id");
    let (status, _, response) = call(&peer_base, "GET", "/api/catalog", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    let catalog: serde_json::Value = serde_json::from_str(&response).expect("provider catalog");
    assert!(
        catalog["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .any(|p| p["id"] == "custom")
    );
    assert!(!response.contains(api_secret));
    let (status, _, response) = call(&peer_base, "GET", "/api/credentials", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    assert!(response.contains(id));
    assert!(!response.contains(api_secret));
    let credential_route = format!("/api/credentials/{id}");
    let (status, _, response) = call(
        &base,
        "PATCH",
        &credential_route,
        &auth,
        r#"{"label":"D4 renamed credential"}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let (status, _, response) = call(&peer_base, "GET", "/api/credentials", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    let rows: serde_json::Value = serde_json::from_str(&response).expect("credentials JSON");
    assert!(
        rows["credentials"]
            .as_array()
            .expect("rows")
            .iter()
            .any(|row| row["id"] == id && row["label"] == "D4 renamed credential")
    );
    let model_id = format!("d4-model-{}", std::process::id());
    let model = serde_json::json!({"id": model_id, "strategy":"priority", "isAlias":false, "targets":[{
        "provider":"custom", "endpointId":format!("d4-{}", std::process::id()), "model":"mock-c3-d0",
        "tier":1,"weight":1,"costPerMTok":{"input":1,"output":2},
        "capabilities":{"tools":true,"images":true,"reasoning":true}
    }]}).to_string();
    let (status, _, response) = call(
        &base,
        "PUT",
        &format!("/api/models/{model_id}"),
        &auth,
        &model,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let (status, _, response) = call(&peer_base, "GET", "/api/models", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    assert!(response.contains(&model_id));
    let (status, _, response) = call(
        &peer_base,
        "POST",
        &format!("/api/models/{model_id}/dry-run"),
        &auth,
        r#"{"tools":true}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let ranking: serde_json::Value = serde_json::from_str(&response).expect("dry-run ranking");
    assert_eq!(ranking["candidates"][0]["credentialId"], id);
    assert!(!response.contains(api_secret));
    let (status, _, response) = call(
        &base,
        "POST",
        "/api/keys",
        &auth,
        r#"{"label":"D4 joint limit","limits":{"requests":{"1m":1}}}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let api_key: serde_json::Value = serde_json::from_str(&response).expect("API key JSON");
    let bearer = format!("Bearer {}", api_key["key"].as_str().expect("raw key"));
    let inference_auth = [("authorization", bearer.as_str())];
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let (a, _, body_a) = call(&base, "GET", "/v1/models", &inference_auth, "").await;
            let (b, _, body_b) = call(&peer_base, "GET", "/v1/models", &inference_auth, "").await;
            if a == 200 && b == 200 && body_a.contains(&model_id) && body_b.contains(&model_id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("routing backstop publishes both snapshots within a second");
    let chat = serde_json::json!({"model": model_id, "messages":[{"role":"user","content":"hi"}]})
        .to_string();
    let (status, _, response) = call(
        &peer_base,
        "POST",
        "/v1/chat/completions",
        &inference_auth,
        &chat,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    assert!(response.contains("lorem ipsum"));
    let success: serde_json::Value = serde_json::from_str(&response).expect("stub response");
    let request_id = success["id"].as_str().expect("request ID");
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let (status, _, response) = call(
                &base,
                "GET",
                &format!("/api/requests/{request_id}/body"),
                &auth,
                "",
            )
            .await;
            assert_eq!(status, 200, "{response}");
            let value: serde_json::Value = serde_json::from_str(&response).expect("body JSON");
            if !value["artifact"].is_null() && value["detailState"] != "none" {
                assert!(response.contains("lorem ipsum") && !response.contains(api_secret));
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("peer reads persisted body capture");
    let (status, _, response) = call(
        &base,
        "POST",
        "/v1/chat/completions",
        &inference_auth,
        &chat,
    )
    .await;
    assert_eq!(status, 429, "{response}");
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let (status, _, response) = call(
                &peer_base,
                "GET",
                &format!("/api/logs?model={model_id}&limit=1"),
                &auth,
                "",
            )
            .await;
            assert_eq!(status, 200, "{response}");
            let page: serde_json::Value = serde_json::from_str(&response).expect("log page");
            if let Some(cursor) = page["nextCursor"].as_str() {
                let newest = &page["logs"][0];
                assert_eq!(newest["requestedModel"], model_id);
                let (s, _, older) = call(
                    &peer_base,
                    "GET",
                    &format!("/api/logs?model={model_id}&limit=1&cursor={cursor}"),
                    &auth,
                    "",
                )
                .await;
                assert_eq!(s, 200, "{older}");
                let older: serde_json::Value = serde_json::from_str(&older).expect("next page");
                assert_ne!(newest["id"], older["logs"][0]["id"]);
                assert_eq!(older["logs"][0]["requestedModel"], model_id);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Postgres writer publishes two log rows");
    let key_id = api_key["id"].as_str().expect("id");
    let (status, _, response) = call(
        &peer_base,
        "GET",
        &format!("/api/usage?apiKeyId={key_id}&groupBy=requestedModel"),
        &auth,
        "",
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let usage: serde_json::Value = serde_json::from_str(&response).expect("usage JSON");
    assert_eq!(usage["rows"][0]["key"], model_id);
    assert_eq!(usage["rows"][0]["requests"], 2);
    assert_eq!(usage["rows"][0]["errors"], 1);
    let (status, _, response) = call(
        &peer_base,
        "GET",
        &format!("/api/logs/export?apiKeyId={key_id}&since=0&until=2000000000000&format=jsonl"),
        &auth,
        "",
    )
    .await;
    assert_eq!(status, 200, "{response}");
    assert_eq!(response.lines().count(), 2);
    let client_login = serde_json::json!({"key": api_key["key"]}).to_string();
    let (status, headers, response) =
        call(&base, "POST", "/api/client/login", &[], &client_login).await;
    assert_eq!(status, 200, "{response}");
    let client_cookie = format!(
        "omni_admin={}",
        token_of(&set_cookie(&headers).expect("client cookie"))
    );
    let (status, _, response) = call(
        &peer_base,
        "GET",
        "/api/client/summary",
        &[("cookie", &client_cookie)],
        "",
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let summary: serde_json::Value = serde_json::from_str(&response).expect("client summary");
    assert_eq!(summary["id"], key_id);
    assert_eq!(summary["dayOffsetMinutes"], 0);
    assert_eq!(summary["limitUsage"][0]["used"], 2);
    let (status, _, response) = call(
        &peer_base,
        "GET",
        "/api/client/logs?apiKeyId=ignored",
        &[("cookie", &client_cookie)],
        "",
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let scoped: serde_json::Value = serde_json::from_str(&response).expect("client logs");
    let logs = scoped["logs"].as_array().expect("rows");
    assert_eq!(logs.len(), 2);
    assert!(
        logs.iter()
            .all(|row| row["requestedModel"] == model_id && row.get("credentialId").is_none())
    );
    let omni_store::Store::Postgres(pg) = store.as_ref() else {
        unreachable!()
    };
    let observed = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_millis(),
    )
    .expect("epoch millis");
    let window = serde_json::json!({"windowType":"daily","used":5,"limit":20,"resetsAt":observed+3_600_000,"windowMs":86_400_000});
    omni_control::quota_ops::save_postgres(pg, id, &[window], observed)
        .await
        .expect("persistent observation");
    for (route, rows) in [
        ("/api/client/quota", "accounts"),
        ("/api/client/quota/history", "samples"),
    ] {
        let (status, _, response) =
            call(&peer_base, "GET", route, &[("cookie", &client_cookie)], "").await;
        assert_eq!(status, 200, "{response}");
        let quota: serde_json::Value = serde_json::from_str(&response).expect("quota JSON");
        let row = quota[rows]
            .as_array()
            .expect("quota rows")
            .iter()
            .find(|row| row["credentialId"] == id)
            .expect("peer reads provider observation");
        assert_eq!(row["usedRatio"].as_f64(), Some(0.25));
        assert!(row.get("limit").is_none() && row.get("used").is_none());
    }
    let failing_model = format!("{model_id}-unavailable");
    let failing_config = model
        .replace(&model_id, &failing_model)
        .replace("mock-c3-d0", "mock-unavailable");
    let (status, _, response) = call(
        &base,
        "PUT",
        &format!("/api/models/{failing_model}"),
        &auth,
        &failing_config,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let (status, _, response) = call(
        &base,
        "POST",
        "/api/keys",
        &auth,
        r#"{"label":"D4 health fixture"}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let key: serde_json::Value = serde_json::from_str(&response).expect("health fixture key");
    let header = format!("Bearer {}", key["key"].as_str().expect("raw key"));
    let request_auth = [("authorization", header.as_str())];
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let (a, b) = tokio::join!(
                call(&base, "GET", "/v1/models", &request_auth, ""),
                call(&peer_base, "GET", "/v1/models", &request_auth, "")
            );
            if a.2.contains(&failing_model) && b.2.contains(&failing_model) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("both snapshots include the failing model");
    let chat = chat.replace(&model_id, &failing_model);
    let (a, b) = tokio::join!(
        call(&base, "POST", "/v1/chat/completions", &request_auth, &chat),
        call(
            &peer_base,
            "POST",
            "/v1/chat/completions",
            &request_auth,
            &chat
        )
    );
    assert!(a.0 >= 500 && b.0 >= 500);
    let omni_store::Store::Postgres(pg) = store.as_ref() else {
        unreachable!()
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let rows = pg.list_health().await.expect("PG health read");
            if rows.iter().any(|r| {
                r.credential_id == id
                    && r.model == "mock-unavailable"
                    && r.consecutive_failures == 2
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both replicas' health mutations accumulate");
    let (status, _, response) = call(&peer_base, "GET", "/api/credentials/health", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    let report: serde_json::Value = serde_json::from_str(&response).expect("health response");
    assert!(
        report["health"]
            .as_array()
            .expect("health rows")
            .iter()
            .any(|r| r["credentialId"] == id && r["consecutiveFailures"] == 2)
    );
    let (status, _, response) = call(
        &peer_base,
        "GET",
        &format!("/api/credentials/quota/history?credentialId={id}"),
        &auth,
        "",
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let report: serde_json::Value =
        serde_json::from_str(&response).expect("quota history response");
    assert_eq!(report["samples"][0]["used"], 5.0);
    assert_eq!(report["gatewayRates"][0]["credentialId"], id);
    use omni_coord::Coord as _;
    let coord = omni_coord::redis::RedisCoord::connect(&redis, Default::default())
        .await
        .expect("probe fixture coord");
    let probe_key = format!("probe:{}", omni_router::health_key(id, "mock-c3-d0"));
    assert_eq!(
        coord
            .gauge_acquire(&probe_key, 10_000, Some("d4-other-attempt"))
            .await
            .expect("hold on another replica"),
        0
    );
    pg.update_health(id, "mock-c3-d0", &|row| {
        let mut row = row.unwrap_or_else(|| omni_router::blank_health(id, "mock-c3-d0"));
        row.breaker_state = omni_store::BreakerState::HalfOpen;
        row
    })
    .await
    .expect("seed half-open pair");
    let probe_model = format!("{model_id}-probe");
    let model = model.replace(&model_id, &probe_model);
    let (status, _, response) = call(
        &base,
        "PUT",
        &format!("/api/models/{probe_model}"),
        &auth,
        &model,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if call(&peer_base, "GET", "/v1/models", &request_auth, "")
                .await
                .2
                .contains(&probe_model)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("peer snapshot includes half-open target");
    let probe_chat = chat.replace(&failing_model, &probe_model);
    let (status, _, response) = call(
        &peer_base,
        "POST",
        "/v1/chat/completions",
        &request_auth,
        &probe_chat,
    )
    .await;
    assert_eq!(status, 503, "held probe must not reach stub: {response}");
    coord
        .gauge_release(&probe_key, Some("d4-other-attempt"))
        .await
        .expect("release peer hold");
    let (status, _, response) = call(
        &peer_base,
        "POST",
        "/v1/chat/completions",
        &request_auth,
        &probe_chat,
    )
    .await;
    assert_eq!(status, 200, "released probe reaches stub: {response}");
    let busy_model = format!("{model_id}-busy");
    let model = model
        .replace(&probe_model, &busy_model)
        .replace("mock-c3-d0", "mock-c40-d50");
    let (status, _, response) = call(
        &base,
        "PUT",
        &format!("/api/models/{busy_model}"),
        &auth,
        &model,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if call(&base, "GET", "/v1/models", &request_auth, "")
                .await
                .2
                .contains(&busy_model)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("busy model published");
    let balanced_model = format!("{model_id}-balanced");
    let mut balanced: serde_json::Value = serde_json::from_str(&model).expect("busy model JSON");
    balanced["id"] = serde_json::json!(balanced_model);
    balanced["strategy"] = serde_json::json!("roundRobin");
    let mut idle_target = balanced["targets"][0].clone();
    idle_target["model"] = serde_json::json!("mock-c1-d0");
    balanced["targets"]
        .as_array_mut()
        .expect("targets")
        .push(idle_target);
    let (status, _, body) = call(
        &base,
        "PUT",
        &format!("/api/models/{balanced_model}"),
        &auth,
        &balanced.to_string(),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let balanced_chat = chat.replace(&failing_model, &balanced_model);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !call(&peer_base, "GET", "/v1/models", &request_auth, "")
            .await
            .2
            .contains(&balanced_model)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("peer sees balanced model");
    let busy_chat = chat.replace(&failing_model, &busy_model);
    let request = call(
        &base,
        "POST",
        "/v1/chat/completions",
        &request_auth,
        &busy_chat,
    );
    let view = omni_cluster_limit::load::LoadView::new();
    let opts = omni_cluster_limit::load::LoadOptions::default();
    let key = omni_router::health_key(id, "mock-c40-d50");
    let observe_load = async {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                omni_cluster_limit::load::refresh(
                    coord.remote(),
                    &view,
                    &omni_coord::system_clock(),
                    &opts,
                )
                .await;
                if view.remote().get(&key) == Some(&1.0) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("fleet load reader sees in-flight HTTP attempt");
        // The standalone publisher and peer refresh on independent ticks.
        // Allow a refresh while the first provider still has ~2s of work.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let (status, _, response) = call(
            &peer_base,
            "POST",
            "/v1/chat/completions",
            &request_auth,
            &balanced_chat,
        )
        .await;
        assert_eq!(status, 200, "{response}");
        let body: serde_json::Value = serde_json::from_str(&response).expect("balanced response");
        assert_eq!(
            body["usage"]["completion_tokens"], 2,
            "peer must select the idle target"
        );
    };
    let ((status, _, response), ()) = tokio::join!(request, observe_load);
    assert_eq!(status, 200, "{response}");
    let (status, _, metrics) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer d4-private-metrics")],
        "",
    )
    .await;
    assert_eq!(status, 200, "{metrics}");
    let counter = |name: &str| {
        metrics
            .lines()
            .find_map(|l| l.strip_prefix(name)?.strip_prefix(' ')?.parse::<u64>().ok())
    };
    assert!(counter("omni_cluster_limiter_redis_calls_total").is_some_and(|n| n >= 1));
    assert!(counter("omni_cluster_load_publishes_total").is_some_and(|n| n >= 1));
    assert_eq!(
        counter("omni_cluster_limiter_local_admissions_total"),
        Some(0)
    );
    let (routing_tx, mut routing_rx) = tokio::sync::mpsc::channel(16);
    let _routing_watch = omni_coord::Coord::subscribe(
        &coord,
        "routing",
        std::sync::Arc::new(move |_, raw| {
            if let Ok(message) = serde_json::from_str::<serde_json::Value>(raw) {
                drop(routing_tx.try_send(message));
            }
        }),
    );
    let mut peer_socket = cluster_socket(&peer_base, &cookie).await;
    assert_eq!(
        cluster_subscribe(&mut peer_socket, "res:keys", None).await["type"],
        "ack"
    );
    let (status, _, response) = call(
        &base,
        "PUT",
        &format!("/api/keys/{key_id}/limits"),
        &auth,
        r#"{"limits":{"concurrency":1}}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let edited: serde_json::Value = serde_json::from_str(&response).expect("edited key");
    let event = cluster_frame(&mut peer_socket).await;
    assert_eq!(event["type"], "event");
    assert_eq!(event["topic"], "res:keys");
    assert!(event.get("seq").is_none());
    drop(peer_socket);
    tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(event) = routing_rx.recv().await {
            if event["change"]["type"] == "key" && event["change"]["id"] == key_id {
                assert_eq!(event["from"], health["nodeId"]);
                assert_eq!(event["change"].as_object().expect("identity only").len(), 2);
                return;
            }
        }
        panic!("routing receiver closed");
    })
    .await
    .expect("committed key edit published identity without credentials or hashes");
    // Complement the real Hub-to-Hub publisher test with the actual HTTP
    // upgrade, fanout and client reconnect/replay path. Use an isolated topic
    // so no global console capture env needs to change in this test process.
    let topic = format!(
        "stream:console:{}",
        health["nodeId"].as_str().expect("node")
    );
    coord
        .remote()
        .publish(
            "broadcast",
            &serde_json::json!({
                "kind":"declare", "topic":topic, "nodeId": health["nodeId"]
            })
            .to_string(),
        )
        .await
        .expect("declare test console topic");
    let mut sockets = [
        cluster_socket(&base, &cookie).await,
        cluster_socket(&peer_base, &cookie).await,
    ];
    for socket in &mut sockets {
        assert_eq!(cluster_subscribe(socket, &topic, None).await["type"], "ack");
    }
    let sequence = format!("seq:{topic}");
    for line in ["fixture line one", "fixture line two"] {
        let seq = coord
            .remote()
            .publish_sequenced(
                "broadcast",
                &serde_json::json!({
                    "kind":"stream", "topic":topic,"payload":{"lines":[line]}
                })
                .to_string(),
                &sequence,
            )
            .await
            .expect("publish fixture line");
        for socket in &mut sockets {
            let frame = cluster_frame(socket).await;
            assert_eq!(frame["topic"], topic);
            assert_eq!(frame["seq"], seq);
            assert_eq!(frame["payload"]["lines"][0], line);
        }
    }
    drop(sockets);
    let mut reconnected = cluster_socket(&peer_base, &cookie).await;
    assert_eq!(
        cluster_subscribe(&mut reconnected, &topic, Some(1)).await["type"],
        "ack"
    );
    let replay = cluster_frame(&mut reconnected).await;
    assert_eq!(replay["seq"], 2);
    assert_eq!(replay["payload"]["lines"][0], "fixture line two");
    drop(reconnected);
    coord.shutdown().await;
    assert_eq!(edited["limitUsage"][0]["dimension"], "concurrency");
    let (status, _, response) =
        call(&base, "DELETE", &format!("/api/keys/{key_id}"), &auth, "").await;
    assert_eq!(status, 200, "{response}");
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if call(&peer_base, "GET", "/v1/models", &inference_auth, "")
                .await
                .0
                == 401
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("revocation reaches peer within one second");
    let (status, _, response) = call(&peer_base, "GET", "/api/console?node=all", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    let console: serde_json::Value = serde_json::from_str(&response).expect("console response");
    assert!(
        console.get("unreachable").is_none_or(|v| v
            .as_array()
            .is_some_and(|ids| !ids.contains(&health["nodeId"]))),
        "{response}"
    );
    let node = health["nodeId"].as_str().expect("node id");
    let (status, _, response) = call(
        &peer_base,
        "GET",
        &format!("/api/console?node={node}"),
        &auth,
        "",
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let addressed: serde_json::Value = serde_json::from_str(&response).expect("remote console");
    assert_ne!(addressed["source"], "fleet");

    heartbeat.await.expect("node heartbeat check");
    // Keep a real response body and its shared slot open while shutting down.
    // A short grace deadline must produce one PG 499 before writer shutdown,
    // then release the slot so the surviving node can admit the same key.
    let (status, _, response) = call(
        &peer_base,
        "POST",
        "/api/keys",
        &auth,
        r#"{"label":"D4 drain fixture","limits":{"concurrency":1,"tokens":{"5h":10000}}}"#,
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let drain_key: serde_json::Value = serde_json::from_str(&response).expect("drain key");
    let drain_id = drain_key["id"].as_str().expect("drain key id");
    let drain_auth = format!("Bearer {}", drain_key["key"].as_str().expect("raw key"));
    let stream = serde_json::json!({"model": busy_model,"stream":true,
        "messages":[{"role":"user","content":"private drain fixture"}]})
    .to_string();
    let mut in_flight = TcpStream::connect(&base).await.expect("open stream");
    in_flight.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: {drain_auth}\r\nContent-Length: {}\r\n\r\n{stream}", stream.len()).as_bytes()).await.expect("submit stream");
    let mut head = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !head.ends_with(b"\r\n\r\n") {
            head.push(in_flight.read_u8().await.expect("stream head"));
            assert!(head.len() < 8192);
        }
    })
    .await
    .expect("warm inference head");
    assert!(head.starts_with(b"HTTP/1.1 200"), "{head:?}");
    let (status, _, response) = call(
        &peer_base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &drain_auth)],
        &stream,
    )
    .await;
    assert_eq!(status, 429, "should share held slot: {response}");

    running.shutdown();
    running.wait().await.expect("ordered cluster shutdown");
    drop(in_flight);
    let rows = pg
        .client()
        .await
        .expect("drain verification")
        .query(
            "SELECT state,status FROM request_logs WHERE api_key_id=$1 AND node_id=$2",
            &[&drain_id, &node],
        )
        .await
        .expect("persisted drain rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, &str>(0), "done");
    assert_eq!(rows[0].get::<_, i32>(1), 499);
    let coord = omni_coord::RedisCoord::connect(&redis, Default::default())
        .await
        .expect("observe warm bucket");
    let bucket = format!("lim:{drain_id}:5h");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs_f64()
        * 1000.0;
    let counts = || async {
        coord
            .remote()
            .buckets_sum(&bucket, 60_000.0, 18_000_000.0, now)
            .await
            .expect("read Redis")
            .expect("already seeded")
    };
    let before = counts().await;
    let pending = format!("d4-boot-recover-{drain_id}");
    pg.client().await.expect("insert fixture").execute("INSERT INTO request_logs (id,at,api_key_id,requested_model,status,duration_ms,state,node_id,input_tokens) VALUES ($1,$2,$3,$4,0,0,'pending','dead-fixture',17)", &[&pending, &observed, &drain_id, &busy_model]).await.expect("abandoned pending row");
    let replacement = start(config, Options::default())
        .await
        .expect("replacement boot");
    let after = counts().await;
    assert_eq!(
        after.requests,
        before.requests + 1.0,
        "boot recovery must debit an existing seed exactly once"
    );
    assert_eq!(after.tokens, before.tokens + 17.0);
    replacement.shutdown();
    replacement.wait().await.expect("replacement drain");
    coord.shutdown().await;
    let (status, _, response) = call(
        &peer_base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &drain_auth)],
        &stream,
    )
    .await;
    assert_eq!(
        status, 200,
        "shutdown must release the shared slot: {response}"
    );
    let (status, _, response) = call(&peer_base, "DELETE", &credential_route, &auth, "").await;
    assert_eq!(status, 200, "{response}");
    let (status, _, response) = call(&peer_base, "GET", "/api/credentials", &auth, "").await;
    assert_eq!(status, 200, "{response}");
    let rows: serde_json::Value = serde_json::from_str(&response).expect("credential list");
    assert!(
        rows["credentials"]
            .as_array()
            .expect("credential rows")
            .iter()
            .all(|row| row["id"] != id)
    );
    let (status, _, _) = call(&peer_base, "POST", "/api/logout", &auth, "").await;
    assert_eq!(status, 200);
    let (status, _, _) = call(&peer_base, "GET", "/api/nodes", &auth, "").await;
    assert_eq!(status, 401);
    peer.shutdown();
    peer.wait().await.expect("peer drain");
}

#[tokio::test]
async fn nonreading_client_deadline_releases_upstream_and_concurrency() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut request = [0; 8192];
        assert!(socket.read(&mut request).await.expect("request") > 0);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .expect("head");
        let record = format!(
            "data: {}\n\n",
            serde_json::json!({"choices":[{"delta":{"content":"x".repeat(16384)}}]})
        );
        let frame = format!("{:x}\r\n{record}\r\n", record.len());
        let mut total = 0;
        loop {
            match tokio::time::timeout(
                Duration::from_millis(100),
                socket.write_all(frame.as_bytes()),
            )
            .await
            {
                Ok(Ok(())) => total += frame.len(),
                Err(_) => break,
                Ok(Err(e)) => panic!("closed before observed backpressure: {e}"),
            }
        }
        assert!(total > 1024 * 1024, "actually filled network buffers");
        blocked_tx.send(total).expect("blocked signal");
        let mut b = [0];
        let closed = tokio::time::timeout(Duration::from_secs(8), socket.read(&mut b))
            .await
            .expect("deadline closed upstream");
        assert!(matches!(closed, Ok(0) | Err(_)));
        closed_tx.send(()).expect("closure signal");
        let (mut next, _) = listener.accept().await.expect("later request admitted");
        assert!(next.read(&mut request).await.expect("next request") > 0);
        next.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\ndata: [DONE]\n\n")
            .await
            .expect("answer");
    });
    let f = fixture(&["c0"]);
    let db = rusqlite::Connection::open(&f.path).expect("db");
    db.execute("UPDATE credentials SET provider_data=?",[format!(r#"{{"endpointId":"e0","origin":"http://127.0.0.1:{port}","protocol":"chat_completions"}}"#)]).expect("origin");
    set_setting(&f.path, "requestDeadlineMs", "3000");
    add_key(&f.path, "kp", KEY, ",limits", ",'{\"concurrency\":1}'");
    let env = [
        ("OMNI_ENCRYPTION_KEY".into(), ENC.into()),
        ("OMNI_DB_PATH".into(), f.path.to_str().expect("path").into()),
        ("OMNI_PORT".into(), "1".into()),
    ]
    .into_iter()
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(config, Options::default()).await.expect("start");
    let base = format!("127.0.0.1:{}", running.addr.port());
    let socket = tokio::net::TcpSocket::new_v4().expect("socket");
    socket
        .set_recv_buffer_size(1024)
        .expect("small receive window");
    let mut client = socket
        .connect(base.parse().expect("address"))
        .await
        .expect("connect");
    let body = r#"{"model":"m1","messages":[{"role":"user","content":"hi"}],"stream":true}"#;
    client.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\nauthorization: Bearer {KEY}\r\ncontent-length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.expect("request");
    tokio::time::timeout(Duration::from_secs(2), blocked_rx)
        .await
        .expect("backpressure before deadline")
        .expect("blocked");
    let headers = [("authorization", format!("Bearer {KEY}"))];
    let auth = [(headers[0].0, headers[0].1.as_str())];
    let (status, _, _) = call(&base, "POST", "/v1/chat/completions", &auth, body).await;
    assert_eq!(status, 429, "concurrency held before deadline");
    closed_rx
        .await
        .expect("upstream closure with client still unread");
    let (status, _, response) = call(&base, "POST", "/v1/chat/completions", &auth, body).await;
    assert_eq!(status, 200, "admission/load released: {response}");
    upstream.await.expect("upstream");
    drop(client);
    running.shutdown();
    running.wait().await.expect("shutdown joins owned pump");
}

#[tokio::test]
async fn exhausted_persisted_budget_rejects_first_request_after_boot() {
    let f = fixture(&["c0"]);
    add_key(&f.path, "kp", KEY, ",limits", ",'{\"tokens\":{\"5h\":1}}'");
    let db = rusqlite::Connection::open(&f.path).expect("db");
    db.execute("INSERT INTO request_logs (id,at,api_key_id,requested_model,status,duration_ms,input_tokens,state) VALUES ('old',?,'kp','m1',200,0,10,'done')",[omni_gateway::clock::now_ms()]).expect("persisted usage");
    let env = [
        ("OMNI_ENCRYPTION_KEY".into(), ENC.into()),
        ("OMNI_DB_PATH".into(), f.path.to_str().expect("path").into()),
        ("OMNI_PORT".into(), "1".into()),
    ]
    .into_iter()
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let began = std::time::Instant::now();
    let running = start(
        config,
        Options {
            seed_delay: Duration::from_millis(100),
            ..Options::default()
        },
    )
    .await
    .expect("start");
    assert!(
        began.elapsed() >= Duration::from_millis(200),
        "both long windows installed before readiness"
    );
    let (status, _, body) = call(
        &format!("127.0.0.1:{}", running.addr.port()),
        "POST",
        "/v1/chat/completions",
        &[("authorization", &format!("Bearer {KEY}"))],
        r#"{"model":"m1","messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(status, 429, "first request: {body}");
    running.shutdown();
    running.wait().await.expect("shutdown");
}

#[tokio::test]
async fn failed_boot_is_bounded_and_same_database_restarts_cleanly() {
    let f = fixture(&["c0"]);
    add_key(&f.path, "kp", KEY, ",limits", ",'{\"tokens\":{\"5h\":1}}'");
    let env = [
        ("OMNI_ENCRYPTION_KEY".into(), ENC.into()),
        ("OMNI_DB_PATH".into(), f.path.to_str().expect("path").into()),
        ("OMNI_PORT".into(), "1".into()),
    ]
    .into_iter()
    .collect();
    let make_config = || {
        let mut c = load_config(&env, || 0).expect("config");
        c.port = 0;
        c
    };
    // What is under test is that the *seed* phase is bounded (10 ms, while
    // each seed is delayed 100 ms), shown by the error naming that bound.
    // The outer timeout only catches a hang: it also covers boot work the
    // test does not time (PBKDF2, migrations, the snapshot read), which a
    // loaded debug build can stretch past a tight budget (review A5 minor).
    let config = make_config();
    let started = std::time::Instant::now();
    let error = tokio::time::timeout(
        Duration::from_secs(30),
        start(
            config,
            Options {
                seed_delay: Duration::from_millis(100),
                boot_seed_timeout: Duration::from_millis(10),
                ..Options::default()
            },
        ),
    )
    .await
    .unwrap_or_else(|_| panic!("startup hung for {:?}", started.elapsed()))
    .expect_err("timeout");
    assert!(
        error.contains("seed installation timed out"),
        "after {:?}: {error}",
        started.elapsed()
    );
    let occupied = TcpListener::bind("127.0.0.1:0").await.expect("occupy");
    let mut config = make_config();
    config.port = occupied.local_addr().expect("addr").port();
    let error = start(config, Options::default())
        .await
        .expect_err("occupied port");
    assert!(error.contains("listen on"));
    drop(occupied);
    let running = start(make_config(), Options::default())
        .await
        .expect("restart after failed starts");
    running.shutdown();
    running.wait().await.expect("clean stop");
}

#[tokio::test]
async fn retained_output_overflow_closes_upstream_and_releases_admission() {
    for streaming in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = tokio::spawn(async move {
            for round in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept");
                let mut buf = Vec::new();
                loop {
                    let mut piece = [0; 8192];
                    let n = socket.read(&mut piece).await.expect("read");
                    assert!(n > 0);
                    buf.extend_from_slice(&piece[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.expect("head");
                let record = format!(
                    "data: {}\n\n",
                    serde_json::json!({"id":"c","model":"m","choices":[{"delta":{"content":"x".repeat(1024)}}]})
                );
                let frame = format!("{:x}\r\n{record}\r\n", record.len());
                // Below-limit second request verifies admission was released.
                let count = if round == 0 { 8193 } else { 8191 };
                for _ in 0..count {
                    if socket.write_all(frame.as_bytes()).await.is_err() {
                        break;
                    }
                }
                if round == 1 {
                    let done = "data: [DONE]\n\n";
                    socket
                        .write_all(format!("{:x}\r\n{done}\r\n0\r\n\r\n", done.len()).as_bytes())
                        .await
                        .expect("terminal");
                } else {
                    let mut byte = [0];
                    let closed =
                        tokio::time::timeout(Duration::from_secs(10), socket.read(&mut byte))
                            .await
                            .expect("overflow cancels upstream");
                    assert!(matches!(closed, Ok(0) | Err(_)));
                }
            }
        });
        let f = fixture(&["c0"]);
        let c = rusqlite::Connection::open(&f.path).expect("db");
        c.execute("UPDATE credentials SET provider_data=?",[format!(r#"{{"endpointId":"e0","origin":"http://127.0.0.1:{port}","protocol":"chat_completions"}}"#)]).expect("origin");
        add_key(&f.path, "kp", KEY, ",limits", ",'{\"concurrency\":1}'");
        let env = [
            ("OMNI_ENCRYPTION_KEY".to_owned(), ENC.to_owned()),
            ("OMNI_DB_PATH".into(), f.path.to_str().expect("path").into()),
            ("OMNI_PORT".into(), "1".into()),
        ]
        .into_iter()
        .collect();
        let mut config = load_config(&env, || 0).expect("config");
        config.port = 0;
        let running = start(config, Options::default()).await.expect("start");
        let base = format!("127.0.0.1:{}", running.addr.port());
        let (path, body) = if streaming {
            (
                "/v1/responses",
                r#"{"model":"m1","input":"hi","stream":true}"#,
            )
        } else {
            (
                "/v1/chat/completions",
                r#"{"model":"m1","messages":[{"role":"user","content":"hi"}],"stream":false}"#,
            )
        };
        for round in 0..2 {
            let (status, _, body) = tokio::time::timeout(
                Duration::from_secs(30),
                call(
                    &base,
                    "POST",
                    path,
                    &[("authorization", &format!("Bearer {KEY}"))],
                    body,
                ),
            )
            .await
            .expect("bounded call");
            if round == 0 {
                if streaming {
                    assert_eq!(status, 200);
                    assert!(!body.contains("response.completed"));
                } else {
                    assert_eq!(status, 502);
                    assert!(body.contains("retained response budget"));
                }
            } else {
                assert_eq!(status, 200, "admission released: {body}");
                if streaming {
                    assert!(body.contains("response.completed"));
                }
            }
        }
        server.await.expect("server");
        running.shutdown();
        running.wait().await.expect("stop");
    }
}

/// One raw HTTP/1.1 exchange; returns (status, lowercased headers, body).
async fn call(
    base: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, Vec<(String, String)>, String) {
    let mut s = TcpStream::connect(base).await.expect("connect");
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).await.expect("write");
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.expect("read");
    let text = String::from_utf8_lossy(&out).to_string();
    let (head, rest) = text.split_once("\r\n\r\n").expect("head");
    let mut lines = head.lines();
    let status: u16 = lines
        .next()
        .expect("status")
        .split(' ')
        .nth(1)
        .expect("code")
        .parse()
        .expect("num");
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(": "))
        .map(|(k, v)| (k.to_lowercase(), v.to_owned()))
        .collect();
    let chunked = headers
        .iter()
        .any(|(k, v)| k == "transfer-encoding" && v == "chunked");
    let body = if chunked {
        dechunk(rest)
    } else {
        rest.to_owned()
    };
    (status, headers, body)
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = s.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.push_str(&rest[..n]);
        s = &rest[n + 2..];
    }
    out
}

fn bearer(g: &Gw) -> String {
    format!("Bearer {}", g.key)
}

async fn stop(mut g: Gw) -> Fixture {
    let r = g.running.take().expect("running");
    r.shutdown();
    r.wait().await.expect("clean shutdown");
    g.f
}

fn logs(f: &Fixture) -> Vec<Vec<String>> {
    rows(
        &f.path,
        "SELECT requested_model, status, error_code, state, attempts, input_tokens, output_tokens FROM request_logs ORDER BY at, id",
    )
}

async fn rtk_gw(rtk: bool, env: &[(&str, &str)]) -> Gw {
    let f = fixture(&["c0"]);
    set_setting(&f.path, "rtkEnabled", if rtk { "true" } else { "false" });
    set_setting(&f.path, "bodyLoggingEnabled", "true");
    boot_on(f, &[("m1", "mock-c3-d0")], Options::default(), env).await
}

#[tokio::test(flavor = "multi_thread")]
async fn rtk_compresses_the_wire_body_while_the_client_body_stays_as_sent() {
    let g = rtk_gw(true, &[("OMNI_BODY_LOGGING_ALLOWED", "true")]).await;
    let auth = bearer(&g);
    let body = serde_json::json!({
        "model": "m1",
        "messages": [
            {"role": "user", "content": "run the tests"},
            {"role": "assistant", "content": null, "tool_calls": [{"id": "call-1", "type": "function",
                "function": {"name": "bash", "arguments": "{\"command\":\"bun test\"}"}}]},
            {"role": "tool", "tool_call_id": "call-1", "content": bun_output()},
            {"role": "user", "content": "thanks"},
        ],
    })
    .to_string();
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        &body,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    let f = stop(g).await;
    let r = rows(&f.path, "SELECT id, rtk_applied FROM request_logs");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0][1], "1");
    let store = omni_store::SqliteStore::open(&f.path, 0).expect("store");
    let read = store
        .get_body(&key(), &r[0][0])
        .expect("read")
        .expect("captured");
    let artifact: serde_json::Value = serde_json::from_str(
        &omni_ir::jsjson::stringify(&read.artifact.expect("artifact")).expect("json"),
    )
    .expect("artifact");
    let tool = |messages: &serde_json::Value| {
        messages
            .as_array()
            .expect("messages")
            .iter()
            .find(|m| m["role"] == "tool")
            .and_then(|m| m["content"].as_str())
            .expect("tool message")
            .to_owned()
    };
    assert_eq!(
        tool(&artifact["client"]["request"]["messages"]),
        bun_output()
    );
    let wire = tool(&artifact["attempts"][0]["request"]["messages"]);
    // The crate's own output for the same body: a wrong-but-shorter
    // compression fails here.
    let mut mint = omni_dialects::ingress::random_tool_use_id;
    let ingested = omni_dialects::ingress::ingest(
        omni_dialects::ingress::Surface::OpenAi,
        &body,
        &omni_dialects::ingress::Headers::new(),
        &mut omni_dialects::ingress::IngressOptions {
            new_tool_use_id: &mut mint,
        },
    )
    .expect("ingest");
    let out =
        omni_rtk::transform_request(&ingested.request, &omni_rtk::RtkConfig { enabled: true });
    assert!(out.report.applied);
    let expected = out
        .request
        .messages
        .iter()
        .flat_map(|m| &m.content)
        .find_map(|b| match b {
            omni_ir::request::ContentBlock::ToolResult(r) => Some(r.content.clone()),
            _ => None,
        })
        .expect("tool result");
    assert_ne!(expected, bun_output());
    assert_eq!(wire, expected);
}

#[tokio::test(flavor = "multi_thread")]
async fn count_tokens_estimates_the_request_as_received_whatever_rtk_says() {
    let body = serde_json::json!({
        "model": "m1",
        "messages": [
            {"role": "user", "content": "run the tests"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "call-1", "name": "bash",
                "input": {"command": "bun test"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call-1",
                "content": bun_output()}]},
            {"role": "user", "content": "thanks"},
        ],
    })
    .to_string();
    let mut answers = Vec::new();
    for rtk in [false, true] {
        let g = rtk_gw(rtk, &[]).await;
        let auth = bearer(&g);
        let (s, _, b) = call(
            &g.base,
            "POST",
            "/v1/messages/count_tokens",
            &[("authorization", &auth)],
            &body,
        )
        .await;
        assert_eq!(s, 200, "{b}");
        answers.push(b);
        stop(g).await;
    }
    assert_eq!(answers[0], answers[1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_streaming_request_files_exactly_one_completed_row() {
    let g = boot().await;
    let auth = bearer(&g);
    let (status, headers, body) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        r#"{"model":"m1","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(status, 200);
    assert!(headers.contains(&(
        "content-type".into(),
        "text/event-stream; charset=utf-8".into()
    )));
    assert_eq!(body.matches("lorem ipsum").count(), 3);
    assert!(body.ends_with("event: message\ndata: [DONE]\n\n"));
    let f = stop(g).await;
    assert_eq!(logs(&f), [["m1", "200", "null", "done", "1", "64", "6"]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_dialect_answers_buffered_and_streamed() {
    let g = boot().await;
    let auth = bearer(&g);
    for (path, body) in [
        (
            "/v1/messages",
            r#"{"model":"m1","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}"#,
        ),
        (
            "/v1/messages",
            r#"{"model":"m1","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        ),
        (
            "/v1/chat/completions",
            r#"{"model":"m1","messages":[{"role":"user","content":"hi"}]}"#,
        ),
        ("/v1/responses", r#"{"model":"m1","input":"hi"}"#),
        (
            "/v1/responses",
            r#"{"model":"m1","stream":true,"input":"hi"}"#,
        ),
    ] {
        let (status, _, text) =
            call(&g.base, "POST", path, &[("authorization", &auth)], body).await;
        assert_eq!(status, 200, "{path} {body}: {text}");
        assert!(text.contains("lorem ipsum"), "{path}: {text}");
    }
    let f = stop(g).await;
    assert_eq!(logs(&f).len(), 5);
    assert!(logs(&f).iter().all(|r| r[1] == "200" && r[3] == "done"));
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_failures_answer_in_the_dialect_and_file_a_row() {
    let g = boot().await;
    let (s, _, b) = call(&g.base, "POST", "/v1/messages", &[], "{}").await;
    assert_eq!(s, 401);
    assert_eq!(
        b,
        r#"{"type":"error","error":{"type":"authentication_error","message":"missing or malformed Authorization header"}}"#
    );
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", "Bearer sk-omni-nope")],
        "{}",
    )
    .await;
    assert_eq!(s, 401);
    assert!(b.contains("invalid API key"), "{b}");
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", "Bearer a"), ("x-api-key", "b")],
        "{}",
    )
    .await;
    assert_eq!((s, b.contains("conflicting API key headers")), (401, true));
    let f = stop(g).await;
    assert_eq!(
        rows(
            &f.path,
            "SELECT status, error_code, api_key_id FROM request_logs"
        )
        .len(),
        3
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unparsable_body_is_ts_s_500_with_jsc_s_message() {
    let g = boot().await;
    let auth = bearer(&g);
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", &auth)],
        "{bad",
    )
    .await;
    assert_eq!(s, 500);
    assert_eq!(
        b,
        r#"{"type":"error","error":{"type":"api_error","message":"JSON Parse error: Expected '}'"}}"#
    );
    let f = stop(g).await;
    assert_eq!(
        rows(&f.path, "SELECT status, error_code FROM request_logs"),
        [["500", "INTERNAL"]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_over_the_limit_is_the_dialect_s_invalid_request() {
    let g = boot().await;
    let auth = bearer(&g);
    let big = format!(
        "{{\"model\":\"m1\",\"x\":\"{}\"}}",
        "a".repeat(omni_gateway::server::BODY_LIMIT)
    );
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        &big,
    )
    .await;
    assert_eq!(s, 400);
    assert!(b.contains("\"type\":\"invalid_request_error\""), "{b}");
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn health_models_count_tokens_and_the_404s() {
    let g = boot().await;
    let auth = bearer(&g);
    let (s, h, b) = call(&g.base, "GET", "/health", &[], "").await;
    assert_eq!(s, 200);
    assert!(h.contains(&(
        "content-type".into(),
        "application/json;charset=utf-8".into()
    )));
    assert!(b.starts_with("{\"ok\":true,\"mode\":\"single\",\"nodeId\":\""));
    let (s, _, b) = call(&g.base, "GET", "/v1/models", &[("x-api-key", &g.key)], "").await;
    assert_eq!(s, 200);
    assert!(
        b.starts_with("{\"object\":\"list\",\"data\":[{\"id\":\"m1\""),
        "{b}"
    );
    assert!(
        b.ends_with("\"has_more\":false,\"first_id\":\"m1\",\"last_id\":\"slow\"}"),
        "{b}"
    );
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages/count_tokens",
        &[("authorization", &auth)],
        r#"{"model":"m1","messages":[{"role":"user","content":"hi there"}]}"#,
    )
    .await;
    assert_eq!((s, b.as_str()), (200, "{\"input_tokens\":10}"));
    let (s, _, b) = call(&g.base, "GET", "/nope", &[], "").await;
    assert_eq!(
        (s, b.as_str()),
        (
            404,
            r#"{"error":{"code":"NOT_FOUND","message":"no route for /nope"}}"#
        )
    );
    let (s, _, b) = call(&g.base, "POST", "/v1/nope", &[], "").await;
    assert_eq!((s, b.as_str()), (404, "NOT_FOUND"));
    let f = stop(g).await;
    // count_tokens and models write no row.
    assert!(rows(&f.path, "SELECT id FROM request_logs").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn pathname_catch_all_preserves_the_normalized_trailing_slash() {
    let g = boot().await;
    for (target, path) in [
        ("/missing/", "/missing/"),
        ("/missing", "/missing"),
        ("/x/%2e%2e/missing/", "/missing/"),
    ] {
        let (status, _, body) = call(&g.base, "GET", target, &[], "").await;
        assert_eq!(status, 404);
        assert_eq!(
            body,
            format!(r#"{{"error":{{"code":"NOT_FOUND","message":"no route for {path}"}}}}"#)
        );
    }
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pathname_static_file_with_a_trailing_slash_still_serves() {
    let f = fixture(&[]);
    let assets = tempfile::tempdir().expect("assets");
    std::fs::write(assets.path().join("large.txt"), "static contents").expect("asset");
    let env = [
        ("OMNI_ENCRYPTION_KEY".to_owned(), ENC.to_owned()),
        (
            "OMNI_DB_PATH".to_owned(),
            f.path.to_str().expect("database path").to_owned(),
        ),
        (
            "OMNI_STATIC_DIR".to_owned(),
            assets.path().to_str().expect("assets path").to_owned(),
        ),
    ]
    .into_iter()
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(config, Options::default()).await.expect("start");
    let base = format!("127.0.0.1:{}", running.addr.port());
    for path in ["/large.txt/", "/x/../large.txt/"] {
        let (status, _, body) = call(&base, "GET", path, &[], "").await;
        assert_eq!((status, body.as_str()), (200, "static contents"));
    }
    running.shutdown();
    running.wait().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread")]
async fn pathname_normalized_inference_routes_keep_their_dispatch_key() {
    let g = boot().await;
    for path in [
        "/v1/x/%2e%2e/messages/",
        "/v1/./responses/",
        "/v1\\x\\..\\chat/completions",
    ] {
        let (status, _, _) = call(&g.base, "POST", path, &[], "{}").await;
        assert_eq!(status, 401, "{path}");
    }
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_hangs_up_mid_stream_files_one_499_row() {
    let g = boot().await;
    let auth = bearer(&g);
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let body = r#"{"model":"slow","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let req = format!(
        "POST /v1/messages HTTP/1.1\r\nhost: x\r\nauthorization: {auth}\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.expect("write");
    let mut got = Vec::new();
    while !String::from_utf8_lossy(&got).contains("lorem ipsum") {
        let mut chunk = [0u8; 4096];
        let n = s.read(&mut chunk).await.expect("read");
        assert!(n > 0);
        got.extend_from_slice(&chunk[..n]);
    }
    drop(s);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let f = stop(g).await;
    let r = rows(
        &f.path,
        "SELECT status, error_code, state, attempts, credential_id FROM request_logs",
    );
    assert_eq!(r, [["499", "interrupted", "done", "1", "c0"]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_stream_carries_keepalive_comments() {
    let g = boot_with(&[("slow", "mock-c3-d300")], Duration::from_millis(100)).await;
    let auth = bearer(&g);
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        r#"{"model":"slow","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(s, 200);
    assert!(b.contains(": keepalive\n\n"), "{b}");
    assert!(b.ends_with("data: [DONE]\n\n"));
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_lets_an_open_stream_finish_and_flushes_its_row() {
    let g = boot_with(&[("slow", "mock-c5-d100")], Duration::from_secs(10)).await;
    let auth = bearer(&g);
    let base = g.base.clone();
    let client = tokio::spawn(async move {
        call(
            &base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", &auth)],
            r#"{"model":"slow","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let f = stop(g).await;
    let (s, _, b) = client.await.expect("client");
    assert_eq!(s, 200);
    assert!(b.ends_with("data: [DONE]\n\n"));
    assert_eq!(logs(&f), [["slow", "200", "null", "done", "1", "64", "10"]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_concurrency_limited_key_is_refused_with_retry_after_and_headers() {
    let g = boot_with(&[("slow", "mock-c3-d200")], Duration::from_secs(10)).await;
    add_key(
        &g.f.path,
        "kl",
        "sk-omni-limited",
        ", limits",
        r#", '{"concurrency":1,"requests":{"1m":100}}'"#,
    );
    // The refresher picks the new key up within one poll; the miss read sooner.
    let base = g.base.clone();
    let first = tokio::spawn(async move {
        call(
            &base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", "Bearer sk-omni-limited")],
            r#"{"model":"slow","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (s, h, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", "Bearer sk-omni-limited")],
        r#"{"model":"slow","messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(s, 429, "{b}");
    assert!(b.contains("API key rate limit exceeded"));
    assert!(
        h.iter().any(|(k, _)| k == "x-ratelimit-limit-requests"),
        "{h:?}"
    );
    let (s1, h1, _) = first.await.expect("first");
    assert_eq!(s1, 200);
    assert!(
        h1.contains(&("x-ratelimit-remaining-requests".into(), "99".into())),
        "{h1:?}"
    );
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_complete_at_head_time_goes_out_with_a_content_length() {
    let g = boot().await;
    let auth = bearer(&g);
    let (s, h, b) = call(&g.base, "POST", "/v1/messages", &[("authorization", &auth)],
        r#"{"model":"nope","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#).await;
    assert_eq!(s, 200);
    assert!(b.starts_with("event: error\n"), "{b}");
    assert!(
        h.contains(&("content-length".into(), b.len().to_string())),
        "{h:?}"
    );
    stop(g).await;
}

/// Screening is not implemented: keys that need it fail closed, the same
/// refusal as when screening is not configured.
async fn screened(settings: &[(&str, &str)]) -> Gw {
    let g = boot_with(&[("m1", "mock-c3-d0")], Duration::from_secs(10)).await;
    add_key(
        &g.f.path,
        "kpol",
        "sk-omni-policy",
        ", guardrail_policy",
        ", 'no secrets'",
    );
    add_key(&g.f.path, "ksr", "sk-omni-smart", ", smart_routing", ", 1");
    for (k, v) in settings {
        set_setting(&g.f.path, k, v);
    }
    // Let the refresher pick the settings and keys up.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    g
}

fn screen_rows(f: &Fixture) -> Vec<Vec<String>> {
    rows(
        &f.path,
        "SELECT api_key_id, requested_model, status, error_code, attempts, degradations, credential_id FROM request_logs ORDER BY at, id",
    )
}

const MSG: &str = r#"{"model":"m1","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}"#;
const MSG_STREAM: &str =
    r#"{"model":"m1","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#;

#[tokio::test(flavor = "multi_thread")]
async fn a_policy_key_with_no_guardrail_model_is_refused_as_unconfigured() {
    let g = screened(&[]).await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-policy")],
        MSG,
    )
    .await;
    assert_eq!(s, 500);
    assert_eq!(
        b,
        r#"{"type":"error","error":{"type":"api_error","message":"usage policy check is not configured"}}"#
    );
    let (s, h, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-policy")],
        MSG_STREAM,
    )
    .await;
    assert_eq!(s, 200);
    assert!(
        h.contains(&("content-length".into(), b.len().to_string())),
        "{h:?}"
    );
    assert_eq!(
        b,
        "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"usage policy check is not configured\"}}\n\n"
    );
    let f = stop(g).await;
    let r = screen_rows(&f);
    assert_eq!(r.len(), 2);
    for row in r {
        assert_eq!(
            row,
            [
                "kpol",
                "m1",
                "500",
                "INTERNAL",
                "0",
                r#"["guardrail:unconfigured"]"#,
                "null"
            ]
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_guardrail_reply_is_refused_with_a_classifier_row() {
    let g = screened(&[("guardrailModel", "\"m1\"")]).await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("x-api-key", "sk-omni-policy")],
        r#"{"model":"m1","messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(s, 502);
    assert_eq!(
        b,
        r#"{"error":{"message":"usage policy check unavailable","type":"server_error","code":"server_error"}}"#
    );
    let f = stop(g).await;
    // The unreadable reply is successful dispatch but fails closed in the judge.
    assert_eq!(
        screen_rows(&f),
        vec![
            vec![
                "kpol",
                "m1",
                "502",
                "UPSTREAM",
                "0",
                r#"["guardrail:unavailable"]"#,
                "null"
            ],
            vec![
                "kpol",
                "m1",
                "200",
                "null",
                "1",
                r#"["guardrail:classifier"]"#,
                "c0"
            ]
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_smart_routing_key_takes_the_normal_path_while_smart_routing_is_off() {
    let g = screened(&[]).await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-smart")],
        MSG,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(b.contains("lorem ipsum"));
    let f = stop(g).await;
    assert_eq!(
        screen_rows(&f),
        [["ksr", "m1", "200", "null", "1", "[]", "c0"]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_smart_routing_key_with_no_models_is_refused_as_unconfigured() {
    let g = screened(&[("smartRouterEnabled", "true")]).await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-smart")],
        MSG,
    )
    .await;
    assert_eq!(s, 500);
    assert_eq!(
        b,
        r#"{"type":"error","error":{"type":"api_error","message":"confidential routing is not configured"}}"#
    );
    let f = stop(g).await;
    assert_eq!(
        screen_rows(&f),
        [[
            "ksr",
            "m1",
            "500",
            "INTERNAL",
            "0",
            r#"["smart-router:unconfigured"]"#,
            "null"
        ]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_smart_routing_key_already_local_bypasses_classification() {
    let g = screened(&[
        ("smartRouterEnabled", "true"),
        ("smartRouterClassifierModel", "\"m1\""),
        ("smartRouterLocalModel", "\"m1\""),
    ])
    .await;
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/responses",
        &[("x-api-key", "sk-omni-smart")],
        r#"{"model":"m1","input":"hi"}"#,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    let f = stop(g).await;
    assert_eq!(
        screen_rows(&f),
        [[
            "ksr",
            "m1",
            "200",
            "null",
            "1",
            r#"["smart-router:already-local"]"#,
            "c0"
        ]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_screen_still_takes_its_rate_limit_slot() {
    let g = boot_with(&[("m1", "mock-c3-d0")], Duration::from_secs(10)).await;
    add_key(
        &g.f.path,
        "kpl",
        "sk-omni-pol-lim",
        ", guardrail_policy, limits",
        r#", 'p', '{"requests":{"1m":1}}'"#,
    );
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let (s1, _, _) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-pol-lim")],
        MSG,
    )
    .await;
    let (s2, _, b2) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("x-api-key", "sk-omni-pol-lim")],
        MSG,
    )
    .await;
    assert_eq!((s1, s2), (500, 429), "{b2}");
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_complete_stream_of_two_frames_is_still_chunked_as_bun_sends_it() {
    let g = boot().await;
    let auth = bearer(&g);
    let (s, h, b) = call(
        &g.base,
        "POST",
        "/v1/responses",
        &[("authorization", &auth)],
        r#"{"model":"nope","stream":true,"input":"hi"}"#,
    )
    .await;
    assert_eq!(s, 200);
    assert!(
        b.starts_with("event: response.failed\n") && b.ends_with("data: [DONE]\n\n"),
        "{b}"
    );
    assert!(
        h.contains(&("transfer-encoding".into(), "chunked".into())),
        "{h:?}"
    );
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn repeated_auth_headers_are_joined_as_whatwg_headers_get_joins_them() {
    let g = boot().await;
    let auth = bearer(&g);
    // Two Authorization lines read as "Bearer k, Bearer k": not a key.
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", &auth), ("authorization", &auth)],
        MSG,
    )
    .await;
    assert_eq!(s, 401, "{b}");
    assert!(b.contains("invalid API key"), "{b}");
    // Matching Authorization and x-api-key tokens are accepted.
    let (s, _, _) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", &auth), ("x-api-key", &g.key)],
        MSG,
    )
    .await;
    assert_eq!(s, 200);
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_still_open_at_the_drain_deadline_files_its_499_before_the_writer_closes() {
    let g = boot_opts(
        &[("slow", "mock-c50-d200")],
        Options {
            stop_deadline: Duration::from_millis(300),
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let body = r#"{"model":"slow","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let req = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\nauthorization: {auth}\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.expect("write");
    let mut got = Vec::new();
    while !String::from_utf8_lossy(&got).contains("lorem ipsum") {
        let mut chunk = [0u8; 4096];
        let n = s.read(&mut chunk).await.expect("read");
        assert!(n > 0);
        got.extend_from_slice(&chunk[..n]);
    }
    let f = stop(g).await;
    drop(s);
    assert_eq!(
        rows(
            &f.path,
            "SELECT status, error_code, state, attempts FROM request_logs"
        ),
        [["499", "interrupted", "done", "1"]]
    );
}

async fn idle_gw(idle: Duration) -> Gw {
    boot_opts(
        &[("m1", "mock-c3-d0")],
        Options {
            idle_timeout: idle,
            ..Options::default()
        },
    )
    .await
}

/// Reads until the server closes; `None` when the read itself waited past `limit`.
async fn read_until_closed(s: &mut TcpStream, limit: Duration) -> Option<String> {
    let mut out = Vec::new();
    let r = tokio::time::timeout(limit, s.read_to_end(&mut out)).await;
    r.ok().map(|_| String::from_utf8_lossy(&out).into_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_exempt_body_that_stops_arriving_outlives_the_idle_timeout() {
    let g = idle_gw(Duration::from_millis(300)).await;
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let req = format!(
        "POST /v1/messages HTTP/1.1\r\nhost: x\r\nx-api-key: {}\r\ncontent-length: 100\r\n\r\n{{\"model\":",
        g.key
    );
    s.write_all(req.as_bytes()).await.expect("write");
    assert!(
        read_until_closed(&mut s, Duration::from_millis(600))
            .await
            .is_none()
    );
    // Shutdown cancels the pending exempt upload through its finisher.
    let f = stop(g).await;
    assert_eq!(
        rows(
            &f.path,
            "SELECT status, error_code, requested_model, api_key_id FROM request_logs"
        ),
        [["499", "interrupted", "", "kp"]]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_but_steady_body_is_not_cut() {
    let g = idle_gw(Duration::from_millis(300)).await;
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let body = MSG.as_bytes();
    let head = format!(
        "POST /v1/messages HTTP/1.1\r\nhost: x\r\nx-api-key: {}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n",
        g.key,
        body.len()
    );
    s.write_all(head.as_bytes()).await.expect("write");
    // Total well past the idle timeout, every gap well under it.
    for part in body.chunks(8) {
        s.write_all(part).await.expect("write");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let got = read_until_closed(&mut s, Duration::from_secs(5))
        .await
        .expect("answered");
    assert!(got.starts_with("HTTP/1.1 200"), "{got}");
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_keep_alive_connection_and_a_stalled_head_are_closed() {
    let g = idle_gw(Duration::from_millis(300)).await;
    let mut idle = TcpStream::connect(&g.base).await.expect("connect");
    assert!(
        read_until_closed(&mut idle, Duration::from_secs(3))
            .await
            .is_some()
    );
    let mut half = TcpStream::connect(&g.base).await.expect("connect");
    half.write_all(b"GET /health HTTP/1.1\r\nhost")
        .await
        .expect("write");
    assert!(
        read_until_closed(&mut half, Duration::from_secs(3))
            .await
            .is_some()
    );
    stop(g).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_silent_upstream_stream_with_keepalives_outlives_the_idle_timeout() {
    // Idle timeout 300 ms; the upstream is silent 1 s between deltas; the
    // gateway's keepalive every 100 ms keeps the response going. The idle
    // timeouts bound reading the request only.
    let g = boot_opts(
        &[("silent", "mock-c2-d1000")],
        Options {
            idle_timeout: Duration::from_millis(300),
            keepalive: Duration::from_millis(100),
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/v1/messages",
        &[("authorization", &auth)],
        MSG_STREAM.replace("m1", "silent").as_str(),
    )
    .await;
    assert_eq!(s, 200);
    assert!(b.matches(": keepalive").count() >= 10, "{b}");
    assert!(b.contains("event: message_stop"), "{b}");
    let f = stop(g).await;
    assert_eq!(rows(&f.path, "SELECT status FROM request_logs"), [["200"]]);
}

/// `POST /__omni/bench/flush`, with bench endpoints on (`OMNI_BENCH=1`):
/// answered once every row from before it is committed, with the writer's
/// cumulative counters.
#[tokio::test(flavor = "multi_thread")]
async fn the_bench_flush_barrier_commits_and_counts() {
    let g = boot_opts(
        &[("fast", "mock-c1-d0")],
        Options {
            bench_endpoints: true,
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    for _ in 0..5 {
        let (s, _, _) = call(
            &g.base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", &auth)],
            r#"{"model":"fast","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await;
        assert_eq!(s, 200);
    }
    let (s, _, b) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s, 200, "{b}");
    let v: serde_json::Value = serde_json::from_str(&b).expect("json");
    assert_eq!(v["dropped"], 0, "{b}");
    assert_eq!(v["failed"], 0, "{b}");
    // Two events per request (Begin, Finish), all ahead of the barrier.
    assert_eq!(v["watermark"], 10, "{b}");
    assert_eq!(v["committed"], 10, "{b}");
    // Committed means in the database, now.
    let done = rows(
        &g.f.path,
        "SELECT COUNT(*) FROM request_logs WHERE state = 'done'",
    );
    assert_eq!(done, [["5"]]);
    stop(g).await;
}

/// Without `OMNI_BENCH=1` the route does not exist: the ordinary 404.
#[tokio::test(flavor = "multi_thread")]
async fn the_bench_flush_route_is_off_by_default() {
    let g = boot_opts(&[("fast", "mock-c1-d0")], Options::default()).await;
    let (s, _, _) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s, 404);
    stop(g).await;
}

/// Holds the database's write lock from another connection, so the writer's
/// next batch (and any barrier behind it) waits.
fn hold_write_lock(path: &std::path::Path) -> rusqlite::Connection {
    let c = rusqlite::Connection::open(path).expect("open");
    c.execute_batch("BEGIN IMMEDIATE").expect("lock");
    c
}

/// One barrier at a time: while one waits on a stuck writer, a second gets
/// 409; the first gives up after the server's timeout with 504
/// `inconclusive`; the slot stays taken until the writer answers it.
#[tokio::test(flavor = "multi_thread")]
async fn a_concurrent_barrier_is_409_and_a_stuck_one_times_out_with_504() {
    let g = boot_opts(
        &[("fast", "mock-c1-d0")],
        Options {
            bench_endpoints: true,
            bench_flush_timeout: Duration::from_millis(500),
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    let (s, _, _) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth)],
        r#"{"model":"fast","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(s, 200);
    let lock = hold_write_lock(&g.f.path);
    let base = g.base.clone();
    let first =
        tokio::spawn(async move { call(&base, "POST", "/__omni/bench/flush", &[], "").await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (s2, _, b2) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s2, 409, "{b2}");
    assert!(b2.contains("\"inconclusive\":true"), "{b2}");
    let (s1, _, b1) = first.await.expect("first");
    assert_eq!(s1, 504, "{b1}");
    assert!(b1.contains("\"inconclusive\":true"), "{b1}");
    // Still in flight (the writer has not answered it): still 409.
    let (s3, _, _) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s3, 409);
    drop(lock);
    // Once the writer gets through, barriers are admitted again.
    let mut ok = false;
    for _ in 0..50 {
        let (s, _, b) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
        if s == 200 {
            let v: serde_json::Value = serde_json::from_str(&b).expect("json");
            assert_eq!(v["watermark"], 2, "{b}");
            assert_eq!(v["committed"], 2, "{b}");
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ok, "no barrier admitted after the writer recovered");
    stop(g).await;
}

/// A barrier never waits for queue room: a full queue is 503 `inconclusive`.
#[tokio::test(flavor = "multi_thread")]
async fn a_barrier_on_a_full_queue_is_503() {
    let g = boot_opts(
        &[("fast", "mock-c1-d0")],
        Options {
            bench_endpoints: true,
            writer_capacity: Some(2),
            ..Options::default()
        },
    )
    .await;
    let auth = bearer(&g);
    let lock = hold_write_lock(&g.f.path);
    // The writer takes the first request's events into a batch that, after
    // the 200 ms interval, sticks on the lock; the next ones fill its 2-slot
    // queue (and the rest are dropped).
    for i in 0..4 {
        if i == 1 {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        let (s, _, _) = call(
            &g.base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", &auth)],
            r#"{"model":"fast","stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await;
        assert_eq!(s, 200);
    }
    let started = std::time::Instant::now();
    let (s, _, b) = call(&g.base, "POST", "/__omni/bench/flush", &[], "").await;
    assert_eq!(s, 503, "{b}");
    assert!(b.contains("\"inconclusive\":true"), "{b}");
    assert!(started.elapsed() < Duration::from_secs(1), "it waited");
    drop(lock);
    stop(g).await;
}

/// `/metrics` exists only with a token, takes exactly `Bearer <token>`, and
/// counts a finished request under the fixed series names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metrics_route_is_token_gated_and_records_completions() {
    let port = upstream().await;
    let f = fixture(&["c0"]);
    let c = rusqlite::Connection::open(&f.path).expect("open");
    c.execute(
        "UPDATE credentials SET provider_data=? WHERE id='c0'",
        rusqlite::params![format!(
            "{{\"endpointId\":\"e0\",\"origin\":\"http://127.0.0.1:{port}\",\"protocol\":\"chat_completions\"}}"
        )],
    )
    .expect("origin");
    c.execute(
        "INSERT OR REPLACE INTO virtual_models (id, targets, strategy) VALUES ('m1', ?, 'priority')",
        rusqlite::params![
            "[{\"provider\":\"custom\",\"endpointId\":\"e0\",\"model\":\"mock-c1-d0\",\"tier\":1,\"weight\":1,\
             \"costPerMTok\":{\"input\":1,\"output\":2},\"capabilities\":{\"tools\":true,\"images\":true,\"reasoning\":true}}]"
        ],
    )
    .expect("model");
    drop(c);
    add_key(&f.path, "kp", KEY, "", "");
    let mut env: std::collections::HashMap<String, String> = [
        ("OMNI_ENCRYPTION_KEY", ENC),
        ("OMNI_DB_PATH", f.path.to_str().expect("path")),
        ("OMNI_PORT", "1"),
        ("OMNI_DAY_OFFSET_MINUTES", "0"),
        ("OMNI_METRICS_TOKEN", "tok"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(
        config,
        Options {
            version: "1.2.3".into(),
            ..Options::default()
        },
    )
    .await
    .expect("start");
    let base = format!("127.0.0.1:{}", running.addr.port());

    let (s, h, body) = call(&base, "GET", "/metrics", &[], "").await;
    assert_eq!((s, body.as_str()), (401, ""));
    assert!(!h.iter().any(|(k, _)| k == "content-type"));
    let (s, _, _) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tokx")],
        "",
    )
    .await;
    assert_eq!(s, 401);
    let (s, h, body) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tok")],
        "",
    )
    .await;
    assert_eq!(s, 200);
    assert!(h.contains(&(
        "content-type".into(),
        "text/plain; version=0.0.4; charset=utf-8".into()
    )));
    assert!(
        body.lines()
            .any(|line| line == "omni_build_info{version=\"1.2.3\"} 1"),
        "{body}"
    );
    assert!(!body.contains("omni_requests_total"));

    let req = r#"{"model":"m1","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let (s, _, _) = call(
        &base,
        "POST",
        "/v1/chat/completions",
        &[
            ("authorization", &format!("Bearer {KEY}")),
            ("content-type", "application/json"),
        ],
        req,
    )
    .await;
    assert_eq!(s, 200);
    let (_, _, body) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tok")],
        "",
    )
    .await;
    assert!(
        body.contains(
            "omni_requests_total{provider=\"custom\",model=\"mock-c1-d0\",status=\"200\",code=\"\",api_key_id=\"kp\"} 1\n"
        ),
        "{body}"
    );
    assert!(body.contains("omni_upstream_duration_seconds_count{provider=\"custom\"} 1\n"));
    assert!(body.contains("omni_ttft_seconds_count{provider=\"custom\",model=\"mock-c1-d0\"} 1\n"));
    for name in [
        "terminal_dropped",
        "optional_dropped",
        "failed_batches",
        "sink_dropped",
    ] {
        assert!(
            body.contains(&format!("omni_request_log_writer_{name}_total 0\n")),
            "{body}"
        );
    }
    // The local counts are empty once the slot is released, and no scrape set
    // the gauge while it was held: no `omni_inflight` series is registered.
    assert!(!body.contains("omni_inflight"), "{body}");
    running.shutdown();
    running.wait().await.expect("stop");

    // No token: no route, the fixed 404 for an unmatched GET.
    env.remove("OMNI_METRICS_TOKEN");
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(config, Options::default()).await.expect("start");
    let base = format!("127.0.0.1:{}", running.addr.port());
    let (s, _, body) = call(
        &base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tok")],
        "",
    )
    .await;
    assert_eq!(s, 404);
    assert_eq!(
        body,
        r#"{"error":{"code":"NOT_FOUND","message":"no route for /metrics"}}"#
    );
    running.shutdown();
    running.wait().await.expect("stop");
}

/// `/api/plugins*` answers the spec's 501 for every method.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_routes_are_unsupported() {
    let g = boot().await;
    for (m, p) in [
        ("GET", "/api/plugins"),
        ("POST", "/api/plugins/x"),
        ("DELETE", "/api/plugins/x/y"),
    ] {
        let (s, _, body) = call(&g.base, m, p, &[], "").await;
        assert_eq!(s, 501, "{m} {p}");
        assert_eq!(
            body,
            r#"{"error":{"code":"UNSUPPORTED","message":"plugins are not supported in this release"}}"#
        );
    }
    let (s, _, _) = call(&g.base, "GET", "/api/pluginsx", &[], "").await;
    assert_eq!(s, 404);
    stop(g).await;
}

/// An upstream that reads the request and never answers: the head never
/// arrives, so only cancellation ends the attempt.
async fn silent_upstream() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = l.local_addr().expect("addr").port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                while matches!(s.read(&mut buf).await, Ok(n) if n > 0) {}
            });
        }
    });
    port
}

async fn metrics_gw(
    port: u16,
    deadline_ms: Option<&str>,
) -> (Fixture, omni_gateway::Running, String) {
    let f = fixture(&["c0"]);
    let c = rusqlite::Connection::open(&f.path).expect("open");
    c.execute(
        "UPDATE credentials SET provider_data=? WHERE id='c0'",
        rusqlite::params![format!(
            "{{\"endpointId\":\"e0\",\"origin\":\"http://127.0.0.1:{port}\",\"protocol\":\"chat_completions\"}}"
        )],
    )
    .expect("origin");
    c.execute(
        "INSERT OR REPLACE INTO virtual_models (id, targets, strategy) VALUES ('m1', ?, 'priority')",
        rusqlite::params![
            "[{\"provider\":\"custom\",\"endpointId\":\"e0\",\"model\":\"silent\",\"tier\":1,\"weight\":1,\
             \"costPerMTok\":{\"input\":1,\"output\":2},\"capabilities\":{\"tools\":true,\"images\":true,\"reasoning\":true}}]"
        ],
    )
    .expect("model");
    drop(c);
    if let Some(ms) = deadline_ms {
        set_setting(&f.path, "requestDeadlineMs", ms);
    }
    add_key(&f.path, "kp", KEY, "", "");
    let env: std::collections::HashMap<String, String> = [
        ("OMNI_ENCRYPTION_KEY", ENC),
        ("OMNI_DB_PATH", f.path.to_str().expect("path")),
        ("OMNI_PORT", "1"),
        ("OMNI_DAY_OFFSET_MINUTES", "0"),
        ("OMNI_METRICS_TOKEN", "tok"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(config, Options::default()).await.expect("start");
    let base = format!("127.0.0.1:{}", running.addr.port());
    (f, running, base)
}

async fn upstream_count(base: &str) -> Option<u64> {
    let (_, _, body) = call(
        base,
        "GET",
        "/metrics",
        &[("authorization", "Bearer tok")],
        "",
    )
    .await;
    body.lines()
        .find_map(|l| l.strip_prefix("omni_upstream_duration_seconds_count{provider=\"custom\"} "))
        .map(|v| v.parse().expect("count"))
}

/// A destroyed upstream request is traced exactly once, from its error
/// path: a request deadline that fires before the
/// upstream head is still one `omni_upstream_duration_seconds` observation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deadline_before_the_upstream_head_is_one_upstream_observation() {
    let port = silent_upstream().await;
    let (_f, running, base) = metrics_gw(port, Some("300")).await;
    let req = r#"{"model":"m1","stream":false,"messages":[{"role":"user","content":"hi"}]}"#;
    let (s, _, _) = call(
        &base,
        "POST",
        "/v1/chat/completions",
        &[
            ("authorization", &format!("Bearer {KEY}")),
            ("content-type", "application/json"),
        ],
        req,
    )
    .await;
    assert_eq!(s, 504);
    assert_eq!(upstream_count(&base).await, Some(1));
    running.shutdown();
    running.wait().await.expect("stop");
}

/// A client that hangs up before the upstream head: the attempt is
/// cancelled, and the abort's destroy → error → trace path still counts it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_abort_before_the_upstream_head_is_one_upstream_observation() {
    let port = silent_upstream().await;
    let (_f, running, base) = metrics_gw(port, None).await;
    let req = r#"{"model":"m1","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
    let mut s = TcpStream::connect(&base).await.expect("connect");
    let head = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\nauthorization: Bearer {KEY}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{req}",
        req.len()
    );
    s.write_all(head.as_bytes()).await.expect("write");
    // Let the attempt reach the silent upstream, then hang up.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        upstream_count(&base).await,
        None,
        "no head yet, no observation yet"
    );
    drop(s);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if upstream_count(&base).await == Some(1) || tokio::time::Instant::now() > deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(upstream_count(&base).await, Some(1));
    running.shutdown();
    running.wait().await.expect("stop");
}

fn set_cookie(h: &[(String, String)]) -> Option<String> {
    h.iter()
        .find(|(k, _)| k == "set-cookie")
        .map(|(_, v)| v.clone())
}

fn token_of(cookie: &str) -> String {
    cookie
        .strip_prefix("omni_admin=")
        .and_then(|r| r.split(';').next())
        .expect("token")
        .to_owned()
}

#[tokio::test]
async fn sqlite_console_selectors_merge_self_and_never_fall_back_for_other_node() {
    let g = boot().await;
    let (status, headers, body) = call(
        &g.base,
        "POST",
        "/api/setup",
        &[],
        r#"{"password":"correct-horse-battery"}"#,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let cookie = format!(
        "omni_admin={}",
        token_of(&set_cookie(&headers).expect("cookie"))
    );
    let auth = [("cookie", cookie.as_str())];
    let (_, _, body) = call(&g.base, "GET", "/health", &[], "").await;
    let health: serde_json::Value = serde_json::from_str(&body).expect("health");
    let node = health["nodeId"].as_str().expect("node id");
    let (status, _, local) = call(&g.base, "GET", "/api/console", &auth, "").await;
    assert_eq!(status, 200, "{local}");
    for path in [
        "/api/console?node=".to_string(),
        format!("/api/console?node={node}"),
    ] {
        let (status, _, body) = call(&g.base, "GET", &path, &auth, "").await;
        assert_eq!((status, body.as_str()), (200, local.as_str()));
    }
    let (status, _, body) = call(
        &g.base,
        "GET",
        "/api/console?node=missing-d4-node",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, 504, "must not return local data: {body}");
    let (status, _, body) = call(&g.base, "GET", "/api/console?node=all", &auth, "").await;
    assert_eq!(status, 200, "{body}");
    let all: serde_json::Value = serde_json::from_str(&body).expect("fleet");
    assert!(all.get("unreachable").is_none(), "{all}");
    let local: serde_json::Value = serde_json::from_str(&local).expect("local");
    assert_eq!(
        all["source"],
        if local["source"] == "none" {
            "none"
        } else {
            "fleet"
        }
    );
    assert!(
        all["lines"]
            .as_array()
            .expect("lines")
            .iter()
            .all(|l| l["nodeId"] == node)
    );
}

#[tokio::test]
async fn admin_setup_login_status_logout_end_to_end() {
    let g = boot().await;
    let anon =
        r#"{"configured":false,"authenticated":false,"principal":null,"viewerConfigured":false}"#;
    let (s, h, b) = call(&g.base, "GET", "/api/status", &[], "").await;
    assert_eq!((s, b.as_str()), (200, anon));
    assert!(
        h.iter()
            .any(|(k, v)| k == "content-type" && v == "application/json;charset=utf-8")
    );

    let (s, _, b) = call(
        &g.base,
        "POST",
        "/api/setup",
        &[],
        r#"{"password":"short"}"#,
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(
        b,
        r#"{"error":{"code":"BAD_REQUEST","message":"admin password must be at least 12 characters"}}"#
    );
    let (s, h, b) = call(
        &g.base,
        "POST",
        "/api/setup",
        &[("x-forwarded-proto", "https")],
        r#"{"password":"correct-horse-battery"}"#,
    )
    .await;
    assert_eq!((s, b.as_str()), (200, r#"{"ok":true}"#));
    let cookie = set_cookie(&h).expect("cookie");
    assert!(
        cookie.ends_with("; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200"),
        "{cookie}"
    );
    let a = token_of(&cookie);
    let (s, _, _) = call(
        &g.base,
        "POST",
        "/api/setup",
        &[],
        r#"{"password":"correct-horse-battery"}"#,
    )
    .await;
    assert_eq!(s, 409);

    let admin = format!("omni_admin={a}");
    let (_, _, b) = call(&g.base, "GET", "/api/status", &[("cookie", &admin)], "").await;
    assert_eq!(
        b,
        r#"{"configured":true,"authenticated":true,"principal":{"kind":"admin"},"viewerConfigured":false}"#
    );

    let (s, _, b) = call(
        &g.base,
        "POST",
        "/api/login",
        &[],
        r#"{"password":"nope-nope-nope"}"#,
    )
    .await;
    assert_eq!(
        (s, b.as_str()),
        (
            401,
            r#"{"error":{"code":"AUTH","message":"invalid password"}}"#
        )
    );
    let (s, _, b) = call(&g.base, "POST", "/api/login", &[], "{bad").await;
    assert_eq!(
        (s, b.as_str()),
        (
            400,
            r#"{"error":{"code":"BAD_REQUEST","message":"invalid JSON body"}}"#
        )
    );

    let (s, h, _) = call(&g.base, "POST", "/api/logout", &[("cookie", &admin)], "").await;
    assert_eq!(s, 200);
    assert_eq!(
        set_cookie(&h).as_deref(),
        Some("omni_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
    );
    let (_, _, b) = call(&g.base, "GET", "/api/status", &[("cookie", &admin)], "").await;
    assert!(b.contains("\"authenticated\":false"), "{b}");

    // Unimplemented `/api` paths keep their fallthrough answers.
    let (s, _, b) = call(&g.base, "GET", "/api/unported", &[], "").await;
    assert_eq!(
        (s, b.as_str()),
        (
            404,
            r#"{"error":{"code":"NOT_FOUND","message":"no route for /api/unported"}}"#
        )
    );
    let (s, _, b) = call(&g.base, "POST", "/api/unported", &[], "").await;
    assert_eq!((s, b.as_str()), (404, "NOT_FOUND"));
    let (s, _, _) = call(&g.base, "POST", "/api/plugins", &[], "").await;
    assert_eq!(s, 501);
    drop(stop(g).await);
}

#[tokio::test]
async fn oversized_declared_bodies_are_413_off_v1_only() {
    let g = boot().await;
    let big = (128u64 * 1024 * 1024 + 1).to_string();
    for path in ["/api/login", "/api/logout", "/api/nope", "/anything"] {
        let mut s = TcpStream::connect(&g.base).await.expect("connect");
        let req = format!(
            "POST {path} HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {big}\r\n\r\n"
        );
        s.write_all(req.as_bytes()).await.expect("write");
        let mut out = Vec::new();
        s.read_to_end(&mut out).await.expect("read");
        let text = String::from_utf8_lossy(&out);
        assert!(text.starts_with("HTTP/1.1 413 "), "{path}: {text}");
        assert!(
            !text.to_ascii_lowercase().contains("\r\ndate:"),
            "{path}: {text}"
        );
    }
    // `/v1/*` keeps its own (smaller) limit and dialect error.
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let req = format!(
        "POST /v1/messages HTTP/1.1\r\nhost: x\r\nconnection: close\r\nauthorization: {}\r\ncontent-length: {big}\r\n\r\n",
        bearer(&g)
    );
    s.write_all(req.as_bytes()).await.expect("write");
    // A pre-routing 413 would answer at once; `/v1` instead waits for the
    // body it was promised.
    let mut buf = vec![0u8; 512];
    let early = tokio::time::timeout(Duration::from_millis(500), s.read(&mut buf)).await;
    assert!(early.is_err(), "/v1 answered before its body: {early:?}");
    drop(s);
    drop(stop(g).await);
}

/// Review A4-minor 1: a store failure during first setup is a 400
/// BAD_REQUEST with SQLite's message, and nothing is configured.
#[tokio::test]
async fn a_store_refused_setup_is_bad_request_with_sqlite_s_message() {
    let g = boot().await;
    rusqlite::Connection::open(&g.f.path)
        .expect("open")
        .execute_batch(
            "CREATE TRIGGER r BEFORE INSERT ON settings WHEN NEW.key = 'adminPasswordHash' \
             BEGIN SELECT RAISE(ABORT, 'review write denied'); END",
        )
        .expect("trigger");
    let (s, _, b) = call(
        &g.base,
        "POST",
        "/api/setup",
        &[],
        r#"{"password":"correct-horse-battery"}"#,
    )
    .await;
    assert_eq!(
        (s, b.as_str()),
        (
            400,
            r#"{"error":{"code":"BAD_REQUEST","message":"review write denied"}}"#
        )
    );
    let (_, _, b) = call(&g.base, "GET", "/api/status", &[], "").await;
    assert!(b.starts_with(r#"{"configured":false,"#), "{b}");
    drop(stop(g).await);
}

/// A5: keys, models, settings and passwords over `/api`, end to end: the
/// guards, a mint whose raw key authenticates on `/v1` within the
/// snapshot's poll, an edit, a revocation that stops it, and a password
/// change that ends the caller's own session.
#[tokio::test]
async fn admin_keys_models_settings_and_passwords_end_to_end() {
    let g = boot().await;
    let (_, h, _) = call(
        &g.base,
        "POST",
        "/api/setup",
        &[],
        r#"{"password":"correct-horse-battery"}"#,
    )
    .await;
    let admin = format!("omni_admin={}", token_of(&set_cookie(&h).expect("cookie")));
    let ck = [("cookie", admin.as_str())];

    let (s, _, b) = call(&g.base, "GET", "/api/keys", &[], "").await;
    assert_eq!(
        (s, b.as_str()),
        (
            401,
            r#"{"error":{"code":"AUTH","message":"admin session required"}}"#
        )
    );
    let (s, _, b) = call(&g.base, "POST", "/api/keys", &ck, r#"{"label":""}"#).await;
    assert_eq!(
        (s, b.as_str()),
        (
            400,
            r#"{"error":{"code":"BAD_REQUEST","message":"label: Too small: expected string to have >=1 characters"}}"#
        )
    );
    let (s, _, b) = call(&g.base, "POST", "/api/keys", &ck, r#"{"label":"api"}"#).await;
    assert_eq!(s, 200, "{b}");
    let created: serde_json::Value = serde_json::from_str(&b).expect("json");
    let raw = created["key"].as_str().expect("key").to_owned();
    let id = created["id"].as_str().expect("id").to_owned();
    assert_eq!(created["prefix"].as_str(), Some(&raw[..12]));

    // The snapshot refresher sees the commit within its poll (500 ms).
    let bearer_raw = format!("Bearer {raw}");
    let mut admitted = false;
    for _ in 0..50 {
        let (s, _, _) = call(
            &g.base,
            "GET",
            "/v1/models",
            &[("authorization", &bearer_raw)],
            "",
        )
        .await;
        if s == 200 {
            admitted = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(admitted, "a minted key is admitted within 1 s");

    let (s, _, b) = call(&g.base, "GET", "/api/keys", &ck, "").await;
    assert_eq!(s, 200);
    assert!(!b.contains(&raw), "the listing never carries a raw key");
    let (s, _, b) = call(
        &g.base,
        "PUT",
        &format!("/api/keys/{id}/limits"),
        &ck,
        r#"{"limits":{"requests":{"1m":5}}}"#,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(
        b.contains(r#""limitUsage":[{"dimension":"requests","window":"1m","limit":5,"used":0,"model":null}]"#),
        "{b}"
    );
    let (s, _, b) = call(
        &g.base,
        "PUT",
        "/api/keys/nope/limits",
        &ck,
        r#"{"limits":{}}"#,
    )
    .await;
    assert_eq!(
        (s, b.as_str()),
        (
            400,
            r#"{"error":{"code":"BAD_REQUEST","message":"no such api key"}}"#
        )
    );
    let (s, _, _) = call(&g.base, "DELETE", &format!("/api/keys/{id}"), &ck, "").await;
    assert_eq!(s, 200);
    let mut refused = false;
    for _ in 0..50 {
        let (s, _, _) = call(
            &g.base,
            "GET",
            "/v1/models",
            &[("authorization", &bearer_raw)],
            "",
        )
        .await;
        if s == 401 {
            refused = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(refused, "a revoked key is refused within 1 s");

    let (s, _, b) = call(&g.base, "PUT", "/api/models/m", &ck, r#"{"id":"x"}"#).await;
    assert_eq!(
        (s, b.as_str()),
        (
            400,
            r#"{"error":{"code":"BAD_REQUEST","message":"strategy: Invalid option: expected one of \"score\"|\"priority\"|\"roundRobin\"|\"weighted\""}}"#
        )
    );
    let (s, _, b) = call(&g.base, "GET", "/api/settings", &ck, "").await;
    assert_eq!(s, 200);
    assert!(
        b.ends_with(r#""viewerConfigured":false,"smartRouterModels":{"classifier":"unset","local":"unset"}}"#),
        "{b}"
    );

    let (s, _, b) = call(
        &g.base,
        "PUT",
        "/api/settings/password",
        &ck,
        r#"{"current":"correct-horse-battery","password":"short"}"#,
    )
    .await;
    assert_eq!(
        (s, b.as_str()),
        (
            400,
            r#"{"error":{"code":"BAD_REQUEST","message":"admin password must be at least 12 characters"}}"#
        )
    );
    let (s, _, _) = call(
        &g.base,
        "PUT",
        "/api/settings/password",
        &ck,
        r#"{"current":"correct-horse-battery","password":"another-password-1"}"#,
    )
    .await;
    assert_eq!(s, 200);
    let (s, _, _) = call(&g.base, "GET", "/api/keys", &ck, "").await;
    assert_eq!(s, 401, "a password change ends the caller's own session");
    drop(stop(g).await);
}
