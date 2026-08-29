/**
 * A plugin's provider, from the plugin directory on disk to the client's bytes.
 *
 * Every other file in this area tests one joint: `pluginProviders.test.ts` proves
 * a declaration is validated, `install.test.ts` proves a validated one reaches
 * the registry, `kiloCodec.test.ts` proves `codecAdapter` performs what a codec
 * describes. None of them routes a request. The design that added the capability
 * asked for exactly this and said why: "anything less tests registration rather
 * than the provider working"
 * (`docs/superpowers/specs/2026-08-28-plugin-provider-capability-design.md`).
 *
 * So this boots the host's own `loadPlugins` against a real directory, installs
 * what it read through the same `installPluginProviders` boot calls, and then
 * sends an ordinary `POST /v1/messages` through `createApp`. Nothing about the
 * provider is injected: `createApp` is given no `adapters`, so routing, pricing
 * and dispatch each reach the module-global registry that `registerProvider`
 * mutated — which is the property the whole widening of `ProviderId` was for, and
 * the one no unit test in this area can observe.
 *
 * **The fixture's wire format is deliberately nobody's.** It is not SSE, not
 * Anthropic's shape and not OpenAI's; it is one JSON document this plugin
 * invented. A fixture that spoke a format some built-in decoder understands
 * would pass this test with the plugin's `decode` never called, which is the
 * assertion the file exists to make.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, PROVIDER_DESCRIPTORS } from "@omni/providers";
import type { Store } from "@omni/store";
import { createStore, deriveKey } from "@omni/store";
import { captureLogger, seedApiKey } from "@omni/testkit";
import { PLUGIN_API_VERSION } from "@omnigateway/plugin-api";
import { createApp } from "../../src/app.ts";
import { createPluginEventBus, type PluginEventBus } from "../../src/plugins/events.ts";
import { installPluginProviders } from "../../src/plugins/install.ts";
import { loadPlugins } from "../../src/plugins/loader.ts";
import { createChannelRegistry } from "../../src/stream/channels.ts";
import { createStubUpstream, header, type StubUpstream } from "./upstream.ts";

const NOW = 1_000_000;
const PLUGIN_ID = "acme-ai";

/**
 * The plugin's server module, as a plugin author would ship it.
 *
 * Plain JavaScript with no imports, for the reason the design gives: the codec
 * types live in `@omni/providers` and cannot be published until `@omni/ir` is,
 * so an in-repo plugin can be typed against the contract and a real one cannot
 * yet. Writing this fixture as untyped JS is therefore closer to the truth of
 * what a third-party plugin will look like than a typed one would be.
 *
 * `providers` is a field on the definition rather than something `setup` calls,
 * so a reader of the manifest and the module can see what is supplied without
 * running any of it — which is what lets the CLI answer for a plugin provider
 * without ever building a context.
 */
const ACME_SERVER = `
const DESCRIPTOR = {
  id: "acme-ai",
  capabilities: { tools: true, images: false, reasoning: false },
  writeOverInput: { fiveMinute: 1.25, oneHour: 2 },
  catalog: {
    defaultModel: "acme-large",
    authTypes: ["apiKey"],
    models: [
      {
        id: "acme-large",
        label: "Acme Large",
        pricing: { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 },
        limits: { contextWindow: 111000, maxOutputTokens: 4096 },
      },
    ],
  },
  modelPrefixes: ["acme-"],
  presentation: {
    label: "Acme",
    tone: "warm",
    order: 90,
    colour: { light: "#aa3366", dark: "#ff88bb" },
  },
};

const codec = {
  buildRequest(input) {
    return {
      request: {
        url: "https://api.acme.test/v1/converse",
        method: "POST",
        headers: [
          ["content-type", "application/json"],
          ["x-acme-key", input.credentials.apiKey],
        ],
        // A shape no built-in sends: the host must be forwarding what the codec
        // built rather than anything it assembled itself.
        body: JSON.stringify({
          acmeModel: input.model,
          turns: input.request.messages.length,
        }),
      },
      decodeState: { model: input.model },
      degradations: ["acme:invented-a-degradation"],
    };
  },

  async *decode(input) {
    const payload = JSON.parse(await new Response(input.body).text());
    yield { type: "start", id: payload.reply_id, model: input.decodeState.model };
    yield { type: "blockStart", index: 0, block: { type: "text" } };
    yield { type: "blockDelta", index: 0, delta: { type: "text", text: payload.say } };
    yield { type: "blockEnd", index: 0 };
    yield {
      type: "end",
      stopReason: "endTurn",
      usage: { inputTokens: 31, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

// setup() is required even of a plugin that supplies nothing else: the loader
// refuses a module with no default export carrying one. A provider-only plugin
// therefore writes this empty function, which is a small cost and a real one.
export default {
  providers: [{ descriptor: DESCRIPTOR, codec }],
  setup() {
    return {};
  },
};
`;

