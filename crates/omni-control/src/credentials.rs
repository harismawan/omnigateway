//! Credential administration. Metadata reads never open secret columns.
use crate::api::Failure;
use crate::body_schema::{Z, parse_or_throw, trim_units};
use crate::settings_value::get;
use omni_ir::jsjson::JsValue;
use omni_store::SqliteStore;
use rusqlite::types::ValueRef;

type Result<T> = std::result::Result<T, Failure>;
fn stringify(v: &JsValue) -> String {
    omni_ir::jsjson::stringify(v).unwrap_or_default()
}
fn text(s: &str) -> JsValue {
    JsValue::String(s.encode_utf16().collect())
}
fn obj(fields: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn sql_value(v: ValueRef<'_>) -> JsValue {
    match v {
        ValueRef::Null => JsValue::Null,
        ValueRef::Integer(n) => JsValue::Number(n as f64),
        ValueRef::Real(n) => JsValue::Number(n),
        ValueRef::Text(s) | ValueRef::Blob(s) => text(&String::from_utf8_lossy(s)),
    }
}
fn provider_data(raw: ValueRef<'_>, id: ValueRef<'_>) -> Result<JsValue> {
    crate::cli_cell::json(raw).map_err(|_| {
        Failure::internal(format!(
            "invalid credential provider_data: id={}",
            stringify(&crate::cli_cell::Cell::read(id).json())
        ))
    })
}

/// Match credentials.list's whole-list JSON failure without opening secret columns.
pub(crate) fn validate_client_metadata(s: &SqliteStore) -> Result<()> {
    let mut stmt = s
        .connection()
        .prepare("SELECT provider_data,id FROM credentials")
        .map_err(Failure::internal)?;
    let mut rows = stmt.query([]).map_err(Failure::internal)?;
    while let Some(row) = rows.next().map_err(Failure::internal)? {
        provider_data(
            row.get_ref(0).map_err(Failure::internal)?,
            row.get_ref(1).map_err(Failure::internal)?,
        )?;
    }
    Ok(())
}
pub(crate) fn rows(s: &SqliteStore, id: Option<&str>) -> Result<Vec<JsValue>> {
    rows_with(
        s,
        id,
        |raw, id| {
            crate::cli_cell::json(raw).map_err(|_| {
                Failure::internal(format!(
                    "invalid credential provider_data: id={}",
                    stringify(&crate::cli_cell::Cell::read(id).json())
                ))
            })
        },
        true,
    )
}

/// Only the serving facts needed by agent setup. Do not select secret columns.
pub(crate) fn setup_rows(s: &SqliteStore) -> Result<Vec<JsValue>> {
    let mut stmt = s
        .connection()
        .prepare("SELECT id,provider,auth_type,enabled,provider_data FROM credentials ORDER BY tier,label")
        .map_err(Failure::internal)?;
    let mut rs = stmt.query([]).map_err(Failure::internal)?;
    let mut out = Vec::new();
    while let Some(row) = rs.next().map_err(Failure::internal)? {
        let cell = |i| row.get_ref(i).map_err(Failure::internal);
        let id = cell(0)?;
        out.push(obj(vec![
            ("id", sql_value(id)),
            ("provider", sql_value(cell(1)?)),
            ("authType", sql_value(cell(2)?)),
            ("enabled", enabled(cell(3)?)),
            ("providerData", provider_data(cell(4)?, id)?),
        ]));
    }
    Ok(out)
}

fn enabled(raw: ValueRef<'_>) -> JsValue {
    JsValue::Bool(matches!(raw, ValueRef::Integer(1)) || matches!(raw,ValueRef::Real(n) if n==1.0))
}

fn rows_with(
    s: &SqliteStore,
    id: Option<&str>,
    parse: fn(ValueRef<'_>, ValueRef<'_>) -> Result<JsValue>,
    terminal: bool,
) -> Result<Vec<JsValue>> {
    let mut stmt = s
        .connection()
        .prepare("SELECT * FROM credentials WHERE (?1 IS NULL OR id=?1) ORDER BY tier,label")
        .map_err(Failure::internal)?;
    let mut rs = stmt.query([id]).map_err(Failure::internal)?;
    let mut out = Vec::new();
    while let Some(r) = rs.next().map_err(Failure::internal)? {
        let mut fields = Vec::new();
        for (k, col) in [
            ("id", "id"),
            ("provider", "provider"),
            ("label", "label"),
            ("authType", "auth_type"),
            ("enabled", "enabled"),
            ("tier", "tier"),
            ("weight", "weight"),
            ("expiresAt", "expires_at"),
            ("accountEmail", "account_email"),
            ("providerData", "provider_data"),
            ("disabledReason", "disabled_reason"),
            ("disabledAt", "disabled_at"),
            ("hasRefreshToken", "refresh_token"),
            ("tokenVersion", "token_version"),
            ("createdAt", "created_at"),
            ("updatedAt", "updated_at"),
        ] {
            let raw = r.get_ref(col).map_err(Failure::internal)?;
            let v = match k {
                "enabled" => enabled(raw),
                "hasRefreshToken" => JsValue::Bool(!matches!(raw, ValueRef::Null)),
                "providerData" => parse(raw, r.get_ref("id").map_err(Failure::internal)?)?,
                _ if terminal => crate::cli_cell::Cell::read(raw).json(),
                _ => sql_value(raw),
            };
            fields.push((k, v));
        }
        out.push(obj(fields));
    }
    Ok(out)
}
pub fn list(s: &SqliteStore) -> Result<String> {
    Ok(stringify(&obj(vec![(
        "credentials",
        JsValue::Array(rows(s, None)?),
    )])))
}
/// Frozen CLI status propagates JSON.parse diagnostics; HTTP retains its safe failures.
pub fn cli_list(s: &SqliteStore) -> std::result::Result<String, String> {
    Ok(stringify(&obj(vec![(
        "credentials",
        JsValue::Array(cli_rows(s)?),
    )])))
}
pub fn cli_rows(s: &SqliteStore) -> std::result::Result<Vec<JsValue>, String> {
    cli_rows_for(s, None)
}
/// A show command must not parse metadata belonging to unrelated accounts.
pub fn cli_rows_for(
    s: &SqliteStore,
    id: Option<&str>,
) -> std::result::Result<Vec<JsValue>, String> {
    let rows = rows_with(
        s,
        id,
        |raw, _| crate::cli_cell::json(raw).map_err(Failure::internal),
        true,
    )
    .map_err(|e| e.message)?;
    Ok(rows)
}
pub fn health(s: &SqliteStore, now: i64) -> Result<String> {
    Ok(stringify(&health_value(s, now, false)?))
}
/// CLI keeps non-finite numbers and BLOB identities until its final renderer.
pub fn cli_health(s: &SqliteStore, now: i64) -> std::result::Result<JsValue, String> {
    health_value(s, now, true).map_err(|e| e.message)
}
fn health_value(s: &SqliteStore, now: i64, cli: bool) -> Result<JsValue> {
    let mut statement = s
        .connection()
        .prepare("SELECT * FROM credential_health")
        .map_err(Failure::internal)?;
    let mut cursor = statement.query([]).map_err(Failure::internal)?;
    let mut health = Vec::new();
    while let Some(row) = cursor.next().map_err(Failure::internal)? {
        let mut fields = Vec::new();
        for (name, column) in [
            ("credentialId", "credential_id"),
            ("model", "model"),
            ("breakerState", "breaker_state"),
            ("consecutiveFailures", "consecutive_failures"),
            ("openedAt", "opened_at"),
            ("rateLimitedUntil", "rate_limited_until"),
        ] {
            fields.push((
                name,
                crate::cli_cell::Cell::read(row.get_ref(column).map_err(Failure::internal)?).json(),
            ));
        }
        health.push(obj(fields));
    }
    let mut statement = s
        .connection()
        .prepare("SELECT * FROM quota_windows")
        .map_err(Failure::internal)?;
    let mut cursor = statement.query([]).map_err(Failure::internal)?;
    let mut quota_json = Vec::new();
    let mut quota = Vec::new();
    while let Some(row) = cursor.next().map_err(Failure::internal)? {
        let mut fields = Vec::new();
        for (name, column) in [
            ("credentialId", "credential_id"),
            ("windowType", "window_type"),
            ("startsAt", "starts_at"),
            ("used", "used"),
            ("limit", "limit_value"),
            ("resetsAt", "resets_at"),
            ("observedAt", "observed_at"),
            ("windowMs", "window_ms"),
        ] {
            fields.push((
                name,
                crate::cli_cell::Cell::read(row.get_ref(column).map_err(Failure::internal)?).json(),
            ));
        }
        let value = obj(fields);
        let number = |name| crate::cli_cell::scalar_number(get(&value, name).expect("quota field"));
        let optional = |name| {
            if matches!(get(&value, name), Some(JsValue::Null)) {
                None
            } else {
                Some(number(name))
            }
        };
        quota.push(omni_store::QuotaWindow {
            text_spent: None,
            credential_id: String::new(), // output retains the raw SQLite identity below
            window_type: omni_store::quota::WindowType::parse(&match get(&value, "windowType") {
                Some(JsValue::String(units)) => String::from_utf16_lossy(units),
                _ => String::new(),
            }),
            starts_at: number("startsAt"),
            used: number("used"),
            limit: optional("limit"),
            resets_at: optional("resetsAt"),
            observed_at: number("observedAt"),
            window_ms: optional("windowMs"),
        });
        quota_json.push(value);
    }
    let settings = s.get_settings()?;
    // list() parses every credential's metadata before the per-id seeks.
    if cli {
        cli_rows(s).map_err(Failure::internal)?;
    } else {
        rows(s, None)?;
    }
    let mut ids = s
        .connection()
        .prepare("SELECT id FROM credentials ORDER BY tier,label")
        .map_err(Failure::internal)?;
    let mut credentials = ids.query([]).map_err(Failure::internal)?;
    let mut last_used = Vec::new();
    while let Some(c) = credentials.next().map_err(Failure::internal)? {
        let raw = c.get_ref(0).map_err(Failure::internal)?;
        let id = crate::cli_cell::Cell::read(raw).json();
        let at = s
            .connection()
            .query_row(
                "SELECT MAX(at) FROM request_logs WHERE credential_id=?",
                [crate::database::bun_cell(raw)],
                |r| Ok(crate::cli_cell::Cell::read(r.get_ref(0)?).json()),
            )
            .map_err(Failure::internal)?;
        if !matches!(at, JsValue::Null) {
            last_used.push((
                crate::cli_cell::scalar_string(&id).encode_utf16().collect(),
                at,
            ));
        }
    }
    Ok(health_response(
        health,
        quota,
        quota_json,
        last_used,
        now,
        settings.quota_poll_interval_ms,
    ))
}

pub async fn health_postgres(pg: &omni_store::pg::PgStore, now: i64) -> Result<String> {
    pg_rows(pg, None).await?;
    let health = pg
        .list_health()
        .await?
        .iter()
        .map(|r| {
            JsValue::from(
                &serde_json::json!({"credentialId":r.credential_id,"model":r.model,
            "breakerState":r.breaker_state,"consecutiveFailures":r.consecutive_failures,
            "openedAt":r.opened_at,"rateLimitedUntil":r.rate_limited_until}),
            )
        })
        .collect();
    let quota = pg.list_quota().await?;
    let quota_json = quota
        .iter()
        .map(|r| JsValue::from(&serde_json::json!(r)))
        .collect();
    let last_used = pg
        .last_used_by_credential()
        .await?
        .into_iter()
        .map(|(id, at)| {
            (
                id.encode_utf16().collect(),
                JsValue::from(&serde_json::Value::from(at)),
            )
        })
        .collect();
    Ok(stringify(&health_response(
        health,
        quota,
        quota_json,
        last_used,
        now,
        pg.get_settings().await?.quota_poll_interval_ms,
    )))
}

fn health_response(
    health: Vec<JsValue>,
    quota: Vec<omni_store::QuotaWindow>,
    quota_json: Vec<JsValue>,
    last_used: Vec<(Vec<u16>, JsValue)>,
    now: i64,
    poll: f64,
) -> JsValue {
    let burn = quota
        .iter()
        .zip(&quota_json)
        .map(|(q, raw)| {
            let stale =
                q.observed_at <= 0.0 || now as f64 - q.observed_at > poll.max(60_000.0) * 3.0;
            let rolled = q.resets_at.is_some_and(|r| r <= now as f64);
            let start = if stale {
                None
            } else {
                q.resets_at.map(|r| {
                    r - q
                        .window_ms
                        .filter(|n| *n > 0.0)
                        .unwrap_or_else(|| q.window_type.nominal_ms())
                })
            };
            let rate = if stale || rolled {
                None
            } else {
                start.map(|start| {
                    let elapsed = (q.observed_at - start) / 3_600_000.0;
                    // Frozen tests raw `window.used === 0`, not ToNumber(used).
                    if elapsed <= 0.0 || get(raw, "used") == Some(&JsValue::Number(0.0)) {
                        0.0
                    } else {
                        q.used / elapsed
                    }
                })
            };
            let exhausts = q.limit.zip(rate).and_then(|(limit, rate)| {
                if limit <= 0.0 || rate <= 0.0 {
                    None
                } else {
                    let remaining = limit - q.used;
                    Some(
                        q.observed_at
                            + (if remaining.is_nan() {
                                f64::NAN
                            } else {
                                remaining.max(0.0)
                            } / rate)
                                * 3_600_000.0,
                    )
                }
            });
            let exhaust_value = match (exhausts, get(raw, "observedAt")) {
                (Some(_), Some(observed @ (JsValue::String(_) | JsValue::Object(_)))) => {
                    let remaining = q.limit.unwrap_or(f64::NAN) - q.used;
                    let delta = (if remaining.is_nan() {
                        f64::NAN
                    } else {
                        remaining.max(0.0)
                    } / rate.unwrap_or(f64::NAN))
                        * 3_600_000.0;
                    let suffix = if delta.is_nan() {
                        "NaN".to_owned()
                    } else if delta == f64::INFINITY {
                        "Infinity".into()
                    } else if delta == f64::NEG_INFINITY {
                        "-Infinity".into()
                    } else {
                        let mut s = String::new();
                        omni_ir::jsjson::write_number(delta, &mut s);
                        s
                    };
                    let mut value: Vec<u16> = crate::cli_cell::scalar_string(observed)
                        .encode_utf16()
                        .collect();
                    value.extend(suffix.encode_utf16());
                    JsValue::String(value)
                }
                _ => exhausts.map_or(JsValue::Null, JsValue::Number),
            };
            let survives = if exhausts.is_none() || q.resets_at.is_none() {
                true
            } else {
                match (&exhaust_value, get(raw, "resetsAt")) {
                    (JsValue::String(a), Some(JsValue::String(b))) => a >= b,
                    (JsValue::String(a), Some(b @ JsValue::Object(_))) => {
                        // Uint8Array ToPrimitive is a comma-joined string, so
                        // two strings compare lexically, not numerically.
                        a.iter()
                            .copied()
                            .cmp(crate::cli_cell::scalar_string(b).encode_utf16())
                            != std::cmp::Ordering::Less
                    }
                    (JsValue::String(a), _) => {
                        omni_ir::js::string_to_number(&String::from_utf16_lossy(a))
                            >= q.resets_at.unwrap_or(f64::NAN)
                    }
                    _ => exhausts.unwrap_or(f64::NAN) >= q.resets_at.unwrap_or(f64::NAN),
                }
            };
            obj(vec![
                (
                    "credentialId",
                    get(raw, "credentialId").expect("quota field").clone(),
                ),
                (
                    "windowType",
                    get(raw, "windowType").expect("quota field").clone(),
                ),
                (
                    "windowStartsAt",
                    start.map_or(JsValue::Null, JsValue::Number),
                ),
                ("ratePerHour", rate.map_or(JsValue::Null, JsValue::Number)),
                ("exhaustsAt", exhaust_value),
                (
                    "survives",
                    if stale || rolled {
                        JsValue::Null
                    } else {
                        JsValue::Bool(survives)
                    },
                ),
                ("stale", JsValue::Bool(stale || rolled)),
            ])
        })
        .collect();
    obj(vec![
        ("health", JsValue::Array(health)),
        ("quota", JsValue::Array(quota_json)),
        ("burn", JsValue::Array(burn)),
        ("lastUsed", JsValue::Object(last_used)),
    ])
}
/// Raw quota projection for CLI status, without health/burn/last-used reads.
/// Like listQuota in frozen TS, unrelated request logs cannot affect this read.
pub fn status_quota(s: &SqliteStore) -> Result<JsValue> {
    status_quota_with(s, false)
}
/// Operator JSON retains SQLite storage classes, including Uint8Array BLOBs.
/// Keep the existing human renderer's narrowing separate from this projection.
pub fn status_quota_json(s: &SqliteStore) -> Result<JsValue> {
    status_quota_with(s, true)
}
fn status_quota_with(s: &SqliteStore, lossless: bool) -> Result<JsValue> {
    let mut statement = s
        .connection()
        .prepare("SELECT * FROM quota_windows")
        .map_err(Failure::internal)?;
    let mut cursor = statement.query([]).map_err(Failure::internal)?;
    let mut quota = Vec::new();
    while let Some(row) = cursor.next().map_err(Failure::internal)? {
        let mut fields = Vec::new();
        for (name, column) in [
            ("credentialId", "credential_id"),
            ("windowType", "window_type"),
            ("startsAt", "starts_at"),
            ("used", "used"),
            ("limit", "limit_value"),
            ("resetsAt", "resets_at"),
            ("observedAt", "observed_at"),
            ("windowMs", "window_ms"),
        ] {
            let raw = row.get_ref(column).map_err(Failure::internal)?;
            fields.push((
                name,
                if lossless {
                    crate::cli_cell::Cell::read(raw).json()
                } else {
                    sql_value(raw)
                },
            ));
        }
        quota.push(obj(fields));
    }
    Ok(JsValue::Array(quota))
}
pub fn remove(s: &SqliteStore, id: Option<&str>) -> Result<()> {
    omni_store::credentials::remove(s.connection(), id)?;
    Ok(())
}
pub fn patch(s: &SqliteStore, id: Option<&str>, body: &JsValue, now: i64) -> Result<()> {
    patch_with(s, id, body, now, false)
}
/// CLI store errors retain JSON.parse's exception rather than HTTP's safe wrapper.
pub fn cli_patch(s: &SqliteStore, id: &str, body: &JsValue, now: i64) -> Result<()> {
    patch_with(s, Some(id), body, now, true)
}
fn patch_with(
    s: &SqliteStore,
    id: Option<&str>,
    body: &JsValue,
    now: i64,
    cli: bool,
) -> Result<()> {
    let mutation = parse_patch(body)?;
    let existing = if id.is_some() {
        if cli {
            cli_rows_for(s, id)
                .map_err(Failure::internal)?
                .into_iter()
                .next()
        } else {
            rows(s, id)?.into_iter().next()
        }
    } else {
        None
    };
    let existing = existing.ok_or_else(|| Failure::bad("no such credential"))?;
    if mutation.is_empty() {
        return Ok(());
    }
    s.connection().execute("UPDATE credentials SET label=COALESCE(?1,label),enabled=COALESCE(?2,enabled),tier=COALESCE(?3,tier),weight=COALESCE(?4,weight),disabled_reason=CASE WHEN ?2 IS NULL THEN disabled_reason WHEN ?2=1 THEN NULL ELSE 'manual' END,disabled_at=CASE WHEN ?2 IS NULL THEN disabled_at WHEN ?2=1 THEN NULL ELSE ?5 END,updated_at=?5 WHERE id=?6", rusqlite::params![mutation.label, mutation.enabled, mutation.tier.map(crate::cli_cell::bind_number), mutation.weight.map(crate::cli_cell::bind_number), now, id]).map_err(Failure::internal)?;
    log_enabled(id, &existing, mutation.enabled);
    Ok(())
}

pub async fn patch_postgres(
    pg: &omni_store::pg::PgStore,
    id: Option<&str>,
    body: &JsValue,
    now: i64,
) -> Result<()> {
    let mutation = parse_patch(body)?;
    let id = id.ok_or_else(|| Failure::bad("no such credential"))?;
    let existing = pg_rows(pg, Some(id))
        .await?
        .pop()
        .ok_or_else(|| Failure::bad("no such credential"))?;
    pg.patch_credential(Some(id), &mutation, now).await?;
    log_enabled(Some(id), &existing, mutation.enabled);
    Ok(())
}

fn parse_patch(body: &JsValue) -> Result<omni_store::credentials::CredentialPatch> {
    let opt = |z| Z::Opt(Box::new(z));
    let schema = Z::Obj {
        shape: vec![
            (
                "label",
                opt(Z::Str {
                    trim: false,
                    min: Some(1),
                    max: None,
                }),
            ),
            ("enabled", opt(Z::Bool)),
            (
                "tier",
                opt(Z::Num {
                    int: true,
                    positive: true,
                    max: None,
                }),
            ),
            (
                "weight",
                opt(Z::Num {
                    int: false,
                    positive: true,
                    max: None,
                }),
            ),
        ],
        strict: true,
        refine: None,
    };
    let patch = parse_or_throw(&schema, body).map_err(|e| {
        Failure::bad(e.trim_start_matches("BAD_REQUEST: ").replace(
            "tier: Too small: expected number to be >0",
            "tier: Too small: expected number to be >=1",
        ))
    })?;
    let JsValue::Object(fields) = &patch else {
        unreachable!()
    };
    let mut mutation = omni_store::credentials::CredentialPatch::default();
    for (k, v) in fields {
        let k = String::from_utf16_lossy(k);
        match (k.as_str(), v) {
            ("label", JsValue::String(u)) => mutation.label = Some(String::from_utf16_lossy(u)),
            ("tier", JsValue::Number(n)) => mutation.tier = Some(*n),
            ("weight", JsValue::Number(n)) => mutation.weight = Some(*n),
            ("enabled", JsValue::Bool(b)) => mutation.enabled = Some(*b),
            _ => unreachable!(),
        }
    }
    Ok(mutation)
}

fn log_enabled(id: Option<&str>, existing: &JsValue, enabled: Option<bool>) {
    if let Some(enabled) = enabled
        && get(existing, "enabled") != Some(&JsValue::Bool(enabled))
    {
        let provider = match get(existing, "provider") {
            Some(JsValue::String(u)) => String::from_utf16_lossy(u),
            _ => String::new(),
        };
        tracing::info!(
            credentialId = id,
            provider,
            "{}",
            if enabled {
                "credential enabled"
            } else {
                "credential disabled"
            }
        );
    }
}
fn required(body: &JsValue, name: &str) -> Result<Vec<u16>> {
    if let Some(JsValue::String(u)) = get(body, name) {
        let u = trim_units(u);
        if !u.is_empty() {
            return Ok(u.to_vec());
        }
    }
    Err(Failure::bad(format!("{name}: must not be empty")))
}
pub fn create(
    s: &SqliteStore,
    key: &omni_crypto::field::FieldKey,
    body: &JsValue,
    now: i64,
) -> Result<String> {
    create_with(s, key, body, now, false)
}
pub fn cli_create(
    s: &SqliteStore,
    key: &omni_crypto::field::FieldKey,
    body: &JsValue,
    now: i64,
) -> Result<String> {
    create_with(s, key, body, now, true)
}
fn create_with(
    s: &SqliteStore,
    key: &omni_crypto::field::FieldKey,
    body: &JsValue,
    now: i64,
    cli: bool,
) -> Result<String> {
    let input = parse_create(body)?;
    if input.provider == "custom" {
        let existing = if cli {
            cli_rows(s).map_err(Failure::internal)?
        } else {
            rows(s, None)?
        };
        check_endpoint(&input.data, existing, cli)?;
    }
    let id = omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate());
    omni_store::credentials::create_api_key(s.connection(), key, &input.columns(&id, now))?;
    let row = rows(s, Some(&id))?.remove(0);
    Ok(created(&id, input, row))
}

