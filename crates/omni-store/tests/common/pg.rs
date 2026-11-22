//! Postgres test plumbing: one throwaway database per test on the server
//! `OMNI_TEST_DATABASE_URL` names, dropped when the test ends.
//!
//! The TS contract harness (`packages/store/test/contract/harness.ts`) wipes
//! `public` on one shared database and runs serially. Rust test threads run in
//! parallel, so each test gets a database of its own instead.

use std::sync::atomic::{AtomicU32, Ordering};

/// The server URL, or `None` after printing why the caller is skipping.
pub fn base_url(test: &str) -> Option<String> {
    match std::env::var("OMNI_TEST_DATABASE_URL") {
        Ok(url) if !url.is_empty() => Some(url),
        _ => {
            assert_ne!(
                std::env::var("OMNI_TEST_REQUIRE_PG").as_deref(),
                Ok("1"),
                "OMNI_TEST_REQUIRE_PG=1 requires OMNI_TEST_DATABASE_URL"
            );
            println!("skipping {test}: OMNI_TEST_DATABASE_URL unset, Postgres not run");
            None
        }
    }
}

/// `url` naming database `name` instead of its own.
pub fn with_database(url: &str, name: &str) -> String {
    let (scheme, rest) = url.split_once("://").expect("a postgres:// url");
    let (authority, tail) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let query = tail.find('?').map_or("", |i| &tail[i..]);
    format!("{scheme}://{authority}/{name}{query}")
}

/// Connects and drives the connection on the current runtime.
pub async fn connect(url: &str) -> tokio_postgres::Client {
    let (client, conn) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .expect("connect");
    tokio::spawn(async move {
        conn.await.ok();
    });
    client
}

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A database of its own, dropped (connections and all) on drop.
pub struct TestDb {
    pub url: String,
    pub name: String,
    base: String,
}

impl TestDb {
    pub async fn create(base: &str, hint: &str) -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let hint: String = hint
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .take(30)
            .collect();
        let name = format!("omni_rs_{}_{n}_{hint}", std::process::id()).to_lowercase();
        let admin = connect(base).await;
        let version: String = admin
            .query_one("SELECT version()", &[])
            .await
            .expect("server version")
            .get(0);
        println!("Postgres server: {version}");
        admin
            .batch_execute(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
            .await
            .expect("drop stale");
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await
            .expect("create database");
        Self {
            url: with_database(base, &name),
            name,
            base: base.to_owned(),
        }
    }

    pub async fn client(&self) -> tokio_postgres::Client {
        connect(&self.url).await
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let base = self.base.clone();
        let name = self.name.clone();
        // A runtime of its own: the test's may be shutting down.
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            rt.block_on(async {
                if let Ok((client, conn)) =
                    tokio_postgres::connect(&base, tokio_postgres::NoTls).await
                {
                    tokio::spawn(async move {
                        conn.await.ok();
                    });
                    client
                        .batch_execute(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
                        .await
                        .ok();
                }
            });
        })
        .join()
        .ok();
    }
}

/// Every row of `table` as PG's record text (`t::text`), sorted. The schema
/// is compared separately, so text is exact: float8 prints shortest-exact.
pub async fn table_rows(client: &tokio_postgres::Client, table: &str) -> Vec<String> {
    let select = if table == "migrations" {
        "SELECT id::text FROM migrations".to_owned()
    } else {
        format!("SELECT t::text FROM {table} t")
    };
    let mut rows: Vec<String> = client
        .query(&select, &[])
        .await
        .expect("rows")
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    rows.sort();
    rows
}

/// The public schema as catalog text: columns, indexes, constraints,
/// triggers and functions, each sorted.
pub async fn schema(client: &tokio_postgres::Client) -> Vec<String> {
    let queries = [
        "SELECT 'col ' || table_name || '.' || column_name || ' #' || ordinal_position || ' '
                || data_type || ' default=' || coalesce(column_default, '-') || ' null=' || is_nullable
           FROM information_schema.columns WHERE table_schema = 'public'",
        "SELECT 'idx ' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname = 'public'",
        "SELECT 'con ' || conname || ' ' || pg_get_constraintdef(oid)
           FROM pg_constraint WHERE connamespace = 'public'::regnamespace",
        "SELECT 'trg ' || tgname || ' ' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal",
        "SELECT 'fn ' || proname || ' ' || prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace",
    ];
    let mut out = Vec::new();
    for q in queries {
        for r in client.query(q, &[]).await.expect("schema") {
            out.push(r.get::<_, String>(0));
        }
    }
    out.sort();
    out
}

/// Every table in `public`.
pub async fn tables(client: &tokio_postgres::Client) -> Vec<String> {
    let mut out: Vec<String> = client
        .query(
            "SELECT tablename::text FROM pg_tables WHERE schemaname = 'public'",
            &[],
        )
        .await
        .expect("tables")
        .iter()
        .map(|r| r.get(0))
        .collect();
    out.sort();
    out
}

/// Every table's rows (see [`table_rows`]), by table.
pub async fn contents(client: &tokio_postgres::Client) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    for t in tables(client).await {
        let rows = table_rows(client, &t).await;
        out.push((t, rows));
    }
    out
}
