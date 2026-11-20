//! Operator-only body read projection. Artifact values stay in the lossless
//! JavaScript carrier all the way to JSON.stringify-compatible HTTP bytes.
use crate::api::Failure;
use omni_crypto::field::FieldKey;
use omni_ir::jsjson::{JsValue, stringify};
use omni_store::SqliteStore;

pub fn read_request_body(store: &SqliteStore, key: &FieldKey, id: &str) -> Result<String, Failure> {
    render(store.get_body(key, id)?, id)
}

pub async fn read_request_body_postgres(
    store: &omni_store::pg::PgStore,
    key: &FieldKey,
    id: &str,
) -> Result<String, Failure> {
    render(store.get_body(key, id).await?, id)
}

fn render(read: Option<omni_store::pg::bodies::BodyRead>, id: &str) -> Result<String, Failure> {
    let (request_id, state, truncated, size, at, artifact) = match read {
        None => (
            JsValue::String(id.encode_utf16().collect()),
            "none",
            false,
            JsValue::Number(0.0),
            JsValue::Null,
            JsValue::Null,
        ),
        Some(read) => (
            read.row.request_id,
            read.row.detail_state.as_str(),
            read.row.truncated,
            read.row.size_bytes,
            read.row.at,
            read.artifact.unwrap_or(JsValue::Null),
        ),
    };
    let string = |s: &str| JsValue::String(s.encode_utf16().collect());
    let value = JsValue::Object(
        [
            ("requestId", request_id),
            ("detailState", string(state)),
            ("truncated", JsValue::Bool(truncated)),
            ("sizeBytes", size),
            ("at", at),
            ("artifact", artifact),
        ]
        .into_iter()
        .map(|(k, v)| (k.encode_utf16().collect(), v))
        .collect(),
    );
    stringify(&value).ok_or_else(|| Failure::internal("body projection could not be encoded"))
}
