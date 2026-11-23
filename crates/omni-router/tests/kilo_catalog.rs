//! Kilo's catalog rows, pinned against literals and cross-checked with the
//! generated `provider-catalog.json` the dashboard serves. Kilo proxies other
//! vendors' models, so the ids carry their origin prefix and the registry
//! claims no prefix of its own.

#[test]
fn builtin_kilo_lists_twenty_seven_rows_at_the_published_rates() {
    let providers = omni_router::Providers::builtin();
    let kilo = providers.get("kilo").expect("provider");
    // (id, input, output, cacheRead, cacheWrite, contextWindow, maxOutputTokens)
    let expected = [
        (
            "anthropic/claude-fable-5",
            10.0,
            50.0,
            1.0,
            12.5,
            1_000_000.0,
            128_000.0,
        ),
        (
            "anthropic/claude-opus-5",
            5.0,
            25.0,
            0.5,
            6.25,
            1_000_000.0,
            128_000.0,
        ),
        (
            "anthropic/claude-sonnet-5",
            2.0,
            10.0,
            0.2,
            2.5,
            1_000_000.0,
            128_000.0,
        ),
        (
            "anthropic/claude-haiku-4.5",
            1.0,
            5.0,
            0.1,
            1.25,
            200_000.0,
            64_000.0,
        ),
        (
            "openai/gpt-5.6-sol",
            5.0,
            30.0,
            0.5,
            6.25,
            1_050_000.0,
            128_000.0,
        ),
        (
            "openai/gpt-5.6-terra",
            2.0,
            12.0,
            0.2,
            2.5,
            1_050_000.0,
            128_000.0,
        ),
        (
            "openai/gpt-5.6-luna",
            0.2,
            1.2,
            0.02,
            0.25,
            1_050_000.0,
            128_000.0,
        ),
        (
            "google/gemini-3.1-pro-preview",
            2.0,
            12.0,
            0.2,
            0.375,
            1_048_576.0,
            65_536.0,
        ),
        (
            "google/gemini-3.7-flash",
            0.75,
            3.75,
            0.075,
            0.041667,
            1_048_576.0,
            65_536.0,
        ),
        (
            "moonshotai/kimi-k3",
            3.0,
            15.0,
            0.3,
            0.0,
            1_048_576.0,
            131_072.0,
        ),
    ];
    assert_eq!(kilo.catalog.len(), 27);
    for (model, (id, input, output, cache_read, cache_write, context, max_output)) in
        kilo.catalog.iter().zip(expected)
    {
        assert_eq!(model.id, id);
        assert_eq!(model.pricing.input, input, "{id}");
        assert_eq!(model.pricing.output, output, "{id}");
        assert_eq!(model.pricing.cache_read, Some(cache_read), "{id}");
        assert_eq!(model.pricing.cache_write_5m, Some(cache_write), "{id}");
        assert_eq!(model.pricing.cache_write_1h, Some(cache_write), "{id}");
        assert_eq!(model.context_window, Some(context), "{id}");
        assert_eq!(model.max_output_tokens, Some(max_output), "{id}");
    }
    // The free rows are priced at zero, not left unpriced: a zero rate is a
    // fact about the model, an absent one would read as "unknown".
    let free = kilo
        .catalog
        .iter()
        .find(|m| m.id == "nvidia/nemotron-3-ultra-550b-a55b:free")
        .expect("free row");
    assert_eq!(free.pricing.input, 0.0);
    assert_eq!(free.pricing.output, 0.0);
    assert_eq!(free.pricing.cache_read, Some(0.0));
    // The auto rows route by tier; only `small` names a rate.
    let small = kilo
        .catalog
        .iter()
        .find(|m| m.id == "kilo-auto/small")
        .expect("auto small");
    assert_eq!(small.pricing.input, 0.05);
    assert_eq!(small.pricing.output, 0.4);
    assert_eq!(small.pricing.cache_read, Some(0.005));
    // Kilo proxies the whole catalog: tools, images and reasoning are all
    // claimed, and no id prefix belongs to kilo itself.
    assert!(kilo.capabilities.tools);
    assert!(kilo.capabilities.images);
    assert!(kilo.capabilities.reasoning);
    assert!(kilo.model_prefixes.is_empty());
}

#[test]
fn kilo_catalog_matches_the_generated_descriptor_and_default() {
    let generated: serde_json::Value = serde_json::from_str(include_str!(
        "../../omni-control/data/provider-catalog.json"
    ))
    .expect("generated catalog");
    let registry = omni_router::Providers::builtin();
    let actual = registry.get("kilo").expect("registered");
    let expected = generated["kilo"]["catalog"]["models"]
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
    let default = generated["kilo"]["catalog"]["defaultModel"]
        .as_str()
        .expect("defaultModel");
    assert_eq!(default, "anthropic/claude-sonnet-5");
    assert!(actual.catalog.iter().any(|m| m.id == default));
}
