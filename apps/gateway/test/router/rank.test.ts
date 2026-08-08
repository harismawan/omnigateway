import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { rank } from "../../src/router/index.ts";
import { credential, health, quota, snapshot, target } from "../helpers/fixtures.ts";

const NOW = 1_000_000;

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const model = (
  targets = [target()],
  strategy: "score" | "priority" | "roundRobin" | "weighted" = "score",
) => ({
  id: "fast",
  strategy,
  isAlias: false,
  targets,
});

test("ranking never decrypts a credential", async () => {
  let opened = 0;
  const spy = credential({
    id: "a",
    secrets: async () => {
      opened++;
      return { accessToken: "t", refreshToken: "r", apiKey: null, idToken: null };
    },
  });
  rank({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [spy] }),
    now: NOW,
    rand: 0,
  });
  expect(opened).toBe(0);
});

test("prefers the lower tier when everything else is equal", () => {
  const { candidates } = rank({
    request: req,
    model: model([target({ model: "cheap", tier: 2 }), target({ model: "premium", tier: 1 })]),
    snapshot: snapshot({ credentials: [credential({ id: "a" })] }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.target.model).toBe("premium");
});

test("prefers the healthier credential at the same tier", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "sick" }), credential({ id: "well" })],
      health: [health({ credentialId: "sick", consecutiveFailures: 2 })],
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("well");
});

test("prefers the cheaper target when cost is the only weighted term", () => {
  const { candidates } = rank({
    request: req,
    model: model([
      target({ model: "pricey", costPerMTok: { input: 15, output: 75 } }),
      target({ model: "thrifty", costPerMTok: { input: 1, output: 3 } }),
    ]),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      settings: { weights: { tier: 0, health: 0, quota: 0, cost: 1, latency: 0, recency: 0 } },
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.target.model).toBe("thrifty");
});

test("prefers the faster credential when latency is the only weighted term", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "slow" }), credential({ id: "quick" })],
      health: [
        health({ credentialId: "slow", ewmaTtftMs: 3000 }),
        health({ credentialId: "quick", ewmaTtftMs: 200 }),
      ],
      settings: { weights: { tier: 0, health: 0, quota: 0, cost: 0, latency: 1, recency: 0 } },
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("quick");
});

test("prefers the credential with more quota headroom", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "drained" }), credential({ id: "fresh" })],
      quota: [
        quota({ credentialId: "drained", used: 90, limit: 100, observedAt: NOW }),
        quota({ credentialId: "fresh", used: 10, limit: 100, observedAt: NOW }),
      ],
      settings: { weights: { tier: 0, health: 0, quota: 1, cost: 0, latency: 0, recency: 0 } },
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("fresh");
});

test("recency spreads load toward the least recently used credential", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "hot" }), credential({ id: "cold" })],
      health: [
        health({ credentialId: "hot", lastUsedAt: NOW - 1_000 }),
        health({ credentialId: "cold", lastUsedAt: NOW - 600_000 }),
      ],
      settings: { weights: { tier: 0, health: 0, quota: 0, cost: 0, latency: 0, recency: 1 } },
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("cold");
});

test("credential weight multiplies the final score", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "light", weight: 1 }), credential({ id: "heavy", weight: 5 })],
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("heavy");
});

test("priority strategy sorts by tier and ignores other terms", () => {
  const { candidates } = rank({
    request: req,
    model: model(
      [
        target({ model: "tier2", tier: 2, costPerMTok: { input: 0, output: 0 } }),
        target({ model: "tier1", tier: 1 }),
      ],
      "priority",
    ),
    snapshot: snapshot({ credentials: [credential({ id: "a" })] }),
    now: NOW,
    rand: 0,
  });
  expect(candidates.map((c) => c.target.model)).toEqual(["tier1", "tier2"]);
});

test("roundRobin puts the least recently used credential first", () => {
  const { candidates } = rank({
    request: req,
    model: model([target()], "roundRobin"),
    snapshot: snapshot({
      credentials: [credential({ id: "a" }), credential({ id: "b" })],
      health: [
        health({ credentialId: "a", lastUsedAt: NOW }),
        health({ credentialId: "b", lastUsedAt: NOW - 10 }),
      ],
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("b");
});

test("weighted selection is deterministic in the injected random value", () => {
  const snap = snapshot({
    credentials: [credential({ id: "a", weight: 1 }), credential({ id: "b", weight: 9 })],
  });
  const pick = (rand: number) =>
    rank({ request: req, model: model([target()], "weighted"), snapshot: snap, now: NOW, rand })
      .candidates[0]?.credential.id;
  expect(pick(0.05)).toBe("a");
  expect(pick(0.5)).toBe("b");
  expect(pick(0.05)).toBe("a");
});

test("weighted ranking still returns every candidate for failover", () => {
  const { candidates } = rank({
    request: req,
    model: model([target()], "weighted"),
    snapshot: snapshot({
      credentials: [credential({ id: "a" }), credential({ id: "b" }), credential({ id: "c" })],
    }),
    now: NOW,
    rand: 0.5,
  });
  expect(candidates).toHaveLength(3);
  expect(new Set(candidates.map((c) => c.credential.id)).size).toBe(3);
});

test("returns an empty list with reasons when nothing is eligible", () => {
  const { candidates, excluded } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [credential({ id: "a", enabled: false })] }),
    now: NOW,
    rand: 0,
  });
  expect(candidates).toEqual([]);
  expect(excluded).toHaveLength(1);
});

