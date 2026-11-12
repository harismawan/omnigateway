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
//! **Retry boundary.** Every error before COMMIT is sent leaves nothing
//! committed: the server rolls an open transaction back when the statement
//! fails or the connection goes. So does a COMMIT the server *answers* with
//! an error (it carries a SQLSTATE). Those are safe to retry. A COMMIT whose
//! answer never arrives (closed connection, I/O error) is
//! [`StoreError::UncertainCommit`]: it may have committed, and re-applying
//! a non-idempotent mutation (`failures + 1`) would count it twice.
//!
//! Frozen TS does the same at that point: Bun's `sql.begin` rejects when
//! the COMMIT's connection is lost, `updateHealth` throws, and the gateway's
//! `persistHealth` callers log "failed to persist credential health" and
//! move on. Nothing re-applies the transition. The Rust health path keeps
//! that (no re-application) and adds a reconciliation re-read, so the caller
//! learns what the row now holds.

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
                credential_id: credential_id.to_owned(),
                model: model.to_owned(),
                breaker_state: BreakerState::parse(r.try_get(0)?),
                consecutive_failures: i64::from(r.try_get::<_, i32>(1)?),
                opened_at: instant(r.try_get(2)?),
                rate_limited_until: instant(r.try_get(3)?),
            }),
        };
        let next = apply(current);
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
            // The server answered the COMMIT with an error: rolled back.
            Err(e) if e.code().is_some() => Err(StoreError::Postgres(e)),
            // No answer: committed or not, nobody here knows.
            Err(e) => Err(StoreError::UncertainCommit(e.to_string())),
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
            credential_id: credential_id.to_owned(),
            model: model.to_owned(),
            breaker_state: BreakerState::parse(r.try_get(0)?),
            consecutive_failures: i64::from(r.try_get::<_, i32>(1)?),
            opened_at: instant(r.try_get(2)?),
            rate_limited_until: instant(r.try_get(3)?),
        }))
    }
}
