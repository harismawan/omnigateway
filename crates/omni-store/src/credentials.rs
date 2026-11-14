//! Provider credentials with their secrets decrypted, and credential health,
//! from `packages/store/src/sqlite/credentials.ts`.
//!
//! TS decrypts lazily, per purpose. The Rust gateway holds decrypted secrets
//! in its snapshot instead (spec, "The request path" rule 1), so this read
//! opens every present field once, keyed by `token_version` so a refresh is
//! seen as a new value.

use crate::error::StoreError;
use crate::row;
use crate::vocab::{AuthType, BreakerState, DisabledReason};
use omni_crypto::field::{FieldError, FieldKey, decrypt};
use rusqlite::{Connection, Row};
use serde::Serialize;

/// One secret column.
#[derive(Clone, PartialEq, Eq)]
pub enum Secret {
    /// The column is NULL.
    Absent,
    Present(String),
    /// The column holds a value that does not open under this key. TS throws
    /// at the first use of such a field; here only this credential is
    /// affected, and its use fails rather than the whole snapshot.
    Unreadable(FieldError),
}

impl Secret {
    pub fn as_deref(&self) -> Option<&str> {
        match self {
            Self::Present(s) => Some(s),
            Self::Absent | Self::Unreadable(_) => None,
        }
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Absent => f.write_str("Absent"),
            Self::Present(_) => f.write_str("Present(..)"),
            Self::Unreadable(e) => write!(f, "Unreadable({e})"),
        }
    }
}

/// `CredentialSecrets`, decrypted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialSecrets {
    pub access_token: Secret,
    pub refresh_token: Secret,
    pub api_key: Secret,
    pub id_token: Secret,
}

/// `Credential` plus its decrypted secrets. Serializes as TS's `Credential`
/// (what `omni credentials list --json` prints): the secrets never serialize.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    #[serde(skip)]
    pub lone_endpoint: Option<Vec<u16>>,
    pub id: String,
    /// `ProviderId`: a validated string, open because plugins add providers.
    pub provider: String,
    pub label: String,
    pub auth_type: AuthType,
    pub enabled: bool,
    pub tier: f64,
    pub weight: f64,
    /// Epoch ms, or `None` when the token does not expire.
    pub expires_at: Option<i64>,
    pub account_email: Option<String>,
    /// Provider-specific durable state; an open record in TS.
    pub provider_data: serde_json::Value,
    pub disabled_reason: Option<DisabledReason>,
    pub disabled_at: Option<i64>,
    /// Derived: the refresh-token column is non-NULL.
    pub has_refresh_token: bool,
    /// Moves on every secret write; the snapshot's cache key for secrets.
    pub token_version: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip)]
    pub secrets: CredentialSecrets,
}

impl Credential {
    /// `openForInference`: the access token for OAuth, the API key otherwise.
    pub fn inference_secret(&self) -> &Secret {
        if self.auth_type == AuthType::OAuth {
            &self.secrets.access_token
        } else {
            &self.secrets.api_key
        }
    }
}

const T: &str = "credentials";

pub(crate) fn lone_fields(
    value: &omni_ir::jsjson::JsValue,
    names: &[&str],
) -> std::collections::HashMap<String, Vec<u16>> {
    let mut out = std::collections::HashMap::new();
    if let omni_ir::jsjson::JsValue::Object(fields) = value {
        for name in names {
            if let Some((_, omni_ir::jsjson::JsValue::String(units))) = fields
                .iter()
                .find(|(k, _)| k.iter().copied().eq(name.encode_utf16()))
                && String::from_utf16(units).is_err()
            {
                out.insert((*name).to_owned(), units.clone());
            }
        }
    }
    out
}

/// API-key creation values. Secret fields deliberately have no Debug implementation.
pub struct ApiKeyCredential<'a> {
    pub id: &'a str,
    pub provider: &'a str,
    pub label: &'a str,
    /// Already encoded with the lossless JavaScript JSON serializer.
    pub provider_data: &'a str,
    pub api_key: &'a str,
    pub now: i64,
}

#[derive(Default)]
pub struct CredentialPatch {
    pub label: Option<String>,
    pub enabled: Option<bool>,
    pub tier: Option<f64>,
    pub weight: Option<f64>,
}

