import {
  createLogger,
  type LogFields,
  type Logger,
  type LogLevel,
  type ProviderId,
  type StreamEvent,
} from "@omni/ir";
import type { ProviderAdapter } from "@omni/providers";
import { healthKey, type Snapshot } from "@omni/router";
import type {
  ApiKey,
  Credential,
  CredentialHealth,
  CredentialSecrets,
  CredentialView,
  QuotaWindow,
  RequestLog,
  Settings,
  Store,
  Target,
  VirtualModel,
} from "@omni/store";
import { createStore, DEFAULT_SETTINGS, deriveKey, generateApiKey, hashApiKey } from "@omni/store";

let seq = 0;

export type CaptureLogger = Logger & {
  /** Rendered lines, exactly as they would reach stdout. */
  lines: string[];
  /** The same calls unrendered, for assertions that should not pin the format. */
  records: Array<{ level: LogLevel; msg: string; fields: LogFields }>;
};

/**
 * A logger that keeps what it was told instead of writing it.
 *
 * Both views exist on purpose: `lines` is how a leak test checks that no secret
 * reached the output, and `records` is how a behaviour test asserts that a
 * failure was reported at `warn` without caring how a line is formatted.
 */
export function captureLogger(level: LogLevel = "debug"): CaptureLogger {
  const lines: string[] = [];
  const records: Array<{ level: LogLevel; msg: string; fields: LogFields }> = [];
  const write = (line: string): void => {
    lines.push(line);
  };
  const inner = createLogger({ level, write });

  const record =
    (at: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      if (inner.enabled(at)) records.push({ level: at, msg, fields: fields ?? {} });
      inner[at](msg, fields);
    };

  return {
    lines,
    records,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    enabled: inner.enabled,
  };
}

/**
 * Secrets are synthetic. No test in this repo carries a real token, and the
 * thunk records whether ranking touched it.
 */
export function credential(overrides: Partial<CredentialView> = {}): CredentialView {
  const id = overrides.id ?? `cred-${++seq}`;
  const authType = overrides.authType ?? "oauth";
  return {
    id,
    provider: "anthropic",
    label: id,
    authType,
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    hasRefreshToken: true,
    createdAt: 0,
    updatedAt: 0,
    secrets: async () => ({
      accessToken: `test-token-${id}`,
      refreshToken: `test-refresh-${id}`,
      apiKey: null,
      idToken: null,
    }),
    openForInference: async () =>
      authType === "oauth"
        ? { accessToken: `test-token-${id}`, apiKey: null }
        : { accessToken: null, apiKey: `test-key-${id}` },
    openForRefresh: async () => ({ refreshToken: `test-refresh-${id}` }),
    openForUsage: async () => ({ accessToken: `test-token-${id}` }),
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
    resetsAt: null,
    observedAt: 0,
    ...overrides,
  };
}

/** A throwaway in-memory store with a fixed test encryption key. */
export async function memoryStore(): Promise<Store> {
  return createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-encryption-key-0123456789"),
  });
}

type SeedCredentialInput = Partial<
  Omit<Credential, "createdAt" | "updatedAt" | "hasRefreshToken"> & CredentialSecrets
> & { id: string };

/**
 * Writes a credential through the real store, so it is really encrypted.
 *
 * Distinct from `credential()` above, which builds an in-memory `CredentialView`
 * for router tests that never touch a database.
 */
export async function seedCredential(store: Store, overrides: SeedCredentialInput): Promise<void> {
  await store.credentials.create({
    provider: "anthropic",
    label: overrides.id,
    authType: "oauth",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: `test-token-${overrides.id}`,
    refreshToken: `test-refresh-${overrides.id}`,
    apiKey: null,
    idToken: null,
    ...overrides,
  });
}

/**
 * Mints a gateway API key and stores it the way the admin route does.
 *
 * Returns the raw value, which exists only here — the store keeps the hash.
 */
export async function seedApiKey(
  store: Store,
  overrides: Partial<Omit<ApiKey, "createdAt" | "revokedAt">> = {},
): Promise<{ raw: string; key: ApiKey }> {
  const raw = generateApiKey();
  const key = await store.keys.create({
    id: crypto.randomUUID(),
    label: "test",
    prefix: raw.slice(0, 12),
    hash: await hashApiKey(raw),
    modelAllowlist: null,
    rateLimitPerMin: null,
    ...overrides,
  });
  return { raw, key };
}

/**
 * A complete `RequestLog` row.
 *
 * Every field carries a value, so a test that cares about one of them says so
 * by overriding it, and a schema change breaks here once rather than in ten
 * separate literals.
 */
export function requestLog(overrides: Partial<RequestLog> & { id: string }): RequestLog {
  return {
    state: "done",
    at: 1_000_000,
    apiKeyId: null,
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 1,
    costUsd: 0,
    degradations: [],
    rtkApplied: false,
    rtkFilterHits: 0,
    rtkOriginalCodeUnits: 0,
    rtkCompressedCodeUnits: 0,
    rtkEstimatedTokensSaved: 0,
    rtkFilters: [],
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

/** An adapter set where every provider replays a fixed event list. */
export function stubAdapters(events: StreamEvent[]): Readonly<Record<ProviderId, ProviderAdapter>> {
  const make = (id: ProviderId): ProviderAdapter => ({
    id,
    capabilities: { tools: true, images: true, reasoning: true },
    async send() {
      return {
        events: (async function* () {
          for (const e of events) yield e;
        })(),
        degradations: [],
      };
    },
  });
  return {
    anthropic: make("anthropic"),
    openai: make("openai"),
    kimi: make("kimi"),
    custom: make("custom"),
  };
}

export function virtualModel(overrides: Partial<VirtualModel> & { id: string }): VirtualModel {
  return {
    strategy: "score",
    targets: [],
    isAlias: false,
    ...overrides,
  };
}
