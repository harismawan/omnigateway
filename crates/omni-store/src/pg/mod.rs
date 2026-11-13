//! The Postgres store: the migrations `packages/store/src/postgres/db.ts`
//! applies, and the same reads and writes the SQLite store offers, against a
//! bounded pool.
//!
//! **Nothing here is on the request path.** The gateway serves from its
//! in-memory snapshot, built from [`PgStore::snapshot_reads`] at boot and on
//! change ([`PgStore::config_version`] is the change probe, as
//! `data_version` is on SQLite). Request-path persistence goes through the
//! batched writer ([`crate::writer::Writer::spawn_postgres`]), whose channel
//! never waits.
//!
//! **Pool.** At most 16 connections per replica (the spec's ceiling), a 1 s
//! wait for a free one, a 5 s connect timeout, and every statement under a
//! 5 s `statement_timeout`. The migration walk runs on a connection of its
//! own without a statement timeout, as `openPg` does: a migration on a large
//! table may take longer, and its lock wait is expected to.
//!
//! **Driver.** `tokio-postgres` with `deadpool-postgres`, not sqlx: the batch
//! writer needs typed array binds for `INSERT … SELECT FROM unnest(...)`,
//! the migration walk needs the simple protocol for multi-statement files
//! (`batch_execute`), and both are first-class there; sqlx's compile-time
//! query checking needs a database at build time, which this workspace's
//! offline builds cannot assume. Statements are prepared once per connection
//! (`prepare_cached`).

pub mod bodies;
pub mod health;
pub mod migrate;
mod rows;
pub mod usage;

use crate::error::StoreError;
use crate::keys::{ApiKey, KeyEdit, OperatorKey};
use crate::models::{ModelRowError, OperatorCredential, OperatorModelRow, VirtualModel};
use crate::settings::Settings;
use crate::{Credential, CredentialHealth, QuotaWindow, SnapshotData};
use deadpool_postgres::{GenericClient, Manager, ManagerConfig, Pool, RecyclingMethod, Timeouts};
use omni_crypto::field::FieldKey;
use std::time::Duration;
use tokio_postgres::NoTls;

/// How the pool is sized and bounded. `Debug` redacts the URL's password.
#[derive(Clone)]
pub struct PgConfig {
    /// A `postgres://` URL (`OMNI_DATABASE_URL`).
    pub url: String,
    /// Pool size; clamped to `1..=16`.
    pub max_connections: usize,
    /// How long a caller waits for a free connection.
    pub wait_timeout: Duration,
    /// How long opening a connection may take.
    pub connect_timeout: Duration,
    /// `statement_timeout` on every pooled connection.
    pub statement_timeout: Duration,
}

impl std::fmt::Debug for PgConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgConfig")
            .field("url", &redacted(&self.url))
            .field("max_connections", &self.max_connections)
            .field("wait_timeout", &self.wait_timeout)
            .field("connect_timeout", &self.connect_timeout)
            .field("statement_timeout", &self.statement_timeout)
            .finish()
    }
}

impl PgConfig {
    /// The spec's defaults: 16 connections, 1 s pool wait, 5 s connect and
    /// statement timeouts.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            max_connections: 16,
            wait_timeout: Duration::from_secs(1),
            connect_timeout: Duration::from_secs(5),
            statement_timeout: Duration::from_secs(5),
        }
    }

    fn pg_config(&self) -> Result<tokio_postgres::Config, StoreError> {
        let mut c: tokio_postgres::Config = self.url.parse()?;
        c.connect_timeout(self.connect_timeout);
        if c.get_application_name().is_none() {
            c.application_name("omni-gateway");
        }
        Ok(c)
    }
}

/// The URL as it may be shown: host and database, never the password
/// (`redacted` in `store.ts`). Both places libpq takes one are masked: the
/// authority's `user:password@`, and a `password=` query parameter.
pub fn redacted(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return "postgres://<unparseable>".to_owned();
    };
    // The authority ends at the first `/`, `?` or `#`.
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let authority = match authority.rsplit_once('@') {
        Some((userinfo, host)) => match userinfo.split_once(':') {
            Some((user, _)) => format!("{user}:***@{host}"),
            None => authority.to_owned(),
        },
        None => authority.to_owned(),
    };
    let tail = match tail.split_once('?') {
        None => tail.to_owned(),
        Some((path, query)) => {
            let (query, fragment) = query
                .split_once('#')
                .map_or((query, None), |(q, f)| (q, Some(f)));
            let masked: Vec<String> = query
                .split('&')
                .map(|pair| match pair.split_once('=') {
                    // The driver percent-decodes a key before looking it up
                    // (`pass%77ord` is `password`), so it is judged decoded.
                    Some((k, _)) if is_password_key(k) => format!("{k}=***"),
                    _ => pair.to_owned(),
                })
                .collect();
            let mut t = format!("{path}?{}", masked.join("&"));
            if let Some(f) = fragment {
                t.push('#');
                t.push_str(f);
            }
            t
        }
    };
    format!("{scheme}://{authority}{tail}")
}

