import { GatewayError } from "@omni/ir";
import type { UsageDimension, UsageGrain } from "@omni/store";
import { z } from "zod";

/**
 * Runs a schema and converts a Zod failure into a BAD_REQUEST carrying the
 * offending field path, so a caller can see which field it got wrong.
 *
 * Deliberately a second copy of the ingress helper rather than a shared import:
 * the request path must not depend on the control package, and eight lines of
 * error shaping is a cheaper price than that edge.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue?.path.join(".") ?? "(root)";
  throw new GatewayError("BAD_REQUEST", `${path}: ${issue?.message ?? "invalid request"}`);
}

/**
 * A finite number from a query parameter, or the fallback.
 *
 * Every caller hands this function strings: the control API from a URL, the CLI
 * from flags. An empty or blank param is absent, not zero — `Number("")` is 0,
 * so an unguarded upper bound clamps a span to the epoch and answers "nothing"
 * where the operator asked for everything, and an unguarded page size collapses
 * to a single row.
 *
 * A literal `"0"` is not blank and stays a value, because the epoch and a zero
 * limit are both things a caller can legitimately mean.
 */
export function optionalNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.trim().length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const providerIdSchema = z.enum(["anthropic", "openai", "kimi", "kilo", "grok", "custom"]);

/**
 * A hypothetical request, described only by required capabilities. This keeps
 * prompt content out of the control surface while exercising router hard filters.
 */
export const dryRunSchema = z
  .object({
    tools: z.boolean().default(false),
    images: z.boolean().default(false),
    reasoning: z.boolean().default(false),
  })
  .strict();

const targetSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.enum(["anthropic", "openai", "kimi", "kilo", "grok"]),
      model: z.string().min(1),
      tier: z.number().int().min(1),
      weight: z.number().positive(),
      costPerMTok: z.object({
        input: z.number().min(0),
        output: z.number().min(0),
        cacheRead: z.number().min(0).optional(),
        cacheWrite5m: z.number().min(0).optional(),
        cacheWrite1h: z.number().min(0).optional(),
      }),
      contextWindow: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      capabilities: z.object({
        tools: z.boolean(),
        images: z.boolean(),
        reasoning: z.boolean(),
      }),
    })
    .strict(),
  z
    .object({
      provider: z.literal("custom"),
      endpointId: z.string().trim().min(1),
      model: z.string().min(1),
      tier: z.number().int().min(1),
      weight: z.number().positive(),
      costPerMTok: z.object({
        input: z.number().min(0),
        output: z.number().min(0),
        cacheRead: z.number().min(0).optional(),
        cacheWrite5m: z.number().min(0).optional(),
        cacheWrite1h: z.number().min(0).optional(),
      }),
      contextWindow: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      capabilities: z.object({
        tools: z.boolean(),
        images: z.boolean(),
        reasoning: z.boolean(),
      }),
    })
    .strict(),
]);

export const modelSchema = z.object({
  // `claude/` is reserved: `GET /v1/models` advertises a mirror of every pool
  // under that prefix for Claude Code's picker, and ingress unwinds it again on
  // the way in. A pool that took the namespace would be shadowed by its own
  // mirror rule and become unaddressable, which is worth refusing at the point
  // it is named rather than discovering as a routing failure.
  id: z
    .string()
    .min(1)
    .refine((value) => !value.toLowerCase().startsWith("claude/"), {
      message:
        'model id must not start with "claude/": that prefix is reserved for discovery mirrors',
    }),
  strategy: z.enum(["score", "priority", "roundRobin", "weighted"]),
  isAlias: z.boolean(),
  targets: z.array(targetSchema).min(1, "a virtual model needs at least one target"),
});

export const keyCreateSchema = z
  .object({
    label: z.string().min(1).default("api key"),
    /** Null means every configured model. An empty array would mean none. */
    modelAllowlist: z.array(z.string().min(1)).nullable().default(null),
    rateLimitPerMin: z.number().int().positive().nullable().default(null),
  })
  .strict();

export const settingsSchema = z.object({
  weights: z
    .object({
      tier: z.number(),
      health: z.number(),
      quota: z.number(),
      cost: z.number(),
      latency: z.number(),
      load: z.number(),
    })
    .strict(),
  maxAttempts: z.number().int().min(1).max(10),
  requestDeadlineMs: z.number().int().min(0),
  breakerThreshold: z.number().int().min(1),
  breakerCooldownMs: z.number().int().positive(),
  logRetentionDays: z.number().int().min(1),
  /** Zero disables quota polling. Takes effect at the next restart. */
  quotaPollIntervalMs: z.number().int().min(0),
  rtkEnabled: z.boolean(),
});

/** Only these credential fields are operator-editable. Secrets are not. */
export const credentialPatchSchema = z
  .object({
    label: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    tier: z.number().int().min(1).optional(),
    weight: z.number().positive().optional(),
  })
  .strict();

/** Mirrors `UsageDimension` exactly; the store whitelists the column. */
export const dimensionSchema = z.enum([
  "credential",
  "model",
  "requestedModel",
  "apiKey",
  "provider",
  "hour",
  "day",
]);

export const grainSchema = z.enum(["raw", "daily"]);

/**
 * `hour` exists only in the raw logs and `day` only in the rollup. Rejecting
 * the mismatch here keeps the store's whitelist a lookup rather than a second
 * validation layer, and turns an operator's bad query into a BAD_REQUEST
 * instead of an error raised from SQL.
 */
const GRAIN_DIMENSIONS: Readonly<Record<UsageGrain, ReadonlySet<UsageDimension>>> = {
  raw: new Set(["credential", "model", "requestedModel", "apiKey", "provider", "hour"]),
  daily: new Set(["credential", "model", "requestedModel", "apiKey", "provider", "day"]),
};

export function requireDimension(grain: UsageGrain, dimension: UsageDimension): UsageDimension {
  if (GRAIN_DIMENSIONS[grain].has(dimension)) return dimension;
  throw new GatewayError("BAD_REQUEST", `usage grain "${grain}" cannot group by "${dimension}"`);
}
