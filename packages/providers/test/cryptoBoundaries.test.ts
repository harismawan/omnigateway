import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { type ChatRequest, GatewayError } from "@omni/ir";
import { antigravityCodec } from "../src/antigravity/codec.ts";
import { applyAnthropicSystem } from "../src/body.ts";
import type { ProviderCodec } from "../src/codec.ts";
import { grokCodec } from "../src/grok/codec.ts";
import { grokDeviceHeaders, mintGrokDevice } from "../src/grok/device.ts";
import { toGrokWire } from "../src/grok/wire.ts";
import { kimiDeviceHeaders, mintKimiDevice } from "../src/kimi/device.ts";
import { toMuseWire } from "../src/muse/wire.ts";
import { openaiCodec } from "../src/openai/codec.ts";
import { keyed, uuidV5 } from "../src/openai/codexIdentity.ts";

const UNICODE = "会話🦊 café";
const SALT = "0123456789abcdef".repeat(4);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const request = (seed: string): ChatRequest => ({
  model: "pool",
  conversationId: seed,
  system: [{ type: "text", text: seed }],
  messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
  stream: true,
});

function build(codec: ProviderCodec, seed: string, providerData: Record<string, unknown> = {}) {
  return codec.buildRequest({
    request: request(seed),
    model: "gpt-6-astra",
    credentials: { accessToken: "tok", apiKey: null, providerData },
    requestId: seed,
    requestStartedAt: 1_792_140_063_816,
    fail: (code, message) => new GatewayError(code, message),
  }).request;
}

test("Anthropic billing consumes the three-digit SHA256 suffix, including UTF16 indexing", () => {
  for (const [seed, suffix] of [
    ["", "406"],
    [UNICODE, "f1d"],
    ["abcd🦊x雪abcdefghijkl界", "39c"],
  ] as const) {
    expect(applyAnthropicSystem([], seed)[0]?.text).toContain(`.${suffix};`);
  }
});

for (const [provider, encode, unicodeKey, emptyKey] of [
  ["Muse", toMuseWire, "afda0bc71e44d08cf12f6dbaf625a329", "67724b4d71fd204f12e4debfca316e30"],
  ["Grok", toGrokWire, "0991f93697d008e553dfd177e61b8372", "f454f4b82e5af5d640f138f2c3ade4cc"],
] as const) {
  test(`${provider} emits exactly the first 32 SHA256 hex digits of the serialized cache seed`, () => {
    expect(encode(request(UNICODE), "model").body.prompt_cache_key).toBe(unicodeKey);
    expect(
      encode({ model: "pool", messages: [], stream: true }, "model").body.prompt_cache_key,
    ).toBe(emptyKey);
  });
}

test("Grok identity headers consume namespaced SHA256 with v5 and variant bits", () => {
  const sent = build(grokCodec, UNICODE);
  expect(sent.headers).toContainEqual(["x-grok-conv-id", "ff9218b0-bc42-5c72-bedd-095097019a4d"]);
  expect(sent.headers).toContainEqual([
    "x-grok-session-id",
    "ff9218b0-bc42-5c72-bedd-095097019a4d",
  ]);
  expect(build(grokCodec, "").headers.some(([name]) => name === "x-grok-conv-id")).toBe(false);
});

test("Antigravity fallback request id consumes namespace, model and Unicode project", () => {
  const sent = antigravityCodec.buildRequest({
    request: request(""),
    model: UNICODE,
    credentials: { accessToken: "tok", apiKey: null, providerData: { projectId: "project-雪" } },
    fail: (code, message) => new GatewayError(code, message),
  }).request;
  expect(JSON.parse(sent.body).requestId).toBe("2b68b718-c49e-4751-8d18-52fec7a16f81");
});

