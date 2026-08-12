import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { credential, health, snapshot, target } from "@omni/testkit";
import { healthKey, rank } from "../src/index.ts";

const NOW = 1_000_000;

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const model = (targets = [target()]) => ({
  id: "fast",
  strategy: "score" as const,
  isAlias: false,
  targets,
});

/** Only the named term carries weight, so a test reads as one signal at a time. */
const only = (term: string, value = 1) => ({
  weights: { tier: 0, health: 0, quota: 0, cost: 0, latency: 0, load: 0, [term]: value },
});

const byId = (candidates: { credential: { id: string }; reasons: Record<string, number> }[]) =>
  new Map(candidates.map((c) => [c.credential.id, c.reasons]));

test("scores latency by how much slower it is, not by rank order", () => {
  const rankLatencies = (slow: number) =>
    byId(
      rank({
        request: req,
        model: model(),
        snapshot: snapshot({
          credentials: [credential({ id: "quick" }), credential({ id: "slow" })],
          health: [
            health({ credentialId: "quick", ewmaTtftMs: 100 }),
            health({ credentialId: "slow", ewmaTtftMs: slow }),
          ],
          settings: only("latency"),
        }),
        now: NOW,
        rand: 0,
        load: new Map(),
      }).candidates,
    );

  // Barely slower is barely worse. Min-max normalisation scored this 0.
  expect(rankLatencies(105).get("slow")?.latency).toBeCloseTo(0.952, 2);
  // Two orders of magnitude slower is much worse. Min-max scored this 0 too.
  expect(rankLatencies(10_000).get("slow")?.latency).toBeCloseTo(0.01, 2);
});

test("an unpriced target scores neutral without collapsing its priced peers", () => {
  const reasons = byId(
    rank({
      request: req,
      model: model([
        target({ model: "thrifty", costPerMTok: { input: 1, output: 3 } }),
        target({ model: "pricey", costPerMTok: { input: 2, output: 6 } }),
        target({ model: "unpriced", costPerMTok: { input: 0, output: 0 } }),
      ]),
      snapshot: snapshot({ credentials: [credential({ id: "a" })], settings: only("cost") }),
      now: NOW,
      rand: 0,
      load: new Map(),
    }).candidates.map((c) => ({ credential: { id: c.target.model }, reasons: c.reasons })),
  );

  expect(reasons.get("unpriced")?.cost).toBe(0.5);
  // The zero price must not become the `min` every other target divides by.
  expect(reasons.get("thrifty")?.cost).toBe(1);
  expect(reasons.get("pricey")?.cost).toBeCloseTo(0.5, 2);
});

/** Cheap in, dear out — against dear in, cheap out. Which wins is the request's call. */
const lopsided = [
  target({ model: "cheap-input", costPerMTok: { input: 1, output: 100 } }),
  target({ model: "cheap-output", costPerMTok: { input: 30, output: 10 } }),
];

const cheapestFor = (request: ChatRequest) =>
  rank({
    request,
    model: { id: "fast", strategy: "score", isAlias: false, targets: lopsided },
    snapshot: snapshot({ credentials: [credential({ id: "a" })], settings: only("cost") }),
    now: NOW,
    rand: 0,
    load: new Map(),
  }).candidates[0]?.target.model;

const prompt = (chars: number, maxTokens?: number): ChatRequest => ({
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(chars) }] }],
  stream: true,
  ...(maxTokens === undefined ? {} : { maxTokens }),
});

test("prices the request in front of it, not an average request", () => {
  // A short prompt spends most of its money on output.
  expect(cheapestFor(prompt(400))).toBe("cheap-output");
  // A long one inverts that, and a fixed input/output blend cannot see it.
  expect(cheapestFor(prompt(400_000))).toBe("cheap-input");
});

test("treats an unusually low maxTokens as a real ceiling on output", () => {
  expect(cheapestFor(prompt(4_000))).toBe("cheap-output");
  expect(cheapestFor(prompt(4_000, 100))).toBe("cheap-input");
});

test("prefers the credential with fewer requests in flight", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "busy" }), credential({ id: "idle" })],
      settings: only("load"),
    }),
    now: NOW,
    rand: 0,
    load: new Map([[healthKey("busy", "claude-opus-4"), 2]]),
  });
  expect(candidates[0]?.credential.id).toBe("idle");
});

test("prefers the target with the cheaper cache read for a cached prompt", () => {
  const cachedPrompt: ChatRequest = {
    model: "fast",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(400_000), cacheControl: { type: "ephemeral" } },
          { type: "text", text: "and now the new turn" },
        ],
      },
    ],
    stream: true,
  };

  const { candidates } = rank({
    request: cachedPrompt,
    model: {
      id: "fast",
      strategy: "score",
      isAlias: false,
      targets: [
        // Identical on fresh input and output; they differ only on cache reads,
        // which is exactly what the old fixed blend could not see.
        target({ model: "dear-cache", costPerMTok: { input: 3, output: 15, cacheRead: 3 } }),
        target({ model: "cheap-cache", costPerMTok: { input: 3, output: 15, cacheRead: 0.3 } }),
      ],
    },
    snapshot: snapshot({ credentials: [credential({ id: "a" })], settings: only("cost") }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(candidates[0]?.target.model).toBe("cheap-cache");
});

test("a zero first-token measurement is unknown, not instant", () => {
  const reasons = byId(
    rank({
      request: req,
      model: model(),
      snapshot: snapshot({
        credentials: [credential({ id: "unmeasured" }), credential({ id: "slow" })],
        health: [
          // A sub-millisecond first token seeds the EWMA at zero. That means
          // "no useful measurement", exactly as a null does.
          health({ credentialId: "unmeasured", ewmaTtftMs: 0 }),
          health({ credentialId: "slow", ewmaTtftMs: 400 }),
        ],
        settings: only("latency"),
      }),
      now: NOW,
      rand: 0,
      load: new Map(),
    }).candidates,
  );

  expect(reasons.get("unmeasured")?.latency).toBe(0.5);
  expect(reasons.get("slow")?.latency).toBe(1);
});
