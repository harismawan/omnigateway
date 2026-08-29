/**
 * The wire Grok puts on the socket, pinned against literals.
 *
 * Captured from the hand-written adapter before it was replaced.
 *
 * Two things here exist nowhere else in the repository. Grok is the only
 * provider whose request reads `CodecInput.requestId`, so these are the only
 * assertions that the field arrives at all — `codecAdapter` forwards it only
 * when dispatch supplied one. And the host pairing is unusually costly to get
 * wrong: an OAuth bearer sent to the API host does not answer 401, it bills
 * against API credits and answers 402 for a healthy subscription.
 */

import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError } from "@omni/ir";
import { grokAdapter } from "../src/grok/index.ts";
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

const BODY =
  '{"model":"grok-4","stream":true,"input":[{"type":"message","role":"user",' +
  '"content":[{"type":"input_text","text":"hi"}]}],"store":false,' +
  '"prompt_cache_key":"af75e45150ba5505736d80ccdd119119",' +
  '"include":["reasoning.encrypted_content"]}';

async function sentFor(
  credentials: AdapterCredentials,
  requestId?: string,
  shape: ChatRequest = request,
): Promise<HttpRequest> {
  const capture = capturing();
  await grokAdapter.send({
    request: shape,
    model: "grok-4",
    credentials,
    http: capture.http,
    signal: new AbortController().signal,
    ...(requestId === undefined ? {} : { requestId }),
  });
  expect(capture.sent).toHaveLength(1);
  return capture.sent[0] as HttpRequest;
}

test("an OAuth credential goes to the proxy, with the two proxy-only headers", async () => {
  const sent = await sentFor(
    creds({ accessToken: "gr-tok", providerData: { deviceId: "gdev-1" } }),
    "req_7",
  );

  expect(sent.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
  expect(sent.body).toBe(BODY);
  expect(sent.headers).toContainEqual(["Authorization", "Bearer gr-tok"]);
  // Proxy-only. The API host has no idea what they mean.
  expect(sent.headers).toContainEqual(["X-XAI-Token-Auth", "xai-grok-cli"]);
  expect(sent.headers).toContainEqual(["x-authenticateresponse", "authenticate-response"]);
  expect(sent.headers.map(([name]) => name)).toEqual([
    "Content-Type",
    "Authorization",
    "X-XAI-Token-Auth",
    "x-authenticateresponse",
    "x-grok-client-identifier",
    "x-grok-client-version",
    "x-grok-client-mode",
    "x-grok-req-id",
    "x-grok-conv-id",
    "x-grok-session-id",
    "x-grok-model-override",
    "User-Agent",
    "Accept",
  ]);
});

test("an API key goes to the API host, and carries neither proxy header", async () => {
  const sent = await sentFor(creds({ apiKey: "xai-key" }));

  expect(sent.url).toBe("https://api.x.ai/v1/responses");
  expect(sent.headers).toContainEqual(["Authorization", "Bearer xai-key"]);
  expect(sent.headers.some(([name]) => name === "X-XAI-Token-Auth")).toBe(false);
  expect(sent.headers.some(([name]) => name === "x-authenticateresponse")).toBe(false);
});

test("the gateway's own request id is reused, and the conversation derived from it", async () => {
  const sent = await sentFor(creds({ accessToken: "gr-tok" }), "req_7");

  // One value joins stdout, `request_logs` and the upstream rather than three.
  expect(sent.headers).toContainEqual(["x-grok-req-id", "req_7"]);
  // Derived, not minted: the contract requires `buildRequest` to describe the
  // same request twice, because the host may build it once per attempt.
  expect(sent.headers).toContainEqual(["x-grok-conv-id", "a9db53bc-87e0-5336-a808-245f0e8d847b"]);
  // Conversation and session are equal, which is what xAI's client sends for a
  // main turn.
  expect(sent.headers).toContainEqual([
    "x-grok-session-id",
    "a9db53bc-87e0-5336-a808-245f0e8d847b",
  ]);
});

test("without a request id the three identifiers are omitted, never invented", async () => {
  // Every path outside dispatch has no request id. Minting one here would make
  // the codec non-deterministic, which is the property retries depend on.
  const sent = await sentFor(creds({ accessToken: "gr-tok" }));

  for (const name of ["x-grok-req-id", "x-grok-conv-id", "x-grok-session-id"]) {
    expect(sent.headers.some(([header]) => header === name)).toBe(false);
  }
  // The model override is not part of that set and is always sent.
  expect(sent.headers).toContainEqual(["x-grok-model-override", "grok-4"]);
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
  const sent = await sentFor(creds({ apiKey: "xai-key" }), undefined, {
    ...request,
    stream: false,
  });

  expect(sent.body).toBe(BODY);
});

test("a credential with neither token is an AUTH failure, and sends nothing", async () => {
  const capture = capturing();
  const attempt = grokAdapter.send({
    request,
    model: "grok-4",
    credentials: creds(),
    http: capture.http,
    signal: new AbortController().signal,
  });

  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((e: unknown) => expect((e as GatewayError).code).toBe("AUTH"));
  expect(capture.sent).toEqual([]);
});
