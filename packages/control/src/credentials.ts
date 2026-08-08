import { GatewayError } from "@omni/ir";
import type { Credential, CredentialHealth, QuotaWindow, Store } from "@omni/store";
import { credentialPatchSchema, parseOrThrow } from "./schemas.ts";

/**
 * A credential as an operator may see it: every stored column, and nothing
 * else.
 *
 * `secrets` is a function on the view, so spreading would drop it anyway — the
 * explicit projection below makes that a decision rather than an accident.
 */
export type CredentialSummary = Credential;

export async function listCredentials(store: Store): Promise<CredentialSummary[]> {
  const credentials = await store.credentials.list();
  return credentials.map((c) => ({
    id: c.id,
    provider: c.provider,
    label: c.label,
    authType: c.authType,
    enabled: c.enabled,
    tier: c.tier,
    weight: c.weight,
    expiresAt: c.expiresAt,
    accountEmail: c.accountEmail,
    providerData: c.providerData,
    disabledReason: c.disabledReason,
    disabledAt: c.disabledAt,
    hasRefreshToken: c.hasRefreshToken,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
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

export type CredentialPatch = {
  label?: string;
  enabled?: boolean;
  tier?: number;
  weight?: number;
};

export async function patchCredential(
  deps: { store: Store; now: () => number },
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
}

export async function removeCredential(store: Store, id: string): Promise<void> {
  await store.credentials.remove(id);
}
