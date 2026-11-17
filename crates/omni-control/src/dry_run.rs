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
    key: &omni_crypto::field::FieldKey,
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
    let models = store
        .list_models()?
        .into_iter()
        .map(|r| r.map_err(Failure::internal))
        .collect::<Result<Vec<_>, _>>()?;
    let snapshot = Snapshot::new(
        omni_store::credentials::list_routing(store.connection(), key)?,
        store.list_health()?,
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
