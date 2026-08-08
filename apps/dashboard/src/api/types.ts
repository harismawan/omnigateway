import type { ErrorCode, ProviderId } from "@omni/ir";
import type {
  ApiKey,
  Credential,
  CredentialHealth,
  DisabledReason,
  QuotaWindow,
  RequestLog,
  Settings,
  Strategy,
  Target,
  UsageBucket,
  UsageDimension,
  UsageGrain,
  VirtualModel,
  // The `/types` subpath is provider-neutral domain types only; the package
  // root would drag SQLite and encryption into the browser build graph.
} from "@omni/store/types";

/**
 * Wire shapes for `/api/*`. They are expressed in terms of the gateway's own
 * domain types wherever the route returns one unchanged, so a change on the
 * server side surfaces here as a type error rather than as a silent mismatch.
 */
export type {
  ApiKey,
  Credential,
  CredentialHealth,
  DisabledReason,
  ErrorCode,
  ProviderId,
  QuotaWindow,
  RequestLog,
  Settings,
  Strategy,
  Target,
  UsageBucket,
  UsageDimension,
  UsageGrain,
  VirtualModel,
};

export type ApiErrorBody = { error: { code: ErrorCode | string; message: string } };

export type StatusResponse = { configured: boolean; authenticated: boolean };

export type CredentialsResponse = { credentials: Credential[] };

export type CredentialHealthResponse = { health: CredentialHealth[]; quota: QuotaWindow[] };

export type CredentialPatch = {
  label?: string;
  enabled?: boolean;
  tier?: number;
  weight?: number;
};

export type ModelsResponse = { models: VirtualModel[] };

/** The key is never persisted in plaintext, so this response is the only copy. */
export type MintedKey = { id: string; label: string; prefix: string; key: string };

/** `hash` is withheld by the route: not a secret, but not worth publishing. */
export type ApiKeySummary = Omit<ApiKey, "hash">;

export type KeysResponse = { keys: ApiKeySummary[] };

export type KeyCreateInput = {
  label: string;
  /** Null means every configured model; an empty array means none. */
  modelAllowlist: string[] | null;
  rateLimitPerMin: number | null;
};

export type SettingsResponse = { settings: Settings };

export type UsageQuery = {
  groupBy: UsageDimension;
  splitBy?: UsageDimension;
  /** `raw` reads request logs; `daily` reads the rollup that outlives them. */
  grain?: UsageGrain;
  since: number;
  until?: number;
};

export type UsageResponse = { rows: UsageBucket[] };

export type LogsResponse = { logs: RequestLog[] };

/** A capability-only probe: no prompt content ever reaches the control API. */
export type DryRunNeed = { tools: boolean; images: boolean; reasoning: boolean };

/** Per-term score contributions, before weights. Keys match `Settings["weights"]`. */
export type ScoreReasons = Record<string, number>;

export type DryRunCandidate = {
  credentialId: string;
  credentialLabel: string;
  provider: ProviderId;
  model: string;
  tier: number;
  score: number;
  reasons: ScoreReasons;
};

export type DryRunExcluded = { credentialId: string; model: string; reason: string };

export type DryRunResult = {
  modelId: string;
  strategy: Strategy;
  /** False for `weighted`, whose order depends on a random draw per request. */
  deterministic: boolean;
  rankedAt: number;
  candidates: DryRunCandidate[];
  excluded: DryRunExcluded[];
};

export type ConnectKind = "pkce" | "device";

export type ConnectStart = {
  flowId: string;
  /** Open in a browser for PKCE; show to the operator for device flows. */
  authorizeUrl: string;
  userCode: string | null;
  kind: ConnectKind;
  supportsManualPaste: boolean;
  pollIntervalMs: number;
};

export type ConnectPending = { status: "pending" };
export type ConnectComplete = { status: "complete"; id: string };
export type ConnectPollResult = ConnectPending | ConnectComplete;
