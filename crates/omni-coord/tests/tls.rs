use omni_coord::Coord;

#[tokio::test]
async fn configured_rediss_verifies_private_ca_and_shares_kv() {
    let Ok(url) = std::env::var("OMNI_TEST_REDIS_TLS_URL") else {
        assert_ne!(std::env::var("OMNI_TEST_REQUIRE_TLS").as_deref(), Ok("1"));
        return;
    };
    let coord = omni_coord::redis::RedisCoord::connect(&url, Default::default())
        .await
        .expect("verified rediss");
    coord
        .kv_set("tls:private-probe", "value", 1000)
        .await
        .expect("set");
    assert_eq!(
        coord
            .kv_get("tls:private-probe")
            .await
            .expect("get")
            .as_deref(),
        Some("value")
    );
    coord.close();
}
