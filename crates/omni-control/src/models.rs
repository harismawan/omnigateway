//! Lossless operator projection; routing retains its separate validated reader.
use omni_ir::jsjson::JsValue;
use omni_store::SqliteStore;

pub fn list(store: &SqliteStore) -> Result<Vec<JsValue>, String> {
    omni_store::models::operator_rows(store.connection())
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, targets, strategy, alias)| {
            Ok(JsValue::Object(vec![
                (
                    "id".encode_utf16().collect(),
                    JsValue::from(&serde_json::json!(id)),
                ),
                (
                    "targets".encode_utf16().collect(),
                    crate::operator_json::parse(&targets)?,
                ),
                (
                    "strategy".encode_utf16().collect(),
                    JsValue::from(&serde_json::json!(strategy)),
                ),
                ("isAlias".encode_utf16().collect(), JsValue::Bool(alias)),
            ]))
        })
        .collect()
}
pub fn get(store: &SqliteStore, id: &str) -> Result<JsValue, String> {
    list(store)?
        .into_iter()
        .find(|m| {
            crate::settings_value::get(m, "id") == Some(&JsValue::from(&serde_json::json!(id)))
        })
        .ok_or_else(|| format!("MODEL_UNAVAILABLE: no virtual model \"{id}\""))
}

pub fn remove(store: &SqliteStore, id: &str) -> Result<(), String> {
    omni_store::models::remove(store.connection(), id).map_err(|e| e.to_string())
}
