//! `CredentialRepo.updateHealth` on Postgres (`packages/store/src/postgres/credentials.ts`):
//! the shared, atomic read-modify-write every replica's breaker goes through.
//!
//! One transaction: the advisory lock on `hashtext(credential|model)` (so
//! the first-ever write for a pair serialises too, where `FOR UPDATE` would
//! lock nothing), then the row `FOR UPDATE`, then the caller's mutation of
//! what is stored *now*, then `UPSERT_HEALTH`. Two replicas recording a
//! failure on the same row therefore both count; neither overwrites the
//! other with a value computed from a stale snapshot.
//!
//! **Retry boundary.** Before COMMIT is attempted, no error can commit this
//! transaction: a failed statement aborts it, and a lost session rolls it
//! back. Those are ordinary (retryable where transient) errors.
//!
//! At COMMIT, only an answer that *positively establishes* non-commit is
//! treated as such ([`commit_rejection`]): an `ErrorResponse` of severity
//! ERROR (not FATAL or PANIC, which end the session) whose SQLSTATE is on
//! an explicit allowlist:
//! - [`COMMIT_RETRYABLE`], `40001` (serialization failure) and `40P01`
//!   (deadlock detected): the two codes PostgreSQL's "Serialization
//!   Failure Handling" (PostgreSQL 17 docs, §13.5) names for retrying the
//!   whole transaction (40001 always, 40P01 "advisable"); both abort and
//!   roll back the transaction that receives them. Retried, through the
//!   same list in the writers' shared classifier, so the label here and
//!   the retry there cannot disagree;
//! - class 23, a deferred constraint checked at COMMIT: a refusal of the
//!   values, as TS's call throws. Not retried.
//!
//! Everything else at COMMIT is [`StoreError::UncertainCommit`]: a
//! connection-level error (closed, I/O, unexpected message), any
//! FATAL/PANIC answer, and every other code. That includes the rest of
//! class 40: `40003` (statement completion unknown) says in so many words
//! that the outcome is unknown, and `40000`/`40002` carry no documented
//! rollback-and-retry contract. It includes the shutdown codes
//! 57P01/57P02/57P03, `57014` (a statement timeout during COMMIT) and
//! anything the client does not recognise. The server may have committed
//! before sending any of those, and re-applying a non-idempotent mutation
//! (`failures + 1`) would count it twice; treating a real rollback as
//! uncertain costs at most one reported, un-retried mutation. A connection
//! closed before COMMIT could even be queued lands here too: the client
//! cannot tell it from a lost acknowledgement, so it is conservatively
//! uncertain, never retried.
//!
//! Frozen TS does not re-apply either: `updateHealth` awaits `sql.begin`
//! and has no retry loop, so a lost COMMIT acknowledgement makes it throw
//! once. What the gateway then does depends on the call site (see the d1
//! report, fix round 3). The Rust health path keeps the no-re-application
//! and adds a re-read, reported as an observation, not an acknowledgement.

use super::PgStore;
use crate::credentials::CredentialHealth;
use crate::error::StoreError;
use crate::vocab::BreakerState;
use tokio_postgres::error::SqlState;

/// What a mutation of one row's health is: the stored row (`None` when the
/// pair has none yet) to the row to store.
pub type HealthApply<'a> = &'a (dyn Fn(Option<CredentialHealth>) -> CredentialHealth + Send + Sync);

/// `UPSERT_HEALTH`, with the instants bound as TS binds a JS number into a
/// `BIGINT`: as `float8`, which Postgres rounds half to even, and refuses
/// when not finite or out of range.
const UPSERT_HEALTH: &str = "INSERT INTO credential_health
   (credential_id, model, breaker_state, consecutive_failures, opened_at, rate_limited_until)
 VALUES ($1, $2, $3, $4, $5::float8::bigint, $6::float8::bigint)
 ON CONFLICT (credential_id, model) DO UPDATE SET
   breaker_state = EXCLUDED.breaker_state,
   consecutive_failures = EXCLUDED.consecutive_failures,
   opened_at = EXCLUDED.opened_at,
   rate_limited_until = EXCLUDED.rate_limited_until";

#[allow(clippy::cast_precision_loss)]
fn instant(v: Option<i64>) -> Option<f64> {
    v.map(|v| v as f64)
}

/// A database refusal of the values, as opposed to a fault worth retrying.
fn refusal(e: &tokio_postgres::Error) -> Option<String> {
    let code = e.code()?;
    [
        SqlState::FOREIGN_KEY_VIOLATION,
        SqlState::NUMERIC_VALUE_OUT_OF_RANGE,
        SqlState::NOT_NULL_VIOLATION,
        SqlState::CHECK_VIOLATION,
        SqlState::INVALID_TEXT_REPRESENTATION,
    ]
    .contains(code)
    .then(|| {
        e.as_db_error()
            .map_or_else(|| e.to_string(), |d| d.message().to_owned())
    })
}

