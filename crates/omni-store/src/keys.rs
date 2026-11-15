//! Gateway API keys, read as `toKey` in `packages/store/src/sqlite/keys.ts`.

use crate::error::StoreError;
use crate::limits::{LimitConfig, parse_limits};

use omni_ir::jsjson::JsValue;

/// `parseLimits`: `JSON.parse` then `parseLimitConfig`, `None` where either
/// throws. A JS string may hold a lone surrogate (the `/api` surface stores
/// what a client sent): such a `models` key is kept as its exact UTF-16
/// (`LimitConfig::lone_models`), never folded into U+FFFD, so `"\ud800"`,
/// `"\udc00"` and a literal U+FFFD stay three different overrides.
pub(crate) fn parse_stored_limits(raw: &str) -> Option<LimitConfig> {
    // serde refuses every lone surrogate escape, so a text it parses holds
    // none: the common case pays for one parse.
    if let Some(config) = parse_limits(raw) {
        return Some(config);
    }
    let parsed = omni_ir::jsjson::parse_js(raw).ok()?;
    let JsValue::Object(fields) = &parsed else {
        return crate::limits::parse_limit_config(&js_to_value(&parsed));
    };
    let mut root = serde_json::Map::new();
    let mut lone = Vec::new();
    for (key, value) in fields {
        let name = String::from_utf16_lossy(key);
        if name == "models"
            && let JsValue::Object(models) = value
        {
            let mut wf = serde_json::Map::new();
            for (position, (model, scope)) in models.iter().enumerate() {
                match String::from_utf16(model) {
                    Ok(model) => {
                        wf.insert(model, js_to_value(scope));
                    }
                    Err(_) => lone.push((model.clone(), position, js_to_value(scope))),
                }
            }
            root.insert(name, serde_json::Value::Object(wf));
        } else if String::from_utf16(key).is_ok() {
            root.insert(name, js_to_value(value));
        } else {
            // A lone surrogate key anywhere else is an unknown key: refused.
            return None;
        }
    }
    crate::limits::parse_limit_config_with_lone(&serde_json::Value::Object(root), lone)
}

/// A JS value as serde holds it, for a validator that only accepts numbers,
/// `null` and objects of them: a value it can hold is converted as is, and
/// one it cannot (a non-finite number, a lone surrogate string or key) to a
/// value the validator refuses just the same (a string, a key never valid).
fn js_to_value(v: &JsValue) -> serde_json::Value {
    use serde_json::Value;
    omni_ir::deep::grow(|| match v {
        JsValue::Undefined | JsValue::Function | JsValue::Null => Value::Null,
        JsValue::Bool(b) => Value::Bool(*b),
        JsValue::Number(n) => serde_json::Number::from_f64(*n)
            .map_or_else(|| Value::String("Infinity".into()), Value::Number),
        JsValue::String(s) => Value::String(String::from_utf16_lossy(s)),
        JsValue::Array(items) => Value::Array(items.iter().map(js_to_value).collect()),
        JsValue::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(k, v)| {
                    let key = String::from_utf16(k).unwrap_or_else(|_| "\u{0}lone".into());
                    (key, js_to_value(v))
                })
                .collect(),
        ),
    })
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
    /// The allowlist's well-formed names (`None`: every model). A name with
    /// a lone surrogate is in [`Self::lone_allowlist`] instead, by exact
    /// UTF-16: `includes` tells it apart from U+FFFD, and so must we.
    pub model_allowlist: Option<Vec<String>>,
    /// Allowlist entries holding a lone surrogate, as exact UTF-16, each with
    /// its position among the allowlist's names (so a writer puts it back
    /// where it stood). Only a request model with a lone surrogate can equal
    /// one.
    #[serde(skip)]
    pub lone_allowlist: Vec<(usize, Vec<u16>)>,
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

    /// `key.modelAllowlist === null || key.modelAllowlist.includes(model)`
    /// with exact JS string identity: `lone` is the request model's UTF-16
    /// where it holds a lone surrogate (then `model` is its lossy form and
    /// only a lone entry can equal it), `None` where `model` is exact.
    pub fn allows(&self, model: &str, lone: Option<&[u16]>) -> bool {
        match (&self.model_allowlist, lone) {
            (None, _) => true,
            (Some(_), Some(units)) => self.lone_allowlist.iter().any(|(_, e)| e == units),
            (Some(list), None) => list.iter().any(|m| m == model),
        }
    }
}

