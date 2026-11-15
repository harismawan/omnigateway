//! Store-level PostgreSQL OAuth lifecycle evidence, not cluster gateway coverage.
#![allow(clippy::unwrap_used)]
use omni_crypto::field::{decrypt, derive_key};
use omni_store::{
    Store,
    credentials::{OAuthCredential, TokenUpdate},
};

#[tokio::test]
async fn oauth_create_reconnect_and_refresh_cas_postgres() {
    let Ok(url) = std::env::var("OMNI_TEST_DATABASE_URL") else {
        assert_ne!(std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(), Ok("1"));
        return;
    };
    let pg = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(url), 0)
        .await
        .unwrap();
    let client = pg.client().await.unwrap();
    let store = Store::Postgres(pg);
    let key = derive_key("local-oauth-pg-fixture");
    let id = "oauth-pg-lifecycle";
    client
        .execute("DELETE FROM credentials WHERE id=$1", &[&id])
        .await
        .unwrap();
    let mut tokens = TokenUpdate {
        access_token: Some("access".into()),
        refresh_token: Some("refresh".into()),
        api_key: None,
        id_token: Some("id-token".into()),
        expires_at: Some(10000),
        updated_at: 100,
    };
    for reconnect in [false, true] {
        let data = if reconnect {
            r#"{"accountId":"new","installationId":"stable","idSalt":"stable"}"#
        } else {
            r#"{"accountId":"old","installationId":"stable","idSalt":"stable","extra":true}"#
        };
        store
            .save_oauth(
                &key,
                &OAuthCredential {
                    id,
                    provider: "openai",
                    label: "fixture",
                    provider_data: data,
                    account_email: Some("fixture@example.test"),
                    tokens: &tokens,
                    reconnect,
                },
            )
            .await
            .unwrap();
        let row = store.credential(&key, id).await.unwrap().unwrap();
        assert!(row.enabled);
        assert_eq!(row.disabled_reason, None);
        assert_eq!(row.token_version, i64::from(reconnect));
        assert_eq!(
            row.provider_data,
            serde_json::from_str::<serde_json::Value>(data).unwrap()
        );
        assert_eq!(row.secrets.id_token.as_deref(), Some("id-token"));
        let raw = client.query_one("SELECT access_token,refresh_token,id_token,disabled_at FROM credentials WHERE id=$1", &[&id]).await.unwrap();
        for (col, expected) in [
            ("access_token", "access"),
            ("refresh_token", "refresh"),
            ("id_token", "id-token"),
        ] {
            let ciphertext: String = raw.get(col);
            assert_ne!(ciphertext, expected);
            assert_eq!(decrypt(&key, &ciphertext).unwrap(), expected);
        }
        assert_eq!(raw.get::<_, Option<i64>>("disabled_at"), None);
        if !reconnect {
            store.disable_rejected_token(id, 101).await.unwrap();
        }
    }
    tokens.access_token = Some("winner".into());
    tokens.id_token = None;
    tokens.updated_at = 200;
    assert!(store.update_tokens(&key, id, &tokens, 1).await.unwrap());
    store.refresh_metadata_with_data(id, None, Some(r#"{"accountId":"winner","installationId":"stable","idSalt":"stable","extra":true}"#.into()), 200).await.unwrap();
    let winner = store.credential(&key, id).await.unwrap().unwrap();
    assert_eq!(winner.token_version, 2);
    assert_eq!(winner.secrets.access_token.as_deref(), Some("winner"));
    // Explicit null clears the token (TS updateTokens also distinguishes null from undefined).
    assert_eq!(winner.secrets.id_token.as_deref(), None);
    assert_eq!(
        winner.account_email.as_deref(),
        Some("fixture@example.test")
    );
    assert_eq!(winner.provider_data["extra"], true);
    tokens.access_token = Some("loser".into());
    tokens.id_token = Some("losing-id".into());
    assert!(!store.update_tokens(&key, id, &tokens, 1).await.unwrap());
    // Host only writes metadata after CAS success; a losing caller does not call it.
    let after = store.credential(&key, id).await.unwrap().unwrap();
    assert_eq!(after.secrets, winner.secrets);
    assert_eq!(after.provider_data, winner.provider_data);
    assert_eq!(after.token_version, 2);
    store
        .refresh_metadata_with_data(id, None, None, 201)
        .await
        .unwrap();
    assert_eq!(
        store
            .credential(&key, id)
            .await
            .unwrap()
            .unwrap()
            .provider_data,
        winner.provider_data
    );
    client
        .execute("DELETE FROM credentials WHERE id=$1", &[&id])
        .await
        .unwrap();
}
