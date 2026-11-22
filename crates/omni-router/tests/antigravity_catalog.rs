/// Gemini 4 rows come from Google's public model and pricing pages
/// (2026-11-22), not a `fetchAvailableModels` probe; standard rates, not the
/// Carbon/Argon introductory ones that end 2026-11-30.
#[test]
fn builtin_antigravity_lists_gemini_4_at_standard_rates() {
    let providers = omni_router::Providers::builtin();
    let catalog = &providers.get("antigravity").expect("provider").catalog;
    for (model, id, input, output, cache_read) in [
        (&catalog[0], "gemini-4-carbon", 4.0, 20.0, 0.2),
        (&catalog[1], "gemini-4-argon", 4.0, 20.0, 0.2),
        (&catalog[2], "gemini-4-neon", 3.0, 15.0, 0.15),
        (&catalog[3], "gemini-4-hydrogen", 1.5, 7.5, 0.075),
    ] {
        assert_eq!(model.id, id);
        assert_eq!(model.pricing.input, input, "{id}");
        assert_eq!(model.pricing.output, output, "{id}");
        assert_eq!(model.pricing.cache_read, Some(cache_read), "{id}");
        assert_eq!(model.pricing.cache_write_5m, Some(0.0), "{id}");
        assert_eq!(model.pricing.cache_write_1h, Some(0.0), "{id}");
        assert_eq!(model.context_window, Some(1_048_576.0), "{id}");
        assert_eq!(model.max_output_tokens, Some(65_536.0), "{id}");
    }
    assert_eq!(catalog[4].id, "gemini-3.8-flash-high");
}
