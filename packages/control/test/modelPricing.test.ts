import { expect, test } from "bun:test";
import { memoryStore, seedCredential } from "@omni/testkit";
import { putModel } from "../src/models.ts";
import { modelSchema } from "../src/schemas.ts";

const target = (
  costPerMTok: Record<string, number>,
): Record<string, unknown> & {
  targets: Array<Record<string, unknown>>;
} => ({
  id: "m",
  strategy: "score" as const,
  isAlias: false,
  targets: [
    {
      provider: "anthropic" as const,
      model: "claude-opus-5",
      tier: 1,
      weight: 1,
      costPerMTok,
      capabilities: { tools: true, images: true, reasoning: true },
    },
  ],
});

test("keeps the per-ttl cache write prices a target was saved with", () => {
  const parsed = modelSchema.parse(
    target({ input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }),
  );
  // Zod strips what it does not name, so an unnamed price is not "passed
  // through" — it is silently dropped on the way to the store.
  expect(parsed.targets[0]?.costPerMTok).toEqual({
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  });
});

test("keeps an explicit zero, which is a provider that bills no write premium", () => {
  const parsed = modelSchema.parse(
    target({ input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 }),
  );
  expect(parsed.targets[0]?.costPerMTok.cacheWrite5m).toBe(0);
  expect(parsed.targets[0]?.costPerMTok.cacheWrite1h).toBe(0);
});

test("still accepts a target saved before write prices existed", () => {
  const parsed = modelSchema.parse(target({ input: 5, output: 25, cacheRead: 0.5 }));
  expect(parsed.targets[0]?.costPerMTok).toEqual({ input: 5, output: 25, cacheRead: 0.5 });
});

test("rejects a negative write price", () => {
  expect(() =>
    modelSchema.parse(target({ input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: -1 })),
  ).toThrow();
});

