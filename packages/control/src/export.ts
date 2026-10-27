import { GatewayError } from "@omni/ir";
import {
  type ExportDestination,
  type ExportDestinationPatch,
  type ExportDestinationType,
  type ExportFilter,
  ExportLimitError,
  MAX_EXPORT_DESTINATIONS,
  type Store,
} from "@omni/store";
import { z } from "zod";
import { DEFAULT_INDEX_PATTERN, expandIndexPattern, indexNameProblem } from "./exportIndex.ts";
import { parseOrThrow } from "./schemas.ts";
import { basePathOf, checkServerUrl } from "./serverUrl.ts";

/**
 * Export destinations as an operator configures them: what each type's config
 * and secret may hold, and the operations the admin API and the CLI share.
 *
 * Every write is validated here, whole, before it reaches the store, which
 * stores `config` as given. Every read returns a summary carrying `hasSecret`,
 * never the secret: only the export worker opens it, through the store.
 */

/**
 * The encoded-request limit a destination takes when its `maxRequestBytes` is
 * null: Elasticsearch 90 MiB (under its 100 MB `http.max_content_length`),
 * webhook 50 MiB, OTLP 4 MiB.
 */
export const DEFAULT_MAX_REQUEST_BYTES: Readonly<Record<ExportDestinationType, number>> = {
  elasticsearch: 90 * 1024 * 1024,
  webhook: 50 * 1024 * 1024,
  otlp: 4 * 1024 * 1024,
};

/** A slug, `[a-z0-9-]{1,40}`. */
export const destinationIdSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/, "must be 1-40 characters of a-z, 0-9 and -");

const MAX_FILTER_ENTRIES = 100;

/**
 * Which completed rows a destination selects. Strict and bounded: a filter is
 * the scope of what leaves the installation, so a misspelled field must be
 * refused rather than read as "no filter". An empty list is kept as itself —
 * it selects nothing, which is something an operator can mean.
 */
export const exportFilterSchema = z
  .object({
    apiKeyIds: z.array(z.string().min(1).max(128)).max(MAX_FILTER_ENTRIES).optional(),
    models: z.array(z.string().min(1).max(256)).max(MAX_FILTER_ENTRIES).optional(),
    failedOnly: z.boolean().optional(),
  })
  .strict();

type ParsedFilter = z.infer<typeof exportFilterSchema>;

/** The store's filter from a parsed one: present fields only, nothing widened or coerced. */
function toFilter(f: ParsedFilter): ExportFilter {
  return {
    ...(f.apiKeyIds === undefined ? {} : { apiKeyIds: f.apiKeyIds }),
    ...(f.models === undefined ? {} : { models: f.models }),
    ...(f.failedOnly === undefined ? {} : { failedOnly: f.failedOnly }),
  };
}

const maxRequestBytesSchema = z.number().int().positive();

/**
 * An outbound base URL, by the custom-provider endpoint rule. Normalised to
 * origin plus base path with trailing slashes collapsed, because the worker
 * appends a path (`/_bulk`, `/v1/logs`) to it.
 */
const baseUrlSchema = z
  .string()
  .max(2048)
  .transform((input, ctx) => {
    const checked = checkServerUrl(input);
    if ("problem" in checked) {
      ctx.addIssue({
        code: "custom",
        message:
          checked.problem === "unparseable"
            ? "must be a valid URL"
            : "must be an http(s) URL with no credentials, query or fragment",
      });
      return z.NEVER;
    }
    return `${checked.url.origin}${basePathOf(checked.url)}`;
  });

/**
 * A webhook URL, by the same rule, but kept as the operator wrote it (in its
 * canonical form): it is posted to as is, so its path — a trailing slash
 * included — is the receiver's, not ours to rewrite.
 */
const exactUrlSchema = z
  .string()
  .max(2048)
  .transform((input, ctx) => {
    const checked = checkServerUrl(input);
    if ("problem" in checked) {
      ctx.addIssue({
        code: "custom",
        message:
          checked.problem === "unparseable"
            ? "must be a valid URL"
            : "must be an http(s) URL with no credentials, query or fragment",
      });
      return z.NEVER;
    }
    return checked.url.href;
  });

