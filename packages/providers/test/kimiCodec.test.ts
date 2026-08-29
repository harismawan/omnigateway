/**
 * The wire kimi puts on the socket, pinned against literals.
 *
 * **These bytes were captured from the hand-written adapter before it was
 * replaced**, which is what makes them evidence rather than a restatement of the
 * codec. Kilo's conversion taught the lesson this file is built on: the
 * byte-for-byte parity test that made *that* conversion safe died with the
 * adapter it compared against and went on passing as a comparison of one
 * implementation with itself. So the parity here was run once, against two real
 * implementations, and what survives is the half that outlives the second one.
 *
 * What is pinned is order as much as content. `kimiProfile.order` exists because
 * the upstream expects a particular client, so a test comparing header *sets*
 * would pass while the wire changed — and the device headers are the specific
 * thing that could drift silently, because they are read off the credential and
 * a codec that dropped them would still build a request that authenticates.
 *
 * `X-Msh-Version` and `User-Agent` carry a version an installation may override
 * (`profileEnvOverride.test.ts`), so their *positions* are pinned and their
 * values are not: pinning a version string would make a profile bump fail a test
 * about transport.
 */

import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError } from "@omni/ir";
import { decodeChat } from "../src/kimi/decode.ts";
import { kimiAdapter } from "../src/kimi/index.ts";
import { parseSse } from "../src/sse.ts";
import type { AdapterCredentials, HttpRequest, HttpResponse } from "../src/types.ts";

const URL = "https://api.kimi.com/coding/v1/chat/completions";

const BODY =
  '{"model":"kimi-k2","messages":[{"role":"user","content":"hi"}],' +
  '"stream":true,"stream_options":{"include_usage":true}}';

/** The device identity as `mintKimiDevice` freezes it onto a credential. */
const DEVICE = {
  deviceId: "dev-1",
  deviceName: "MacBook-Pro",
  deviceModel: "MacBookPro18,3",
  osVersion: "15.3.1",
};

const SSE = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
  "data: [DONE]\n\n",
].join("");

function sseBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(SSE));
      controller.close();
    },
  });
}

function capturing(): { sent: HttpRequest[]; http: (r: HttpRequest) => Promise<HttpResponse> } {
  const sent: HttpRequest[] = [];
  return {
    sent,
    http: async (r) => {
      sent.push(r);
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: sseBody(),
        text: async () => "",
      };
    },
  };
}

