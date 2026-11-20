use omni_store::pg::{PgConfig, PgStore};

#[tokio::test]
async fn configured_tls_connects_and_encrypts_every_pool_connection() {
    let Ok(url) = std::env::var("OMNI_TEST_PG_TLS_URL") else {
        assert_ne!(std::env::var("OMNI_TEST_REQUIRE_TLS").as_deref(), Ok("1"));
        return;
    };
    let pg = PgStore::open(PgConfig::new(url), 0)
        .await
        .expect("verified PG TLS");
    let client = pg.client().await.expect("pooled TLS connection");
    let encrypted: bool = client
        .query_one(
            "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
            &[],
        )
        .await
        .expect("ssl state")
        .get(0);
    assert!(encrypted);
}
