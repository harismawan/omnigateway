/**
 * The wire Anthropic puts on the socket, and the three optional hooks only this
 * provider uses.
 *
 * **The literals here were captured from the hand-written adapter before it was
 * replaced**, which is what makes them evidence rather than a restatement of the
 * codec — the method kimi's conversion established after kilo's parity test died
 * with the adapter it compared against and went on passing.
 *
 * This provider is the reason `decodeState`, `cloakedTools` and `classifyError`
 * exist. Kilo and kimi use none of them, so until this conversion those three
 * were designed rather than exercised. Converting before the contract is
 * published was the whole point, and it found one gap: `CodecErrorInput` had no
 * `fallback`, so a codec could not reclassify the host's own parsed message
 * without re-deriving it from the raw body. The last two tests here are what
 * that field bought.
 *
 * `cch=` is a token computed over the finished bytes, so a body literal below
 * pins the serialization *and* the signing together: change a field's order and
 * the token changes with it.
 */

import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError, type StreamEvent } from "@omni/ir";
import { anthropicAdapter } from "../src/anthropic/index.ts";
import { ccVersionSuffix } from "../src/body.ts";
import type { AdapterCredentials, HttpRequest, HttpResponse } from "../src/types.ts";

const URL = "https://api.anthropic.com/v1/messages";