/// The SQLSTATEs that, at severity ERROR, establish that a COMMIT rolled
/// back and may be retried: serialization failure and deadlock, the pair
/// PostgreSQL's documentation names for retrying a transaction (§13.5).
/// The writers' shared retry classifier (`writer::task::transient`)
/// retries exactly these from class 40, by this list, so a
/// [`CommitRejection::Retryable`] is always retried.
pub(crate) const COMMIT_RETRYABLE: [SqlState; 2] = [
    SqlState::T_R_SERIALIZATION_FAILURE,
    SqlState::T_R_DEADLOCK_DETECTED,
];

/// How a COMMIT's error is to be read: what positively establishes that
/// the transaction did not commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommitRejection {
    /// A [`COMMIT_RETRYABLE`] code at severity ERROR: rolled back, retry.
    Retryable,
    /// A deferred constraint checked at COMMIT (class 23) at severity
    /// ERROR: rolled back, the values are refused.
    Refused,
}

/// Whether a COMMIT error positively establishes non-commit, judged by
/// severity and SQLSTATE together (never by the mere presence of a code).
/// `None`: the outcome is unknown.
pub(crate) fn commit_rejection(e: &tokio_postgres::Error) -> Option<CommitRejection> {
    let db = e.as_db_error()?;
    classify_commit(db.parsed_severity(), db.severity(), db.code())
}

/// [`commit_rejection`] on the fields of an `ErrorResponse`.
fn classify_commit(
    parsed: Option<tokio_postgres::error::Severity>,
    raw: &str,
    code: &SqlState,
) -> Option<CommitRejection> {
    use tokio_postgres::error::Severity;
    // FATAL and PANIC end the session (or the server): whatever the code,
    // they say nothing about whether this COMMIT landed first. A server
    // that did not send `V` (pre-9.6) is judged by its `S`, which may be
    // localised, so only the untranslated `ERROR` counts there.
    let error = match parsed {
        Some(s) => matches!(s, Severity::Error),
        None => raw == "ERROR",
    };
    if !error {
        return None;
    }
    // An allowlist, not a class: the rest of class 40 (40003 "statement
    // completion unknown" above all), the shutdown codes and anything
    // unrecognised are not rollback evidence.
    if COMMIT_RETRYABLE.contains(code) {
        Some(CommitRejection::Retryable)
    } else if code.code().starts_with("23") {
        Some(CommitRejection::Refused)
    } else {
        None
    }
}

/// A COMMIT's error as the caller should act on it.
fn commit_error(e: tokio_postgres::Error) -> StoreError {
    match commit_rejection(&e) {
        Some(CommitRejection::Retryable) => StoreError::Postgres(e),
        Some(CommitRejection::Refused) => StoreError::Refused(
            e.as_db_error()
                .map_or_else(|| e.to_string(), |d| d.message().to_owned()),
        ),
        None => StoreError::UncertainCommit(e.to_string()),
    }
}

impl PgStore {
    /// `updateHealth(credentialId, model, apply)`: reads the stored row under
    /// the pair's lock, applies `apply`, writes the result, all in one
    /// transaction, and returns the row `apply` proposed. That is what was
    /// written except where the column rounds it: a fractional instant comes
    /// back fractional, as TS's does, and is stored rounded to the BIGINT.
    ///
    /// A panic in `apply` unwinds through here: the dropped transaction
    /// sends ROLLBACK (releasing the pair's lock) before its connection is
    /// reused.
    ///
    /// [`StoreError::Refused`] when the database refuses the values (no such
    /// credential, a count or instant its columns cannot hold); nothing is
    /// written then, as TS's call throws.
    pub async fn update_health(
        &self,
        credential_id: &str,
        model: &str,
        apply: HealthApply<'_>,
    ) -> Result<CredentialHealth, StoreError> {
        let mut client = self.client().await?;
        let tx = client.transaction().await?;
        let lock = tx
            .prepare_cached("SELECT pg_advisory_xact_lock(hashtext($1))")
            .await?;
        tx.execute(&lock, &[&format!("{credential_id}|{model}")])
            .await?;
        let read = tx
            .prepare_cached(
                "SELECT breaker_state, consecutive_failures, opened_at, rate_limited_until
                   FROM credential_health WHERE credential_id = $1 AND model = $2 FOR UPDATE",
            )
            .await?;
        let current = match tx.query_opt(&read, &[&credential_id, &model]).await? {
            None => None,
            Some(r) => Some(CredentialHealth {
                scalar: None,
                credential_id: credential_id.to_owned(),
                model: model.to_owned(),
                breaker_state: BreakerState::parse(r.try_get(0)?),
                consecutive_failures: i64::from(r.try_get::<_, i32>(1)?),
                opened_at: instant(r.try_get(2)?),
                rate_limited_until: instant(r.try_get(3)?),
            }),
        };
        let next = apply(current);
        if next.scalar.is_some() {
            return Err(StoreError::Refused(
                "SQLite health scalars cannot be bound to PostgreSQL INTEGER health".into(),
            ));
        }
        let failures = i32::try_from(next.consecutive_failures).map_err(|_| {
            StoreError::Refused(format!(
                "credential_health.consecutive_failures: {} is out of INTEGER range",
                next.consecutive_failures
            ))
        })?;
        let write = tx.prepare_cached(UPSERT_HEALTH).await?;
        if let Err(e) = tx
            .execute(
                &write,
                &[
                    &next.credential_id,
                    &next.model,
                    &next.breaker_state.as_str(),
                    &failures,
                    &next.opened_at,
                    &next.rate_limited_until,
                ],
            )
            .await
        {
            return Err(refusal(&e).map_or(StoreError::Postgres(e), StoreError::Refused));
        }
        match tx.commit().await {
            Ok(()) => Ok(next),
            Err(e) => Err(commit_error(e)),
        }
    }

