import { GatewayError } from "@omni/ir";
import { PROVIDER_ID_PATTERN } from "@omni/providers/descriptors";
import { limitConfigSchema } from "@omni/ratelimit/catalog";
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

/**
 * A provider id, validated by *format* rather than against a list.
 *
 * It was `z.enum(PROVIDER_IDS)`, and that was wrong in a way nothing caught:
 * `PROVIDER_IDS` is `Object.keys(...)` evaluated at import, which is long before
 * `loadPlugins()` runs — so the enum froze a build-time snapshot and would have
 * refused a credential for a provider the gateway had just registered. The same
 * bug `providerCatalog` had, in the one place where the symptom is "connecting
 * this account is impossible" rather than "this provider is missing from a list".
 *
 * Format alone is not the whole answer, and is not meant to be. Whether the
 * provider is *installed* is asked separately by each caller, because they want
 * different answers: `createApiKeyCredential` refuses to mint an account for a
 * provider that does not exist, while `putModel` accepts a target naming one,
 * for the same reason it accepts a dangling pin — removing a provider must not
 * make an unrelated edit unsavable.
 */
export const providerIdSchema = z
  .string()
  .regex(PROVIDER_ID_PATTERN, "must be a lowercase provider id");

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

/**
 * One target, for any provider this installation might have.
 *
 * **Was a two-armed discriminated union**, and the arms were hand-written on the
 * argument that deriving them "widens the arm's inferred `provider` back to
 * `ProviderId` and costs the exhaustiveness the union exists for". That argument
 * died when `ProviderId` became a validated string: there is no longer a closed
 * set to be exhaustive over, so the union was buying nothing and costing two
 * things.
 *
 * The first was correctness. A provider loaded from `<root>/plugins/` has an id
 * no five-member enum contains, so `PUT /api/models/:id` and `omni models put -f`
 * refused every target naming one — a plugin could supply a provider that
 * routing, pricing and the console all knew about and that no operator could
 * configure. That is what this change fixes, and it is why the plugin capability
 * is not shippable without it.
 *
 * The second was duplication. Forty lines were repeated across the two arms, and
 * the repository already records what that cost: "the block is duplicated and
 * the custom arm went untested once".
 *
 * What the union actually enforced is kept, as the rule it always was: a custom
 * target carries an `endpointId`, and nothing else does. Losing that would let a
 * custom target save with no endpoint, which no account can be matched to — it
 * would then fail every request at routing rather than at the point it was
 * named.
 */
const targetSchema = z
  .object({
    provider: providerIdSchema,
    // Optional here and required by the rule below, because a schema cannot
    // condition one field's presence on another's value without leaving the
    // object shape open first.
    endpointId: z.string().trim().min(1).optional(),
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
    // Pins this target to one account. Absent means any credential of the
    // provider; there is deliberately no check that the id names a live
    // credential, matching the rule that removing an account must not make an
    // unrelated edit unsavable. An empty string is refused because it is not
    // a third state — it is an id nothing can ever match.
    //
    // Bounded and charset-limited because a pin that matches nothing is
    // reported as `pin:missing` carrying this string, and that row reaches
    // `LogFields.credentialId` and `request_logs.degradations`. Unvalidated,
    // it would be the one operator free-text field on a closed allowlist
    // whose own documentation calls it a bounded identifier. Credential ids
    // are `crypto.randomUUID()`, so nothing legitimate comes close to either
    // bound; the format itself is deliberately not enforced, since pinning
    // the schema to today's id generator would make every stored pin
    // unreadable if it ever changed.
    //
    // One copy now rather than two. The two arms carried identical blocks and
    // the custom one went untested once.
    credentialId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "credentialId must be an account id")
      .optional(),
    capabilities: z.object({
      tools: z.boolean(),
      images: z.boolean(),
      reasoning: z.boolean(),
    }),
  })
  .strict()
  .refine((t) => t.provider !== "custom" || t.endpointId !== undefined, {
    message: "custom targets require an endpointId",
    path: ["endpointId"],
  })
  .refine((t) => t.provider === "custom" || t.endpointId === undefined, {
    message: "endpointId is only meaningful for a custom target",
    path: ["endpointId"],
  });

