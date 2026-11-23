//! Qoder registers OAuth-only with no invented models or model prefixes,
//! pinned against `qoderRegistration.test.ts` and the generated
//! `provider-catalog.json`. Its real catalog is account-derived: the OAuth
//! flow stores `providerData.modelCatalog`, which `omni-control` merges into
//! `/api/catalog` — the builtin registry stays empty.

#[test]
fn builtin_qoder_registers_empty_without_model_prefixes() {
    let providers = omni_router::Providers::builtin();
    let qoder = providers.get("qoder").expect("provider");
    assert!(qoder.catalog.is_empty(), "no invented models");
    assert!(qoder.model_prefixes.is_empty());
    // Tools, images and reasoning: the full capability set.
    assert!(qoder.capabilities.tools);
    assert!(qoder.capabilities.images);
    assert!(qoder.capabilities.reasoning);
}

#[test]
fn qoder_catalog_matches_the_generated_empty_descriptor() {
    let generated: serde_json::Value = serde_json::from_str(include_str!(
        "../../omni-control/data/provider-catalog.json"
    ))
    .expect("generated catalog");
    let catalog = &generated["qoder"]["catalog"];
    assert_eq!(catalog["models"].as_array().expect("models").len(), 0);
    assert_eq!(catalog["defaultModel"], "");
    assert_eq!(catalog["authTypes"], serde_json::json!(["oauth"]));
    assert_eq!(
        generated["qoder"]["modelPrefixes"]
            .as_array()
            .expect("modelPrefixes")
            .len(),
        0
    );
    assert_eq!(generated["qoder"]["presentation"]["label"], "Qoder");
    let registry = omni_router::Providers::builtin();
    let actual = registry.get("qoder").expect("registered");
    assert_eq!(actual.catalog.len(), 0);
    assert!(registry.has("qoder"));
}