test("Codex codec preserves SHA Buffer timestamp reads, SHA1 namespace bytes and UTF8 HMAC salt", () => {
  const sent = build(openaiCodec, UNICODE, { accountId: UNICODE, idSalt: SALT });
  const body = JSON.parse(sent.body);
  const metadata = JSON.parse(new Map(sent.headers).get("x-codex-turn-metadata") ?? "null");
  expect(body.prompt_cache_key).toBe("019c7b5b-d6cf-733a-bc2f-55084374fe8a");
  expect(metadata.installation_id).toBe("64630a66-48c8-4b6a-bb0d-47ab9a19e074");
  expect(metadata.context_window_id).toBe("019c7b5b-d6cf-7464-b71d-b834670e89b3");
  expect(metadata.turn_id).toBe("019c7b5b-d6cf-77c8-a8d6-423d9228c822");
  expect(body.input.map((item: { id: string }) => item.id)).toEqual([
    "msg_2d316b43-cf48-51d7-b3d7-269da314819c",
    "msg_01a143df-3448-79eb-8038-ebf4d0fc608a",
  ]);
  expect(JSON.parse(build(openaiCodec, "", { accountId: "" }).body).prompt_cache_key).toBe(
    "019ea3d3-c026-7133-8793-396a5f61d523",
  );
  expect(JSON.parse(build(openaiCodec, UNICODE).body).prompt_cache_key).toBe(
    "019f3e30-40ff-708c-b12f-6dbaf625a329",
  );
});

test("Codex accepted empty SHA1 and HMAC values retain literal RFC-compatible digests", () => {
  expect(uuidV5("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "")).toBe(
    "0a68eb57-c88a-5f34-9e9d-27f85e68af4f",
  );
  expect(keyed("", "")).toBe("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad");
  expect(keyed(SALT, UNICODE)).toBe(
    "7d39425d4d10185722184e6ea363a6614fad9f6887d223ac1b3a8fa71948d5a2",
  );
  expect(keyed(undefined, UNICODE)).toBe(UNICODE);
});

test("minted device UUIDv4 values survive repeated persisted header reads", () => {
  const kimi = mintKimiDevice();
  const grok = mintGrokDevice();
  expect(kimi.deviceId).toMatch(UUID_V4);
  expect(grok.agentId).toMatch(UUID_V4);
  const stored = JSON.parse(JSON.stringify({ kimi, grok }));
  for (let turn = 0; turn < 2; turn++) {
    expect(kimiDeviceHeaders(stored.kimi)).toContainEqual(["X-Msh-Device-Id", kimi.deviceId]);
    expect(grokDeviceHeaders(stored.grok)).toEqual([["x-grok-agent-id", grok.agentId]]);
  }
});

test("provider root browser bundle executes OAuth secret generation with Bun absent", async () => {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/index.ts")],
    target: "browser",
    format: "cjs",
    // Existing server profiles read environment at import time. Specialize only
    // that pre-existing boundary, never Bun.CryptoHasher or the Bun global.
    define: { "Bun.env": "({})" },
  });
  expect(built.success).toBe(true);
  const module = { exports: {} as typeof import("../src/index.ts") };
  const context = {
    module,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    // The root also contains transport/platform profiles; no real process or
    // Bun is exposed to the isolated browser-style execution context.
    process: { platform: "linux", arch: "x64", version: "v24.0.0", versions: {}, env: {} },
  };
  const output = built.outputs[0];
  if (output === undefined) throw new Error("browser bundle has no output");
  runInNewContext(await output.text(), context);
  expect(runInNewContext("typeof Bun", context)).toBe("undefined");
  const refresh = async (providerData: Record<string, unknown>) => {
    const flow = module.exports.openaiOAuthFlow.refresh({
      refreshToken: "refresh",
      providerData,
      now: () => 0,
      fail: (code, message) => new GatewayError(code, message),
      keepPolling: () => {
        throw new Error("unexpected polling during refresh");
      },
      pkce: () => {
        throw new Error("unexpected PKCE during refresh");
      },
      randomState: () => {
        throw new Error("unexpected state during refresh");
      },
    });
    expect((await flow.next()).done).toBe(false);
    const result = await flow.next({
      status: 200,
      headers: new Headers(),
      body: '{"access_token":"tok"}',
    });
    if (!result.done) throw new Error("refresh did not complete");
    return result.value.providerData;
  };
  const secrets = await refresh({});
  expect(secrets?.installationId).toMatch(UUID_V4);
  expect(secrets?.idSalt).toMatch(/^[0-9a-f]{64}$/);
  expect(await refresh(secrets ?? {})).toEqual(secrets);
  expect((await refresh({}))?.idSalt).not.toBe(secrets?.idSalt);
});