/// Whether a query key names the password once percent-decoded, as
/// tokio-postgres decodes it (`percent_decode`, then UTF-8) before matching
/// `password`. Matched case-insensitively (wider than the driver's exact
/// match), and a key that does not decode is treated as one, to be safe.
fn is_password_key(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(h) = bytes.get(i + 1..i + 3)
            && let Ok(h) = std::str::from_utf8(h)
            && let Ok(b) = u8::from_str_radix(h, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_or(true, |k| k.eq_ignore_ascii_case("password"))
}

/// A migrated Postgres database behind a bounded pool. Cheap to clone.
#[derive(Clone)]
pub struct PgStore {
    pool: Pool,
    url: String,
    day_offset_minutes: i64,
}

impl std::fmt::Debug for PgStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgStore")
            .field("url", &redacted(&self.url))
            .field("day_offset_minutes", &self.day_offset_minutes)
            .finish_non_exhaustive()
    }
}

/// The pooled client type.
pub type PgClient = deadpool_postgres::Client;

impl PgStore {
    /// `openPg`: run the migration walk under the advisory lock on a
    /// connection of its own, then open the pool. `day_offset_minutes` is the
    /// fixed offset every daily bucket uses.
    pub async fn open(config: PgConfig, day_offset_minutes: i64) -> Result<Self, StoreError> {
        let pg = config.pg_config()?;
        {
            let (client, conn) = pg.connect(NoTls).await?;
            let driver = tokio::spawn(async move {
                if let Err(e) = conn.await {
                    tracing::debug!(reason = %e, "postgres migration connection ended");
                }
            });
            let walked = migrate::migrate(&client).await;
            // Dropping the client closes the session, which releases a lock
            // an interrupted walk could not unlock itself.
            drop(client);
            driver.await.ok();
            walked?;
        }
        let mut pooled = pg;
        let timeout = format!(
            "-c statement_timeout={}",
            config.statement_timeout.as_millis()
        );
        // Appended, so `options` the URL already carries are kept.
        let options = match pooled.get_options() {
            Some(given) if !given.is_empty() => format!("{given} {timeout}"),
            _ => timeout,
        };
        pooled.options(options);
        let manager = Manager::from_config(
            pooled,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(config.max_connections.clamp(1, 16))
            .timeouts(Timeouts {
                wait: Some(config.wait_timeout),
                create: Some(config.connect_timeout),
                recycle: Some(config.connect_timeout),
            })
            .runtime(deadpool_postgres::Runtime::Tokio1)
            .build()
            .map_err(|e| StoreError::Pool(e.to_string()))?;
        Ok(Self {
            pool,
            url: config.url,
            day_offset_minutes,
        })
    }

    /// The database as it may be shown (`databasePath` in TS).
    pub fn database_path(&self) -> String {
        redacted(&self.url)
    }

    pub fn day_offset_minutes(&self) -> i64 {
        self.day_offset_minutes
    }

    /// A pooled connection, waiting at most the configured wait timeout.
    pub async fn client(&self) -> Result<PgClient, StoreError> {
        Ok(self.pool.get().await?)
    }

    /// `config_version`: moves whenever a table the snapshot is built from
    /// changes, on any replica (the `bump_config_version` triggers). The
    /// Postgres analogue of SQLite's `PRAGMA data_version` probe.
    pub async fn config_version(&self) -> Result<i64, StoreError> {
        let c = self.client().await?;
        let stmt = c
            .prepare_cached("SELECT version FROM config_version WHERE id = 1")
            .await?;
        Ok(c.query_opt(&stmt, &[]).await?.map_or(0, |r| r.get(0)))
    }

    /// Every snapshot read, in one read-only repeatable-read transaction, so
    /// the parts agree with each other.
    pub async fn snapshot_reads(&self, key: &FieldKey) -> Result<SnapshotData, StoreError> {
        let mut c = self.client().await?;
        let tx = c
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let data = SnapshotData {
            api_keys: rows::list_key_entries(&tx).await?,
            credentials: rows::list_credentials(&tx, key).await?,
            health: rows::list_health(&tx).await?,
            models: rows::list_models(&tx).await?,
            quota: rows::list_quota(&tx).await?,
            settings: rows::get_settings(&tx).await?,
        };
        tx.commit().await?;
        Ok(data)
    }

    pub async fn list_api_keys(&self) -> Result<Vec<ApiKey>, StoreError> {
        rows::list_keys(&self.client().await?).await
    }

    /// The one read a snapshot miss (a brand-new key) falls back to.
    pub async fn find_api_key_by_hash(&self, hash: &str) -> Result<Option<ApiKey>, StoreError> {
        rows::find_key(&self.client().await?, "hash", hash).await
    }

    pub async fn list_credentials(&self, key: &FieldKey) -> Result<Vec<Credential>, StoreError> {
        rows::list_credentials(&self.client().await?, key).await
    }

    pub async fn credential(
        &self,
        key: &FieldKey,
        id: &str,
    ) -> Result<Option<Credential>, StoreError> {
        let mut client = self.client().await?;
        let tx = client.build_transaction().read_only(true).start().await?;
        let row = rows::credential(&tx, key, id).await?;
        tx.commit().await?;
        Ok(row)
    }

    pub async fn refresh_metadata(
        &self,
        id: &str,
        email: Option<String>,
        now: i64,
    ) -> Result<(), StoreError> {
        self.client().await?.execute("UPDATE credentials SET account_email=COALESCE($1,account_email),updated_at=$2 WHERE id=$3", &[&email,&now,&id]).await?;
        Ok(())
    }

    pub async fn disable_rejected_token(&self, id: &str, now: i64) -> Result<(), StoreError> {
        self.disable_credential(id, now, "tokenRejected").await
    }

    pub async fn disable_credential(
        &self,
        id: &str,
        now: i64,
        reason: &str,
    ) -> Result<(), StoreError> {
        self.client().await?.execute("UPDATE credentials SET enabled=false,disabled_reason=$3,disabled_at=$1,updated_at=$1 WHERE id=$2", &[&now,&id,&reason]).await?;
        Ok(())
    }

    pub async fn update_tokens(
        &self,
        key: &FieldKey,
        id: &str,
        update: &crate::credentials::TokenUpdate,
        expected_version: i64,
    ) -> Result<bool, StoreError> {
        let sealed = update.sealed(key);
        Ok(self.client().await?.execute(
            "UPDATE credentials SET access_token=$1, refresh_token=$2, api_key=$3, id_token=$4, expires_at=$5, updated_at=$6, token_version=token_version+1 WHERE id=$7 AND token_version=$8::bigint",
            &[&sealed[0], &sealed[1], &sealed[2], &sealed[3], &update.expires_at, &update.updated_at, &id, &expected_version],
        ).await? > 0)
    }

    pub async fn list_health(&self) -> Result<Vec<CredentialHealth>, StoreError> {
        rows::list_health(&self.client().await?).await
    }

    pub async fn list_models(
        &self,
    ) -> Result<Vec<Result<VirtualModel, ModelRowError>>, StoreError> {
        rows::list_models(&self.client().await?).await
    }

    pub async fn list_quota(&self) -> Result<Vec<QuotaWindow>, StoreError> {
        rows::list_quota(&self.client().await?).await
    }

    pub async fn get_settings(&self) -> Result<Settings, StoreError> {
        rows::get_settings(&self.client().await?).await
    }

    // --- Operator (CLI and control) reads and writes. ---

    /// `KeyRepo.create`, with the row the caller built.
    pub async fn create_key(&self, key: &ApiKey) -> Result<(), StoreError> {
        rows::create_key(&self.client().await?, key).await
    }

    /// One explicit key mutation; SQL identifiers never come from input.
    pub async fn edit_key(&self, id: &str, edit: KeyEdit<'_>) -> Result<(), StoreError> {
        rows::edit_key(&self.client().await?, id, edit).await
    }

    /// The key with TS's raw allowlist semantics (see `keys::get_operator`).
    pub async fn get_operator_key(&self, id: &str) -> Result<Option<ApiKey>, StoreError> {
        rows::get_operator_key(&self.client().await?, id).await
    }

    /// Every key, newest first, in the operator projection.
    pub async fn operator_keys(&self, id: Option<&str>) -> Result<Vec<OperatorKey>, StoreError> {
        rows::operator_keys(&self.client().await?, id).await
    }

    pub async fn put_model(
        &self,
        id: &str,
        targets: &str,
        strategy: &str,
        alias: bool,
    ) -> Result<(), StoreError> {
        let c = self.client().await?;
        let stmt = c
            .prepare_cached(
                "INSERT INTO virtual_models (id, targets, strategy, is_alias) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (id) DO UPDATE SET
                   targets = EXCLUDED.targets,
                   strategy = EXCLUDED.strategy,
                   is_alias = EXCLUDED.is_alias",
            )
            .await?;
        c.execute(&stmt, &[&id, &targets, &strategy, &alias])
            .await?;
        Ok(())
    }

    /// Delete only the named configuration row, retaining historical usage.
    pub async fn remove_model(&self, id: &str) -> Result<(), StoreError> {
        let c = self.client().await?;
        let stmt = c
            .prepare_cached("DELETE FROM virtual_models WHERE id = $1")
            .await?;
        c.execute(&stmt, &[&id]).await?;
        Ok(())
    }

    pub async fn operator_models(&self) -> Result<Vec<OperatorModelRow>, StoreError> {
        rows::operator_models(&self.client().await?).await
    }

    pub async fn operator_credentials(&self) -> Result<Vec<OperatorCredential>, StoreError> {
        rows::operator_credentials(&self.client().await?).await
    }

    /// `ConfigRepo.putSettings`: merge the patch and commit one row.
    pub async fn put_settings(
        &self,
        patch: &serde_json::Value,
    ) -> Result<serde_json::Value, StoreError> {
        let c = self.client().await?;
        let (next, raw) = crate::settings::merged(rows::get_settings(&c).await?.json, patch);
        rows::write_raw_setting(&c, "settings", &raw).await?;
        Ok(next)
    }

    /// The stored `settings` text, untouched.
    pub async fn operator_settings_raw(&self) -> Result<Option<String>, StoreError> {
        rows::read_raw_setting(&self.client().await?, "settings").await
    }

    pub async fn write_operator_settings_raw(&self, raw: &str) -> Result<(), StoreError> {
        rows::write_raw_setting(&self.client().await?, "settings", raw).await
    }

    // --- Maintenance. ---

    /// `heartbeat` then the `sweepPending` read: this node's liveness row,
    /// the day-old ones forgotten, and every pending row of this node or of
    /// a node with no live heartbeat, as the 499 `interrupted` completions
    /// the boot sweep sends through the writer.
    pub async fn sweep_pending(
        &self,
        node_id: &str,
        now: i64,
    ) -> Result<Vec<crate::writer::RequestLog>, StoreError> {
        usage::sweep_pending(&self.client().await?, node_id, now).await
    }

    /// `MaintenanceRepo.stats().schemaVersion`: the newest applied id.
    pub async fn schema_version(&self) -> Result<i32, StoreError> {
        let c = self.client().await?;
        Ok(
            c.query_one("SELECT COALESCE(MAX(id), 0) FROM migrations", &[])
                .await?
                .get(0),
        )
    }
}

/// Runs `f` on a transaction-capable client, for helpers generic over both.
pub(crate) async fn query_rows(
    c: &impl GenericClient,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<Vec<tokio_postgres::Row>, StoreError> {
    let stmt = c.prepare_cached(sql).await?;
    Ok(c.query(&stmt, params).await?)
}

#[cfg(test)]
mod tests {
    use super::redacted;

    #[test]
    fn the_password_never_shows() {
        assert_eq!(
            redacted("postgres://omni:secret@db:5432/omni?sslmode=disable"),
            "postgres://omni:***@db:5432/omni?sslmode=disable"
        );
        assert_eq!(redacted("postgres://db/omni"), "postgres://db/omni");
        assert_eq!(redacted("postgres://u@db/omni"), "postgres://u@db/omni");
        assert_eq!(redacted("nope"), "postgres://<unparseable>");
        assert_eq!(
            redacted("postgres://db/omni?user=u&password=hunter2&sslmode=require"),
            "postgres://db/omni?user=u&password=***&sslmode=require"
        );
        assert_eq!(
            redacted("postgresql://u:p%40ss@db?PASSWORD=x"),
            "postgresql://u:***@db?PASSWORD=***"
        );
        assert_eq!(
            redacted("postgres://u:p@db:5432"),
            "postgres://u:***@db:5432"
        );
        // The driver percent-decodes keys: these are all its `password`.
        for key in ["pass%77ord", "%70%61%73%73%77%6F%72%64", "PASS%57ORD"] {
            let url = format!("postgres://u@db/omni?{key}=secret&sslmode=disable");
            assert_eq!(
                redacted(&url),
                format!("postgres://u@db/omni?{key}=***&sslmode=disable")
            );
        }
        // A key that does not decode to UTF-8 is masked rather than trusted.
        assert_eq!(redacted("postgres://db?%ff=x"), "postgres://db?%ff=***");
        assert_eq!(
            redacted("postgres://db?passwords=x"),
            "postgres://db?passwords=x"
        );
    }

    #[test]
    fn config_debug_never_shows_the_password() {
        let c = super::PgConfig::new(
            "postgres://omni:hunter2@db/omni?password=hunter3&pass%77ord=hunter4",
        );
        // The driver reads that key as the password.
        let parsed: tokio_postgres::Config = c.url.parse().expect("parses");
        assert_eq!(parsed.get_password(), Some(b"hunter4".as_slice()));
        let shown = format!("{c:?}");
        assert!(!shown.contains("hunter"), "{shown}");
        let s = crate::StoreConfig::Postgres(c);
        let shown = format!("{s:?} {s:#?}");
        assert!(!shown.contains("hunter"), "{shown}");
        assert!(shown.contains("omni:***@db"), "{shown}");
    }
}
