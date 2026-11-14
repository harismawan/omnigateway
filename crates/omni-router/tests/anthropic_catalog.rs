#[test]
fn builtin_anthropic_uses_generated_prices_and_limits() {
    let providers = omni_router::Providers::builtin();
    let catalog = &providers.get("anthropic").expect("provider").catalog;
    assert_eq!(catalog.len(), 8);
    let opus = catalog
        .iter()
        .find(|m| m.id == "claude-opus-5-5")
        .expect("opus");
    assert_eq!(opus.pricing.input, 4.0);
    assert_eq!(opus.pricing.cache_write_1h, Some(8.0));
    assert_eq!(opus.context_window, Some(1_000_000.0));
    assert_eq!(opus.max_output_tokens, Some(128_000.0));
    assert!(providers.get("custom").expect("custom").catalog.is_empty());
}
