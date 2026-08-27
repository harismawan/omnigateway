import type {
  ApiKeySummary,
  BodyArtifact,
  BurnEstimate,
  CatalogProvider,
  Credential,
  CredentialHealth,
  DatabaseOverview,
  DryRunResult,
  LifecycleCapability,
  LimitConfig,
  LimitReading,
  QuotaSample,
  QuotaWindow,
  RequestBodyResponse,
  RequestLog,
  Settings,
  SnapshotInfo,
  UsageBucket,
  VirtualModel,
} from "../../src/api/types.ts";

/** A fixed clock, so relative timestamps in assertions never drift. */
export const NOW = 1_800_000_000_000;

export function credential(patch: Partial<Credential> = {}): Credential {
  return {
    id: "cred-1",
    provider: "anthropic",
    label: "claude-main",
    authType: "oauth",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: NOW + 3_600_000,
    accountEmail: "ops@example.com",
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    hasRefreshToken: true,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW,
    ...patch,
  };
}

export function health(patch: Partial<CredentialHealth> = {}): CredentialHealth {
  return {
    credentialId: "cred-1",
    model: "claude-opus-5",
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: 210,
    lastUsedAt: NOW - 30_000,
    ...patch,
  };
}

export function quota(patch: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    credentialId: "cred-1",
    windowType: "fiveHour",
    startsAt: NOW - 3_600_000,
    used: 500,
    limit: 1_000,
    resetsAt: NOW + 3_600_000,
    observedAt: NOW - 60_000,
    windowMs: null,
    ...patch,
  };
}

/** A window that runs out before it resets, which is the case worth naming. */
export function burn(patch: Partial<BurnEstimate> = {}): BurnEstimate {
  return {
    credentialId: "cred-1",
    windowType: "fiveHour",
    windowStartsAt: NOW - 3_600_000,
    ratePerHour: 500,
    exhaustsAt: NOW + 1_800_000,
    survives: false,
    stale: false,
    ...patch,
  };
}

export function quotaSample(patch: Partial<QuotaSample> = {}): QuotaSample {
  return {
    credentialId: "cred-1",
    windowType: "fiveHour",
    observedAt: NOW - 3_000_000,
    used: 100,
    limit: 1_000,
    resetsAt: NOW + 3_600_000,
    windowMs: null,
    ...patch,
  };
}

export function model(patch: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id: "fast",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
        capabilities: { tools: true, images: true, reasoning: false },
      },
    ],
    ...patch,
  };
}

/**
 * A key as `/api/keys` returns it.
 *
 * `limitUsage` follows whatever `limits` ends up being, so a patch that sets a
 * ceiling gets a reading for it without every caller restating the matrix
 * twice. Patch it directly to say what has been used against one.
 */
export function apiKey(patch: Partial<ApiKeySummary> = {}): ApiKeySummary {
  const limits = patch.limits === undefined ? { requests: { "1m": 120 } } : patch.limits;
  return {
    id: "key-1",
    label: "laptop",
    prefix: "omni_sk_a1b2",
    modelAllowlist: null,
    limits,
    limitUsage: readingsFor(limits),
    bodyLoggingOptOut: false,
    createdAt: NOW - 86_400_000,
    revokedAt: null,
    ...patch,
  };
}

/** One idle reading per configured ceiling, in the order the route emits them. */
function readingsFor(limits: LimitConfig | null): LimitReading[] {
  if (limits === null) return [];
  const readings: LimitReading[] = [];
  for (const dimension of ["requests", "tokens", "spend"] as const) {
    const windows = limits[dimension];
    if (windows === undefined) continue;
    for (const window of ["1m", "5h", "1w"] as const) {
      const limit: number | null | undefined = windows[window as keyof typeof windows];
      if (limit === undefined || limit === null) continue;
      readings.push({ dimension, window, limit, used: 0 });
    }
  }
  if (limits.concurrency !== undefined && limits.concurrency !== null) {
    readings.push({
      dimension: "concurrency",
      window: null,
      limit: limits.concurrency,
      used: null,
    });
  }
  return readings;
}

export function log(patch: Partial<RequestLog> = {}): RequestLog {
  return {
    id: "req-1",
    state: "done",
    at: NOW - 60_000,
    apiKeyId: "key-1",
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-haiku-4-5",
    credentialId: "cred-1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: 240,
    durationMs: 1_400,
    costUsd: 0.012,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
    ...patch,
  };
}

export function usageBucket(patch: Partial<UsageBucket> = {}): UsageBucket {
  return {
    key: "cred-1",
    requests: 42,
    inputTokens: 120_000,
    outputTokens: 30_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    rtkSavedTokens: 0,
    rtkAppliedRequests: 0,
    costUsd: 3.5,
    errors: 2,
    durationMsSum: 42_000,
    ...patch,
  };
}

