use omni_crypto::field::FieldError;

/// Parser input is available only to explicit wire consumers, never formatting.
pub struct ParserDetail(String);

impl From<String> for ParserDetail {
    fn from(value: String) -> Self {
        Self(value)
    }
}
impl ParserDetail {
    pub fn into_wire_detail(self) -> String {
        self.0
    }
}
impl std::fmt::Debug for ParserDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<stored JSON parser detail redacted>")
    }
}

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
    /// number its column cannot hold): fails that call alone.
    /// Not transient; retrying changes nothing.
    #[error("refused: {0}")]
    Refused(String),
    /// A COMMIT whose outcome is unknown: its answer never arrived (the
    /// connection went with it), or was an error that does not establish a
    /// rollback (see `pg::health`). The transaction may or may not have
    /// committed. Never retried blindly; a non-idempotent write would apply
    /// twice.
    #[error("commit outcome unknown: {0}")]
    UncertainCommit(String),
    /// A caller-supplied closure (a health mutation) panicked; whatever
    /// transaction it ran in was rolled back as it unwound.
    #[error("panicked: {0}")]
    Panicked(String),
    /// A row the reader cannot use.
    #[error("unreadable row: {0}")]
    Corrupt(String),
    /// Parser diagnostics may quote stored content. Only explicit wire
    /// consumers may read `detail`; Display is safe for internal error logs.
    #[error("unreadable row: {table}.{column} of {row_id}: not valid JSON")]
    StoredJson {
        table: &'static str,
        column: &'static str,
        row_id: String,
        detail: ParserDetail,
    },
    /// A stored secret that does not decrypt under this key. Surfaces at the
    /// first use of the secret.
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

#[cfg(test)]
mod tests {
    use super::StoreError;

    #[test]
    fn stored_json_display_excludes_parser_detail() {
        let error = StoreError::StoredJson {
            table: "api_keys",
            column: "model_allowlist",
            row_id: "key-1".into(),
            detail: "JSON Parse error: Unexpected identifier storedSecretCanary"
                .to_owned()
                .into(),
        };
        assert_eq!(
            error.to_string(),
            "unreadable row: api_keys.model_allowlist of key-1: not valid JSON"
        );
        assert!(!error.to_string().contains("storedSecretCanary"));
        assert!(!format!("{error:?}").contains("storedSecretCanary"));
        if let StoreError::StoredJson { detail, .. } = error {
            assert!(detail.into_wire_detail().contains("storedSecretCanary"));
        } else {
            panic!("wrong variant");
        }
    }
}
