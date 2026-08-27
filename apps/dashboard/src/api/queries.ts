import type { Cadence } from "@omnigateway/dashboard-sdk";
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { del, get, patch, post, put, request, withQuery } from "./client.ts";
import type {
  AgentModelMapping,
  ApiKeySummary,
  BurnEstimate,
  ClientQuotaResponse,
  ConnectPollResult,
  ConnectStart,
  ConsoleResponse,
  Credential,
  CredentialHealth,
  CredentialHealthResponse,
  CredentialPatch,
  CredentialsResponse,
  DatabaseOverview,
  DryRunNeed,
  DryRunResult,
  KeyCreateInput,
  KeyLimitsInput,
  KeyModelsInput,
  KeysResponse,
  LifecycleCapability,
  LogsResponse,
  MintedKey,
  ModelsResponse,
  PluginCatalogEntry,
  PluginsResponse,
  ProviderHeadroom,
  ProviderId,
  QuotaHistoryQuery,
  QuotaHistoryResponse,
  QuotaWindow,
  RequestBodyResponse,
  RequestLog,
  RestoreResult,
  RetentionPolicy,
  Settings,
  SettingsResponse,
  SetupClient,
  SetupFile,
  SetupResponse,
  SnapshotInfo,
  SnapshotsResponse,
  StatusResponse,
  UsageBucket,
  UsageQuery,
  UsageResponse,
  VacuumResult,
  VirtualModel,
} from "./types.ts";

export const queryKeys = {
  status: ["status"] as const,
  credentials: ["credentials"] as const,
  credentialHealth: ["credentials", "health"] as const,
  models: ["models"] as const,
  keys: ["keys"] as const,
  settings: ["settings"] as const,
  agentSetup: (client: SetupClient, mapping?: AgentModelMapping) =>
    ["agent-setup", client, mapping ?? null] as const,
  usage: (query: UsageQuery) =>
    [
      "usage",
      query.grain ?? "raw",
      query.groupBy,
      query.splitBy ?? null,
      query.since,
      query.until ?? null,
    ] as const,
  quotaHistory: (query: QuotaHistoryQuery) =>
    ["quota-history", query.credentialId, query.since, query.until ?? null] as const,
  logs: (limit: number) => ["logs", limit] as const,
  requestBody: (requestId: string) => ["logs", "body", requestId] as const,
  /**
   * The client surface's own keys, under prefixes the console never uses.
   *
   * Separate prefixes and not a scoped variant of `usage` / `logs`, because the
   * two answer different questions and the invalidation map routes by prefix: a
   * `res:usage` frame invalidating `["usage", …]` must not also drop a client's
   * cache under a key that means something else.
   */
  clientSummary: ["client", "summary"] as const,
  clientUsage: (query: UsageQuery) =>
    [
      "client",
      "usage",
      query.grain ?? "raw",
      query.groupBy,
      query.splitBy ?? null,
      query.since,
      query.until ?? null,
    ] as const,
  clientLogs: (limit: number) => ["client", "logs", limit] as const,
  clientQuota: ["client", "quota"] as const,
  console: (lines: number, level: string) => ["console", lines, level] as const,
  database: ["database"] as const,
  snapshots: ["database", "snapshots"] as const,
  lifecycle: ["lifecycle"] as const,
  plugins: ["plugins"] as const,
};

/**
 * Refresh cadence. `false` means this query does not refetch on its own, which
 * two different things now ask for: the chassis LIVE switch, because an idle
 * console should not keep a laptop awake, and a topic the push socket is
 * carrying, because an interval on top of a live feed is duplicated work.
 *
 * Every hook below still just receives a number or `false`. Which of the two
 * reasons produced it is decided in `cadence`, and none of these hooks knows a
 * socket exists — that is what lets `src/session/stream.tsx` fall back to
 * polling by re-rendering rather than by reaching into any of them.
 *
 * Defined beside the `cadence` that produces it, which is in the SDK now that a
 * plugin panel reads the same switch. Re-exported here because every hook below
 * takes one and this is where a reader of those signatures looks.
 */
export type { Cadence };

export function useStatus(): UseQueryResult<StatusResponse> {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => get<StatusResponse>("/api/status", signal),
    // The session cookie can expire while the tab sits open.
    staleTime: 30_000,
  });
}

