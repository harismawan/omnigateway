import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { credential, snapshot, target } from "@omni/testkit";
import { eligible, requiredProviders } from "../src/filters.ts";

const NOW = 1_000_000;

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const webSearch = {
  kind: "provider" as const,
  provider: "anthropic" as const,
  family: "webSearch" as const,
  type: "web_search_20250305",
  name: "web_search",
  wire: {},
};

const nativeHistory: ChatRequest["messages"] = [
  {
    role: "assistant",
    content: [
      {
        type: "providerNative",
        provider: "anthropic",
        blockType: "web_search_tool_result",
        data: { tool_use_id: "srvtoolu_1", content: [] },
      },
    ],
  },
];

const model = (targets: ReturnType<typeof target>[]) => ({
  id: "fast",
  strategy: "score" as const,
  isAlias: false,
  targets,
});

test("a portable custom tool names no provider", () => {
  expect([
    ...requiredProviders({
      ...req,
      tools: [{ kind: "portable", name: "f", inputSchema: {} }],
    }),
  ]).toEqual([]);
});

test("a provider-defined tool names its provider", () => {
  expect([...requiredProviders({ ...req, tools: [webSearch] })]).toEqual(["anthropic"]);
});

test("provider-native history names its producer", () => {
  expect([...requiredProviders({ ...req, messages: nativeHistory })]).toEqual(["anthropic"]);
});

/**
 * A request naming two providers, which the singular version could not express.
 *
 * It returned the *first* provider-owned item — `find` short-circuiting before
 * the history scan — so this request was admitted to anthropic targets and the
 * `acme` block was then handed to `anthropic/wire.ts`, whose `encodeBlock`
 * spreads `data` verbatim. A payload one provider produced would have been
 * transmitted to another, opaque contents and all.
 *
 * Unreachable through today's ingress: both construction sites write
 * `provider: "anthropic"` as a literal, and a foreign block replayed by a client
 * fails `ANTHROPIC_NATIVE_BLOCK_TYPES`. It becomes reachable the moment a plugin
 * codec emits `providerNative` blocks, which is what this branch exists to make
 * possible — and by then the two wire encoders that gave up their own
 * self-checks will have been citing this rule for a release.
 */
const acmeNative: ChatRequest["messages"] = [
  {
    role: "assistant",
    content: [
      {
        type: "providerNative",
        provider: "acme",
        blockType: "acme_lookup",
        data: { id: "srv_1", secret_state: "acme-only" },
      },
    ],
  },
];

test("a request owned by two providers names both", () => {
  const both = { ...req, tools: [webSearch], messages: acmeNative };
  expect([...requiredProviders(both)].sort()).toEqual(["acme", "anthropic"]);
});

test("two history blocks from different providers name both", () => {
  // **Not the same test as the one above**, and the difference is the whole
  // point. That one puts one owner in `tools` and the other in `messages`, so
  // the tools loop has already contributed before the history loop runs — which
  // means it cannot see a history loop that returns on its first hit. The commit
  // fixing this named *two* short-circuits and only one of them was pinned:
  // restoring the second passed the entire repository suite, and the request
  // then died at encode as a non-retryable 500 instead of failing to route.
  const mixed: ChatRequest["messages"] = [
    { role: "assistant", content: [acmeNative[0]?.content[0] as never] },
    {
      role: "assistant",
      content: [
        {
          type: "providerNative",
          provider: "anthropic",
          blockType: "web_search_tool_result",
          data: { tool_use_id: "srvtoolu_1", content: [] },
        },
      ],
    },
  ];
  expect([...requiredProviders({ ...req, messages: mixed })].sort()).toEqual(["acme", "anthropic"]);
});

