/**
 * The wire a custom endpoint gets, pinned against literals.
 *
 * Captured from the hand-written adapter before it was replaced.
 *
 * This provider is the **second** user of `decodeState`, after Anthropic's tool
 * cloak, and a different shape of the same need: the wire format is a property
 * of the *credential*, so `decode` cannot work it out from the response. The
 * adapter closed over the value; a codec has no closure spanning its two halves.
 * The protocol round trip is therefore the load-bearing test here, not the URL.
 */

import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError } from "@omni/ir";
import { customAdapter } from "../src/custom/index.ts";
import type { AdapterCredentials, HttpRequest, HttpResponse } from "../src/types.ts";

const request: ChatRequest = {
  model: "pool",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

function capturing(): { sent: HttpRequest[]; http: (r: HttpRequest) => Promise<HttpResponse> } {
  const sent: HttpRequest[] = [];
  return {
    sent,
    http: async (r) => {
      sent.push(r);
      const text = "data: [DONE]\n\n";
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new Response(text).body as ReadableStream<Uint8Array>,
        text: async () => text,
      };
    },
  };
}

const creds = (over: Partial<AdapterCredentials> = {}): AdapterCredentials => ({
  accessToken: null,
  apiKey: null,
  providerData: {},
  ...over,
});

const endpoint = (over: Record<string, unknown> = {}) =>
  creds({
    apiKey: "ck",
    providerData: { origin: "https://host.test", protocol: "chat_completions", ...over },
  });

async function sentFor(
  credentials: AdapterCredentials,
  shape: ChatRequest = request,
): Promise<HttpRequest> {
  const capture = capturing();
  await customAdapter.send({
    request: shape,
    model: "m1",
    credentials,
    http: capture.http,
    signal: new AbortController().signal,
  });
  expect(capture.sent).toHaveLength(1);
  return capture.sent[0] as HttpRequest;
}

test("a chat_completions endpoint is addressed and encoded as one", async () => {
  const sent = await sentFor(endpoint());

  expect(sent.provider).toBe("custom");
  expect(sent.url).toBe("https://host.test/v1/chat/completions");
  expect(sent.headers).toEqual([
    ["Content-Type", "application/json"],
    ["Authorization", "Bearer ck"],
  ]);
  expect(sent.body).toBe(
    '{"model":"m1","messages":[{"role":"user","content":"hi"}],"stream":true,' +
      '"stream_options":{"include_usage":true}}',
  );
});

test("a responses endpoint gets the other encoder and the other suffix", async () => {
  const sent = await sentFor(endpoint({ protocol: "responses" }));

  expect(sent.url).toBe("https://host.test/v1/responses");
  expect(sent.body).toBe(
    '{"model":"m1","input":[{"type":"message","role":"user",' +
      '"content":[{"type":"input_text","text":"hi"}]}],"stream":true,"store":false}',
  );
});

test("a base path ending in /v1 is not doubled", async () => {
  // Operators habitually enter OpenAI-SDK-style bases that already end in
  // `/v1`, and a blind append produces `/v1/v1/responses` — a 404 that reads
  // like a broken endpoint rather than a broken join.
  const sent = await sentFor(endpoint({ basePath: "/api/v1", protocol: "responses" }));

  expect(sent.url).toBe("https://host.test/api/v1/responses");
});

test("a base path ending in another version segment is not given /v1", async () => {
  const sent = await sentFor(endpoint({ basePath: "/api/coding/paas/v4" }));

  expect(sent.url).toBe("https://host.test/api/coding/paas/v4/chat/completions");
});

test("a base path not ending in a version segment gets /v1", async () => {
  const sent = await sentFor(endpoint({ basePath: "/api" }));

  expect(sent.url).toBe("https://host.test/api/v1/chat/completions");
});

test("the protocol reaches decode through decodeState, not through a closure", async () => {
  // The assertion this file exists for. A codec whose `decode` ignored
  // `decodeState` would fall back to the chat decoder, which reads a completely
  // different event shape — so a responses stream would decode to nothing at all
  // rather than failing.
  // The Responses dialect names its events in the SSE `event:` field, which the
  // chat decoder never reads — so a codec ignoring `decodeState` yields nothing
  // here rather than yielding something wrong. Silence is the failure mode this
  // asserts against.
  const responses = [
    'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"message"}}\n\n',
    'event: response.content_part.added\ndata: {"output_index":0,"part":{"type":"output_text"}}\n\n',
    'event: response.output_text.delta\ndata: {"output_index":0,"delta":"hello"}\n\n',
    'event: response.content_part.done\ndata: {"output_index":0}\n\n',
    'event: response.completed\ndata: {"response":{"id":"r","usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
  ].join("");

  const sent: HttpRequest[] = [];
  const result = await customAdapter.send({
    request,
    model: "m1",
    credentials: endpoint({ protocol: "responses" }),
    http: async (r) => {
      sent.push(r);
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new Response(responses).body as ReadableStream<Uint8Array>,
        text: async () => responses,
      };
    },
    signal: new AbortController().signal,
  });

  const texts: string[] = [];
  for await (const event of result.events) {
    if (event.type === "blockDelta" && event.delta.type === "text") texts.push(event.delta.text);
  }
  expect(texts.join("")).toBe("hello");
});

test("a non-streaming client request still asks the upstream to stream", async () => {
  // The failure this guards is silent and total: a non-streaming upstream
  // answers JSON, `parseSse` yields nothing, and the client gets an empty
  // response. Dispatch serves a non-streaming client by collecting the stream,
  // so the request going out is identical either way.
  //
  // It needs its own case because the wire encoder copies the client's own
  // `stream` flag, so with a streaming request the codec's override is a no-op
  // and deleting it survives every other assertion here — measured, on this
  // file, before this test existed.
  const sent = await sentFor(endpoint({ protocol: "responses" }), { ...request, stream: false });

  expect(sent.body).toContain('"stream":true');
});

test("a credential with no API key is an AUTH failure, and sends nothing", async () => {
  const capture = capturing();
  const attempt = customAdapter.send({
    request,
    model: "m1",
    credentials: creds({ providerData: { origin: "https://host.test", protocol: "responses" } }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((e: unknown) => expect((e as GatewayError).code).toBe("AUTH"));
  expect(capture.sent).toEqual([]);
});

test("endpoint metadata that is not an endpoint is refused before the transport", async () => {
  // `BAD_REQUEST` and not `UPSTREAM`: nothing upstream was asked. The codec's
  // own classification survives `codecAdapter`, which only restamps the provider.
  const capture = capturing();
  const attempt = customAdapter.send({
    request,
    model: "m1",
    credentials: creds({ apiKey: "ck", providerData: { origin: 42, protocol: "responses" } }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((e: unknown) => expect((e as GatewayError).code).toBe("BAD_REQUEST"));
  expect(capture.sent).toEqual([]);
});
