import { GatewayError } from "@omni/ir";
import type { Store } from "@omni/store";

/** How many request rows travel per read. */
const PAGE = 1_000;

export type CopyCounts = {
  credentials: number;
  apiKeys: number;
  models: number;
  requestLogs: number;
  /** Rows skipped because they were still pending, or carried no completion. */
  skippedPending: number;
};

export type CopyReport = {
  counts: CopyCounts;
  /** What was not carried, by name, so the operator reads it here and not in an incident. */
  notCarried: readonly string[];
};

/** What one installation holds that another backend must receive before it can serve. */
export const NOT_CARRIED = [
  "request bodies (the artifact corpus stays with the source; body rows are not written)",
  "usage_daily older than the retained request logs (rebuilt from the rows that are carried)",
  "quota readings and credential health (re-probed and re-measured within one poll interval)",
  "sessions and pending OAuth flows (ephemeral; every operator logs in again)",
  "plugin_* tables (their SQL is the source dialect's; carry them by hand)",
] as const;

/**
 * Copies the essential state of one store into an empty one.
 *
 * Everything goes through the `Store` interface, so the target encrypts with
 * its own key from the plaintext the source decrypted — which is why both must
 * be opened with the same `OMNI_ENCRYPTION_KEY`, and why nothing here touches
 * ciphertext. Request rows are written through `append`, which rebuilds the
 * hourly rollup and `usage_daily` as a side effect; a final `rebuildRollup`
 * makes the target's derived tables agree with what it now holds.
 *
 * Refuses a target that already holds anything: a copy onto a live install is
 * a merge, and a merge has no right answer for a duplicate key.
 */
export async function copyStore(source: Store, target: Store): Promise<CopyReport> {
  const [keys, models, credentials, hash] = await Promise.all([
    target.keys.list(),
    target.config.listModels(),
    target.credentials.list(),
    target.config.getAdminPasswordHash(),
  ]);
  if (keys.length > 0 || models.length > 0 || credentials.length > 0 || hash !== null) {
    throw new GatewayError("CONFLICT", "the target already holds data; copy into an empty store");
  }

  // Every refusal the copy can make is made before anything is written, so a
  // failure never leaves a half-filled target that the retry then refuses.
  const keys_ = await source.keys.list();
  for (const key of keys_) {
    if (key.limits === null) {
      throw new GatewayError(
        "BAD_REQUEST",
        `api key ${key.id} has unreadable limits; repair it first`,
      );
    }
  }

  const counts: CopyCounts = {
    credentials: 0,
    apiKeys: 0,
    models: 0,
    requestLogs: 0,
    skippedPending: 0,
  };

  // Configuration first, so a copy that fails part-way through the logs leaves
  // an installation that can at least be logged into and route.
  const settings = await source.config.getSettings();
  await target.config.putSettings(settings);
  const adminHash = await source.config.getAdminPasswordHash();
  if (adminHash !== null) await target.config.setAdminPasswordHash(adminHash);
  await target.config.setViewerPasswordHash(await source.config.getViewerPasswordHash());

  for (const credential of await source.credentials.list()) {
    const secrets = await credential.secrets();
    const {
      secrets: _s,
      openForInference: _i,
      openForRefresh: _r,
      openForUsage: _u,
      createdAt: _c,
      updatedAt: _up,
      hasRefreshToken: _h,
      tokenVersion: _v,
      ...meta
    } = credential;
    await target.credentials.create({ ...meta, ...secrets });
    counts.credentials += 1;
  }

  for (const model of await source.config.listModels()) {
    await target.config.putModel(model);
    counts.models += 1;
  }

  for (const key of keys_) {
    await target.keys.importRow(key);
    counts.apiKeys += 1;
  }

  let cursor: { at: number; id: string } | null = null;
  for (;;) {
    const page = await source.usage.scan(cursor, PAGE);
    if (page.length === 0) break;
    for (const log of page) {
      if (log.state !== "done") {
        counts.skippedPending += 1;
        continue;
      }
      await target.usage.append(log);
      counts.requestLogs += 1;
    }
    const last = page[page.length - 1];
    if (last === undefined) break;
    cursor = { at: last.at, id: last.id };
  }
  await target.usage.rebuildRollup();

  return { counts, notCarried: NOT_CARRIED };
}
