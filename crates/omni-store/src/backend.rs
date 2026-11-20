//! One store over either backend: the surface the gateway and CLI use, so a
//! caller holding a [`Store`] does not care which database is behind it.
//!
//! **Async, and never on the request path.** Every method is `async`; the
//! SQLite arm runs its synchronous read on the blocking pool behind a mutex
//! (one connection, as the SQLite store has always been used), the Postgres
//! arm on its pool. The gateway reads a snapshot at boot and on change, and
//! request-path writes go through [`Store::spawn_writer`].
//!
//! Selecting a backend from `OMNI_DATABASE_URL` or the cluster config is the
//! binaries' job and is not done here (`d1-report.md`, "remaining
//! integration").

use crate::error::StoreError;
use crate::keys::{self, ApiKey, KeyEdit, OperatorKey};
use crate::models::{ModelRowError, OperatorCredential, OperatorModelRow, VirtualModel};
use crate::pg::{PgConfig, PgStore};
use crate::settings::Settings;
use crate::writer::{RequestLog, Writer, WriterConfig};
use crate::{Credential, CredentialHealth, QuotaWindow, SnapshotData, SqliteStore};
use omni_crypto::field::FieldKey;
use omni_ratelimit::buckets::Counts;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

/// Which database, and how to reach it.
#[derive(Debug, Clone)]
pub enum StoreConfig {
    Sqlite { path: PathBuf },
    Postgres(PgConfig),
}

/// Which engine a store is (`Store.engine` in TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Sqlite,
    Postgres,
}

/// A migrated store of either kind. Cheap to clone.
#[derive(Debug, Clone)]
pub enum Store {
    Sqlite {
        store: Arc<Mutex<SqliteStore>>,
        path: PathBuf,
        day_offset_minutes: i64,
    },
    Postgres(PgStore),
}

macro_rules! on_sqlite {
    ($store:expr, |$s:ident| $body:expr) => {{
        let store = Arc::clone($store);
        tokio::task::spawn_blocking(move || {
            let _runtime_access = crate::lifecycle::access();
            let $s = store.lock().unwrap_or_else(PoisonError::into_inner);
            $body
        })
        .await
        .map_err(|e| {
            if e.is_panic() {
                StoreError::Panicked(crate::writer::panic_message(e.into_panic()))
            } else {
                StoreError::Writer(format!("store task: {e}"))
            }
        })?
    }};
}

