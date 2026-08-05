import type { ProviderId } from "@omni/ir";
import type {
  ApiKey,
  BreakerState,
  Credential,
  CredentialHealth,
  QuotaWindow,
  RequestLog,
  ScoringWeights,
  Settings,
  Strategy,
  Target,
  UsageBucket,
  VirtualModel,
  WindowType,
} from "@omni/store/types";

export type {
  ApiKey,
  BreakerState,
  Credential,
  CredentialHealth,
  ProviderId,
  QuotaWindow,
  RequestLog,
  ScoringWeights,
  Settings,
  Strategy,
  Target,
  UsageBucket,
  VirtualModel,
  WindowType,
};

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "kimi"];

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kimi: "Kimi Coding",
};

export const STRATEGIES: readonly Strategy[] = ["score", "priority", "roundRobin", "weighted"];

/** What `GET /api/credentials` actually serializes. */
export type WireCredential = Credential;

export type CredentialsResponse = { credentials: WireCredential[] };
export type ModelsResponse = { models: VirtualModel[] };
export type SettingsResponse = { settings: Settings };
export type UsageResponse = { rows: UsageBucket[] };
export type LogsResponse = { logs: RequestLog[] };
export type OkResponse = { ok: true };

/** `GET /api/status` — drives the first-run branch in Task 4. */
export type StatusResponse = { configured: boolean; authenticated: boolean };

/** `GET /api/keys`. The stored `hash` is deliberately absent from the wire shape. */
export type WireApiKey = Omit<ApiKey, "hash">;
export type KeysResponse = { keys: WireApiKey[] };

/** `POST /api/keys`. `key` is the plaintext value, returned exactly once. */
export type MintedKey = { id: string; label: string; prefix: string; key: string };

export type MintKeyInput = {
  label: string;
  modelAllowlist: string[] | null;
  rateLimitPerMin: number | null;
};

/** Only these credential fields are operator-editable; the gateway rejects the rest. */
export type CredentialPatch = {
  label?: string;
  enabled?: boolean;
  tier?: number;
  weight?: number;
};

/** `POST /api/connect/start` */
export type ConnectStart = {
  flowId: string;
  authorizeUrl: string;
  userCode: string | null;
  kind: "pkce" | "device";
  supportsManualPaste: boolean;
  pollIntervalMs: number;
};

/** `POST /api/connect/finish` — the response carries an id and nothing else. */
export type ConnectFinish = { id: string };

/** `POST /api/connect/poll` — 202 while pending, 200 with the id on completion. */
export type ConnectPoll = { status: "pending" } | { status: "complete"; id: string };

export type UsageGroupBy = "credential" | "model" | "apiKey" | "hour";

export const USAGE_GROUP_BY: readonly UsageGroupBy[] = ["model", "credential", "apiKey", "hour"];

/** `POST /api/models/:id/dry-run` — the request body. */
export type DryRunRequest = { tools: boolean; images: boolean; reasoning: boolean };

/** One ranked candidate. `reasons` holds the six normalized score terms. */
export type DryRunCandidate = {
  credentialId: string;
  credentialLabel: string;
  provider: ProviderId;
  model: string;
  tier: number;
  score: number;
  reasons: Record<string, number>;
};

/** Matches the router's excluded candidate representation. */
export type DryRunExcluded = { credentialId: string; model: string; reason: string };

export type DryRunResponse = {
  modelId: string;
  strategy: Strategy;
  deterministic: boolean;
  rankedAt: number;
  candidates: DryRunCandidate[];
  excluded: DryRunExcluded[];
};

export const SCORE_TERMS = ["tier", "health", "quota", "cost", "latency", "recency"] as const;
