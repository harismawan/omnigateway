import type {
  CredentialHealth,
  QuotaWindow,
  RequestLog,
  Target,
  UsageBucket,
  VirtualModel,
  WireApiKey,
  WireCredential,
} from "../../src/api/types.ts";

export const NOW = 1_700_000_000_000;

export function credentialFixture(patch: Partial<WireCredential> = {}): WireCredential {
  return {
    id: "c1",
    provider: "anthropic",
    label: "work",
    authType: "oauth",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: NOW + 3_600_000,
    accountEmail: "user@example.com",
    providerData: {},
    hasRefreshToken: true,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    ...patch,
  };
}

export function healthFixture(patch: Partial<CredentialHealth> = {}): CredentialHealth {
  return {
    credentialId: "c1",
    model: "claude-opus-4",
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: 420,
    lastUsedAt: NOW - 60_000,
    ...patch,
  };
}

export function quotaFixture(patch: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    credentialId: "c1",
    windowType: "fiveHour",
    startsAt: NOW - 1_800_000,
    used: 250,
    limit: 1_000,
    ...patch,
  };
}

export function targetFixture(patch: Partial<Target> = {}): Target {
  return {
    provider: "anthropic",
    model: "claude-opus-4",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 15, output: 75 },
    capabilities: { tools: true, images: true, reasoning: true },
    ...patch,
  };
}

export function modelFixture(patch: Partial<VirtualModel> = {}): VirtualModel {
  return {
    id: "fast",
    targets: [targetFixture()],
    strategy: "score",
    isAlias: false,
    ...patch,
  };
}

export function keyFixture(patch: Partial<WireApiKey> = {}): WireApiKey {
  return {
    id: "k1",
    label: "laptop",
    prefix: "omni_sk_abcd",
    modelAllowlist: null,
    rateLimitPerMin: null,
    createdAt: NOW - 86_400_000,
    revokedAt: null,
    ...patch,
  };
}

export function logFixture(patch: Partial<RequestLog> = {}): RequestLog {
  return {
    id: "r1",
    at: NOW - 5_000,
    apiKeyId: "k1",
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 1_200,
    outputTokens: 340,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: 410,
    durationMs: 2_100,
    costUsd: 0.0435,
    degradations: [],
    ...patch,
  };
}

export function bucketFixture(patch: Partial<UsageBucket> = {}): UsageBucket {
  return {
    key: "claude-opus-4",
    requests: 12,
    inputTokens: 14_400,
    outputTokens: 4_080,
    costUsd: 0.52,
    errors: 1,
    ...patch,
  };
}
