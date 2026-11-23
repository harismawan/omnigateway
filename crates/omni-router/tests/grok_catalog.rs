//! Grok's six catalog rows, pinned against literals and cross-checked with
//! the generated `provider-catalog.json` the dashboard serves.

#[test]
fn builtin_grok_lists_six_rows_at_the_published_rates() {
    let providers = omni_router::Providers::builtin();
    let grok = providers.get("grok").expect("provider");
    // (id, input, output, cacheRead, contextWindow, maxOutputTokens)
    let expected = [
        ("grok-4.6", 2.0, 6.0, 0.5, 500_000.0, 128_000.0),
        ("grok-4.5", 2.0, 6.0, 0.3, 500_000.0, 128_000.0),
        ("grok-4.3", 1.25, 2.5, 0.2, 1_000_000.0, 128_000.0),
        (
            "grok-4.20-0309-reasoning",
            1.25,
            2.5,
            0.2,
            1_000_000.0,
            128_000.0,
        ),
        (
            "grok-4.20-0309-non-reasoning",
            1.25,
            2.5,
            0.2,
            1_000_000.0,
            128_000.0,
        ),
        (
            "grok-4.20-multi-agent-0309",
            1.25,
            2.5,
            0.2,
            1_000_000.0,
            128_000.0,
        ),
    ];
    assert_eq!(grok.catalog.len(), expected.len());
    for (model, (id, input, output, cache_read, context, max_output)) in
        grok.catalog.iter().zip(expected)
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
    // Tools, images and reasoning: the full capability set.
    assert!(grok.capabilities.tools);
    assert!(grok.capabilities.images);
    assert!(grok.capabilities.reasoning);
    assert_eq!(grok.model_prefixes, ["grok-"]);
}

#[test]
fn grok_catalog_matches_the_generated_descriptor_and_default() {
    let generated: serde_json::Value = serde_json::from_str(include_str!(
        "../../omni-control/data/provider-catalog.json"
    ))
    .expect("generated catalog");
    let registry = omni_router::Providers::builtin();
    let actual = registry.get("grok").expect("registered");
    let expected = generated["grok"]["catalog"]["models"]
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
    let default = generated["grok"]["catalog"]["defaultModel"]
        .as_str()
        .expect("defaultModel");
    assert_eq!(default, "grok-4.6");
    assert!(actual.catalog.iter().any(|m| m.id == default));
}