export function useCredentials(): UseQueryResult<Credential[]> {
  return useQuery({
    queryKey: queryKeys.credentials,
    queryFn: async ({ signal }) =>
      (await get<CredentialsResponse>("/api/credentials", signal)).credentials,
  });
}

export type HealthSnapshot = {
  health: CredentialHealth[];
  quota: QuotaWindow[];
  /** Derived server-side, so the boards and the CLI cannot disagree about it. */
  burn: BurnEstimate[];
};

export function useCredentialHealth(cadence: Cadence = 10_000): UseQueryResult<HealthSnapshot> {
  return useQuery({
    queryKey: queryKeys.credentialHealth,
    queryFn: ({ signal }) => get<CredentialHealthResponse>("/api/credentials/health", signal),
    refetchInterval: cadence,
  });
}

/**
 * The retained readings behind one account's quota chart, and the gateway rate
 * that corroborates them.
 *
 * Deliberately without a refetch interval, unlike credential health: this is
 * read only while a row is expanded, and the rows it draws are appended at the
 * provider poll interval rather than at request speed. That is also why the
 * gateway rate is here — it costs a request-log aggregate per window, which a
 * ten-second poll cannot afford. `enabled` is false when no window can be
 * placed on a timeline, so a span that means nothing is never asked for.
 */
export function useQuotaHistory(
  query: QuotaHistoryQuery,
  enabled = true,
): UseQueryResult<QuotaHistoryResponse> {
  return useQuery({
    queryKey: queryKeys.quotaHistory(query),
    enabled,
    queryFn: ({ signal }) =>
      get<QuotaHistoryResponse>(
        withQuery("/api/credentials/quota/history", {
          credentialId: query.credentialId,
          since: query.since,
          ...(query.until === undefined ? {} : { until: query.until }),
        }),
        signal,
      ),
    refetchInterval: false,
  });
}

export function useModels(): UseQueryResult<VirtualModel[]> {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: async ({ signal }) => (await get<ModelsResponse>("/api/models", signal)).models,
  });
}

export function useKeys(): UseQueryResult<ApiKeySummary[]> {
  return useQuery({
    queryKey: queryKeys.keys,
    queryFn: async ({ signal }) => (await get<KeysResponse>("/api/keys", signal)).keys,
  });
}

/**
 * One fetch of `/api/settings`, read two ways.
 *
 * The route answers with the settings and with whether the environment permits
 * body capture, and both hooks below select from the same cache entry rather
 * than issuing a request each. Splitting them keeps the common case — a board
 * that wants the settings — reading exactly as it did before the second field
 * existed.
 */
const settingsQuery = {
  queryKey: queryKeys.settings,
  queryFn: ({ signal }: { signal: AbortSignal }) => get<SettingsResponse>("/api/settings", signal),
};

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({ ...settingsQuery, select: (response) => response.settings });
}

/**
 * Whether body capture is actually happening, which needs both keys.
 *
 * `OMNI_BODY_LOGGING_ALLOWED` is read at boot and the setting is flipped at
 * runtime; either one off means nothing is recorded. Surfaces that state what
 * this gateway does with prompts must answer on the pair, because answering on
 * the setting alone tells an operator their prompts are being kept when the
 * environment never permitted it.
 */
export function useBodyLoggingActive(): UseQueryResult<boolean> {
  return useQuery({
    ...settingsQuery,
    select: (response) => response.bodyLoggingAllowed && response.settings.bodyLoggingEnabled,
  });
}

/** Whether the environment permits capture at all, regardless of the setting. */
export function useBodyLoggingAllowed(): UseQueryResult<boolean> {
  return useQuery({ ...settingsQuery, select: (response) => response.bodyLoggingAllowed });
}

/**
 * The configuration files an agent needs to reach this gateway.
 *
 * Fetched rather than built here: each entry's context window is resolved by
 * the same code `GET /v1/models` uses, and a console deriving it separately
 * would eventually disagree with the gateway about what a pool holds. The key
 * in these files is always a placeholder — the store keeps only hashes.
 */
