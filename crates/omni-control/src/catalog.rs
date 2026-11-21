//! Built-in provider descriptors (`PROVIDER_DESCRIPTORS`), generated from the
//! frozen TS registry by `conformance/cli/provider-catalog.ts`. Never edit the
//! data file by hand; `--check` reports drift.
//!
//! Operator metadata only: registry order, catalog rows, pricing, limits,
//! model auth, capabilities and presentation. Gateway routing keeps its own
//! registry, so listing a provider here does not make its codec available.
//! Plugin providers are installation state and are not represented.
use crate::settings_value::get;
use omni_ir::jsjson::JsValue;
use std::sync::OnceLock;

pub const DATA: &str = include_str!("../data/provider-catalog.json");

/// Every built-in descriptor, in `Object.entries` order.
pub fn descriptors() -> &'static [(Vec<u16>, JsValue)] {
    static PARSED: OnceLock<JsValue> = OnceLock::new();
    match PARSED.get_or_init(|| crate::operator_json::parse(DATA).expect("generated JSON")) {
        JsValue::Object(entries) => entries,
        _ => unreachable!("generated catalog is an object"),
    }
}

/// An own-key lookup, so `constructor` or `__proto__` is never a provider.
pub fn descriptor(id: &str) -> Option<&'static JsValue> {
    descriptors()
        .iter()
        .find(|(k, _)| k.iter().copied().eq(id.encode_utf16()))
        .map(|(_, v)| v)
}

fn units(s: &str) -> JsValue {
    JsValue::String(s.encode_utf16().collect())
}

fn catalog_models(descriptor: &JsValue) -> &[JsValue] {
    match get(descriptor, "catalog").and_then(|c| get(c, "models")) {
        Some(JsValue::Array(models)) => models,
        _ => &[],
    }
}

fn choice<'a>(descriptor: &'a JsValue, model: &str) -> Option<&'a JsValue> {
    let id = units(model);
    catalog_models(descriptor)
        .iter()
        .find(|c| get(c, "id") == Some(&id))
}

/// `catalogRows`: every model row with its provider id, filtered by provider.
pub fn rows(only: Option<&str>) -> Vec<(String, &'static JsValue)> {
    descriptors()
        .iter()
        .map(|(id, d)| (String::from_utf16_lossy(id), d))
        .filter(|(id, _)| only.is_none_or(|only| only == id))
        .flat_map(|(id, d)| catalog_models(d).iter().map(move |m| (id.clone(), m)))
        .collect()
}

/// `entryModelAuths` through the built-in registry; an unknown provider
/// reaches with every way in (`UNKNOWN_PROVIDER_AUTHS`).
pub fn model_auths(provider: &str, model: &str) -> Vec<&'static str> {
    let Some(d) = descriptor(provider) else {
        return vec!["oauth", "apiKey"];
    };
    let auths = choice(d, model)
        .and_then(|c| get(c, "auth"))
        .or_else(|| get(d, "catalog").and_then(|c| get(c, "authTypes")));
    match auths {
        Some(JsValue::Array(list)) => list
            .iter()
            .map(|a| match a {
                a if *a == units("oauth") => "oauth",
                a if *a == units("apiKey") => "apiKey",
                _ => unreachable!("generated auth is oauth or apiKey"),
            })
            .collect(),
        _ => unreachable!("generated catalog states authTypes"),
    }
}

/// `targetFromCatalog`: a target the operator then owns. Pricing is copied,
/// capabilities are the provider's, token limits are deliberately omitted.
/// Errors are the frozen CLI's usage messages.
pub fn target(spec: &str) -> Result<JsValue, String> {
    let Some((provider, model)) = spec.split_once(':').filter(|(p, _)| !p.is_empty()) else {
        return Err(format!(
            "--from-catalog expects <provider>:<model>, got \"{spec}\""
        ));
    };
    let Some(d) = descriptor(provider) else {
        return Err(format!("unknown provider \"{provider}\" in \"{spec}\""));
    };
    let Some(pricing) = choice(d, model).and_then(|c| get(c, "pricing")) else {
        return Err(format!(
            "no catalog entry for \"{spec}\"; see omni models catalog"
        ));
    };
    let field = |k: &str, v: JsValue| (k.encode_utf16().collect(), v);
    Ok(JsValue::Object(vec![
        field("provider", units(provider)),
        field("model", units(model)),
        field("tier", JsValue::Number(1.0)),
        field("weight", JsValue::Number(1.0)),
        field("costPerMTok", pricing.clone()),
        field(
            "capabilities",
            get(d, "capabilities").expect("generated").clone(),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    /// The embedded data is the frozen registry, compared as values with key
    /// and row order intact. The generator's `--check` holds the bytes.
    #[test]
    fn generated_data_matches_frozen_ts_registry() {
        let repo = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let output = Command::new("bun")
            .current_dir(repo)
            .args([
                "-e",
                "import { PROVIDER_DESCRIPTORS } from './packages/providers/src/descriptors.ts'; process.stdout.write(JSON.stringify(PROVIDER_DESCRIPTORS))",
            ])
            .output()
            .expect("Bun oracle required");
        assert!(output.status.success(), "{output:?}");
        let frozen = crate::operator_json::parse(&String::from_utf8(output.stdout).expect("UTF8"))
            .expect("frozen JSON");
        let embedded = crate::operator_json::parse(super::DATA).expect("embedded JSON");
        assert_eq!(embedded, frozen);
        assert_eq!(
            omni_ir::jsjson::stringify(&embedded),
            omni_ir::jsjson::stringify(&frozen)
        );
    }

    #[test]
    fn lookups_are_own_keys_and_auths_follow_rows() {
        assert!(super::descriptor("constructor").is_none());
        assert!(super::descriptor("__proto__").is_none());
        assert_eq!(super::model_auths("plugin", "x"), ["oauth", "apiKey"]);
        assert_eq!(super::model_auths("qoder", "x"), ["oauth"]);
        assert_eq!(super::model_auths("custom", "x"), ["apiKey"]);
        assert_eq!(super::model_auths("kilo", "kilo-auto/free"), ["apiKey"]);
        assert_eq!(super::model_auths("kilo", "unlisted"), ["oauth", "apiKey"]);
        assert!(super::rows(Some("")).is_empty());
        assert!(super::rows(Some("qoder")).is_empty());
        assert_eq!(super::rows(None).len(), 78);
    }
}
