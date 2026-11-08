//! Virtual models and their targets, read as `listModels` in
//! `packages/store/src/sqlite/config.ts` reads them.
//!
//! TS parses `targets` with a bare `JSON.parse` and no validation, so the
//! fields are typed here as loosely as TS uses them: every number is a JS
//! number (`f64`), and keys this build does not know are kept in `extra` so
//! the value serializes back unchanged.

use crate::error::StoreError;
use crate::row;
use crate::vocab::Strategy;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// `TargetPricing`: dollars per million tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetPricing {
    pub input: f64,
    pub output: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "cacheWrite5m"
    )]
    pub cache_write_5m: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "cacheWrite1h"
    )]
    pub cache_write_1h: Option<f64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl TargetPricing {
    /// `cacheReadRate`: a tenth of input where no cache-read price is named.
    pub fn cache_read_rate(&self) -> f64 {
        self.cache_read.unwrap_or(self.input * 0.1)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub tools: bool,
    pub images: bool,
    pub reasoning: bool,
}

/// `Target`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub provider: String,
    /// Required for custom targets; absent on built-in ones. Kept as JSON
    /// because `servesTarget` treats a non-string as matching nothing, and a
    /// typed read would either refuse the row or lose that distinction.
    ///
    /// `None` is absent; `Some(Value::Null)` is an explicit `null`, which
    /// `servesTarget` treats as a value matching no account.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub endpoint_id: Option<serde_json::Value>,
    pub model: String,
    pub tier: f64,
    pub weight: f64,
    pub cost_per_m_tok: TargetPricing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<f64>,
    pub capabilities: Capabilities,
    /// A pin to one account; absent means any account of the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A key that is present deserializes to `Some`, even when it holds `null`.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(d).map(Some)
}

/// `VirtualModel`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualModel {
    pub id: String,
    pub targets: Vec<Target>,
    pub strategy: Strategy,
    /// Generated from an alias for a concrete model name.
    pub is_alias: bool,
}

const T: &str = "virtual_models";

/// One `virtual_models` row this build could not read, named by its id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRowError {
    pub id: String,
    pub reason: String,
}

impl std::fmt::Display for ModelRowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "virtual model {}: {}", self.id, self.reason)
    }
}

/// `ConfigRepo.listModels`, ordered by id, one result per row.
///
/// TS parses each row's `targets` with a bare `JSON.parse` inside one `.map`,
/// so a row that is not JSON throws the whole list there. The gateway's
/// routing snapshot must not: a row that does not read is returned as its own
/// error, naming the model, and every other model is still served. JSON that
/// is not shaped like `Target[]` is an error for that row too, where TS would
/// carry it on and misbehave at routing.
///
/// Only a failure of the query itself, or an unreadable `id`, fails the whole
/// read.
pub fn list(conn: &Connection) -> Result<Vec<Result<VirtualModel, ModelRowError>>, StoreError> {
    let mut stmt = conn.prepare_cached("SELECT * FROM virtual_models ORDER BY id")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let id = row::text(r, T, "id")?;
        out.push(read_model(r, &id).map_err(|reason| ModelRowError { id, reason }));
    }
    Ok(out)
}

fn read_model(r: &rusqlite::Row<'_>, id: &str) -> Result<VirtualModel, String> {
    let raw = row::json(r, T, "targets").map_err(|e| e.to_string())?;
    let targets = serde_json::from_value(raw)
        .map_err(|e| format!("virtual_models.targets: not a Target[] ({e})"))?;
    Ok(VirtualModel {
        targets,
        strategy: Strategy::parse(&row::text(r, T, "strategy").map_err(|e| e.to_string())?),
        is_alias: row::flag(r, "is_alias").map_err(|e| e.to_string())?,
        id: id.to_owned(),
    })
}