/** RFC 9110 `token`. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;
/** Tab, visible ASCII, and Latin-1 — what `fetch` accepts; never CR, LF or NUL. */
const HEADER_VALUE = /^[\t\x20-\x7E\x80-\xFF]*$/;
const MAX_HEADERS = 32;

/**
 * Names the worker sets itself, or that framing owns. A configured one would
 * either be overwritten silently or corrupt the request; the signature pair in
 * particular must never be forgeable from configuration.
 */
const RESERVED_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
  "x-omni-signature",
  "x-omni-timestamp",
]);

const headersSchema = z
  .record(
    z.string().regex(HEADER_NAME, "must be a header name"),
    z.string().max(8192).regex(HEADER_VALUE, "must not contain control characters"),
  )
  .superRefine((headers, ctx) => {
    const names = Object.keys(headers);
    if (names.length > MAX_HEADERS) {
      ctx.addIssue({ code: "custom", message: `at most ${MAX_HEADERS} headers` });
    }
    const seen = new Set<string>();
    for (const name of names) {
      const lower = name.toLowerCase();
      if (RESERVED_HEADERS.has(lower)) {
        ctx.addIssue({ code: "custom", path: [name], message: "is set by the gateway" });
      } else if (seen.has(lower)) {
        ctx.addIssue({ code: "custom", path: [name], message: "is given twice" });
      }
      seen.add(lower);
    }
  });

/** An index pattern's expansion is the same length for every day; any sample judges it. */
const SAMPLE_DAY = Date.UTC(2026, 0, 1);

const indexPatternSchema = z
  .string()
  .max(512)
  .superRefine((pattern, ctx) => {
    const problem = indexNameProblem(expandIndexPattern(pattern, SAMPLE_DAY));
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

export const elasticsearchConfigSchema = z
  .object({
    url: baseUrlSchema,
    index: indexPatternSchema.default(DEFAULT_INDEX_PATTERN),
    bodyIndex: indexPatternSchema.default("omni-bodies-{yyyy.MM.dd}"),
    auth: z.enum(["apiKey", "basic", "none"]),
    flavor: z.enum(["elasticsearch", "opensearch"]).default("elasticsearch"),
  })
  .strict();

export const webhookConfigSchema = z
  .object({
    url: exactUrlSchema,
    /** Non-secret headers, shown back to readers. Secret ones go in the secret. */
    headers: headersSchema.default({}),
  })
  .strict();

export const otlpConfigSchema = z
  .object({
    /** Base; the worker appends `/v1/logs` or `/v1/traces`. */
    endpoint: baseUrlSchema,
    signal: z.enum(["logs", "traces"]),
  })
  .strict();

export type ElasticsearchConfig = z.infer<typeof elasticsearchConfigSchema>;
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type OtlpConfig = z.infer<typeof otlpConfigSchema>;

const secretText = (max: number) => z.string().min(1).max(max);

/** The credential each Elasticsearch `auth` mode carries; `none` carries no secret. */
export const elasticsearchSecretSchemas = {
  apiKey: z.object({ apiKey: secretText(4096) }).strict(),
  basic: z
    .object({
      // RFC 7617: the user-id cannot contain a colon.
      username: secretText(256).regex(/^[^:]*$/, "must not contain :"),
      password: secretText(1024),
    })
    .strict(),
} as const;

const elasticsearchSecretSchema = z.union([
  elasticsearchSecretSchemas.apiKey,
  elasticsearchSecretSchemas.basic,
]);

/** Secret headers and/or a signing secret; at least one, or there is no secret to keep. */
export const webhookSecretSchema = z
  .object({
    headers: headersSchema.optional(),
    signingSecret: secretText(1024).optional(),
  })
  .strict()
  .refine((s) => Object.keys(s.headers ?? {}).length > 0 || s.signingSecret !== undefined, {
    message: "needs headers or a signingSecret",
  });

export const otlpSecretSchema = z
  .object({
    headers: headersSchema.refine((h) => Object.keys(h).length > 0, "needs at least one header"),
  })
  .strict();

/**
 * A secret as a write carries it: the object itself, or its JSON text — the
 * store contract is "a string sets", so a caller holding the serialised form
 * passes it as is. Text is parsed here and then held to the same strict schema.
 * Unparseable text is refused with a fixed message: the parser's own error can
 * quote the input, and the input is a credential.
 */
function secretInput<T>(schema: z.ZodType<T>) {
  return z
    .unknown()
    .transform((value, ctx): unknown => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "must be a JSON object" });
        return z.NEVER;
      }
    })
    .pipe(schema);
}