impl Store {
    /// Raw PHC settings rows shared by backend-aware console authentication.
    pub async fn password_hash(&self, name: &str) -> Result<Option<String>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let name = name.to_owned();
                on_sqlite!(store, |s| {
                    use rusqlite::OptionalExtension as _;
                    Ok(s.connection()
                        .query_row("SELECT value FROM settings WHERE key=?", [&name], |r| {
                            Ok(match r.get_ref(0)? {
                                rusqlite::types::ValueRef::Text(t) => {
                                    Some(String::from_utf8_lossy(t).into_owned())
                                }
                                _ => None,
                            })
                        })
                        .optional()?
                        .flatten())
                })
            }
            Self::Postgres(pg) => Ok(pg
                .client()
                .await?
                .query_opt("SELECT value FROM settings WHERE key=$1", &[&name])
                .await?
                .map(|r| r.try_get(0))
                .transpose()?),
        }
    }

    pub async fn password_hash_set_if_absent(
        &self,
        name: &str,
        hash: &str,
    ) -> Result<bool, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let (name, hash) = (name.to_owned(), hash.to_owned());
                on_sqlite!(store, |s| Ok(s.connection().execute(
                    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
                    [&name, &hash]
                )? == 1))
            }
            Self::Postgres(pg) => Ok(pg
                .client()
                .await?
                .execute(
                    "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING",
                    &[&name, &hash],
                )
                .await?
                == 1),
        }
    }

    pub async fn password_hash_set(
        &self,
        name: &str,
        hash: Option<&str>,
    ) -> Result<(), StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let (name, hash) = (name.to_owned(), hash.map(str::to_owned));
                on_sqlite!(store, |s| {
                    if let Some(hash) = hash {
                        s.connection().execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&name, &hash])?;
                    } else {
                        s.connection()
                            .execute("DELETE FROM settings WHERE key=?", [&name])?;
                    }
                    Ok(())
                })
            }
            Self::Postgres(pg) => {
                let client = pg.client().await?;
                if let Some(hash) = hash {
                    client.execute("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", &[&name, &hash]).await?;
                } else {
                    client
                        .execute("DELETE FROM settings WHERE key=$1", &[&name])
                        .await?;
                }
                Ok(())
            }
        }
    }
    /// Opens (creating and migrating) the store `config` names.
    pub async fn open(config: StoreConfig, day_offset_minutes: i64) -> Result<Self, StoreError> {
        match config {
            StoreConfig::Sqlite { path } => {
                let p = path.clone();
                let store =
                    tokio::task::spawn_blocking(move || SqliteStore::open(&p, day_offset_minutes))
                        .await
                        .map_err(|e| StoreError::Writer(format!("store open panicked: {e}")))??;
                Ok(Self::Sqlite {
                    store: crate::lifecycle::shared(store),
                    path,
                    day_offset_minutes,
                })
            }
            StoreConfig::Postgres(pg) => {
                Ok(Self::Postgres(PgStore::open(pg, day_offset_minutes).await?))
            }
        }
    }

    pub fn engine(&self) -> Engine {
        match self {
            Self::Sqlite { .. } => Engine::Sqlite,
            Self::Postgres(_) => Engine::Postgres,
        }
    }

    /// `databasePath`: the file, or the URL with its password redacted.
    pub fn database_path(&self) -> String {
        match self {
            Self::Sqlite { path, .. } => path.display().to_string(),
            Self::Postgres(pg) => pg.database_path(),
        }
    }

    pub fn day_offset_minutes(&self) -> i64 {
        match self {
            Self::Sqlite {
                day_offset_minutes, ..
            } => *day_offset_minutes,
            Self::Postgres(pg) => pg.day_offset_minutes(),
        }
    }

    /// The batched writer over this store's database.
    pub fn spawn_writer(&self, config: WriterConfig) -> Result<Writer, StoreError> {
        match self {
            Self::Sqlite { path, .. } => Writer::spawn(path, config),
            Self::Postgres(pg) => Writer::spawn_postgres(pg.clone(), config),
        }
    }

    /// A cheap "did anything the snapshot reads change" probe: SQLite's
    /// `data_version`, Postgres's `config_version`. Compare for inequality
    /// only; the two count different things.
    pub async fn change_version(&self) -> Result<i64, StoreError> {
        match self {
            Self::Sqlite { store, .. } => on_sqlite!(store, |s| s.data_version()),
            Self::Postgres(pg) => pg.config_version().await,
        }
    }

    pub async fn snapshot_reads(&self, key: &FieldKey) -> Result<SnapshotData, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let key = key.clone();
                on_sqlite!(store, |s| s.snapshot_reads(&key))
            }
            Self::Postgres(pg) => pg.snapshot_reads(key).await,
        }
    }

    pub async fn list_api_keys(&self) -> Result<Vec<ApiKey>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => on_sqlite!(store, |s| s.list_api_keys()),
            Self::Postgres(pg) => pg.list_api_keys().await,
        }
    }

    pub async fn find_api_key_by_hash(&self, hash: &str) -> Result<Option<ApiKey>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let hash = hash.to_owned();
                on_sqlite!(store, |s| s.find_api_key_by_hash(&hash))
            }
            Self::Postgres(pg) => pg.find_api_key_by_hash(hash).await,
        }
    }

    pub async fn find_api_key_entry(
        &self,
        hash: &str,
    ) -> Result<Option<Result<ApiKey, keys::KeyRowError>>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let hash = hash.to_owned();
                on_sqlite!(store, |s| s.find_api_key_entry(&hash))
            }
            Self::Postgres(pg) => pg.find_api_key_entry(hash).await,
        }
    }

    pub async fn list_credentials(&self, key: &FieldKey) -> Result<Vec<Credential>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let key = key.clone();
                on_sqlite!(store, |s| s.list_credentials(&key))
            }
            Self::Postgres(pg) => pg.list_credentials(key).await,
        }
    }

    pub async fn list_health(&self) -> Result<Vec<CredentialHealth>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => on_sqlite!(store, |s| s.list_health()),
            Self::Postgres(pg) => pg.list_health().await,
        }
    }

    /// Fresh credential view for refresh lock deduplication and CAS losers.
    pub async fn credential(
        &self,
        key: &FieldKey,
        id: &str,
    ) -> Result<Option<Credential>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let key = key.clone();
                let id = id.to_owned();
                on_sqlite!(store, |s| crate::credentials::get(
                    s.connection(),
                    &key,
                    &id
                ))
            }
            Self::Postgres(pg) => pg.credential(key, id).await,
        }
    }

    /// Refresh metadata never changes token_version. Called only by the CAS winner.
    pub async fn save_oauth(
        &self,
        key: &FieldKey,
        input: &crate::credentials::OAuthCredential<'_>,
    ) -> Result<(), StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let sealed = input.tokens.sealed(key);
                let id = input.id.to_owned();
                let provider = input.provider.to_owned();
                let label = input.label.to_owned();
                let data = input.provider_data.to_owned();
                let email = input.account_email.map(str::to_owned);
                let expiry = input.tokens.expires_at;
                let now = input.tokens.updated_at;
                let reconnect = input.reconnect;
                on_sqlite!(store, |s| {
                    if reconnect {
                        s.connection().execute("UPDATE credentials SET access_token=?1,refresh_token=?2,api_key=?3,id_token=?4,expires_at=?5,updated_at=?6,token_version=token_version+1 WHERE id=?7", rusqlite::params![sealed[0],sealed[1],sealed[2],sealed[3],expiry,now,id])?;
                        s.connection().execute("UPDATE credentials SET enabled=1,disabled_reason=NULL,disabled_at=NULL,account_email=?1,provider_data=?2 WHERE id=?3", rusqlite::params![email,data,id])?;
                    } else {
                        s.connection().execute("INSERT INTO credentials(id,provider,label,auth_type,enabled,tier,weight,provider_data,account_email,access_token,refresh_token,api_key,id_token,expires_at,created_at,updated_at) VALUES (?1,?2,?3,'oauth',1,1,1,?4,?5,?6,?7,?8,?9,?10,?11,?11)", rusqlite::params![id,provider,label,data,email,sealed[0],sealed[1],sealed[2],sealed[3],expiry,now])?;
                    }
                    Ok(())
                })
            }
            Self::Postgres(pg) => pg.save_oauth(key, input).await,
        }
    }

    /// Refresh metadata never changes token_version. Called only by the CAS winner.
    pub async fn refresh_metadata(
        &self,
        id: &str,
        email: Option<String>,
        now: i64,
    ) -> Result<(), StoreError> {
        self.refresh_metadata_with_data(id, email, None, now).await
    }

    /// Winner-only metadata write; data is the host's prior/result merge.
    pub async fn refresh_metadata_with_data(
        &self,
        id: &str,
        email: Option<String>,
        data: Option<String>,
        now: i64,
    ) -> Result<(), StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let id = id.to_owned();
                on_sqlite!(store, |s| {
                    s.connection().execute("UPDATE credentials SET account_email=COALESCE(?,account_email),provider_data=COALESCE(?,provider_data),updated_at=? WHERE id=?", rusqlite::params![email,data,now,id])?;
                    Ok(())
                })
            }
            Self::Postgres(pg) => pg.refresh_metadata_with_data(id, email, data, now).await,
        }
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
        match self {
            Self::Sqlite { store, .. } => {
                let id = id.to_owned();
                let reason = reason.to_owned();
                on_sqlite!(store, |s| {
                    s.connection().execute("UPDATE credentials SET enabled=0,disabled_reason=?,disabled_at=?,updated_at=? WHERE id=?", rusqlite::params![reason,now,now,id])?;
                    Ok(())
                })
            }
            Self::Postgres(pg) => pg.disable_credential(id, now, reason).await,
        }
    }

    pub async fn update_tokens(
        &self,
        key: &FieldKey,
        id: &str,
        update: &crate::credentials::TokenUpdate,
        expected_version: i64,
    ) -> Result<bool, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let key = key.clone();
                let id = id.to_owned();
                let update = update.clone();
                on_sqlite!(store, |s| crate::credentials::update_tokens(
                    s.connection(),
                    &key,
                    &id,
                    &update,
                    expected_version
                ))
            }
            Self::Postgres(pg) => pg.update_tokens(key, id, update, expected_version).await,
        }
    }

    pub async fn list_models(
        &self,
    ) -> Result<Vec<Result<VirtualModel, ModelRowError>>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => on_sqlite!(store, |s| s.list_models()),
            Self::Postgres(pg) => pg.list_models().await,
        }
    }

    pub async fn list_quota(&self) -> Result<Vec<QuotaWindow>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => on_sqlite!(store, |s| s.list_quota()),
            Self::Postgres(pg) => pg.list_quota().await,
        }
    }

    pub async fn get_settings(&self) -> Result<Settings, StoreError> {
        match self {
            Self::Sqlite { store, .. } => on_sqlite!(store, |s| s.get_settings()),
            Self::Postgres(pg) => pg.get_settings().await,
        }
    }

    /// `updateHealth(credentialId, model, apply)`: the shared atomic
    /// read-modify-write a breaker failure or transition goes through (see
    /// [`crate::writer::HealthWriter`] for the immediate path that calls it).
    /// A panic in `apply` rolls the transaction back and is returned as
    /// [`StoreError::Panicked`] on both backends.
    pub async fn update_health(
        &self,
        credential_id: &str,
        model: &str,
        apply: crate::writer::HealthMutation,
    ) -> Result<CredentialHealth, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let (id, model) = (credential_id.to_owned(), model.to_owned());
                on_sqlite!(store, |s| crate::credentials::update_health(
                    s.connection(),
                    &id,
                    &model,
                    &*apply
                ))
            }
            // In a task of its own, so a panic in `apply` is this call's
            // `StoreError::Panicked` (as on SQLite) rather than the caller's
            // unwind; the transaction rolls back as the task unwinds.
            Self::Postgres(pg) => {
                let (pg, id, model) = (pg.clone(), credential_id.to_owned(), model.to_owned());
                tokio::spawn(async move { pg.update_health(&id, &model, &*apply).await })
                    .await
                    .map_err(|e| {
                        if e.is_panic() {
                            StoreError::Panicked(crate::writer::panic_message(e.into_panic()))
                        } else {
                            StoreError::Writer(format!("health mutation task: {e}"))
                        }
                    })?
            }
        }
    }

    /// The stored health row for one pair (the uncertain-commit re-read).
    pub async fn read_health(
        &self,
        credential_id: &str,
        model: &str,
    ) -> Result<Option<CredentialHealth>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let (id, model) = (credential_id.to_owned(), model.to_owned());
                on_sqlite!(store, |s| crate::credentials::read_health(
                    s.connection(),
                    &id,
                    &model
                ))
            }
            Self::Postgres(pg) => pg.read_health(credential_id, model).await,
        }
    }

    /// `heartbeat` then `sweepPending`'s read: the boot sweep's completions.
    pub async fn sweep_pending(
        &self,
        node_id: &str,
        now: i64,
    ) -> Result<Vec<RequestLog>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let node_id = node_id.to_owned();
                on_sqlite!(store, |s| crate::usage::sweep_pending(
                    s.connection(),
                    &node_id,
                    now
                ))
            }
            Self::Postgres(pg) => pg.sweep_pending(node_id, now).await,
        }
    }

    /// `usage.sumSince`.
    pub async fn sum_since(
        &self,
        api_key_id: &str,
        since: i64,
        model: Option<&str>,
    ) -> Result<Counts, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let (id, model) = (api_key_id.to_owned(), model.map(str::to_owned));
                on_sqlite!(store, |s| crate::usage::sum_since(
                    s.connection(),
                    &id,
                    since,
                    model.as_deref()
                ))
            }
            Self::Postgres(pg) => pg.sum_since(api_key_id, since, model).await,
        }
    }

    /// The seed read's buckets and stamps, in one snapshot.
    pub async fn seed_rows(
        &self,
        api_key_id: &str,
        since_ms: i64,
        grain_ms: i64,
        requested_model: Option<&str>,
        stamp_cap: usize,
    ) -> Result<crate::usage::SeedRead, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let (id, model) = (api_key_id.to_owned(), requested_model.map(str::to_owned));
                on_sqlite!(store, |s| crate::usage::seed_rows(
                    s.connection(),
                    &id,
                    since_ms,
                    grain_ms,
                    model.as_deref(),
                    stamp_cap
                ))
            }
            Self::Postgres(pg) => {
                pg.seed_rows(api_key_id, since_ms, grain_ms, requested_model, stamp_cap)
                    .await
            }
        }
    }

    // --- CLI / control writes ---

    pub async fn create_key(&self, key: &ApiKey) -> Result<(), StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let key = key.clone();
                on_sqlite!(store, |s| keys::create(s.connection(), &key))
            }
            Self::Postgres(pg) => pg.create_key(key).await,
        }
    }

    pub async fn edit_key(&self, id: &str, edit: OwnedKeyEdit) -> Result<(), StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let id = id.to_owned();
                on_sqlite!(store, |s| keys::edit(s.connection(), &id, edit.borrow()))
            }
            Self::Postgres(pg) => pg.edit_key(id, edit.borrow()).await,
        }
    }

    pub async fn get_operator_key(&self, id: &str) -> Result<Option<ApiKey>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let id = id.to_owned();
                on_sqlite!(store, |s| keys::get_operator(s.connection(), &id))
            }
            Self::Postgres(pg) => pg.get_operator_key(id).await,
        }
    }

    pub async fn operator_keys(&self, id: Option<&str>) -> Result<Vec<OperatorKey>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let id = id.map(str::to_owned);
                on_sqlite!(store, |s| keys::operator_rows(
                    s.connection(),
                    id.as_deref()
                ))
            }
            Self::Postgres(pg) => pg.operator_keys(id).await,
        }
    }

    pub async fn put_model(
        &self,
        id: &str,
        targets: &str,
        strategy: &str,
        alias: bool,
    ) -> Result<(), StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let (id, targets, strategy) =
                    (id.to_owned(), targets.to_owned(), strategy.to_owned());
                on_sqlite!(store, |s| crate::models::put(
                    s.connection(),
                    &id,
                    &targets,
                    &strategy,
                    alias
                ))
            }
            Self::Postgres(pg) => pg.put_model(id, targets, strategy, alias).await,
        }
    }

    pub async fn remove_model(&self, id: &str) -> Result<(), StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let id = id.to_owned();
                on_sqlite!(store, |s| crate::models::remove(s.connection(), &id))
            }
            Self::Postgres(pg) => pg.remove_model(id).await,
        }
    }

    pub async fn operator_models(&self) -> Result<Vec<OperatorModelRow>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                on_sqlite!(store, |s| crate::models::operator_rows(s.connection()))
            }
            Self::Postgres(pg) => pg.operator_models().await,
        }
    }

    pub async fn operator_credentials(&self) -> Result<Vec<OperatorCredential>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                on_sqlite!(store, |s| crate::models::operator_credentials(
                    s.connection()
                ))
            }
            Self::Postgres(pg) => pg.operator_credentials().await,
        }
    }

    pub async fn put_settings(
        &self,
        patch: &serde_json::Value,
    ) -> Result<serde_json::Value, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let patch = patch.clone();
                on_sqlite!(store, |s| crate::settings::put(s.connection(), &patch))
            }
            Self::Postgres(pg) => pg.put_settings(patch).await,
        }
    }

    pub async fn operator_settings_raw(&self) -> Result<Option<String>, StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                on_sqlite!(store, |s| crate::settings::operator_raw(s.connection()))
            }
            Self::Postgres(pg) => pg.operator_settings_raw().await,
        }
    }

    pub async fn write_operator_settings_raw(&self, raw: &str) -> Result<(), StoreError> {
        match self {
            Self::Sqlite { store, .. } => {
                let raw = raw.to_owned();
                on_sqlite!(store, |s| crate::settings::write_operator_raw(
                    s.connection(),
                    &raw
                ))
            }
            Self::Postgres(pg) => pg.write_operator_settings_raw(raw).await,
        }
    }
}

/// [`KeyEdit`] with owned values, so it can cross to the blocking pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnedKeyEdit {
    Limits(String),
    Expiry(Option<i64>),
    Models(Option<String>),
    Guardrail(Option<String>),
    SmartRouting(bool),
    Revoke(i64),
}

impl OwnedKeyEdit {
    pub fn borrow(&self) -> KeyEdit<'_> {
        match self {
            Self::Limits(v) => KeyEdit::Limits(v),
            Self::Expiry(v) => KeyEdit::Expiry(*v),
            Self::Models(v) => KeyEdit::Models(v.as_deref()),
            Self::Guardrail(v) => KeyEdit::Guardrail(v.as_deref()),
            Self::SmartRouting(v) => KeyEdit::SmartRouting(*v),
            Self::Revoke(v) => KeyEdit::Revoke(*v),
        }
    }
}
