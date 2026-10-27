import type { Settings, Store } from "@omni/store";
import { promptOperation } from "./promptErrors.ts";
import { parseOrThrow, settingsSchema } from "./schemas.ts";

export async function getSettings(store: Store): Promise<Settings> {
  return store.config.getSettings();
}

/**
 * Saves settings, and answers with what is stored rather than with what arrived.
 * Prompt assignments are optional for old clients; alias reconciliation belongs
 * to the store's locked merge, never a prior control read.
 *
 * Every field the schema requires is replaced, so this is still a whole-object
 * save. Body retention, the three guardrail fields and the five smart-router
 * fields are optional for older
 * clients, as is snapshot retention because the database panel owns it: a caller that omits either keeps the stored
 * policy, and the store's merge — not this function — decides what that means.
 */
export async function putSettings(store: Store, input: unknown): Promise<Settings> {
  const {
    prompts,
    bodyRetentionDays,
    snapshotKeepLatest,
    snapshotMaxAgeDays,
    guardrailModel,
    guardrailTimeoutMs,
    guardrailHistoryTurns,
    smartRouterEnabled,
    smartRouterClassifierModel,
    smartRouterLocalModel,
    smartRouterPolicy,
    smartRouterTimeoutMs,
    ...rest
  } = parseOrThrow(settingsSchema, input);
  // Spread rather than assigned, because `exactOptionalPropertyTypes` draws the
  // distinction this function depends on: an absent key keeps the stored value,
  // while a present `undefined` would be a write of nothing.
  const patch: Partial<Settings> = {
    ...rest,
    ...(prompts === undefined ? {} : { prompts }),
    ...(bodyRetentionDays === undefined ? {} : { bodyRetentionDays }),
    ...(snapshotKeepLatest === undefined ? {} : { snapshotKeepLatest }),
    ...(snapshotMaxAgeDays === undefined ? {} : { snapshotMaxAgeDays }),
    ...(guardrailModel === undefined ? {} : { guardrailModel }),
    ...(guardrailTimeoutMs === undefined ? {} : { guardrailTimeoutMs }),
    ...(guardrailHistoryTurns === undefined ? {} : { guardrailHistoryTurns }),
    ...(smartRouterEnabled === undefined ? {} : { smartRouterEnabled }),
    ...(smartRouterClassifierModel === undefined ? {} : { smartRouterClassifierModel }),
    ...(smartRouterLocalModel === undefined ? {} : { smartRouterLocalModel }),
    ...(smartRouterPolicy === undefined ? {} : { smartRouterPolicy }),
    ...(smartRouterTimeoutMs === undefined ? {} : { smartRouterTimeoutMs }),
  };
  return promptOperation(() => store.config.putSettings(patch));
}
