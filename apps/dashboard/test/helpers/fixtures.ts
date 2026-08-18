import type {
  ApiKeySummary,
  BodyArtifact,
  BurnEstimate,
  Credential,
  CredentialHealth,
  DatabaseOverview,
  DryRunResult,
  LifecycleCapability,
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

export function apiKey(patch: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "key-1",
    label: "laptop",
    prefix: "omni_sk_a1b2",
    modelAllowlist: null,
    rateLimitPerMin: 120,
    bodyLoggingOptOut: false,
    createdAt: NOW - 86_400_000,
    revokedAt: null,
    ...patch,
  };
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
