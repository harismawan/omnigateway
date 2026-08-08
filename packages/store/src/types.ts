import type { ProviderId } from "@omni/ir";

export type BreakerState = "closed" | "open" | "halfOpen";
export type AuthType = "oauth" | "apiKey";
export type WindowType = "fiveHour" | "daily" | "weekly";

/**
 * Why a credential is not routing.
 *
 * `tokenRejected` is the provider's verdict on a refresh: the credential cannot
 * be revived without reconnecting. `expiredNoRefresh` is ours, for an OAuth
 * credential that ran out with nothing to refresh from. `manual` is the
 * operator's own switch, and is the only one they can undo with a toggle.
 */
export type DisabledReason = "tokenRejected" | "expiredNoRefresh" | "manual";

export type Credential = {
  id: string;
  provider: ProviderId;
  label: string;
  authType: AuthType;
  enabled: boolean;
  tier: number;
  weight: number;
  /** Milliseconds since epoch, or null when the token does not expire. */
  expiresAt: number | null;
  accountEmail: string | null;
  /** Provider-specific durable state, e.g. Kimi device identity, Codex workspace id. */
  providerData: Record<string, unknown>;
  /** Why `enabled` is false. Null whenever the credential is enabled. */
  disabledReason: DisabledReason | null;
  disabledAt: number | null;
  /**
   * Derived at read time, never written. Lets the router decide whether an
   * expired credential can be revived without decrypting anything.
   */
  hasRefreshToken: boolean;
  createdAt: number;
  updatedAt: number;
};

/** Secret material, resolved separately so ranking never decrypts. */
export type CredentialSecrets = {
  accessToken: string | null;
  refreshToken: string | null;
  apiKey: string | null;
  idToken: string | null;
};

/**
 * A credential plus a thunk for its secrets. The router reads only the
 * metadata; dispatch calls `secrets()` on the single winning candidate, so
 * ranking N candidates costs one decryption rather than N.
 */
export type CredentialView = Credential & { secrets: () => Promise<CredentialSecrets> };

export type CredentialHealth = {
  credentialId: string;
  model: string;
  breakerState: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  rateLimitedUntil: number | null;
  ewmaTtftMs: number | null;
  lastUsedAt: number | null;
};

/**
 * One provider-reported usage window for one credential.
 *
 * `used` and `limit` are in whatever unit the provider reported. A provider
 * that only gives a percentage is stored as `used: 87, limit: 100`, which keeps
 * every consumer on the same ratio arithmetic.
 */
export type QuotaWindow = {
  credentialId: string;
  windowType: WindowType;
  startsAt: number;
  used: number;
  /** Null means the provider reported usage without a ceiling to measure it against. */
  limit: number | null;
  /** When the provider says the window rolls over, or null when it did not say. */
  resetsAt: number | null;
  /**
   * When this reading was taken. Zero for a row written before snapshots
   * existed; readers treat that as never observed rather than as current.
   */
  observedAt: number;
};

export type Target = {
  provider: ProviderId;
  model: string;
  tier: number;
  weight: number;
  costPerMTok: { input: number; output: number; cacheRead?: number };
  capabilities: { tools: boolean; images: boolean; reasoning: boolean };
};

export type Strategy = "score" | "priority" | "roundRobin" | "weighted";

export type VirtualModel = {
  id: string;
  targets: Target[];
  strategy: Strategy;
  /** True when this row was generated from an alias for a concrete model name. */
  isAlias: boolean;
};

export type ApiKey = {
  id: string;
  label: string;
  /** First 12 chars of the key, for display. Never the full key. */
  prefix: string;
  hash: string;
  modelAllowlist: string[] | null;
  rateLimitPerMin: number | null;
  createdAt: number;
  revokedAt: number | null;
};

export type RequestLog = {
  id: string;
  at: number;
  apiKeyId: string | null;
  requestedModel: string;
  resolvedProvider: ProviderId | null;
  resolvedModel: string | null;
  credentialId: string | null;
  attempts: number;
  status: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ttftMs: number | null;
  durationMs: number;
  costUsd: number;
  /** Capability degradations applied, e.g. ["droppedThinking"]. */
  degradations: string[];
};

export type ScoringWeights = {
  tier: number;
  health: number;
  quota: number;
  cost: number;
  latency: number;
  recency: number;
};

export type Settings = {
  weights: ScoringWeights;
  maxAttempts: number;
  requestDeadlineMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  logRetentionDays: number;
  /** How often provider quota is polled. Zero disables polling entirely. */
  quotaPollIntervalMs: number;
};