/// A key row the gateway reader could not read, which TS's `toKey` would
/// also have thrown on: refused at auth with `message` (what TS's thrown
/// error says), never served and never poisoning the other keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyRowError {
    pub id: String,
    pub hash: String,
    pub message: String,
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

/// `JSON.stringify(parseLimitConfig(input.limits))`, as `create` stores it:
/// the complete matrix, lone-surrogate overrides included.
pub(crate) fn limits_column(key: &ApiKey) -> Result<String, StoreError> {
    Ok(key
        .limits
        .as_ref()
        .ok_or_else(|| StoreError::Corrupt("unreadable limits".into()))?
        .to_json_text())
}

/// `setLimits`' guard: the stored text a raw limits edit writes, read with
/// `JSON.parse` semantics (a lone surrogate in an override name kept).
pub(crate) fn edited_limits(raw: &str) -> Result<String, StoreError> {
    Ok(parse_stored_limits(raw)
        .ok_or_else(|| StoreError::Corrupt("unreadable limits".into()))?
        .to_json_text())
}

/// `JSON.stringify(modelAllowlist)` for a create: every name, a lone
/// surrogate escaped where it stood.
pub(crate) fn allowlist_column(key: &ApiKey) -> Option<String> {
    let wf = key.model_allowlist.as_ref()?;
    let mut lone = key.lone_allowlist.iter().peekable();
    let mut wf_iter = wf.iter();
    let mut items = Vec::with_capacity(wf.len() + key.lone_allowlist.len());
    for position in 0..wf.len() + key.lone_allowlist.len() {
        let units = match lone.peek() {
            Some((p, _)) if *p == position => lone.next().expect("peeked").1.clone(),
            _ => match wf_iter.next() {
                Some(s) => s.encode_utf16().collect(),
                None => lone.next().expect("counted").1.clone(),
            },
        };
        items.push(JsValue::String(units));
    }
    omni_ir::jsjson::stringify(&JsValue::Array(items))
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

/// The stored `model_allowlist` as the gateway reads it: well-formed names,
/// and those holding a lone surrogate as exact UTF-16 (see
/// [`ApiKey::lone_allowlist`]).
///
/// TS is `JSON.parse(..) as string[]`: invalid JSON throws (the error's
/// message is JavaScriptCore's), and anything else is used by
/// `includes(model)`. A JSON `null` is unrestricted there too. A non-string
/// entry can never equal a model name, so dropping it changes no decision.
/// Any other non-array is a hand-edited row TS would throw on (or, for a
/// string, substring-match) at the request; it reads here as deny-all, the
/// closed direction.
pub(crate) type Allowlist = (Option<Vec<String>>, Vec<(usize, Vec<u16>)>);

pub(crate) fn parse_allowlist(id: &str, raw: Option<String>) -> Result<Allowlist, StoreError> {
    let Some(raw) = raw else {
        return Ok((None, Vec::new()));
    };
    // serde refuses every lone surrogate escape, so what it parses holds none.
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
        return Ok(match parsed {
            serde_json::Value::Null => (None, Vec::new()),
            serde_json::Value::Array(items) => (
                Some(
                    items
                        .into_iter()
                        .filter_map(|v| match v {
                            serde_json::Value::String(s) => Some(s),
                            _ => None,
                        })
                        .collect(),
                ),
                Vec::new(),
            ),
            _ => (Some(Vec::new()), Vec::new()),
        });
    }
    let parsed = omni_ir::jsjson::parse_js(&raw).map_err(|detail| StoreError::StoredJson {
        table: T,
        column: "model_allowlist",
        row_id: id.to_owned(),
        detail: detail.into(),
    })?;
    Ok(match &parsed {
        JsValue::Null => (None, Vec::new()),
        JsValue::Array(items) => {
            let mut wf = Vec::new();
            let mut lone = Vec::new();
            for item in items {
                if let JsValue::String(units) = item {
                    match String::from_utf16(units) {
                        Ok(s) => wf.push(s),
                        Err(_) => lone.push((wf.len() + lone.len(), units.clone())),
                    }
                }
            }
            (Some(wf), lone)
        }
        _ => (Some(Vec::new()), Vec::new()),
    })
}

