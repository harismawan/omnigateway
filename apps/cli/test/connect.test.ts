import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectFlows, ConnectPoll, ConnectStart } from "@omni/control";
import { GatewayError } from "@omni/ir";
import { PLUGIN_API_VERSION } from "@omnigateway/plugin-api";
import { cli, makeRoot } from "./helpers/harness.ts";

/** Writes a plugin into an installation's own `plugins/` directory. */
function writePluginDir(
  root: string,
  id: string,
  manifest: unknown,
  files: Record<string, string>,
): void {
  const home = join(root, "plugins", id);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "omni-plugin.json"), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(home, name), contents);
  }
}

/** A flow that answers exactly as a provider would, without one being there. */
function stubFlows(input: {
  start: Partial<ConnectStart>;
  polls?: ConnectPoll[];
  finish?: (flowId: unknown, code: unknown) => Promise<{ id: string }>;
}): { flows: ConnectFlows; finished: Array<{ flowId: unknown; code: unknown }>; polls: number } {
  const finished: Array<{ flowId: unknown; code: unknown }> = [];
  const remaining = [...(input.polls ?? [])];
  const record = { polls: 0 };

  const flows = {
    // Present because `ConnectFlows` has it, not because this stub's answer is
    // consulted: the command asks `env.connectable` — a separate dependency, so
    // that the gate runs before a store is opened — and the harness overrides
    // only `connect`. The tests below that assert a refusal are therefore
    // exercising the **real** `connectableProviders`.
    connectableIds: () => ["anthropic", "openai", "kimi", "kilo", "grok", "antigravity", "muse"],
    async start(): Promise<ConnectStart> {
      return {
        flowId: "flow-1",
        authorizeUrl: "https://provider.example/authorize?x=1",
        userCode: null,
        kind: "pkce",
        supportsManualPaste: true,
        pollIntervalMs: 1,
        ...input.start,
      };
    },
    async finish(flowId: unknown, code: unknown) {
      finished.push({ flowId, code });
      return input.finish === undefined ? { id: "cred-1" } : input.finish(flowId, code);
    },
    async poll(): Promise<ConnectPoll> {
      record.polls += 1;
      const next = remaining.shift();
      if (next === undefined) throw new GatewayError("INTERNAL", "polled too many times");
      return next;
    },
  } as unknown as ConnectFlows;

  return {
    flows,
    finished,
    get polls() {
      return record.polls;
    },
  };
}

async function installation(): Promise<string> {
  const root = makeRoot();
  await cli(["db", "migrate"], { root });
  return root;
}

test("a redirect flow prints the URL and completes with what the operator pasted", async () => {
  const root = await installation();
  const stub = stubFlows({ start: { kind: "pkce" } });

  const result = await cli(["connect", "anthropic", "--label", "work", "--json"], {
    root,
    connect: () => stub.flows,
    prompt: {
      isTty: true,
      secret: async () => "https://localhost:1455/auth/callback?code=abc&state=xyz",
      confirm: async () => true,
    },
  });

  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ id: "cred-1", provider: "anthropic" });
  // The URL goes to stderr, so `--json` on stdout stays parseable.
  expect(result.err).toContain("https://provider.example/authorize?x=1");
  expect(stub.finished[0]?.code).toBe("https://localhost:1455/auth/callback?code=abc&state=xyz");
});

test("a device flow shows the user code and polls until the operator approves", async () => {
  const root = await installation();
  const stub = stubFlows({
    start: { kind: "device", userCode: "WXYZ-1234", pollIntervalMs: 1 },
    polls: [{ status: "pending" }, { status: "pending" }, { status: "complete", id: "cred-9" }],
  });

  const result = await cli(["connect", "kimi", "--json"], {
    root,
    connect: () => stub.flows,
  });

  expect(result.code).toBe(0);
  expect(result.err).toContain("WXYZ-1234");
  expect(JSON.parse(result.out)).toMatchObject({ id: "cred-9" });
  expect(stub.polls).toBe(3);
});

