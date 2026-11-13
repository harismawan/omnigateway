//! Operator key summaries.
use omni_store::SqliteStore;
use serde_json::{Value, json};

pub struct CreateKey {
    pub label: String,
    pub models: Option<Vec<String>>,
    pub limits: Value,
    pub no_bodies: bool,
    pub expiry: Option<i64>,
    pub policy: Option<String>,
    pub smart: bool,
}
pub fn create_key(store: &SqliteStore, input: CreateKey, now: i64) -> Result<Value, String> {
    if input.label.is_empty() {
        return Err("BAD_REQUEST: label: Too small: expected string to have >=1 characters".into());
    }
    if let Some(i) = input
        .models
        .as_ref()
        .and_then(|v| v.iter().position(String::is_empty))
    {
        return Err(format!(
            "BAD_REQUEST: modelAllowlist.{i}: Too small: expected string to have >=1 characters"
        ));
    }
    validate_limits(&input.limits, "limits", true)?;
    if input.expiry.is_some_and(|v| v <= 0) {
        return Err("BAD_REQUEST: expiresAt: Too small: expected number to be >0".into());
    }
    if input.expiry.is_some_and(|v| v > 8_640_000_000_000_000) {
        return Err(
            "BAD_REQUEST: expiresAt: Too big: expected number to be <=8640000000000000".into(),
        );
    }
    let policy = input.policy.as_deref().map(omni_ir::js::trim);
    if let Some(p) = policy {
        if p.is_empty() {
            return Err(
                "BAD_REQUEST: guardrailPolicy: Too small: expected string to have >=1 characters"
                    .into(),
            );
        }
        if p.chars().count() > 4000 {
            return Err(
                "BAD_REQUEST: guardrailPolicy: Too big: expected string to have <=4000 characters"
                    .into(),
            );
        }
    }
    let raw = omni_crypto::apikey::generate();
    // Independent CSPRNG material for the public UUID; never derived from the key.
    let id = omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate());
    let prefix = omni_crypto::apikey::prefix(&raw);
    let limits = omni_store::limits::parse_limits(&input.limits.to_string())
        .ok_or("BAD_REQUEST: invalid limits")?;
    let key = omni_store::keys::ApiKey {
        id: id.clone(),
        label: input.label.clone(),
        prefix: prefix.clone(),
        hash: omni_crypto::apikey::hash(&raw),
        model_allowlist: input.models,
        lone_allowlist: Vec::new(),
        limits: Some(limits),
        body_logging_opt_out: input.no_bodies,
        created_at: now,
        revoked_at: None,
        expires_at: input.expiry,
        guardrail_policy: policy.map(str::to_owned),
        smart_routing: input.smart,
    };
    omni_store::keys::create(store.connection(), &key).map_err(|e| e.to_string())?;
    Ok(json!({"id":id,"label":input.label,"prefix":prefix,"key":raw}))
}

/// Validate and persist the CLI's complete, already edited matrix.
pub fn set_limits(
    store: &SqliteStore,
    id: &str,
    limits: &omni_ir::jsjson::JsValue,
) -> Result<omni_ir::jsjson::JsValue, String> {
    use omni_ir::jsjson::JsValue;
    let body = JsValue::Object(vec![("limits".encode_utf16().collect(), limits.clone())]);
    let parsed = crate::body_schema::parse_or_throw(&crate::body_schema::key_limits(), &body)
        .map_err(|e| format!("BAD_REQUEST: {e}"))?;
    let limits = crate::settings_value::get(&parsed, "limits").expect("limits");
    require_key(store, id)?;
    let raw = omni_ir::jsjson::stringify(limits).expect("limits");
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Limits(&raw),
    )
    .map_err(|e| e.to_string())?;
    Ok(limits.clone())
}

