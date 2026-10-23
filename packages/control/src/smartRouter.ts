import type { ProviderDescriptors } from "@omni/providers/descriptors";
import { buildSnapshot, localOnlyModel, resolveModel, type Snapshot } from "@omni/router";
import type { Store } from "@omni/store";

/**
 * Whether the installation can route confidential requests safely.
 *
 * `null` problem is healthy — including when the feature is off or no live key
 * carries the flag, which is the default and needs neither model. Otherwise the
 * first failing of: `unconfigured` (either model unset), `unresolved` (either
 * names nothing routing can resolve), `notLocal` (either resolves but is not
 * served solely by `custom` endpoints, so confidential content would leave the
 * operator's hardware). In each, every flagged request is refused. None is
 * refused at write time — a dangling model, like a dangling pin, must not make
 * an unrelated edit unsavable — so this is where an operator hears of it before
 * a client does.
 *
 * Revoked keys are not counted: nothing they send is judged.
 */
export type SmartRouterReadiness = {
  enabled: boolean;
  keysWithFlag: number;
  classifierModel: string | null;
  localModel: string | null;
  problem: "unconfigured" | "unresolved" | "notLocal" | null;
};

export async function smartRouterReadiness(
  store: Store,
  // A dependency, not a default, for the reason `guardrailReadiness` gives.
  providers: ProviderDescriptors,
  now: number = Date.now(),
): Promise<SmartRouterReadiness> {
  const keysWithFlag = (await store.keys.list()).filter(
    (key) => key.revokedAt === null && key.smartRouting,
  ).length;
  const snapshot = await buildSnapshot(store, now);
  const { smartRouterEnabled: enabled, smartRouterClassifierModel: classifierModel } =
    snapshot.settings;
  const localModel = snapshot.settings.smartRouterLocalModel;
  const report = (problem: SmartRouterReadiness["problem"]): SmartRouterReadiness => ({
    enabled,
    keysWithFlag,
    classifierModel,
    localModel,
    problem,
  });
  if (!enabled || keysWithFlag === 0) return report(null);
  const { classifier, local } = smartRouterModelStatus(snapshot, providers);
  const states = [classifier, local];
  if (states.includes("unset")) return report("unconfigured");
  if (states.includes("unresolved")) return report("unresolved");
  if (states.includes("notLocal")) return report("notLocal");
  return report(null);
}

/**
 * One configured smart-router model, judged on its own: `unset`, `unresolved`
 * (names nothing routing can resolve), `notLocal` (resolves, but some target is
 * not a `custom` endpoint), or `ok`.
 */
export type SmartRouterModelState = "ok" | "unset" | "unresolved" | "notLocal";

export type SmartRouterModelStatus = {
  classifier: SmartRouterModelState;
  local: SmartRouterModelState;
};

function modelState(
  name: string | null,
  snapshot: Snapshot,
  providers: ProviderDescriptors,
): SmartRouterModelState {
  if (name === null) return "unset";
  try {
    resolveModel(name, snapshot, providers);
  } catch {
    return "unresolved";
  }
  return localOnlyModel(name, snapshot, providers) === null ? "notLocal" : "ok";
}

/**
 * Each smart-router model's state against `snapshot`, for the console's inline
 * warnings. Unlike `smartRouterReadiness` it ignores the switch and the key
 * flags: an operator choosing a model wants to hear it is wrong before turning
 * the feature on, and the console decides what the switch makes of it.
 */
export function smartRouterModelStatus(
  snapshot: Snapshot,
  providers: ProviderDescriptors,
): SmartRouterModelStatus {
  const { smartRouterClassifierModel, smartRouterLocalModel } = snapshot.settings;
  return {
    classifier: modelState(smartRouterClassifierModel, snapshot, providers),
    local: modelState(smartRouterLocalModel, snapshot, providers),
  };
}