const base: ChatRequest = {
  model: "pool",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const oauth = (): AdapterCredentials => ({
  accessToken: "anth-oauth",
  apiKey: null,
  providerData: {},
});
const apiKey = (): AdapterCredentials => ({
  accessToken: null,
  apiKey: "sk-ant-key",
  providerData: {},
});

const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function sse(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function capturing(
  reply: { status?: number; body?: string; headers?: Record<string, string> } = {},
): { sent: HttpRequest[]; http: (r: HttpRequest) => Promise<HttpResponse> } {
  const sent: HttpRequest[] = [];
  const status = reply.status ?? 200;
  const text = reply.body ?? STOP;
  return {
    sent,
    http: async (r) => {
      sent.push(r);
      return {
        status,
        headers: new Headers(reply.headers ?? { "content-type": "text/event-stream" }),
        body: sse(text),
        text: async () => text,
      };
    },
  };
}

async function send(
  request: ChatRequest,
  credentials: AdapterCredentials,
  reply?: { status?: number; body?: string; headers?: Record<string, string> },
) {
  const capture = capturing(reply);
  const result = await anthropicAdapter.send({
    request,
    model: "claude-opus-4",
    credentials,
    http: capture.http,
    signal: new AbortController().signal,
  });
  return { result, sent: capture.sent[0] as HttpRequest };
}

/** Header names in wire order, which is what the profile exists to fix. */
const HEADER_NAMES = [
  "Accept",
  "Content-Type",
  "User-Agent",
  "X-Stainless-Arch",
  "X-Stainless-Lang",
  "X-Stainless-OS",
  "X-Stainless-Package-Version",
  "X-Stainless-Retry-Count",
  "X-Stainless-Runtime",
  "X-Stainless-Runtime-Version",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "x-api-key",
  "x-app",
] as const;

test("an API key request is signed over exactly these bytes", async () => {
  const { sent, result } = await send(base, apiKey());

  expect(sent.provider).toBe("anthropic");
  expect(sent.url).toBe(URL);
  expect(sent.method).toBe("POST");
  expect(sent.headers.map(([name]) => name)).toEqual([...HEADER_NAMES]);
  expect(sent.headers).toContainEqual(["x-api-key", "sk-ant-key"]);
  expect(sent.headers).toContainEqual(["anthropic-version", "2023-06-01"]);
  expect(sent.headers).toContainEqual(["Accept", "text/event-stream"]);
  // No `anthropic-beta` at all: an empty header is not the same as an absent
  // one, and Anthropic rejects a vendor field whose beta the header omits.
  expect(sent.headers.some(([name]) => name === "anthropic-beta")).toBe(false);

  expect(sent.body).toBe(
    '{"model":"claude-opus-4","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],' +
      '"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.258.1e2; ' +
      'cc_entrypoint=cli; cch=abd52;"},{"type":"text","text":"You are a Claude agent, built on ' +
      'Anthropic\'s Claude Agent SDK."}],"max_tokens":4096,"stream":true}',
  );
  expect(result.degradations).toEqual([]);
  // Absent, not zero. The count is only meaningful when a cloak ran.
  expect(result.cloakedTools).toBeUndefined();
});

test("an OAuth request adds the beta, the preamble, and its own signature", async () => {
  const { sent, result } = await send(base, oauth());

  // `Authorization` in place of `x-api-key`, and the profile decides where.
  expect(sent.headers.map(([name]) => name)).toEqual([
    "Accept",
    "Authorization",
    "Content-Type",
    "User-Agent",
    "X-Stainless-Arch",
    "X-Stainless-Lang",
    "X-Stainless-OS",
    "X-Stainless-Package-Version",
    "X-Stainless-Retry-Count",
    "X-Stainless-Runtime",
    "X-Stainless-Runtime-Version",
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "anthropic-version",
    "x-app",
  ]);
  expect(sent.headers).toContainEqual(["Authorization", "Bearer anth-oauth"]);
  expect(sent.headers).toContainEqual(["anthropic-beta", "oauth-2025-04-20"]);

  // The OAuth leg carries a second system block the API-key leg does not, and a
  // different `cch` because the token is computed over the finished bytes.
  expect(sent.body).toContain("cch=b3d1d;");
  expect(sent.body).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
  expect(result.degradations).toEqual(["anthropic:oauth-system-prefix"]);
});

test("cc_version is hashed from the first user message's first text block", async () => {
  // `base` sends "hi", which pads every picked index to "0" and so equals the
  // empty-string suffix — a codec passing "" would sign identically. Both texts
  // here are long enough to reach index 20, and the first message is not the
  // user's, so `messages[0]` and `find(role === "user")` disagree too.
  const assistantText = "Earlier assistant turn, long enough to reach index twenty.";
  const userText = "Fix the auth middleware, please. Thanks";
  const { sent } = await send(
    {
      ...base,
      messages: [
        { role: "assistant", content: [{ type: "text", text: assistantText }] },
        { role: "user", content: [{ type: "text", text: userText }] },
      ],
    },
    apiKey(),
  );
  const expected = ccVersionSuffix(userText);
  expect(expected).not.toBe(ccVersionSuffix(""));
  expect(expected).not.toBe(ccVersionSuffix(assistantText));
  expect(sent.body).toContain(`cc_version=2.1.258.${expected}; `);
});

test("the client's own betas ride along, and the OAuth beta is added not substituted", async () => {
  const betas = ["context-1m-2025-08-07", "fine-grained-tool-streaming-2025-05-14"];
  const { sent } = await send({ ...base, betas }, apiKey());

  // Joined in order, one header. `claude-opus-4` is a 1M-capable target, so the
  // context beta survives — the drop only fires where the catalog positively
  // reports a smaller window.
  expect(sent.headers).toContainEqual([
    "anthropic-beta",
    "context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14",
  ]);
});

test("the OAuth leg cloaks tool names, and reports how many", async () => {
  const withTools: ChatRequest = {
    ...base,
    tools: [
      {
        kind: "portable",
        name: "session_search",
        description: "d",
        inputSchema: { type: "object" },
      },
    ],
  };
  const { sent, result } = await send(withTools, oauth());

  // The rename reaches the wire. RTK normalises by case and separator, so an
  // egress-side restore would silently degrade every shell classification —
  // which is why the alias exists only between here and `decode`.
  expect(sent.body).toContain('"name":"SessionSearch"');
  expect(sent.body).not.toContain("session_search");
  expect(result.degradations).toContain("anthropic:tool-names-cloaked");
  // A count and never the names: this value reaches `LogFields`, the redaction
  // boundary, and a tool name is client free text.
  expect(result.cloakedTools).toBe(1);
});

test("the API-key leg renames nothing, because that surface does not fingerprint", async () => {
  const withTools: ChatRequest = {
    ...base,
    tools: [
      {
        kind: "portable",
        name: "session_search",
        description: "d",
        inputSchema: { type: "object" },
      },
    ],
  };
  const { sent, result } = await send(withTools, apiKey());

  expect(sent.body).toContain('"name":"session_search"');
  expect(result.cloakedTools).toBeUndefined();
});

test("decodeState carries the cloak to decode, which restores the real names", async () => {
  // The hook this provider is the reason for. `decodeState` is `unknown` to the
  // host and never inspected by it, so this asserts the round trip rather than
  // the field: a tool call comes back under the *client's* name, which only the
  // alias map built during `buildRequest` can produce.
  const withTools: ChatRequest = {
    ...base,
    tools: [
      {
        kind: "portable",
        name: "session_search",
        description: "d",
        inputSchema: { type: "object" },
      },
    ],
  };
  const stream =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-opus-4","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"SessionSearch"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const { result } = await send(withTools, oauth(), { body: stream });

  const events: StreamEvent[] = [];
  for await (const event of result.events) events.push(event);
  const started = events.find((e) => e.type === "blockStart");
  expect(started).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "t1", name: "session_search" },
  });
});