export const settings: Settings = {
  weights: { tier: 10, health: 3, quota: 2, load: 2, cost: 1, latency: 1 },
  maxAttempts: 3,
  requestDeadlineMs: 120_000,
  breakerThreshold: 3,
  breakerCooldownMs: 30_000,
  logRetentionDays: 30,
  quotaPollIntervalMs: 300_000,
  rtkEnabled: false,
  autoCacheEnabled: true,
  bodyLoggingEnabled: false,
  bodyLoggingCaptureStreamChunks: false,
  snapshotKeepLatest: 5,
  snapshotMaxAgeDays: 30,
};

/**
 * One captured artifact, with the pre/post-RTK difference actually present.
 *
 * The client request holds an uncompressed tool result and the attempt request
 * holds the compressed one, because that is the pair the console has to keep
 * distinguishable — a fixture where both sides matched would let a UI that
 * mislabels them pass.
 */
export function bodyArtifact(patch: Partial<BodyArtifact> = {}): BodyArtifact {
  return {
    schemaVersion: 1,
    requestId: "req-1",
    at: NOW - 60_000,
    client: {
      request: { model: "fast", messages: [{ role: "user", content: "FULL-TOOL-RESULT" }] },
      response: { id: "msg_1", content: "hello" },
      truncated: false,
    },
    attempts: [
      {
        attempt: 1,
        provider: "anthropic",
        request: { model: "claude-haiku-4-5", messages: [{ role: "user", content: "SQUEEZED" }] },
        response: { id: "msg_1", content: "hello" },
        streamChunks: null,
        truncated: false,
      },
    ],
    error: null,
    ...patch,
  };
}

export function requestBody(patch: Partial<RequestBodyResponse> = {}): RequestBodyResponse {
  return {
    requestId: "req-1",
    detailState: "ready",
    truncated: false,
    sizeBytes: 2_048,
    at: NOW - 60_000,
    artifact: bodyArtifact(),
    ...patch,
  };
}

export const dryRunResult: DryRunResult = {
  modelId: "fast",
  strategy: "score",
  deterministic: true,
  rankedAt: NOW,
  candidates: [
    {
      credentialId: "cred-1",
      credentialLabel: "claude-main",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tier: 1,
      score: 13.5,
      reasons: { tier: 1, health: 1, quota: 0.5, cost: 0.2, latency: 0.8, load: 0.4 },
    },
  ],
  excluded: [{ credentialId: "cred-2", model: "gpt-5.6", reason: "breaker:open" }],
};

/**
 * One snapshot file, as `GET /api/database/snapshots` lists it.
 *
 * The id is the filename, which is what the routes take as `:id` — a fixture
 * that gave them different values would let a board that sends the wrong one
 * pass.
 */
export function snapshot(patch: Partial<SnapshotInfo> = {}): SnapshotInfo {
  const id = patch.id ?? "db_2027-01-15T09-00-00-000Z_manual.sqlite";
  return {
    id,
    filename: id,
    createdAt: NOW - 3_600_000,
    sizeBytes: 10_485_760,
    reason: "manual",
    ...patch,
  };
}

/**
 * A database a quarter of which is free pages.
 *
 * The page geometry and the byte figures agree with each other: 3072 pages of
 * 4 KiB is the 12 MiB on disk, and the 768 free ones are the 3 MiB a vacuum
 * would reclaim. A fixture whose numbers did not multiply out would hide a
 * panel that divided the wrong pair.
 */
export function databaseOverview(patch: Partial<DatabaseOverview> = {}): DatabaseOverview {
  return {
    stats: { pageSize: 4096, pageCount: 3072, freelistCount: 768, schemaVersion: 14 },
    fileBytes: 12_582_912,
    walBytes: 1_048_576,
    bodiesBytes: 52_428_800,
    logicalBytes: 12_582_912,
    freePageBytes: 3_145_728,
    freeDiskBytes: 10_737_418_240,
    retention: { keepLatest: 5, maxAgeDays: 30 },
    snapshots: { count: 1, totalBytes: 10_485_760, latestAt: NOW - 3_600_000 },
    ...patch,
  };
}

/** systemd by default: the shape where both controls are real. */
export function lifecycle(patch: Partial<LifecycleCapability> = {}): LifecycleCapability {
  return { supervisor: "systemd", canRestart: true, canShutdown: true, ...patch };
}

/**
 * The provider catalog as `/api/catalog` sends it: **not** in display order.
 *
 * Hand-written rather than imported from `@omni/providers`. The console reads
 * this over `/api/catalog` now, and a fixture is what keeps a price edit in
 * `kilo/models.ts` from failing a test about draft state — the assertions state
 * their own numbers and this states the numbers they assert.
 *
 * Small on purpose: two or three models per provider, chosen for the shapes the
 * console has to handle rather than for coverage of the real list. What it does
 * keep faithful is the *structure* — a provider with no models at all
 * (`custom`), one whose catalog splits by way in (`kilo`), one whose window
 * narrows through OAuth (`openai`), and a `pasteHint` and `callback` where the
 * real descriptors carry them.
 *
 * And, deliberately, the *disorder*. The endpoint sends `order` rather than a
 * sorted array — wire order is not a contract — so a fixture already in
 * ascending `order` makes "sorted" and "unsorted" the same array, and no test
 * written against it can tell a console that sorts from one that does not. That
 * is what let the sort in `api/queries.ts` be deleted with 484 tests still
 * green. Every screen wants `catalogFixture()`, which is this run through the
 * rule; this one is for the code that has to apply that rule.
 */