struct CredentialInput {
    provider: String,
    label: Vec<u16>,
    label_text: String,
    secret: String,
    data: JsValue,
    data_text: String,
}

impl CredentialInput {
    fn columns<'a>(
        &'a self,
        id: &'a str,
        now: i64,
    ) -> omni_store::credentials::ApiKeyCredential<'a> {
        omni_store::credentials::ApiKeyCredential {
            id,
            provider: &self.provider,
            label: &self.label_text,
            provider_data: &self.data_text,
            api_key: &self.secret,
            now,
        }
    }
}

fn parse_create(body: &JsValue) -> Result<CredentialInput> {
    if !matches!(body, JsValue::Object(_) | JsValue::Array(_)) {
        return Err(Failure::bad("credential body is required"));
    }
    let provider = get(body, "provider");
    let Some(JsValue::String(p)) = provider else {
        return Err(Failure::bad(format!(
            "(root): Invalid input: expected string, received {}",
            crate::body_schema::received(provider)
        )));
    };
    let provider = String::from_utf16_lossy(p);
    if provider.len() > 32
        || !provider
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase())
        || !provider
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(Failure::bad("(root): must be a lowercase provider id"));
    }
    if crate::catalog::descriptor(&provider).is_none() {
        return Err(Failure::bad(format!(
            "provider: no provider named \"{provider}\""
        )));
    }
    let secret = required(body, "apiKey")?;
    let label = match get(body, "label") {
        Some(JsValue::String(u)) => trim_units(u).to_vec(),
        None => Vec::new(),
        _ => return Err(Failure::bad("label: must be a string")),
    };
    let label = if label.is_empty() {
        format!("{provider} api key").encode_utf16().collect()
    } else {
        label
    };
    let mut data = obj(vec![]);
    if provider == "custom" {
        let endpoint = required(body, "endpointId")?;
        let endpoint_label = required(body, "endpointLabel")?;
        let origin = required(body, "origin")?;
        let protocol = get(body, "protocol").cloned().unwrap_or(JsValue::Undefined);
        if protocol != text("chat_completions") && protocol != text("responses") {
            return Err(Failure::bad("protocol: unsupported protocol"));
        }
        let url = url::Url::parse(&String::from_utf16_lossy(&origin))
            .map_err(|_| Failure::bad("origin: must be a valid URL"))?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some_and(|p| !p.is_empty())
            || url.query().is_some_and(|q| !q.is_empty())
            || url.fragment().is_some_and(|f| !f.is_empty())
        {
            return Err(Failure::bad("origin: must be an HTTP(S) server origin"));
        }
        data = obj(vec![
            ("endpointId", JsValue::String(endpoint)),
            ("endpointLabel", JsValue::String(endpoint_label)),
            ("origin", text(&url.origin().ascii_serialization())),
            ("basePath", text(url.path().trim_end_matches('/'))),
            ("protocol", protocol),
        ]);
    }
    Ok(CredentialInput {
        provider,
        label_text: String::from_utf16_lossy(&label),
        label,
        secret: String::from_utf16_lossy(&secret),
        data_text: stringify(&data),
        data,
    })
}