export const modelSchema = z.object({
  id: z.string().min(1),
  strategy: z.enum(["score", "priority", "roundRobin", "weighted"]),
  isAlias: z.boolean(),
  targets: z.array(targetSchema).min(1, "a virtual model needs at least one target"),
});

export const keyCreateSchema = z
  .object({
    label: z.string().min(1).default("api key"),
    /** Null means every configured model. An empty array would mean none. */
    modelAllowlist: z.array(z.string().min(1)).nullable().default(null),
    /**
     * The sparse `(dimension, window)` matrix. `{}` is unlimited.
     *
     * Strict all the way down, so an unknown dimension or window name is
     * refused here rather than stored and later read as no limit at all.
     */
    limits: limitConfigSchema.default({}),
    /**
     * Suppresses body capture for this key whatever the settings say.
     *
     * Defaulted rather than required so every existing caller keeps working,
     * and defaulted to `false` because the installation-wide setting it defers
     * to is itself off by default: a key that says nothing inherits the
     * installation's policy rather than opting itself out of one it has not met.
     */
    bodyLoggingOptOut: z.boolean().default(false),
  })
  .strict();

/**
 * One of the two parts of a key that may be edited after it is minted — the
 * matrix here, the model allowlist in `keyModelsSchema` below.
 *
 * Sent whole rather than as a patch: `limits` is one JSON document, `{}` is a
 * meaningful value, and a partial body would have to distinguish "leave this
 * pair alone" from "clear it" in a shape where absent and null already both
 * mean unlimited. A caller that wants to change one pair reads the matrix,
 * edits it, and sends it back.
 *
 * `bodyLoggingOptOut` is deliberately not here. An opt-out is a promise to
 * whoever holds the key and must not be revocable behind their back; a limit is
 * the operator's own ceiling on their own installation.
 */
export const keyLimitsSchema = z.object({ limits: limitConfigSchema }).strict();

/**
 * The other part of a key that may be edited after it is minted.
 *
 * Sent whole rather than as a patch, for the same reason the matrix is:
 * `null` (every model) and `[]` (none) are both meaningful values, so a
 * partial body would have to distinguish "leave this alone" from each of them
 * in a shape where absent already means something. A caller that wants to add
 * one model reads the summary and sends the array back.
 *
 * Deliberately not defaulted, unlike at creation: an edit that forgot the field
 * must fail loudly rather than pick one of the two opposite facts for itself.
 */
export const keyModelsSchema = z
  .object({
    /** Null means every configured model; an empty array denies all of them. */
    modelAllowlist: z.array(z.string().min(1)).nullable(),
  })
  .strict();

/**
 * How many database snapshots to keep, and for how long.
 *
 * Both bounds are floored at one. Keeping zero snapshots deletes the undo for
 * the operation that just took it, and an age of zero days expires a snapshot
 * the moment it is written; neither is a policy an operator means to set.
 */
export const retentionSchema = z
  .object({
    keepLatest: z.number().int().min(1).max(100),
    maxAgeDays: z.number().int().min(1).max(3_650),
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
  /** Adds a cache breakpoint to Anthropic requests that arrive carrying none. */
  autoCacheEnabled: z.boolean(),
  /**
   * One half of the capture contract. `OMNI_BODY_LOGGING_ALLOWED` is the other,
   * and it is read at boot, so nothing this schema accepts can start recording
   * prompts on an installation whose environment does not permit it.
   */
  bodyLoggingEnabled: z.boolean(),
  /** Raw SSE frames per attempt. Gated apart because it is far the largest. */
  bodyLoggingCaptureStreamChunks: z.boolean(),
  /**
   * The one pair of settings fields that may be omitted.
   *
   * Retention is edited from the database panel through its own operation, so a
   * settings save from a client that has never heard of it carries neither
   * field. Required, they would make every such save a `BAD_REQUEST`; defaulted,
   * they would quietly reset an operator's policy on every unrelated save. Absent
   * means "not mentioned", and `putSettings` merges rather than replaces.
   */
  snapshotKeepLatest: retentionSchema.shape.keepLatest.optional(),
  snapshotMaxAgeDays: retentionSchema.shape.maxAgeDays.optional(),
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