export type ElasticsearchSecret = z.infer<typeof elasticsearchSecretSchema>;
export type WebhookSecret = z.infer<typeof webhookSecretSchema>;
export type OtlpSecret = z.infer<typeof otlpSecretSchema>;

const common = {
  id: destinationIdSchema,
  /** `afterExisting` is the store's, for copying into a new store; no operator asks for it. */
  startFrom: z.enum(["now", "oldest"]),
  filter: exportFilterSchema.optional(),
  enabled: z.boolean().optional(),
  maxRequestBytes: maxRequestBytesSchema.nullable().optional(),
};

const createSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...common,
      type: z.literal("elasticsearch"),
      config: elasticsearchConfigSchema,
      secret: secretInput(elasticsearchSecretSchema).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("webhook"),
      config: webhookConfigSchema,
      secret: secretInput(webhookSecretSchema).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("otlp"),
      config: otlpConfigSchema,
      secret: secretInput(otlpSecretSchema).optional(),
    })
    .strict(),
]);

const patchCommon = {
  filter: exportFilterSchema.optional(),
  enabled: z.boolean().optional(),
  maxRequestBytes: maxRequestBytesSchema.nullable().optional(),
};

/**
 * An edit, per stored type. `config` is written whole when present; `secret`
 * is written whole when present, `null` clears it, absent keeps it. `id`,
 * `type` and `startFrom` are fixed at creation, and bodies have their own
 * operation, so none of them is accepted here.
 */
const patchSchemas = {
  elasticsearch: z
    .object({
      ...patchCommon,
      config: elasticsearchConfigSchema.optional(),
      secret: secretInput(elasticsearchSecretSchema).nullable().optional(),
    })
    .strict(),
  webhook: z
    .object({
      ...patchCommon,
      config: webhookConfigSchema.optional(),
      secret: secretInput(webhookSecretSchema).nullable().optional(),
    })
    .strict(),
  otlp: z
    .object({
      ...patchCommon,
      config: otlpConfigSchema.optional(),
      secret: secretInput(otlpSecretSchema).nullable().optional(),
    })
    .strict(),
} as const;

const bodiesSchema = z.object({ include: z.boolean() }).strict();

/**
 * A destination as any reader may see it: never the secret, only whether one
 * is set. `revision` is the export worker's change signal and stays off the
 * wire; `updatedAt` is what a reader is shown.
 */
export type DestinationSummary = Omit<ExportDestination, "revision">;

