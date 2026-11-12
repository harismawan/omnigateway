//! The control operations behind `routes/admin.ts`'s keys, models, catalog
//! and settings handlers, for request bodies of any shape.
//!
//! The CLI builds its inputs from flags, so it never handed these operations
//! arbitrary JSON; the HTTP surface does. Everything here is therefore
//! [`JsValue`] end to end: a body's lone surrogates, out-of-range numbers,
//! duplicate keys and nesting depth survive validation, storage and the
//! response exactly as `JSON.parse` → zod → `JSON.stringify` treats them.
//! Validation is the oracle-tested port in [`crate::body_schema`],
//! [`crate::model_schema`] and [`crate::settings`]; storage goes through the
//! same `omni_store` primitives the CLI uses.
//!
//! Errors are `(code, message)`: `code` is the `GatewayError` code TS throws
//! (`BAD_REQUEST`, `MODEL_UNAVAILABLE`, ...), or `None` for anything else (a
//! `TypeError`, a store failure), which the route reports as `500 INTERNAL
//! "internal error"`, as `apiErrorResponse` does.
use crate::settings_value::get;
use omni_ir::jsjson::{JsValue, stringify};
use omni_store::SqliteStore;

/// A failed operation: a `GatewayError` code and message, or `None` for
/// anything TS would not have thrown as a `GatewayError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: Option<&'static str>,
    pub message: String,
}

impl Failure {
    fn bad(message: impl Into<String>) -> Self {
        Failure {
            code: Some("BAD_REQUEST"),
            message: message.into(),
        }
    }
    fn internal(message: impl std::fmt::Display) -> Self {
        Failure {
            code: None,
            message: message.to_string(),
        }
    }
    /// The control layer's `"CODE: message"` strings (CLI convention).
    fn from_control(e: String) -> Self {
        for code in ["BAD_REQUEST", "MODEL_UNAVAILABLE"] {
            if let Some(m) = e.strip_prefix(code).and_then(|m| m.strip_prefix(": ")) {
                return Failure {
                    code: Some(code),
                    message: m.to_owned(),
                };
            }
        }
        Failure::internal(e)
    }
}

impl From<omni_store::StoreError> for Failure {
    fn from(e: omni_store::StoreError) -> Self {
        Failure::internal(e)
    }
}

type Result<T> = std::result::Result<T, Failure>;

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn text(s: &str) -> JsValue {
    JsValue::String(units(s))
}
fn field(k: &str, v: JsValue) -> (Vec<u16>, JsValue) {
    (units(k), v)
}
fn object(fields: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::Object(fields.into_iter().map(|(k, v)| field(k, v)).collect())
}

