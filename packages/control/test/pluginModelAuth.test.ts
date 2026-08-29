/**
 * `putModel`'s reachability check, asked about a provider that arrived at boot.
 *
 * The check reads which credential kinds can serve a model. It asked
 * `PROVIDER_MODEL_CATALOG`, keyed by provider id and built at import — and
 * `registerProvider` mutates `PROVIDER_DESCRIPTORS` and deliberately not that
 * table, so a provider loaded from `<root>/plugins/` is never in it. The lookup
 * therefore returned the fail-open "either kind" for every plugin provider,
 * while the descriptor sat in the registry saying otherwise.
 *
 * Fail-open is the right default for a provider nothing can describe. It is the
 * wrong answer when the description is right there: `putModel` saved a target
 * whose model the operator's only account cannot reach, and the console's model
 * picker — reading the same fact off `/api/catalog`, which does resolve
 * descriptors — hid that model. Two surfaces disagreeing about which account
 * serves which model is the failure `packages/control/src/catalog.ts` names as
 * its whole reason for resolving model auth server-side.
 *
 * This is the last of the reads CLAUDE.md tracks under "a module-scope snapshot
 * over a provider table". The five before it were found one at a time.
 */

import { afterEach, expect, test } from "bun:test";
import { ADAPTERS, type ProviderAdapter, registerProvider } from "@omni/providers";
import type { ProviderDescriptor } from "@omni/providers/descriptors";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { memoryStore, seedCredential } from "@omni/testkit";
import { putModel } from "../src/models.ts";

const ID = "authcheck-ai";

/**
 * Registered and then removed by hand.
 *
 * `registerProvider` has no inverse — a gateway registers at boot and lives with
 * it. A test cannot: `packages/providers/test/descriptor.test.ts` asserts the
 * descriptor key set equals a literal, so a provider left behind fails a file
 * that never mentioned this one. The delete uses the same cast the registry
 * writes through, which is the honest way to say this reaches past the API.
 */
afterEach(() => {
  delete (PROVIDER_DESCRIPTORS as Record<string, ProviderDescriptor>)[ID];
  delete (ADAPTERS as Record<string, ProviderAdapter>)[ID];
});

function install(auth: readonly ("oauth" | "apiKey")[]): void {
  const descriptor = {
    id: ID,
    capabilities: { tools: true, images: false, reasoning: false },
    writeOverInput: { fiveMinute: 1.25, oneHour: 2 },
    catalog: {
      defaultModel: "ac-1",
      authTypes: ["oauth", "apiKey"] as const,
      models: [
        {
          id: "ac-1",
          label: "Authcheck One",
          auth,
          pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
          limits: { contextWindow: 123000, maxOutputTokens: 4096 },
        },
      ],
    },
    modelPrefixes: ["ac-"],
    presentation: {
      label: "Authcheck",
      order: 90,
      tone: "cyan",
      colour: { light: "oklch(0.5 0.03 258)", dark: "oklch(0.72 0.03 258)" },
    },
  } as unknown as ProviderDescriptor;
  registerProvider(descriptor, {} as ProviderAdapter);
}

const model = {
  id: "m",
  strategy: "score" as const,
  isAlias: false,
  targets: [
    {
      provider: ID,
      model: "ac-1",
      tier: 1,
      weight: 1,
      costPerMTok: { input: 5, output: 25 },
      capabilities: { tools: true, images: false, reasoning: false },
    },
  ],
};

test("a plugin provider's declared model auth is enforced at write time", async () => {
  // The descriptor says this model is OAuth-only; the installation holds an API
  // key for it and nothing else. Before this, the lookup missed the descriptor,
  // answered "either kind", and the target saved.
  install(["oauth"]);
  const store = await memoryStore();
  await seedCredential(store, { id: "ac-key", provider: ID, authType: "apiKey", label: "the key" });

  const error: unknown = await putModel(store, "m", model).then(
    () => null,
    (thrown: unknown) => thrown,
  );

  expect(error).not.toBeNull();
  // Three things, because a refusal naming only one of them sends the operator
  // to the wrong place: the model, what it needs, and what they actually hold.
  const message = (error as Error).message;
  expect(message).toContain("ac-1");
  expect(message).toContain("OAuth credentials only");
  expect(message).toContain("every authcheck-ai credential here is API key");
  store.close();
});

test("the same target saves once the declared auth matches what is held", async () => {
  // The positive control. A check that refused every plugin target would satisfy
  // the test above and make the whole capability unusable.
  install(["apiKey"]);
  const store = await memoryStore();
  await seedCredential(store, { id: "ac-key", provider: ID, authType: "apiKey", label: "the key" });

  await putModel(store, "m", model);
  expect((await store.config.listModels()).map((row) => row.id)).toContain("m");
  store.close();
});

test("a provider no build contains is still unknown rather than forbidden", async () => {
  // The fail-open default, which the fix must not take away: nothing is
  // registered under this id, so nothing describes what it can reach, and a
  // target naming it must still save. An empty answer here would refuse every
  // target of a provider whose plugin is not installed yet — the exact case a
  // restore lands in.
  const store = await memoryStore();
  await seedCredential(store, { id: "ac-key", provider: ID, authType: "apiKey", label: "the key" });

  await putModel(store, "m", model);
  expect((await store.config.listModels()).map((row) => row.id)).toContain("m");
  store.close();
});