/// What TS's `toKey` throws on for this row's allowlist, or `None`:
/// `JSON.parse(stored)`'s message, verbatim (the refusal's message at auth),
/// an empty column included (`JSON Parse error: Unexpected EOF`, not the
/// request-body wording `Request.json()` gives an empty body).
pub(crate) fn allowlist_parse_error(raw: Option<&str>) -> Option<String> {
    omni_ir::jsjson::parse_js(raw?).err()
}

/// A JS number read from a date cell as `bun:sqlite` returns it: INTEGER and
/// REAL as numbers, TEXT through `Number(text)` (a comparison coerces it),
/// NULL as `None`.
fn js_instant(r: &Row<'_>, column: &str) -> Result<Option<f64>, StoreError> {
    use rusqlite::types::ValueRef;
    #[allow(clippy::cast_precision_loss)]
    Ok(match r.get_ref(column)? {
        ValueRef::Null => None,
        ValueRef::Integer(v) => Some(v as f64),
        ValueRef::Real(v) => Some(v),
        ValueRef::Text(t) => Some(omni_ir::js::string_to_number(&String::from_utf8_lossy(t))),
        ValueRef::Blob(_) => Some(f64::NAN),
    })
}

/// `expiresAt > now` for integer `now`, as an `i64` instant: the ceiling of
/// a fractional value keeps the comparison exact; a non-number never
/// compares greater (`NaN`), so it reads as already past.
#[allow(clippy::cast_possible_truncation)]
fn expiry_instant(v: f64) -> i64 {
    if v.is_nan() {
        i64::MIN
    } else {
        v.ceil() as i64
    }
}

fn read_key(r: &Row<'_>, operator: bool) -> Result<ApiKey, StoreError> {
    let id = row::text(r, T, "id")?;
    let (model_allowlist, lone_allowlist) = parse_allowlist(
        &id,
        if operator {
            None
        } else {
            row::opt_text(r, T, "model_allowlist")?
        },
    )?;
    // `parseLimits`: unreadable (any cell `JSON.parse` + the schema refuse,
    // a non-text one included) marks the key rather than failing the read.
    let limits = row::opt_text(r, T, "limits")
        .ok()
        .flatten()
        .and_then(|raw| parse_stored_limits(&raw));
    // Dates as the JS numbers TS compares: only `revokedAt === null` and
    // `expiresAt > now` decide anything here, and both survive the integer
    // view (see [`expiry_instant`]). `createdAt` is display only.
    #[allow(clippy::cast_possible_truncation)]
    let created_at = js_instant(r, "created_at")?.map_or(0, |v| v.floor() as i64);
    #[allow(clippy::cast_possible_truncation)]
    let revoked_at =
        js_instant(r, "revoked_at")?.map(|v| if v.is_nan() { 0 } else { v.floor() as i64 });
    let expires_at = js_instant(r, "expires_at")?.map(expiry_instant);
    Ok(ApiKey {
        label: row::text(r, T, "label")?,
        prefix: row::text(r, T, "prefix")?,
        hash: row::text(r, T, "hash")?,
        model_allowlist,
        lone_allowlist,
        limits,
        // Only a stored 1 opts out.
        body_logging_opt_out: row::flag(r, "body_logging_opt_out")?,
        created_at: if operator { 0 } else { created_at },
        revoked_at,
        expires_at: if operator { None } else { expires_at },
        guardrail_policy: row::opt_text(r, T, "guardrail_policy")?,
        smart_routing: row::flag(r, "smart_routing")?,
        id,
    })
}

/// One row through [`read_key`], or the per-key refusal TS's `toKey` would
/// have thrown for it (see [`KeyRowError`]).
fn read_key_entry(r: &Row<'_>) -> Result<Option<Result<ApiKey, KeyRowError>>, StoreError> {
    match read_key(r, false) {
        Ok(key) => Ok(Some(Ok(key))),
        Err(e) => {
            let id = row::opt_text(r, T, "id").ok().flatten().unwrap_or_default();
            // A row with no text hash can never be presented: it is left out
            // (`WHERE hash = ?` never finds it either), never failing the read.
            let Some(hash) = row::opt_text(r, T, "hash").ok().flatten() else {
                tracing::warn!(apiKeyId = %id, reason = %e, "api key row without a hash skipped");
                return Ok(None);
            };
            let raw = row::opt_text(r, T, "model_allowlist").ok().flatten();
            let message = allowlist_parse_error(raw.as_deref()).unwrap_or_else(|| e.to_string());
            Ok(Some(Err(KeyRowError { id, hash, message })))
        }
    }
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
    /// As stored, like the other two dates (`revokedAt` may be fractional).
    pub revoked_at: serde_json::Value,
    pub expires_at: serde_json::Value,
}