/** What the fixture upstream answers, in the format only this plugin can read. */
const ACME_RESPONSE = {
  kind: "json" as const,
  status: 200,
  body: { reply_id: "acme_reply_1", say: "Acme speaking" },
};

let dir = "";
let store: Store;
let buses: PluginEventBus[] = [];
const installed: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omni-plugin-provider-"));
  store = await createStore({
    path: join(dir, "test.db"),
    encryptionKey: await deriveKey("0".repeat(64)),
  });
  buses = [];
});

afterEach(async () => {
  for (const bus of buses) bus.stop();
  store.close();
  // The registry is module state and `registerProvider` refuses a duplicate, so
  // a provider left behind would fail the *next* run of this file rather than
  // this one — the shape of leak that reads as flakiness.
  for (const id of installed.splice(0)) {
    delete (PROVIDER_DESCRIPTORS as Record<string, unknown>)[id];
    delete (ADAPTERS as Record<string, unknown>)[id];
  }
  await rm(dir, { recursive: true, force: true });
});

/** Writes the plugin, loads it the way boot does, and installs what it declared. */
async function bootPlugin(over: { origins?: readonly string[] } = {}): Promise<void> {
  const root = join(dir, "plugins");
  const home = join(root, PLUGIN_ID);
  await mkdir(join(home, "server"), { recursive: true });
  await writeFile(
    join(home, "omni-plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      name: "The Acme Provider",
      version: "1.0.0",
      api: PLUGIN_API_VERSION,
      server: "server/index.js",
      capabilities: ["provider"],
      // Must match what the codec below actually calls. The host refuses a
      // request to an origin the manifest does not name, so these two agreeing
      // is part of what this test asserts rather than incidental setup.
      origins: over.origins ?? ["https://api.acme.test"],
    }),
  );
  await writeFile(join(home, "server", "index.js"), ACME_SERVER);

  const bus = createPluginEventBus({});
  buses.push(bus);
  const result = await loadPlugins({
    root,
    store,
    events: bus,
    channels: createChannelRegistry({ sockets: { has: () => false, sendTo: () => {} } }),
    sdkVersion: "1.0.0",
  });

  // Asserted rather than assumed: a loader failure here would otherwise surface
  // as a 503 from routing, which reads as a routing bug.
  expect(result.failures).toEqual([]);
  expect(result.providers.map((p) => p.descriptor.id)).toEqual([PLUGIN_ID]);

  installed.push(PLUGIN_ID);
  installPluginProviders(result.providers, captureLogger());
}

async function harness(): Promise<{
  upstream: StubUpstream;
  call: (body: unknown) => Promise<Response>;
}> {
  await store.credentials.create({
    id: "acme-1",
    provider: PLUGIN_ID,
    label: "acme-1",
    authType: "apiKey",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    disabledReason: null,
    disabledAt: null,
    accessToken: null,
    refreshToken: null,
    apiKey: "acme-secret",
    idToken: null,
  });
  const { raw } = await seedApiKey(store, { label: "plugin-provider-e2e" });

  const upstream = createStubUpstream();
  const app = createApp({
    store,
    baseUrl: "http://localhost:9000",
    now: () => NOW,
    rand: () => 0.5,
    http: upstream.http,
    requestId: () => "req_acme_1",
    // No `adapters`. Every registry read on this path is a call-time read of the
    // global the plugin mutated, which is the thing under test.
  });

  const call = (body: unknown) =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
        body: JSON.stringify(body),
      }),
    );

  return { upstream, call };
}

