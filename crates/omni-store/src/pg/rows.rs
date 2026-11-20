//! The snapshot and operator reads on Postgres, mapped to the same types the
//! SQLite readers produce, the way `packages/store/src/postgres/*.ts` maps
//! them: `BIGINT` instants and counters to JS numbers, `BOOLEAN` flags as
//! they are, and every TEXT-held JSON parsed by the one reader both
//! backends share.

use super::query_rows;
use crate::credentials::{Credential, CredentialHealth, CredentialSecrets, Secret};
use crate::error::StoreError;
use crate::keys::{self, ApiKey, KeyEdit, OperatorKey};
use crate::models::{self, ModelRowError, OperatorCredential, OperatorModelRow, VirtualModel};
use crate::quota::{QuotaWindow, WindowType};
use crate::settings::{self, Settings};
use crate::vocab::{AuthType, BreakerState, DisabledReason};
use deadpool_postgres::GenericClient;
use omni_crypto::field::{FieldKey, decrypt};
use tokio_postgres::Row;

#[allow(clippy::cast_precision_loss)]
fn f(v: i64) -> f64 {
    v as f64
}

fn opt_f(v: Option<i64>) -> Option<f64> {
    v.map(f)
}

// --- api_keys -------------------------------------------------------------

fn to_key(r: &Row) -> Result<ApiKey, StoreError> {
    let id: String = r.try_get("id")?;
    let (model_allowlist, lone_allowlist) =
        keys::parse_allowlist(&id, r.try_get("model_allowlist")?)?;
    let limits: String = r.try_get("limits")?;
    Ok(ApiKey {
        label: r.try_get("label")?,
        prefix: r.try_get("prefix")?,
        hash: r.try_get("hash")?,
        model_allowlist,
        lone_allowlist,
        // `parseLimits`: unreadable marks the key rather than failing the read.
        limits: keys::parse_stored_limits(&limits),
        body_logging_opt_out: r.try_get("body_logging_opt_out")?,
        created_at: r.try_get("created_at")?,
        revoked_at: r.try_get("revoked_at")?,
        expires_at: r.try_get("expires_at")?,
        guardrail_policy: r.try_get("guardrail_policy")?,
        smart_routing: r.try_get("smart_routing")?,
        id,
    })
}

pub(crate) async fn list_keys(c: &impl GenericClient) -> Result<Vec<ApiKey>, StoreError> {
    list_key_entries(c)
        .await?
        .into_iter()
        .map(|e| {
            e.map_err(|e| StoreError::StoredJson {
                table: "api_keys",
                column: "model_allowlist",
                row_id: e.id,
                detail: e.message.into(),
            })
        })
        .collect()
}

/// One row through [`to_key`], or that key's [`keys::KeyRowError`] (an
/// allowlist `JSON.parse` refuses, the only per-row failure Postgres's typed
/// columns leave).
fn to_key_entry(r: &Row) -> Result<Result<ApiKey, keys::KeyRowError>, StoreError> {
    match to_key(r) {
        Ok(k) => Ok(Ok(k)),
        Err(StoreError::StoredJson { detail, .. }) => Ok(Err(keys::KeyRowError {
            id: r.try_get("id")?,
            hash: r.try_get("hash")?,
            message: detail.into_wire_detail(),
        })),
        Err(StoreError::Corrupt(e)) => {
            let raw: Option<String> = r.try_get("model_allowlist")?;
            Ok(Err(keys::KeyRowError {
                id: r.try_get("id")?,
                hash: r.try_get("hash")?,
                message: keys::allowlist_parse_error(raw.as_deref()).unwrap_or(e),
            }))
        }
        Err(e) => Err(e),
    }
}

/// Every key, each read on its own (see `keys::list_entries`).
pub(crate) async fn list_key_entries(
    c: &impl GenericClient,
) -> Result<Vec<Result<ApiKey, keys::KeyRowError>>, StoreError> {
    query_rows(c, "SELECT * FROM api_keys ORDER BY created_at DESC", &[])
        .await?
        .iter()
        .map(to_key_entry)
        .collect()
}

