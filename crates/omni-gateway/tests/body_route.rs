#![allow(clippy::unwrap_used)]
mod common;
use omni_gateway::{
    admin_auth::{self, SessionKv},
    admin_routes, server,
};
use omni_gateway_core::{
    ratelimit::RateLimiter,
    snapshot::{MissConfig, MissResolver},
};
use omni_ir::jsjson::{parse_js, stringify};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn frozen_body_route_matrix() {
    let f = common::fixture(&["c0"]);
    let h = common::harness(&f, vec![]);
    let store = || omni_store::SqliteStore::open(&f.path, 0).unwrap();
    let clock: admin_auth::Clock = Arc::new(|| 0);
    let kv = Arc::new(admin_auth::MemoryKv::new(clock.clone()));
    for role in ["admin", "viewer"] {
        kv.set(
            &omni_crypto::session::key(role, role),
            &format!(r#"{{"expiresAt":60000,"principal":{{"kind":"{role}"}}}}"#),
            60000,
        )
        .await
        .unwrap();
    }
    let app = Arc::new(server::App {
        database_swap: tokio::sync::Mutex::new(()),
        quiesce: Arc::new(omni_gateway::quiesce::Quiesce::default()),
        lifecycle: omni_gateway::lifecycle::Lifecycle::default(),
        version: "0.0.0-dev".into(),
        cluster: false,
        stop: tokio::sync::watch::channel(false).0,
        deadline_workers: server::DeadlineWorkers::new(),
        miss: MissResolver::new(
            h.deps.holder.clone(),
            Arc::new(Mutex::new(store())),
            MissConfig::default(),
        ),
        deps: h.deps.clone(),
        limiter: RateLimiter::new(),
        node_id: "body-route".into(),
        keepalive: Duration::from_secs(10),
        idle_timeout: Duration::from_secs(20),
        bench_endpoints: false,
        bench_flush_timeout: Duration::from_secs(2),
        metrics_token: None,
        static_root: None,
        admin: admin_auth::AdminAuth::new(store(), kv, clock, 60000),
        base_url_https: false,
        control: admin_routes::ControlStore::new(store()),
        credential_key: common::key(),
        connect: Arc::new(omni_gateway::connect::ConnectFlows::default()),
        body_logging_allowed: true,
        day_offset_minutes: 0,
        reported_catalog_problems: Mutex::default(),
        stream: Default::default(),
    });
    let artifact = parse_js(r#"{"requestId":"foreign","at":0,"client":{"request":"\ud800","response":null},"attempts":[],"error":null}"#).unwrap();
    let row = store().put_body(&common::key(), &artifact).unwrap();
    store()
        .connection()
        .execute(
            "UPDATE request_bodies SET request_id='present' WHERE request_id='foreign'",
            [],
        )
        .unwrap();
    let path = f
        .dir
        .path()
        .join("request_bodies")
        .join(row.rel_path.as_ref().unwrap());
    let bytes = std::fs::read(&path).unwrap();
    let mut cells = vec![];
    let mut actual = vec![];
    for state in [
        "absent",
        "ready",
        "missing",
        "corrupt",
        "recovered",
        "wrong-key",
        "none",
        "null-path",
    ] {
        match state {
            "missing" => std::fs::remove_file(&path).unwrap(),
            "corrupt" => std::fs::write(&path, "bad").unwrap(),
            "recovered" => std::fs::write(&path, &bytes).unwrap(),
            "wrong-key" => {
                let sealed = omni_store::pg::bodies::seal(
                    &omni_crypto::field::derive_key("foreign-encryption-key"),
                    &stringify(&artifact).unwrap(),
                )
                .unwrap();
                std::fs::write(&path, &sealed.bytes).unwrap();
                store()
                    .connection()
                    .execute(
                        "UPDATE request_bodies SET sha256=?,size_bytes=?",
                        rusqlite::params![sealed.sha256, sealed.bytes.len() as i64],
                    )
                    .unwrap();
            }
            "none" => {
                store()
                    .connection()
                    .execute("UPDATE request_bodies SET detail_state='alien'", [])
                    .unwrap();
            }
            "null-path" => {
                store()
                    .connection()
                    .execute(
                        "UPDATE request_bodies SET detail_state='ready',rel_path=NULL",
                        [],
                    )
                    .unwrap();
            }
            _ => {}
        }
        for role in ["admin", "viewer", "none"] {
            let id = if state == "absent" {
                "absent"
            } else {
                "present"
            };
            let target = format!("/api/requests/{id}/body");
            let read = store().get_body(&common::key(), id).unwrap().map(|r| {
                let a = r.artifact.as_ref().map(|a| stringify(a).unwrap()).unwrap_or("null".into());
                format!(r#"{{"row":{{"requestId":"present","detailState":"{}","truncated":{},"sizeBytes":{},"at":{}}},"artifact":{a}}}"#,
                    r.row.detail_state.as_str(), r.row.truncated, stringify(&r.row.size_bytes).unwrap(), stringify(&r.row.at).unwrap())
            }).unwrap_or("null".into());
            cells.push(format!(
                r#"{{"role":"{role}","path":"{target}","read":{read}}}"#
            ));
            actual.push(request(app.clone(), &target, role).await);
        }
    }
    for target in [
        "/api/requests/a%2Fb/body",
        "/api/requests/%C3%A9/body",
        "/api/requests/%25/body",
        "/api/requests/%FF/body",
        "/api/requests/%ZZ/body",
    ] {
        cells.push(format!(
            r#"{{"role":"admin","path":"{target}","read":null}}"#
        ));
        actual.push(request(app.clone(), target, "admin").await);
    }
    let mut child = Command::new("bun")
        .args(["--no-env-file", "conformance/store/body-route-reference.ts"])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("[{}]", cells.join(",")).as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(actual, expected);
    h.writer.close().await.unwrap();
    println!("29 frozen route cases");
}

async fn request(app: Arc<server::App>, target: &str, role: &str) -> Value {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let svc = hyper::service::service_fn(move |req| server::handle(app.clone(), req));
        omni_gateway::http1_builder(Duration::from_secs(20))
            .serve_connection(hyper_util::rt::TokioIo::new(socket), svc)
            .await
            .unwrap();
    });
    let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
    let cookie = if role == "none" {
        String::new()
    } else {
        format!("Cookie: omni_admin={role}\r\n")
    };
    socket
        .write_all(
            format!(
                "GET {target} HTTP/1.1\r\nHost: localhost\r\n{cookie}Connection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).await.unwrap();
    task.await.unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    let header = |name: &str| {
        head.lines().skip(1).find_map(|line| {
            let (k, v) = line.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim().to_owned())
        })
    };
    json!({"status":head.split_whitespace().nth(1).unwrap().parse::<u16>().unwrap(), "type":header("content-type"), "cache":header("cache-control"), "body":body})
}