pub fn validate_limits(v: &Value, path: &str, root: bool) -> Result<(), String> {
    let err = |p: &str, message: String| format!("BAD_REQUEST: {p}: {message}");
    let object = v.as_object().ok_or_else(|| {
        err(
            path,
            "Invalid input: expected object, received number".into(),
        )
    })?;
    for d in ["requests", "tokens", "spend", "concurrency"] {
        let Some(value) = object.get(d) else { continue };
        let p = format!("{path}.{d}");
        let check = |v: &Value, p: &str| -> Result<(), String> {
            if v.is_null() {
                return Ok(());
            }
            let n = v
                .as_f64()
                .ok_or_else(|| err(p, "Invalid input: expected number, received object".into()))?;
            if d != "spend" && n.fract() != 0.0 {
                return Err(err(
                    p,
                    "Invalid input: expected int, received number".into(),
                ));
            }
            if d != "spend" && n > 9007199254740991.0 {
                return Err(err(
                    p,
                    "Too big: expected int to be <=9007199254740991".into(),
                ));
            }
            if n <= 0.0 {
                return Err(err(p, "Too small: expected number to be >0".into()));
            }
            Ok(())
        };
        if d == "concurrency" {
            check(value, &p)?;
        } else {
            let windows = value
                .as_object()
                .ok_or_else(|| err(&p, "Invalid input: expected object, received number".into()))?;
            for w in ["1m", "5h", "1w"] {
                if d == "spend" && w == "1m" {
                    continue;
                }
                if let Some(n) = windows.get(w) {
                    check(n, &format!("{p}.{w}"))?;
                }
            }
            let unknown: Vec<_> = windows
                .keys()
                .filter(|w| !matches!(w.as_str(), "1m" | "5h" | "1w") || d == "spend" && *w == "1m")
                .collect();
            if !unknown.is_empty() {
                return Err(err(&p, unknown_keys(&unknown)));
            }
        }
    }
    if root
        && let Some(value) = object.get("models")
        && !value.is_object()
    {
        let kind = match value {
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::String(_) => "string",
            Value::Bool(_) => "boolean",
            _ => "number",
        };
        return Err(err(
            &format!("{path}.models"),
            format!("Invalid input: expected record, received {kind}"),
        ));
    }
    if !root
        && !object.values().any(|v| {
            v.is_number()
                || v.as_object()
                    .is_some_and(|o| o.values().any(Value::is_number))
        })
    {
        return Err(err(
            path,
            "a model override must set at least one limit; omit the model to remove it".into(),
        ));
    }
    if root && let Some(models) = object.get("models").and_then(Value::as_object) {
        for (model, scope) in omni_ir::jsjson::own_entries(models) {
            if model.is_empty() || model.chars().count() > 256 {
                return Err(err(
                    &format!("{path}.models.{}", safe_token(model)),
                    "Invalid key in record".into(),
                ));
            }
            validate_limits(
                scope,
                &format!("{path}.models.{}", safe_token(model)),
                false,
            )?;
        }
        if models.len() > 64 {
            return Err(err(
                &format!("{path}.models"),
                "at most 64 model overrides per key".into(),
            ));
        }
    }
    let unknown: Vec<_> = object
        .keys()
        .filter(|k| {
            !matches!(k.as_str(), "requests" | "tokens" | "spend" | "concurrency")
                && !(root && *k == "models")
        })
        .collect();
    if !unknown.is_empty() {
        return Err(err(path, unknown_keys(&unknown)));
    }
    Ok(())
}
fn unknown_keys(keys: &[&String]) -> String {
    format!("unrecognized key \"{}\"", safe_token(keys[0]))
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod mutation_tests {
    use super::*;
    #[test]
    fn malformed_model_shapes_match_frozen_schema() {
        for (value, detail) in [
            (json!(null), "Invalid input: expected record, received null"),
            (json!([]), "Invalid input: expected record, received array"),
            (json!(3), "Invalid input: expected record, received number"),
            (
                json!("x"),
                "Invalid input: expected record, received string",
            ),
        ] {
            assert_eq!(
                validate_limits(&json!({"models":value}), "limits", true).expect_err("invalid"),
                format!("BAD_REQUEST: limits.models: {detail}")
            );
        }
        for scope in [json!({}), json!({"concurrency":null})] {
            assert_eq!(
                validate_limits(&json!({"models":{"m":scope}}), "limits", true).expect_err("empty"),
                "BAD_REQUEST: limits.models.m: a model override must set at least one limit; omit the model to remove it"
            );
        }
    }
    #[test]
    fn captured_summary_survives_competing_write() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("db");
        let store = SqliteStore::open(&path, 0).expect("store");
        let other = SqliteStore::open(&path, 0).expect("other");
        store.connection().execute("INSERT INTO api_keys(id,label,prefix,hash,limits,created_at) VALUES('k','before','p','h','{}',1)",[]).expect("seed");
        let mut listing = list_keys(&store, 100).expect("list");
        other.connection().execute("INSERT INTO api_keys(id,label,prefix,hash,limits,created_at,model_allowlist) VALUES('bad','bad','b','bad','{}',2,'broken')",[]).expect("unrelated bad row after initial list");
        listing
            .capture_mutation(&store, "k", 100, "smartRouting", true.into(), || {
                set_smart_routing(&store, "k", true)?;
                // Deterministic gate: rival commits after our write, before summary.
                other
                    .connection()
                    .execute(
                        "UPDATE api_keys SET label='after',smart_routing=0 WHERE id='k'",
                        [],
                    )
                    .expect("rival");
                Ok(None)
            })
            .expect("mutation");
        assert_eq!(listing.data["keys"][0]["label"], "before");
        assert_eq!(listing.data["keys"][0]["smartRouting"], true);
        assert_eq!(
            other
                .connection()
                .query_row("SELECT label FROM api_keys WHERE id='k'", [], |r| r
                    .get::<_, String>(0))
                .expect("persisted"),
            "after"
        );
        assert_eq!(
            other
                .connection()
                .query_row("SELECT smart_routing FROM api_keys WHERE id='k'", [], |r| r
                    .get::<_, i64>(0))
                .expect("persisted"),
            0
        );
    }
}
pub(crate) fn safe_token(s: &str) -> &str {
    if !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:/+-".contains(&b))
    {
        s
    } else {
        "(unprintable)"
    }
}

