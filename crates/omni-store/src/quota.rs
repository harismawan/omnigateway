//! Provider quota readings, read as `listQuota` in
//! `packages/store/src/sqlite/credentials.ts` reads them.

use crate::error::StoreError;
use crate::row;
use rusqlite::Connection;
use serde::Serialize;

/// `WindowType`: a bucket name, not a duration (`durationFor`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WindowType {
    FiveHour,
    Daily,
    Weekly,
    /// A stored name this build does not know. TS casts it through, and its
    /// nominal length is then `undefined`; see [`WindowType::nominal_ms`].
    Other(String),
}

impl WindowType {
    pub fn parse(s: &str) -> Self {
        match s {
            "fiveHour" => Self::FiveHour,
            "daily" => Self::Daily,
            "weekly" => Self::Weekly,
            other => Self::Other(other.to_owned()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::FiveHour => "fiveHour",
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Other(s) => s,
        }
    }

    /// `WINDOW_DURATION_MS[windowType]`. NaN for an unknown name, which is
    /// what `undefined` becomes in the arithmetic TS does with it.
    pub fn nominal_ms(&self) -> f64 {
        match self {
            Self::FiveHour => 5.0 * 60.0 * 60.0 * 1000.0,
            Self::Daily => 24.0 * 60.0 * 60.0 * 1000.0,
            Self::Weekly => 7.0 * 24.0 * 60.0 * 60.0 * 1000.0,
            Self::Other(_) => f64::NAN,
        }
    }
}

impl Serialize for WindowType {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// `QuotaWindow`. Numbers are JS numbers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub credential_id: String,
    pub window_type: WindowType,
    pub starts_at: f64,
    pub used: f64,
    /// `None`: usage reported without a ceiling.
    pub limit: Option<f64>,
    pub resets_at: Option<f64>,
    /// Zero for a row never observed.
    pub observed_at: f64,
    pub window_ms: Option<f64>,
}

const Q: &str = "quota_windows";

fn opt_number(r: &rusqlite::Row<'_>, column: &str) -> Result<Option<f64>, StoreError> {
    match r.get_ref(column)? {
        rusqlite::types::ValueRef::Null => Ok(None),
        _ => row::number(r, Q, column).map(Some),
    }
}

/// `CredentialRepo.listQuota`: every stored reading.
pub fn list(conn: &Connection) -> Result<Vec<QuotaWindow>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM quota_windows")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        out.push(QuotaWindow {
            credential_id: row::text(r, Q, "credential_id")?,
            window_type: WindowType::parse(&row::text(r, Q, "window_type")?),
            starts_at: row::number(r, Q, "starts_at")?,
            used: row::number(r, Q, "used")?,
            limit: opt_number(r, "limit_value")?,
            resets_at: opt_number(r, "resets_at")?,
            observed_at: row::number(r, Q, "observed_at")?,
            window_ms: opt_number(r, "window_ms")?,
        });
    }
    Ok(out)
}