impl CredentialPatch {
    pub fn is_empty(&self) -> bool {
        self.label.is_none()
            && self.enabled.is_none()
            && self.tier.is_none()
            && self.weight.is_none()
    }
}

pub fn create_api_key(
    conn: &Connection,
    key: &FieldKey,
    input: &ApiKeyCredential<'_>,
) -> Result<(), StoreError> {
    let sealed = omni_crypto::field::encrypt(key, input.api_key);
    conn.execute("INSERT INTO credentials(id,provider,label,auth_type,enabled,tier,weight,provider_data,api_key,created_at,updated_at) VALUES(?,?,?,'apiKey',1,1,1,?,?,?,?)",rusqlite::params![input.id,input.provider,input.label,input.provider_data,sealed,input.now,input.now])?;
    Ok(())
}

pub fn patch_metadata(
    conn: &Connection,
    id: Option<&str>,
    patch: &CredentialPatch,
    now: i64,
) -> Result<(), StoreError> {
    if patch.is_empty() {
        return Ok(());
    }
    conn.execute("UPDATE credentials SET label=COALESCE(?1,label),enabled=COALESCE(?2,enabled),tier=COALESCE(?3,tier),weight=COALESCE(?4,weight),disabled_reason=CASE WHEN ?2 IS NULL THEN disabled_reason WHEN ?2=1 THEN NULL ELSE 'manual' END,disabled_at=CASE WHEN ?2 IS NULL THEN disabled_at WHEN ?2=1 THEN NULL ELSE ?5 END,updated_at=?5 WHERE id=?6",rusqlite::params![patch.label,patch.enabled,patch.tier,patch.weight,now,id])?;
    Ok(())
}

pub fn remove(conn: &Connection, id: Option<&str>) -> Result<(), StoreError> {
    conn.execute("DELETE FROM credentials WHERE id=?", [id])?;
    Ok(())
}

/// A complete OAuth rotation. All four secret columns are replaced, including
/// NULLs; the expiry belongs to the same atomic versioned write.
/// Deliberately has no Debug implementation: contains plaintext secrets.
#[derive(Clone)]
pub struct TokenUpdate {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub api_key: Option<String>,
    pub id_token: Option<String>,
    pub expires_at: Option<i64>,
    pub updated_at: i64,
}

impl TokenUpdate {
    pub(crate) fn sealed(&self, key: &FieldKey) -> [Option<String>; 4] {
        [
            &self.access_token,
            &self.refresh_token,
            &self.api_key,
            &self.id_token,
        ]
        .map(|s| s.as_deref().map(|s| omni_crypto::field::encrypt(key, s)))
    }
}

/// Compare-and-swap against the version read before calling the token endpoint.
/// A missing row or a lost race returns false without changing any column.
pub fn update_tokens(
    conn: &Connection,
    key: &FieldKey,
    id: &str,
    update: &TokenUpdate,
    expected_version: i64,
) -> Result<bool, StoreError> {
    let sealed = update.sealed(key);
    Ok(conn.execute(
        "UPDATE credentials SET access_token=?, refresh_token=?, api_key=?, id_token=?, expires_at=?, updated_at=?, token_version=token_version+1 WHERE id=? AND token_version=?",
        rusqlite::params![sealed[0], sealed[1], sealed[2], sealed[3], update.expires_at, update.updated_at, id, expected_version],
    )? > 0)
}

fn open(r: &Row<'_>, key: &FieldKey, column: &'static str) -> Result<Secret, StoreError> {
    Ok(match row::opt_text(r, T, column)? {
        None => Secret::Absent,
        Some(sealed) => match decrypt(key, &sealed) {
            Ok(plain) => Secret::Present(plain),
            Err(e) => Secret::Unreadable(e),
        },
    })
}

