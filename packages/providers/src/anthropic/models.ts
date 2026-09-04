import type { ProviderModelCatalogEntry, ProviderReasoningForm } from "../catalog-types.ts";

/**
 * Anthropic's curated models and their list prices.
 *
 * Prices checked 2026-09-04 against Anthropic's published API pricing. Cache
 * reads are 0.1x of base input across the range *except* on Claude Fable 5.1,
 * which reads at 0.025x; the figures below are absolute because a target stores
 * a number, not a multiplier.
 *
 * Claude Sonnet 5's $2.00 / $10.00 launch rate is now its standard price — the
 * increase to $3.00 / $15.00 scheduled for 2026-09-01 was cancelled.
 *
 * Claude Mythos 5.1 is deliberately absent: it prices identically to Fable 5.1
 * but is limited-availability, so an operator offered it can add a target by
 * hand rather than have every console list a model it cannot reach.
 *
 * Context and output limits are the published maxima; the 1M window on the
 * Fable, Opus and Sonnet entries is the default there, not an opt-in tier.
 */
export const ANTHROPIC_MODELS: ProviderModelCatalogEntry = {
  defaultModel: "claude-opus-5",
  // A subscription token, or a console API key sent as `x-api-key`.
  authTypes: ["oauth", "apiKey"],
  models: [
    {
      id: "claude-fable-5-1",
      label: "Claude Fable 5.1",
      // Cache reads are 0.025x here, not the 0.1x every other entry pays.
      pricing: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    },
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
      pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
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
