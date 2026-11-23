//! Muse's four catalog rows, pinned against literals and cross-checked with
//! the generated `provider-catalog.json` the dashboard serves.

#[test]
fn builtin_muse_lists_four_rows_at_the_published_rates() {
    let providers = omni_router::Providers::builtin();
    let muse = providers.get("muse").expect("provider");
    // (id, input, output, cacheRead, contextWindow, maxOutputTokens).
    // Contributor rows bill a fraction of the standard rate because Meta
    // trains on that traffic; cache reads price at the published rate, and
    // nothing bills a write premium.
    let expected = [
        ("muse-spark-1.3", 1.25, 4.25, 0.15, 1_048_576.0, 943_718.0),
        (
            "muse-spark-1.3-contributor",
            0.1,
            0.2,
            0.002,
            1_048_576.0,
            943_718.0,
        ),
        ("muse-spark-1.2", 1.25, 4.25, 0.15, 1_048_576.0, 943_718.0),
        (
            "muse-spark-1.2-contributor",
            0.1,
            0.2,
            0.002,
            1_048_576.0,
            943_718.0,
        ),
    ];
    assert_eq!(muse.catalog.len(), expected.len());
    for (model, (id, input, output, cache_read, context, max_output)) in
        muse.catalog.iter().zip(expected)
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
    assert!(muse.capabilities.tools);
    assert!(muse.capabilities.images);
    assert!(muse.capabilities.reasoning);
    assert_eq!(muse.model_prefixes, ["muse-", "muse-spark"]);
}

#[test]
fn muse_catalog_matches_the_generated_descriptor_and_default() {
    let generated: serde_json::Value = serde_json::from_str(include_str!(
        "../../omni-control/data/provider-catalog.json"
    ))
    .expect("generated catalog");
    let registry = omni_router::Providers::builtin();
    let actual = registry.get("muse").expect("registered");
    let expected = generated["muse"]["catalog"]["models"]
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
    let default = generated["muse"]["catalog"]["defaultModel"]
        .as_str()
        .expect("defaultModel");
    assert_eq!(default, "muse-spark-1.3");
    assert!(actual.catalog.iter().any(|m| m.id == default));
}
