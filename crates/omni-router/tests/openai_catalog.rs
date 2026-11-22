#[test]
fn builtin_openai_lists_gpt_6_2_with_auth_specific_limits_and_prices() {
    let providers = omni_router::Providers::builtin();
    let catalog = &providers.get("openai").expect("provider").catalog;
    for (model, id, input, output, cache_read, cache_write, oauth_context) in [
        (
            &catalog[0],
            "gpt-6.2-astra",
            8.0,
            40.0,
            0.4,
            10.0,
            272_000.0,
        ),
        (&catalog[1], "gpt-6.2-sol", 2.0, 10.0, 0.1, 2.5, 500_000.0),
    ] {
        assert_eq!(model.id, id);
        assert_eq!(model.pricing.input, input, "{id}");
        assert_eq!(model.pricing.output, output, "{id}");
        assert_eq!(model.pricing.cache_read, Some(cache_read), "{id}");
        assert_eq!(model.pricing.cache_write_5m, Some(cache_write), "{id}");
        assert_eq!(model.pricing.cache_write_1h, Some(0.0), "{id}");
        assert_eq!(model.context_window, Some(922_000.0), "{id}");
        assert_eq!(model.max_output_tokens, Some(128_000.0), "{id}");
        assert_eq!(
            model.oauth_limits,
            Some((Some(oauth_context), Some(128_000.0))),
            "{id}"
        );
    }
}
