import { pluginApiPath } from "@omnigateway/dashboard-sdk";
import { del, get, post, put } from "../../api/client.ts";

/**
 * The `api` the console hands a plugin's `mount`.
 *
 * The verbs are wired through the console's own `api/client.ts` rather than the
 * SDK's `createPluginApi`, deliberately: a panel rendered inside the console
 * should fail the way the console fails, with its error handling and its session
 * behaviour, not the way a standalone plugin bundle does.
 *
 * The path guard is NOT duplicated for that convenience. `pluginApiPath` is
 * imported from the SDK, because a rule about what may leave a plugin's prefix
 * held in two places is a rule that will eventually be true in only one of
 * them.
 */
export type PluginApi = {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
};

/**
 * One `PluginApi` per plugin id, for the lifetime of the page.
 *
 * A fresh object per render would be a new identity for a value derived from
 * nothing but its id, and a new identity is what turns `useEffect(…, [api])`
 * into a loop and defeats a `queryKey` built from it.
 */
const apiByPluginId = new Map<string, PluginApi>();

export function pluginApi(pluginId: string): PluginApi {
  const existing = apiByPluginId.get(pluginId);
  if (existing !== undefined) return existing;

  const created: PluginApi = {
    get: <T>(path: string, signal?: AbortSignal) => get<T>(pluginApiPath(pluginId, path), signal),
    post: <T>(path: string, body?: unknown) => post<T>(pluginApiPath(pluginId, path), body),
    put: <T>(path: string, body: unknown) => put<T>(pluginApiPath(pluginId, path), body),
    del: <T>(path: string) => del<T>(pluginApiPath(pluginId, path)),
  };
  apiByPluginId.set(pluginId, created);
  return created;
}
