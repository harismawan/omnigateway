import { expect, test } from "bun:test";
import { memoryStore } from "@omni/testkit";
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