test("a 400 carrying the fingerprint phrase is reclassified, and keeps its degradations", async () => {
  // The third hook, and the one that needed `fallback`. What is matched is the
  // *parsed* message — `httpError` has already pulled `error.message` out of the
  // document and truncated it — so a codec working from the raw body would be
  // re-deriving a value the host had computed one line earlier.
  const body = JSON.stringify({
    error: { type: "invalid_request_error", message: "You are out of extra usage" },
  });

  const attempt = send(base, oauth(), { status: 400, body });
  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((error: unknown) => {
    const failure = error as GatewayError;
    expect(failure.code).toBe("FINGERPRINT_REFUSED");
    expect(failure.provider).toBe("anthropic");
    expect(failure.message).toBe("You are out of extra usage");
    // The record exists to answer "was the cloak running when this was refused",
    // and there is no result on the throw path to carry the answer.
    expect(failure.degradations).toEqual(["anthropic:oauth-system-prefix"]);
  });
});

test("the same phrase at another status keeps the host's own classification", async () => {
  // `httpError` maps 413 and 422 to `BAD_REQUEST` as well, and can downgrade any
  // status to it on a context-length body — so reading `fallback.code` instead
  // of the status would relabel refusals this provider never measured. A 429 is
  // the one that matters: it is retryable, and turning it into a
  // non-retryable refusal ends a request a sibling credential would have served.
  const body = JSON.stringify({
    error: { type: "rate_limit_error", message: "You are out of extra usage" },
  });

  const attempt = send(base, apiKey(), { status: 429, body });
  await attempt.catch((error: unknown) => {
    expect((error as GatewayError).code).toBe("RATE_LIMIT");
  });
  await expect(attempt).rejects.toThrow(GatewayError);
});

test("the phrase outside the message is not a refusal, which is why fallback exists", async () => {
  // **The assertion that justifies `fallback` being on the contract at all**, and
  // it was missing from the first version of this file — mutation testing found
  // it: replacing `input.fallback.message` with `input.body` survived every
  // other test here, because every other fixture puts the phrase in the message,
  // where the raw document contains it too.
  //
  // Here they disagree. The upstream refused for an unrelated reason and the
  // phrase appears elsewhere in the document — an echoed field, a debug key, a
  // quoted request. Matching the raw body relabels an ordinary `BAD_REQUEST` as
  // a non-retryable `FINGERPRINT_REFUSED`, which ends a request the rest of the
  // pool would have served, and blames tool names for it.
  const body = JSON.stringify({
    error: { type: "invalid_request_error", message: "model: extra inputs are not permitted" },
    request_echo: { note: "the account is out of extra usage" },
  });

  const attempt = send(base, apiKey(), { status: 400, body });
  await attempt.catch((error: unknown) => {
    expect((error as GatewayError).code).toBe("BAD_REQUEST");
    expect((error as GatewayError).message).toBe("model: extra inputs are not permitted");
  });
  await expect(attempt).rejects.toThrow(GatewayError);
});

test("an ordinary 400 is left exactly as the host classified it", async () => {
  const body = JSON.stringify({ error: { type: "invalid_request_error", message: "bad model" } });

  const attempt = send(base, apiKey(), { status: 400, body });
  await attempt.catch((error: unknown) => {
    expect((error as GatewayError).code).toBe("BAD_REQUEST");
    expect((error as GatewayError).message).toBe("bad model");
  });
  await expect(attempt).rejects.toThrow(GatewayError);
});

test("a non-streaming client request still asks the upstream to stream", async () => {
  // The failure this guards is silent and total: a non-streaming upstream
  // answers JSON, `parseSse` yields nothing, and the client gets an empty
  // response. Dispatch serves a non-streaming client by collecting the stream,
  // so the request going out is identical either way.
  //
  // **This file was the one of the six that lacked this case**, and the gap was
  // invisible from inside this package: deleting `stream: true` from the codec
  // leaves `bun test packages/providers` entirely green, because `toWire`
  // copies the client's own flag and every other fixture here is a streaming
  // request. The mutant dies only in `apps/gateway`, a package away from the
  // file a contributor edits. A guard that lives somewhere else is one they
  // will not see fail.
  const { sent } = await send({ ...base, stream: false }, apiKey());

  expect(sent.body).toContain('"stream":true');
});

test("a credential with neither token is an AUTH failure, and sends nothing", async () => {
  const capture = capturing();
  const attempt = anthropicAdapter.send({
    request: base,
    model: "claude-opus-4",
    credentials: { accessToken: null, apiKey: null, providerData: {} },
    http: capture.http,
    signal: new AbortController().signal,
  });

  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((error: unknown) => expect((error as GatewayError).code).toBe("AUTH"));
  expect(capture.sent).toEqual([]);
});