pub(crate) async fn find_key_entry(
    c: &impl GenericClient,
    hash: &str,
) -> Result<Option<Result<ApiKey, keys::KeyRowError>>, StoreError> {
    query_rows(c, "SELECT * FROM api_keys WHERE hash = $1", &[&hash])
        .await?
        .first()
        .map(to_key_entry)
        .transpose()
}

pub(crate) async fn key_entry_by_id(
    c: &impl GenericClient,
    id: &str,
) -> Result<Option<Result<ApiKey, keys::KeyRowError>>, StoreError> {
    query_rows(c, "SELECT * FROM api_keys WHERE id=$1", &[&id])
        .await?
        .first()
        .map(to_key_entry)
        .transpose()
}

/// `one(where, arg)`: `where` is one of two fixed column names.
pub(crate) async fn find_key(
    c: &impl GenericClient,
    column: &'static str,
    value: &str,
) -> Result<Option<ApiKey>, StoreError> {
    let sql = match column {
        "hash" => "SELECT * FROM api_keys WHERE hash = $1",
        _ => "SELECT * FROM api_keys WHERE id = $1",
    };
    query_rows(c, sql, &[&value])
        .await?
        .first()
        .map(to_key)
        .transpose()
}

pub(crate) async fn create_key(c: &impl GenericClient, key: &ApiKey) -> Result<(), StoreError> {
    let limits = keys::limits_column(key)?;
    let allowlist = keys::allowlist_column(key);
    let stmt = c
        .prepare_cached(
            "INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits,
                                   body_logging_opt_out, created_at, revoked_at, expires_at,
                                   guardrail_policy, smart_routing)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11)",
        )
        .await?;
    c.execute(
        &stmt,
        &[
            &key.id,
            &key.label,
            &key.prefix,
            &key.hash,
            &allowlist,
            &limits,
            &key.body_logging_opt_out,
            &key.created_at,
            &key.expires_at,
            &key.guardrail_policy,
            &key.smart_routing,
        ],
    )
    .await?;
    Ok(())
}

pub(crate) async fn edit_key(
    c: &impl GenericClient,
    id: &str,
    edit: KeyEdit<'_>,
) -> Result<(), StoreError> {
    match edit {
        KeyEdit::Limits(raw) => {
            let raw = keys::edited_limits(raw)?;
            query_rows(
                c,
                "UPDATE api_keys SET limits = $1 WHERE id = $2",
                &[&raw, &id],
            )
            .await?
        }
        KeyEdit::Expiry(v) => {
            query_rows(
                c,
                "UPDATE api_keys SET expires_at = $1 WHERE id = $2",
                &[&v, &id],
            )
            .await?
        }
        KeyEdit::Models(v) => {
            query_rows(
                c,
                "UPDATE api_keys SET model_allowlist = $1 WHERE id = $2",
                &[&v, &id],
            )
            .await?
        }
        KeyEdit::Guardrail(v) => {
            query_rows(
                c,
                "UPDATE api_keys SET guardrail_policy = $1 WHERE id = $2",
                &[&v, &id],
            )
            .await?
        }
        KeyEdit::SmartRouting(v) => {
            query_rows(
                c,
                "UPDATE api_keys SET smart_routing = $1 WHERE id = $2",
                &[&v, &id],
            )
            .await?
        }
        KeyEdit::Revoke(v) => {
            query_rows(
                c,
                "UPDATE api_keys SET revoked_at = $1 WHERE id = $2",
                &[&v, &id],
            )
            .await?
        }
    };
    Ok(())
}

