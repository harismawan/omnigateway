//! The retired `ponytailMode` strip on Postgres: a stored blob carrying it
//! reads back without it, and a `PUT` carrying it succeeds and ignores it.
//! The strip is control-layer (`settings_value::decode`); the store itself
//! echoes unknown keys on purpose.
//!
//! Needs `OMNI_TEST_DATABASE_URL`; skips without it, and fails instead under
//! `OMNI_TEST_REQUIRE_PG=1`. Runs in a database of its own, dropped at the end.

use omni_control::api::{put_settings_postgres, settings_postgres};
use omni_control::settings_value::{get, set};
use omni_ir::jsjson::{JsValue, parse_js};
use omni_store::pg::{PgConfig, PgStore};

#[tokio::test]
async fn postgres_strips_a_stored_and_a_sent_ponytail_mode() {
    let url = match std::env::var("OMNI_TEST_DATABASE_URL") {
        Ok(url) if !url.is_empty() => url,
        _ => {
            assert_ne!(
                std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(),
                Ok("1"),
                "OMNI_TEST_REQUIRE_PG=1 requires OMNI_TEST_DATABASE_URL"
            );
            println!("skipping: OMNI_TEST_DATABASE_URL unset, Postgres not run");
            return;
        }
    };
    let admin = PgStore::open(PgConfig::new(url.clone()), 0)
        .await
        .expect("fixture server");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let database = format!("ponytail_strip_{}_{nanos}", std::process::id());
    admin
        .client()
        .await
        .expect("admin connection")
        .batch_execute(&format!("CREATE DATABASE {database}"))
        .await
        .expect("isolated database");
    let mut own = url::Url::parse(&url).expect("fixture URL");
    own.set_path(&format!("/{database}"));
    let pg = PgStore::open(PgConfig::new(own.to_string()), 0)
        .await
        .expect("fixture store");

    pg.write_operator_settings_raw(r#"{"ponytailMode":"lite","extra":1}"#)
        .await
        .expect("seed");
    let read = settings_postgres(&pg).await.expect("read");
    assert_eq!(get(&read, "ponytailMode"), None);
    assert_eq!(get(&read, "extra"), Some(&JsValue::Number(1.0)));

    for sent in [r#""ultra""#, "7", "{}"] {
        // A whole settings body, as a client PUTs it, plus the retired key.
        let mut body = settings_postgres(&pg).await.expect("read");
        set(&mut body, "ponytailMode", parse_js(sent).expect("shape"));
        set(&mut body, "maxAttempts", JsValue::Number(5.0));
        put_settings_postgres(&pg, &body)
            .await
            .expect("a ponytailMode is ignored, never refused");
        let raw = pg
            .operator_settings_raw()
            .await
            .expect("row")
            .expect("written");
        assert!(!raw.contains("ponytailMode"), "{sent}: {raw}");
        let read = settings_postgres(&pg).await.expect("read");
        assert_eq!(get(&read, "maxAttempts"), Some(&JsValue::Number(5.0)));
        assert_eq!(get(&read, "extra"), Some(&JsValue::Number(1.0)));
        assert_eq!(get(&read, "ponytailMode"), None);
    }

    drop(pg);
    admin
        .client()
        .await
        .expect("admin connection")
        .batch_execute(&format!("DROP DATABASE {database} WITH (FORCE)"))
        .await
        .expect("drop the isolated database");
}
