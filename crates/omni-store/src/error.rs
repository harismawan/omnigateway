use omni_crypto::field::FieldError;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
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
