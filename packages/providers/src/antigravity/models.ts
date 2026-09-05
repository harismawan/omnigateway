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
 * of one row. `gemini-pro-agent` is **not** one of these: it names the same
 * model as `gemini-3.1-pro-high`, and it is the only one of the two the backend
 * will actually serve. See the row below.
 *
 * **These prices are the public Gemini API's list rates, and nobody is billed
 * them on this surface.** Antigravity is sold as a flat subscription and states
 * no per-token rate at all; the figures below are carried at the operator's
 * explicit request, so that `cost_usd` reads as what the same traffic would have
 * cost on the paid API rather than as zero.
 *
 * Read what that means before changing anything that consumes them. Catalog
 * pricing is the default a **new** target stores, and a target's stored price is
 * what `finishLog` debits — so an API key with a dollar limit will exhaust that
 * limit against spend which did not happen. An operator who wants the older
 * behaviour sets `costPerMTok` to zero on the saved target; catalog edits reach
 * new targets only, so existing targets keep whatever they already hold.
 *
 * Sources and the shape of the mapping, since none of it is one-to-one:
 *
 * - Rates read 2026-09-05 from `ai.google.dev/gemini-api/docs/pricing`. Each row
 *   is priced by the **model its displayName names**, not by its id — the tier
 *   suffixes (`-high`, `-low`) are Antigravity's own and the public API prices
 *   one model per family.
 * - **`gemini-3.8`, `-3.7` and `-3.6` Flash carry their `standard` rate, not the
 *   introductory one.** Google prices those three families at $0.75/$3.75
 *   through 2026-12-31 and $1.50/$7.50 from 1 January 2027. The standard figure
 *   is the one stored, deliberately: a table holding the promotional rate would
 *   be correct today and silently wrong on a date nobody is watching for, and
 *   these numbers are a reference for spend rather than an invoice. Every other
 *   family below is already on its standard rate, so this is the only row group
 *   where the two differ.
 * - Pro and 2.5 Pro price in two bands by prompt size. The **≤200K** band is
 *   carried, because `ProviderModelPricing` holds one number and the smaller
 *   band is the common case; a long-context request is under-costed here.
 * - Where a family prices audio above text, the **text** rate is carried.
 * - `cacheWrite5m` and `cacheWrite1h` are **0, and that is a real price rather
 *   than a missing one**: Google bills cache *storage* per hour, which is a
 *   different quantity from the per-token write premium these two fields hold.
 *   There is nowhere honest to put $/1M/hour, so it is left out rather than
 *   converted with an invented residency time.
 * - `gemini-3-flash` stays at zero: the public price list has no "Gemini 3
 *   Flash" row, and inventing one is the thing this comment exists to prevent.
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

/** Google bills cache storage per hour, not per write. See the note above. */
const NO_CACHE_WRITE = { cacheWrite5m: 0, cacheWrite1h: 0 };

/** The one row the public price list does not name. */
const FREE = { input: 0, output: 0, cacheRead: 0, ...NO_CACHE_WRITE };
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
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.8-flash-medium",
      label: "Gemini 3.8 Flash (Medium)",
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.8-flash-low",
      label: "Gemini 3.8 Flash (Low)",
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.7-flash-high",
      label: "Gemini 3.7 Flash (High)",
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.7-flash-medium",
      label: "Gemini 3.7 Flash (Medium)",
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.7-flash-low",
      label: "Gemini 3.7 Flash (Low)",
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.6-flash-high",
      label: "Gemini 3.6 Flash (High)",
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.6-flash-medium",
      label: "Gemini 3.6 Flash (Medium)",
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.6-flash-low",
      label: "Gemini 3.6 Flash (Low)",
      pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    // The 3.5 Flash tiers keep ids that do not say which model or tier they are.
    // That is Antigravity's own naming, forwarded unchanged because the upstream
    // matches on these strings; the labels carry what the probe's displayName
    // says each one actually is.
    {
      id: "gemini-3-flash-agent",
      label: "Gemini 3.5 Flash (High)",
      pricing: { input: 1.5, output: 9, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.5-flash-low",
      label: "Gemini 3.5 Flash (Medium)",
      pricing: { input: 1.5, output: 9, cacheRead: 0.15, ...NO_CACHE_WRITE },
      limits: FLASH_LIMITS,
    },
    {
      id: "gemini-3.5-flash-extra-low",
      label: "Gemini 3.5 Flash (Low)",
      pricing: { input: 1.5, output: 9, cacheRead: 0.15, ...NO_CACHE_WRITE },
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
      pricing: { input: 0.3, output: 2.5, cacheRead: 0.03, ...NO_CACHE_WRITE },
      limits: PRO_LIMITS,
    },
    {
      // **The catalog lists `gemini-3.1-pro-high` and the backend will not
      // serve it.** Measured 2026-09-05, twice: every request shape answers
      // `400 Request contains an invalid argument.` under that id while
      // `gemini-3.1-pro-low` answers 200 — so it is the id, not the tier, the
      // entitlement or the request. `gemini-pro-agent` carries the displayName
      // "Gemini 3.1 Pro (High)" and serves, so it is the same model under the
      // spelling that works.
      //
      // An earlier reading of this file left `gemini-pro-agent` out as "the
      // same row under a name that does not say which model it is". That was
      // right about the model and wrong about which id the backend takes, and
      // the probe cannot show it: `fetchAvailableModels` reports both.
      id: "gemini-pro-agent",
      label: "Gemini 3.1 Pro (High)",
      pricing: { input: 2, output: 12, cacheRead: 0.2, ...NO_CACHE_WRITE },
      limits: PRO_LIMITS,
    },
    {
      id: "gemini-3.1-pro-low",
      label: "Gemini 3.1 Pro (Low)",
      pricing: { input: 2, output: 12, cacheRead: 0.2, ...NO_CACHE_WRITE },
      limits: PRO_LIMITS,
    },
    {
      id: "gemini-3.1-flash-lite",
      label: "Gemini 3.1 Flash Lite",
      pricing: { input: 0.25, output: 1.5, cacheRead: 0.025, ...NO_CACHE_WRITE },
      limits: PRO_LIMITS,
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      pricing: { input: 1.25, output: 10, cacheRead: 0.125, ...NO_CACHE_WRITE },
      limits: PRO_LIMITS,
    },
  ],
};
