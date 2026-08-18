import type { Settings, Store } from "@omni/store";
import { parseOrThrow, settingsSchema } from "./schemas.ts";

export async function getSettings(store: Store): Promise<Settings> {
  return store.config.getSettings();
}

/**
 * Saves settings, and answers with what is stored rather than with what arrived.
 *
 * Every field the schema requires is replaced, so this is still a whole-object
 * save. The difference is snapshot retention, which the schema leaves optional
 * because the database panel owns it: a caller that omits it keeps the stored
 * policy, and the store's merge — not this function — decides what that means.
 */
export async function putSettings(store: Store, input: unknown): Promise<Settings> {
  const { snapshotKeepLatest, snapshotMaxAgeDays, ...rest } = parseOrThrow(settingsSchema, input);
  // Spread rather than assigned, because `exactOptionalPropertyTypes` draws the
  // distinction this function depends on: an absent key keeps the stored value,
  // while a present `undefined` would be a write of nothing.
  const patch: Partial<Settings> = {
    ...rest,
    ...(snapshotKeepLatest === undefined ? {} : { snapshotKeepLatest }),
    ...(snapshotMaxAgeDays === undefined ? {} : { snapshotMaxAgeDays }),
  };
  return store.config.putSettings(patch);
}
