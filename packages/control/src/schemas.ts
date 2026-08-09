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

export const providerIdSchema = z.enum(["anthropic", "openai", "kimi"]);

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

export const modelSchema = z.object({
  id: z.string().min(1),
  strategy: z.enum(["score", "priority", "roundRobin", "weighted"]),
  isAlias: z.boolean(),
  targets: z
    .array(
      z.object({
        provider: providerIdSchema,
        model: z.string().min(1),
        tier: z.number().int().min(1),
        weight: z.number().positive(),
        // One object with optional prices rather than a union of shapes: a
        // union lets a malformed `cacheRead` fall through to the branch that
        // does not name it, so a bad price is dropped instead of rejected.
        costPerMTok: z.object({
          input: z.number().min(0),
          output: z.number().min(0),
          cacheRead: z.number().min(0).optional(),
          // A zero is a provider that bills no premium for creating a cache
          // entry — a price, not a missing one — so it has to survive parsing.
          cacheWrite5m: z.number().min(0).optional(),
          cacheWrite1h: z.number().min(0).optional(),
        }),
        // Advertised on GET /v1/models, never enforced here. Optional so a
        // target for a model the catalog does not list can stay silent rather
        // than claim a window nobody checked.
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        capabilities: z.object({
          tools: z.boolean(),
          images: z.boolean(),
          reasoning: z.boolean(),
        }),
      }),
    )
    .min(1, "a virtual model needs at least one target"),
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
      recency: z.number(),
    })
    .strict(),
  maxAttempts: z.number().int().min(1).max(10),
  requestDeadlineMs: z.number().int().positive(),
  breakerThreshold: z.number().int().min(1),
  breakerCooldownMs: z.number().int().positive(),
  logRetentionDays: z.number().int().min(1),
  /** Zero disables quota polling. Takes effect at the next restart. */
  quotaPollIntervalMs: z.number().int().min(0),
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