fn check_endpoint(data: &JsValue, rows: Vec<JsValue>, cli: bool) -> Result<()> {
    for row in rows {
        if get(&row, "provider") != Some(&text("custom")) {
            continue;
        }
        let undefined = JsValue::Undefined;
        let old = get(&row, "providerData").unwrap_or(&undefined);
        if matches!(old, JsValue::Null) {
            return Err(Failure::internal(if cli {
                "null is not an object (evaluating 'credential.providerData.endpointId')"
            } else {
                "null provider data"
            }));
        }
        if get(old, "endpointId") == get(data, "endpointId")
            && ["endpointLabel", "origin", "basePath", "protocol"]
                .iter()
                .any(|k| {
                    let v = get(old, k);
                    if *k == "basePath" && !matches!(v, Some(JsValue::String(_))) {
                        get(data, k) != Some(&text(""))
                    } else {
                        v != get(data, k)
                    }
                })
        {
            return Err(Failure {
                code: Some("CONFLICT"),
                message: "endpointId: metadata conflicts with existing endpoint".into(),
            });
        }
    }
    Ok(())
}

fn created(id: &str, input: CredentialInput, mut row: JsValue) -> String {
    if let JsValue::Object(fields) = &mut row {
        for (k, v) in fields {
            if k.iter().copied().eq("label".encode_utf16()) {
                *v = JsValue::String(input.label.clone());
            } else if k.iter().copied().eq("tokenVersion".encode_utf16()) {
                *v = JsValue::Number(0.0);
            }
        }
    }
    tracing::info!(
        credentialId = id,
        provider = input.provider,
        "credential added"
    );
    stringify(&obj(vec![("credential", row)]))
}

pub(crate) async fn pg_rows(
    pg: &omni_store::pg::PgStore,
    id: Option<&str>,
) -> Result<Vec<JsValue>> {
    pg.credential_metadata(id)
        .await?
        .iter()
        .map(|raw| {
            omni_ir::jsjson::parse_js(raw)
                .map_err(|_| Failure::internal("invalid credential metadata"))
        })
        .collect()
}

pub async fn list_postgres(pg: &omni_store::pg::PgStore) -> Result<String> {
    Ok(stringify(&obj(vec![(
        "credentials",
        JsValue::Array(pg_rows(pg, None).await?),
    )])))
}

pub async fn create_postgres(
    pg: &omni_store::pg::PgStore,
    key: &omni_crypto::field::FieldKey,
    body: &JsValue,
    now: i64,
) -> Result<(String, String)> {
    let input = parse_create(body)?;
    if input.provider == "custom" {
        check_endpoint(&input.data, pg_rows(pg, None).await?, false)?;
    }
    let id = omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate());
    pg.create_api_key_credential(key, &input.columns(&id, now))
        .await?;
    let row = pg_rows(pg, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| Failure::internal("credential write not found"))?;
    Ok((id.clone(), created(&id, input, row)))
}
