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
  ConnectPollResult,
  ConnectStart,
  ConsoleResponse,
  Credential,
  CredentialHealth,
  CredentialHealthResponse,
  CredentialPatch,
  CredentialsResponse,
  DryRunNeed,
  DryRunResult,
  KeyCreateInput,
  KeysResponse,
  LogsResponse,
  MintedKey,
  ModelsResponse,
  ProviderId,
  QuotaWindow,
  RequestLog,
  Settings,
  SettingsResponse,
  SetupClient,
  SetupFile,
  SetupResponse,
  StatusResponse,
  UsageBucket,
  UsageQuery,
  UsageResponse,
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
  logs: (limit: number) => ["logs", limit] as const,
  console: (lines: number, level: string) => ["console", lines, level] as const,
};

/**
 * Polling cadence. `false` pauses a query, which is what the chassis LIVE
 * switch does — an idle console should not keep a laptop awake.
 */
export type Cadence = number | false;

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

export type HealthSnapshot = { health: CredentialHealth[]; quota: QuotaWindow[] };

export function useCredentialHealth(cadence: Cadence = 10_000): UseQueryResult<HealthSnapshot> {
  return useQuery({
    queryKey: queryKeys.credentialHealth,
    queryFn: ({ signal }) => get<CredentialHealthResponse>("/api/credentials/health", signal),
    refetchInterval: cadence,
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

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: async ({ signal }) => (await get<SettingsResponse>("/api/settings", signal)).settings,
  });
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
 * How often the request log is re-read.
 *
 * Faster than the rest of the console because the log now carries requests that
 * are still running. At ten seconds a spinner lies in both directions: a short
 * request is over before it is ever fetched, and a finished one keeps turning
 * until the next poll. Each read is a session check and one indexed SELECT
 * against local SQLite, and the LIVE switch still stops it dead.
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

/* ---------------------------------------------------------------- session -- */

export function useLogin(): UseMutationResult<{ ok: true }, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => post<{ ok: true }>("/api/login", { password }),
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
    provider: "custom";
    apiKey: string;
    endpointId: string;
    endpointLabel: string;
    origin: string;
    protocol: "chat_completions" | "responses";
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