/// A JS string as UTF-8 for SQLite: what `bun:sqlite` binds (lone
/// surrogates become U+FFFD).
fn utf8(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn string_of(v: &JsValue) -> Option<&[u16]> {
    match v {
        JsValue::String(s) => Some(s),
        _ => None,
    }
}

// ------------------------------------------------------------ keys

/// `toSummary(store, key, now)` for one stored row, with the fields an edit
/// replaced (`{ ...key, field: value }`) already applied to `row`.
struct KeyRow {
    id: String,
    label: String,
    prefix: String,
    /// `JSON.parse(model_allowlist)` or null.
    allowlist: JsValue,
    /// `parseLimits(...)`: the parsed matrix, or null when unreadable.
    limits: JsValue,
    body_logging_opt_out: bool,
    created_at: serde_json::Value,
    revoked_at: Option<i64>,
    expires_at: serde_json::Value,
    guardrail_policy: Option<String>,
    smart_routing: bool,
}

/// `JSON.parse` of a stored column, which throws (a `SyntaxError`, reported
/// as INTERNAL) on anything `JSON.parse` refuses.
fn parse_stored(raw: &str) -> Result<JsValue> {
    crate::operator_json::parse(raw).map_err(Failure::internal)
}

/// `parseLimits`: the stored matrix through `parseLimitConfig` (strict,
/// `__proto__` refused at any depth), or null when it does not parse.
fn stored_limits(raw: &str) -> JsValue {
    let Ok(value) = crate::operator_json::parse(raw) else {
        return JsValue::Null;
    };
    if names_proto(&value) {
        return JsValue::Null;
    }
    crate::body_schema::parse_or_throw(&crate::body_schema::limit_config(), &value)
        .unwrap_or(JsValue::Null)
}

/// `assertNoProto`: `__proto__` as an own key anywhere.
fn names_proto(v: &JsValue) -> bool {
    let mut stack = vec![v];
    while let Some(v) = stack.pop() {
        match v {
            JsValue::Object(fields) => {
                for (k, v) in fields {
                    if k.iter().copied().eq("__proto__".encode_utf16()) {
                        return true;
                    }
                    stack.push(v);
                }
            }
            JsValue::Array(items) => stack.extend(items),
            _ => {}
        }
    }
    false
}

fn key_rows(store: &SqliteStore, id: Option<&str>) -> Result<Vec<KeyRow>> {
    omni_store::keys::operator_rows(store.connection(), id)?
        .into_iter()
        .map(|row| {
            Ok(KeyRow {
                allowlist: match &row.allowlist_json {
                    None => JsValue::Null,
                    Some(raw) => parse_stored(raw)?,
                },
                limits: {
                    let limits = stored_limits(&row.limits_json);
                    if matches!(limits, JsValue::Null) {
                        tracing::error!(apiKeyId = %row.key.id, "api key limits unreadable");
                    }
                    limits
                },
                id: row.key.id,
                label: row.key.label,
                prefix: row.key.prefix,
                body_logging_opt_out: row.key.body_logging_opt_out,
                created_at: row.created_at,
                revoked_at: row.key.revoked_at,
                expires_at: row.expires_at,
                guardrail_policy: row.key.guardrail_policy,
                smart_routing: row.key.smart_routing,
            })
        })
        .collect()
}

const WINDOWS: [(&str, i64); 3] = [("1m", 60_000), ("5h", 18_000_000), ("1w", 604_800_000)];

/// `readScope`: one scope's readings, one `sumSince` per distinct window.
fn read_scope(
    store: &SqliteStore,
    id: &str,
    scope: &JsValue,
    model: Option<&[u16]>,
    now: i64,
    out: &mut Vec<JsValue>,
) -> Result<()> {
    fn set(v: Option<&JsValue>) -> Option<&JsValue> {
        v.filter(|v| !matches!(v, JsValue::Null))
    }
    let model_text = model.map(utf8);
    let mut sums: Vec<(&str, omni_ratelimit::buckets::Counts)> = Vec::new();
    // `configuredWindows`: insertion order of first need, dimension-major.
    for dimension in ["requests", "tokens", "spend"] {
        let Some(windows) = get(scope, dimension) else {
            continue;
        };
        for (window, ms) in WINDOWS {
            if set(get(windows, window)).is_some() && !sums.iter().any(|(w, _)| *w == window) {
                sums.push((
                    window,
                    omni_store::usage::sum_since(
                        store.connection(),
                        id,
                        now - ms,
                        model_text.as_deref(),
                    )?,
                ));
            }
        }
    }
    let model_value = model.map_or(JsValue::Null, |m| JsValue::String(m.to_vec()));
    for dimension in ["requests", "tokens", "spend"] {
        let Some(windows) = get(scope, dimension) else {
            continue;
        };
        for (window, _) in WINDOWS {
            let Some(limit) = set(get(windows, window)) else {
                continue;
            };
            let sum = &sums.iter().find(|(w, _)| *w == window).expect("summed").1;
            let used = match dimension {
                "requests" => sum.requests,
                "tokens" => sum.tokens,
                _ => sum.cost_usd,
            };
            out.push(object(vec![
                ("dimension", text(dimension)),
                ("window", text(window)),
                ("limit", limit.clone()),
                ("used", JsValue::Number(used)),
                ("model", model_value.clone()),
            ]));
        }
    }
    if let Some(limit) = set(get(scope, "concurrency")) {
        out.push(object(vec![
            ("dimension", text("concurrency")),
            ("window", JsValue::Null),
            ("limit", limit.clone()),
            ("used", JsValue::Null),
            ("model", model_value),
        ]));
    }
    Ok(())
}

/// `toSummary`.
fn summary(store: &SqliteStore, k: KeyRow, now: i64) -> Result<JsValue> {
    let mut usage = Vec::new();
    if !matches!(k.limits, JsValue::Null) {
        read_scope(store, &k.id, &k.limits, None, now, &mut usage)?;
        if let Some(JsValue::Object(models)) = get(&k.limits, "models") {
            for i in js_order(models) {
                let (name, scope) = &models[i];
                read_scope(store, &k.id, scope, Some(name), now, &mut usage)?;
            }
        }
    }
    let opt_text = |v: Option<String>| v.map_or(JsValue::Null, |s| text(&s));
    Ok(object(vec![
        ("id", text(&k.id)),
        ("label", text(&k.label)),
        ("prefix", text(&k.prefix)),
        ("modelAllowlist", k.allowlist),
        ("limits", k.limits),
        ("limitUsage", JsValue::Array(usage)),
        ("bodyLoggingOptOut", JsValue::Bool(k.body_logging_opt_out)),
        ("createdAt", JsValue::from(&k.created_at)),
        (
            "revokedAt",
            k.revoked_at
                .map_or(JsValue::Null, |v| JsValue::from(&serde_json::json!(v))),
        ),
        ("expiresAt", JsValue::from(&k.expires_at)),
        ("guardrailPolicy", opt_text(k.guardrail_policy)),
        ("smartRouting", JsValue::Bool(k.smart_routing)),
    ]))
}

/// JS own-key order: canonical array indices ascending, then insertion.
fn js_order(fields: &[(Vec<u16>, JsValue)]) -> Vec<usize> {
    let mut indexed: Vec<(u32, usize)> = Vec::new();
    let mut named = Vec::new();
    for (i, (k, _)) in fields.iter().enumerate() {
        let index = k
            .iter()
            .all(|u| (48..=57).contains(u))
            .then(|| omni_ir::jsjson::array_index(&utf8(k)))
            .flatten();
        match index {
            Some(n) => indexed.push((n, i)),
            None => named.push(i),
        }
    }
    indexed.sort_unstable();
    indexed.into_iter().map(|(_, i)| i).chain(named).collect()
}

/// `GET /api/keys`: `{ keys: await listKeys(store) }`, newest first.
pub fn list_keys(store: &SqliteStore, now: i64) -> Result<String> {
    let keys = key_rows(store, None)?
        .into_iter()
        .map(|k| summary(store, k, now))
        .collect::<Result<Vec<_>>>()?;
    Ok(stringify(&object(vec![("keys", JsValue::Array(keys))])).expect("keys"))
}

/// `POST /api/keys`: `createKey(store, body)`; the only response that
/// carries the raw key.
pub fn create_key(store: &SqliteStore, body: &JsValue, now: i64) -> Result<String> {
    let parsed = crate::body_schema::parse_or_throw(&crate::body_schema::key_create(), body)
        .map_err(Failure::bad)?;
    let f = |k: &str| get(&parsed, k).expect("defaulted");
    let label = string_of(f("label")).expect("string").to_vec();
    let raw = omni_crypto::apikey::generate();
    // Independent CSPRNG material for the public UUID; never derived from the key.
    let id = omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate());
    let prefix = omni_crypto::apikey::prefix(&raw);
    let allowlist = match f("modelAllowlist") {
        JsValue::Null => None,
        v => Some(stringify(v).expect("allowlist")),
    };
    let limits = stringify(f("limits")).expect("limits");
    let label_text = utf8(&label);
    let policy = string_of(f("guardrailPolicy")).map(utf8);
    #[allow(clippy::cast_possible_truncation)]
    let expires = match f("expiresAt") {
        JsValue::Number(n) => Some(*n as i64),
        _ => None,
    };
    omni_store::keys::create_columns(
        store.connection(),
        &omni_store::keys::NewKeyColumns {
            id: &id,
            label: &label_text,
            prefix: &prefix,
            hash: &omni_crypto::apikey::hash(&raw),
            model_allowlist: allowlist.as_deref(),
            limits: &limits,
            body_logging_opt_out: f("bodyLoggingOptOut") == &JsValue::Bool(true),
            created_at: now,
            expires_at: expires,
            guardrail_policy: policy.as_deref(),
            smart_routing: f("smartRouting") == &JsValue::Bool(true),
        },
    )?;
    // `{ id, label: created.label, prefix, key }`: `created` is the input
    // spread, so the label is the parsed string, lone surrogates and all.
    Ok(stringify(&object(vec![
        ("id", text(&id)),
        ("label", JsValue::String(label)),
        ("prefix", text(&prefix)),
        ("key", text(&raw)),
    ]))
    .expect("created"))
}