export interface CredentialRepo {
  list(): Promise<CredentialView[]>;
  /** Routing metadata only; secret ciphertext is loaded lazily by credential id. */
  listRouting(): Promise<CredentialView[]>;
  get(id: string): Promise<CredentialView | null>;
  create(
    input: Omit<Credential, "createdAt" | "updatedAt" | "hasRefreshToken"> & CredentialSecrets,
  ): Promise<Credential>;
  update(id: string, patch: Partial<Credential>): Promise<void>;
  updateSecrets(
    id: string,
    secrets: Partial<CredentialSecrets>,
    expiresAt: number | null,
  ): Promise<void>;
  remove(id: string): Promise<void>;
  listHealth(): Promise<CredentialHealth[]>;
  saveHealth(rows: CredentialHealth[]): Promise<void>;
  listQuota(): Promise<QuotaWindow[]>;
  saveQuota(rows: QuotaWindow[]): Promise<void>;
}

export interface ConfigRepo {
  listModels(): Promise<VirtualModel[]>;
  putModel(model: VirtualModel): Promise<void>;
  removeModel(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  putSettings(patch: Partial<Settings>): Promise<Settings>;
  getAdminPasswordHash(): Promise<string | null>;
  /** Writes only if no admin hash exists; reports whether this call won. */
  setAdminPasswordHashIfAbsent(hash: string): Promise<boolean>;
  /** Replaces an existing password hash for the authenticated password-change path. */
  setAdminPasswordHash(hash: string): Promise<void>;
}

export interface KeyRepo {
  list(): Promise<ApiKey[]>;
  findByHash(hash: string): Promise<ApiKey | null>;
  create(input: Omit<ApiKey, "createdAt" | "revokedAt">): Promise<ApiKey>;
  revoke(id: string): Promise<void>;
}

/**
 * A dimension usage can be sliced by. `hour` only exists in raw logs and `day`
 * only in the rollup; the rest are available at both grains.
 */
export type UsageDimension =
  | "credential"
  | "model"
  | "requestedModel"
  | "apiKey"
  | "provider"
  | "hour"
  | "day";

/**
 * `raw` reads `request_logs`, which is bounded by the retention window but can
 * resolve down to the hour. `daily` reads the `usage_daily` rollup, which keeps
 * a year but only ever answers per day.
 */
export type UsageGrain = "raw" | "daily";

export type UsageQuery = {
  since: number;
  until?: number;
  /** Defaults to `raw`. */
  grain?: UsageGrain;
  groupBy: UsageDimension;
  /**
   * A second dimension, giving one bucket per (groupBy, splitBy) pair. This is
   * what turns a time series into a stacked one — group by `day`, split by
   * `provider` — without asking the caller to issue a query per series.
   */
  splitBy?: UsageDimension;
};

export type UsageBucket = {
  key: string;
  /** Present only when the query set `splitBy`. */
  split?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  errors: number;
  /** Summed request durations; divide by `requests` for the window's mean. */
  durationMsSum: number;
};

export interface UsageRepo {
  append(log: RequestLog): Promise<void>;
  recent(limit: number): Promise<RequestLog[]>;
  aggregate(q: UsageQuery): Promise<UsageBucket[]>;
  prune(olderThan: number): Promise<number>;
  /** Prunes the daily rollup, which is kept far longer than the raw logs. */
  pruneDaily(olderThan: number): Promise<number>;
}

export type RoutingChange =
  | { type: "healthSaved"; rows: CredentialHealth[] }
  | { type: "quotaSaved"; rows: QuotaWindow[] }
  | { type: "credentialsChanged" }
  | { type: "modelsChanged" }
  | { type: "settingsChanged" };

export interface RoutingChangeSource {
  /** SQLite connection-local view of commits made by other connections. */
  version(): number;
  subscribe(listener: (change: RoutingChange) => void): () => void;
}

export type Store = {
  credentials: CredentialRepo;
  config: ConfigRepo;
  keys: KeyRepo;
  usage: UsageRepo;
  routing: RoutingChangeSource;
  close(): void;
};

export const DEFAULT_SETTINGS: Settings = {
  weights: { tier: 10, health: 3, quota: 2, cost: 1, latency: 1, recency: 0.5 },
  maxAttempts: 3,
  requestDeadlineMs: 120_000,
  breakerThreshold: 3,
  breakerCooldownMs: 30_000,
  logRetentionDays: 30,
  quotaPollIntervalMs: 300_000,
};
