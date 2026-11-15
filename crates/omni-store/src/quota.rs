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
    /// Snapshot-time JS relational comparison over raw SQLite primitives.
    #[serde(skip)]
    pub text_spent: Option<bool>,
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

impl QuotaWindow {
    pub fn spent(&self) -> bool {
        self.text_spent
            .unwrap_or_else(|| self.limit.is_some_and(|l| self.used >= l))
    }
}

const Q: &str = "quota_windows";

/// Bounded newest-first sample read; the caller applies the frozen JS re-sort.
pub fn list_quota_samples(
    conn: &Connection,
    since: f64,
    until: f64,
    limit: usize,
) -> Result<Vec<Vec<rusqlite::types::Value>>, StoreError> {
    let mut stmt = conn.prepare("SELECT credential_id,window_type,used,limit_value,resets_at,observed_at,window_ms FROM quota_samples WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT ?")?;
    let rows = stmt.query_map(rusqlite::params![since, until, limit as i64], |r| {
        (0..7)
            .map(|i| r.get_ref(i).map(crate::js::own_cell))
            .collect()
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Lossless cells for the client projection; coercion belongs to control.
pub struct CompactSamples {
    pub cells: Vec<rusqlite::types::Value>,
    pub series: Vec<[usize; 2]>,
    pub values: Vec<[rusqlite::types::Value; 5]>,
}

/// Same SQL order as list_quota_samples, with exact typed series-cell interning.
pub fn list_compact_quota_samples(
    conn: &Connection,
    since: f64,
    until: f64,
    limit: usize,
) -> Result<CompactSamples, StoreError> {
    use rusqlite::types::ValueRef;
    #[derive(Hash, PartialEq, Eq)]
    enum Key<'a> {
        Null,
        Integer(i64),
        Real(u64),
        Text(&'a [u8]),
        Blob(&'a [u8]),
    }
    fn key(v: ValueRef<'_>) -> Key<'_> {
        match v {
            ValueRef::Null => Key::Null,
            ValueRef::Integer(n) => Key::Integer(n),
            ValueRef::Real(n) => Key::Real(n.to_bits()),
            ValueRef::Text(s) => Key::Text(s),
            ValueRef::Blob(s) => Key::Blob(s),
        }
    }
    // Hash buckets borrow SQLite bytes for lookup; equality checks preserve
    // SQLite types and bit patterns, including signed zero and blob identity.
    use std::hash::{Hash, Hasher};
    let mut buckets: std::collections::HashMap<u64, Vec<usize>> = std::collections::HashMap::new();
    let mut raw = Vec::<(u8, Vec<u8>)>::new();
    let mut out = CompactSamples {
        cells: Vec::new(),
        series: Vec::with_capacity(limit.min(50_001)),
        values: Vec::with_capacity(limit.min(50_001)),
    };
    let mut stmt = conn.prepare_cached("SELECT credential_id,window_type,used,limit_value,resets_at,observed_at,window_ms FROM quota_samples WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT ?")?;
    let mut rows = stmt.query(rusqlite::params![since, until, limit as i64])?;
    while let Some(r) = rows.next()? {
        let mut series = [0; 2];
        for (i, slot) in series.iter_mut().enumerate() {
            let v = r.get_ref(i)?;
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            key(v).hash(&mut hash);
            let bucket = buckets.entry(hash.finish()).or_default();
            let (tag, bytes): (u8, std::borrow::Cow<'_, [u8]>) = match v {
                ValueRef::Null => (0, (&[][..]).into()),
                ValueRef::Integer(n) => (1, n.to_le_bytes().to_vec().into()),
                ValueRef::Real(n) => (2, n.to_bits().to_le_bytes().to_vec().into()),
                ValueRef::Text(s) => (3, s.into()),
                ValueRef::Blob(s) => (4, s.into()),
            };
            *slot = if let Some(id) = bucket
                .iter()
                .find(|id| raw[**id].0 == tag && raw[**id].1 == *bytes)
            {
                *id
            } else {
                let id = out.cells.len();
                out.cells.push(crate::js::own_cell(v));
                raw.push((tag, bytes.into_owned()));
                bucket.push(id);
                id
            };
        }
        out.series.push(series);
        out.values.push([
            crate::js::own_cell(r.get_ref(2)?),
            crate::js::own_cell(r.get_ref(3)?),
            crate::js::own_cell(r.get_ref(4)?),
            crate::js::own_cell(r.get_ref(5)?),
            crate::js::own_cell(r.get_ref(6)?),
        ]);
    }
    Ok(out)
}

/// Lossless cells for the client projection; coercion belongs to control.
pub fn client_windows(conn: &Connection) -> Result<Vec<Vec<rusqlite::types::Value>>, StoreError> {
    let mut stmt = conn.prepare("SELECT credential_id,window_type,used,limit_value,resets_at,observed_at,window_ms FROM quota_windows")?;
    let rows = stmt.query_map([], |r| {
        (0..7)
            .map(|i| r.get_ref(i).map(crate::js::own_cell))
            .collect()
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn opt_number(r: &rusqlite::Row<'_>, column: &str) -> Result<Option<f64>, StoreError> {
    match r.get_ref(column)? {
        rusqlite::types::ValueRef::Null => Ok(None),
        v => Ok(Some(crate::js::coerce_cell(v))),
    }
}

/// `CredentialRepo.listQuota`: every stored reading.
pub fn list(conn: &Connection) -> Result<Vec<QuotaWindow>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM quota_windows")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        // A non-string JS Map key cannot match a credential's string id.
        let Ok(credential_id) = row::text(r, Q, "credential_id") else {
            tracing::warn!("unaddressable quota credential id omitted from routing snapshot");
            continue;
        };
        // Unknown window names still enforce their ceiling in TS. A BLOB's
        // Uint8Array string form is used in exclusion messages; its duration
        // lookup is unknown (NaN), just like an unknown text name.
        let window_name = match r.get_ref("window_type")? {
            rusqlite::types::ValueRef::Text(s) => String::from_utf8_lossy(s).into_owned(),
            rusqlite::types::ValueRef::Blob(b) => {
                b.iter().map(u8::to_string).collect::<Vec<_>>().join(",")
            }
            rusqlite::types::ValueRef::Null => "null".into(),
            v => crate::js::number_to_string(crate::js::coerce_cell(v)),
        };
        out.push(QuotaWindow {
            text_spent: Some(relational_spent(
                r.get_ref("used")?,
                r.get_ref("limit_value")?,
            )),
            credential_id,
            window_type: WindowType::parse(&window_name),
            starts_at: crate::js::coerce_cell(r.get_ref("starts_at")?),
            used: crate::js::coerce_cell(r.get_ref("used")?),
            limit: opt_number(r, "limit_value")?,
            resets_at: opt_number(r, "resets_at")?,
            observed_at: crate::js::coerce_cell(r.get_ref("observed_at")?),
            window_ms: opt_number(r, "window_ms")?,
        });
    }
    Ok(out)
}

/// JS ToPrimitive precedes relational comparison: Uint8Array becomes a
/// comma-separated string. Only two string primitives compare lexically;
/// every other pair uses ToNumber. The router exempts a NULL ceiling first.
fn relational_spent(
    used: rusqlite::types::ValueRef<'_>,
    limit: rusqlite::types::ValueRef<'_>,
) -> bool {
    use rusqlite::types::ValueRef;
    fn string_primitive(v: ValueRef<'_>) -> Option<String> {
        match v {
            ValueRef::Text(s) => Some(String::from_utf8_lossy(s).into_owned()),
            ValueRef::Blob(b) => Some(b.iter().map(u8::to_string).collect::<Vec<_>>().join(",")),
            _ => None,
        }
    }
    if matches!(limit, ValueRef::Null) {
        return false;
    }
    match (string_primitive(used), string_primitive(limit)) {
        (Some(a), Some(b)) => a.encode_utf16().cmp(b.encode_utf16()).is_ge(),
        _ => crate::js::coerce_cell(used) >= crate::js::coerce_cell(limit),
    }
}
