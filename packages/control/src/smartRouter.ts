import type { ProviderDescriptors } from "@omni/providers/descriptors";
import { buildSnapshot, localOnlyModel, resolveModel } from "@omni/router";
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
  if (classifierModel === null || localModel === null) return report("unconfigured");
  const names = [classifierModel, localModel];
  for (const name of names) {
    try {
      resolveModel(name, snapshot, providers);
    } catch {
      return report("unresolved");
    }
  }
  if (names.some((name) => localOnlyModel(name, snapshot, providers) === null)) {
    return report("notLocal");
  }
  return report(null);
}
