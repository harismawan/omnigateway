//! Gateway API keys, read as `toKey` in `packages/store/src/sqlite/keys.ts`.

use crate::error::StoreError;
use crate::limits::{LimitConfig, parse_limits};
use crate::row;
use rusqlite::{Connection, OptionalExtension as _, Row};
use serde::Serialize;

/// `ApiKey`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub id: String,
    pub label: String,
    /// First 12 chars of the key, for display.
    pub prefix: String,
    /// `omni_crypto::apikey::hash` of the raw key.
    pub hash: String,
    pub model_allowlist: Option<Vec<String>>,
    /// `None` when the stored column could not be parsed: refused at auth,
    /// never read as unlimited. `Some` of an empty config is unlimited.
    pub limits: Option<LimitConfig>,
    pub body_logging_opt_out: bool,
    pub created_at: i64,
    pub revoked_at: Option<i64>,
    /// `None` is "never expires".
    pub expires_at: Option<i64>,
    /// `None` is "no guardrail".
    pub guardrail_policy: Option<String>,
    pub smart_routing: bool,
}

impl ApiKey {
    /// `keyUsable`: not revoked, and not past an expiry (exclusive).
    pub fn usable(&self, now_ms: i64) -> bool {
        self.revoked_at.is_none() && self.expires_at.is_none_or(|at| at > now_ms)
    }
}

const T: &str = "api_keys";

fn to_key(r: &Row<'_>) -> Result<ApiKey, StoreError> {
    let id = row::text(r, T, "id")?;
    // TS is `JSON.parse(..) as string[]`: invalid JSON throws, and anything
    // else is used by `includes(model)`. A JSON `null` is unrestricted there
    // too. A non-string entry can never equal a model name, so dropping it
    // changes no decision. Any other non-array is a hand-edited row TS would
    // throw on (or, for a string, substring-match) at the request; it reads
    // here as deny-all, the closed direction.
    let model_allowlist = match row::opt_text(r, T, "model_allowlist")? {
        None => None,
        Some(raw) => {
            let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
                StoreError::Corrupt(format!("api_keys.model_allowlist of {id}: not JSON ({e})"))
            })?;
            match parsed {
                serde_json::Value::Null => None,
                other => Some(match other {
                    serde_json::Value::Array(items) => items
                        .into_iter()
                        .filter_map(|v| match v {
                            serde_json::Value::String(s) => Some(s),
                            _ => None,
                        })
                        .collect(),
                    _ => Vec::new(),
                }),
            }
        }
    };
    // `parseLimits`: unreadable marks the key rather than failing the read.
    let limits = parse_limits(&row::text(r, T, "limits")?);
    Ok(ApiKey {
        label: row::text(r, T, "label")?,
        prefix: row::text(r, T, "prefix")?,
        hash: row::text(r, T, "hash")?,
        model_allowlist,
        limits,
        // Only a stored 1 opts out.
        body_logging_opt_out: row::flag(r, "body_logging_opt_out")?,
        created_at: row::integer(r, T, "created_at")?,
        revoked_at: row::opt_integer(r, T, "revoked_at")?,
        expires_at: row::opt_integer(r, T, "expires_at")?,
        guardrail_policy: row::opt_text(r, T, "guardrail_policy")?,
        smart_routing: row::flag(r, "smart_routing")?,
        id,
    })
}

/// `KeyRepo.list`: every key, newest first.
pub fn list(conn: &Connection) -> Result<Vec<ApiKey>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM api_keys ORDER BY created_at DESC")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        out.push(to_key(r)?);
    }
    Ok(out)
}

/// `KeyRepo.findByHash`: the one read a snapshot miss falls back to.
pub fn find_by_hash(conn: &Connection, hash: &str) -> Result<Option<ApiKey>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM api_keys WHERE hash = ?")?;
    stmt.query_row([hash], |r| Ok(to_key(r)))
        .optional()?
        .transpose()
}
