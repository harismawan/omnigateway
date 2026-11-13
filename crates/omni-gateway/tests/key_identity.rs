//! A5 review round 1, over HTTP against an in-process gateway:
//!
//! - I1: model identity in key allowlists and per-model limits is exact
//!   UTF-16, as `Array.prototype.includes` and `Object.hasOwn` compare it.
//!   A lone surrogate is never the U+FFFD it is stored as, and two different
//!   lone surrogates are never each other.
//! - I2: one unreadable key row does not stop boot or the snapshot refresh;
//!   that key alone is refused, as TS's `findByHash` refuses it at auth.
//! - I3: admin summaries carry a fractional `revokedAt` as the number it is.
//!
//! Every expected answer here was taken from the frozen TS binary
//! (`/tmp/opencode/a5-fix1/probe`).

mod common;

use std::time::Duration;

use common::*;
use omni_gateway::{Options, start};
use omni_gateway_core::config::load_config;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct Gw {
    f: Fixture,
    base: String,
    running: Option<omni_gateway::Running>,
}

async fn boot_on(f: Fixture) -> Gw {
    let env: std::collections::HashMap<String, String> = [
        ("OMNI_ENCRYPTION_KEY", ENC),
        ("OMNI_DB_PATH", f.path.to_str().expect("path")),
        ("OMNI_PORT", "1"),
        ("OMNI_DAY_OFFSET_MINUTES", "0"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let mut config = load_config(&env, || 0).expect("config");
    config.port = 0;
    let running = start(config, Options::default()).await.expect("start");
    Gw {
        f,
        base: format!("127.0.0.1:{}", running.addr.port()),
        running: Some(running),
    }
}

async fn stop(mut g: Gw) {
    let r = g.running.take().expect("running");
    r.shutdown();
    r.wait().await.expect("clean shutdown");
}

async fn call(
    base: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, String) {
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
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .expect("status");
    (status, rest.to_owned())
}

/// A key row written as `KeyRepo.create` writes it, with raw column text.
fn key(path: &std::path::Path, id: &str, raw: &str, allowlist: Option<&str>, limits: &str) {
    rusqlite::Connection::open(path)
        .expect("open")
        .execute(
            "INSERT INTO api_keys (id,label,prefix,hash,model_allowlist,limits,created_at) VALUES (?,?,?,?,?,?,1)",
            rusqlite::params![
                id,
                id,
                omni_crypto::apikey::prefix(raw),
                omni_crypto::apikey::hash(raw),
                allowlist,
                limits
            ],
        )
        .expect("key");
}

fn model(path: &std::path::Path, id: &str) {
    rusqlite::Connection::open(path)
        .expect("open")
        .execute(
            r#"INSERT INTO virtual_models (id,targets,strategy) VALUES (?, '[{"provider":"custom","endpointId":"e0","model":"up","tier":1,"weight":1,"costPerMTok":{"input":1,"output":2},"capabilities":{"tools":true,"images":true,"reasoning":true}}]', 'score')"#,
            [id],
        )
        .expect("model");
}

fn chat(model: &str) -> String {
    format!(r#"{{"model":"{model}","messages":[{{"role":"user","content":"hi"}}]}}"#)
}

const NOT_ALLOWED: &str = r#"{"error":{"message":"model \"(unprintable)\" is not allowed for this API key","type":"invalid_request_error","code":"invalid_api_key"}}"#;

/// I1: allowlist `["\ud800","plain"]` against a model named U+FFFD.
#[tokio::test(flavor = "multi_thread")]
async fn a_lone_surrogate_never_matches_the_replacement_character_or_another_surrogate() {
    let f = fixture(&["c0"]);
    model(&f.path, "\u{fffd}");
    model(&f.path, "plain");
    key(
        &f.path,
        "k1",
        "sk-omni-k1",
        Some(r#"["\ud800","plain"]"#),
        "{}",
    );
    key(&f.path, "k2", "sk-omni-k2", Some(r#"["\ufffd"]"#), "{}");
    key(
        &f.path,
        "k3",
        "sk-omni-k3",
        None,
        r#"{"models":{"\ud800":{"concurrency":1},"\ufffd":{"requests":{"1m":1}}}}"#,
    );
    let g = boot_on(f).await;
    let auth = |k: &str| format!("Bearer sk-omni-{k}");

    // `/v1/models`: k1 sees `plain` only; k2 sees the U+FFFD model.
    let (s, b) = call(
        &g.base,
        "GET",
        "/v1/models",
        &[("authorization", &auth("k1"))],
        "",
    )
    .await;
    assert_eq!(s, 200);
    assert!(
        b.contains("\"first_id\":\"plain\",\"last_id\":\"plain\""),
        "{b}"
    );
    let (_, b) = call(
        &g.base,
        "GET",
        "/v1/models",
        &[("authorization", &auth("k2"))],
        "",
    )
    .await;
    assert!(b.contains("\"first_id\":\"\u{fffd}\""), "{b}");

    // Chat: k1 refuses U+FFFD (escaped and literal) and a different lone
    // surrogate; k2 refuses `\ud800`.
    for m in [r"\ufffd", "\u{fffd}", r"\ud801"] {
        let (s, b) = call(
            &g.base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", &auth("k1"))],
            &chat(m),
        )
        .await;
        assert_eq!((s, b.as_str()), (401, NOT_ALLOWED), "k1 {m}");
    }
    for m in [r"\ud800", r"\ud801", r" \ud800 ", r"\ud800[1m]"] {
        let (s, b) = call(
            &g.base,
            "POST",
            "/v1/chat/completions",
            &[("authorization", &auth("k2"))],
            &chat(m),
        )
        .await;
        assert_eq!((s, b.as_str()), (401, NOT_ALLOWED), "k2 {m}");
    }
    // `count_tokens` checks the same allowlist.
    let (s, _) = call(
        &g.base,
        "POST",
        "/v1/messages/count_tokens",
        &[("authorization", &auth("k1"))],
        &chat(r"\ufffd"),
    )
    .await;
    assert_eq!(s, 401);

    // A lone-surrogate model the key admits is TS's URIError, never served.
    let (s, b) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &[("authorization", &auth("k1"))],
        &chat(r"\ud800"),
    )
    .await;
    assert_eq!(s, 500, "{b}");
    assert!(
        b.contains("String contained an illegal UTF-16 sequence."),
        "{b}"
    );

    // Per-model limits: `\ud800` and U+FFFD are different overrides. A
    // count for U+FFFD is judged against U+FFFD's 1/min alone…
    let (s, _) = call(
        &g.base,
        "POST",
        "/v1/messages/count_tokens",
        &[("authorization", &auth("k3"))],
        &chat(r"\ufffd"),
    )
    .await;
    assert_eq!(s, 200);
    let (s, _) = call(
        &g.base,
        "POST",
        "/v1/messages/count_tokens",
        &[("authorization", &auth("k3"))],
        &chat(r"\ufffd"),
    )
    .await;
    assert_eq!(s, 429, "U+FFFD's own 1/min");
    // …and `\ud801` (no override of its own) is not U+FFFD's: 200, not 429.
    let (s, b) = call(
        &g.base,
        "POST",
        "/v1/messages/count_tokens",
        &[("authorization", &auth("k3"))],
        &chat(r"\ud801"),
    )
    .await;
    assert_eq!((s, b.as_str()), (200, r#"{"input_tokens":9}"#));
    // `\ud800` names its own override: TS's URIError building its subject.
    let (s, b) = call(
        &g.base,
        "POST",
        "/v1/messages/count_tokens",
        &[("authorization", &auth("k3"))],
        &chat(r"\ud800"),
    )
    .await;
    assert_eq!(
        (s, b.as_str()),
        (
            500,
            r#"{"type":"error","error":{"type":"api_error","message":"String contained an illegal UTF-16 sequence."}}"#
        )
    );
    stop(g).await;
}

/// I2 at boot: a key whose allowlist does not parse, and one with
/// fractional dates, leave the gateway booting and every other key served.
#[tokio::test(flavor = "multi_thread")]
async fn one_unreadable_key_row_does_not_stop_boot() {
    let f = fixture(&["c0"]);
    key(&f.path, "ok", "sk-omni-ok", None, "{}");
    key(&f.path, "bad", "sk-omni-bad", Some("{bad"), "{}");
    key(&f.path, "frac", "sk-omni-frac", None, "{}");
    rusqlite::Connection::open(&f.path)
        .expect("open")
        .execute_batch(
            "UPDATE api_keys SET created_at = 1700000000000.5, expires_at = 4102444800000.5 WHERE id = 'frac';
             INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,revoked_at) VALUES ('rev','r','p','h','{}',1,1.5);",
        )
        .expect("edit");
    let g = boot_on(f).await;
    for k in ["ok", "frac"] {
        let (s, b) = call(
            &g.base,
            "GET",
            "/v1/models",
            &[("authorization", &format!("Bearer sk-omni-{k}"))],
            "",
        )
        .await;
        assert_eq!(s, 200, "{k}: {b}");
    }
    let (s, b) = call(
        &g.base,
        "GET",
        "/v1/models",
        &[("authorization", "Bearer sk-omni-bad")],
        "",
    )
    .await;
    assert_eq!(
        (s, b.as_str()),
        (
            500,
            r#"{"type":"error","error":{"type":"api_error","message":"JSON Parse error: Expected '}'"}}"#
        )
    );
    stop(g).await;
}

/// I2 live: key A served from the snapshot, key B corrupted behind the
/// gateway's back, then A revoked through `/api`: A is refused within 1 s,
/// and a model added after the corruption is still picked up.
#[tokio::test(flavor = "multi_thread")]
async fn a_corrupt_key_does_not_freeze_revocation_of_another() {
    let f = fixture(&["c0"]);
    key(&f.path, "a", "sk-omni-a", None, "{}");
    key(&f.path, "b", "sk-omni-b", None, "{}");
    let g = boot_on(f).await;
    let a = [("authorization", "Bearer sk-omni-a")];
    let (s, _) = call(&g.base, "GET", "/v1/models", &a, "").await;
    assert_eq!(s, 200);

    let (_, h) = {
        let (s, _) = call(
            &g.base,
            "POST",
            "/api/setup",
            &[],
            r#"{"password":"correct-horse-battery"}"#,
        )
        .await;
        assert_eq!(s, 200);
        // Log in for the cookie (setup's cookie is not read by `call`).
        let mut s = TcpStream::connect(&g.base).await.expect("connect");
        let body = r#"{"password":"correct-horse-battery"}"#;
        s.write_all(format!("POST /api/login HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.expect("write");
        let mut out = String::new();
        s.read_to_string(&mut out).await.expect("read");
        ((), out)
    };
    let cookie = h
        .lines()
        .find_map(|l| l.strip_prefix("set-cookie: "))
        .and_then(|c| c.split(';').next())
        .expect("cookie")
        .to_owned();

    rusqlite::Connection::open(&g.f.path)
        .expect("open")
        .execute(
            "UPDATE api_keys SET model_allowlist = '{bad' WHERE id = 'b'",
            [],
        )
        .expect("corrupt");
    model(&g.f.path, "late");
    let (s, _) = call(&g.base, "DELETE", "/api/keys/a", &[("cookie", &cookie)], "").await;
    assert_eq!(s, 200);
    let started = std::time::Instant::now();
    let mut refused = false;
    while started.elapsed() < Duration::from_secs(1) {
        let (s, _) = call(&g.base, "GET", "/v1/models", &a, "").await;
        if s == 401 {
            refused = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        refused,
        "revoked key still served {:?} after the revoke",
        started.elapsed()
    );
    let (_, b) = call(&g.base, "GET", "/api/models", &[("cookie", &cookie)], "").await;
    assert!(b.contains("\"id\":\"late\""), "{b}");
    stop(g).await;
}

/// I3: `revokedAt` read as the stored number, on the listing and on an
/// edit's summary; the three dates as INTEGER, fractional REAL and null.
#[tokio::test(flavor = "multi_thread")]
async fn summaries_carry_fractional_dates_as_numbers() {
    let f = fixture(&["c0"]);
    let g = boot_on(f).await;
    let (_, _) = call(
        &g.base,
        "POST",
        "/api/setup",
        &[],
        r#"{"password":"correct-horse-battery"}"#,
    )
    .await;
    let mut s = TcpStream::connect(&g.base).await.expect("connect");
    let body = r#"{"password":"correct-horse-battery"}"#;
    s.write_all(format!("POST /api/login HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.expect("write");
    let mut out = String::new();
    s.read_to_string(&mut out).await.expect("read");
    let cookie = out
        .lines()
        .find_map(|l| l.strip_prefix("set-cookie: "))
        .and_then(|c| c.split(';').next())
        .expect("cookie")
        .to_owned();
    rusqlite::Connection::open(&g.f.path)
        .expect("open")
        .execute_batch(
            "INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,revoked_at,expires_at) VALUES
               ('r1','l','p1','h1','{}',1500000000000.5,1.5,2.25),
               ('r2','l','p2','h2','{}',1500000000001,7,8),
               ('r3','l','p3','h3','{}',1500000000002,NULL,NULL);",
        )
        .expect("rows");
    let ck = [("cookie", cookie.as_str())];
    let (s, b) = call(&g.base, "GET", "/api/keys", &ck, "").await;
    assert_eq!(s, 200, "{b}");
    assert!(
        b.contains(r#""createdAt":1500000000000.5,"revokedAt":1.5,"expiresAt":2.25"#),
        "{b}"
    );
    assert!(
        b.contains(r#""createdAt":1500000000001,"revokedAt":7,"expiresAt":8"#),
        "{b}"
    );
    assert!(
        b.contains(r#""createdAt":1500000000002,"revokedAt":null,"expiresAt":null"#),
        "{b}"
    );
    let (s, b) = call(
        &g.base,
        "PUT",
        "/api/keys/r1/smart-routing",
        &ck,
        r#"{"enabled":true}"#,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(
        b.contains(r#""createdAt":1500000000000.5,"revokedAt":1.5,"expiresAt":2.25"#),
        "{b}"
    );
    stop(g).await;
}

/// Review A5-R2 (the reviewer's repro, answers from the frozen binary): a
/// chat for `"\ud800"`, refused early, must not debit the genuine U+FFFD
/// override's live long window. TS debits the key-wide subject, then
/// `encodeURIComponent` throws before any model subject. After a restart
/// the U+FFFD seed reads the stored replacement-character row, in both
/// builds alike (TS: 200 live, 429 after restart).
#[tokio::test(flavor = "multi_thread")]
async fn an_early_refused_lone_model_never_debits_the_replacement_character_model() {
    let f = fixture(&["c0"]);
    key(
        &f.path,
        "kf",
        "sk-omni-kf",
        None,
        r#"{"models":{"\ufffd":{"requests":{"5h":1}}}}"#,
    );
    let g = boot_on(f).await;
    let auth = [("authorization", "Bearer sk-omni-kf")];
    let count = |g: &Gw| {
        let base = g.base.clone();
        async move {
            call(
                &base,
                "POST",
                "/v1/messages/count_tokens",
                &auth,
                &chat(r"\ufffd"),
            )
            .await
            .0
        }
    };
    // Seeds U+FFFD's 5h window (a count writes no row).
    assert_eq!(count(&g).await, 200);
    tokio::time::sleep(Duration::from_millis(600)).await;
    let (s, _) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &auth,
        &chat(r"\ud800"),
    )
    .await;
    assert_eq!(s, 500);
    // The refused row commits and is delivered to the limiter (writer batch).
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(count(&g).await, 200, "live: the U+FFFD budget is untouched");
    assert_eq!(count(&g).await, 200);
    let f = {
        let mut g = g;
        let r = g.running.take().expect("running");
        r.shutdown();
        r.wait().await.expect("stop");
        g.f
    };
    let g = boot_on(f).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        count(&g).await,
        429,
        "after restart the seed reads the stored U+FFFD row, as TS's does"
    );
    stop(g).await;
}

/// The other half of review A5-R2: the same refused request *is* a completed
/// request against the key-wide subject, as in TS, whose `debit` adds to the
/// key's buckets before `modelSubjectId` throws (frozen binary: 200, 500,
/// then 429).
#[tokio::test(flavor = "multi_thread")]
async fn an_early_refused_lone_model_still_debits_the_key_wide_subject() {
    let f = fixture(&["c0"]);
    key(
        &f.path,
        "kw",
        "sk-omni-kw",
        None,
        r#"{"requests":{"5h":1}}"#,
    );
    let g = boot_on(f).await;
    let auth = [("authorization", "Bearer sk-omni-kw")];
    let count = |g: &Gw| {
        let base = g.base.clone();
        async move {
            call(
                &base,
                "POST",
                "/v1/messages/count_tokens",
                &auth,
                &chat("plain"),
            )
            .await
            .0
        }
    };
    // Seeds the key's 5h window (a count writes no row).
    assert_eq!(count(&g).await, 200);
    tokio::time::sleep(Duration::from_millis(600)).await;
    let (s, _) = call(
        &g.base,
        "POST",
        "/v1/chat/completions",
        &auth,
        &chat(r"\ud800"),
    )
    .await;
    assert_eq!(s, 500);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        count(&g).await,
        429,
        "the key's one request per 5 h is spent"
    );
    stop(g).await;
}
