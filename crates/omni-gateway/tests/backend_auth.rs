use omni_gateway::admin_auth::{AdminAuth, CoordKv, Principal, SESSION_TTL_MS};
use std::sync::Arc;

#[tokio::test]
async fn actual_pg_auth_and_redis_sessions_cross_process_dependencies() {
    let (Ok(url), Ok(redis_url)) = (
        std::env::var("OMNI_TEST_DATABASE_URL"),
        std::env::var("OMNI_TEST_REDIS_URL"),
    ) else {
        assert_ne!(std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(), Ok("1"));
        return;
    };
    let store = Arc::new(
        omni_store::Store::open(
            omni_store::StoreConfig::Postgres(omni_store::pg::PgConfig::new(url)),
            0,
        )
        .await
        .expect("PG"),
    );
    let one = Arc::new(
        omni_coord::redis::RedisCoord::connect(&redis_url, Default::default())
            .await
            .expect("coord A"),
    );
    let two = Arc::new(
        omni_coord::redis::RedisCoord::connect(&redis_url, Default::default())
            .await
            .expect("coord B"),
    );
    let now: omni_gateway::admin_auth::Clock = Arc::new(|| 1000);
    let a = AdminAuth::from_backend(
        store.clone(),
        Arc::new(CoordKv::new(one.clone())),
        now.clone(),
        SESSION_TTL_MS,
    );
    let b = AdminAuth::from_backend(
        store,
        Arc::new(CoordKv::new(two.clone())),
        now,
        SESSION_TTL_MS,
    );
    a.set_password("private-test-password")
        .await
        .expect("password");
    let token = a
        .login("private-test-password")
        .await
        .expect("login")
        .expect("session");
    assert_eq!(
        b.verify(&token).await.expect("shared verify"),
        Some(Principal::Admin)
    );
    b.logout(&token).await.expect("remote logout");
    assert_eq!(a.verify(&token).await.expect("shared invalidation"), None);
    one.close();
    two.close();
}

#[tokio::test]
async fn backend_auth_shares_setup_password_and_session_invalidation() {
    let dir = tempfile::tempdir().expect("root");
    let store = Arc::new(
        omni_store::Store::open(
            omni_store::StoreConfig::Sqlite {
                path: dir.path().join("db"),
            },
            0,
        )
        .await
        .expect("store"),
    );
    let now: omni_gateway::admin_auth::Clock = Arc::new(|| 1000);
    let kv = Arc::new(CoordKv::new(Arc::new(omni_coord::MemoryCoord::new(
        Arc::new(|| 1000.0),
    ))));
    let a = AdminAuth::from_backend(store.clone(), kv.clone(), now.clone(), SESSION_TTL_MS);
    let b = AdminAuth::from_backend(store, kv, now, SESSION_TTL_MS);
    assert!(
        a.set_initial_password("twelve-chars-password")
            .await
            .expect("setup")
    );
    assert!(
        !b.set_initial_password("different-password")
            .await
            .expect("atomic setup")
    );
    let token = a
        .login("twelve-chars-password")
        .await
        .expect("login")
        .expect("session");
    assert_eq!(
        b.verify(&token).await.expect("verify"),
        Some(Principal::Admin)
    );
    b.set_password("new-password-12345").await.expect("replace");
    assert_eq!(a.verify(&token).await.expect("invalidated"), None);
    assert!(
        a.login("new-password-12345")
            .await
            .expect("new login")
            .is_some()
    );
}
