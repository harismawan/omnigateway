use omni_gateway_core::snapshot::{MissConfig, MissResolver, MissResult, SnapshotHolder};
use omni_store::{Store, StoreConfig};
use std::sync::Arc;

#[tokio::test]
async fn actual_postgres_boot_miss_and_config_version_backstop() {
    let Ok(url) = std::env::var("OMNI_TEST_DATABASE_URL") else {
        assert_ne!(std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(), Ok("1"));
        return;
    };
    let name = format!("omni_d4_core_{}", std::process::id());
    let (authority, _) = url.rsplit_once('/').expect("test database url");
    let authority = authority.to_owned();
    // This target is run only in D4's new disposable PG namespace.
    let bootstrap = Store::open(StoreConfig::Postgres(omni_store::pg::PgConfig::new(url)), 0)
        .await
        .expect("bootstrap");
    let Store::Postgres(pg) = bootstrap else {
        panic!("PG");
    };
    pg.client()
        .await
        .expect("admin")
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .expect("isolated db");
    let store = Arc::new(
        Store::open(
            StoreConfig::Postgres(omni_store::pg::PgConfig::new(format!("{authority}/{name}"))),
            0,
        )
        .await
        .expect("primary"),
    );
    let holder = Arc::new(
        SnapshotHolder::build_from(store.clone(), omni_crypto::field::derive_key("test"), 0.0)
            .await
            .expect("PG boot"),
    );
    let miss = MissResolver::from_backend(holder.clone(), store.clone(), MissConfig::default());
    let Store::Postgres(pg) = store.as_ref() else {
        panic!("PG");
    };
    pg.client().await.expect("operator").batch_execute("INSERT INTO api_keys(id,label,prefix,hash,created_at,limits) VALUES('key','key','key','hash',0,'{}')").await.expect("key");
    assert!(matches!(
        miss.resolve("hash").await,
        MissResult::Found(Ok(_))
    ));
    let refresher = holder
        .clone()
        .spawn_backend_refresher(store.clone(), std::time::Duration::from_millis(10));
    pg.client()
        .await
        .expect("operator")
        .batch_execute("UPDATE api_keys SET revoked_at=1 WHERE id='key'")
        .await
        .expect("revoke");
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if holder
                .load()
                .keys_by_hash
                .get("hash")
                .expect("key")
                .as_ref()
                .expect("readable")
                .revoked_at
                .is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("PG backstop publishes revoke");
    refresher.abort();
    assert!(refresher.await.expect_err("cancelled").is_cancelled());
    holder.drain_publications().await;
    // Preserve this execution DB as evidence; service cleanup is controller-owned.
}

#[tokio::test]
async fn backend_boot_miss_and_backstop_publish_without_sqlite_specific_callers() {
    let dir = tempfile::tempdir().expect("private root");
    let path = dir.path().join("gateway.db");
    let store = Arc::new(
        Store::open(StoreConfig::Sqlite { path: path.clone() }, 0)
            .await
            .expect("store"),
    );
    let holder = Arc::new(
        SnapshotHolder::build_from(store.clone(), omni_crypto::field::derive_key("test"), 0.0)
            .await
            .expect("boot"),
    );
    let miss = MissResolver::from_backend(holder.clone(), store.clone(), MissConfig::default());
    let db = omni_store::SqliteStore::open(path, 0).expect("operator");
    db.connection().execute_batch("INSERT INTO api_keys(id,label,prefix,hash,created_at,limits) VALUES('key','key','key','hash',0,'{}')").expect("new key");
    assert!(matches!(
        miss.resolve("hash").await,
        MissResult::Found(Ok(_))
    ));
    assert_eq!(miss.reads(), 1);
    assert!(matches!(
        miss.resolve("hash").await,
        MissResult::Found(Ok(_))
    ));
    assert_eq!(miss.reads(), 1, "warm lookup does not query the backend");
    let refresher = holder
        .clone()
        .spawn_backend_refresher(store, std::time::Duration::from_millis(10));
    db.connection()
        .execute("UPDATE api_keys SET revoked_at=1 WHERE id='key'", [])
        .expect("revoke");
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if holder
                .load()
                .keys_by_hash
                .get("hash")
                .expect("key")
                .as_ref()
                .expect("readable")
                .revoked_at
                .is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("backstop publishes revoke");
    refresher.abort();
    assert!(
        refresher
            .await
            .expect_err("cancelled refresher")
            .is_cancelled()
    );
    holder.drain_publications().await;
}
