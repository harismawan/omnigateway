import { expect, test } from "bun:test";
import { memoryStore, seedCredential, target, virtualModel } from "@omni/testkit";
import { resolveModelLimits, type ServingCredential } from "../src/modelLimits.ts";
import { describeModelsForSetup } from "../src/setup.ts";

/**
 * What a pinned target advertises.
 *
 * OpenAI is the case that has something to say: an OAuth credential is routed
 * to the Codex backend, whose 272,000-token window is under a third of the
 * API's 922,000. A provider holding both ways in is described by the narrower
 * one, because failover can land on either — but a pinned target has no
 * failover, so narrowing across accounts it can never reach understates by
 * 650,000 tokens, and `setup.ts` writes that figure into an agent's own
 * configuration where it outlives the request.
 */

const API_WINDOW = 922_000;
const CODEX_WINDOW = 272_000;

const serving = (
  id: string,
  authType: "oauth" | "apiKey",
  overrides: Partial<ServingCredential> = {},
): ServingCredential => ({
  id,
  provider: "openai",
  authType,
  enabled: true,
  ...overrides,
});

const openai = (credentialId?: string) =>
  virtualModel({
    id: "m",
    targets: [
      target({
        provider: "openai",
        model: "gpt-5.6",
        ...(credentialId === undefined ? {} : { credentialId }),
      }),
    ],
  });

const BOTH = [serving("key", "apiKey"), serving("oauth", "oauth")];

test("an unpinned target is still described by the narrowest way in", () => {
  // Unchanged behaviour, and the control for every case below: failover really
  // can land on the Codex credential here, so 922,000 would be a promise the
  // gateway cannot keep.
  expect(resolveModelLimits(openai(), BOTH).contextWindow).toBe(CODEX_WINDOW);
});

test("a target pinned to the API key advertises the API window, not Codex's", () => {
  // The bug this fixes: the OAuth credential exists but cannot serve this
  // target, so narrowing to it hides 650,000 tokens the pinned account holds.
  expect(resolveModelLimits(openai("key"), BOTH).contextWindow).toBe(API_WINDOW);
});

test("a target pinned to the OAuth account advertises Codex's window", () => {
  // The other direction, and the one that must not widen: an API key sitting
  // beside the pin is irrelevant to a request this target serves.
  expect(resolveModelLimits(openai("oauth"), BOTH).contextWindow).toBe(CODEX_WINDOW);
});

test("output limits follow the pin too, not just the context window", () => {
  expect(resolveModelLimits(openai("key"), BOTH).maxOutputTokens).toBe(128_000);
});

test("a pin naming an account that is gone does not widen the answer", () => {
  // The pin is deliberately not validated at write time, so a dangling one is a
  // state the listing must survive. There is no serving path to resolve it to,
  // and the router fails the request as `pin:missing` — advertising more than
  // the unpinned answer would state a window nothing can serve.
  expect(resolveModelLimits(openai("deleted"), BOTH).contextWindow).toBe(CODEX_WINDOW);
});

test("a pin naming a disabled account does not widen the answer", () => {
  // `resolveModelLimits` describes what can serve a request right now, and a
  // disabled credential serves nothing. Reading its auth off anyway would
  // advertise the API's window for a target that currently routes nowhere.
  const credentials = [serving("key", "apiKey", { enabled: false }), serving("oauth", "oauth")];
  expect(resolveModelLimits(openai("key"), credentials).contextWindow).toBe(CODEX_WINDOW);
});

test("a pin naming another provider's account does not widen the answer", () => {
  // The router's pin check sits after the provider check, so such a pin is
  // `pin:missing` rather than a way around it. Reading the foreign credential's
  // auth here would let an anthropic API key widen an OpenAI target.
  const credentials = [
    serving("elsewhere", "apiKey", { provider: "anthropic" }),
    serving("oauth", "oauth"),
  ];
  expect(resolveModelLimits(openai("elsewhere"), credentials).contextWindow).toBe(CODEX_WINDOW);
});

test("a pool is still described by its narrowest member, pin or no pin", () => {
  // The pin narrows which accounts serve one target. It says nothing about the
  // other targets, and a client still sizes its context once for the pool.
  // The pinned target is second on purpose: a resolution that let the last
  // target win outright would land on the right answer if it were first.
  const pool = virtualModel({
    id: "m",
    targets: [
      target({ provider: "openai", model: "gpt-5.6-luna" }),
      target({ provider: "openai", model: "gpt-5.6", credentialId: "key" }),
    ],
  });
  expect(resolveModelLimits(pool, BOTH).contextWindow).toBe(CODEX_WINDOW);
});

test("a figure saved on the pinned target still wins over the catalog", () => {
  const pinned = virtualModel({
    id: "m",
    targets: [
      target({ provider: "openai", model: "gpt-5.6", credentialId: "key", contextWindow: 64_000 }),
    ],
  });
  expect(resolveModelLimits(pinned, BOTH).contextWindow).toBe(64_000);
});

test("a pin on an installation holding no credential reports the published figures", () => {
  // Nothing serves the provider, so there is no serving path to narrow to and
  // the catalog's own answer is the honest one — the same reading an unpinned
  // target gets.
  expect(resolveModelLimits(openai("key"), []).contextWindow).toBe(API_WINDOW);
});

test("the figure written into an agent's configuration follows the pin", async () => {
  // Through `describeModelsForSetup`, because the identity it maps credentials
  // to is where the pin can be dropped without any type complaining, and this
  // figure is persisted as `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and into opencode's
  // config — it outlives the request that would otherwise expose it as wrong.
  const store = await memoryStore();
  await seedCredential(store, {
    id: "openai-key",
    provider: "openai",
    authType: "apiKey",
    accessToken: null,
    refreshToken: null,
    apiKey: "k-openai",
  });
  await seedCredential(store, { id: "openai-oauth", provider: "openai", authType: "oauth" });
  await store.config.putModel(openai("openai-key"));

  const described = await describeModelsForSetup(store);
  expect(described[0]?.limits.contextWindow).toBe(API_WINDOW);
});
