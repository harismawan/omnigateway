import type { ProviderDescriptors } from "@omni/providers/descriptors";
import { buildSnapshot, resolveModel } from "@omni/router";
import type { Store } from "@omni/store";

/**
 * Whether the installation can judge the keys that carry a usage policy.
 *
 * `null` problem is healthy — including when no key carries a policy, which is
 * the default and needs no classifier at all. `unconfigured` and `unresolved`
 * are the two states in which every request from such a key is refused: the
 * classifier model is unset, or names nothing routing can resolve. Neither is
 * refused at write time — a dangling classifier, like a dangling pin, must not
 * make an unrelated edit unsavable — so this is where an operator hears of it
 * before a client does.
 *
 * Revoked keys are not counted: nothing they send is judged.
 */
export type GuardrailReadiness = {
  keysWithPolicy: number;
  model: string | null;
  problem: "unconfigured" | "unresolved" | null;
};

export async function guardrailReadiness(
  store: Store,
  // A dependency, not a default, for the reason `dryRun` gives: the CLI's
  // installation is the one its plugin manifests describe, and the built-in
  // registry alone would call a plugin provider's model unresolvable.
  providers: ProviderDescriptors,
  now: number = Date.now(),
): Promise<GuardrailReadiness> {
  const keysWithPolicy = (await store.keys.list()).filter(
    (key) => key.revokedAt === null && key.guardrailPolicy !== null,
  ).length;
  const snapshot = await buildSnapshot(store, now);
  const model = snapshot.settings.guardrailModel;
  if (keysWithPolicy === 0) return { keysWithPolicy, model, problem: null };
  if (model === null) return { keysWithPolicy, model, problem: "unconfigured" };
  try {
    // The router's own answer, the same call dispatch makes for the classifier.
    resolveModel(model, snapshot, providers);
    return { keysWithPolicy, model, problem: null };
  } catch {
    return { keysWithPolicy, model, problem: "unresolved" };
  }
}
