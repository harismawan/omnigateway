import { expect, test } from "bun:test";
import type { ProviderId } from "@omni/ir";
import { memoryStore, seedCredential } from "@omni/testkit";
import { putModel } from "../src/models.ts";

/**
 * The reachability check, read through a pin.
 *
 * `unreachable` refuses a target no credential this installation holds could
 * ever reach. Provider-wide, that means "some account of this provider can
 * serve it"; pinned, only one account can, so an unrelated sibling of the other
 * kind is no longer evidence of anything. Letting it pass saves a target that
 * hard-fails every request with no fallback — worse than the unpinned case the
 * check was written for, because there is nothing to fall back to.
 *
 * Kilo is the case with something to say: its `:free` tier and `kilo-auto/*`
 * routers are served to an API key and not to a subscription token.
 */

type Store = Awaited<ReturnType<typeof memoryStore>>;

const GATEWAY_ONLY = "kilo-auto/frontier";

const kiloModel = (model: string, pin?: string, overrides: Record<string, unknown> = {}) => ({
  id: "m",
  strategy: "score" as const,
  isAlias: false,
  targets: [
    {
      provider: "kilo" as const,
      model,
      tier: 1,
      weight: 1,
      costPerMTok: { input: 0, output: 0 },
      capabilities: { tools: true, images: true, reasoning: true },
      ...(pin === undefined ? {} : { credentialId: pin }),
      ...overrides,
    },
  ],
});

async function credential(
  store: Store,
  id: string,
  authType: "oauth" | "apiKey",
  provider: ProviderId = "kilo",
): Promise<void> {
  await seedCredential(store, {
    id,
    provider,
    authType,
    enabled: true,
    // Deliberately not the id: the refusal below names the account the way the
    // console does, and an id-shaped label would let either one satisfy it.
    label: `${id} account`,
    ...(authType === "apiKey" ? { accessToken: null, refreshToken: null, apiKey: `k-${id}` } : {}),
  });
}

test("putModel refuses a target pinned to an account that cannot reach the model", async () => {
  const store = await memoryStore();
  // The API key is what makes this discriminating: provider-wide the model is
  // reachable, so only a pin-aware check can see that this target is not.
  await credential(store, "kilo-key", "apiKey");
  await credential(store, "kilo-oauth", "oauth");

  const error: unknown = await putModel(store, "m", kiloModel(GATEWAY_ONLY, "kilo-oauth")).then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toMatchObject({ code: "BAD_REQUEST" });
  const message = String((error as Error).message);
  expect(message).toContain(`kilo serves "${GATEWAY_ONLY}"`);
  expect(message).toContain("API key credentials only");
  // Names the pinned account rather than the provider's whole set, or the
  // operator reads it as the unpinned refusal and goes looking for an account
  // they already have.
  expect(message).toContain('pinned to "kilo-oauth account"');
  expect(message).not.toContain("every kilo credential here is");
  expect(await store.config.listModels()).toEqual([]);
});

test("putModel saves a target pinned to the account that can reach the model", async () => {
  const store = await memoryStore();
  await credential(store, "kilo-key", "apiKey");
  await credential(store, "kilo-oauth", "oauth");

  await putModel(store, "m", kiloModel(GATEWAY_ONLY, "kilo-key"));
  expect((await store.config.listModels())[0]?.targets[0]?.credentialId).toBe("kilo-key");
});

test("putModel saves a pin naming an account this installation does not hold", async () => {
  const store = await memoryStore();
  await credential(store, "kilo-key", "apiKey");

  // The pin is deliberately not validated for existence at write time: removing
  // an account must not make an unrelated edit unsavable. The router reports it
  // as `pin:missing` and `omni doctor` lists it.
  await putModel(store, "m", kiloModel(GATEWAY_ONLY, "never-existed"));
  expect((await store.config.listModels())[0]?.targets[0]?.credentialId).toBe("never-existed");
});

test("putModel does not read a pin at another provider as reaching this one", async () => {
  const store = await memoryStore();
  await credential(store, "kilo-oauth", "oauth");
  await credential(store, "anthropic-key", "apiKey", "anthropic");

  // The router's pin check sits after the provider check, so this pin is
  // `pin:missing`, not a way in. Resolving it to the anthropic key's auth would
  // launder the provider-wide refusal that OAuth-only kilo has earned.
  await expect(
    putModel(store, "m", kiloModel(GATEWAY_ONLY, "anthropic-key")),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("putModel refuses a stored target whose pin is repointed at an account that cannot reach it", async () => {
  const store = await memoryStore();
  await credential(store, "kilo-key", "apiKey");
  await credential(store, "kilo-oauth", "oauth");
  await putModel(store, "m", kiloModel(GATEWAY_ONLY, "kilo-key"));

  // Grandfathering keys on provider and model, so the edit below is exempt from
  // the provider-wide check — but the pin check names an account that exists
  // right now, which is exactly what grandfathering does not protect against.
  await expect(putModel(store, "m", kiloModel(GATEWAY_ONLY, "kilo-oauth"))).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect((await store.config.listModels())[0]?.targets[0]?.credentialId).toBe("kilo-key");
});

test("putModel keeps a stored pinned target savable after its account goes", async () => {
  const store = await memoryStore();
  await credential(store, "kilo-key", "apiKey");
  await putModel(store, "m", kiloModel(GATEWAY_ONLY, "kilo-key"));
  await credential(store, "kilo-oauth", "oauth");
  await store.credentials.remove("kilo-key");

  // The pin no longer resolves, so the check falls back to provider-wide, where
  // the stored target is grandfathered. Editing the tier of a target the
  // operator has not touched must not require deleting it first.
  await putModel(store, "m", kiloModel(GATEWAY_ONLY, "kilo-key", { tier: 3 }));
  expect((await store.config.listModels())[0]?.targets[0]?.tier).toBe(3);
});

test("putModel lets a dangling pin be cleared without refusing the repair", async () => {
  const store = await memoryStore();
  await credential(store, "kilo-key", "apiKey");
  await putModel(store, "m", kiloModel(GATEWAY_ONLY, "kilo-key"));
  await store.credentials.remove("kilo-key");
  await credential(store, "kilo-oauth", "oauth");

  // Removing the pin is the operator repairing the target, and the state they
  // are repairing from saved fine. A check that refused this would leave the
  // dangling pin as the only savable shape of the model.
  await putModel(store, "m", kiloModel(GATEWAY_ONLY));
  expect((await store.config.listModels())[0]?.targets[0]?.credentialId).toBeUndefined();
});

test("putModel says nothing about a pinned target for a model the catalog does not list", async () => {
  const store = await memoryStore();
  await credential(store, "kilo-oauth", "oauth");

  // An unlisted model is unknown rather than forbidden, and a pin does not turn
  // an absent catalog entry into a restriction.
  await putModel(store, "m", kiloModel("qwen/qwen4-max", "kilo-oauth"));
  expect((await store.config.listModels())[0]?.targets[0]?.model).toBe("qwen/qwen4-max");
});