export function useAgentSetup(
  client: SetupClient,
  mapping?: AgentModelMapping,
): UseQueryResult<SetupFile[]> {
  return useQuery({
    queryKey: queryKeys.agentSetup(client, mapping),
    enabled: mapping !== undefined,
    queryFn: async ({ signal }) =>
      (
        await get<SetupResponse>(
          withQuery("/api/agent-setup", {
            client,
            ...(mapping ?? {}),
          }),
          signal,
        )
      ).files,
  });
}

export function useUsage(
  query: UsageQuery,
  cadence: Cadence = 60_000,
): UseQueryResult<UsageBucket[]> {
  return useQuery({
    queryKey: queryKeys.usage(query),
    queryFn: async ({ signal }) =>
      (
        await get<UsageResponse>(
          withQuery("/api/usage", {
            groupBy: query.groupBy,
            since: query.since,
            ...(query.grain === undefined ? {} : { grain: query.grain }),
            ...(query.splitBy === undefined ? {} : { splitBy: query.splitBy }),
            ...(query.until === undefined ? {} : { until: query.until }),
          }),
          signal,
        )
      ).rows,
    refetchInterval: cadence,
  });
}

/**
 * How often the request log is re-read when nothing is pushing it.
 *
 * Faster than the rest of the console because the log now carries requests that
 * are still running. At ten seconds a spinner lies in both directions: a short
 * request is over before it is ever fetched, and a finished one keeps turning
 * until the next poll. Each read is a session check and one indexed SELECT
 * against local SQLite, and the LIVE switch still stops it dead.
 *
 * With a healthy socket `res:logs` replaces this interval rather than shortening
 * it: the gateway coalesces that topic to at most one frame per second, so push
 * is strictly fewer reads than the two-second timer and never more.
 */
export const LOG_CADENCE_MS = 2_000;

export function useLogs(
  limit = 100,
  cadence: Cadence = LOG_CADENCE_MS,
): UseQueryResult<RequestLog[]> {
  return useQuery({
    queryKey: queryKeys.logs(limit),
    queryFn: async ({ signal }) =>
      (await get<LogsResponse>(withQuery("/api/logs", { limit }), signal)).logs,
    refetchInterval: cadence,
  });
}

/**
 * One request's captured bodies.
 *
 * Fetched only while a row is expanded, and never polled: an artifact is written
 * once, at the end of the request, and nothing rewrites it afterwards. It is
 * also the largest and most sensitive thing this console can ask for, which is
 * reason enough not to put it on a two-second timer beside the log itself.
 *
 * `enabled` is false with no row open, so closing the modal stops the fetch
 * rather than leaving a request in flight for a body nobody is looking at.
 */
export function useRequestBody(requestId: string | null): UseQueryResult<RequestBodyResponse> {
  return useQuery({
    queryKey: queryKeys.requestBody(requestId ?? ""),
    enabled: requestId !== null,
    queryFn: ({ signal }) =>
      get<RequestBodyResponse>(`/api/requests/${encodeURIComponent(requestId ?? "")}/body`, signal),
    refetchInterval: false,
  });
}

/**
 * How often the gateway's own output is re-read.
 *
 * Slower than the request log, which carries in-flight requests a spinner has
 * to keep up with. Console lines are written by boot, refresh, and quota work,
 * none of which moves at request speed.
 */
export const CONSOLE_CADENCE_MS = 5_000;

export function useConsole(
  lines = 200,
  level = "",
  cadence: Cadence = CONSOLE_CADENCE_MS,
): UseQueryResult<ConsoleResponse> {
  return useQuery({
    queryKey: queryKeys.console(lines, level),
    queryFn: async ({ signal }) =>
      get<ConsoleResponse>(
        withQuery("/api/console", { lines, ...(level === "" ? {} : { level }) }),
        signal,
      ),
    refetchInterval: cadence,
  });
}

/* --------------------------------------------------------------- database -- */

/**
 * How big the database is and what a vacuum would give back.
 *
 * Not polled. Every figure here moves on an hourly maintenance sweep or on an
 * operation the operator just performed, and both of those invalidate this key
 * themselves.
 */
export function useDatabaseOverview(): UseQueryResult<DatabaseOverview> {
  return useQuery({
    queryKey: queryKeys.database,
    queryFn: ({ signal }) => get<DatabaseOverview>("/api/database", signal),
    refetchInterval: false,
  });
}