const request: ChatRequest = {
  model: "cheap",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const credentials = (over: Partial<AdapterCredentials> = {}): AdapterCredentials => ({
  accessToken: "kimi-oauth-token",
  apiKey: null,
  providerData: {},
  ...over,
});

async function sentFor(shape: ChatRequest, creds: AdapterCredentials): Promise<HttpRequest> {
  const capture = capturing();
  await kimiAdapter.send({
    request: shape,
    model: "kimi-k2",
    credentials: creds,
    http: capture.http,
    signal: new AbortController().signal,
  });
  expect(capture.sent).toHaveLength(1);
  return capture.sent[0] as HttpRequest;
}

/** Header values, with the two an installation may override left out. */
function pinned(sent: HttpRequest): readonly (readonly [string, string])[] {
  return sent.headers.filter(([name]) => name !== "X-Msh-Version" && name !== "User-Agent");
}

test("a credential with no device identity sends the protocol headers alone", async () => {
  const sent = await sentFor(request, credentials());

  expect(sent.provider).toBe("kimi");
  expect(sent.method).toBe("POST");
  expect(sent.url).toBe(URL);
  expect(sent.body).toBe(BODY);
  expect(sent.headers.map(([name]) => name)).toEqual([
    "Content-Type",
    "Authorization",
    "X-Msh-Platform",
    "X-Msh-Version",
    "User-Agent",
    "Accept",
  ]);
  expect(pinned(sent)).toEqual([
    ["Content-Type", "application/json"],
    ["Authorization", "Bearer kimi-oauth-token"],
    ["X-Msh-Platform", "kimi_code_cli"],
    ["Accept", "text/event-stream"],
  ]);
});

test("a device identity is sent whole, and in its own place in the order", async () => {
  const sent = await sentFor(request, credentials({ providerData: DEVICE }));

  // Position, not presence. The device headers are merged with the protocol
  // headers and then ordered by the profile, so asserting only that they are
  // somewhere in the list would pass with them appended to the end.
  expect(sent.headers.map(([name]) => name)).toEqual([
    "Content-Type",
    "Authorization",
    "X-Msh-Platform",
    "X-Msh-Version",
    "X-Msh-Device-Id",
    "X-Msh-Device-Name",
    "X-Msh-Device-Model",
    "X-Msh-Os-Version",
    "User-Agent",
    "Accept",
  ]);
  expect(pinned(sent)).toEqual([
    ["Content-Type", "application/json"],
    ["Authorization", "Bearer kimi-oauth-token"],
    ["X-Msh-Platform", "kimi_code_cli"],
    ["X-Msh-Device-Id", "dev-1"],
    ["X-Msh-Device-Name", "MacBook-Pro"],
    ["X-Msh-Device-Model", "MacBookPro18,3"],
    ["X-Msh-Os-Version", "15.3.1"],
    ["Accept", "text/event-stream"],
  ]);
});

test("a credential minted before the device fields exist still identifies itself", async () => {
  // Real stored state: credentials created before the three descriptive fields
  // existed carry only `deviceId`. Upstream needs the identity to be stable
  // rather than true, so the rest are sent as `unknown` — dropping the header
  // set entirely would change the device this credential has always claimed to
  // be, which is what forces re-authentication.
  const sent = await sentFor(request, credentials({ providerData: { deviceId: "dev-2" } }));

  expect(sent.headers).toContainEqual(["X-Msh-Device-Id", "dev-2"]);
  expect(sent.headers).toContainEqual(["X-Msh-Device-Name", "unknown"]);
  expect(sent.headers).toContainEqual(["X-Msh-Device-Model", "unknown"]);
  expect(sent.headers).toContainEqual(["X-Msh-Os-Version", "unknown"]);
});

test("an API key is sent as the same bearer, to the same host", async () => {
  // Kimi serves both credential types from one URL, unlike kilo. Asserted so
  // that a future split is a deliberate change rather than a silent one.
  const sent = await sentFor(
    request,
    credentials({ accessToken: null, apiKey: "kimi-api-key", providerData: DEVICE }),
  );

  expect(sent.url).toBe(URL);
  expect(sent.headers).toContainEqual(["Authorization", "Bearer kimi-api-key"]);
});

test("a non-streaming client request still asks the upstream to stream", async () => {
  // The failure this guards is silent and total: a non-streaming upstream
  // returns JSON, `parseSse` yields nothing, and the client gets an empty
  // response. Dispatch serves a non-streaming client by collecting the stream,
  // so the request going out is identical either way.
  const sent = await sentFor({ ...request, stream: false }, credentials({ providerData: DEVICE }));

  expect(sent.body).toBe(BODY);
});

test("a credential carrying no token is an AUTH failure, not a bare request", async () => {
  // `codecAdapter` passes a `GatewayError`'s own classification through, and
  // this is the case that depends on it: dispatch gates its credential-refresh
  // retry on `AUTH`, so a codec failure flattened to `UPSTREAM` would fail over
  // instead of refreshing, and on a single-candidate pool would fail outright.
  const capture = capturing();
  const attempt = kimiAdapter.send({
    request,
    model: "kimi-k2",
    credentials: credentials({ accessToken: null }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((error: unknown) => {
    expect((error as GatewayError).code).toBe("AUTH");
    expect((error as GatewayError).provider).toBe("kimi");
  });
  // Nothing was sent. A codec that built a request and let the host discover the
  // missing token would put an unauthenticated call on the wire first.
  expect(capture.sent).toEqual([]);
});

test("the decoded stream is the decoder's own, reached through the bridge", async () => {
  // Goes through `codecAdapter`'s stream guard and the codec's `decode` wiring,
  // and compares against the decoder called directly — so a bridge that dropped,
  // reordered or re-wrapped an event fails here.
  const capture = capturing();
  const result = await kimiAdapter.send({
    request,
    model: "kimi-k2",
    credentials: credentials({ providerData: DEVICE }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  const viaBridge = [];
  for await (const event of result.events) viaBridge.push(event);
  const direct = [];
  for await (const event of decodeChat(parseSse(sseBody()))) direct.push(event);

  expect(viaBridge).toEqual(direct);
  expect(result.degradations).toEqual([]);
});
