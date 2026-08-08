import type { Settings, Store } from "@omni/store";
import { parseOrThrow, settingsSchema } from "./schemas.ts";

export async function getSettings(store: Store): Promise<Settings> {
  return store.config.getSettings();
}

export async function putSettings(store: Store, input: unknown): Promise<Settings> {
  const settings: Settings = parseOrThrow(settingsSchema, input);
  await store.config.putSettings(settings);
  return settings;
}