test("candidates carry their per-term reasons", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [credential({ id: "a" })] }),
    now: NOW,
    rand: 0,
  });
  expect(Object.keys(candidates[0]?.reasons ?? {}).sort()).toEqual([
    "cost",
    "health",
    "latency",
    "quota",
    "recency",
    "tier",
  ]);
});

test("ranking is stable for identical inputs", () => {
  const snap = snapshot({
    credentials: [credential({ id: "a" }), credential({ id: "b" }), credential({ id: "c" })],
  });
  const ids = () =>
    rank({ request: req, model: model(), snapshot: snap, now: NOW, rand: 0 }).candidates.map(
      (c) => c.credential.id,
    );
  expect(ids()).toEqual(ids());
});

test("the weighted lottery draws a near-spent account less often than its weight says", () => {
  const snapshotWith = () =>
    snapshot({
      credentials: [
        credential({ id: "drained", weight: 1 }),
        credential({ id: "fresh", weight: 1 }),
      ],
      quota: [
        quota({ credentialId: "drained", used: 95, limit: 100, observedAt: NOW, resetsAt: null }),
        quota({ credentialId: "fresh", used: 5, limit: 100, observedAt: NOW, resetsAt: null }),
      ],
    });

  // Equal configured weights, so the draw is decided by headroom alone: 0.05
  // against 0.95, which puts the crossover at five percent of the cursor.
  const early = rank({
    request: req,
    model: model([target()], "weighted"),
    snapshot: snapshotWith(),
    now: NOW,
    rand: 0.04,
  });
  expect(early.candidates[0]?.credential.id).toBe("drained");

  const later = rank({
    request: req,
    model: model([target()], "weighted"),
    snapshot: snapshotWith(),
    now: NOW,
    rand: 0.06,
  });
  expect(later.candidates[0]?.credential.id).toBe("fresh");
});

test("a candidate with no headroom left is never drawn by the lottery", () => {
  const { candidates } = rank({
    request: req,
    model: model([target()], "weighted"),
    snapshot: snapshot({
      credentials: [credential({ id: "spent" }), credential({ id: "fresh" })],
      quota: [
        // Not yet excluded by the filter: the reading is one request old and the
        // window has not rolled over, but there is nothing left to draw on.
        quota({ credentialId: "spent", used: 100, limit: 100, observedAt: NOW, resetsAt: null }),
        quota({ credentialId: "fresh", used: 0, limit: 100, observedAt: NOW, resetsAt: null }),
      ],
    }),
    now: NOW,
    rand: 0.999,
  });
  expect(candidates[0]?.credential.id).toBe("fresh");
});

test("round robin skips past an account close to exhaustion", () => {
  const { candidates } = rank({
    request: req,
    model: model([target()], "roundRobin"),
    snapshot: snapshot({
      credentials: [credential({ id: "idle-but-spent" }), credential({ id: "busier" })],
      health: [
        health({ credentialId: "idle-but-spent", lastUsedAt: NOW - 600_000 }),
        health({ credentialId: "busier", lastUsedAt: NOW - 1_000 }),
      ],
      quota: [
        quota({
          credentialId: "idle-but-spent",
          used: 97,
          limit: 100,
          observedAt: NOW,
          resetsAt: null,
        }),
        quota({ credentialId: "busier", used: 20, limit: 100, observedAt: NOW, resetsAt: null }),
      ],
    }),
    now: NOW,
    rand: 0,
  });

  // Strict least-recently-used would pick the idle account and spend the rest
  // of its window on requests that are about to start failing.
  expect(candidates[0]?.credential.id).toBe("busier");
  expect(candidates[1]?.credential.id).toBe("idle-but-spent");
});

test("round robin still rotates when both accounts have headroom", () => {
  const { candidates } = rank({
    request: req,
    model: model([target()], "roundRobin"),
    snapshot: snapshot({
      credentials: [credential({ id: "idle" }), credential({ id: "busier" })],
      health: [
        health({ credentialId: "idle", lastUsedAt: NOW - 600_000 }),
        health({ credentialId: "busier", lastUsedAt: NOW - 1_000 }),
      ],
      quota: [
        quota({ credentialId: "idle", used: 40, limit: 100, observedAt: NOW, resetsAt: null }),
        quota({ credentialId: "busier", used: 20, limit: 100, observedAt: NOW, resetsAt: null }),
      ],
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("idle");
});
