import type { ProviderModelCatalogEntry, ProviderReasoningForm } from "../catalog-types.ts";

/**
 * Anthropic's curated models and their list prices.
 *
 * Prices checked 2026-08-08 against Anthropic's published API pricing. Cache
 * reads are a flat 0.1x of base input across the range, expanded here into
 * absolute figures because a target stores a number, not a multiplier.
 *
 * Note: Claude Sonnet 5 carries an introductory $2.00 / $10.00 rate through
 * 2026-08-31. The standard rate is used here so a model configured today still
 * prices correctly in September; edit the target if the intro rate applies.
 *
 * Context and output limits are the published maxima; the 1M window on the
 * Opus, Sonnet and Fable entries is the default there, not an opt-in tier.
 */
export const ANTHROPIC_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "claude-opus-5",
  models: [
    {
      id: "claude-fable-5",
      label: "Claude Fable 5",
      pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
      limits: { contextWindow: 200_000, maxOutputTokens: 64_000 },
      // Predates adaptive thinking: this one still takes a fixed budget and
      // rejects the adaptive form.
      reasoningForm: "budget",
    },
  ],
};

/** The 1M-context marker an operator may leave on a stored model string. */
const ONE_M_SUFFIX = "[1m]";

/** A dated snapshot suffix, as in `claude-haiku-4-5-20251001`. */
const DATED_SUFFIX = /-\d{8}$/;

/**
 * Resolves a configured model string to the thinking form it accepts.
 *
 * Operators store the model verbatim, so the same catalog entry arrives spelled
 * several ways: bare, dated, or with the 1M marker still attached. Those two
 * suffixes are stripped and nothing else is guessed — a name that is not in the
 * catalog is assumed to be a model published after this table was written, and
 * new models speak the current form.
 */
export function anthropicReasoningForm(model: string): ProviderReasoningForm {
  let id = model.trim();
  if (id.toLowerCase().endsWith(ONE_M_SUFFIX)) id = id.slice(0, -ONE_M_SUFFIX.length).trim();
  id = id.replace(DATED_SUFFIX, "");
  return ANTHROPIC_MODELS.models.find((m) => m.id === id)?.reasoningForm ?? "adaptive";
}
