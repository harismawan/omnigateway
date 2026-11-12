use omni_crypto::field::FieldError;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    /// A Postgres statement or connection failure.
    #[error("postgres: {0}")]
    Postgres(#[from] tokio_postgres::Error),
    /// The Postgres pool could not hand out a connection in time (or at all).
    #[error("postgres pool: {0}")]
    Pool(String),
    /// A Postgres batch found a row another writer inserted between its read
    /// and its write. The transaction is rolled back; retrying re-reads.
    #[error("postgres write conflict: {0}")]
    Conflict(String),
    #[error("migration {id} failed: {source}")]
    Migration {
        id: i64,
        #[source]
        source: Box<StoreError>,
    },
    /// A write the database refuses for its values (a missing credential, a
    /// number its column cannot hold): what the TS repository throws on for
    /// that call alone. Not transient; retrying changes nothing.
    #[error("refused: {0}")]
    Refused(String),
    /// A COMMIT was sent and its answer never arrived (the connection went
    /// with it): the transaction may or may not have committed. Never
    /// retried blindly; a non-idempotent write would apply twice.
    #[error("commit outcome unknown: {0}")]
    UncertainCommit(String),
    /// A caller-supplied closure (a health mutation) panicked; whatever
    /// transaction it ran in was rolled back as it unwound.
    #[error("panicked: {0}")]
    Panicked(String),
    /// A row the TS reader would also have thrown on.
    #[error("unreadable row: {0}")]
    Corrupt(String),
    /// A stored secret that does not decrypt under this key. TS throws here
    /// too, at the first use of the secret.
    #[error("credential {credential_id} field {field} does not decrypt: {source}")]
    Secret {
        credential_id: String,
        field: &'static str,
        #[source]
        source: FieldError,
    },
    /// The batched writer's task or connection is gone.
    #[error("writer: {0}")]
    Writer(String),
}

impl From<deadpool_postgres::PoolError> for StoreError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        match e {
            deadpool_postgres::PoolError::Backend(e) => Self::Postgres(e),
            other => Self::Pool(other.to_string()),
        }
    }
}