fn to_credential(r: &Row<'_>, key: &FieldKey) -> Result<Credential, StoreError> {
    let raw = row::text(r, T, "provider_data")?;
    let lossless = omni_ir::jsjson::parse_js(&raw).map_err(StoreError::Corrupt)?;
    Ok(Credential {
        lone_endpoint: lone_fields(&lossless, &["endpointId"]).remove("endpointId"),
        id: row::text(r, T, "id")?,
        provider: row::text(r, T, "provider")?,
        label: row::text(r, T, "label")?,
        auth_type: AuthType::parse(&row::text(r, T, "auth_type")?),
        enabled: row::flag(r, "enabled")?,
        tier: row::number(r, T, "tier")?,
        weight: row::number(r, T, "weight")?,
        expires_at: row::opt_integer(r, T, "expires_at")?,
        account_email: row::opt_text(r, T, "account_email")?,
        provider_data: omni_ir::js::parse_json(&raw)
            .ok_or_else(|| StoreError::Corrupt("invalid provider data".into()))?,
        disabled_reason: row::opt_text(r, T, "disabled_reason")?.map(|s| DisabledReason::parse(&s)),
        disabled_at: row::opt_integer(r, T, "disabled_at")?,
        has_refresh_token: r.get_ref("refresh_token")?.data_type() != rusqlite::types::Type::Null,
        token_version: row::integer(r, T, "token_version")?,
        created_at: row::integer(r, T, "created_at")?,
        updated_at: row::integer(r, T, "updated_at")?,
        secrets: CredentialSecrets {
            access_token: open(r, key, "access_token")?,
            refresh_token: open(r, key, "refresh_token")?,
            api_key: open(r, key, "api_key")?,
            id_token: open(r, key, "id_token")?,
        },
    })
}

/// `CredentialRepo.list`, ordered by tier then label, secrets decrypted.
pub fn get(conn: &Connection, key: &FieldKey, id: &str) -> Result<Option<Credential>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM credentials WHERE id=?")?;
    let mut rows = stmt.query([id])?;
    rows.next()?.map(|r| to_credential(r, key)).transpose()
}

/// All credentials, in routing order.
pub fn list(conn: &Connection, key: &FieldKey) -> Result<Vec<Credential>, StoreError> {
    read_list(conn, key, false)
}

/// Routing alone isolates unreadable metadata; operator lists still refuse it.
pub fn list_routing(conn: &Connection, key: &FieldKey) -> Result<Vec<Credential>, StoreError> {
    read_list(conn, key, true)
}

fn read_list(
    conn: &Connection,
    key: &FieldKey,
    isolate: bool,
) -> Result<Vec<Credential>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM credentials ORDER BY tier, label")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        match to_credential(r, key) {
            Ok(credential) => out.push(credential),
            Err(_) if isolate => {
                // A metadata row that cannot be represented must not freeze
                // unrelated credentials, revocations, or model publication.
                // Never log the row or parser input (it may contain secrets).
                tracing::warn!("credential metadata unreadable; omitted from routing snapshot");
            }
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// `CredentialHealth`: what routing decides on for one (credential, model).
///
/// The instants are JS numbers: `recordFailure` adds a fractional
/// `Retry-After` and TS stores the fraction (the INTEGER-affinity column
/// keeps a non-integral REAL as REAL), so they are `f64` end to end.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialHealth {
    /// Raw unusual cells and precomputed JS arithmetic, populated at read time.
    #[serde(skip)]
    pub scalar: Option<std::sync::Arc<HealthScalars>>,
    pub credential_id: String,
    pub model: String,
    pub breaker_state: BreakerState,
    pub consecutive_failures: i64,
    pub opened_at: Option<f64>,
    pub rate_limited_until: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HealthScalars {
    pub failures: rusqlite::types::Value,
    pub opened: rusqlite::types::Value,
    pub until: rusqlite::types::Value,
    pub count: f64,
    pub score: f64,
}

impl CredentialHealth {
    #[allow(clippy::cast_precision_loss)]
    pub fn failure_number(&self) -> f64 {
        self.scalar
            .as_ref()
            .map_or(self.consecutive_failures as f64, |s| s.count)
    }

    pub fn health_score(&self) -> f64 {
        self.scalar
            .as_ref()
            .map_or_else(|| 1.0 / (1.0 + self.failure_number()), |s| s.score)
    }

    pub fn failure_cell(&self) -> rusqlite::types::Value {
        self.scalar.as_ref().map_or_else(
            || crate::js::bind_number(self.failure_number()),
            |s| s.failures.clone(),
        )
    }