/// Which field a `PUT /api/keys/:id/<edit>` replaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEdit {
    Limits,
    Models,
    Expiry,
    Guardrail,
    SmartRouting,
}

/// `setKeyLimits` / `setKeyModels` / `setKeyExpiry` / `setKeyGuardrail` /
/// `setKeySmartRouting`: validate, refuse an unknown id before writing,
/// write, and answer `toSummary({ ...key, <field>: parsed })`.
pub fn edit_key(
    store: &SqliteStore,
    id: Option<&str>,
    edit: KeyEdit,
    body: &JsValue,
    now: i64,
) -> Result<String> {
    use crate::body_schema as s;
    let (schema, name) = match edit {
        KeyEdit::Limits => (s::key_limits(), "limits"),
        KeyEdit::Models => (s::key_models(), "modelAllowlist"),
        KeyEdit::Expiry => (s::key_expiry(), "expiresAt"),
        KeyEdit::Guardrail => (s::key_guardrail(), "policy"),
        KeyEdit::SmartRouting => (s::key_smart_routing(), "enabled"),
    };
    let parsed = s::parse_or_throw(&schema, body).map_err(Failure::bad)?;
    let value = get(&parsed, name).expect("required").clone();
    // `store.keys.get(id)`: `toKey` on the row, which throws where
    // `JSON.parse(model_allowlist)` does.
    let Some(id) = id else {
        return Err(Failure::bad("no such api key"));
    };
    let mut rows = key_rows(store, Some(id))?;
    let Some(mut row) = rows.pop() else {
        return Err(Failure::bad("no such api key"));
    };
    let conn = store.connection();
    use omni_store::keys::{KeyEdit as E, edit as write};
    match edit {
        KeyEdit::Limits => {
            omni_store::keys::set_limits_encoded(conn, id, &stringify(&value).expect("limits"))?;
            row.limits = value;
        }
        KeyEdit::Models => {
            let encoded = match &value {
                JsValue::Null => None,
                v => Some(stringify(v).expect("allowlist")),
            };
            write(conn, id, E::Models(encoded.as_deref()))?;
            row.allowlist = value;
        }
        KeyEdit::Expiry => {
            #[allow(clippy::cast_possible_truncation)]
            let at = match &value {
                JsValue::Number(n) => Some(*n as i64),
                _ => None,
            };
            write(conn, id, E::Expiry(at))?;
            row.expires_at = at.map_or(serde_json::Value::Null, serde_json::Value::from);
        }
        KeyEdit::Guardrail => {
            let policy = string_of(&value).map(utf8);
            write(conn, id, E::Guardrail(policy.as_deref()))?;
            return summary_with(store, row, now, "guardrailPolicy", value);
        }
        KeyEdit::SmartRouting => {
            let on = value == JsValue::Bool(true);
            write(conn, id, E::SmartRouting(on))?;
            row.smart_routing = on;
        }
    }
    Ok(stringify(&summary(store, row, now)?).expect("summary"))
}

