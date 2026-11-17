//! The SQLite and Postgres stores: migrations shared with the TS build, and
//! the reads the gateway builds its in-memory snapshot from.
//!
//! A database written by either build is opened by the other and continued
//! from its migration id. Nothing here runs on the request path; the gateway
//! reads a [`SnapshotData`] at boot and on change, and serves from memory.

mod backend;
pub mod bodies;
pub mod credentials;
mod error;
mod js;
pub mod keys;
pub mod logs;
pub mod maintenance;
pub mod operator_cell;
/// `api_keys.limits`; lives with the arithmetic in `omni-ratelimit`, as TS's
/// store imports `@omni/ratelimit/catalog`.
pub use omni_ratelimit::limits;
pub mod migrate;
pub mod models;
pub mod pg;
pub mod quota;
pub mod reports;
pub mod rollup;
mod row;
pub mod settings;
pub mod usage;
mod vocab;
pub mod writer;

pub use backend::{Engine, OwnedKeyEdit, Store, StoreConfig};
pub use credentials::{Credential, CredentialHealth, CredentialSecrets, Secret};
pub use error::StoreError;
pub use keys::ApiKey;
pub use limits::{LimitConfig, LimitScope};
pub use models::{ModelRowError, Target, TargetPricing, VirtualModel};
pub use quota::{QuotaWindow, WindowType};
pub use settings::Settings;
pub use vocab::{AuthType, BreakerState, DisabledReason, Strategy};

use omni_crypto::field::FieldKey;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Everything the gateway's in-memory snapshot is built from, read in one
/// transaction so the parts agree with each other.
#[derive(Debug, Clone)]
pub struct SnapshotData {
    /// Newest first. A row that does not read is that key's own error (a
    /// per-key refusal at auth), so one malformed key never stops boot or a
    /// refresh, and never freezes the others' revocation.
    pub api_keys: Vec<Result<ApiKey, keys::KeyRowError>>,
    /// By tier then label, secrets decrypted.
    pub credentials: Vec<Credential>,
    pub health: Vec<CredentialHealth>,
    /// By id. A row that does not read is its own error, so one malformed
    /// model never takes the others down.
    pub models: Vec<Result<VirtualModel, ModelRowError>>,
    pub quota: Vec<QuotaWindow>,
    pub settings: Settings,
}

/// One connection to a migrated database.
///
/// The read handle. A writer (Task 2) opens its own connection with
/// [`open_connection`], so it gets the same pragmas without a second migrate.
pub struct SqliteStore {
    conn: Connection,
    path: PathBuf,
    day_offset_minutes: i64,
}

/// Opens `path` (creating it) with the TS connection pragmas, and nothing
/// else. Per-connection pragmas must be set on every connection.
pub fn open_connection(path: &Path) -> Result<Connection, StoreError> {
    let conn = Connection::open(path)?;
    migrate::apply_pragmas(&conn)?;
    Ok(conn)
}

impl std::fmt::Debug for SqliteStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteStore")
            .field("path", &self.path)
            .field("day_offset_minutes", &self.day_offset_minutes)
            .finish_non_exhaustive()
    }
}

impl SqliteStore {
    /// Independent read-only report handle. No migration or persistent transaction.
    pub fn open_reader(
        path: impl AsRef<Path>,
        day_offset_minutes: i64,
    ) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self {
            conn,
            path,
            day_offset_minutes,
        })
    }

    /// `openDb`: open or create, set the pragmas, apply what the ledger lacks.
    /// `day_offset_minutes` is the fixed offset every daily bucket uses.
    pub fn open(path: impl AsRef<Path>, day_offset_minutes: i64) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        let mut conn = open_connection(&path)?;
        migrate::migrate(&mut conn, day_offset_minutes)?;
        Ok(Self {
            conn,
            path,
            day_offset_minutes,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn day_offset_minutes(&self) -> i64 {
        self.day_offset_minutes
    }

    /// The underlying connection, for reads not wrapped here.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// `PRAGMA data_version`: changes when another connection commits to the
    /// file. A cheap "did anything move" probe until the TS `config_version`
    /// counter is read.
    pub fn data_version(&self) -> Result<i64, StoreError> {
        Ok(self
            .conn
            .query_row("PRAGMA data_version", [], |r| r.get(0))?)
    }

    /// Every snapshot read, in one read transaction.
    pub fn snapshot_reads(&self, key: &FieldKey) -> Result<SnapshotData, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let data = SnapshotData {
            api_keys: keys::list_entries(&tx)?,
            credentials: credentials::list_routing(&tx, key)?,
            health: credentials::list_routing_health(&tx)?,
            models: models::list(&tx)?,
            quota: quota::list(&tx)?,
            settings: settings::get(&tx)?,
        };
        tx.commit()?;
        Ok(data)
    }

    pub fn list_api_keys(&self) -> Result<Vec<ApiKey>, StoreError> {
        keys::list(&self.conn)
    }

    /// The one read a snapshot miss (a brand-new key) falls back to.
    pub fn find_api_key_by_hash(&self, hash: &str) -> Result<Option<ApiKey>, StoreError> {
        keys::find_by_hash(&self.conn, hash)
    }

    /// [`Self::find_api_key_by_hash`], an unreadable row as that key's
    /// [`keys::KeyRowError`] rather than a failed read.
    pub fn find_api_key_entry(
        &self,
        hash: &str,
    ) -> Result<Option<Result<ApiKey, keys::KeyRowError>>, StoreError> {
        keys::find_entry_by_hash(&self.conn, hash)
    }

    pub fn list_credentials(&self, key: &FieldKey) -> Result<Vec<Credential>, StoreError> {
        credentials::list(&self.conn, key)
    }

    pub fn list_health(&self) -> Result<Vec<CredentialHealth>, StoreError> {
        credentials::list_health(&self.conn)
    }

    pub fn list_models(&self) -> Result<Vec<Result<VirtualModel, ModelRowError>>, StoreError> {
        models::list(&self.conn)
    }

    pub fn list_quota(&self) -> Result<Vec<QuotaWindow>, StoreError> {
        quota::list(&self.conn)
    }

    pub fn get_settings(&self) -> Result<Settings, StoreError> {
        settings::get(&self.conn)
    }
}
