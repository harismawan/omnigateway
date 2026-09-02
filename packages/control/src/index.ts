/**
 * Everything an operator can do to a gateway, independent of how they ask.
 *
 * The control API and the CLI are both adapters over this package: one turns
 * HTTP requests into these calls, the other turns argv into them. Nothing here
 * knows about either — no cookies, no argv, no terminal, no timers.
 */
export {
  ADMIN_COOKIE,
  type AdminAuth,
  type AdminAuthOptions,
  createAdminAuth,
} from "./adminAuth.ts";
export { type RequestBodyRead, readRequestBody } from "./bodies.ts";
export {
  type CatalogProblem,
  type CatalogProvider,
  isPaletteSafeColour,
  isPaletteSafeProviderId,
  NEUTRAL_COLOUR,
  providerCatalog,
} from "./catalog.ts";
export {
  type ClientRequestLog,
  isClientVisibleDegradation,
  toClientLog,
} from "./clientLog.ts";
export { type Config, loadConfig } from "./config.ts";
export {
  type ConnectDeps,
  type ConnectFlows,
  type ConnectPoll,
  type ConnectStart,
  createConnectFlows,
  isProviderId,
  PROVIDER_IDS,
} from "./connect.ts";
export {
  type CommandRunner,
  type ConsoleDeps,
  type ConsoleLine,
  type ConsoleQuery,
  type ConsoleRead,
  type ConsoleSource,
  consoleLimit,
  MAX_CONSOLE_LINES,
  parseConsoleLines,
  readConsole,
  resolveConsoleSource,
  UNIT_NAME,
} from "./console.ts";
export {
  type CredentialPatch,
  type CredentialStatus,
  type CredentialSummary,
  createApiKeyCredential,
  credentialHealth,
  credentialStatus,
  getCredential,
  listCredentials,
  type ProviderExists,
  patchCredential,
  refreshCredential,
  removeCredential,
} from "./credentials.ts";
export {
  createSnapshot,
  type DatabaseDeps,
  type DatabaseOverview,
  type DatabaseStore,
  deleteSnapshot,
  getDatabaseOverview,
  importSnapshot,
  listSnapshots,
  MAX_IMPORT_BYTES,
  previewRestore,
  pruneSnapshots,
  putRetention,
  type RestorePreview,
  type RestoreResult,
  type RetentionPolicy,
  resolveSnapshotForDownload,
  restoreSnapshot,
  SNAPSHOT_HEADROOM,
  SNAPSHOTS_DIRNAME,
  type SnapshotInfo,
  type SnapshotReason,
  SwapFailedError,
  snapshotsDir,
  stagedImportPath,
  sweepStaging,
  vacuum,
} from "./database.ts";
export { type DryRunCandidate, type DryRunResult, dryRun } from "./dryRun.ts";
export {
  type ApiKeySummary,
  type CreatedKey,
  createKey,
  type LimitReading,
  listKeys,
  readOwnKey,
  revokeKey,
  setKeyLimits,
  setKeyModels,
} from "./keys.ts";
export {
  DOCKERENV_PATH,
  describeLifecycle,
  type LifecycleCapability,
  type LifecycleDeps,
  requestRestart,
  requestShutdown,
  type Supervisor,
} from "./lifecycle.ts";
export {
  type ModelLimits,
  modelDisplayName,
  resolveModelLimits,
  type ServingCredential,
} from "./modelLimits.ts";
export { getModel, listModels, putModel, removeModel } from "./models.ts";
export {
  type FetchBytesOptions,
  nodeDatabaseFs,
  nodeFetchBytes,
  nodePluginFs,
} from "./nodeFs.ts";
export {
  OAUTH_PROVIDERS,
  oauthProviderIds,
  registerOAuthProvider,
  seedBuiltinOAuth,
} from "./oauth/index.ts";
export { DISPATCH_REFRESH_LEAD_MS, SCHEDULER_REFRESH_LEAD_MS } from "./oauth/lead.ts";
export { createPendingFlows, type StoredFlow } from "./oauth/pending.ts";
export { createRefresher, type Refresher } from "./oauth/refresh.ts";
export type {
  AuthorizeStart,
  DeviceOAuthProvider,
  FlowResult,
  OAuthDeps,
  OAuthProvider,
  PendingFlow,
  PkceOAuthProvider,
  UsageReport,
} from "./oauth/types.ts";
export {
  type PluginImporter,
  type PluginProviderRead,
  type RegisteredProvider,
  readPluginProviders,
  readProviders,
  validateRegistration,
} from "./pluginProviders.ts";
export {
  DEFAULT_NPM_REGISTRY,
  INSTALL_RECORD_FILENAME,
  installPlugin,
  listPlugins,
  MANIFEST_FILENAME,
  MAX_PLUGIN_BYTES,
  NPM_PACKUMENT_ACCEPT,
  orphanPluginTables,
  PLUGINS_DIRNAME,
  type PluginDeps,
  type PluginFs,
  type PluginInstallOptions,
  type PluginInstallRecord,
  type PluginInstallResult,
  type PluginProblem,
  type PluginRemoveOptions,
  type PluginRemoveResult,
  type PluginReport,
  type PluginStore,
  type PluginSummary,
  pluginsDir,
  readInstallRecord,
  removePlugin,
  updatePlugin,
  verifyPlugin,
} from "./plugins.ts";
export {
  ALL,
  NONE,
  type Principal,
  type PrincipalKind,
  readsNothing,
  type Scope,
  scopeKey,
  scopeOf,
} from "./principal.ts";
export { type BurnEstimate, type BurnInput, burnEstimates, burnFor } from "./quota/burn.ts";
export {
  type AccountQuotaHistoryInput,
  type AccountQuotaHistoryResult,
  type AccountQuotaSample,
  accountQuotaHistory,
} from "./quota/clientHistory.ts";
export { type AccountQuota, accountQuota, usedRatioOf } from "./quota/headroom.ts";
export {
  type GatewayRate,
  type QuotaHistoryInput,
  type QuotaHistoryResult,
  quotaHistory,
  retainedSpan,
} from "./quota/history.ts";
export {
  type PollerDeps,
  poll,
  probe,
  RATE_LIMIT_COOLDOWN_MS,
} from "./quota/poll.ts";
export {
  credentialPatchSchema,
  dimensionSchema,
  dryRunSchema,
  grainSchema,
  keyCreateSchema,
  modelSchema,
  parseOrThrow,
  providerIdSchema,
  requireDimension,
  retentionSchema,
  settingsSchema,
} from "./schemas.ts";
export { getSettings, putSettings } from "./settings.ts";
export {
  type AgentModelMapping,
  claudeSettings,
  describeModelsForSetup,
  KEY_PLACEHOLDER,
  opencodeConfig,
  type SetupClient,
  type SetupFile,
  type SetupInput,
  setupFiles,
} from "./setup.ts";
export { type ForwardRead, fileExists, fileSize, readFrom, tailFile } from "./tail.ts";
export {
  logLimit,
  MAX_LOG_LIMIT,
  queryUsage,
  recentLogs,
  type UsageQueryInput,
} from "./usage.ts";
