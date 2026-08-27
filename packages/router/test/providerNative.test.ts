import { expect, test } from "bun:test";
import type { ChatRequest, ProviderId } from "@omni/ir";
import { credential, snapshot, target } from "@omni/testkit";
import { eligible, requiredProvider } from "../src/filters.ts";

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
  expect(
    requiredProvider({
      ...req,
      tools: [{ kind: "portable", name: "f", inputSchema: {} }],
    }),
  ).toBeUndefined();
});

test("a provider-defined tool names its provider", () => {
  expect(requiredProvider({ ...req, tools: [webSearch] })).toBe("anthropic");
});

test("provider-native history names its producer", () => {
  expect(requiredProvider({ ...req, messages: nativeHistory })).toBe("anthropic");
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
const NATIVE_TOOLS_BEFORE: Readonly<Record<ProviderId, boolean>> = {
  anthropic: true,
  openai: false,
  kimi: false,
  kilo: false,
  grok: false,
  custom: false,
};

const IDS = Object.keys(NATIVE_TOOLS_BEFORE) as ProviderId[];

/** The rule as it stood, applied to one target. */
function admittedBefore(needNative: boolean, provider: ProviderId): boolean {
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