pub fn list_operator(conn: &Connection) -> Result<Vec<OperatorKey>, StoreError> {
    operator_rows(conn, None)
}

pub fn operator_rows(conn: &Connection, id: Option<&str>) -> Result<Vec<OperatorKey>, StoreError> {
    operator_rows_with(conn, id, None)
}

/// Terminal-only cells; HTTP and routing retain the strict reader.
pub fn cli_operator_rows(
    conn: &Connection,
    id: Option<&str>,
    cell: fn(rusqlite::types::ValueRef<'_>) -> String,
) -> Result<Vec<OperatorKey>, StoreError> {
    operator_rows_with(conn, id, Some(cell))
}

fn operator_rows_with(
    conn: &Connection,
    id: Option<&str>,
    cell: Option<fn(rusqlite::types::ValueRef<'_>) -> String>,
) -> Result<Vec<OperatorKey>, StoreError> {
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
        // The cell as `bun:sqlite` returns it: an INTEGER as an integer, a
        // REAL as its number, TEXT as a string.
        let date = |name| -> Result<serde_json::Value, StoreError> {
            use rusqlite::types::ValueRef;
            Ok(match r.get_ref(name)? {
                ValueRef::Null | ValueRef::Blob(_) => serde_json::Value::Null,
                ValueRef::Integer(v) => serde_json::Value::from(v),
                ValueRef::Real(v) => serde_json::Value::from(v),
                ValueRef::Text(t) => {
                    serde_json::Value::from(String::from_utf8_lossy(t).into_owned())
                }
            })
        };
        out.push(OperatorKey {
            key: read_key(r, true)?,
            allowlist_json: if let Some(cell) = cell {
                match r.get_ref("model_allowlist")? {
                    rusqlite::types::ValueRef::Null => None,
                    raw => Some(cell(raw)),
                }
            } else {
                row::opt_text(r, T, "model_allowlist")?
            },
            limits_json: if let Some(cell) = cell {
                cell(r.get_ref("limits")?)
            } else {
                row::text(r, T, "limits")?
            },
            created_at: date("created_at")?,
            revoked_at: date("revoked_at")?,
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
            return Err(StoreError::StoredJson {
                table: T,
                column: "model_allowlist",
                row_id: id.to_owned(),
                detail: error.into(),
            });
        }
        key
    })
    .transpose()
}

/// `KeyRepo.list`: every key, newest first. A row TS's `toKey` would throw
/// on fails the whole list, as `keys.list()` does in TS (the admin listing).
pub fn list(conn: &Connection) -> Result<Vec<ApiKey>, StoreError> {
    list_entries(conn)?
        .into_iter()
        .map(|e| {
            e.map_err(|e| StoreError::StoredJson {
                table: T,
                column: "model_allowlist",
                row_id: e.id,
                detail: e.message.into(),
            })
        })
        .collect()
}

/// Every key, newest first, each read on its own: an unreadable row is that
/// key's [`KeyRowError`], never the whole read's failure. What the routing
/// snapshot loads, so one bad row cannot stop boot or a refresh.
pub fn list_entries(conn: &Connection) -> Result<Vec<Result<ApiKey, KeyRowError>>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM api_keys ORDER BY created_at DESC")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        out.extend(read_key_entry(r)?);
    }
    Ok(out)
}

/// `KeyRepo.findByHash`: the one read a snapshot miss falls back to. A row
/// TS's `toKey` would throw on is `Err(KeyRowError)` inside `Ok(Some)`.
pub fn find_entry_by_hash(
    conn: &Connection,
    hash: &str,
) -> Result<Option<Result<ApiKey, KeyRowError>>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM api_keys WHERE hash = ?")?;
    Ok(stmt
        .query_row([hash], |r| Ok(read_key_entry(r)))
        .optional()?
        .transpose()?
        .flatten())
}

/// [`find_entry_by_hash`], an unreadable row as an error.
pub fn find_by_hash(conn: &Connection, hash: &str) -> Result<Option<ApiKey>, StoreError> {
    Ok(match find_entry_by_hash(conn, hash)? {
        None => None,
        Some(Ok(k)) => Some(k),
        Some(Err(e)) => return Err(StoreError::Corrupt(e.message)),
    })
}
