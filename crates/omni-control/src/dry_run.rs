//! The frozen capabilities-only hypothetical request, using the live router.
use crate::{
    api::Failure,
    body_schema::{Z, parse_or_throw},
    settings_value::get,
};
use omni_ir::jsjson::JsValue;
use omni_router::{Providers, RankInput, Snapshot, rank};
use omni_store::SqliteStore;
use serde_json::json;

pub fn cli(
    store: &SqliteStore,
    secret: &str,
    id: &str,
    input: &JsValue,
    now: f64,
) -> Result<JsValue, String> {
    run(
        store,
        &omni_crypto::field::derive_key(secret),
        id,
        input,
        now,
        &Providers::builtin(),
    )
    .map_err(|e| match e.code {
        Some(code) => format!("{code}: {}", e.message),
        None => e.message,
    })
}

pub fn run(
    store: &SqliteStore,
    _key: &omni_crypto::field::FieldKey,
    id: &str,
    input: &JsValue,
    now: f64,
    providers: &Providers,
) -> Result<JsValue, Failure> {
    let schema = Z::Obj {
        shape: ["tools", "images", "reasoning"]
            .into_iter()
            .map(|k| (k, Z::Default(Box::new(Z::Bool), || JsValue::Bool(false))))
            .collect(),
        strict: true,
        refine: None,
    };
    let need = parse_or_throw(&schema, input).map_err(Failure::bad)?;
    let models = models(store, id)?;
    let snapshot = Snapshot::new(
        credentials(store, now)?,
        health(store)?,
        store.list_quota()?,
        models,
        store.get_settings()?,
        now,
    );
    let model = snapshot.models.get(id).ok_or_else(|| Failure {
        code: Some("MODEL_UNAVAILABLE"),
        message: format!("no virtual model \"{id}\""),
    })?;
    let enabled = |k| matches!(get(&need, k), Some(JsValue::Bool(true)));
    let mut probe = json!({"model":id,"messages":[{"role":"user","content": if enabled("images") {json!([{"type":"image","mediaType":"image/png","data":""}])} else {json!([{"type":"text","text":""}])}}],"stream":false});
    if enabled("tools") {
        probe["tools"] = json!([{"kind":"portable","name":"probe","description":"","inputSchema":{"type":"object"}}]);
    }
    if enabled("reasoning") {
        probe["reasoning"] = json!({"mode":"adaptive"});
    }
    let request = serde_json::from_value(probe).map_err(Failure::internal)?;
    let result = rank(&RankInput {
        request: &request,
        model,
        snapshot: &snapshot,
        now,
        rand: 0.0,
        load: None,
        recent: None,
        providers: Some(providers),
    });
    let strategy = serde_json::to_value(&model.strategy).map_err(Failure::internal)?;
    let candidates: Vec<_> = result.candidates.iter().map(|c| json!({"credentialId":c.credential.id,"credentialLabel":c.credential.label,"provider":c.credential.provider,"model":c.target.model,"tier":c.target.tier,"score":c.score,"reasons":{"tier":c.reasons.tier,"health":c.reasons.health,"quota":c.reasons.quota,"cost":c.reasons.cost,"latency":c.reasons.latency,"load":c.reasons.load}})).collect();
    let excluded: Vec<_> = result
        .excluded
        .iter()
        .map(|e| json!({"credentialId":e.credential_id,"model":e.model,"reason":e.reason}))
        .collect();
    let out = json!({"modelId":model.id,"strategy":strategy,"deterministic":strategy != "weighted","rankedAt":now,"candidates":candidates,"excluded":excluded});
    Ok(JsValue::from(&out))
}

// These projections belong only to operator dry-run. Never relax live readers.
fn models(store: &SqliteStore, selected: &str) -> Result<Vec<omni_store::VirtualModel>, Failure> {
    use crate::cli_cell;
    let mut stmt = store
        .connection()
        .prepare("SELECT * FROM virtual_models ORDER BY id")
        .map_err(Failure::internal)?;
    let mut rows = stmt.query([]).map_err(Failure::internal)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(Failure::internal)? {
        // Frozen JSON.parses every row, but only iterates the selected targets.
        let raw = cli_cell::json(row.get_ref("targets").map_err(Failure::internal)?)
            .map_err(Failure::internal)?;
        let id = cli_cell::string(row.get_ref("id").map_err(Failure::internal)?);
        if id != selected {
            continue;
        }
        let mut targets: serde_json::Value =
            serde_json::from_str(&omni_ir::jsjson::stringify(&raw).unwrap_or_default())
                .map_err(Failure::internal)?;
        let list = targets
            .as_array_mut()
            .ok_or_else(|| Failure::internal("targets is not iterable"))?;
        for target in list.iter_mut() {
            for field in ["tier", "weight"] {
                target[field] = json!(omni_ir::js::to_number(target.get(field)));
            }
            for cap in ["tools", "images", "reasoning"] {
                target["capabilities"][cap] = json!(omni_ir::js::truthy(
                    target.get("capabilities").and_then(|c| c.get(cap))
                ));
            }
        }
        let strategy =
            match cli_cell::Cell::read(row.get_ref("strategy").map_err(Failure::internal)?) {
                cli_cell::Cell::String(s) => omni_store::Strategy::parse(&s),
                // An object/number matches no switch case, even if ToString is "score".
                c => omni_store::Strategy::Other(cli_cell::scalar_string(&c.json())),
            };
        out.push(omni_store::VirtualModel {
            id,
            targets: serde_json::from_value(targets).map_err(Failure::internal)?,
            strategy,
            is_alias: false,
        });
    }
    Ok(out)
}

