import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { credential, health, quota, snapshot, target } from "@omni/testkit";
import { eligible, requiredCapabilities } from "../src/filters.ts";

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

test("derives required capabilities from the request", () => {
  expect(requiredCapabilities(req)).toEqual({ tools: false, images: false, reasoning: false });
  expect(
    requiredCapabilities({ ...req, tools: [{ provider: "custom", name: "f", inputSchema: {} }] })
      .tools,
  ).toBe(true);
  expect(
    requiredCapabilities({ ...req, reasoning: { mode: "adaptive", effort: "low" } }).reasoning,
  ).toBe(true);
  expect(
    requiredCapabilities({
      ...req,
      messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "A" }] }],
    }).images,
  ).toBe(true);
});

test("pairs each target with every credential of its provider", () => {
  const a = credential({ id: "a", provider: "anthropic" });
  const k = credential({ id: "k", provider: "kimi" });
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [a, k] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(1);
  expect(pairs[0]?.credential.id).toBe("a");
});

test("pairs custom targets only with credentials for the same endpoint", () => {
  const matching = credential({
    id: "matching",
    provider: "custom",
    authType: "apiKey",
    providerData: { endpointId: "local" },
  });
  const other = credential({
    id: "other",
    provider: "custom",
    authType: "apiKey",
    providerData: { endpointId: "remote" },
  });
  const { pairs } = eligible({
    request: req,
    model: model([target({ provider: "custom", endpointId: "local", model: "llama" })]),
    snapshot: snapshot({ credentials: [matching, other] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs.map((pair) => pair.credential.id)).toEqual(["matching"]);
});

test("a pinned target pairs only with the credential it names", () => {
  const pinned = credential({ id: "pinned", provider: "anthropic" });
  const other = credential({ id: "other", provider: "anthropic" });
  const { pairs, excluded } = eligible({
    request: req,
    model: model([target({ credentialId: "pinned" })]),
    snapshot: snapshot({ credentials: [pinned, other] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs.map((pair) => pair.credential.id)).toEqual(["pinned"]);
  // An account the pin excludes is not a rejected candidate — it was never one,
  // the same as a credential for another provider. Recording it would bury the
  // reasons that describe the pinned account itself.
  expect(excluded).toHaveLength(0);
});

test("a pin is hard: an ineligible pinned account does not spill to another", () => {
  const pinned = credential({ id: "pinned", provider: "anthropic", enabled: false });
  const other = credential({ id: "other", provider: "anthropic" });
  const { pairs, excluded } = eligible({
    request: req,
    model: model([target({ credentialId: "pinned" })]),
    snapshot: snapshot({ credentials: [pinned, other] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs).toHaveLength(0);
  // The pinned account's own reason survives, so the operator learns why rather
  // than only that nothing was left.
  expect(excluded).toEqual([
    { credentialId: "pinned", model: "claude-opus-4", reason: "disabled" },
  ]);
});

test("a pin naming no existing credential reports itself", () => {
  const { pairs, excluded } = eligible({
    request: req,
    model: model([target({ credentialId: "deleted" })]),
    snapshot: snapshot({ credentials: [credential({ id: "other", provider: "anthropic" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs).toHaveLength(0);
  // Without this row the request fails with nothing in `excluded` explaining
  // why, which is the one case where the silent skip above costs the answer.
  expect(excluded).toEqual([
    { credentialId: "deleted", model: "claude-opus-4", reason: "pin:missing" },
  ]);
});

test("an unpinned target in the same model is unaffected by a sibling's pin", () => {
  const pinned = credential({ id: "pinned", provider: "anthropic" });
  const other = credential({ id: "other", provider: "anthropic" });
  const { pairs } = eligible({
    request: req,
    model: model([
      target({ model: "claude-opus-4", credentialId: "pinned" }),
      target({ model: "claude-sonnet-4" }),
    ]),
    snapshot: snapshot({ credentials: [pinned, other] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs.map((pair) => `${pair.target.model}:${pair.credential.id}`).sort()).toEqual([
    "claude-opus-4:pinned",
    "claude-sonnet-4:other",
    "claude-sonnet-4:pinned",
  ]);
});

test("a pin does not rescue a credential the provider filter already rejects", () => {
  // The pin names a credential of the wrong provider. It must not become a way
  // to route an Anthropic target through a Kimi account.
  const { pairs, excluded } = eligible({
    request: req,
    model: model([target({ credentialId: "k" })]),
    snapshot: snapshot({ credentials: [credential({ id: "k", provider: "kimi" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs).toHaveLength(0);
  expect(excluded).toEqual([{ credentialId: "k", model: "claude-opus-4", reason: "pin:missing" }]);
});

test("every dangling pin in a model is reported, not just the first", () => {
  // `pinSeen` is per target. Hoisted out of the target loop, a first target
  // that resolves would suppress the row for every later one, and the request
  // fails with an exclusion list that explains only part of why.
  const { pairs, excluded } = eligible({
    request: req,
    model: model([
      target({ model: "claude-opus-4", credentialId: "live" }),
      target({ model: "claude-sonnet-4", credentialId: "gone" }),
      target({ model: "claude-haiku-4", credentialId: "also-gone" }),
    ]),
    snapshot: snapshot({ credentials: [credential({ id: "live", provider: "anthropic" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs.map((pair) => pair.target.model)).toEqual(["claude-opus-4"]);
  expect(excluded).toEqual([
    { credentialId: "gone", model: "claude-sonnet-4", reason: "pin:missing" },
    { credentialId: "also-gone", model: "claude-haiku-4", reason: "pin:missing" },
  ]);
});

test("a pinned target reports one reason, not its own reason and pin:missing too", () => {
  // `pinSeen` must be set before the capability drop. Set after it, a pinned
  // target that fails any earlier check emits two rows for one target.
  const { excluded } = eligible({
    request: { ...req, tools: [{ provider: "custom", name: "f", inputSchema: {} }] },
    model: model([
      target({ capabilities: { tools: false, images: true, reasoning: true }, credentialId: "a" }),
    ]),
    snapshot: snapshot({ credentials: [credential({ id: "a", provider: "anthropic" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(excluded).toEqual([
    { credentialId: "a", model: "claude-opus-4", reason: "capability:tools" },
  ]);
});

test("a pin cannot reach a custom credential on another endpoint", () => {
  // The widening mutation: making the endpoint check conditional on the pin
  // would route this target at the wrong base URL with the wrong key.
  const { pairs, excluded } = eligible({
    request: req,
    model: model(
      [target({ provider: "custom", endpointId: "local", model: "llama" })].map((t) => ({
        ...t,
        credentialId: "remote-account",
      })),
    ),
    snapshot: snapshot({
      credentials: [
        credential({
          id: "remote-account",
          provider: "custom",
          authType: "apiKey",
          providerData: { endpointId: "remote" },
        }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs).toHaveLength(0);
  expect(excluded).toEqual([
    { credentialId: "remote-account", model: "llama", reason: "pin:missing" },
  ]);
});

test("a pin reaches a custom credential on the target's own endpoint", () => {
  const { pairs } = eligible({
    request: req,
    model: model([
      { ...target({ provider: "custom", endpointId: "local", model: "llama" }), credentialId: "l" },
    ]),
    snapshot: snapshot({
      credentials: [
        credential({
          id: "l",
          provider: "custom",
          authType: "apiKey",
          providerData: { endpointId: "local" },
        }),
        credential({
          id: "other",
          provider: "custom",
          authType: "apiKey",
          providerData: { endpointId: "local" },
        }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs.map((pair) => pair.credential.id)).toEqual(["l"]);
});

test("a pin on an installation with no credentials at all still reports itself", () => {
  // The likeliest real trigger — fresh install, or the provider's last account
  // removed — and the case where an empty exclusion list would be worst.
  const { pairs, excluded } = eligible({
    request: req,
    model: model([target({ credentialId: "gone" })]),
    snapshot: snapshot({ credentials: [] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs).toHaveLength(0);
  expect(excluded).toEqual([
    { credentialId: "gone", model: "claude-opus-4", reason: "pin:missing" },
  ]);
});

test("a dangling pin reports itself once, not once per account it skipped", () => {
  // Every other dangling-pin case here holds nought or one credential of the
  // target's provider, so a row emitted per skipped sibling reads identically.
  // The row is about the pin, not about the accounts it excluded — one per
  // sibling is the noise this reason exists to replace.
  const { pairs, excluded } = eligible({
    request: req,
    model: model([target({ credentialId: "gone" })]),
    snapshot: snapshot({
      credentials: [
        credential({ id: "a", provider: "anthropic" }),
        credential({ id: "b", provider: "anthropic" }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs).toEqual([]);
  expect(excluded).toEqual([
    { credentialId: "gone", model: "claude-opus-4", reason: "pin:missing" },
  ]);
});

test("excludes disabled credentials", () => {
  const { pairs, excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [credential({ id: "a", enabled: false })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(0);
  expect(excluded[0]).toEqual({ credentialId: "a", model: "claude-opus-4", reason: "disabled" });
});

test("excludes targets that lack a required capability", () => {
  const { pairs, excluded } = eligible({
    request: { ...req, tools: [{ provider: "custom", name: "f", inputSchema: {} }] },
    model: model([target({ capabilities: { tools: false, images: true, reasoning: true } })]),
    snapshot: snapshot({ credentials: [credential({ id: "a" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(0);
  expect(excluded[0]?.reason).toBe("capability:tools");
});

test("excludes an open breaker inside its cooldown", () => {
  const { pairs, excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      health: [
        health({
          credentialId: "a",
          breakerState: "open",
          openedAt: NOW - 1_000,
          consecutiveFailures: 3,
        }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(0);
  expect(excluded[0]?.reason).toBe("breaker:open");
});

test("admits an open breaker whose cooldown has elapsed as a half-open probe", () => {
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      health: [
        health({
          credentialId: "a",
          breakerState: "open",
          openedAt: NOW - 60_000,
          consecutiveFailures: 3,
        }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(1);
});

test("cooldown grows exponentially with consecutive failures", () => {
  // threshold 3, base cooldown 30s. At 5 failures the backoff is 30s * 2^2.
  const openedAt = NOW - 100_000;
  const build = (failures: number) =>
    eligible({
      request: req,
      model: model(),
      snapshot: snapshot({
        credentials: [credential({ id: "a" })],
        health: [
          health({
            credentialId: "a",
            breakerState: "open",
            openedAt,
            consecutiveFailures: failures,
          }),
        ],
      }),
      now: NOW,
      rand: 0,
      load: new Map(),
    });
  expect(build(3).pairs).toHaveLength(1);
  expect(build(8).pairs).toHaveLength(0);
});

test("excludes a credential inside an observed rate-limit window", () => {
  const { excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      health: [health({ credentialId: "a", rateLimitedUntil: NOW + 5_000 })],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(excluded[0]?.reason).toBe("rateLimited");
});

test("an expired rate-limit window no longer excludes", () => {
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      health: [health({ credentialId: "a", rateLimitedUntil: NOW - 1 })],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(1);
});

test("a spent window past its reported reset no longer excludes", () => {
  // The snapshot is a reading from the last poll. Once the provider's own reset
  // time has passed, holding the credential out would strand it until the next
  // poll for a window that has already rolled over.
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      quota: [quota({ credentialId: "a", used: 100, limit: 100, resetsAt: NOW - 1 })],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(1);
});

test("a spent window whose reset is still ahead keeps excluding", () => {
  const { excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      quota: [quota({ credentialId: "a", used: 100, limit: 100, resetsAt: NOW + 60_000 })],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(excluded[0]?.reason).toBe("quota:fiveHour");
});

test("excludes a credential whose reported quota is spent", () => {
  const { excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      quota: [quota({ credentialId: "a", used: 100, limit: 100 })],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(excluded[0]?.reason).toBe("quota:fiveHour");
});

test("a quota window with no configured limit never excludes", () => {
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      quota: [quota({ credentialId: "a", used: 10_000, limit: null })],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(1);
});

test("excludes an expired credential that cannot be refreshed", () => {
  const dead = credential({ id: "a", expiresAt: NOW - 1, hasRefreshToken: false });
  const { excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [dead] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(excluded[0]?.reason).toBe("expired");
});

test("keeps an expired credential that has a refresh token", () => {
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [credential({ id: "a", expiresAt: NOW - 1 })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(1);
});

test("api-key credentials are never treated as expired", () => {
  const key = credential({
    id: "a",
    authType: "apiKey",
    expiresAt: NOW - 1,
    hasRefreshToken: false,
    secrets: async () => ({ accessToken: null, refreshToken: null, apiKey: "k", idToken: null }),
  });
  expect(
    eligible({
      request: req,
      model: model(),
      snapshot: snapshot({ credentials: [key] }),
      now: NOW,
      rand: 0,
      load: new Map(),
    }).pairs,
  ).toHaveLength(1);
});
