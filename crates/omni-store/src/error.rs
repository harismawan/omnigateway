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
