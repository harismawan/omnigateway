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