    /// The stored health row for one pair, or `None`.
    pub async fn read_health(
        &self,
        credential_id: &str,
        model: &str,
    ) -> Result<Option<CredentialHealth>, StoreError> {
        let c = self.client().await?;
        let read = c
            .prepare_cached(
                "SELECT breaker_state, consecutive_failures, opened_at, rate_limited_until
                   FROM credential_health WHERE credential_id = $1 AND model = $2",
            )
            .await?;
        let Some(r) = c.query_opt(&read, &[&credential_id, &model]).await? else {
            return Ok(None);
        };
        Ok(Some(CredentialHealth {
            scalar: None,
            credential_id: credential_id.to_owned(),
            model: model.to_owned(),
            breaker_state: BreakerState::parse(r.try_get(0)?),
            consecutive_failures: i64::from(r.try_get::<_, i32>(1)?),
            opened_at: instant(r.try_get(2)?),
            rate_limited_until: instant(r.try_get(3)?),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{CommitRejection, classify_commit};
    use tokio_postgres::error::{Severity, SqlState};

    #[test]
    fn only_an_error_level_rejection_is_evidence_of_rollback() {
        use CommitRejection::{Refused, Retryable};
        let cases: [(Option<Severity>, &str, SqlState, Option<CommitRejection>); 18] = [
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::T_R_SERIALIZATION_FAILURE,
                Some(Retryable),
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::T_R_DEADLOCK_DETECTED,
                Some(Retryable),
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::CHECK_VIOLATION,
                Some(Refused),
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::FOREIGN_KEY_VIOLATION,
                Some(Refused),
            ),
            // Session-ending severities, whatever the code.
            (
                Some(Severity::Fatal),
                "FATAL",
                SqlState::T_R_SERIALIZATION_FAILURE,
                None,
            ),
            (
                Some(Severity::Panic),
                "PANIC",
                SqlState::CHECK_VIOLATION,
                None,
            ),
            (
                Some(Severity::Fatal),
                "FATAL",
                SqlState::ADMIN_SHUTDOWN,
                None,
            ),
            // Shutdown codes, even at ERROR.
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::ADMIN_SHUTDOWN,
                None,
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::CRASH_SHUTDOWN,
                None,
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::CANNOT_CONNECT_NOW,
                None,
            ),
            // The rest of class 40 is not on the allowlist: completion
            // unknown above all, and the codes with no retry contract.
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::T_R_STATEMENT_COMPLETION_UNKNOWN,
                None,
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::TRANSACTION_ROLLBACK,
                None,
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::T_R_INTEGRITY_CONSTRAINT_VIOLATION,
                None,
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::from_code("40999"),
                None,
            ),
            // Anything else is unknown, including a statement timeout at
            // COMMIT and codes the client cannot interpret.
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::QUERY_CANCELED,
                None,
            ),
            (
                Some(Severity::Error),
                "ERROR",
                SqlState::from_code("XX000"),
                None,
            ),
            // No `V` field: only the untranslated `S` = ERROR counts.
            (
                None,
                "ERROR",
                SqlState::T_R_SERIALIZATION_FAILURE,
                Some(Retryable),
            ),
            (None, "FEHLER", SqlState::T_R_SERIALIZATION_FAILURE, None),
        ];
        for (parsed, raw, code, want) in cases {
            assert_eq!(
                classify_commit(parsed, raw, &code),
                want,
                "{parsed:?} {raw} {code:?}"
            );
        }
    }

    /// The label and the behaviour agree: across every class-40 code (and
    /// the shutdown and timeout codes the writer retries before COMMIT), a
    /// COMMIT error is labelled `Retryable` exactly when the writers'
    /// shared classifier retries its code. Anything labelled otherwise
    /// becomes `UncertainCommit` or `Refused` and never reaches the
    /// classifier.
    #[test]
    fn the_commit_retry_label_matches_the_writer_retry_classifier() {
        let codes = [
            "40000", "40001", "40002", "40003", "40P01", "40999", "57P01", "57P03", "57014",
            "55P03", "23514",
        ];
        for code in codes {
            let code = SqlState::from_code(code);
            let label = classify_commit(Some(Severity::Error), "ERROR", &code);
            let retried = crate::writer::transient_sqlstate(&code);
            if label == Some(CommitRejection::Retryable) {
                assert!(retried, "{code:?} is labelled retryable but not retried");
            }
            if code.code().starts_with("40") {
                assert_eq!(
                    label == Some(CommitRejection::Retryable),
                    retried,
                    "{code:?}: class-40 label and retry disagree"
                );
            }
        }
    }
}
