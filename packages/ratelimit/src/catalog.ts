import { z } from "zod";

/**
 * The dimensions a gateway API key can be limited in.
 *
 * These names are the outer JSON keys of `api_keys.limits` in every row, so
 * this list is a storage contract in the same class as `RTK_FILTER_IDS`, not an
 * internal enum: adding a name is free, renaming or removing one loses every
 * row that used it.
 */
export const DIMENSIONS = ["requests", "tokens", "spend", "concurrency"] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** Window names, persisted as the inner JSON keys. Same contract as above. */
export const WINDOWS = ["1m", "5h", "1w"] as const;

export type Window = (typeof WINDOWS)[number];

/**
 * Nominal length of each window.
 *
 * Every window is counted sliding rather than fixed. A fixed window resets on a
 * clock edge, which lets a key spend a whole window's allowance either side of
 * one — twice the configured ceiling with no rule broken — and it does that at
 * every size, not only at a minute.
 */
export const WINDOW_MS: Record<Window, number> = {
  "1m": 60_000,
  "5h": 5 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
};

/**
 * A whole count, or null for unlimited.
 *
 * Zero is refused: it denies every request, which is a revoked key rather than
 * a ceiling, and an operator who typed it meant something else.
 */
const countLimit = z.number().int().positive().nullable();

/** Dollars, so fractional. Otherwise the same rule as a count. */
const spendLimit = z.number().positive().nullable();

/**
 * `.strict()` throughout is the point of this file.
 *
 * An unknown window name is a parse failure, not a silent drop. `isRtkFilterId`
 * may discard an id it does not know on read because the worst outcome is a gap
 * in reported history; a limit key discarded the same way reads as "no limit"
 * and fails open on a control the operator explicitly set.
 */
const countWindows = z
  .object({
    "1m": countLimit.optional(),
    "5h": countLimit.optional(),
    "1w": countLimit.optional(),
  })
  .strict();

/**
 * No `1m`. A per-minute dollar ceiling is a rate limit in costume — `requests`
 * and `tokens` already shape burst at that horizon — and spend is a budget,
 * which is measured in hours and weeks.
 */
const spendWindows = z
  .object({
    "5h": spendLimit.optional(),
    "1w": spendLimit.optional(),
  })
  .strict();

/**
 * One scope's sparse matrix: the key-wide limits, or one model's override.
 *
 * Named apart from `LimitConfig` so the pure evaluator can take this and
 * nothing wider — handed a whole config, it would be handed a `models` member
 * it silently ignores.
 */
export const limitConfigBaseSchema = z
  .object({
    requests: countWindows.optional(),
    tokens: countWindows.optional(),
    spend: spendWindows.optional(),
    /**
     * Not a window: in-flight requests for this key right now. It exists
     * because no windowed dimension can see an agent loop that opens forty
     * streams and holds them — one request per stream, few tokens so far, and
     * no dollars yet.
     */
    concurrency: countLimit.optional(),
  })
  .strict();

/** The matrix of one scope. See `LimitConfig` for what absent and null mean. */
export type LimitConfigBase = z.infer<typeof limitConfigBaseSchema>;

/** How many models one key may override. A key is configured by hand. */
export const MAX_MODEL_OVERRIDES = 64;

/** The longest model name an override may carry, matched exactly. */
export const MAX_MODEL_NAME_LENGTH = 256;

/** Whether a scope sets any ceiling at all, rather than only nulls and empties. */
function setsAnyLimit(scope: LimitConfigBase): boolean {
  if (scope.concurrency !== undefined && scope.concurrency !== null) return true;
  for (const dimension of ["requests", "tokens", "spend"] as const) {
    const windows: Partial<Record<Window, number | null | undefined>> | undefined =
      scope[dimension];
    if (windows === undefined) continue;
    for (const window of WINDOWS) {
      const limit = windows[window];
      if (limit !== undefined && limit !== null) return true;
    }
  }
  return false;
}

/**
 * One model's override: the key-wide shape, minus `models`, and never empty.
 *
 * An override is removed by omitting it. An empty one — `{}`, or nothing but
 * nulls — would sit in the console as a row that reads like a ceiling and
 * limits nothing, so it is refused at write rather than stored as a husk.
 */
const modelOverrideSchema = limitConfigBaseSchema.refine(setsAnyLimit, {
  message: "a model override must set at least one limit; omit the model to remove it",
});

export const limitConfigSchema = limitConfigBaseSchema
  .extend({
    /**
     * Per-model overrides, keyed by the requested model exactly as the
     * allowlist sees it. They stack with the key-wide limits — a request for
     * one of these models must pass both — so no override can lift a key past
     * its own key-wide ceiling.
     *
     * Not a dimension: `DIMENSIONS` and `WINDOWS` are unchanged, and an older
     * build's strict parse refuses a row carrying this, which fails closed.
     */
    models: z
      .record(z.string().min(1).max(MAX_MODEL_NAME_LENGTH), modelOverrideSchema)
      .refine((models) => Object.keys(models).length <= MAX_MODEL_OVERRIDES, {
        message: `at most ${MAX_MODEL_OVERRIDES} model overrides per key`,
      })
      .optional(),
  })
  .strict();

/**
 * The sparse matrix of limits on one key.
 *
 * An absent key and an explicit `null` both mean unlimited. Because limits are
 * per-key with no inheritance, nothing distinguishes the two and nothing needs
 * to: there is no "inherit" for an absent key to have meant.
 */
export type LimitConfig = z.infer<typeof limitConfigSchema>;

/**
 * The override one model carries, or undefined where it has none.
 *
 * The single lookup, and every consumer goes through it. zod's record yields a
 * plain object, so a bare `limits.models?.[model]` answers
 * `Object.prototype.constructor` for a model named `constructor` — a function
 * where a matrix was expected, read as a ceiling by whoever indexed it.
 */
export function modelOverride(limits: LimitConfig, model: string): LimitConfigBase | undefined {
  const models = limits.models;
  if (models === undefined || !Object.hasOwn(models, model)) return undefined;
  return models[model];
}

/**
 * `.strict()` rejects an unknown key — except this one.
 *
 * `JSON.parse` makes `__proto__` an own property, and zod 4.4.3 nevertheless
 * drops it silently instead of refusing it, while rejecting `bogus` and `9m`
 * beside it. So `{"requests":{"__proto__":60}}` parses to `{"requests":{}}` and
 * a caller is told their ceiling was stored when nothing was: the "reports
 * success having changed nothing" outcome this codebase refuses elsewhere, and
 * an empty husk of exactly the shape `CLAUDE.md` forbids.
 *
 * Checked before parsing rather than as a refinement, because by the time zod
 * has a value to refine the key is already gone.
 */
function assertNoProto(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__") {
      throw new Error(`limits cannot name "__proto__"${path === "" ? "" : ` under ${path}`}`);
    }
    assertNoProto((value as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`);
  }
}

/**
 * Validates a stored or submitted `limits` value, throwing on anything this
 * build cannot understand.
 *
 * Throwing rather than returning a partial config is deliberate; see the note
 * on `.strict()` above.
 */
export function parseLimitConfig(value: unknown): LimitConfig {
  assertNoProto(value, "");
  return limitConfigSchema.parse(value);
}