/// A summary whose one field is the parsed JS value rather than the row's
/// (a guardrail policy keeps its lone surrogates in the response).
fn summary_with(
    store: &SqliteStore,
    row: KeyRow,
    now: i64,
    name: &str,
    value: JsValue,
) -> Result<String> {
    let mut out = summary(store, row, now)?;
    crate::settings_value::set(&mut out, name, value);
    Ok(stringify(&out).expect("summary"))
}

/// `DELETE /api/keys/:id`: `revokeKey` (an unknown id, or one that does not
/// decode, is no error).
pub fn revoke_key(store: &SqliteStore, id: Option<&str>, now: i64) -> Result<()> {
    let Some(id) = id else { return Ok(()) };
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Revoke(now),
    )?;
    Ok(())
}

// ------------------------------------------------------------ models

/// `GET /api/models`: `{ models: listModels(store) }`, stored values as
/// `JSON.parse` reads them (a row that does not parse fails the listing).
pub fn list_models(store: &SqliteStore) -> Result<String> {
    let models = crate::models::list(store).map_err(Failure::internal)?;
    Ok(stringify(&object(vec![("models", JsValue::Array(models))])).expect("models"))
}

/// `PUT /api/models/:id`: `putModel(store, id, body)`. `id` is `None` where
/// the path parameter does not decode (Elysia hands the handler `null`),
/// which no body's id can match.
pub fn put_model(store: &SqliteStore, id: Option<&str>, body: &JsValue) -> Result<()> {
    let Some(id) = id else {
        crate::model_schema::parse(body).map_err(Failure::from_control)?;
        return Err(Failure::bad("model id in the path and body must match"));
    };
    crate::models::put(store, id, body).map_err(Failure::from_control)
}

