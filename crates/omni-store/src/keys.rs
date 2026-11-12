//! Gateway API keys, read as `toKey` in `packages/store/src/sqlite/keys.ts`.

use crate::error::StoreError;
use crate::limits::{LimitConfig, parse_limits};

/// `parseLimits`' `JSON.parse` then `parseLimitConfig`, where a lone
/// surrogate escape (valid to `JSON.parse`, and storable through `/api`)
/// reads as U+FFFD instead of making the whole key unreadable.
pub(crate) fn parse_stored_limits(raw: &str) -> Option<LimitConfig> {
    parse_limits(raw).or_else(|| parse_limits(&omni_ir::js::replace_lone_surrogates(raw)?))
}
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

/// Explicit mutation vocabulary; SQL identifiers never come from CLI input.
pub enum KeyEdit<'a> {
    Limits(&'a str),
    Expiry(Option<i64>),
    Models(Option<&'a str>),
    Guardrail(Option<&'a str>),
    SmartRouting(bool),
    Revoke(i64),
}

/// `JSON.stringify(parseLimitConfig(input.limits))`, as `create` stores it.
pub(crate) fn limits_column(key: &ApiKey) -> Result<String, StoreError> {
    let limits = key
        .limits
        .as_ref()
        .ok_or_else(|| StoreError::Corrupt("unreadable limits".into()))?
        .to_json();
    Ok(omni_ir::jsjson::stringify(&omni_ir::jsjson::JsValue::from(&limits)).expect("limits"))
}

/// `setLimits`' guard: the stored text a raw limits edit writes.
pub(crate) fn edited_limits(raw: &str) -> Result<String, StoreError> {
    let parsed =
        parse_limits(raw).ok_or_else(|| StoreError::Corrupt("unreadable limits".into()))?;
    Ok(
        omni_ir::jsjson::stringify(&omni_ir::jsjson::JsValue::from(&parsed.to_json()))
            .expect("limits"),
    )
}

/// `JSON.stringify(modelAllowlist)` for a create.
pub(crate) fn allowlist_column(key: &ApiKey) -> Option<String> {
    key.model_allowlist
        .as_ref()
        .map(|v| serde_json::to_string(v).expect("models"))
}

pub fn create(conn: &Connection, key: &ApiKey) -> Result<(), StoreError> {
    let limits = limits_column(key)?;
    conn.execute("INSERT INTO api_keys (id,label,prefix,hash,model_allowlist,limits,body_logging_opt_out,created_at,revoked_at,expires_at,guardrail_policy,smart_routing) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?)",rusqlite::params![key.id,key.label,key.prefix,key.hash,allowlist_column(key),limits,i64::from(key.body_logging_opt_out),key.created_at,key.expires_at,key.guardrail_policy,i64::from(key.smart_routing)])?;
    Ok(())
}

pub fn edit(conn: &Connection, id: &str, edit: KeyEdit<'_>) -> Result<(), StoreError> {
    match edit {
        KeyEdit::Limits(v) => {
            let raw = edited_limits(v)?;
            conn.execute(
                "UPDATE api_keys SET limits = ? WHERE id = ?",
                rusqlite::params![raw, id],
            )?
        }
        KeyEdit::Expiry(v) => conn.execute(
            "UPDATE api_keys SET expires_at = ? WHERE id = ?",
            rusqlite::params![v, id],
        )?,
        KeyEdit::Models(v) => conn.execute(
            "UPDATE api_keys SET model_allowlist = ? WHERE id = ?",
            rusqlite::params![v, id],
        )?,
        KeyEdit::Guardrail(v) => conn.execute(
            "UPDATE api_keys SET guardrail_policy = ? WHERE id = ?",
            rusqlite::params![v, id],
        )?,
        KeyEdit::SmartRouting(v) => conn.execute(
            "UPDATE api_keys SET smart_routing = ? WHERE id = ?",
            rusqlite::params![i64::from(v), id],
        )?,
        KeyEdit::Revoke(v) => conn.execute(
            "UPDATE api_keys SET revoked_at = ? WHERE id = ?",
            rusqlite::params![v, id],
        )?,
    };
    Ok(())
}

/// The stored `model_allowlist` as the gateway reads it.
///
/// TS is `JSON.parse(..) as string[]`: invalid JSON throws, and anything
/// else is used by `includes(model)`. A JSON `null` is unrestricted there
/// too. A non-string entry can never equal a model name, so dropping it
/// changes no decision. Any other non-array is a hand-edited row TS would
/// throw on (or, for a string, substring-match) at the request; it reads
/// here as deny-all, the closed direction.
pub(crate) fn parse_allowlist(
    id: &str,
    raw: Option<String>,
) -> Result<Option<Vec<String>>, StoreError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    // A lone surrogate escape (valid to `JSON.parse`) reads as U+FFFD.
    let parsed: serde_json::Value = omni_ir::js::parse_json(&raw).ok_or_else(|| {
        let e = serde_json::from_str::<serde_json::Value>(&raw)
            .err()
            .map_or_else(String::new, |e| e.to_string());
        StoreError::Corrupt(format!("api_keys.model_allowlist of {id}: not JSON ({e})"))
    })?;
    Ok(match parsed {
        serde_json::Value::Null => None,
        serde_json::Value::Array(items) => Some(
            items
                .into_iter()
                .filter_map(|v| match v {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .collect(),
        ),
        _ => Some(Vec::new()),
    })
}

fn to_key(r: &Row<'_>) -> Result<ApiKey, StoreError> {
    read_key(r, false)
}

fn read_key(r: &Row<'_>, operator: bool) -> Result<ApiKey, StoreError> {
    let id = row::text(r, T, "id")?;
    let model_allowlist = parse_allowlist(
        &id,
        if operator {
            None
        } else {
            row::opt_text(r, T, "model_allowlist")?
        },
    )?;
    // `parseLimits`: unreadable marks the key rather than failing the read.
    let limits = parse_stored_limits(&row::text(r, T, "limits")?);
    Ok(ApiKey {
        label: row::text(r, T, "label")?,
        prefix: row::text(r, T, "prefix")?,
        hash: row::text(r, T, "hash")?,
        model_allowlist,
        limits,
        // Only a stored 1 opts out.
        body_logging_opt_out: row::flag(r, "body_logging_opt_out")?,
        created_at: if operator {
            0
        } else {
            row::integer(r, T, "created_at")?
        },
        revoked_at: row::opt_integer(r, T, "revoked_at")?,
        expires_at: if operator {
            None
        } else {
            row::opt_integer(r, T, "expires_at")?
        },
        guardrail_policy: row::opt_text(r, T, "guardrail_policy")?,
        smart_routing: row::flag(r, "smart_routing")?,
        id,
    })
}

/// Operator projection preserves stored allowlist JSON and numeric dates. The
/// gateway continues to use its fail-closed, normalized reader above.
pub struct OperatorKey {
    pub key: ApiKey,
    pub allowlist_json: Option<String>,
    /// The stored `limits` text, unparsed: the HTTP listing re-reads it with
    /// JS string semantics (lone surrogates included), which serde cannot.
    pub limits_json: String,
    pub created_at: serde_json::Value,
    pub expires_at: serde_json::Value,
}

pub fn list_operator(conn: &Connection) -> Result<Vec<OperatorKey>, StoreError> {
    operator_rows(conn, None)
}

pub fn operator_rows(conn: &Connection, id: Option<&str>) -> Result<Vec<OperatorKey>, StoreError> {
    let mut stmt = conn.prepare_cached(if id.is_some() {
        "SELECT * FROM api_keys WHERE id = ?1"
    } else {
        "SELECT * FROM api_keys ORDER BY created_at DESC"
    })?;
    let mut rows = if let Some(id) = id {
        stmt.query([id])?
    } else {
        stmt.query([])?
    };
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let date = |name| -> Result<serde_json::Value, StoreError> {
            Ok(r.get::<_, Option<f64>>(name)?
                .map_or(serde_json::Value::Null, serde_json::Value::from))
        };
        out.push(OperatorKey {
            key: read_key(r, true)?,
            allowlist_json: row::opt_text(r, T, "model_allowlist")?,
            limits_json: row::text(r, T, "limits")?,
            created_at: date("created_at")?,
            expires_at: date("expires_at")?,
        });
    }
    Ok(out)
}

/// One new key's columns, already encoded as `KeyRepo.create` encodes
/// them (`JSON.stringify` of the allowlist and of the parsed limits).
///
/// For callers that validated the input with JS string semantics (the
/// `/api` surface): text that cannot be round-tripped through serde, such as
/// a lone surrogate escaped in a model name, is written exactly as given.
#[derive(Debug, Clone, Copy)]
pub struct NewKeyColumns<'a> {
    pub id: &'a str,
    pub label: &'a str,
    pub prefix: &'a str,
    pub hash: &'a str,
    pub model_allowlist: Option<&'a str>,
    pub limits: &'a str,
    pub body_logging_opt_out: bool,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub guardrail_policy: Option<&'a str>,
    pub smart_routing: bool,
}

/// `KeyRepo.create` with pre-encoded columns (see [`NewKeyColumns`]).
pub fn create_columns(conn: &Connection, k: &NewKeyColumns<'_>) -> Result<(), StoreError> {
    conn.execute("INSERT INTO api_keys (id,label,prefix,hash,model_allowlist,limits,body_logging_opt_out,created_at,revoked_at,expires_at,guardrail_policy,smart_routing) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?)",rusqlite::params![k.id,k.label,k.prefix,k.hash,k.model_allowlist,k.limits,i64::from(k.body_logging_opt_out),k.created_at,k.expires_at,k.guardrail_policy,i64::from(k.smart_routing)])?;
    Ok(())
}

/// `KeyRepo.setLimits` for a matrix the caller already ran through
/// `parseLimitConfig` and encoded: written as given (see [`NewKeyColumns`]).
pub fn set_limits_encoded(conn: &Connection, id: &str, limits: &str) -> Result<(), StoreError> {
    conn.execute(
        "UPDATE api_keys SET limits = ? WHERE id = ?",
        rusqlite::params![limits, id],
    )?;
    Ok(())
}

/// Control writes inspect the target row with TS's raw allowlist semantics,
/// rather than using the admission reader or parsing unrelated keys.
pub fn get_operator(conn: &Connection, id: &str) -> Result<Option<ApiKey>, StoreError> {
    conn.query_row("SELECT * FROM api_keys WHERE id = ?", [id], |r| {
        Ok((
            read_key(r, true),
            r.get::<_, Option<String>>("model_allowlist")?,
        ))
    })
    .optional()?
    .map(|(key, raw)| {
        if let Some(raw) = raw
            && let Some(error) = omni_ir::jsc_json::parse_error(&raw)
        {
            return Err(StoreError::Corrupt(error));
        }
        key
    })
    .transpose()
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