/**
 * Where a snapshot is, for a link rather than for a fetch.
 *
 * Not a hook and not a mutation on purpose: the response is a whole database
 * and a secret-bearing one, so it is never read into this process. The browser
 * follows the URL, sends the same-origin session cookie the route requires, and
 * streams the file to disk.
 */
export function snapshotDownloadUrl(id: string): string {
  return `/api/database/snapshots/${encodeURIComponent(id)}/download`;
}

export function useSnapshots(): UseQueryResult<SnapshotInfo[]> {
  return useQuery({
    queryKey: queryKeys.snapshots,
    queryFn: async ({ signal }) =>
      (await get<SnapshotsResponse>("/api/database/snapshots", signal)).snapshots,
    refetchInterval: false,
  });
}

/**
 * Everything a whole-database operation makes stale.
 *
 * The size figures and the snapshot list move together — a snapshot changes the
 * count on the overview, a vacuum changes the bytes the next snapshot will be —
 * so they are invalidated as a pair rather than one at a time.
 */
function invalidateDatabase(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: queryKeys.database });
}

export function useCreateSnapshot(): UseMutationResult<SnapshotInfo, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => post<SnapshotInfo>("/api/database/snapshots"),
    onSuccess: () => invalidateDatabase(client),
  });
}

export function useSaveRetention(): UseMutationResult<RetentionPolicy, Error, RetentionPolicy> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (policy: RetentionPolicy) =>
      put<RetentionPolicy>("/api/database/retention", policy),
    onSuccess: () => {
      invalidateDatabase(client);
      // The policy lives in `Settings`, which the settings screen also reads.
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export function useVacuum(): UseMutationResult<VacuumResult, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => post<VacuumResult>("/api/database/vacuum"),
    onSuccess: () => invalidateDatabase(client),
  });
}

export function useDeleteSnapshot(): UseMutationResult<{ ok: true }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      del<{ ok: true }>(`/api/database/snapshots/${encodeURIComponent(id)}`),
    onSuccess: () => invalidateDatabase(client),
  });
}

/**
 * Puts a snapshot back in place of the live database.
 *
 * Nothing is invalidated here. The caller has to read `adminPasswordChanged`
 * first: when it is true the gateway has already ended every admin session, and
 * a refetch fired from `onSuccess` would race the caller to the same dead cookie
 * and turn a clean sign-out into a screen of failures.
 */
export function useRestoreSnapshot(): UseMutationResult<RestoreResult, Error, string> {
  return useMutation({
    mutationFn: (id: string) =>
      post<RestoreResult>(`/api/database/snapshots/${encodeURIComponent(id)}/restore`),
  });
}

/**
 * Puts a database the operator supplied in place of the live one.
 *
 * The same operation as a restore with a different source, so it answers with
 * the same shape and the same `adminPasswordChanged` rule applies — which is why
 * this, too, invalidates nothing on its own.
 */
export function useImportDatabase(): UseMutationResult<RestoreResult, Error, File> {
  return useMutation({
    mutationFn: (file: File) => post<RestoreResult>("/api/database/import", file),
  });
}

/* -------------------------------------------------------------- lifecycle -- */

/**
 * Whether a restart would restart anything.
 *
 * Read from the gateway rather than assumed, because the answer is a property of
 * how this installation was started: a unit under systemd, a container, or a
 * process nothing is watching.
 */
export function useLifecycle(): UseQueryResult<LifecycleCapability> {
  return useQuery({
    queryKey: queryKeys.lifecycle,
    queryFn: ({ signal }) => get<LifecycleCapability>("/api/lifecycle", signal),
    refetchInterval: false,
  });
}

/**
 * Asks the gateway to restart, and nothing more.
 *
 * The response arrives before the process goes anywhere, so a success here means
 * the request was accepted rather than that anything has happened yet. Waiting
 * for the gateway to come back is the caller's job, and it cannot be done
 * through this client: the whole point is the window where nothing answers.
 */
export function useRestart(): UseMutationResult<{ ok: true }, Error, void> {
  return useMutation({ mutationFn: () => post<{ ok: true }>("/api/lifecycle/restart") });
}

export function useShutdown(): UseMutationResult<{ ok: true }, Error, void> {
  return useMutation({ mutationFn: () => post<{ ok: true }>("/api/lifecycle/shutdown") });
}