pub fn set_expiry(store: &SqliteStore, id: &str, expiry: Option<i64>) -> Result<(), String> {
    if expiry.is_some_and(|v| v <= 0) {
        return Err("BAD_REQUEST: expiresAt: Too small: expected number to be >0".into());
    }
    if expiry.is_some_and(|v| v > 8_640_000_000_000_000) {
        return Err(
            "BAD_REQUEST: expiresAt: Too big: expected number to be <=8640000000000000".into(),
        );
    }
    require_key(store, id)?;
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Expiry(expiry),
    )
    .map_err(|e| e.to_string())
}

pub fn set_models(store: &SqliteStore, id: &str, models: Option<&[String]>) -> Result<(), String> {
    if let Some(i) = models.and_then(|m| m.iter().position(String::is_empty)) {
        return Err(format!(
            "BAD_REQUEST: modelAllowlist.{i}: Too small: expected string to have >=1 characters"
        ));
    }
    let json = models.map(|m| serde_json::to_string(m).expect("strings"));
    require_key(store, id)?;
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Models(json.as_deref()),
    )
    .map_err(|e| e.to_string())
}

pub fn set_guardrail(store: &SqliteStore, id: &str, policy: Option<&str>) -> Result<(), String> {
    let policy = policy.map(omni_ir::js::trim);
    if let Some(p) = policy {
        // Frozen Zod counts Unicode code points for string size checks.
        let length = p.chars().count();
        if length == 0 {
            return Err(
                "BAD_REQUEST: policy: Too small: expected string to have >=1 characters".into(),
            );
        }
        if length > 4000 {
            return Err(
                "BAD_REQUEST: policy: Too big: expected string to have <=4000 characters".into(),
            );
        }
    }
    require_key(store, id)?;
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Guardrail(policy),
    )
    .map_err(|e| e.to_string())
}

fn require_key(store: &SqliteStore, id: &str) -> Result<(), String> {
    if omni_store::keys::get_operator(store.connection(), id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err("BAD_REQUEST: no such api key".into());
    }
    Ok(())
}

pub fn set_smart_routing(store: &SqliteStore, id: &str, enabled: bool) -> Result<(), String> {
    require_key(store, id)?;
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::SmartRouting(enabled),
    )
    .map_err(|e| e.to_string())
}

pub fn revoke(store: &SqliteStore, id: &str, now: i64) -> Result<(), String> {
    omni_store::keys::edit(
        store.connection(),
        id,
        omni_store::keys::KeyEdit::Revoke(now),
    )
    .map_err(|e| e.to_string())
}

/// Explicit public projection: never serialize the stored hash.
pub struct KeyListing {
    /// The listing for display and editing: well-formed limits only, and
    /// the complete `limitUsage` with model names as they print (a lone
    /// surrogate as U+FFFD, the bytes stdout carries in both builds).
    pub data: Value,
    pub allowlists: Vec<omni_ir::jsjson::JsValue>,
    /// Each key's complete matrix (lone-surrogate overrides included) and
    /// its readings, exact: what `--json` prints.
    pub limits_js: Vec<omni_ir::jsjson::JsValue>,
    pub usage_js: Vec<omni_ir::jsjson::JsValue>,
}

