/// Gemini 4 rows carry the tier ids a live `fetchAvailableModels` reported on
/// 2026-11-22; prices are Google's public standard rates per family, not the
/// Carbon/Argon introductory ones that end 2026-11-30.
#[test]
fn builtin_antigravity_lists_gemini_4_tiers_at_standard_rates() {
    let providers = omni_router::Providers::builtin();
    let catalog = &providers.get("antigravity").expect("provider").catalog;
    let families = [
        ("carbon", false, 4.0, 20.0, 0.2),
        ("argon", false, 4.0, 20.0, 0.2),
        ("neon", true, 3.0, 15.0, 0.15),
        ("hydrogen", true, 1.5, 7.5, 0.075),
    ];
    let mut expected = Vec::new();
    for (family, xhigh, input, output, cache_read) in families {
        let tiers: &[&str] = if xhigh {
            &["xhigh", "high", "medium", "low"]
        } else {
            &["high", "medium", "low"]
        };
        for tier in tiers {
            expected.push((
                format!("gemini-4-{family}-{tier}"),
                input,
                output,
                cache_read,
            ));
        }
    }
    let ids: Vec<&str> = catalog.iter().map(|m| m.id.as_str()).collect();
    let want: Vec<&str> = expected.iter().map(|(id, ..)| id.as_str()).collect();
    assert_eq!(ids[..want.len()], want[..]);
    assert_eq!(ids[want.len()], "gemini-3.8-flash-high");
    for (model, (id, input, output, cache_read)) in catalog.iter().zip(&expected) {
        assert_eq!(model.pricing.input, *input, "{id}");
        assert_eq!(model.pricing.output, *output, "{id}");
        assert_eq!(model.pricing.cache_read, Some(*cache_read), "{id}");
        assert_eq!(model.pricing.cache_write_5m, Some(0.0), "{id}");
        assert_eq!(model.pricing.cache_write_1h, Some(0.0), "{id}");
        assert_eq!(model.context_window, Some(1_048_576.0), "{id}");
        assert_eq!(model.max_output_tokens, Some(65_536.0), "{id}");
    }
}