/// `DELETE /api/models/:id`: `removeModel` (an unknown id, or one that does
/// not decode, deletes nothing and is no error).
pub fn remove_model(store: &SqliteStore, id: Option<&str>) -> Result<()> {
    match id {
        Some(id) => crate::models::remove(store, id).map_err(Failure::internal),
        None => Ok(()),
    }
}

// ------------------------------------------------------------ settings

/// `getSettings(store)`.
pub fn settings(store: &SqliteStore) -> Result<JsValue> {
    crate::settings::get(store).map_err(Failure::internal)
}

/// `PUT /api/settings`: `putSettings(store, body)`.
pub fn put_settings(store: &SqliteStore, body: &JsValue) -> Result<()> {
    crate::settings::put(store, body)
        .map(|_| ())
        .map_err(Failure::from_control)
}

/// `GET /api/settings`' body: the settings, the two boot facts, whether a
/// viewer password exists, and each smart-router model's state.
pub fn settings_body(
    settings: JsValue,
    body_logging_allowed: bool,
    day_offset_minutes: i64,
    viewer_configured: bool,
    smart_router_models: (&str, &str),
) -> String {
    #[allow(clippy::cast_precision_loss)]
    let offset = JsValue::Number(day_offset_minutes as f64);
    stringify(&object(vec![
        ("settings", settings),
        ("bodyLoggingAllowed", JsValue::Bool(body_logging_allowed)),
        ("dayOffsetMinutes", offset),
        ("viewerConfigured", JsValue::Bool(viewer_configured)),
        (
            "smartRouterModels",
            object(vec![
                ("classifier", text(smart_router_models.0)),
                ("local", text(smart_router_models.1)),
            ]),
        ),
    ]))
    .expect("settings")
}

// ------------------------------------------------------------ catalog

/// `isPaletteSafeColour`'s `safeColour`: the trimmed value, or `None`.
fn safe_colour(v: Option<&JsValue>) -> Option<Vec<u16>> {
    let JsValue::String(s) = v? else { return None };
    let t = crate::body_schema::trim_units(s);
    if t.is_empty()
        || t.len() > 128
        || !t.iter().all(|u| {
            u8::try_from(*u).is_ok_and(|b| b.is_ascii_alphanumeric() || b" ().,%#/+-".contains(&b))
        })
    {
        return None;
    }
    let mut depth = 0i32;
    for u in t {
        match u {
            40 => depth += 1,
            41 => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return None;
        }
    }
    if depth != 0 {
        return None;
    }
    // FETCHING_FUNCTION: /\b(?:url|attr|image-set|element|expression)\s*\(/i
    let lower: String = utf8(t).to_ascii_lowercase();
    let b = lower.as_bytes();
    for name in ["url", "attr", "image-set", "element", "expression"] {
        for (at, _) in lower.match_indices(name) {
            let boundary = at == 0 || !(b[at - 1].is_ascii_alphanumeric() || b[at - 1] == b'_');
            let mut j = at + name.len();
            while j < b.len() && b[j] == b' ' {
                j += 1;
            }
            if boundary && b.get(j) == Some(&b'(') {
                return None;
            }
        }
    }
    Some(t.to_vec())
}

