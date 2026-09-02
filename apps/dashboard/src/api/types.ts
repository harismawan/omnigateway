import type { ErrorCode, ProviderId } from "@omni/ir";
import type {
  ApiKey,
  AuthType,
  BodyArtifact,
  BodyAttempt,
  BodyDetailState,
  BodyPair,
  Credential,
  CredentialHealth,
  DatabaseStats,
  Dimension,
  DisabledReason,
  LimitConfig,
  PonytailMode,
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
  Window,
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
  AuthType,
  BodyArtifact,
  BodyAttempt,
  BodyDetailState,
  BodyPair,
  Credential,
  CredentialHealth,
  DatabaseStats,
  Dimension,
  DisabledReason,
  ErrorCode,
  LimitConfig,
  PonytailMode,
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
  Window,
};

export type ApiErrorBody = { error: { code: ErrorCode | string; message: string } };

/**
 * A request row as `/api/client/logs` returns it.
 *
 * Hand-mirrored from `ClientRequestLog` in `@omni/control`, which the console
 * may not import. It is an enumerated projection there rather than `RequestLog`
 * minus three keys, so it is enumerated here too: typing this as the store's own
 * row is what let a component read `rtkFilters` off a payload that has never
 * carried it, and TypeScript agreed because the fetch is an unchecked cast.
 */
export type ClientRequestLog = {
  id: string;
  state: RequestLog["state"];
  at: number;
  requestedModel: string;
  /** Which provider served it. The *account* is deliberately not here. */
  resolvedProvider: RequestLog["resolvedProvider"];
  resolvedModel: string | null;
  attempts: number;
  status: number;
  errorCode: RequestLog["errorCode"];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ttftMs: number | null;
  durationMs: number;
  costUsd: number;
  degradations: string[];
  rtkApplied: boolean;
  rtkEstimatedTokensSaved: number;
};

/**
 * What a shared request component may assume it has been handed.
 *
 * The fields both surfaces carry, plus the operator's own as optional. A
 * component renders an optional field only where it has checked for it, so the
 * client's narrower row is a value the same table can draw rather than a second
 * table — and a column the client has no data for cannot be reached by
 * forgetting a guard.
 */
export type RequestRow = ClientRequestLog &
  Partial<
    Pick<
      RequestLog,
      | "apiKeyId"
      | "credentialId"
      | "rtkFilters"
      | "rtkFilterHits"
      | "rtkOriginalCodeUnits"
      | "rtkCompressedCodeUnits"
    >
  >;

/**
 * Which surface a session belongs to.
 *
 * Mirrored rather than imported: `Principal` is declared in `@omni/control`,
 * which the console may not reach into. The `machine` arm is deliberately absent
 * — it belongs to a plugin token and never opens a browser session, so a console
 * that could represent one would invite a branch nothing can reach.
 */
export type SessionPrincipal =
  | { kind: "admin" }
  | { kind: "viewer" }
  | { kind: "client"; apiKeyId: string };

export type StatusResponse = {
  configured: boolean;
  authenticated: boolean;
  /** Null when unauthenticated. */
  principal: SessionPrincipal | null;
  /** Whether a read-only password exists, so the login form knows to offer it. */
  viewerConfigured: boolean;
};

/**
 * One provider account's window as a client sees it.
 *
 * The label is a deliberate disclosure by the operator — a screen that collapsed
 * a provider's accounts could not say which one was filling up. The figures are
 * fractions because that is what the bars and the chart render, **not** because
 * the ceiling behind them is withheld: exact ratios and `exhaustsAt` both give
 * it back, and `AccountQuota` in `@omni/control` records why that was accepted
 * rather than rounded away.
 */
export type AccountQuota = {
  /** Stable per account, and what a chart joins its retained readings on. */
  credentialId: string;
  /** The operator's own name for the account. */
  label: string;
  provider: ProviderId;
  windowType: "fiveHour" | "daily" | "weekly";
  /** Null where the account reported no ceiling. Unknown, never unlimited. */
  usedRatio: number | null;
  resetsAt: number | null;
  /** When the account behind the ratio was last read; where the chart places it. */
  observedAt: number;
  windowMs: number | null;
  /**
   * Burn as a fraction of the window's own ceiling per hour.
   *
   * Scaled for the reason `usedRatio` is: a fraction is what the chart plots.
   * Null where suppressed.
   */
  ratePerHourRatio: number | null;
  /** When this window runs out at that rate; null when it will not or cannot be said. */
  exhaustsAt: number | null;
  /** Whether the window outlives its own reset. Null when the estimate is suppressed. */
  survives: boolean | null;
  /**
   * True when the reading is too old to believe. Decided in `@omni/control`,
   * because the test needs `quotaPollIntervalMs` and that setting lives on a
   * route no client may read.
   */
  stale: boolean;
  /**
   * True when the reading counts a window whose reset is already behind us.
   *
   * Apart from `stale` because the panel treats them differently: a rolled-over
   * reading is minutes old and its measured history stays on the chart, with
   * only the inferences suppressed.
   */
  rolledOver: boolean;
};