test("a device flow never asks the operator to paste anything", async () => {
  const root = await installation();
  const stub = stubFlows({
    start: { kind: "device", userCode: "CODE", pollIntervalMs: 1 },
    polls: [{ status: "complete", id: "cred-2" }],
  });

  let asked = false;
  const result = await cli(["connect", "kimi"], {
    root,
    connect: () => stub.flows,
    prompt: {
      isTty: true,
      secret: async () => {
        asked = true;
        return "";
      },
      confirm: async () => true,
    },
  });

  expect(result.code).toBe(0);
  expect(asked).toBe(false);
});

test("an unknown provider is refused before a flow is started", async () => {
  const root = await installation();
  let started = false;
  const stub = stubFlows({ start: {} });

  const result = await cli(["connect", "notaprovider"], {
    root,
    connect: () => {
      started = true;
      return stub.flows;
    },
  });

  expect(result.code).toBe(2);
  // The whole line, matched exactly. `toContain` of the current message is a
  // prefix check wearing a disguise: it passes unchanged against a message that
  // has grown a provider on the end, which is precisely the drift the list is
  // here to catch. Only equality notices both a provider added and one dropped.
  expect(result.err.split("\n")[0]).toBe(
    "provider must be one of anthropic, openai, kimi, kilo, grok, antigravity, muse",
  );
  expect(started).toBe(false);
});

/**
 * `custom` is a provider this gateway has, and not one there is anything to
 * authorize for — it is reached by API key alone. The guard here used to be a
 * plain `isProviderId`, which accepted it and left the refusal to `start`, so
 * the list the operator was shown and the set the command took disagreed.
 */
test("connect refuses custom, which is a provider with no flow to start", async () => {
  const root = await installation();
  let started = false;
  const stub = stubFlows({ start: {} });

  const result = await cli(["connect", "custom"], {
    root,
    connect: () => {
      started = true;
      return stub.flows;
    },
  });

  expect(result.code).toBe(2);
  expect(result.err.split("\n")[0]).toBe(
    "provider must be one of anthropic, openai, kimi, kilo, grok, antigravity, muse",
  );
  expect(started).toBe(false);
});