/// The operator projection: stored allowlist text and numeric dates kept
/// as stored (see `keys::read_key(.., operator)`).
fn to_operator_key(r: &Row) -> Result<OperatorKey, StoreError> {
    let date = |name: &str| -> Result<serde_json::Value, StoreError> {
        Ok(r.try_get::<_, Option<i64>>(name)?
            .map_or(serde_json::Value::Null, serde_json::Value::from))
    };
    let limits: String = r.try_get("limits")?;
    let key = ApiKey {
        id: r.try_get("id")?,
        label: r.try_get("label")?,
        prefix: r.try_get("prefix")?,
        hash: r.try_get("hash")?,
        model_allowlist: None,
        lone_allowlist: Vec::new(),
        limits: keys::parse_stored_limits(&limits),
        body_logging_opt_out: r.try_get("body_logging_opt_out")?,
        created_at: 0,
        revoked_at: r.try_get("revoked_at")?,
        expires_at: None,
        guardrail_policy: r.try_get("guardrail_policy")?,
        smart_routing: r.try_get("smart_routing")?,
    };
    Ok(OperatorKey {
        key,
        allowlist_json: r.try_get("model_allowlist")?,
        limits_json: limits,
        created_at: date("created_at")?,
        revoked_at: date("revoked_at")?,
        expires_at: date("expires_at")?,
    })
}

pub(crate) async fn operator_keys(
    c: &impl GenericClient,
    id: Option<&str>,
) -> Result<Vec<OperatorKey>, StoreError> {
    let rows = match id {
        Some(id) => query_rows(c, "SELECT * FROM api_keys WHERE id = $1", &[&id]).await?,
        None => query_rows(c, "SELECT * FROM api_keys ORDER BY created_at DESC", &[]).await?,
    };
    rows.iter().map(to_operator_key).collect()
}

pub(crate) async fn get_operator_key(
    c: &impl GenericClient,
    id: &str,
) -> Result<Option<ApiKey>, StoreError> {
    let rows = query_rows(c, "SELECT * FROM api_keys WHERE id = $1", &[&id]).await?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let raw: Option<String> = r.try_get("model_allowlist")?;
    if let Some(raw) = raw
        && let Some(error) = omni_ir::jsc_json::parse_error(&raw)
    {
        return Err(StoreError::StoredJson {
            table: "api_keys",
            column: "model_allowlist",
            row_id: id.to_owned(),
            detail: error.into(),
        });
    }
    to_operator_key(r).map(|k| Some(k.key))
}

// --- credentials ----------------------------------------------------------

fn open(r: &Row, key: &FieldKey, column: &str) -> Result<Secret, StoreError> {
    Ok(match r.try_get::<_, Option<String>>(column)? {
        None => Secret::Absent,
        Some(sealed) => match decrypt(key, &sealed) {
            Ok(plain) => Secret::Present(plain),
            Err(e) => Secret::Unreadable(e),
        },
    })
}

fn to_credential(r: &Row, key: &FieldKey) -> Result<Credential, StoreError> {
    let provider_data: String = r.try_get("provider_data")?;
    let refresh: Option<String> = r.try_get("refresh_token")?;
    let id: String = r.try_get("id")?;
    let lossless =
        omni_ir::jsjson::parse_js(&provider_data).map_err(|detail| StoreError::StoredJson {
            table: "credentials",
            column: "provider_data",
            row_id: id.clone(),
            detail: detail.into(),
        })?;
    Ok(Credential {
        lone_endpoint: crate::credentials::lone_fields(&lossless, &["endpointId"])
            .remove("endpointId"),
        id,
        provider: r.try_get("provider")?,
        label: r.try_get("label")?,
        auth_type: AuthType::parse(r.try_get("auth_type")?),
        enabled: r.try_get("enabled")?,
        tier: f64::from(r.try_get::<_, i32>("tier")?),
        weight: r.try_get("weight")?,
        // Frozen numOrNull reads the BIGINT as a JS number.
        expires_at: r
            .try_get::<_, Option<i64>>("expires_at")?
            .map(|at| at as f64),
        account_email: r.try_get("account_email")?,
        provider_data: omni_ir::js::parse_json(&provider_data)
            .ok_or_else(|| StoreError::Corrupt("invalid provider data".into()))?,
        disabled_reason: r
            .try_get::<_, Option<&str>>("disabled_reason")?
            .map(DisabledReason::parse),
        disabled_at: r.try_get("disabled_at")?,
        has_refresh_token: refresh.is_some(),
        token_version: i64::from(r.try_get::<_, i32>("token_version")?),
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
        secrets: CredentialSecrets {
            access_token: open(r, key, "access_token")?,
            refresh_token: open(r, key, "refresh_token")?,
            api_key: open(r, key, "api_key")?,
            id_token: open(r, key, "id_token")?,
        },
    })
}

