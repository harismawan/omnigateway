import type { ProviderModelCatalogEntry } from "../catalog-types.ts";

/**
 * The Gemini models Antigravity's Cloud Code backend serves.
 *
 * Read on 2026-09-05 from a live `POST /v1internal:fetchAvailableModels` against
 * a connected account, which is the authenticated catalog Antigravity's own
 * client reads. That replaced an earlier second-hand copy of omniroute's static
 * alias table, and the two disagreed on nearly everything that matters:
 * omniroute 3.8.49 stopped at 3.6, 3.8.50 stopped at 3.7 and declared every 3.6
 * and 3.5 id retired, and Google's public model docs list neither the tier ids
 * nor `gemini-pro-agent` at all — `v1internal` is not the public Gemini API and
 * publishes no catalog. **Re-probe rather than reasoning from any of those
 * three.** A row that stops working is an id change upstream, not a bug here.
 *
 * The probe is per-account: it reports what *this* subscription may reach, so an
 * install on a different tier can legitimately see a shorter list than this.
 *
 * Each tier is its own upstream id with its own `thinkingBudget` — High is `-1`
 * (dynamic), Medium 4000, Low 1000 — which is what lets `wire.ts` treat the tier
 * as the model and send no budget of its own. The backend also offers a
 * `<family>-tiered` id per Flash family that picks a depth itself; those are left
 * out because an operator choosing a model here has already made that choice.
 *
 * `gemini-2.5-flash`, `gemini-2.5-flash-thinking` and `gemini-2.5-flash-lite`
 * are **deliberately absent though they answer**: the probe reports all three
 * with the displayName "Gemini 3.1 Flash Lite", so they are old names aliased
 * onto a model already listed below and carrying them would offer four spellings
 * of one row. `gemini-pro-agent` is left out for the same reason — it is
 * `gemini-3.1-pro-high` under a name that does not say which model it is.
 *
 * **Everything here is unpriced**, which is a deliberate zero and not a missing
 * figure. Antigravity is sold as a subscription and states no per-token rate at
 * all, so the router's scorer reads these as unknown and drops them from the
 * cost term — the same treatment, and the same stored value, as Kilo's
 * `kilo-auto/*` routers. An operator who wants an antigravity target cost-ranked
 * sets a real `costPerMTok` on the saved target. The public Gemini API's list
 * prices do not apply and must not be copied in: nobody is billed per token on
 * this surface.
 *
 * Antigravity's backend also serves Claude (250K context) and GPT-OSS models,
 * and the probe returns them. They are left out on purpose: `claude-` is already
 * anthropic's `modelPrefixes`, so those rows could never be reached by a bare
 * name, and two providers answering to one vendor's model line is a worse trade
 * than the capacity is worth. Excluding them is also what makes the quota probe
 * honest — see `oauth.ts`, which reads only the Gemini family's windows. The
 * `chat_*` entries the probe marks `isInternal` and the `tab_*` and `-image`
 * rows are not chat surfaces and are excluded too.
 */
/**
 * The output ceiling every Flash row advertises.
 *
 * `wire.ts` reads it to clamp a client that named a larger figure of its own,
 * and to leave room above a thinking budget.
 *
 * **This was 16,384 until 2026-09-05**, on a reading that Cloud Code answered
 * `400 Invalid Argument` above that whatever the model could do. The live
 * catalog advertises 65,536 on every Flash row and 65,535 on the Pro and Lite
 * rows, so the figure was raised to what the backend itself publishes. That
 * raise was **not** re-confirmed against a live `streamGenerateContent`: if
 * large `max_tokens` requests start failing as invalid argument, this constant
 * is the first thing to suspect, and the earlier 16,384 the thing to restore.
 */
export const MAX_OUTPUT_TOKENS = 65_536;

/** What the Pro and Lite rows advertise instead — one below the Flash ceiling. */
const PRO_MAX_OUTPUT_TOKENS = 65_535;

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
const FLASH_LIMITS = { contextWindow: 1_048_576, maxOutputTokens: MAX_OUTPUT_TOKENS };
const PRO_LIMITS = { contextWindow: 1_048_576, maxOutputTokens: PRO_MAX_OUTPUT_TOKENS };

export const ANTIGRAVITY_MODELS: ProviderModelCatalogEntry = {
  // The newest family's High tier, matching what the live catalog marks
  // `recommended` and what Antigravity's own client defaults to.
  defaultModel: "gemini-3.8-flash-high",
  // OAuth only. There is no API key that reaches `v1internal`: the surface is
  // the IDE's, and it authenticates with a Google account.
  authTypes: ["oauth"],
  models: [
    {
      id: "gemini-3.8-flash-high",
      label: "Gemini 3.8 Flash (High)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.8-flash-medium",
      label: "Gemini 3.8 Flash (Medium)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.8-flash-low",
      label: "Gemini 3.8 Flash (Low)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.7-flash-high",
      label: "Gemini 3.7 Flash (High)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.7-flash-medium",
      label: "Gemini 3.7 Flash (Medium)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.7-flash-low",
      label: "Gemini 3.7 Flash (Low)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.6-flash-high",
      label: "Gemini 3.6 Flash (High)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.6-flash-medium",
      label: "Gemini 3.6 Flash (Medium)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.6-flash-low",
      label: "Gemini 3.6 Flash (Low)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    // The 3.5 Flash tiers keep ids that do not say which model or tier they are.
    // That is Antigravity's own naming, forwarded unchanged because the upstream
    // matches on these strings; the labels carry what the probe's displayName
    // says each one actually is.
    {
      id: "gemini-3-flash-agent",
      label: "Gemini 3.5 Flash (High)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.5-flash-low",
      label: "Gemini 3.5 Flash (Medium)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.5-flash-extra-low",
      label: "Gemini 3.5 Flash (Low)",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3-flash",
      label: "Gemini 3 Flash",
      pricing: FREE,
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.5-flash-lite",
      label: "Gemini 3.5 Flash Lite",
      pricing: FREE,
      limits: PRO_LIMITS,
    },
    {
      id: "gemini-3.1-pro-high",
      label: "Gemini 3.1 Pro (High)",
      pricing: FREE,
      limits: PRO_LIMITS,
    },
    {
      id: "gemini-3.1-pro-low",
      label: "Gemini 3.1 Pro (Low)",
      pricing: FREE,
      limits: PRO_LIMITS,
    },
    {
      id: "gemini-3.1-flash-lite",
      label: "Gemini 3.1 Flash Lite",
      pricing: FREE,
      limits: PRO_LIMITS,
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      pricing: FREE,
      limits: PRO_LIMITS,
    },
  ],
};
