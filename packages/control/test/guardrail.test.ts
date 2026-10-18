import { expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { memoryStore, seedApiKey, target, virtualModel } from "@omni/testkit";
import { guardrailReadiness } from "../src/guardrail.ts";

test("readiness counts live keys with a policy and asks the router whether the classifier resolves", async () => {
  const store = await memoryStore();
  await seedApiKey(store, { guardrailPolicy: null });
  const revoked = await seedApiKey(store, { guardrailPolicy: "Work only." });
  await store.keys.revoke(revoked.key.id);
  // A revoked key sends nothing, so nothing of its needs judging.
  expect(await guardrailReadiness(store, PROVIDER_DESCRIPTORS)).toEqual({
    keysWithPolicy: 0,
    model: null,
    problem: null,
  });

  await seedApiKey(store, { guardrailPolicy: "Work only." });
  expect((await guardrailReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("unconfigured");

  await store.config.putSettings({ guardrailModel: "judge" });
  expect((await guardrailReadiness(store, PROVIDER_DESCRIPTORS)).problem).toBe("unresolved");

  await store.config.putModel(virtualModel({ id: "judge", targets: [target()] }));
  expect(await guardrailReadiness(store, PROVIDER_DESCRIPTORS)).toEqual({
    keysWithPolicy: 1,
    model: "judge",
    problem: null,
  });
  store.close();
});
