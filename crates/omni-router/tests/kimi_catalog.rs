//! Kimi's four catalog rows, pinned against literals and cross-checked with
//! the generated `provider-catalog.json` the dashboard serves.

#[test]
fn builtin_kimi_lists_four_rows_at_the_published_rates() {
    let providers = omni_router::Providers::builtin();
    let kimi = providers.get("kimi").expect("provider");
    // (id, input, output, cacheRead, contextWindow, maxOutputTokens)
    let expected = [
        ("k3-256k", 3.0, 15.0, 0.3, 262_144.0, 131_072.0),
        ("k3", 3.0, 15.0, 0.3, 1_048_576.0, 131_072.0),
        ("kimi-for-coding", 0.95, 4.0, 0.19, 262_144.0, 131_072.0),
        (
            "kimi-for-coding-highspeed",
            0.95,
            8.0,
            0.19,
            262_144.0,
            131_072.0,
        ),
    ];
    assert_eq!(kimi.catalog.len(), expected.len());
    for (model, (id, input, output, cache_read, context, max_output)) in
        kimi.catalog.iter().zip(expected)
    {
        assert_eq!(model.id, id);
        assert_eq!(model.pricing.input, input, "{id}");
        assert_eq!(model.pricing.output, output, "{id}");
        assert_eq!(model.pricing.cache_read, Some(cache_read), "{id}");
        assert_eq!(model.pricing.cache_write_5m, Some(0.0), "{id}");
        assert_eq!(model.pricing.cache_write_1h, Some(0.0), "{id}");
        assert_eq!(model.context_window, Some(context), "{id}");
        assert_eq!(model.max_output_tokens, Some(max_output), "{id}");
    }
    // Tools only: no images, no reasoning.
    assert!(kimi.capabilities.tools);
    assert!(!kimi.capabilities.images);
    assert!(!kimi.capabilities.reasoning);
    assert_eq!(kimi.model_prefixes, ["kimi-", "moonshot"]);
}

#[test]
fn kimi_catalog_matches_the_generated_descriptor_and_default() {
    let generated: serde_json::Value = serde_json::from_str(include_str!(
        "../../omni-control/data/provider-catalog.json"
    ))
    .expect("generated catalog");
    let registry = omni_router::Providers::builtin();
    let actual = registry.get("kimi").expect("registered");
    let expected = generated["kimi"]["catalog"]["models"]
        .as_array()
        .expect("models");
    assert!(!expected.is_empty());
    assert_eq!(actual.catalog.len(), expected.len());
    for (actual, expected) in actual.catalog.iter().zip(expected) {
        assert_eq!(actual.id, expected["id"]);
        assert_eq!(actual.label, expected["label"]);
        assert_eq!(
            actual.pricing,
            serde_json::from_value(expected["pricing"].clone()).expect("pricing")
        );
        assert_eq!(
            actual.context_window,
            expected["limits"]["contextWindow"].as_f64()
        );
        assert_eq!(
            actual.max_output_tokens,
            expected["limits"]["maxOutputTokens"].as_f64()
        );
    }
    // The default model is a row the router can actually price.
    let default = generated["kimi"]["catalog"]["defaultModel"]
        .as_str()
        .expect("defaultModel");
    assert_eq!(default, "k3-256k");
    assert!(actual.catalog.iter().any(|m| m.id == default));
}
