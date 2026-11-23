//! `parseModelCatalog` / `publicModelCatalog`: the vendor's `assistant` scene
//! projected into public rows. No vendor secrets (`api_key`, `url`, `model`)
//! and no guessed prices cross this boundary.

use omni_ir::jsjson::JsValue;
use serde_json::{Map, Value, json};

/// One inference model as the credential bundle and the wire carry it.
#[derive(Debug, Clone, PartialEq)]
pub struct QoderModel {
    pub key: String,
    pub display_name: String,
    pub images: bool,
    pub reasoning: bool,
    pub max_input_tokens: Option<f64>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Invalid Qoder model catalog")]
pub struct InvalidCatalog;

/// `text`: 1..=200 UTF-16 units, no control characters — public model metadata
/// must not carry header injection.
fn text(value: Option<&JsValue>) -> Option<String> {
    match value {
        Some(JsValue::String(s))
            if !s.is_empty() && s.len() <= 200 && s.iter().all(|u| *u >= 0x20 && *u != 0x7f) =>
        {
            Some(String::from_utf16_lossy(s))
        }
        _ => None,
    }
}

fn safe_positive_integer(value: Option<&JsValue>) -> Option<f64> {
    match value {
        Some(JsValue::Number(n))
            if n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0 =>
        {
            Some(*n)
        }
        _ => None,
    }
}

/// Scans at most 2000 rows, keeps at most 500, skips disabled rows and
/// duplicates, and reads only the public fields.
pub fn parse_model_catalog(value: &JsValue) -> Result<Vec<QoderModel>, InvalidCatalog> {
    let Some(JsValue::Array(rows)) = value.get("assistant") else {
        return Err(InvalidCatalog);
    };
    if !value.is_object() {
        return Err(InvalidCatalog);
    }
    let mut models: Vec<QoderModel> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for row in rows.iter().take(2000) {
        if !row.is_object() {
            continue;
        }
        // `[false, 0, "0"].includes(r.enable)` — strict, so only these three.
        match row.get("enable") {
            Some(JsValue::Bool(false)) => continue,
            Some(JsValue::Number(n)) if *n == 0.0 => continue,
            Some(v) if v.string_eq("0") => continue,
            _ => {}
        }
        let (Some(key), Some(display_name)) = (text(row.get("key")), text(row.get("display_name")))
        else {
            continue;
        };
        if seen.contains(&key) {
            continue;
        }
        seen.push(key.clone());
        models.push(QoderModel {
            key,
            display_name,
            images: matches!(row.get("is_vl"), Some(JsValue::Bool(true))),
            reasoning: matches!(row.get("is_reasoning"), Some(JsValue::Bool(true))),
            max_input_tokens: safe_positive_integer(row.get("max_input_tokens")),
        });
        if models.len() == 500 {
            break;
        }
    }
    Ok(models)
}

/// The version-1 public catalog stored on `providerData.modelCatalog`, the
/// shape `omni-control`'s `public_rows` reads back.
pub fn public_model_catalog(models: &[QoderModel]) -> Map<String, Value> {
    let rows: Vec<Value> = models
        .iter()
        .map(|m| {
            let mut limits = Map::new();
            if let Some(n) = m.max_input_tokens {
                omni_ir::deep::insert(
                    &mut limits,
                    "contextWindow".into(),
                    omni_ir::stream::number(n),
                );
            }
            json!({
                "id": m.key,
                "name": m.display_name,
                "pricing": null,
                "limits": Value::Object(limits),
            })
        })
        .collect();
    let mut out = Map::new();
    omni_ir::deep::insert(&mut out, "version".into(), json!(1));
    omni_ir::deep::insert(&mut out, "models".into(), Value::Array(rows));
    out
}

/// The bundle's `models` rows, in the credential's camelCase vocabulary.
pub fn bundle_rows(models: &[QoderModel]) -> Value {
    Value::Array(models.iter().map(bundle_row).collect())
}

fn bundle_row(m: &QoderModel) -> Value {
    let mut row = Map::new();
    omni_ir::deep::insert(&mut row, "key".into(), json!(m.key));
    omni_ir::deep::insert(&mut row, "displayName".into(), json!(m.display_name));
    omni_ir::deep::insert(&mut row, "images".into(), json!(m.images));
    omni_ir::deep::insert(&mut row, "reasoning".into(), json!(m.reasoning));
    if let Some(n) = m.max_input_tokens {
        omni_ir::deep::insert(
            &mut row,
            "maxInputTokens".into(),
            omni_ir::stream::number(n),
        );
    }
    Value::Object(row)
}

/// `providerData.inferenceModels`: the vendor-shaped rows a later refresh
/// re-parses as its last-good catalog when the listing is unavailable.
pub fn inference_rows(models: &[QoderModel]) -> Value {
    Value::Array(
        models
            .iter()
            .map(|m| {
                let mut row = Map::new();
                omni_ir::deep::insert(&mut row, "key".into(), json!(m.key));
                omni_ir::deep::insert(&mut row, "display_name".into(), json!(m.display_name));
                omni_ir::deep::insert(&mut row, "is_vl".into(), json!(m.images));
                omni_ir::deep::insert(&mut row, "is_reasoning".into(), json!(m.reasoning));
                // `undefined` on the TS side: the key is absent, never null.
                if let Some(n) = m.max_input_tokens {
                    omni_ir::deep::insert(
                        &mut row,
                        "max_input_tokens".into(),
                        omni_ir::stream::number(n),
                    );
                }
                Value::Object(row)
            })
            .collect(),
    )
}