/// One public catalog row: id, name, and the limits it states.
type PublicRow = (Vec<u16>, Vec<u16>, Limits);
/// `contextWindow` / `maxOutputTokens`, where present.
type Limits = Vec<(&'static str, f64)>;
/// One account's row for a model id: its name and limits.
type Named = (Vec<u16>, Limits);

/// `parsePublicModelCatalog(account.providerData.modelCatalog)`'s rows.
fn public_rows(catalog: Option<&JsValue>) -> Vec<PublicRow> {
    let Some(JsValue::Object(_)) = catalog else {
        return Vec::new();
    };
    let catalog = catalog.expect("object");
    if get(catalog, "version") != Some(&JsValue::Number(1.0)) {
        return Vec::new();
    }
    let Some(JsValue::Array(models)) = get(catalog, "models") else {
        return Vec::new();
    };
    let valid = |v: Option<&JsValue>| match v {
        Some(JsValue::String(s))
            if !s.is_empty() && s.len() <= 200 && s.iter().all(|u| *u >= 0x20 && *u != 0x7f) =>
        {
            Some(s.clone())
        }
        _ => None,
    };
    let mut out: Vec<PublicRow> = Vec::new();
    for raw in models.iter().take(500) {
        if !matches!(raw, JsValue::Object(_) | JsValue::Array(_)) {
            continue;
        }
        let (Some(id), Some(name)) = (valid(get(raw, "id")), valid(get(raw, "name"))) else {
            continue;
        };
        if out.iter().any(|(seen, _, _)| *seen == id) {
            continue;
        }
        let mut limits = Vec::new();
        let source =
            get(raw, "limits").filter(|l| matches!(l, JsValue::Object(_) | JsValue::Array(_)));
        for key in ["contextWindow", "maxOutputTokens"] {
            if let Some(JsValue::Number(n)) = source.and_then(|s| get(s, key))
                && n.fract() == 0.0
                && n.abs() <= 9_007_199_254_740_991.0
                && *n > 0.0
            {
                limits.push((key, *n));
            }
        }
        out.push((id, name, limits));
    }
    out
}

/// `String.prototype.localeCompare` under Bun's default (root/`en`) ICU
/// collation.
fn locale_compare(a: &[u16], b: &[u16]) -> std::cmp::Ordering {
    static COLLATOR: std::sync::OnceLock<icu_collator::CollatorBorrowed<'static>> =
        std::sync::OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            icu_collator::Collator::try_new(
                icu_collator::CollatorPreferences::default(),
                icu_collator::options::CollatorOptions::default(),
            )
            .expect("compiled collation data")
        })
        .compare_utf16(a, b)
}

/// One stored account, for `accountModels`: provider, and `providerData`
/// as `JSON.parse` reads it.
pub type Account = (String, JsValue);

/// The accounts `providerCatalog` reads (`store.credentials.list()`):
/// provider and parsed `provider_data`, every row (a row that does not
/// parse fails the route, as `JSON.parse` throws in TS).
pub fn accounts(store: &SqliteStore) -> Result<Vec<Account>> {
    omni_store::models::operator_credentials(store.connection())?
        .into_iter()
        .map(|(_, provider, _, _, data)| Ok((provider, parse_stored(&data)?)))
        .collect()
}

/// A colour this endpoint had to replace, as `CatalogProblem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogProblem {
    pub provider: String,
    pub field: &'static str,
}

