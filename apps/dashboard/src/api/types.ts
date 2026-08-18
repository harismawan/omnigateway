import type { ErrorCode, ProviderId } from "@omni/ir";
import type {
  ApiKey,
  BodyArtifact,
  BodyAttempt,
  BodyDetailState,
  BodyPair,
  Credential,
  CredentialHealth,
  DatabaseStats,
  DisabledReason,
  QuotaSample,
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
  BodyArtifact,
  BodyAttempt,
  BodyDetailState,
  BodyPair,
  Credential,
  CredentialHealth,
  DatabaseStats,
  DisabledReason,
  ErrorCode,
  ProviderId,
  QuotaSample,
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

/**
 * How fast one quota window is being spent, and whether it lasts.
 *
 * Mirrored rather than imported: the estimate is derived in `@omni/control`,
 * which the console may not reach into, so this is a hand-kept copy of
 * `BurnEstimate` that the route returns unchanged.
 *
 * Every estimate is null when `stale` is true — a reading nobody believes must
 * not be dressed up as a number, so surfaces guard on the flag rather than on
 * whether a figure happens to be present.
 */
export type BurnEstimate = {
  credentialId: string;
  windowType: QuotaWindow["windowType"];
  /** Inferred as `resetsAt` minus the window's length. Null with no stated reset. */
  windowStartsAt: number | null;
  /** Provider units per hour, averaged across the window so far. */
  ratePerHour: number | null;
  /** When the window runs out at that rate, or null when it will not. */
  exhaustsAt: number | null;
  /** Whether the window outlives its own reset. Null only when suppressed. */
  survives: boolean | null;
  stale: boolean;
};

/**
 * What this gateway accounts for over the same span the provider rate covers.
 *
 * On the history response rather than beside the estimate, because it costs a
 * request-log aggregate per window and the health route is refetched every ten
 * seconds. Only the Accounts disclosure shows it, and only while expanded.
 */
export type GatewayRate = {
  credentialId: string;
  windowType: QuotaWindow["windowType"];
  /** Null when the window start is unknown, so there is no span to divide by. */
  gatewayRatePerHour: number | null;
};

export type CredentialHealthResponse = {
  health: CredentialHealth[];
  quota: QuotaWindow[];
  burn: BurnEstimate[];
};

/** Both bounds are epoch milliseconds; the route clamps them to retention. */
export type QuotaHistoryQuery = {
  credentialId: string;
  since: number;
  until?: number;
};

/** The estimate itself rides the health endpoint and is not repeated here. */
export type QuotaHistoryResponse = { samples: QuotaSample[]; gatewayRates: GatewayRate[] };

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
  /** Settable only here: there is no route that turns capture back on for a key. */
  bodyLoggingOptOut: boolean;
};

/**
 * The runtime settings, plus whether the environment permits body capture.
 *
 * `bodyLoggingAllowed` is not part of `Settings` and never will be: it is
 * `OMNI_BODY_LOGGING_ALLOWED`, read at boot, and the console needs it only so it
 * can say that flipping `bodyLoggingEnabled` on this installation would do
 * nothing. A switch that silently does nothing is worse than one that is absent.
 */
export type SettingsResponse = { settings: Settings; bodyLoggingAllowed: boolean };

/**
 * One request's captured bodies.
 *
 * Mirrored rather than imported: the shape is assembled in `@omni/control`,
 * which the console may not reach into, so this is a hand-kept copy of
 * `RequestBodyRead` that the route returns unchanged. It deliberately carries no
 * artifact path and no digest — where the gateway keeps a file is not the
 * console's business.
 */
export type RequestBodyResponse = {
  requestId: string;
  /** `none` is "never captured"; `missing` and `corrupt` are "captured, then lost". */
  detailState: BodyDetailState;
  truncated: boolean;
  /** Bytes as stored, which are ciphertext, so roughly twice the plaintext. */
  sizeBytes: number;
  at: number | null;
  artifact: BodyArtifact | null;
};

/**
 * The marker that replaced a body too large to keep.
 *
 * Written by the store in place of the payload, so an artifact that reads as
 * `ready` can still have nothing in it. Recognised structurally because the
 * bodies either side of it are `unknown` by design.
 */
export type BodyOmission = { omitted: true; reason: string; serializedBytes: number };

/** Which agent a generated configuration is for. */
export type SetupClient = "claude" | "opencode";

export type SetupFile = { path: string; contents: string };

export type AgentModelMapping = {
  defaultModel: string;
  fableModel?: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
};

export type SetupResponse = { client: SetupClient; files: SetupFile[] };

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

/**
 * One line of the gateway's own output.
 *
 * Every field but `raw` is nullable because not every line came from the
 * gateway's logger: a journal carries systemd's own notices and anything the
 * runtime printed outside it. Those are shown as they arrived.
 */
export type ConsoleLine = {
  raw: string;
  at: number | null;
  level: "debug" | "info" | "warn" | "error" | null;
  msg: string | null;
};

/**
 * Which log the gateway found, and what it holds.
 *
 * `source` is part of the answer rather than an internal detail: the screen
 * states where these lines came from, and cannot without being told. `none`
 * means nothing captured the gateway's stdout — ordinary in development, not
 * an error.
 */
export type ConsoleResponse = {
  source: "file" | "journal" | "none";
  /** Only for `file`. A journal has no path to name. */
  path?: string;
  lines: ConsoleLine[];
};

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

/* --------------------------------------------------------------- database -- */

/**
 * The database panel's wire shapes.
 *
 * Mirrored by hand rather than imported, for the reason `BurnEstimate` above
 * gives: these are `@omni/control`'s types, and the console may not reach into
 * that package. `DatabaseStats` is the exception — it is a store type, which the
 * `/types` subpath already publishes, so it is imported and stays honest by
 * itself.
 */
export type RetentionPolicy = {
  /** How many snapshots survive regardless of age. Never zero. */
  keepLatest: number;
  maxAgeDays: number;
};

export type SnapshotInfo = {
  /** The filename. A snapshot has no identity apart from the file it is. */
  id: string;
  filename: string;
  createdAt: number;
  sizeBytes: number;
  /** `manual` or `preRestore`; free-form on the wire, so never switched on. */
  reason: string;
};

export type DatabaseOverview = {
  stats: DatabaseStats;
  fileBytes: number;
  walBytes: number;
  /** The captured-body tree, which snapshots deliberately exclude. */
  bodiesBytes: number;
  logicalBytes: number;
  /** The part of the logical size a vacuum would give back. */
  freePageBytes: number;
  freeDiskBytes: number | null;
  retention: RetentionPolicy;
  snapshots: { count: number; totalBytes: number; latestAt: number | null };
};

export type SnapshotsResponse = { snapshots: SnapshotInfo[] };

export type VacuumResult = { ok: true; reclaimedBytes: number; durationMs: number };

/**
 * What a restore or an import answers with.
 *
 * `adminPasswordChanged` is the field that matters to a console: the gateway has
 * already ended every admin session by the time this arrives, so the cookie the
 * operator is holding is dead and any refetch would only earn a 401.
 */
export type RestoreResult = {
  ok: true;
  counts: Record<string, number>;
  preRestoreSnapshot: SnapshotInfo;
  adminPasswordChanged: boolean;
};

export type Supervisor = "systemd" | "container" | "none";

export type LifecycleCapability = {
  supervisor: Supervisor;
  canRestart: boolean;
  canShutdown: boolean;
  /** Why the capability is what it is, when that is not obvious. */
  note?: string;
};