    pub fn opened_cell(&self) -> rusqlite::types::Value {
        self.scalar.as_ref().map_or_else(
            || {
                self.opened_at
                    .map(crate::js::bind_number)
                    .unwrap_or(rusqlite::types::Value::Null)
            },
            |s| s.opened.clone(),
        )
    }

    pub fn until_cell(&self) -> rusqlite::types::Value {
        self.scalar.as_ref().map_or_else(
            || {
                self.rate_limited_until
                    .map(crate::js::bind_number)
                    .unwrap_or(rusqlite::types::Value::Null)
            },
            |s| s.until.clone(),
        )
    }

    /// Completion-time transitions update raw cells; routing only reads cached numbers.
    pub fn refresh_scalar(&mut self, opened: bool, until: bool) {
        if let Some(s) = &mut self.scalar {
            let s = std::sync::Arc::make_mut(s);
            if opened {
                s.opened = self
                    .opened_at
                    .map(crate::js::bind_number)
                    .unwrap_or(rusqlite::types::Value::Null);
            }
            if until {
                s.until = self
                    .rate_limited_until
                    .map(crate::js::bind_number)
                    .unwrap_or(rusqlite::types::Value::Null);
            }
        }
    }

    pub fn increment_failures(&mut self) {
        use rusqlite::types::Value;
        let raw = match self.failure_cell() {
            Value::Text(s) => Value::Text(format!("{s}1")),
            Value::Blob(bytes) => Value::Text(format!(
                "{}1",
                bytes
                    .iter()
                    .map(u8::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            )),
            _ => crate::js::bind_number(self.failure_number() + 1.0),
        };
        if let Value::Integer(n) = raw {
            self.consecutive_failures = n;
            if let Some(s) = &mut self.scalar {
                let s = std::sync::Arc::make_mut(s);
                s.failures = raw;
                s.count = crate::js::coerce_cell((&s.failures).into());
                s.score = 1.0 / (1.0 + s.count);
            }
        } else {
            let count = crate::js::coerce_cell((&raw).into());
            let denominator = match &raw {
                Value::Text(s) => omni_ir::js::string_to_number(&format!("1{s}")),
                _ => 1.0 + count,
            };
            self.scalar = Some(std::sync::Arc::new(HealthScalars {
                failures: raw,
                opened: self.opened_cell(),
                until: self.until_cell(),
                count,
                score: 1.0 / denominator,
            }));
        }
    }
}

fn health_from_row(r: &rusqlite::Row<'_>) -> Result<CredentialHealth, StoreError> {
    use rusqlite::types::ValueRef;
    let failures = r.get_ref("consecutive_failures")?;
    let opened = r.get_ref("opened_at")?;
    let until = r.get_ref("rate_limited_until")?;
    let count = crate::js::coerce_cell(failures);
    let ordinary = matches!(failures, ValueRef::Integer(_))
        && matches!(
            opened,
            ValueRef::Null | ValueRef::Integer(_) | ValueRef::Real(_)
        )
        && matches!(
            until,
            ValueRef::Null | ValueRef::Integer(_) | ValueRef::Real(_)
        );
    let scalar = (!ordinary).then(|| {
        let denominator = match failures {
            ValueRef::Text(s) => {
                omni_ir::js::string_to_number(&format!("1{}", String::from_utf8_lossy(s)))
            }
            ValueRef::Blob(bytes) => omni_ir::js::string_to_number(&format!(
                "1{}",
                bytes
                    .iter()
                    .map(u8::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            )),
            _ => 1.0 + count,
        };
        std::sync::Arc::new(HealthScalars {
            failures: crate::js::own_cell(failures),
            opened: crate::js::own_cell(opened),
            until: crate::js::own_cell(until),
            count,
            score: 1.0 / denominator,
        })
    });
    Ok(CredentialHealth {
        scalar,
        credential_id: row::text(r, H, "credential_id")?,
        model: row::text(r, H, "model")?,
        breaker_state: BreakerState::parse(
            r.get::<_, String>("breaker_state").as_deref().unwrap_or(""),
        ),
        consecutive_failures: r.get("consecutive_failures").unwrap_or(0),
        opened_at: (!matches!(opened, ValueRef::Null)).then(|| crate::js::coerce_cell(opened)),
        rate_limited_until: (!matches!(until, ValueRef::Null))
            .then(|| crate::js::coerce_cell(until)),
    })
}

const H: &str = "credential_health";

/// `CredentialRepo.listHealth`.
pub fn list_health(conn: &Connection) -> Result<Vec<CredentialHealth>, StoreError> {
    read_health_rows(conn, false)
}

/// Snapshot reads isolate unaddressable rows and preserve each scalar independently.
pub fn list_routing_health(conn: &Connection) -> Result<Vec<CredentialHealth>, StoreError> {
    read_health_rows(conn, true)
}

fn read_health_rows(conn: &Connection, isolate: bool) -> Result<Vec<CredentialHealth>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM credential_health")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let health = health_from_row(r);
        match health {
            Ok(row) => out.push(row),
            Err(_) if isolate => {
                tracing::warn!("credential health unreadable; omitted from routing snapshot")
            }
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// `UPSERT_HEALTH` in `packages/store/src/sqlite/credentials.ts`.
const UPSERT_HEALTH: &str = "INSERT INTO credential_health
   (credential_id, model, breaker_state, consecutive_failures, opened_at,
    rate_limited_until)
 VALUES (?,?,?,?,?,?)
 ON CONFLICT (credential_id, model) DO UPDATE SET
   breaker_state = excluded.breaker_state,
   consecutive_failures = excluded.consecutive_failures,
   opened_at = excluded.opened_at,
   rate_limited_until = excluded.rate_limited_until";

/// `CredentialRepo.updateHealth` on SQLite: read the stored row, apply the
/// mutation, write it, in one `IMMEDIATE` transaction (the write lock is
/// taken first, so no other connection can land between the read and the
/// write). [`StoreError::Refused`] for a row the foreign key refuses (no
/// such credential); nothing is written then, as TS's call throws.
///
/// The transaction is an RAII guard: an error, a failed COMMIT, or a panic
/// in `apply` unwinding through here all roll it back, so the connection is
/// never left inside a transaction holding the write lock. SQLite's COMMIT
/// is local, so its outcome is never uncertain.
pub fn update_health(
    conn: &Connection,
    credential_id: &str,
    model: &str,
    apply: &(dyn Fn(Option<CredentialHealth>) -> CredentialHealth + Send + Sync),
) -> Result<CredentialHealth, StoreError> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let current = read_health(&tx, credential_id, model)?;
    let next = apply(current);
    match tx.prepare_cached(UPSERT_HEALTH)?.execute(rusqlite::params![
        next.credential_id,
        next.model,
        next.breaker_state.as_str(),
        next.failure_cell(),
        next.opened_cell(),
        next.until_cell(),
    ]) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(e, msg))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            return Err(StoreError::Refused(msg.unwrap_or_else(|| e.to_string())));
        }
        Err(e) => return Err(e.into()),
    }
    // `Transaction::commit(self)` consumes the guard. If COMMIT fails (say
    // `SQLITE_BUSY`, which leaves SQLite's transaction open), the guard is
    // dropped on the way out, and rusqlite 0.41's `Drop` rolls back
    // whenever the connection is not in autocommit; after a successful
    // COMMIT it is, and the drop does nothing.
    tx.commit()?;
    Ok(next)
}

/// The stored health row for one pair, or `None`.
pub fn read_health(
    conn: &Connection,
    credential_id: &str,
    model: &str,
) -> Result<Option<CredentialHealth>, StoreError> {
    use rusqlite::OptionalExtension as _;
    conn.prepare_cached("SELECT * FROM credential_health WHERE credential_id = ? AND model = ?")?
        .query_row([credential_id, model], |r| Ok(health_from_row(r)))
        .optional()?
        .transpose()
}
/// Named accounts disclosed by the client quota surface. Secret columns are never read.
pub fn client_quota_accounts(
    conn: &rusqlite::Connection,
) -> Result<Vec<Vec<rusqlite::types::Value>>, crate::error::StoreError> {
    let mut stmt = conn.prepare("SELECT id,label,provider FROM credentials ORDER BY tier,label")?;
    let rows = stmt.query_map([], |r| {
        (0..3)
            .map(|i| r.get_ref(i).map(crate::js::own_cell))
            .collect()
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