impl KeyListing {
    /// Replace a mutation result with the pre-write target projection. Reading
    /// after UPDATE would leak a concurrent writer's state into this response.
    pub fn capture_mutation<F>(
        &mut self,
        store: &SqliteStore,
        id: &str,
        now: i64,
        field: &str,
        value: Value,
        write: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Result<Option<omni_ir::jsjson::JsValue>, String>,
    {
        let mut captured = project_keys(
            store,
            now,
            omni_store::keys::operator_rows(store.connection(), Some(id))
                .map_err(|e| e.to_string())?,
        )?;
        let index = captured.data["keys"]
            .as_array()
            .expect("keys")
            .iter()
            .position(|k| k["id"] == id)
            .ok_or("BAD_REQUEST: no such api key")?;
        let written = write()?;
        captured.data["keys"][index][field] = value.clone();
        if field == "modelAllowlist" {
            captured.allowlists[index] = omni_ir::jsjson::JsValue::from(&value);
        }
        if field == "limits" {
            captured.limits_js[index] =
                written.unwrap_or_else(|| omni_ir::jsjson::JsValue::from(&value));
        }
        let usage = crate::api::limit_usage(store, id, &captured.limits_js[index], now)
            .map_err(|e| e.message)?;
        let key = &mut captured.data["keys"][index];
        key["limitUsage"] = Value::Array(usage.iter().map(crate::api::lossy).collect());
        self.data["keys"] = Value::Array(vec![key.clone()]);
        self.allowlists = vec![captured.allowlists[index].clone()];
        self.limits_js = vec![captured.limits_js[index].clone()];
        self.usage_js = vec![omni_ir::jsjson::JsValue::Array(usage)];
        Ok(())
    }
    /// One key as JS sees it: the serde summary with its exact fields
    /// (allowlist, limits, readings) put back.
    fn exact(&self, index: usize) -> omni_ir::jsjson::JsValue {
        use omni_ir::jsjson::JsValue;
        let mut key = JsValue::from(&self.data["keys"][index]);
        if let JsValue::Object(fields) = &mut key {
            for (name, value) in fields {
                let name = String::from_utf16_lossy(name);
                match name.as_str() {
                    "modelAllowlist" => *value = self.allowlists[index].clone(),
                    "limits" => *value = self.limits_js[index].clone(),
                    "limitUsage" => *value = self.usage_js[index].clone(),
                    _ => {}
                }
            }
        }
        key
    }
    pub fn one_json(&self, index: usize) -> String {
        omni_ir::jsjson::stringify_pretty(&self.exact(index)).unwrap_or_default()
    }
    pub fn json(&self) -> String {
        use omni_ir::jsjson::{JsValue, stringify_pretty};
        let keys = (0..self.allowlists.len()).map(|i| self.exact(i)).collect();
        stringify_pretty(&JsValue::Object(vec![(
            "keys".encode_utf16().collect(),
            JsValue::Array(keys),
        )]))
        .unwrap_or_default()
    }
}

pub fn list_keys(store: &SqliteStore, now: i64) -> Result<KeyListing, String> {
    project_keys(
        store,
        now,
        omni_store::keys::list_operator(store.connection()).map_err(|e| e.to_string())?,
    )
}
fn project_keys(
    store: &SqliteStore,
    now: i64,
    rows: Vec<omni_store::keys::OperatorKey>,
) -> Result<KeyListing, String> {
    let mut keys = Vec::new();
    let mut allowlists = Vec::new();
    let mut limits_js = Vec::new();
    let mut usage_js = Vec::new();
    for omni_store::keys::OperatorKey {
        key,
        allowlist_json: raw,
        created_at,
        expires_at,
        revoked_at,
        ..
    } in rows
    {
        allowlists.push(match raw {
            None => omni_ir::jsjson::JsValue::Null,
            Some(raw) => crate::operator_json::parse(&raw)?,
        });
        let allowlist = Value::Null;
        let limits = key
            .limits
            .as_ref()
            .map_or(Value::Null, omni_store::LimitConfig::to_json_well_formed);
        let exact = key.limits.as_ref().map_or(
            omni_ir::jsjson::JsValue::Null,
            omni_store::LimitConfig::to_js,
        );
        let readings =
            crate::api::limit_usage(store, &key.id, &exact, now).map_err(|e| e.message)?;
        let usage: Vec<Value> = readings.iter().map(crate::api::lossy).collect();
        limits_js.push(exact);
        usage_js.push(omni_ir::jsjson::JsValue::Array(readings));
        keys.push(json!({"id":key.id,"label":key.label,"prefix":key.prefix,"modelAllowlist":allowlist,"limits":limits,"limitUsage":usage,"bodyLoggingOptOut":key.body_logging_opt_out,"createdAt":created_at,"revokedAt":revoked_at,"expiresAt":expires_at,"guardrailPolicy":key.guardrail_policy,"smartRouting":key.smart_routing}));
    }
    Ok(KeyListing {
        data: json!({"keys":keys}),
        allowlists,
        limits_js,
        usage_js,
    })
}