test("a provider that repudiates the code fails the command rather than half-connecting", async () => {
  const root = await installation();
  const stub = stubFlows({
    start: { kind: "pkce" },
    finish: async () => {
      throw new GatewayError("AUTH", "authorization state mismatch");
    },
  });

  const result = await cli(["connect", "openai"], {
    root,
    connect: () => stub.flows,
    prompt: { isTty: true, secret: async () => "pasted", confirm: async () => true },
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain("state mismatch");

  const listed = await cli(["credentials", "list", "--json"], { root });
  expect(JSON.parse(listed.out)).toEqual({ credentials: [] });
});

/** A plugin whose provider authorizes by PKCE, for the real-flows test below. */
const ACME_OAUTH_PLUGIN = `
const DESCRIPTOR = {
  id: "acme-ai",
  capabilities: { tools: false, images: false, reasoning: false },
  writeOverInput: { fiveMinute: 1.25, oneHour: 2 },
  catalog: {
    defaultModel: "acme-large",
    authTypes: ["oauth"],
    models: [{
      id: "acme-large",
      label: "Acme Large",
      pricing: { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 },
      limits: { contextWindow: 1000, maxOutputTokens: 100 },
    }],
  },
  modelPrefixes: ["acme-"],
  presentation: { label: "Acme", tone: "warm", order: 90, colour: { light: "#a36", dark: "#f8b" } },
};
const codec = {
  buildRequest: (input) => ({
    request: { url: "https://api.acme.test/v1/x", method: "POST", headers: [], body: "{}" },
  }),
  decode: async function* () {},
};
const oauth = {
  kind: "pkce",
  supportsManualPaste: true,
  async *start(input) {
    const { verifier, challenge } = input.pkce();
    return {
      authorizeUrl: "https://api.acme.test/authorize?c=" + challenge,
      pending: { verifier, challenge, state: input.randomState(), redirectUri: input.redirectUri },
    };
  },
  async *exchange(input) {
    const res = yield { url: "https://api.acme.test/token", method: "POST", headers: [], body: "{}" };
    if (res.status !== 200) throw input.fail("AUTH", "refused");
    return {
      secrets: { accessToken: "a", refreshToken: null, apiKey: null, idToken: null },
      expiresAt: null,
      accountEmail: null,
      providerData: {},
    };
  },
  async *refresh(input) {
    const res = yield { url: "https://api.acme.test/token", method: "POST", headers: [], body: "{}" };
    if (res.status !== 200) throw input.fail("AUTH", "refused");
    return {
      secrets: { accessToken: "b", refreshToken: null, apiKey: null, idToken: null },
      expiresAt: null,
      accountEmail: null,
      providerData: {},
    };
  },
};
export default { providers: [{ descriptor: DESCRIPTOR, codec, oauth }], setup() { return {}; } };
`;

/**
 * `omni connect` against the **real** `createConnectFlows`, not a stub.
 *
 * Every other test in this file replaces `connect:` with a fake `ConnectFlows`,
 * which is the right shape for asserting what the command prints — and
 * structurally unable to see the bug this file exists for.
 *
 * That bug: the command's gate read the merged registry while
 * `createConnectFlows.start` read the module-global `PROVIDER_DESCRIPTORS`. The
 * gateway populates that global at boot; this process never does and must not,
 * because `loadPlugins` runs migrations and registers routes. So a plugin's
 * provider was admitted by one gate and refused by the next — with a message
 * naming the provider it had just refused, because `unconnectable()` builds its
 * list from the injected map. Two registries, one call, opposite answers.
 *
 * The gateway's own e2e cannot catch it either: it runs `installPluginProviders`
 * first, so it exercises the one process where the global *is* populated.
 */
test("connect reaches a plugin-supplied provider, through the real flows", async () => {
  const root = await installation();
  writePluginDir(
    root,
    "acme-ai",
    {
      id: "acme-ai",
      name: "Acme",
      version: "1.0.0",
      api: PLUGIN_API_VERSION,
      server: "server.js",
      capabilities: ["provider"],
      origins: ["https://api.acme.test"],
    },
    { "server.js": ACME_OAUTH_PLUGIN },
  );

  // No `connect:` override — this is the whole point.
  //
  // The prompt throws so the command stops after printing the authorize URL.
  // `silentPrompt` answers "" immediately, which would carry it into
  // `finish` → the plugin's `exchange` → a **real** request to
  // `api.acme.test`, and no test may reach a network. What is under test is
  // `start`, which is where the two registries disagreed.
  const result = await cli(["connect", "acme-ai"], {
    root,
    prompt: {
      isTty: false,
      input: async () => "",
      confirm: async () => true,
      secret: async () => {
        throw new Error("stop before the exchange");
      },
    },
  });

  // It must not be refused by the connectable gate, and it must not be refused
  // by `start` either. Before the fix the second refusal read:
  //   "provider must be one of anthropic, openai, kimi, kilo, grok, muse, acme-ai"
  // — a list containing the provider it was refusing.
  expect(result.err).not.toContain("provider must be one of");
  expect(result.out + result.err).toContain("https://api.acme.test/authorize");
});

test("connect still refuses a provider no plugin supplies", async () => {
  // The control. A gate that admitted everything would satisfy the test above.
  const root = await installation();
  const result = await cli(["connect", "notaprovider"], { root });

  expect(result.code).toBe(2);
  expect(result.err).toContain("provider must be one of");
  expect(result.err).not.toContain("notaprovider,");
});