pub(crate) async fn list_credentials(
    c: &impl GenericClient,
    key: &FieldKey,
) -> Result<Vec<Credential>, StoreError> {
    query_rows(c, "SELECT * FROM credentials ORDER BY tier, label", &[])
        .await?
        .iter()
        .map(|r| to_credential(r, key))
        .collect()
}

/// Routing refresh must not freeze unrelated accounts because one row is
/// unreadable. Operator list/get retain their existing explicit error surface.
pub(crate) async fn snapshot_credentials(
    c: &impl GenericClient,
    key: &FieldKey,
) -> Result<Vec<Credential>, StoreError> {
    let rows = query_rows(c, "SELECT * FROM credentials ORDER BY tier, label", &[]).await?;
    let mut credentials = Vec::with_capacity(rows.len());
    for row in &rows {
        match to_credential(row, key) {
            Ok(credential) => credentials.push(credential),
            Err(_) => tracing::warn!("unreadable credential omitted from routing snapshot"),
        }
    }
    Ok(credentials)
}

pub(crate) async fn credential(
    c: &impl GenericClient,
    key: &FieldKey,
    id: &str,
) -> Result<Option<Credential>, StoreError> {
    query_rows(c, "SELECT * FROM credentials WHERE id=$1", &[&id])
        .await?
        .first()
        .map(|r| to_credential(r, key))
        .transpose()
}

pub(crate) async fn list_health(
    c: &impl GenericClient,
) -> Result<Vec<CredentialHealth>, StoreError> {
    query_rows(c, "SELECT * FROM credential_health", &[])
        .await?
        .iter()
        .map(to_health)
        .collect()
}

pub(crate) async fn health(
    c: &impl GenericClient,
    id: &str,
    model: &str,
) -> Result<Option<CredentialHealth>, StoreError> {
    query_rows(
        c,
        "SELECT * FROM credential_health WHERE credential_id=$1 AND model=$2",
        &[&id, &model],
    )
    .await?
    .first()
    .map(to_health)
    .transpose()
}

fn to_health(r: &Row) -> Result<CredentialHealth, StoreError> {
    Ok(CredentialHealth {
        scalar: None,
        credential_id: r.try_get("credential_id")?,
        model: r.try_get("model")?,
        breaker_state: BreakerState::parse(r.try_get("breaker_state")?),
        consecutive_failures: i64::from(r.try_get::<_, i32>("consecutive_failures")?),
        opened_at: opt_f(r.try_get("opened_at")?),
        rate_limited_until: opt_f(r.try_get("rate_limited_until")?),
    })
}

pub(crate) async fn operator_credentials(
    c: &impl GenericClient,
) -> Result<Vec<OperatorCredential>, StoreError> {
    query_rows(
        c,
        "SELECT id, provider, label, auth_type, provider_data FROM credentials ORDER BY tier, label",
        &[],
    )
    .await?
    .iter()
    .map(|r| Ok((r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, r.try_get(3)?, r.try_get(4)?)))
    .collect()
}

// --- quota ----------------------------------------------------------------

pub(crate) async fn list_quota(c: &impl GenericClient) -> Result<Vec<QuotaWindow>, StoreError> {
    query_rows(c, "SELECT * FROM quota_windows", &[])
        .await?
        .iter()
        .map(to_quota)
        .collect()
}

