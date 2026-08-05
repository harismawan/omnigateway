import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { api } from "./client.ts";
import type {
  CredentialsResponse,
  KeysResponse,
  LogsResponse,
  ModelsResponse,
  RequestLog,
  Settings,
  SettingsResponse,
  StatusResponse,
  UsageBucket,
  UsageGroupBy,
  UsageResponse,
  VirtualModel,
  WireApiKey,
  WireCredential,
} from "./types.ts";

export const qk = {
  status: () => ["status"] as const,
  credentials: () => ["credentials"] as const,
  models: () => ["models"] as const,
  settings: () => ["settings"] as const,
  keys: () => ["keys"] as const,
  usage: (groupBy: UsageGroupBy, sinceMs: number) => ["usage", groupBy, sinceMs] as const,
  logs: (limit: number) => ["logs", limit] as const,
};

export function statusQuery() {
  return queryOptions<StatusResponse>({
    queryKey: qk.status(),
    queryFn: () => api.get<StatusResponse>("/api/status"),
  });
}

export function credentialsQuery() {
  return queryOptions<WireCredential[]>({
    queryKey: qk.credentials(),
    queryFn: async () => (await api.get<CredentialsResponse>("/api/credentials")).credentials,
  });
}

export function modelsQuery() {
  return queryOptions<VirtualModel[]>({
    queryKey: qk.models(),
    queryFn: async () => (await api.get<ModelsResponse>("/api/models")).models,
  });
}

export function settingsQuery() {
  return queryOptions<Settings>({
    queryKey: qk.settings(),
    queryFn: async () => (await api.get<SettingsResponse>("/api/settings")).settings,
  });
}

export function keysQuery() {
  return queryOptions<WireApiKey[]>({
    queryKey: qk.keys(),
    queryFn: async () => (await api.get<KeysResponse>("/api/keys")).keys,
  });
}

export function usageQuery(groupBy: UsageGroupBy, sinceMs: number) {
  const query = new URLSearchParams({ groupBy, since: String(sinceMs) });
  return queryOptions<UsageBucket[]>({
    queryKey: qk.usage(groupBy, sinceMs),
    queryFn: async () => (await api.get<UsageResponse>(`/api/usage?${query}`)).rows,
  });
}

export function logsQuery(limit: number, pollMs: number) {
  return queryOptions<RequestLog[]>({
    queryKey: qk.logs(limit),
    queryFn: async () => (await api.get<LogsResponse>(`/api/logs?limit=${limit}`)).logs,
    refetchInterval: pollMs,
    staleTime: 0,
  });
}

export function useInvalidate(): (keys: readonly unknown[][]) => Promise<void> {
  const queryClient = useQueryClient();
  return async (keys) => {
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
}