test("a provider-native block in the system prompt names its producer", () => {
  // `ChatRequest.system` is a `ContentBlock[]`, so it carries these too, and it
  // was not scanned. Such a request routed to *any* provider with an empty
  // exclusion list — while this function's own first line claims to name every
  // provider the request carries.
  const system: ChatRequest["system"] = [
    {
      type: "providerNative",
      provider: "acme",
      blockType: "acme_lookup",
      data: { id: "srv_1" },
    },
  ];
  expect([...requiredProviders({ ...req, system })]).toEqual(["acme"]);

  const { pairs, excluded } = eligible({
    request: { ...req, system },
    model: model([target({ provider: "openai", model: "gpt-5" })]),
    snapshot: snapshot({ credentials: [credential({ id: "o", provider: "openai" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toEqual([]);
  expect(excluded).toMatchObject([{ kind: "target", reason: "capability:providerNative" }]);
});

test("a request owned by two providers can be served by neither", () => {
  const { pairs, excluded } = eligible({
    request: { ...req, tools: [webSearch], messages: acmeNative },
    model: model([target({ provider: "anthropic", model: "claude" })]),
    snapshot: snapshot({ credentials: [credential({ id: "a1", provider: "anthropic" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  // The anthropic target matched the first-found owner and was admitted before.
  expect(pairs).toEqual([]);
  // And it fails with a reason rather than an empty exclusion list, which is the
  // whole distinction `provider:missing` and `pin:missing` exist to preserve.
  expect(excluded).toMatchObject([{ kind: "target", reason: "capability:providerNative" }]);
});

test("a request naming Anthropic excludes OpenAI and Kimi targets", () => {
  const { pairs, excluded } = eligible({
    request: { ...req, tools: [webSearch] },
    model: model([
      target({ provider: "openai", model: "gpt-5" }),
      target({ provider: "kimi", model: "k2" }),
      target({ provider: "anthropic", model: "claude-opus-4" }),
    ]),
    snapshot: snapshot({
      credentials: [
        credential({ id: "o", provider: "openai" }),
        credential({ id: "k", provider: "kimi" }),
        credential({ id: "a", provider: "anthropic" }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs.map((p) => p.credential.id)).toEqual(["a"]);
  expect(excluded.map((e) => e.reason)).toEqual([
    "capability:providerNative",
    "capability:providerNative",
  ]);
});

// Dispatch redacts `credentialId` from the degradation for these and only
// these, and it reads this discriminator to decide. Pinned here rather than
// only in dispatch, because the router is what sets it.
test("a provider mismatch is a fact about the target, not the account", () => {
  const { excluded } = eligible({
    request: { ...req, tools: [webSearch] },
    model: model([target({ provider: "openai", model: "gpt-5" })]),
    snapshot: snapshot({ credentials: [credential({ id: "o", provider: "openai" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(excluded.map((e) => e.kind)).toEqual(["target"]);
});

test("a missing portable capability stays a fact about the account", () => {
  const { excluded } = eligible({
    request: { ...req, tools: [{ kind: "portable", name: "f", inputSchema: {} }] },
    model: model([
      target({
        provider: "openai",
        model: "gpt-5",
        capabilities: { tools: false, images: true, reasoning: true },
      }),
    ]),
    snapshot: snapshot({ credentials: [credential({ id: "o", provider: "openai" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(excluded.map((e) => [e.kind, e.reason])).toEqual([["account", "capability:tools"]]);
});

// The routing half of the `kind` rename. Under the old discriminant this tool
// was spelled `provider: "custom"` — the same string a portable tool carried —
// so "which provider owns this" had no answer to read.
test("a tool the custom provider defines routes only to custom targets", () => {
  const { pairs } = eligible({
    request: {
      ...req,
      tools: [
        {
          kind: "provider",
          provider: "custom",
          family: "webSearch",
          type: "web_search_20250305",
          name: "web_search",
          wire: {},
        },
      ],
    },
    model: model([
      target({ provider: "anthropic", model: "claude-opus-4" }),
      target({ provider: "custom", model: "llama" }),
    ]),
    snapshot: snapshot({
      credentials: [
        credential({ id: "a", provider: "anthropic" }),
        credential({ id: "c", provider: "custom" }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs.map((p) => p.credential.id)).toEqual(["c"]);
});

test("a pool with no Anthropic target yields no candidates at all", () => {
  const { pairs } = eligible({
    request: { ...req, tools: [webSearch] },
    model: model([target({ provider: "openai", model: "gpt-5" })]),
    snapshot: snapshot({ credentials: [credential({ id: "o", provider: "openai" })] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs).toHaveLength(0);
});

test("a portable custom tool still routes to every provider", () => {
  const { pairs } = eligible({
    request: { ...req, tools: [{ kind: "portable", name: "f", inputSchema: {} }] },
    model: model([
      target({ provider: "openai", model: "gpt-5" }),
      target({ provider: "anthropic", model: "claude-opus-4" }),
    ]),
    snapshot: snapshot({
      credentials: [
        credential({ id: "o", provider: "openai" }),
        credential({ id: "a", provider: "anthropic" }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });
  expect(pairs.map((p) => p.credential.id).sort()).toEqual(["a", "o"]);
});

/**
 * A verbatim copy of `ANTHROPIC_NATIVE_TOOLS` as it stood in
 * `packages/ir/src/capabilities.ts`, and then briefly as
 * `ProviderDescriptor.anthropicNativeTools`, before the routing rule started
 * reading the request's own data instead.
 *
 * Checked in as a literal on purpose. The old rule was "exclude every target
 * whose entry is false"; the new one is "admit only the producing provider".
 * An equivalence test that read the live registry on both sides would agree
 * with any table at all, including one that had drifted — which is the whole
 * failure this fixture exists to prevent.
 */
const NATIVE_TOOLS_BEFORE = {
  anthropic: true,
  openai: false,
  kimi: false,
  kilo: false,
  grok: false,
  custom: false,
} as const satisfies Readonly<Record<string, boolean>>;

/**
 * The six the fixture names.
 *
 * `ProviderId` is a validated string now, so `Record<ProviderId, boolean>`
 * would make every read of the fixture `| undefined` and let a provider go
 * missing from it silently — the exact drift the fixture exists to catch. The
 * literal keys are the totality, so they are what the reads are keyed on.
 */
type BuiltIn = keyof typeof NATIVE_TOOLS_BEFORE;

const IDS = Object.keys(NATIVE_TOOLS_BEFORE) as BuiltIn[];

/** The rule as it stood, applied to one target. */
function admittedBefore(needNative: boolean, provider: BuiltIn): boolean {
  return !needNative || NATIVE_TOOLS_BEFORE[provider];
}

test("the new rule selects exactly the targets the old table selected", () => {
  const cases: Array<{ name: string; request: ChatRequest; needNative: boolean }> = [
    { name: "provider-defined tool", request: { ...req, tools: [webSearch] }, needNative: true },
    {
      name: "provider-native history",
      request: { ...req, messages: nativeHistory },
      needNative: true,
    },
    {
      name: "portable tool only",
      request: { ...req, tools: [{ kind: "portable", name: "f", inputSchema: {} }] },
      needNative: false,
    },
    { name: "neither", request: req, needNative: false },
  ];

  for (const c of cases) {
    const { pairs } = eligible({
      request: c.request,
      model: model(IDS.map((id) => target({ provider: id, model: `m-${id}` }))),
      snapshot: snapshot({
        credentials: IDS.map((id) => credential({ id, provider: id })),
      }),
      now: NOW,
      rand: 0,
      load: new Map(),
    });
    const now = pairs.map((p) => p.target.provider).sort();
    const before = IDS.filter((id) => admittedBefore(c.needNative, id)).sort();
    expect(now, c.name).toEqual(before);
  }
});

/**
 * The reason row for the rule beside the pin.
 *
 * `pin:missing` exists because a pin that matches no account drops every
 * credential silently and would fail the request with nothing in `excluded` to
 * explain it. The endpoint rule does exactly the same thing and had no such row:
 * a target naming an endpoint no account is at — or carrying a corrupt one after
 * an unvalidated read — failed every request with an empty exclusion list, and
 * `omni doctor` only inspects pinned targets.
 */
test("a target no account can serve reports why, even unpinned", () => {
  const { pairs, excluded } = eligible({
    request: req,
    model: model([target({ provider: "custom", model: "m", endpointId: "nowhere" })]),
    snapshot: snapshot({
      credentials: [credential({ id: "c", provider: "custom", providerData: { endpointId: "a" } })],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs).toEqual([]);
  expect(excluded.map((e) => [e.kind, e.reason])).toEqual([["target", "endpoint:unmatched"]]);
});

test("a provider with no accounts at all stays silent", () => {
  // An empty pool is already legible; a row per unconnected provider would be
  // noise on every dry-run.
  const { pairs, excluded } = eligible({
    request: req,
    model: model([target({ provider: "custom", model: "m", endpointId: "nowhere" })]),
    snapshot: snapshot({ credentials: [] }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(pairs).toEqual([]);
  expect(excluded).toEqual([]);
});

test("an account dropped for its own reason is not also reported as unservable", () => {
  // Disabled, expired, breakered and quota-spent each leave their own row. Only
  // a target nothing serves is unexplained, so the two must not double up.
  const { excluded } = eligible({
    request: req,
    model: model([target({ provider: "custom", model: "m", endpointId: "a" })]),
    snapshot: snapshot({
      credentials: [
        credential({
          id: "c",
          provider: "custom",
          enabled: false,
          providerData: { endpointId: "a" },
        }),
      ],
    }),
    now: NOW,
    rand: 0,
    load: new Map(),
  });

  expect(excluded.map((e) => e.reason)).toEqual(["disabled"]);
});
