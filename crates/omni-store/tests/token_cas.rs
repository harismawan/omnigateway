#![allow(clippy::unwrap_used)] // Test assertions: any database/crypto failure fails the test.

mod common;

use omni_crypto::field::{decrypt, derive_key};
use omni_store::{
    SqliteStore,
    credentials::{TokenUpdate, update_tokens},
};

#[test]
fn rotation_is_encrypted_atomic_and_version_guarded() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open(dir.path().join("tokens.db"), 0).unwrap();
    let conn = store.connection();
    conn.execute("INSERT INTO credentials (id,provider,label,auth_type,created_at,updated_at) VALUES ('c','anthropic','c','oauth',0,0)", []).unwrap();
    let key = derive_key("token-cas-test-key");
    let update = TokenUpdate {
        access_token: Some("access-one".into()),
        refresh_token: Some("refresh-one".into()),
        api_key: None,
        id_token: None,
        expires_at: Some(1234.0),
        updated_at: 42,
    };
    assert!(update_tokens(conn, &key, "c", &update, 0).unwrap());
    let stored: (String, String, i64, i64, i64) = conn.query_row("SELECT access_token,refresh_token,token_version,expires_at,updated_at FROM credentials WHERE id='c'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert!(stored.0.starts_with("enc:v1:"));
    assert_eq!(decrypt(&key, &stored.0).unwrap(), "access-one");
    assert_eq!(decrypt(&key, &stored.1).unwrap(), "refresh-one");
    assert_eq!((stored.2, stored.3, stored.4), (1, 1234, 42));
    let loser = TokenUpdate {
        access_token: Some("loser".into()),
        expires_at: None,
        updated_at: 99,
        ..update.clone()
    };
    assert!(!update_tokens(conn, &key, "c", &loser, 0).unwrap());
    let current = store.list_credentials(&key).unwrap().remove(0);
    assert_eq!(current.secrets.access_token.as_deref(), Some("access-one"));
    assert_eq!(current.expires_at, Some(1234.0));
    assert_eq!(current.updated_at, 42);
    assert!(!update_tokens(conn, &key, "gone", &update, 0).unwrap());
    assert!(update_tokens(conn, &key, "c", &loser, 1).unwrap());
    let current = store.list_credentials(&key).unwrap().remove(0);
    assert_eq!(current.token_version, 2);
    assert_eq!(current.expires_at, None);
}

#[tokio::test]
async fn postgres_competing_rotations_have_one_winner() {
    let Some(base) = common::pg::base_url("postgres_competing_rotations_have_one_winner") else {
        return;
    };
    let db = common::pg::TestDb::create(&base, "token_cas").await;
    let store = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(&db.url), 0)
        .await
        .unwrap();
    db.client().await.batch_execute("INSERT INTO credentials (id,provider,label,auth_type,created_at,updated_at) VALUES ('c','anthropic','c','oauth',0,0)").await.unwrap();
    let key = derive_key("token-cas-test-key");
    let first = TokenUpdate {
        access_token: Some("first".into()),
        refresh_token: Some("rotated".into()),
        api_key: None,
        id_token: None,
        expires_at: Some(1234.0),
        updated_at: 42,
    };
    let second = TokenUpdate {
        access_token: Some("second".into()),
        ..first.clone()
    };
    let (a, b) = tokio::join!(
        store.update_tokens(&key, "c", &first, 0),
        store.update_tokens(&key, "c", &second, 0)
    );
    let a = a.unwrap();
    assert_ne!(a, b.unwrap());
    let current = store.list_credentials(&key).await.unwrap().remove(0);
    assert_eq!(current.token_version, 1);
    assert_eq!(
        current.secrets.access_token.as_deref(),
        Some(if a { "first" } else { "second" })
    );
    assert_eq!(current.secrets.refresh_token.as_deref(), Some("rotated"));
    assert_eq!(current.expires_at, Some(1234.0));
    assert!(!store.update_tokens(&key, "gone", &first, 0).await.unwrap());
    store
        .refresh_metadata("c", Some("rotated@example.com".into()), 88)
        .await
        .unwrap();
    store.disable_rejected_token("c", 99).await.unwrap();
    let current = store.list_credentials(&key).await.unwrap().remove(0);
    assert!(!current.enabled);
    assert_eq!(current.disabled_reason.unwrap().as_str(), "tokenRejected");
    assert_eq!(current.disabled_at, Some(99));
    assert_eq!(
        current.account_email.as_deref(),
        Some("rotated@example.com")
    );
    assert_eq!(current.token_version, 1);
}