pub(crate) async fn quota_for(
    c: &impl GenericClient,
    id: &str,
) -> Result<Vec<QuotaWindow>, StoreError> {
    query_rows(
        c,
        "SELECT * FROM quota_windows WHERE credential_id=$1",
        &[&id],
    )
    .await?
    .iter()
    .map(to_quota)
    .collect()
}

fn to_quota(r: &Row) -> Result<QuotaWindow, StoreError> {
    Ok(QuotaWindow {
        text_spent: None,
        credential_id: r.try_get("credential_id")?,
        window_type: WindowType::parse(r.try_get("window_type")?),
        starts_at: f(r.try_get("starts_at")?),
        used: f(r.try_get("used")?),
        limit: opt_f(r.try_get("limit_value")?),
        resets_at: opt_f(r.try_get("resets_at")?),
        observed_at: f(r.try_get("observed_at")?),
        window_ms: opt_f(r.try_get("window_ms")?),
    })
}

// --- virtual_models -------------------------------------------------------

pub(crate) async fn list_models(
    c: &impl GenericClient,
) -> Result<Vec<Result<VirtualModel, ModelRowError>>, StoreError> {
    let rows = query_rows(c, "SELECT * FROM virtual_models ORDER BY id", &[]).await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let id: String = r.try_get("id")?;
        let targets: String = r.try_get("targets")?;
        let strategy: String = r.try_get("strategy")?;
        let alias: bool = r.try_get("is_alias")?;
        out.push(
            models::model_from_parts(&id, &targets, &strategy, alias)
                .map_err(|reason| ModelRowError { id, reason }),
        );
    }
    Ok(out)
}

pub(crate) async fn operator_models(
    c: &impl GenericClient,
) -> Result<Vec<OperatorModelRow>, StoreError> {
    query_rows(c, "SELECT * FROM virtual_models ORDER BY id", &[])
        .await?
        .iter()
        .map(|r| {
            Ok((
                r.try_get("id")?,
                r.try_get("targets")?,
                r.try_get("strategy")?,
                r.try_get("is_alias")?,
            ))
        })
        .collect()
}

// --- settings -------------------------------------------------------------

pub(crate) async fn read_raw_setting(
    c: &impl GenericClient,
    key: &str,
) -> Result<Option<String>, StoreError> {
    Ok(
        query_rows(c, "SELECT value FROM settings WHERE key = $1", &[&key])
            .await?
            .first()
            .map(|r| r.try_get(0))
            .transpose()?,
    )
}

pub(crate) async fn write_raw_setting(
    c: &impl GenericClient,
    key: &str,
    value: &str,
) -> Result<(), StoreError> {
    query_rows(
        c,
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        &[&key, &value],
    )
    .await?;
    Ok(())
}

pub(crate) async fn get_settings(c: &impl GenericClient) -> Result<Settings, StoreError> {
    let raw = read_raw_setting(c, "settings").await?;
    Ok(Settings::from_json(settings::settings_json(raw.as_deref())))
}

#[cfg(test)]
mod stored_json_tests {
    use crate::StoreError;

    #[test]
    fn postgres_parse_failures_redact_formats_and_preserve_wire_detail() {
        for (table, column) in [
            ("api_keys", "model_allowlist"),
            ("credentials", "provider_data"),
            ("virtual_models", "targets"),
        ] {
            let e = StoreError::StoredJson {
                table,
                column,
                row_id: "row-1".into(),
                detail: "postgresStoredCanary".to_owned().into(),
            };
            assert!(!e.to_string().contains("postgresStoredCanary"));
            assert!(!format!("{e:?}").contains("postgresStoredCanary"));
            let StoreError::StoredJson { detail, .. } = e else {
                unreachable!()
            };
            assert_eq!(detail.into_wire_detail(), "postgresStoredCanary");
        }
    }
}