function summarize(d: ExportDestination): DestinationSummary {
  return {
    id: d.id,
    generation: d.generation,
    type: d.type,
    enabled: d.enabled,
    config: d.config,
    filter: d.filter,
    filterMalformed: d.filterMalformed,
    includeBodies: d.includeBodies,
    maxRequestBytes: d.maxRequestBytes,
    startAt: d.startAt,
    hasSecret: d.hasSecret,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

const bad = (message: string): GatewayError => new GatewayError("BAD_REQUEST", message);

const NO_SUCH = "no such export destination";
const TRACES_BODIES = "OTLP traces destinations cannot export bodies";

async function existing(store: Store, id: string): Promise<ExportDestination> {
  const destination = await store.exportDestinations.get(id);
  if (destination === null) throw bad(NO_SUCH);
  return destination;
}

/**
 * Whether the Elasticsearch credential matches its `auth` mode: `none` has no
 * secret, `apiKey` and `basic` have one of their own shape. `secret` is the
 * one being written, or `"kept"` for the stored one, which matches only the
 * mode it was written for.
 */
function checkElasticsearchSecret(
  auth: ElasticsearchConfig["auth"],
  secret: ElasticsearchSecret | null | "kept",
  stored: { auth: ElasticsearchConfig["auth"] | null; hasSecret: boolean },
): void {
  if (auth === "none") {
    const none = secret === null || (secret === "kept" && !stored.hasSecret);
    if (!none) throw bad('secret: auth "none" carries no secret; clear it with null');
    return;
  }
  if (secret === "kept") {
    if (stored.hasSecret && stored.auth === auth) return;
    throw bad(`secret: auth "${auth}" needs its credential in the secret`);
  }
  const matches =
    secret !== null && (auth === "apiKey" ? "apiKey" in secret : "username" in secret);
  if (!matches) throw bad(`secret: auth "${auth}" needs its credential in the secret`);
}

/** A header a webhook sends both plainly and secretly would be sent twice or lost. */
function checkWebhookHeaders(config: WebhookConfig, secret: WebhookSecret): void {
  const plain = new Set(Object.keys(config.headers).map((name) => name.toLowerCase()));
  for (const name of Object.keys(secret.headers ?? {})) {
    if (plain.has(name.toLowerCase())) {
      throw bad(`secret.headers.${name}: is also a plain header`);
    }
  }
}

/**
 * The stored webhook secret, or null when none is set or it does not parse —
 * then it holds no header this build could send, so nothing can collide. Read
 * only to compare header names; never returned or quoted.
 */
async function retainedWebhookSecret(store: Store, id: string): Promise<WebhookSecret | null> {
  const text = await store.exportDestinations.openSecret(id);
  if (text === null) return null;
  const result = secretInput(webhookSecretSchema).safeParse(text);
  return result.success ? result.data : null;
}

/** The stored config read through its type's schema, or null when it no longer parses. */
function storedConfig<T>(schema: z.ZodType<T>, d: ExportDestination): T | null {
  const result = schema.safeParse(d.config);
  return result.success ? result.data : null;
}

export async function listDestinations(store: Store): Promise<DestinationSummary[]> {
  return (await store.exportDestinations.list()).map(summarize);
}

export async function getDestination(store: Store, id: string): Promise<DestinationSummary> {
  return summarize(await existing(store, id));
}

/**
 * Creates a destination. `startFrom: "now"` exports only what completes from
 * here on; `"oldest"` everything still retained. Bodies start off and are
 * turned on through {@link setDestinationBodies} alone.
 */
export async function createDestination(store: Store, input: unknown): Promise<DestinationSummary> {
  const body = parseOrThrow(createSchema, input);
  if (body.type === "elasticsearch") {
    checkElasticsearchSecret(body.config.auth, body.secret ?? null, {
      auth: null,
      hasSecret: false,
    });
  }
  if (body.type === "webhook" && body.secret !== undefined) {
    checkWebhookHeaders(body.config, body.secret);
  }

  if ((await store.exportDestinations.get(body.id)) !== null) {
    throw new GatewayError("CONFLICT", `export destination "${body.id}" already exists`);
  }
  try {
    const created = await store.exportDestinations.create({
      id: body.id,
      type: body.type,
      config: body.config,
      startFrom: body.startFrom,
      ...(body.filter === undefined ? {} : { filter: toFilter(body.filter) }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.maxRequestBytes === undefined ? {} : { maxRequestBytes: body.maxRequestBytes }),
      ...(body.secret === undefined ? {} : { secret: JSON.stringify(body.secret) }),
    });
    return summarize(created);
  } catch (error) {
    if (error instanceof ExportLimitError) {
      throw new GatewayError("CONFLICT", `at most ${MAX_EXPORT_DESTINATIONS} export destinations`);
    }
    throw error;
  }
}

/**
 * Edits a destination. `config` and `filter` are written whole; `secret` is
 * written whole when present, cleared by `null`, kept when absent.
 */
export async function updateDestination(
  store: Store,
  id: string,
  input: unknown,
): Promise<DestinationSummary> {
  const current = await existing(store, id);
  const patch = await destinationPatch(store, current, input);
  const updated = await store.exportDestinations.update(id, patch);
  if (updated === null) throw bad(NO_SUCH);
  return summarize(updated);
}

/** Read-only preflight for callers composing a config edit and the separate bodies operation. */
export async function validateDestinationUpdate(
  store: Store,
  id: string,
  input: unknown,
  includeBodies?: boolean,
): Promise<void> {
  const current = await existing(store, id);
  const effective = { ...current, includeBodies: includeBodies ?? current.includeBodies };
  const patch = await destinationPatch(store, effective, input);
  if (
    effective.includeBodies &&
    current.type === "otlp" &&
    (patch.config ?? current.config).signal === "traces"
  )
    throw bad(TRACES_BODIES);
}

async function destinationPatch(
  store: Store,
  current: ExportDestination,
  input: unknown,
): Promise<ExportDestinationPatch> {
  const id = current.id;
  const patch: ExportDestinationPatch = {};

  switch (current.type) {
    case "elasticsearch": {
      const body = parseOrThrow(patchSchemas.elasticsearch, input);
      if (body.config !== undefined || body.secret !== undefined) {
        const stored = storedConfig(elasticsearchConfigSchema, current);
        const config = body.config ?? stored;
        if (config === null) throw bad("config: the stored config is unreadable; send it whole");
        checkElasticsearchSecret(config.auth, body.secret === undefined ? "kept" : body.secret, {
          auth: stored?.auth ?? null,
          hasSecret: current.hasSecret,
        });
      }
      Object.assign(patch, commonPatch(body));
      break;
    }
    case "webhook": {
      const body = parseOrThrow(patchSchemas.webhook, input);
      if (body.secret !== undefined && body.secret !== null) {
        const config = body.config ?? storedConfig(webhookConfigSchema, current);
        if (config !== null) checkWebhookHeaders(config, body.secret);
      } else if (body.secret === undefined && body.config !== undefined && current.hasSecret) {
        // The secret is kept, so the new plain headers are judged against it.
        const retained = await retainedWebhookSecret(store, id);
        if (retained !== null) checkWebhookHeaders(body.config, retained);
      }
      Object.assign(patch, commonPatch(body));
      break;
    }
    case "otlp": {
      const body = parseOrThrow(patchSchemas.otlp, input);
      if (body.config?.signal === "traces" && current.includeBodies) throw bad(TRACES_BODIES);
      Object.assign(patch, commonPatch(body));
      break;
    }
  }

  return patch;
}

/** The store patch from a parsed edit: present fields only, the secret serialised. */
function commonPatch(body: {
  config?: object | undefined;
  filter?: ParsedFilter | undefined;
  enabled?: boolean | undefined;
  maxRequestBytes?: number | null | undefined;
  secret?: object | null | undefined;
}): ExportDestinationPatch {
  return {
    ...(body.config === undefined ? {} : { config: { ...body.config } }),
    ...(body.filter === undefined ? {} : { filter: toFilter(body.filter) }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(body.maxRequestBytes === undefined ? {} : { maxRequestBytes: body.maxRequestBytes }),
    ...(body.secret === undefined
      ? {}
      : { secret: body.secret === null ? null : JSON.stringify(body.secret) }),
  };
}

/**
 * Turns body export on or off. Off is always allowed. On is refused for an
 * OTLP traces destination. Runtime capture and export gates still bind sends.
 */
export async function setDestinationBodies(
  store: Store,
  id: string,
  input: unknown,
): Promise<DestinationSummary> {
  const { include } = parseOrThrow(bodiesSchema, input);
  const current = await existing(store, id);
  if (include) {
    if (current.type === "otlp" && current.config.signal === "traces") throw bad(TRACES_BODIES);
  }
  const updated = await store.exportDestinations.update(id, { includeBodies: include });
  if (updated === null) throw bad(NO_SUCH);
  return summarize(updated);
}

export async function removeDestination(store: Store, id: string): Promise<void> {
  if (!(await store.exportDestinations.remove(id))) throw bad(NO_SUCH);
}
