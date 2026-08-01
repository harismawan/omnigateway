import type {
  CredentialHealth,
  CredentialView,
  QuotaWindow,
  Settings,
  Target,
  VirtualModel,
} from "@omni/store";
import { DEFAULT_SETTINGS } from "@omni/store";
import { healthKey } from "../../src/router/snapshot.ts";
import type { Snapshot } from "../../src/router/types.ts";

let seq = 0;

/**
 * Secrets are synthetic. No test in this repo carries a real token, and the
 * thunk records whether ranking touched it.
 */
export function credential(overrides: Partial<CredentialView> = {}): CredentialView {
  const id = overrides.id ?? `cred-${++seq}`;
  return {
    id,
    provider: "anthropic",
    label: id,
    authType: "oauth",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    hasRefreshToken: true,
    createdAt: 0,
    updatedAt: 0,
    secrets: async () => ({
      accessToken: `test-token-${id}`,
      refreshToken: `test-refresh-${id}`,
      apiKey: null,
      idToken: null,
    }),
    ...overrides,
  };
}

export function target(overrides: Partial<Target> = {}): Target {
  return {
    provider: "anthropic",
    model: "claude-opus-4",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 15, output: 75 },
    capabilities: { tools: true, images: true, reasoning: true },
    ...overrides,
  };
}

export function health(overrides: Partial<CredentialHealth> = {}): CredentialHealth {
  return {
    credentialId: "cred-1",
    model: "claude-opus-4",
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: null,
    lastUsedAt: null,
    ...overrides,
  };
}

export function quota(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    credentialId: "cred-1",
    windowType: "fiveHour",
    startsAt: 0,
    used: 0,
    limit: null,
    ...overrides,
  };
}

export function snapshot(parts: {
  credentials?: CredentialView[];
  health?: CredentialHealth[];
  quota?: QuotaWindow[];
  models?: VirtualModel[];
  settings?: Partial<Settings>;
  builtAt?: number;
}): Snapshot {
  const quotaMap = new Map<string, QuotaWindow[]>();
  for (const row of parts.quota ?? []) {
    const list = quotaMap.get(row.credentialId);
    if (list === undefined) quotaMap.set(row.credentialId, [row]);
    else list.push(row);
  }

  return {
    credentials: parts.credentials ?? [],
    health: new Map((parts.health ?? []).map((h) => [healthKey(h.credentialId, h.model), h])),
    quota: quotaMap,
    models: new Map((parts.models ?? []).map((m) => [m.id, m])),
    settings: {
      ...DEFAULT_SETTINGS,
      ...parts.settings,
      weights: { ...DEFAULT_SETTINGS.weights, ...parts.settings?.weights },
    },
    builtAt: parts.builtAt ?? 1_000_000,
  };
}