/// `GET /api/catalog`: `{ providers: providerCatalog(report, builtins,
/// accounts) }`, `quotaResets: true` on the providers whose OAuth flow can
/// list and redeem banked resets.
pub fn catalog(accounts: &[Account], report: &mut dyn FnMut(CatalogProblem)) -> Result<String> {
    const NEUTRAL: &str = "oklch(0.62 0 0)";
    const QUOTA_RESETS: [&str; 2] = ["anthropic", "openai"];
    let mut providers = Vec::new();
    for (id, descriptor) in crate::catalog::descriptors() {
        let id_text = utf8(id);
        let presentation = get(descriptor, "presentation").expect("generated");
        let catalog = get(descriptor, "catalog").expect("generated");
        let colour = get(presentation, "colour");
        let mut half = |mode: &'static str| {
            safe_colour(colour.and_then(|c| get(c, mode))).map_or_else(
                || {
                    report(CatalogProblem {
                        provider: id_text.clone(),
                        field: if mode == "light" {
                            "colour.light"
                        } else {
                            "colour.dark"
                        },
                    });
                    text(NEUTRAL)
                },
                JsValue::String,
            )
        };
        let colours = object(vec![("light", half("light")), ("dark", half("dark"))]);
        let auth_types = get(catalog, "authTypes").expect("generated").clone();
        let JsValue::Array(statics) = get(catalog, "models").expect("generated") else {
            unreachable!("generated catalog models")
        };
        let mut models: Vec<JsValue> = statics
            .iter()
            .map(|m| {
                let mut fields = vec![
                    field("id", get(m, "id").expect("id").clone()),
                    field("label", get(m, "label").expect("label").clone()),
                    field(
                        "pricing",
                        get(m, "pricing").cloned().unwrap_or(JsValue::Null),
                    ),
                    field("limits", get(m, "limits").expect("limits").clone()),
                ];
                if let Some(o) = get(m, "oauthLimits") {
                    fields.push(field("oauthLimits", o.clone()));
                }
                fields.push(field("auth", get(m, "auth").unwrap_or(&auth_types).clone()));
                JsValue::Object(fields)
            })
            .collect();
        // `accountModels`: rows from this provider's accounts' public
        // catalogs that the static catalog lacks, grouped by id.
        let static_ids: Vec<&JsValue> = statics.iter().filter_map(|m| get(m, "id")).collect();
        let mut grouped: Vec<(Vec<u16>, Vec<Named>)> = Vec::new();
        for (provider, data) in accounts {
            if *provider != id_text {
                continue;
            }
            // `account.providerData.modelCatalog` on a stored `null`.
            if matches!(data, JsValue::Null) {
                return Err(Failure::internal(
                    "null is not an object (evaluating 'account.providerData.modelCatalog')",
                ));
            }
            for (row_id, name, limits) in public_rows(get(data, "modelCatalog")) {
                if static_ids.contains(&&JsValue::String(row_id.clone())) {
                    continue;
                }
                match grouped.iter_mut().find(|(k, _)| *k == row_id) {
                    Some((_, rows)) => rows.push((name, limits)),
                    None => grouped.push((row_id, vec![(name, limits)])),
                }
            }
        }
        grouped.sort_by(|(a, _), (b, _)| locale_compare(a, b));
        for (key, rows) in grouped {
            let mut limits = Vec::new();
            for f in ["contextWindow", "maxOutputTokens"] {
                let values: Option<Vec<f64>> = rows
                    .iter()
                    .map(|(_, l)| l.iter().find(|(k, _)| *k == f).map(|(_, v)| *v))
                    .collect();
                if let Some(values) = values {
                    limits.push(field(
                        f,
                        JsValue::Number(values.into_iter().fold(f64::INFINITY, f64::min)),
                    ));
                }
            }
            models.push(JsValue::Object(vec![
                field("id", JsValue::String(key)),
                field("label", JsValue::String(rows[0].0.clone())),
                field("pricing", JsValue::Null),
                field("limits", JsValue::Object(limits)),
                field("auth", auth_types.clone()),
            ]));
        }
        let mut fields = vec![
            field("id", JsValue::String(id.clone())),
            field("label", get(presentation, "label").expect("label").clone()),
            field("order", get(presentation, "order").expect("order").clone()),
            field("colour", colours),
        ];
        if let Some(hint) = get(presentation, "pasteHint") {
            fields.push(field("pasteHint", hint.clone()));
        }
        if let Some(callback) = get(descriptor, "callback") {
            fields.push(field("callback", callback.clone()));
        }
        fields.push(field(
            "defaultModel",
            get(catalog, "defaultModel").expect("default").clone(),
        ));
        fields.push(field("authTypes", auth_types));
        fields.push(field("models", JsValue::Array(models)));
        if QUOTA_RESETS.contains(&id_text.as_str()) {
            fields.push(field("quotaResets", JsValue::Bool(true)));
        }
        providers.push(JsValue::Object(fields));
    }
    Ok(stringify(&object(vec![("providers", JsValue::Array(providers))])).expect("catalog"))
}

// ------------------------------------------------------------ smart router

/// `smartRouterModelStatus(await buildSnapshot(store, now), PROVIDER_DESCRIPTORS)`.
///
/// `buildSnapshot` parses every credential's `provider_data` and every
/// model's `targets` (either throwing fails the route), and `localOnlyModel`
/// reads the resolved model's `targets` with no shape check, so a hand-edited
/// row can make it throw a `TypeError` too: both are reproduced here.
pub fn smart_router_models(
    store: &SqliteStore,
    settings: &JsValue,
) -> Result<(&'static str, &'static str)> {
    accounts(store)?;
    let models = crate::models::list(store).map_err(Failure::internal)?;
    let state = |key: &str| -> Result<&'static str> {
        let Some(JsValue::String(name)) = get(settings, key) else {
            return Ok("unset");
        };
        model_state(name, &models)
    };
    Ok((
        state("smartRouterClassifierModel")?,
        state("smartRouterLocalModel")?,
    ))
}