export type ClientQuotaResponse = { accounts: AccountQuota[] };

/**
 * One retained reading of one account's window, as the client surface charts it.
 *
 * `usedRatio` is never null: a reading against an unstated ceiling is not a
 * percentage of anything and is dropped in `@omni/control`, the same rule
 * `quotaSegments` applies to the operator's readings.
 */
export type AccountQuotaSample = {
  credentialId: string;
  label: string;
  provider: ProviderId;
  windowType: "fiveHour" | "daily" | "weekly";
  observedAt: number;
  usedRatio: number;
  resetsAt: number | null;
  windowMs: number | null;
};

/** Both bounds are epoch milliseconds; the route clamps them to retention. */
export type ClientQuotaHistoryQuery = { since: number; until?: number };

/**
 * No gateway rate here, unlike the operator's history response: that aggregate
 * covers every key on the installation, so it answers a question about the
 * operator's traffic rather than this client's.
 */
export type ClientQuotaHistoryResponse = {
  samples: AccountQuotaSample[];
  /** True when the read hit its row cap, so the series starts later than asked. */
  truncated: boolean;
};

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

/**
 * `hash` is withheld by the route: not a secret, but not worth publishing.
 *
 * `limits` arrives nullable, and the null is load-bearing rather than an
 * absence: it says the gateway could not parse what is stored and is refusing
 * the key until an operator fixes it. Rendering it like `{}` would present the
 * one row that needs attention as the least interesting on the board.
 */
export type ApiKeySummary = Omit<ApiKey, "hash"> & {
  /**
   * One entry per configured limit, so the board can render the matrix without
   * knowing which `(dimension, window)` pairs are meaningful. Empty for an
   * unlimited key, and empty for one whose stored matrix could not be parsed:
   * there is nothing to measure against a ceiling nobody can read.
   */
  limitUsage: LimitReading[];
};

/**
 * One ceiling and what has gone against it.
 *
 * Mirrored rather than imported: the shape is assembled in `@omni/control`,
 * which the console may not reach into. `used` counts completed requests still
 * inside the window, so it is a floor on what the limiter sees rather than the
 * limiter's own number — the gateway adds an in-memory delta this route cannot.
 */
export type LimitReading = {
  dimension: Dimension;
  /** Null for `concurrency`, which is a gauge and has no window. */
  window: Window | null;
  limit: number;
  /**
   * Null where no stored row measures it, which today means `concurrency`
   * alone. Zero would claim the gauge is empty; null says nobody asked it.
   */
  used: number | null;
};

export type KeysResponse = { keys: ApiKeySummary[] };

/** The whole matrix, sent whole. `{}` leaves the key unlimited. */
export type KeyLimitsInput = { limits: LimitConfig };

/**
 * The whole allowlist, sent whole. `null` is every model and `[]` is none;
 * the two are opposite facts, so an edit must say which it means.
 */
export type KeyModelsInput = { modelAllowlist: string[] | null };

export type KeyCreateInput = {
  label: string;
  /** Null means every configured model; an empty array means none. */
  modelAllowlist: string[] | null;
  /**
   * The sparse `(dimension, window)` matrix. `{}` is unlimited.
   *
   * Not nullable, unlike the same field on `ApiKeySummary`: unreadable is a
   * state a reader discovers, never one a minting form may ask for.
   */
  limits: LimitConfig;
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

/** The client's own tail, which is a narrower row than the operator's. */
export type ClientLogsResponse = { logs: ClientRequestLog[] };

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
  /** Which process wrote it. Only on a merged (`fleet`) read. */
  nodeId?: string;
};

/** One process serving this installation, as `/api/nodes` reports it. */
export type NodeEntry = { id: string; seenAt: number; self: boolean };
export type NodesResponse = { nodes: NodeEntry[] };

/**
 * Which log the gateway found, and what it holds.
 *
 * `source` is part of the answer rather than an internal detail: the screen
 * states where these lines came from, and cannot without being told. `none`
 * means nothing captured the gateway's stdout — ordinary in development, not
 * an error.
 */
