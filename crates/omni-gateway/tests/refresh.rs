#![allow(clippy::unwrap_used)]
use omni_gateway::refresh::Refresher;

#[test]
fn refresher_is_a_shared_service() {
    fn shared<T: Send + Sync>() {}
    shared::<Refresher>();
}

struct Fake {
    status: u16,
    calls: AtomicUsize,
}
struct DeepToken;
struct LocalOAuth {
    url: String,
    client: omni_providers::http::Client,
}
impl HttpClient for LocalOAuth {
    fn send(
        &self,
        mut request: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
    > {
        assert_eq!(request.url, "https://auth.openai.com/oauth/token");
        request.url.clone_from(&self.url);
        Box::pin(self.client.send(request))
    }
}

#[tokio::test]
async fn openai_local_endpoint_retry_id_token_and_cas_loser() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_dir, mut service, _, _) = fixture(200).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/oauth/token", listener.local_addr().unwrap());
    Arc::get_mut(&mut service).unwrap().http = Arc::new(LocalOAuth {
        url,
        client: omni_providers::http::Client::new(),
    });
    Arc::get_mut(&mut service).unwrap().lock = Arc::new(Unavailable);
    if let Store::Sqlite { store, .. } = service.store.as_ref() {
        store
            .lock()
            .unwrap()
            .connection()
            .execute(
                "UPDATE credentials SET provider='openai',provider_data='{\"extra\":true}'",
                [],
            )
            .unwrap();
    }
    let c = service
        .store
        .credential(&service.key, "c")
        .await
        .unwrap()
        .unwrap();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut ready = Some(ready_tx);
        let mut release = Some(release_rx);
        for status in [503, 200, 200] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buf = [0; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&bytes);
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length: usize = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap()
                        .parse()
                        .unwrap();
                    if body.len() >= length {
                        assert!(body.contains("grant_type=refresh_token"));
                        break;
                    }
                }
            }
            if status == 200 && ready.is_some() {
                ready.take().unwrap().send(()).unwrap();
                release.take().unwrap().await.unwrap();
            }
            let body = r#"{"access_token":"local","id_token":"h.eyJlbWFpbCI6Im1haWwifQ.s"}"#;
            socket.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    assert_eq!(
        service.refresh(&c).await.unwrap_err().code,
        ErrorCode::Upstream
    );
    let task = {
        let service = service.clone();
        let c = c.clone();
        tokio::spawn(async move { service.refresh(&c).await })
    };
    ready_rx.await.unwrap();
    let update = omni_store::credentials::TokenUpdate {
        access_token: Some("winner".into()),
        refresh_token: Some("old".into()),
        api_key: None,
        id_token: None,
        expires_at: Some(1),
        updated_at: 99,
    };
    assert!(
        service
            .store
            .update_tokens(&service.key, "c", &update, 0)
            .await
            .unwrap()
    );
    service
        .store
        .refresh_metadata_with_data(
            "c",
            Some("winner-mail".into()),
            Some("{\"winner\":true}".into()),
            99,
        )
        .await
        .unwrap();
    release_tx.send(()).unwrap();
    assert_eq!(
        task.await.unwrap().unwrap().access_token.as_deref(),
        Some("winner")
    );
    let stored = service
        .store
        .credential(&service.key, "c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.provider_data, serde_json::json!({"winner":true}));
    assert_eq!(stored.account_email.as_deref(), Some("winner-mail"));
    let secrets = service.refresh(&stored).await.unwrap();
    assert_eq!(
        secrets.id_token.as_deref(),
        Some("h.eyJlbWFpbCI6Im1haWwifQ.s")
    );
    assert_eq!(secrets.refresh_token.as_deref(), Some("old"));
    let stored = service
        .store
        .credential(&service.key, "c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.account_email.as_deref(), Some("mail"));
    assert_eq!(stored.provider_data["winner"], true);
    assert_eq!(stored.provider_data["idSalt"].as_str().unwrap().len(), 64);
    assert_eq!(stored.token_version, 2);
    server.await.unwrap();
}
impl HttpClient for DeepToken {
    fn send(
        &self,
        _: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
    > {
        Box::pin(async {
            let body = format!(
                "{{\"access_token\":\"a\",\"refresh_token\":{}\"r\"{}}}",
                "[".repeat(40000),
                "]".repeat(40000)
            );
            Ok(HttpResponse {
                status: 200,
                headers: Headers::new(),
                body: ResponseBody::from_bytes(body),
            })
        })
    }
}
#[test]
fn deep_token_host_subprocess() {
    if std::env::var_os("OMNI_DEEP_TOKEN_CHILD").is_some() {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        let (_dir, mut service, _, c) = fixture(200).await;
                        Arc::get_mut(&mut service).unwrap().http = Arc::new(DeepToken);
                        let secrets = service.refresh(&c).await.unwrap();
                        assert_eq!(secrets.refresh_token.as_deref(), Some("r"));
                    });
            })
            .unwrap()
            .join()
            .unwrap();
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "deep_token_host_subprocess"])
        .env("OMNI_DEEP_TOKEN_CHILD", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
struct Unavailable;
impl omni_gateway::refresh::RefreshLock for Unavailable {
    fn acquire(
        &self,
        _: String,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Option<Box<dyn omni_gateway::refresh::RefreshGuard>>>
                + Send
                + '_,
        >,
    > {
        Box::pin(async { None })
    }
}
impl HttpClient for Fake {
    fn send(
        &self,
        _: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
    > {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            Ok(HttpResponse {
                status: self.status,
                headers: Headers::new(),
                body: ResponseBody::from_bytes(
                    r#"{"access_token":"new","refresh_token":"rotation","expires_in":3600,"account":{"email_address":"new@example.com"}}"#,
                ),
            })
        })
    }
}
async fn fixture(
    status: u16,
) -> (
    tempfile::TempDir,
    Arc<Refresher>,
    Arc<Fake>,
    omni_store::Credential,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");
    let db = omni_store::SqliteStore::open(&path, 0).unwrap();
    let key = omni_crypto::field::derive_key("refresh-test");
    db.connection().execute("INSERT INTO credentials (id,provider,label,auth_type,refresh_token,created_at,updated_at) VALUES ('c','anthropic','c','oauth','old',0,0)", []).unwrap();
    db.connection()
        .execute(
            "UPDATE credentials SET refresh_token=?",
            [omni_crypto::field::encrypt(&key, "old")],
        )
        .unwrap();
    drop(db);
    let store = Arc::new(Store::open(StoreConfig::Sqlite { path }, 0).await.unwrap());
    let c = store.credential(&key, "c").await.unwrap().unwrap();
    let http = Arc::new(Fake {
        status,
        calls: AtomicUsize::new(0),
    });
    let service = Arc::new(Refresher::new(store, key, http.clone(), || 1000));
    (dir, service, http, c)
}
#[tokio::test]
async fn sweep_refreshes_due_rows_and_disables_expired_without_token() {
    let (_dir, service, http, _) = fixture(200).await;
    if let Store::Sqlite { store, .. } = service.store.as_ref() {
        let db = store.lock().unwrap();
        db.connection()
            .execute("UPDATE credentials SET expires_at=1001", [])
            .unwrap();
        db.connection().execute("INSERT INTO credentials (id,provider,label,auth_type,expires_at,created_at,updated_at) VALUES ('empty','anthropic','empty','oauth',1,0,0)", []).unwrap();
    }
    assert_eq!(service.sweep(None).await.unwrap(), 1);
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    let empty = service
        .store
        .credential(&service.key, "empty")
        .await
        .unwrap()
        .unwrap();
    assert!(!empty.enabled);
    assert_eq!(empty.disabled_reason.unwrap().as_str(), "expiredNoRefresh");
    assert_eq!(service.sweep(None).await.unwrap(), 0);
}

#[tokio::test]
async fn drain_waits_for_detached_rotation_to_persist() {
    let (_dir, service, http, c) = fixture(200).await;
    let caller = {
        let service = service.clone();
        tokio::spawn(async move { service.refresh(&c).await })
    };
    while http.calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    service.drain().await;
    let row = service
        .store
        .credential(&service.key, "c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.token_version, 1);
    assert_eq!(row.secrets.access_token.as_deref(), Some("new"));
}

#[tokio::test]
async fn openai_expired_refresh_retains_identity_and_extra_metadata() {
    let (_dir, service, http, _) = fixture(200).await;
    let prior = serde_json::json!({"accountId":"workspace", "installationId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "idSalt":"a".repeat(64), "extra":{"keep":true}});
    if let Store::Sqlite { store, .. } = service.store.as_ref() {
        store
            .lock()
            .unwrap()
            .connection()
            .execute(
                "UPDATE credentials SET provider='openai', expires_at=1, provider_data=?",
                [prior.to_string()],
            )
            .unwrap();
    }
    assert_eq!(service.sweep(None).await.unwrap(), 1);
    let stored = service
        .store
        .credential(&service.key, "c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.provider_data, prior);
    assert_eq!(stored.secrets.access_token.as_deref(), Some("new"));
    assert_eq!(stored.secrets.refresh_token.as_deref(), Some("rotation"));
    assert_eq!(stored.token_version, 1);
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn openai_exchange_create_and_reconnect_replace_metadata() {
    let (_dir, service, _, _) = fixture(200).await;
    let mut prior = serde_json::json!({});
    for reconnect in [false, true] {
        let result = omni_providers::openai::oauth::token_result(200, r#"{"access_token":"exchange","refresh_token":"r","id_token":"h.eyJlbWFpbCI6Im1haWwifQ.s"}"#, None, 1000.0, &prior).unwrap();
        let data = serde_json::Value::Object(result.provider_data);
        if reconnect {
            assert_eq!(data["installationId"], prior["installationId"]);
            assert_eq!(data["idSalt"], prior["idSalt"]);
            assert!(data.get("extra").is_none());
        }
        let tokens = omni_store::credentials::TokenUpdate {
            access_token: Some(String::from_utf16_lossy(&result.access_token)),
            refresh_token: Some("r".into()),
            api_key: None,
            id_token: result.id_token.map(|s| String::from_utf16_lossy(&s)),
            expires_at: None,
            updated_at: 1000,
        };
        service
            .store
            .save_oauth(
                &service.key,
                &omni_store::credentials::OAuthCredential {
                    id: "exchange",
                    provider: "openai",
                    label: "label",
                    provider_data: &data.to_string(),
                    account_email: Some("mail"),
                    tokens: &tokens,
                    reconnect,
                },
            )
            .await
            .unwrap();
        let stored = service
            .store
            .credential(&service.key, "exchange")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.secrets.access_token.as_deref(), Some("exchange"));
        assert_eq!(stored.provider_data, data);
        assert!(stored.enabled);
        assert_eq!(stored.disabled_reason, None);
        assert_eq!(stored.token_version, i64::from(reconnect));
        prior = data;
        prior["extra"] = serde_json::json!(true);
        if let Store::Sqlite { store, .. } = service.store.as_ref() {
            let db = store.lock().unwrap();
            let raw: String = db
                .connection()
                .query_row(
                    "SELECT id_token FROM credentials WHERE id='exchange'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_ne!(Some(raw.as_str()), tokens.id_token.as_deref());
            db.connection().execute("UPDATE credentials SET enabled=0,disabled_reason='tokenRejected',disabled_at=1,provider_data=? WHERE id='exchange'",[prior.to_string()]).unwrap();
        }
    }
}

#[tokio::test]
async fn unreadable_refresh_is_internal_not_auth_and_keeps_enabled() {
    let (_dir, service, http, c) = fixture(200).await;
    if let Store::Sqlite { store, .. } = service.store.as_ref() {
        store
            .lock()
            .unwrap()
            .connection()
            .execute("UPDATE credentials SET refresh_token='broken'", [])
            .unwrap();
    }
    let error = service.refresh(&c).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(error.message, "malformed ciphertext");
    assert_eq!(http.calls.load(Ordering::SeqCst), 0);
    assert!(
        service
            .store
            .credential(&service.key, "c")
            .await
            .unwrap()
            .unwrap()
            .enabled
    );
}

#[tokio::test]
async fn unrelated_corrupt_row_cannot_break_refresh() {
    let (_dir, service, _, c) = fixture(200).await;
    if let Store::Sqlite { store, .. } = service.store.as_ref() {
        store.lock().unwrap().connection().execute("INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('corrupt','anthropic','bad','oauth','not-json',0,0)",[]).unwrap();
    }
    assert_eq!(
        service.refresh(&c).await.unwrap().access_token.as_deref(),
        Some("new")
    );
}

#[tokio::test]
async fn cancellation_drops_only_the_waiter_not_shared_rotation() {
    let (_dir, service, http, c) = fixture(200).await;
    let waiting = {
        let service = service.clone();
        let c = c.clone();
        tokio::spawn(async move { service.refresh(&c).await })
    };
    while http.calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    let result = service.refresh(&c).await.unwrap();
    assert_eq!(result.access_token.as_deref(), Some("new"));
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn success_coalesces_and_stale_views_deduplicate() {
    let (_dir, service, http, c) = fixture(200).await;
    let (a, b) = tokio::join!(service.refresh(&c), service.refresh(&c));
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        service.refresh(&c).await.unwrap().access_token.as_deref(),
        Some("new")
    );
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    let stored = service
        .store
        .credential(&service.key, "c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.token_version, 1);
    assert_eq!(stored.account_email.as_deref(), Some("new@example.com"));
}
#[tokio::test]
async fn failures_are_shared_but_not_cached_and_rejection_disables() {
    for (status, code, enabled) in [
        (400, ErrorCode::Auth, false),
        (429, ErrorCode::RateLimit, true),
        (503, ErrorCode::Upstream, true),
    ] {
        let (_dir, service, http, c) = fixture(status).await;
        let (a, b) = tokio::join!(service.refresh(&c), service.refresh(&c));
        assert_eq!(a.unwrap_err().code, code);
        assert_eq!(b.unwrap_err().code, code);
        assert_eq!(http.calls.load(Ordering::SeqCst), 1);
        let stored = service
            .store
            .credential(&service.key, "c")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.enabled, enabled);
        assert_eq!(stored.token_version, 0);
        assert_eq!(stored.account_email, None);
        if !enabled {
            assert_eq!(stored.disabled_reason.unwrap().as_str(), "tokenRejected");
        }
        assert_eq!(service.refresh(&c).await.unwrap_err().code, code);
        assert_eq!(http.calls.load(Ordering::SeqCst), 2);
    }
}
#[tokio::test]
async fn missing_token_and_unsupported_provider_do_not_call_transport() {
    let (_dir, service, http, mut c) = fixture(200).await;
    // Missing rows exercise the supplied view, just as frozen TS does.
    c.id = "missing".into();
    c.provider = "unsupported".into();
    assert_eq!(
        service.refresh(&c).await.unwrap_err().code,
        ErrorCode::BadRequest
    );
    c.secrets.refresh_token = omni_store::Secret::Absent;
    assert_eq!(service.refresh(&c).await.unwrap_err().code, ErrorCode::Auth);
    assert_eq!(http.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn unavailable_lock_fails_open_and_cas_loser_preserves_winner_metadata() {
    let (_dir, mut service, http, c) = fixture(200).await;
    Arc::get_mut(&mut service).unwrap().lock = Arc::new(Unavailable);
    let task = {
        let service = service.clone();
        tokio::spawn(async move { service.refresh(&c).await })
    };
    while http.calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    let update = omni_store::credentials::TokenUpdate {
        access_token: Some("winner".into()),
        refresh_token: Some("winner-rotation".into()),
        api_key: None,
        id_token: None,
        expires_at: None,
        updated_at: 99,
    };
    assert!(
        service
            .store
            .update_tokens(&service.key, "c", &update, 0)
            .await
            .unwrap()
    );
    assert_eq!(
        task.await.unwrap().unwrap().access_token.as_deref(),
        Some("winner")
    );
    let c = service
        .store
        .credential(&service.key, "c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(c.account_email, None);
    assert_eq!(c.updated_at, 99);
    assert_eq!(http.calls.load(Ordering::SeqCst), 1);
}
use omni_ir::error::ErrorCode;
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};
use omni_store::{Store, StoreConfig};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
