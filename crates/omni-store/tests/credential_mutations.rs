use omni_crypto::field::{decrypt, derive_key};
use omni_store::credentials::{ApiKeyCredential, CredentialPatch};

#[tokio::test]
async fn credential_mutations_encrypt_and_preserve_metadata() {
    let key = derive_key("mutation-test-key");
    let input = ApiKeyCredential {
        id: "a6-mutation",
        provider: "custom",
        label: "label",
        provider_data: r#"{"endpointId":"\ud800"}"#,
        api_key: "secret-mutation",
        now: 123,
    };
    let patch = CredentialPatch {
        label: Some("edited".into()),
        enabled: Some(false),
        tier: Some(2.0),
        weight: Some(0.5),
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let store = omni_store::SqliteStore::open(dir.path().join("db"), 0).expect("store");
    omni_store::credentials::create_api_key(store.connection(), &key, &input).expect("create");
    omni_store::credentials::patch_metadata(store.connection(), Some(input.id), &patch, 456)
        .expect("patch");
    let row: (String, String, String, i64, i64) = store
        .connection()
        .query_row(
            "SELECT api_key,provider_data,disabled_reason,disabled_at,updated_at FROM credentials",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .expect("row");
    assert_eq!(decrypt(&key, &row.0).expect("decrypt"), input.api_key);
    assert_eq!(
        (row.1.as_str(), row.2.as_str(), row.3, row.4),
        (input.provider_data, "manual", 456, 456)
    );
    omni_store::credentials::patch_metadata(
        store.connection(),
        Some(input.id),
        &CredentialPatch::default(),
        789,
    )
    .expect("noop");
    assert_eq!(
        store
            .connection()
            .query_row("SELECT updated_at FROM credentials", [], |r| r
                .get::<_, i64>(0))
            .expect("time"),
        456
    );
    omni_store::credentials::remove(store.connection(), Some(input.id)).expect("delete");
    assert_eq!(
        store
            .connection()
            .query_row("SELECT count(*) FROM credentials", [], |r| r
                .get::<_, i64>(0))
            .expect("count"),
        0
    );

    let Ok(url) = std::env::var("OMNI_TEST_DATABASE_URL") else {
        return;
    };
    let pg = omni_store::pg::PgStore::open(omni_store::pg::PgConfig::new(url), 0)
        .await
        .expect("pg");
    pg.remove_credential(Some(input.id)).await.expect("cleanup");
    pg.create_api_key_credential(&key, &input)
        .await
        .expect("pg create");
    pg.patch_credential(Some(input.id), &patch, 456)
        .await
        .expect("pg patch");
    let c = pg.client().await.expect("client");
    let r = c
        .query_one("SELECT * FROM credentials WHERE id=$1", &[&input.id])
        .await
        .expect("row");
    assert_eq!(
        decrypt(&key, r.get("api_key")).expect("pg decrypt"),
        input.api_key
    );
    assert_eq!(r.get::<_, String>("provider_data"), input.provider_data);
    assert_eq!(r.get::<_, String>("disabled_reason"), "manual");
    assert_eq!(r.get::<_, i64>("disabled_at"), 456);
    pg.patch_credential(Some(input.id), &CredentialPatch::default(), 789)
        .await
        .expect("pg noop");
    let r = c
        .query_one(
            "SELECT updated_at FROM credentials WHERE id=$1",
            &[&input.id],
        )
        .await
        .expect("row");
    assert_eq!(r.get::<_, i64>(0), 456);
    pg.patch_credential(
        Some(input.id),
        &CredentialPatch {
            enabled: Some(true),
            ..Default::default()
        },
        789,
    )
    .await
    .expect("enable");
    let r = c
        .query_one(
            "SELECT enabled,disabled_reason,disabled_at FROM credentials WHERE id=$1",
            &[&input.id],
        )
        .await
        .expect("row");
    assert!(r.get::<_, bool>(0));
    assert_eq!(r.get::<_, Option<String>>(1), None);
    assert_eq!(r.get::<_, Option<i64>>(2), None);
    pg.remove_credential(Some(input.id))
        .await
        .expect("pg delete");
    pg.remove_credential(Some(input.id))
        .await
        .expect("pg delete twice");
    assert!(
        c.query("SELECT id FROM credentials WHERE id=$1", &[&input.id])
            .await
            .expect("deleted")
            .is_empty()
    );
    eprintln!("LIVE POSTGRES credential create/decrypt/patch/noop/enable/delete executed");
}
