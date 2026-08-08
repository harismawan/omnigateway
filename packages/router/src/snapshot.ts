import type { QuotaWindow, Store } from "@omni/store";
import type { Snapshot } from "./types.ts";

const HEALTH_KEY_SEP = "::";

/** Health is per (credential, model); this is the composite key. */
export function healthKey(credentialId: string, model: string): string {
  return credentialId + HEALTH_KEY_SEP + model;
}

export async function buildSnapshot(store: Store, now: number): Promise<Snapshot> {
  const [credentials, healthRows, quotaRows, models, settings] = await Promise.all([
    store.credentials.listRouting(),
    store.credentials.listHealth(),
    store.credentials.listQuota(),
    store.config.listModels(),
    store.config.getSettings(),
  ]);

  const health = new Map(healthRows.map((h) => [healthKey(h.credentialId, h.model), h]));

  const quota = new Map<string, QuotaWindow[]>();
  for (const row of quotaRows) {
    const list = quota.get(row.credentialId);
    if (list === undefined) quota.set(row.credentialId, [row]);
    else list.push(row);
  }

  return {
    credentials,
    health,
    quota,
    models: new Map(models.map((m) => [m.id, m])),
    settings,
    builtAt: now,
  };
}