export type ConsoleResponse = {
  /** `fleet` is every live process merged by timestamp. */
  source: "file" | "journal" | "none" | "fleet";
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
  engine: "sqlite" | "postgres";
  /** The file path, or the server URL with its password masked. */
  location: string;
  stats: DatabaseStats;
  fileBytes: number;
  walBytes: number;
  /** The captured-body tree beside a SQLite file, or the `request_bodies` table on Postgres. */
  bodiesBytes: number;
  logicalBytes: number;
  /** The part of the logical size a vacuum would give back. */
  freePageBytes: number;
  freeDiskBytes: number | null;
  retention: RetentionPolicy;
  snapshots: { count: number; totalBytes: number; latestAt: number | null };
  /** Every table, largest first. `rows` is exact on SQLite, an estimate on Postgres. */
  tables: TableStats[];
};

export type TableStats = {
  name: string;
  /** Table plus its indexes (and TOAST on Postgres). */
  bytes: number;
  rows: number;
  /** Postgres tuples awaiting autovacuum; null where the engine has no such number. */
  deadRows: number | null;
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

/** What a plugin asks for in the rail. Absent when the plugin adds no screen. */
export type PluginNav = {
  label: string;
  /** A name from the plugin's manifest. The console picks its own glyph. */
};

export type PluginUiInfo = {
  /**
   * The URL the console imports, under `/plugin-assets/<id>/`.
   *
   * Carries the plugin's version as `?v=`, and it must be imported whole. The
   * query is what makes a reinstalled bundle a URL the browser has not already
   * resolved — the module map is keyed by URL for the lifetime of a document,
   * so a stripped one would leave a console tab on the previous build while
   * reporting the new version beside it.
   *
   * `null` whenever the bundle is incompatible: the gateway withholds the URL
   * on purpose, so a console that ignored `compatible` would still have nothing
   * to import and could not turn a version mismatch into a render crash.
   */
  entry: string | null;
  compatible: boolean;
  /** Why it is incompatible. Shown on the disabled rail entry, verbatim. */
  reason?: string | undefined;
};

/**
 * One installed plugin, as `/api/plugins` reports it.
 *
 * Mirrored rather than imported: the shape is assembled in
 * `apps/gateway/src/plugins/ui.ts`, and per boundary 12 the console may not
 * reach into the gateway for a type. The three states this file has to keep
 * distinguishable are `ui === null` (backend-only, no screen at all),
 * `ui.compatible === false` (a screen that will not load, named with a reason),
 * and a live UI.
 */
export type PluginCatalogEntry = {
  id: string;
  name: string;
  version: string;
  nav: PluginNav | null;
  ui: PluginUiInfo | null;
};

export type PluginsResponse = { plugins: PluginCatalogEntry[] };

/** List price in US dollars per million tokens, as the catalog publishes it. */
export type CatalogPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/** Published context and output ceilings, in tokens. */
export type CatalogLimits = { contextWindow: number; maxOutputTokens: number };

/**
 * One curated model of one provider.
 *
 * `auth` is stated only where a provider does not serve the same model to both
 * ways in — Kilo's free tier answers an API key and not a subscription — and
 * absent means both. `oauthLimits` is the same idea for the window: absent
 * means one set of limits covers either backend.
 */
export type CatalogModel = {
  id: string;
  label: string;
  pricing: CatalogPricing;
  limits: CatalogLimits;
  oauthLimits?: CatalogLimits;
  /**
   * Which credential types can reach this model.
   *
   * Always present: the endpoint resolves it, applying the rule that a model
   * states its own set or inherits the provider's. It was optional here while
   * the console applied that rule itself — which was a second copy of it, and is
   * why it moved.
   */
  auth: readonly AuthType[];
};

/**
 * One provider the gateway can serve, as `/api/catalog` reports it.
 *
 * Mirrored rather than imported: the shape is assembled by `providerCatalog()`
 * in `packages/control`, and per boundary 12 the console may not reach into the
 * gateway or control for a type — nor, since this endpoint exists, into the
 * provider package for the data itself. A provider that loads from a plugin at
 * boot has no build-time module to import, which is the whole reason the
 * console reads this over the wire.
 *
 * `order` is the rank the console draws providers in; the wire order is not a
 * contract, so `useProviderCatalog` sorts by it on the way in.
 */
export type CatalogProvider = {
  id: string;
  label: string;
  order: number;
  colour: { light: string; dark: string };
  /** What the operator does next in that provider's own words, or absent. */
  pasteHint?: string;
  /** The redirect a PKCE flow lands on. Absent for providers that have none. */
  callback?: { uri: string; label: string };
  defaultModel: string;
  /** Which kinds of credential the gateway can hold for this provider. */
  authTypes: readonly AuthType[];
  models: readonly CatalogModel[];
};

export type CatalogResponse = { providers: CatalogProvider[] };