test("a plugin's provider serves a request end to end, on a configured target", async () => {
  await bootPlugin();
  await store.config.putModel({
    id: "acme-pool",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: PLUGIN_ID,
        model: "acme-large",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 4, output: 20, cacheRead: 0.4 },
        capabilities: { tools: true, images: false, reasoning: false },
      },
    ],
  });
  const { call, upstream } = await harness();
  upstream.queue(ACME_RESPONSE);

  const res = await call({
    model: "acme-pool",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello acme" }],
  });

  expect(res.status).toBe(200);

  // The codec's request reached the transport, verbatim and whole: its URL, a
  // header no built-in sends, and a body in a shape none of them builds. The
  // credential is the decrypted one for this provider — the single documented
  // exception to "a plugin never receives a secret".
  expect(upstream.calls).toHaveLength(1);
  const sent = upstream.calls[0];
  if (sent === undefined) throw new Error("the codec never reached the transport");
  expect(sent.url).toBe("https://api.acme.test/v1/converse");
  expect(header(sent, "x-acme-key")).toBe("acme-secret");
  expect(sent.body).toEqual({ acmeModel: "acme-large", turns: 1 });

  // And the codec's decoded events reached the client. The text exists nowhere
  // but this plugin's own `decode`, so a host that fell back to any built-in
  // decoder cannot produce it.
  const body = (await res.json()) as {
    content: { type: string; text: string }[];
    usage: Record<string, number>;
  };
  expect(body.content).toEqual([{ type: "text", text: "Acme speaking" }]);
  expect(body.usage.input_tokens).toBe(31);
  expect(body.usage.output_tokens).toBe(7);
});

test("routing infers the plugin's own model prefix, and prices from its catalog", async () => {
  // The other half, and it is a different code path rather than a variation:
  // a configured pool short-circuits `resolveModel` before any registry is
  // consulted, so only a bare model name proves the prefix table and the catalog
  // are the plugin's.
  await bootPlugin();
  const { call, upstream } = await harness();
  upstream.queue(ACME_RESPONSE);

  const res = await call({
    model: "acme-large",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello acme" }],
  });

  expect(res.status).toBe(200);
  expect(upstream.calls).toHaveLength(1);

  const logs = await store.usage.recent(10);
  const log = logs.find((row) => row.id === "req_acme_1");
  expect(log?.resolvedProvider).toBe(PLUGIN_ID);
  expect(log?.resolvedModel).toBe("acme-large");
  // 31 input at 4/M plus 7 output at 20/M, both from the plugin's own catalog.
  // No built-in charges these, and an un-injected fallback bills zero.
  expect(log?.costUsd).toBeCloseTo((31 * 4 + 7 * 20) / 1_000_000, 12);
  // What the codec reported it could not express is recorded, not interpreted.
  expect(log?.degradations).toContain("acme:invented-a-degradation");
});

test("a plugin cannot reach an origin its manifest never declared", async () => {
  // The audit surface, enforced end to end. A provider plugin never holds a
  // client — it directs the host's — so nothing about this path passed through
  // the check that bounds a plugin's own `fetch`, and an operator reading the
  // manifest could not see where their prompts went.
  //
  // The fixture is the same plugin with one word changed in its manifest, so
  // what is under test is the enforcement and not the plugin.
  await bootPlugin({ origins: ["https://somewhere.else.test"] });
  const { call, upstream } = await harness();
  upstream.queue(ACME_RESPONSE);

  const res = await call({
    model: "acme-large",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello acme" }],
  });

  expect(res.status).toBeGreaterThanOrEqual(400);
  // Never sent. Reporting it afterwards would mean the prompt already left.
  expect(upstream.calls).toEqual([]);
});
