import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import type { Credential, CredentialHealth, QuotaWindow, Store } from "@omni/store";
import { createAdminAuth } from "./adminAuth.ts";
import type { Refresher } from "./oauth/refresh.ts";
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

export async function createApiKeyCredential(
  store: Store,
  input: { provider: unknown; apiKey: unknown; label?: unknown },
  logger: Logger = noopLogger,
): Promise<CredentialSummary> {
  const provider = parseOrThrow(providerIdSchema, input.provider);
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    throw new GatewayError("BAD_REQUEST", "apiKey: must not be empty");
  }
  if (input.label !== undefined && typeof input.label !== "string") {
    throw new GatewayError("BAD_REQUEST", "label: must be a string");
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
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: input.apiKey,
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

export async function credentialHealth(
  store: Store,
): Promise<{ health: CredentialHealth[]; quota: QuotaWindow[] }> {
  const [health, quota] = await Promise.all([
    store.credentials.listHealth(),
    store.credentials.listQuota(),
  ]);
  return { health, quota };
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