test("putModel rejects a custom endpoint not represented by credentials", async () => {
  const store = await memoryStore();
  const custom = target({ input: 0, output: 0 });
  custom.targets[0] = {
    ...custom.targets[0],
    provider: "custom",
    endpointId: "missing",
    model: "local-model",
  };

  await expect(putModel(store, "m", custom)).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

/**
 * Per-model auth enforcement.
 *
 * Kilo serves its `:free` tier and its `kilo-auto/*` routers to an API key and
 * not to a subscription token. Saved against an OAuth-only installation, such a
 * target fails upstream with a billing error that reads as anything but a
 * routing bug, so `putModel` refuses it at save time instead.
 */
function kiloModel(model: string): Record<string, unknown> {
  const built = target({ input: 0, output: 0 });
  built.targets[0] = { ...built.targets[0], provider: "kilo", model };
  return built;
}

async function kiloCredential(
  store: Awaited<ReturnType<typeof memoryStore>>,
  id: string,
  authType: "oauth" | "apiKey",
  enabled = true,
): Promise<void> {
  await seedCredential(store, {
    id,
    provider: "kilo",
    authType,
    enabled,
    ...(authType === "apiKey" ? { accessToken: null, refreshToken: null, apiKey: `k-${id}` } : {}),
  });
}

test("putModel refuses a gateway-only kilo model on an OAuth-only installation", async () => {
  const store = await memoryStore();
  await kiloCredential(store, "kilo-oauth", "oauth");

  const error: unknown = await putModel(store, "m", kiloModel("kilo-auto/frontier")).then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toMatchObject({ code: "BAD_REQUEST" });
  // Both halves named, so the operator knows which way in is missing rather
  // than only that something is.
  const message = String((error as Error).message);
  expect(message).toContain('kilo serves "kilo-auto/frontier"');
  expect(message).toContain("API key credentials only");
  expect(message).toContain("every kilo credential here is OAuth");
  expect(await store.config.listModels()).toEqual([]);
});

test("putModel allows a gateway-only kilo model once an API key is connected", async () => {
  const store = await memoryStore();
  await kiloCredential(store, "kilo-oauth", "oauth");
  await kiloCredential(store, "kilo-key", "apiKey");

  await putModel(store, "m", kiloModel("kilo-auto/frontier"));
  expect((await store.config.listModels())[0]?.targets[0]?.model).toBe("kilo-auto/frontier");
});

test("putModel says nothing about a provider the installation holds no credential for", async () => {
  const store = await memoryStore();
  // Composing models before connecting accounts is a normal order to work in,
  // and nothing here is evidence about which way in this install will have.
  await putModel(store, "m", kiloModel("kilo-auto/frontier"));
  expect((await store.config.listModels())[0]?.targets[0]?.model).toBe("kilo-auto/frontier");
});

test("putModel treats a model the catalog does not list as unknown, not forbidden", async () => {
  const store = await memoryStore();
  await kiloCredential(store, "kilo-oauth", "oauth");

  // Kilo proxies several hundred models and the catalog curates a few dozen.
  // Reading an absent entry as a restriction would lock the rest out.
  await putModel(store, "m", kiloModel("qwen/qwen4-max"));
  expect((await store.config.listModels())[0]?.targets[0]?.model).toBe("qwen/qwen4-max");
});

test("putModel counts a disabled credential, so one rejected token strands nothing", async () => {
  const store = await memoryStore();
  // The enabled OAuth credential is what makes this discriminating: filtering
  // the disabled key out leaves kilo looking OAuth-only, which is the refusal
  // this test exists to rule out. A disabled key alone would leave kilo with no
  // credential at all, and the no-credential case passes for its own reason.
  await kiloCredential(store, "kilo-oauth", "oauth");
  await kiloCredential(store, "kilo-key", "apiKey", false);

  await putModel(store, "m", kiloModel("kilo-auto/frontier"));
  expect((await store.config.listModels())[0]?.targets[0]?.model).toBe("kilo-auto/frontier");
});

test("putModel keeps a stored target savable after the credential that reached it goes", async () => {
  const store = await memoryStore();
  await kiloCredential(store, "kilo-oauth", "oauth");
  await kiloCredential(store, "kilo-key", "apiKey");
  await putModel(store, "m", kiloModel("kilo-auto/frontier"));

  const credentials = await store.credentials.list();
  const key = credentials.find((credential) => credential.authType === "apiKey");
  await store.credentials.remove(String(key?.id));

  // Editing the tier of an untouched target must not require deleting it.
  const edited = kiloModel("kilo-auto/frontier");
  (edited.targets as Array<Record<string, unknown>>)[0] = {
    ...(edited.targets as Array<Record<string, unknown>>)[0],
    tier: 3,
  };
  await putModel(store, "m", edited);
  expect((await store.config.listModels())[0]?.targets[0]?.tier).toBe(3);
});

test("putModel judges a retargeted target fresh rather than carrying the exemption over", async () => {
  const store = await memoryStore();
  await kiloCredential(store, "kilo-oauth", "oauth");
  await kiloCredential(store, "kilo-key", "apiKey");
  await putModel(store, "m", kiloModel("kilo-auto/frontier"));

  const credentials = await store.credentials.list();
  const key = credentials.find((credential) => credential.authType === "apiKey");
  await store.credentials.remove(String(key?.id));

  // A different model id is the operator asserting something new, not carrying
  // a working configuration forward.
  await expect(putModel(store, "m", kiloModel("kilo-auto/small"))).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("requires an endpoint id only for custom targets", () => {
  const custom = target({ input: 0, output: 0 });
  custom.targets[0] = { ...custom.targets[0], provider: "custom", model: "local-model" };
  expect(() => modelSchema.parse(custom)).toThrow(/endpointId/);

  custom.targets[0] = { ...custom.targets[0], endpointId: "local-vllm" };
  expect(modelSchema.parse(custom).targets[0]).toMatchObject({
    provider: "custom",
    endpointId: "local-vllm",
  });

  const builtIn = target({ input: 5, output: 25 });
  builtIn.targets[0] = { ...builtIn.targets[0], endpointId: "not-allowed" };
  expect(() => modelSchema.parse(builtIn)).toThrow(/unrecognized key/i);
});