fn credentials(store: &SqliteStore, now: f64) -> Result<Vec<omni_store::Credential>, Failure> {
    use crate::cli_cell::{scalar_number, scalar_string};
    let mut out = Vec::new();
    for row in crate::credentials::rows(store, None)? {
        let cell = |k| get(&row, k).unwrap_or(&JsValue::Null);
        let text = |k| scalar_string(cell(k));
        let number = |k| scalar_number(cell(k));
        let data = cell("providerData");
        if matches!(data, JsValue::Null) {
            return Err(Failure::internal("null provider_data"));
        }
        // Encode the already evaluated expiry predicate, avoiding integer truncation
        // at fractional millisecond boundaries. API-key expiry is not consulted.
        let expires_at = (!matches!(cell("expiresAt"), JsValue::Null)
            && number("expiresAt") <= now)
            .then_some(i64::MIN);
        out.push(omni_store::Credential {
            lone_endpoint: None,
            id: text("id"),
            provider: text("provider"),
            label: text("label"),
            auth_type: omni_store::AuthType::parse(&text("authType")),
            enabled: matches!(cell("enabled"), JsValue::Bool(true)),
            tier: number("tier"),
            weight: number("weight"),
            expires_at,
            account_email: None,
            provider_data: serde_json::from_str(
                &omni_ir::jsjson::stringify(data).unwrap_or_default(),
            )
            .map_err(Failure::internal)?,
            disabled_reason: None,
            disabled_at: None,
            has_refresh_token: matches!(cell("hasRefreshToken"), JsValue::Bool(true)),
            token_version: 0,
            created_at: 0,
            updated_at: 0,
            secrets: omni_store::CredentialSecrets {
                access_token: omni_store::Secret::Absent,
                refresh_token: omni_store::Secret::Absent,
                api_key: omni_store::Secret::Absent,
                id_token: omni_store::Secret::Absent,
            },
        });
    }
    Ok(out)
}

fn health(store: &SqliteStore) -> Result<Vec<omni_store::CredentialHealth>, Failure> {
    use crate::cli_cell;
    let mut stmt = store
        .connection()
        .prepare("SELECT * FROM credential_health")
        .map_err(Failure::internal)?;
    let mut rows = stmt.query([]).map_err(Failure::internal)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(Failure::internal)? {
        let cell = |k: &str| row.get_ref(k).map_err(Failure::internal);
        let failures = cell("consecutive_failures")?;
        let count = cli_cell::scalar_number(&cli_cell::Cell::read(failures).json());
        let denominator = match cli_cell::Cell::read(failures) {
            cli_cell::Cell::String(s) => omni_ir::js::string_to_number(&format!("1{s}")),
            cli_cell::Cell::Bytes(_) => {
                omni_ir::js::string_to_number(&format!("1{}", cli_cell::string(failures)))
            }
            _ => 1.0 + count,
        };
        let time = |k| -> Result<Option<f64>, Failure> {
            let c = cli_cell::Cell::read(cell(k)?);
            Ok((!matches!(c, cli_cell::Cell::Null)).then(|| cli_cell::scalar_number(&c.json())))
        };
        out.push(omni_store::CredentialHealth {
            credential_id: cli_cell::string(cell("credential_id")?),
            model: cli_cell::string(cell("model")?),
            breaker_state: match cli_cell::Cell::read(cell("breaker_state")?) {
                cli_cell::Cell::String(s) => omni_store::BreakerState::parse(&s),
                _ => omni_store::BreakerState::Other(String::new()),
            },
            consecutive_failures: 0,
            opened_at: time("opened_at")?,
            rate_limited_until: time("rate_limited_until")?,
            scalar: Some(std::sync::Arc::new(
                omni_store::credentials::HealthScalars {
                    failures: failures.into(),
                    opened: cell("opened_at")?.into(),
                    until: cell("rate_limited_until")?.into(),
                    count,
                    score: 1.0 / denominator,
                },
            )),
        });
    }
    Ok(out)
}