fn model_state(name: &[u16], models: &[JsValue]) -> Result<&'static str> {
    let configured = models
        .iter()
        .rev()
        .find(|m| get(m, "id") == Some(&JsValue::String(name.to_vec())));
    let Some(model) = configured else {
        // `resolveModel`'s shorthand and prefix inference: any success is
        // a synthesized, non-`custom` model (`custom/…` is refused).
        let sep = name.iter().position(|u| *u == 47 || *u == 58);
        let resolves = match sep {
            Some(sep) if sep > 0 => {
                let prefix = utf8(&name[..sep]);
                prefix != "custom"
                    && sep + 1 < name.len()
                    && crate::catalog::descriptor(&prefix).is_some()
            }
            _ => crate::catalog::descriptors().iter().any(|(_, d)| {
                matches!(get(d, "modelPrefixes"), Some(JsValue::Array(ps)) if ps.iter().any(
                    |p| matches!(p, JsValue::String(p) if name.starts_with(p))
                ))
            }),
        };
        return Ok(if resolves { "notLocal" } else { "unresolved" });
    };
    // `localOnlyModel`: `model.targets.length === 0` is not local; then
    // `targets.every((t) => t.provider === "custom")`, which throws on a
    // non-array or on reaching a null target.
    let type_error = || Failure::internal("TypeError in localOnlyModel");
    let targets = get(model, "targets");
    let empty = match targets {
        Some(JsValue::Array(a)) => a.is_empty(),
        Some(JsValue::String(s)) => s.is_empty(),
        Some(JsValue::Object(fields)) => fields.iter().any(|(k, v)| {
            k.iter().copied().eq("length".encode_utf16()) && *v == JsValue::Number(0.0)
        }),
        Some(JsValue::Null) | None => return Err(type_error()),
        _ => false,
    };
    if empty {
        return Ok("notLocal");
    }
    let Some(JsValue::Array(targets)) = targets else {
        return Err(type_error());
    };
    for t in targets {
        match t {
            JsValue::Null => return Err(type_error()),
            t if get(t, "provider") == Some(&text("custom")) => {}
            _ => return Ok("notLocal"),
        }
    }
    Ok("ok")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_follow_the_palette_rule() {
        let c = |s: &str| safe_colour(Some(&text(s))).map(|u| utf8(&u));
        assert_eq!(c(" oklch(0.5 0.1 2) ").as_deref(), Some("oklch(0.5 0.1 2)"));
        assert_eq!(c("#aabbcc").as_deref(), Some("#aabbcc"));
        assert_eq!(c("rgb(1 2 3 / 50%)").as_deref(), Some("rgb(1 2 3 / 50%)"));
        for bad in [
            "",
            "  ",
            "red; }",
            "oklch(0.5",
            "a)(b",
            "url(x)",
            "URL (x)",
            "x url(y)",
            "image-set(a)",
            "a\"b",
            "a*b",
            &"a".repeat(129),
        ] {
            assert_eq!(c(bad), None, "{bad}");
        }
        // `\burl\s*\(` needs a word boundary: `curl(` is not `url(`.
        assert_eq!(c("curl(x)").as_deref(), Some("curl(x)"));
    }

    #[test]
    fn locale_compare_is_icu_root() {
        let mut v: Vec<Vec<u16>> = [
            "b", "a", "B", "_x", "1", "A", "-a", "é", "z", "Z", "a b", "ab", "ä",
        ]
        .iter()
        .map(|s| units(s))
        .collect();
        v.sort_by(|a, b| locale_compare(a, b));
        let got: Vec<String> = v.iter().map(|u| utf8(u)).collect();
        // Bun 1.4.4: ['b','a','B',...].sort((a, b) => a.localeCompare(b))
        assert_eq!(got.join("|"), "_x|-a|1|a|A|ä|a b|ab|b|B|é|z|Z");
    }
}