/* ---------------------------------------------------------------- session -- */

/** Which credential a login attempt is presenting. */
export type LoginMode = "admin" | "viewer" | "client";

export type LoginInput = { mode: LoginMode; secret: string };

/**
 * Signs in as one of the three principals.
 *
 * The mode is carried explicitly rather than inferred from what the secret looks
 * like. A gateway API key and a password are both strings, and a heuristic that
 * guessed would send one to the wrong endpoint on the day a password happens to
 * start with the key prefix.
 */
export function useLogin(): UseMutationResult<{ ok: true }, Error, LoginInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ mode, secret }: LoginInput) =>
      mode === "client"
        ? post<{ ok: true }>("/api/client/login", { key: secret })
        : post<{ ok: true }>("/api/login", {
            password: secret,
            ...(mode === "viewer" ? { mode: "viewer" } : {}),
          }),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSetup(): UseMutationResult<{ ok: true }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => post<{ ok: true }>("/api/setup", { password }),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useLogout(): UseMutationResult<{ ok: true }, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ ok: true }>("/api/logout"),
    onSuccess: () => {
      // Nothing cached survives a sign-out; the next operator starts clean.
      client.clear();
    },
  });
}

export function useClientLogout(): UseMutationResult<{ ok: true }, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ ok: true }>("/api/client/logout"),
    onSuccess: () => client.clear(),
  });
}

/* ----------------------------------------------------------------- client -- */

/**
 * The client surface's reads.
 *
 * Four hooks against `/api/client/*` rather than the console's hooks with a
 * parameter. The narrowing is the server's, not a query argument — a hook that
 * took a key id would put the scope in the caller's hands, which is the shape
 * this whole surface exists to avoid.
 */
export function useClientSummary(): UseQueryResult<ApiKeySummary> {
  return useQuery({
    queryKey: queryKeys.clientSummary,
    queryFn: ({ signal }) => get<ApiKeySummary>("/api/client/summary", signal),
  });
}

export function useClientUsage(
  query: UsageQuery,
  cadence: Cadence = 60_000,
): UseQueryResult<UsageBucket[]> {
  return useQuery({
    queryKey: queryKeys.clientUsage(query),
    queryFn: ({ signal }) =>
      get<UsageBucket[]>(
        withQuery("/api/client/usage", {
          groupBy: query.groupBy,
          since: query.since,
          ...(query.grain === undefined ? {} : { grain: query.grain }),
          ...(query.splitBy === undefined ? {} : { splitBy: query.splitBy }),
          ...(query.until === undefined ? {} : { until: query.until }),
        }),
        signal,
      ),
    refetchInterval: cadence,
  });
}

export function useClientLogs(
  limit = 100,
  cadence: Cadence = LOG_CADENCE_MS,
): UseQueryResult<RequestLog[]> {
  return useQuery({
    queryKey: queryKeys.clientLogs(limit),
    queryFn: async ({ signal }) =>
      (await get<LogsResponse>(withQuery("/api/client/logs", { limit }), signal)).logs,
    refetchInterval: cadence,
  });
}

export function useClientQuota(cadence: Cadence = 60_000): UseQueryResult<ProviderHeadroom[]> {
  return useQuery({
    queryKey: queryKeys.clientQuota,
    queryFn: async ({ signal }) =>
      (await get<ClientQuotaResponse>("/api/client/quota", signal)).headroom,
    refetchInterval: cadence,
  });
}

/* ------------------------------------------------------------ credentials -- */

export function useUpdateCredential(): UseMutationResult<
  { ok: true },
  Error,
  { id: string; patch: CredentialPatch }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch: body }) => patch<{ ok: true }>(`/api/credentials/${id}`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.credentials });
      void client.invalidateQueries({ queryKey: queryKeys.credentialHealth });
    },
  });
}

export function useDeleteCredential(): UseMutationResult<{ ok: true }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del<{ ok: true }>(`/api/credentials/${id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.credentials });
      void client.invalidateQueries({ queryKey: queryKeys.credentialHealth });
    },
  });
}

/* ----------------------------------------------------------------- models -- */

export function useSaveModel(): UseMutationResult<{ ok: true }, Error, VirtualModel> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (model: VirtualModel) => put<{ ok: true }>(`/api/models/${model.id}`, model),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.models }),
  });
}

export function useDeleteModel(): UseMutationResult<{ ok: true }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del<{ ok: true }>(`/api/models/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.models }),
  });
}

