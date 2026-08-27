import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import type { Credential, CredentialHealth, QuotaWindow, Store } from "@omni/store";
import { createAdminAuth } from "./adminAuth.ts";
import { isProviderId } from "./connect.ts";
import type { Refresher } from "./oauth/refresh.ts";
import { type BurnEstimate, burnEstimates } from "./quota/burn.ts";
import { credentialPatchSchema, parseOrThrow, providerIdSchema } from "./schemas.ts";

/**
 * A credential as an operator may see it: every stored column, and nothing
 * else.
 *
 * `secrets` is a function on the view, so spreading would drop it anyway — the
 * explicit projection below makes that a decision rather than an accident.
 */
export type CredentialSummary = Credential;

function summarizeCredential(credential: Credential): CredentialSummary {
  return {
    id: credential.id,
    provider: credential.provider,
    label: credential.label,
    authType: credential.authType,
    enabled: credential.enabled,
    tier: credential.tier,
    weight: credential.weight,
    expiresAt: credential.expiresAt,
    accountEmail: credential.accountEmail,
    providerData: credential.providerData,
    disabledReason: credential.disabledReason,
    disabledAt: credential.disabledAt,
    hasRefreshToken: credential.hasRefreshToken,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

export async function listCredentials(store: Store): Promise<CredentialSummary[]> {
  return (await store.credentials.list()).map(summarizeCredential);
}

export async function getCredential(store: Store, id: string): Promise<CredentialSummary> {
  const credential = await store.credentials.get(id);
  if (credential === null) throw new GatewayError("BAD_REQUEST", "no such credential");
  return summarizeCredential(credential);
}

export type CustomProviderData = {
  endpointId: string;
  endpointLabel: string;
  /** URL origin alone; any base path lives beside it so this stays an origin. */
  origin: string;
  /**
   * Base path under which the server is reachable, e.g. `/api` for
   * `https://example.com/api/v1/chat/completions`. Empty for a bare origin.
   * Absent (not empty) on rows written before base paths were accepted, so
   * readers must default it to "".
   */
  basePath: string;
  protocol: "chat_completions" | "responses";
};

export type ApiKeyCredentialInput = {
  provider: unknown;
  apiKey: unknown;
  label?: unknown;
  endpointId?: unknown;
  endpointLabel?: unknown;
  origin?: unknown;
  protocol?: unknown;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GatewayError("BAD_REQUEST", `${field}: must not be empty`);
  }
  return value.trim();
}

function customProviderData(input: ApiKeyCredentialInput): CustomProviderData {
  const endpointId = requiredString(input.endpointId, "endpointId");
  const endpointLabel = requiredString(input.endpointLabel, "endpointLabel");
  const originInput = requiredString(input.origin, "origin");
  if (input.protocol !== "chat_completions" && input.protocol !== "responses") {
    throw new GatewayError("BAD_REQUEST", "protocol: unsupported protocol");
  }

  let url: URL;
  try {
    url = new URL(originInput);
  } catch {
    throw new GatewayError("BAD_REQUEST", "origin: must be a valid URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new GatewayError("BAD_REQUEST", "origin: must be an HTTP(S) server origin");
  }

  // A base path is allowed because reverse-proxied servers routinely live at a
  // subpath (`https://example.com/api`). Trailing slashes collapse away — a
  // bare `/` is no path at all. The WHATWG parser has already resolved dot
  // segments and kept percent-escapes intact, so nothing else needs guarding.
  const basePath = url.pathname.replace(/\/+$/, "");

  return { endpointId, endpointLabel, origin: url.origin, basePath, protocol: input.protocol };
}

function sameCustomEndpoint(a: Record<string, unknown>, b: CustomProviderData): boolean {
  // Legacy rows carry no basePath; absent means bare origin, same as "".
  const basePath = typeof a.basePath === "string" ? a.basePath : "";
  return (
    a.endpointId === b.endpointId &&
    a.endpointLabel === b.endpointLabel &&
    a.origin === b.origin &&
    basePath === b.basePath &&
    a.protocol === b.protocol
  );
}

export async function createApiKeyCredential(
  store: Store,
  input: ApiKeyCredentialInput,
  logger: Logger = noopLogger,
): Promise<CredentialSummary> {
  const provider = parseOrThrow(providerIdSchema, input.provider);
  // Format, then existence. The schema stopped being an enum over the registry
  // because that enum was a build-time snapshot — but minting an account for a
  // provider that does not exist produces a credential that stores, lists, and
  // fails on first dispatch, so the existence question is asked here instead,
  // against the registry as it stands right now.
  //
  // Deliberately not the rule `putModel` follows. A target naming a removed
  // provider is existing state an operator must still be able to edit; a new
  // credential has no such history to preserve.
  if (!isProviderId(provider)) {
    throw new GatewayError("BAD_REQUEST", `provider: no provider named "${provider}"`);
  }
  const apiKey = requiredString(input.apiKey, "apiKey");
  if (input.label !== undefined && typeof input.label !== "string") {
    throw new GatewayError("BAD_REQUEST", "label: must be a string");
  }

  let providerData: Record<string, unknown> = {};
  if (provider === "custom") {
    const custom = customProviderData(input);
    const existing = (await store.credentials.list()).filter(
      (credential) =>
        credential.provider === "custom" &&
        credential.providerData.endpointId === custom.endpointId,
    );
    if (existing.some((credential) => !sameCustomEndpoint(credential.providerData, custom))) {
      throw new GatewayError("CONFLICT", `endpointId: metadata conflicts with existing endpoint`);
    }
    providerData = custom;
  }

  const label = input.label?.trim() || `${provider} api key`;
  const created = await store.credentials.create({
    id: crypto.randomUUID(),
    provider,
    label,
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData,
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey,
    idToken: null,
  });
  logger.info("credential added", { credentialId: created.id, provider: created.provider });
  return summarizeCredential(created);
}

export async function refreshCredential(
  deps: { store: Store; refresh: Refresher },
  id: string,
): Promise<CredentialSummary> {
  const credential = await deps.store.credentials.get(id);
  if (credential === null) throw new GatewayError("BAD_REQUEST", "no such credential");
  if (credential.authType !== "oauth") {
    throw new GatewayError(
      "BAD_REQUEST",
      `credential "${id}" is an api key and has nothing to refresh`,
    );
  }

  await deps.refresh(credential);
  return getCredential(deps.store, id);
}

/**
 * Everything the console draws per credential: breaker state, the newest quota
 * reading, and what that reading implies.
 *
 * `burn` is derived rather than stored, over rows this call already loads, and
 * that is the whole budget for this route. The console refetches it every ten
 * seconds against the same synchronous connection that serves `/v1/messages`,
 * so nothing here may touch `request_logs`: the gateway-rate corroboration
 * lives on the history endpoint, where it is asked for once per expanded row.
 */
export async function credentialHealth(deps: {
  store: Store;
  now: () => number;
}): Promise<{ health: CredentialHealth[]; quota: QuotaWindow[]; burn: BurnEstimate[] }> {
  const [health, quota, settings] = await Promise.all([
    deps.store.credentials.listHealth(),
    deps.store.credentials.listQuota(),
    deps.store.config.getSettings(),
  ]);
  const burn = burnEstimates(quota, {
    now: deps.now(),
    pollIntervalMs: settings.quotaPollIntervalMs,
  });
  return { health, quota, burn };
}

export type CredentialStatus = {
  adminConfigured: boolean;
  credentials: Array<
    Pick<CredentialSummary, "id" | "provider" | "label" | "enabled"> & {
      quota: QuotaWindow[];
    }
  >;
};

export async function credentialStatus(
  store: Store,
  options: { now: () => number },
): Promise<CredentialStatus> {
  const [credentials, quota, adminConfigured] = await Promise.all([
    listCredentials(store),
    store.credentials.listQuota(),
    createAdminAuth(store, { now: options.now, sessionTtlMs: 0 }).isConfigured(),
  ]);
  const byCredential = new Map<string, QuotaWindow[]>();
  for (const row of quota) {
    const rows = byCredential.get(row.credentialId);
    if (rows === undefined) byCredential.set(row.credentialId, [row]);
    else rows.push(row);
  }

  return {
    adminConfigured,
    credentials: credentials.map(({ id, provider, label, enabled }) => ({
      id,
      provider,
      label,
      enabled,
      quota: byCredential.get(id) ?? [],
    })),
  };
}

export type CredentialPatch = {
  label?: string;
  enabled?: boolean;
  tier?: number;
  weight?: number;
};

export async function patchCredential(
  deps: { store: Store; now: () => number; logger?: Logger },
  id: string,
  input: unknown,
): Promise<void> {
  const patch = parseOrThrow(credentialPatchSchema, input);
  const existing = await deps.store.credentials.get(id);
  if (existing === null) throw new GatewayError("BAD_REQUEST", "no such credential");

  await deps.store.credentials.update(id, {
    ...(patch.label === undefined ? {} : { label: patch.label }),
    // The toggle is the operator's own verdict, so it overwrites whatever
    // reason was there. Re-enabling a credential the provider repudiated is
    // allowed: the operator may know something we do not, and the next
    // refresh will disable it again if they do not.
    ...(patch.enabled === undefined
      ? {}
      : {
          enabled: patch.enabled,
          disabledReason: patch.enabled ? null : ("manual" as const),
          disabledAt: patch.enabled ? null : deps.now(),
        }),
    ...(patch.tier === undefined ? {} : { tier: patch.tier }),
    ...(patch.weight === undefined ? {} : { weight: patch.weight }),
  });
  if (patch.enabled !== undefined && patch.enabled !== existing.enabled) {
    (deps.logger ?? noopLogger).info(patch.enabled ? "credential enabled" : "credential disabled", {
      credentialId: id,
      provider: existing.provider,
    });
  }
}

export async function removeCredential(store: Store, id: string): Promise<void> {
  await store.credentials.remove(id);
}
