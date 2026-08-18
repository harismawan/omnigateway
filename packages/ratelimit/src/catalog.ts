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

export const limitConfigSchema = z
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

/**
 * The sparse matrix of limits on one key.
 *
 * An absent key and an explicit `null` both mean unlimited. Because limits are
 * per-key with no inheritance, nothing distinguishes the two and nothing needs
 * to: there is no "inherit" for an absent key to have meant.
 */
export type LimitConfig = z.infer<typeof limitConfigSchema>;

/**
 * Validates a stored or submitted `limits` value, throwing on anything this
 * build cannot understand.
 *
 * Throwing rather than returning a partial config is deliberate; see the note
 * on `.strict()` above.
 */
export function parseLimitConfig(value: unknown): LimitConfig {
  return limitConfigSchema.parse(value);
}