export function useDryRun(): UseMutationResult<
  DryRunResult,
  Error,
  { modelId: string; need: DryRunNeed }
> {
  return useMutation({
    mutationFn: ({ modelId, need }) => post<DryRunResult>(`/api/models/${modelId}/dry-run`, need),
  });
}

/* ------------------------------------------------------------------- keys -- */

export function useCreateKey(): UseMutationResult<MintedKey, Error, KeyCreateInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: KeyCreateInput) => post<MintedKey>("/api/keys", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

/**
 * Replaces one key's limits.
 *
 * One of two fields editable after minting — the allowlist via
 * `useSetKeyModels` is the other. `bodyLoggingOptOut` has no mutation like
 * this on purpose: it is a promise to whoever holds the key, while a limit is
 * the operator's own ceiling on their own installation.
 */
export function useSetKeyLimits(): UseMutationResult<
  ApiKeySummary,
  Error,
  { id: string } & KeyLimitsInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, limits }) => put<ApiKeySummary>(`/api/keys/${id}/limits`, { limits }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

/**
 * Replaces one key's model allowlist.
 *
 * The other field on a key that is editable after minting, for the same reason
 * as the matrix: an allowlist that cannot be adjusted without minting a new key
 * and redeploying every client is one that gets set to unrestricted instead.
 */
export function useSetKeyModels(): UseMutationResult<
  ApiKeySummary,
  Error,
  { id: string } & KeyModelsInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, modelAllowlist }) =>
      put<ApiKeySummary>(`/api/keys/${id}/models`, { modelAllowlist }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

export function useRevokeKey(): UseMutationResult<{ ok: true }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del<{ ok: true }>(`/api/keys/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

/* --------------------------------------------------------------- settings -- */

export function useSaveSettings(): UseMutationResult<{ ok: true }, Error, Settings> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: Settings) => put<{ ok: true }>("/api/settings", settings),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

/* ---------------------------------------------------------------- connect -- */

export function useConnectStart(): UseMutationResult<
  ConnectStart,
  Error,
  { provider: ProviderId; label: string }
> {
  return useMutation({
    mutationFn: (input) => post<ConnectStart>("/api/connect/start", input),
  });
}

export function useCreateApiKeyCredential(): UseMutationResult<
  { credential: Credential },
  Error,
  {
    provider: ProviderId;
    apiKey: string;
    /**
     * Custom's endpoint metadata, absent for every other provider: the gateway
     * reads these only when the provider is `custom` and the adapter supplies
     * its own address otherwise.
     */
    endpointId?: string;
    endpointLabel?: string;
    origin?: string;
    protocol?: "chat_completions" | "responses";
    label?: string | undefined;
  }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input) => post<{ credential: Credential }>("/api/credentials", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.credentials }),
  });
}

export function useConnectFinish(): UseMutationResult<
  { id: string },
  Error,
  { flowId: string; code: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input) => post<{ id: string }>("/api/connect/finish", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.credentials }),
  });
}

/**
 * Which plugins this installation runs.
 *
 * Held for a long time on purpose: plugins are loaded at boot and installing one
 * reports that a restart is required, so the set cannot change under a console
 * that stays open. The rail reads this on every screen, and a refetch per
 * navigation would be a request whose answer is known not to have moved.
 */
export function usePlugins(): UseQueryResult<PluginCatalogEntry[]> {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: async ({ signal }) => (await get<PluginsResponse>("/api/plugins", signal)).plugins,
    staleTime: 5 * 60_000,
  });
}

/**
 * One poll of a device-code flow.
 *
 * The route answers 202 while the operator has not finished authorizing, which
 * is a normal outcome rather than a failure, so it is accepted and reported as
 * `pending`.
 */
export async function pollConnect(flowId: string): Promise<ConnectPollResult> {
  const result = await request<ConnectPollResult>("/api/connect/poll", {
    method: "POST",
    body: { flowId },
    accept: [202],
  });
  if (result.status === 202) return { status: "pending" };
  return result.data;
}
