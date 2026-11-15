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
    if matches!(raw, ValueRef::Null) {
        return Ok(JsValue::Null);
    }
    let invalid = || {
        Failure::internal(format!(
            "invalid credential provider_data: id={}",
            stringify(&sql_value(id))
        ))
    };
    let bytes = raw.as_bytes().map_err(|_| invalid())?;
    crate::operator_json::parse(&String::from_utf8_lossy(bytes)).map_err(|_| invalid())
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
fn rows(s: &SqliteStore, id: Option<&str>) -> Result<Vec<JsValue>> {
    rows_with(s, id, provider_data)
}
fn rows_with(
    s: &SqliteStore,
    id: Option<&str>,
    parse: fn(ValueRef<'_>, ValueRef<'_>) -> Result<JsValue>,
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
                "enabled" => JsValue::Bool(
                    matches!(raw, ValueRef::Integer(1))
                        || matches!(raw,ValueRef::Real(n) if n==1.0),
                ),
                "hasRefreshToken" => JsValue::Bool(!matches!(raw, ValueRef::Null)),
                "providerData" => parse(raw, r.get_ref("id").map_err(Failure::internal)?)?,
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
    let rows = rows_with(s, None, |raw, _| {
        if matches!(raw, ValueRef::Null) {
            return Ok(JsValue::Null);
        }
        crate::operator_json::parse(&String::from_utf8_lossy(
            raw.as_bytes().map_err(Failure::internal)?,
        ))
        .map_err(Failure::internal)
    })
    .map_err(|e| e.message)?;
    Ok(stringify(&obj(vec![("credentials", JsValue::Array(rows))])))
}
pub fn health(s: &SqliteStore, now: i64) -> Result<String> {
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
                sql_value(row.get_ref(column).map_err(Failure::internal)?),
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
                sql_value(row.get_ref(column).map_err(Failure::internal)?),
            ));
        }
        let value = obj(fields);
        let number = |name| match get(&value, name) {
            Some(JsValue::Number(n)) => *n,
            Some(JsValue::Null) => 0.0,
            Some(JsValue::String(u)) => omni_ir::js::string_to_number(&String::from_utf16_lossy(u)),
            _ => f64::NAN,
        };
        let optional = |name| {
            if matches!(get(&value, name), Some(JsValue::Null)) {
                None
            } else {
                Some(number(name))
            }
        };
        quota.push(omni_store::QuotaWindow {
            text_spent: None,
            credential_id: row.get("credential_id").map_err(Failure::internal)?,
            window_type: omni_store::quota::WindowType::parse(
                &row.get::<_, String>("window_type")
                    .map_err(Failure::internal)?,
            ),
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
    let credentials = rows(s, None)?;
    let mut last_used = Vec::new();
    for c in credentials {
        if let Some(JsValue::String(id)) = get(&c, "id") {
            let at: Option<f64> = s
                .connection()
                .query_row(
                    "SELECT MAX(at) FROM request_logs WHERE credential_id=?",
                    [String::from_utf16_lossy(id)],
                    |r| r.get(0),
                )
                .map_err(Failure::internal)?;
            if let Some(at) = at {
                last_used.push((id.clone(), JsValue::Number(at)));
            }
        }
    }
    let burn = quota
        .iter()
        .zip(&quota_json)
        .map(|(q, raw)| {
            let stale = q.observed_at <= 0.0
                || now as f64 - q.observed_at > settings.quota_poll_interval_ms.max(60_000.0) * 3.0;
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
                    if elapsed <= 0.0 || q.used == 0.0 {
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
                (Some(_), Some(JsValue::String(units))) => {
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
                    let mut value = units.clone();
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
                    (JsValue::String(a), _) => {
                        omni_ir::js::string_to_number(&String::from_utf16_lossy(a))
                            >= q.resets_at.unwrap_or(f64::NAN)
                    }
                    _ => exhausts.unwrap_or(f64::NAN) >= q.resets_at.unwrap_or(f64::NAN),
                }
            };
            obj(vec![
                ("credentialId", text(&q.credential_id)),
                ("windowType", text(q.window_type.as_str())),
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
    Ok(stringify(&obj(vec![
        ("health", JsValue::Array(health)),
        ("quota", JsValue::Array(quota_json)),
        ("burn", JsValue::Array(burn)),
        ("lastUsed", JsValue::Object(last_used)),
    ])))
}
/// Raw quota projection for CLI status, without health/burn/last-used reads.
/// Like listQuota in frozen TS, unrelated request logs cannot affect this read.
pub fn status_quota(s: &SqliteStore) -> Result<JsValue> {
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
            fields.push((
                name,
                sql_value(row.get_ref(column).map_err(Failure::internal)?),
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
    let existing = if id.is_some() {
        rows(s, id)?.into_iter().next()
    } else {
        None
    };
    let existing = existing.ok_or_else(|| Failure::bad("no such credential"))?;
    let JsValue::Object(fields) = &patch else {
        unreachable!()
    };
    if fields.is_empty() {
        return Ok(());
    }
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
    omni_store::credentials::patch_metadata(s.connection(), id, &mutation, now)?;
    if let Some(enabled) = mutation.enabled
        && get(&existing, "enabled") != Some(&JsValue::Bool(enabled))
    {
        let provider = match get(&existing, "provider") {
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
    Ok(())
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
        for row in rows(s, None)? {
            if get(&row, "provider") != Some(&text("custom")) {
                continue;
            }
            let undefined = JsValue::Undefined;
            let old = get(&row, "providerData").unwrap_or(&undefined);
            if matches!(old, JsValue::Null) {
                return Err(Failure::internal("null provider data"));
            }
            if get(old, "endpointId") == get(&data, "endpointId")
                && ["endpointLabel", "origin", "basePath", "protocol"]
                    .iter()
                    .any(|k| {
                        let v = get(old, k);
                        if *k == "basePath" && !matches!(v, Some(JsValue::String(_))) {
                            get(&data, k) != Some(&text(""))
                        } else {
                            v != get(&data, k)
                        }
                    })
            {
                return Err(Failure {
                    code: Some("CONFLICT"),
                    message: "endpointId: metadata conflicts with existing endpoint".into(),
                });
            }
        }
    }
    let id = omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate());
    omni_store::credentials::create_api_key(
        s.connection(),
        key,
        &omni_store::credentials::ApiKeyCredential {
            id: &id,
            provider: &provider,
            label: &String::from_utf16_lossy(&label),
            provider_data: &stringify(&data),
            api_key: &String::from_utf16_lossy(&secret),
            now,
        },
    )?;
    let mut row = rows(s, Some(&id))?.remove(0);
    if let JsValue::Object(fields) = &mut row {
        for (k, v) in fields {
            if k.iter().copied().eq("label".encode_utf16()) {
                *v = JsValue::String(label.clone());
            }
        }
    }
    tracing::info!(credentialId = id, provider, "credential added");
    Ok(stringify(&obj(vec![("credential", row)])))
}