export function wireCatalogFixture(): CatalogProvider[] {
  return [
    {
      id: "kilo",
      label: "Kilo",
      order: 4,
      colour: { light: "oklch(0.52 0.14 224)", dark: "oklch(0.74 0.14 224)" },
      pasteHint: "Approve the code on Kilo's device page. This dialog finishes on its own.",
      defaultModel: "anthropic/claude-sonnet-5",
      authTypes: ["oauth", "apiKey"],
      models: [
        {
          id: "anthropic/claude-sonnet-5",
          label: "Claude Sonnet 5",
          pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
          limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
        },
        {
          // Gateway-only: a subscription token cannot reach the auto routers.
          id: "kilo-auto/frontier",
          label: "Kilo Auto — frontier",
          pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
          limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
          auth: ["apiKey"],
        },
        {
          id: "cohere/north-mini-code:free",
          label: "North Mini Code — free",
          pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          limits: { contextWindow: 256_000, maxOutputTokens: 64_000 },
          auth: ["apiKey"],
        },
      ],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      order: 1,
      colour: { light: "oklch(0.56 0.13 45)", dark: "oklch(0.74 0.12 48)" },
      pasteHint: "Authorize in the browser, then paste the code Anthropic shows you.",
      defaultModel: "claude-opus-5",
      authTypes: ["oauth", "apiKey"],
      models: [
        {
          id: "claude-opus-5",
          label: "Claude Opus 5",
          pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
          limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
        },
        {
          id: "claude-haiku-4-5",
          label: "Claude Haiku 4.5",
          pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
          limits: { contextWindow: 200_000, maxOutputTokens: 64_000 },
        },
      ],
    },
    {
      // No catalog and one way in: what an operator's own endpoint looks like.
      id: "custom",
      label: "OpenAI Compatible",
      order: 6,
      colour: { light: "oklch(0.5 0.03 258)", dark: "oklch(0.72 0.03 258)" },
      pasteHint: "Enter endpoint metadata and API key.",
      defaultModel: "",
      authTypes: ["apiKey"],
      models: [],
    },
    {
      id: "openai",
      label: "OpenAI",
      order: 2,
      colour: { light: "oklch(0.5 0.09 190)", dark: "oklch(0.76 0.1 190)" },
      pasteHint: "Authorize in the browser. When it redirects to localhost, paste the whole URL.",
      callback: { uri: "http://localhost:1455/auth/callback", label: "OpenAI" },
      defaultModel: "gpt-5.6",
      authTypes: ["oauth", "apiKey"],
      models: [
        {
          id: "gpt-5.6",
          label: "GPT-5.6",
          pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
          limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
          oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
        },
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol — deepest reasoning",
          pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
          limits: { contextWindow: 922_000, maxOutputTokens: 128_000 },
          oauthLimits: { contextWindow: 272_000, maxOutputTokens: 128_000 },
        },
      ],
    },
    {
      id: "grok",
      label: "Grok",
      order: 5,
      colour: { light: "oklch(0.52 0.14 125)", dark: "oklch(0.74 0.14 125)" },
      pasteHint: "Authorize in the browser. When it redirects to 127.0.0.1, paste the whole URL.",
      callback: { uri: "http://127.0.0.1:56121/callback", label: "Grok" },
      defaultModel: "grok-4.6",
      authTypes: ["oauth", "apiKey"],
      models: [
        {
          id: "grok-4.6",
          label: "Grok 4.6",
          pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
          limits: { contextWindow: 2_000_000, maxOutputTokens: 128_000 },
        },
      ],
    },
    {
      id: "kimi",
      label: "Kimi",
      order: 3,
      colour: { light: "oklch(0.53 0.17 330)", dark: "oklch(0.72 0.16 330)" },
      pasteHint: "Enter the code on Kimi's device page. This dialog finishes on its own.",
      defaultModel: "k3-256k",
      authTypes: ["oauth", "apiKey"],
      models: [
        {
          id: "k3-256k",
          label: "Kimi K3 — 256K",
          pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 0, cacheWrite1h: 0 },
          limits: { contextWindow: 262_144, maxOutputTokens: 131_072 },
        },
      ],
    },
  ];
}

/**
 * The same catalog in the order the console must draw it.
 *
 * What every screen holds: `_app`'s gate resolves `catalogQuery`, which sorts
 * once, and each board then walks the array it was given. Seeded into the test
 * client by `makeQueryClient`, so a board test starts where production starts.
 *
 * The comparison is restated here rather than imported from `api/queries.ts` on
 * purpose. If this helper called the production sort, reversing that sort would
 * reverse the seed too and every board assertion would keep passing against a
 * console drawing providers backwards — the expectation has to be stated
 * independently of the thing it judges.
 */
export function catalogFixture(): CatalogProvider[] {
  return [...wireCatalogFixture()].sort((a, b) => a.order - b.order);
}
