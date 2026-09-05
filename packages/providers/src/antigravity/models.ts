import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * The Gemini models Antigravity's Cloud Code backend serves.
 *
 * Ids and limits read on 2026-09-05 from omniroute 3.8.49's
 * `open-sse/config/antigravityModelAliases.ts`, whose own comments record which
 * rows were proven live against `streamGenerateContent` and which were dropped
 * for answering 400. Google publishes no catalog for `v1internal`, so this is a
 * second-hand reading of a live probe rather than a quote from a vendor page —
 * a row that stops working is an id change upstream, not a bug here.
 *
 * The ids are not display names and several of them do not say which model they
 * are: `gemini-pro-agent` is 3.1 Pro at the High budget, `gemini-3-flash-agent`
 * is 3.5 Flash at High, and `gemini-3.5-flash-low` is the *Medium* tier with
 * `-extra-low` below it. That is Antigravity's own naming, forwarded unchanged
 * because the upstream matches on these strings; the labels carry the tier so an
 * operator picking from a list is not choosing between three spellings of
 * "flash".
 *
 * **Everything here is unpriced**, which is a deliberate zero and not a missing
 * figure. Antigravity is sold as a subscription and states no per-token rate at
 * all, so the router's scorer reads these as unknown and drops them from the
 * cost term — the same treatment, and the same stored value, as Kilo's
 * `kilo-auto/*` routers. An operator who wants an antigravity target cost-ranked
 * sets a real `costPerMTok` on the saved target.
 *
 * Antigravity's backend also serves Claude and GPT-OSS models. They are left out
 * on purpose: `claude-` is already anthropic's `modelPrefixes`, so those rows
 * could never be reached by a bare name, and two providers answering to one
 * vendor's model line is a worse trade than the capacity is worth. Excluding
 * them is also what makes the quota probe honest — see `oauth.ts`, which reads
 * only the Gemini family's windows.
 */
/**
 * Cloud Code's own output ceiling, below every model's own.
 *
 * Every row states this rather than the 65K its model holds, because the
 * catalog's job is to say what a request may actually ask for: `GET /v1/models`
 * is what a client paces itself against, and the wrapper answers
 * `400 Invalid Argument` above this figure whatever the model could do.
 * Confirmed upstream against both a Gemini and a Claude row.
 *
 * Lives here rather than in `wire.ts` — which also reads it, to clamp a client
 * that named its own figure — because this file is the leaf `catalog.ts`
 * assembles, and the dependency has to run in that direction.
 */
export const MAX_OUTPUT_TOKENS = 16_384;

export const ANTIGRAVITY_MODELS: ProviderModelCatalogEntry = {
  // Antigravity's own `defaultAgentModelId`.
  defaultModel: "gemini-3.6-flash-high",
  // OAuth only. There is no API key that reaches `v1internal`: the surface is
  // the IDE's, and it authenticates with a Google account.
  authTypes: ["oauth"],
  models: [
    {
      id: "gemini-3.6-flash-high",
      label: "Gemini 3.6 Flash (High)",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-3.6-flash-medium",
      label: "Gemini 3.6 Flash (Medium)",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-3.6-flash-low",
      label: "Gemini 3.6 Flash (Low)",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-pro-agent",
      label: "Gemini 3.1 Pro (High)",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-3.1-pro-low",
      label: "Gemini 3.1 Pro (Low)",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-3-flash-agent",
      label: "Gemini 3.5 Flash (High)",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-3.5-flash-low",
      label: "Gemini 3.5 Flash (Medium)",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-3.5-flash-extra-low",
      label: "Gemini 3.5 Flash (Low)",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-3.1-flash-lite",
      label: "Gemini 3.1 Flash Lite",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-2.5-flash-thinking",
      label: "Gemini 2.5 Flash Thinking",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    {
      id: "gemini-2.5-flash-lite",
      label: "Gemini 2.5 Flash Lite",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      limits: { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
  ],
};
