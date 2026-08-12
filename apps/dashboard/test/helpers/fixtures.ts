import type {
  ApiKeySummary,
  Credential,
  CredentialHealth,
  DryRunResult,
  QuotaWindow,
  RequestLog,
  Settings,
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
};

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
