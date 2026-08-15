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
export { type Config, loadConfig } from "./config.ts";
export {
  type ConnectDeps,
  type ConnectFlows,
  type ConnectPoll,
  type ConnectStart,
  createConnectFlows,
  isProviderId,
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
  patchCredential,
  refreshCredential,
  removeCredential,
} from "./credentials.ts";
export { type DryRunCandidate, type DryRunResult, dryRun } from "./dryRun.ts";
export { type ApiKeySummary, type CreatedKey, createKey, listKeys, revokeKey } from "./keys.ts";
export {
  type ModelLimits,
  modelDisplayName,
  resolveModelLimits,
  type ServingCredential,
} from "./modelLimits.ts";
export { getModel, listModels, putModel, removeModel } from "./models.ts";
export { OAUTH_PROVIDERS } from "./oauth/index.ts";
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
export { type BurnEstimate, type BurnInput, burnEstimates, burnFor } from "./quota/burn.ts";
export {
  type GatewayRate,
  type QuotaHistoryInput,
  type QuotaHistoryResult,
  quotaHistory,
} from "./quota/history.ts";
export {
  type PollerDeps,
  poll,
  probe,
  RATE_LIMIT_COOLDOWN_MS,
  resetQuotaCooldowns,
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
export { fileExists, tailFile } from "./tail.ts";
export {
  logLimit,
  MAX_LOG_LIMIT,
  queryUsage,
  recentLogs,
  type UsageQueryInput,
} from "./usage.ts";
