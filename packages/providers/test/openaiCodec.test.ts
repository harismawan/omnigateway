/**
 * The wire OpenAI puts on the socket, pinned against literals.
 *
 * Captured from the hand-written adapter before it was replaced, which is the
 * method kimi's conversion established: parity asserted against an
 * implementation that still exists is evidence, and the same assertion after the
 * conversion compares the codec with itself.
 *
 * The credential type changes two things at once here — the host *and* the
 * account header — and crossing them is the failure this file exists for: an
 * OAuth token sent to the API host is not a clean 401.
 */

import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError } from "@omni/ir";
import { openaiAdapter } from "../src/openai/index.ts";
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
  '{"model":"gpt-5-codex","stream":true,"input":[{"type":"message","role":"user",' +
  '"content":[{"type":"input_text","text":"hi"}]}],"store":false}';

async function sentFor(
  credentials: AdapterCredentials,
  shape: ChatRequest = request,
): Promise<HttpRequest> {
  const capture = capturing();
  await openaiAdapter.send({
    request: shape,
    model: "gpt-5-codex",
    credentials,
    http: capture.http,
    signal: new AbortController().signal,
  });
  expect(capture.sent).toHaveLength(1);
  return capture.sent[0] as HttpRequest;
}

test("an OAuth credential goes to the Codex host, naming its billing account", async () => {
  const sent = await sentFor(
    creds({ accessToken: "oa-tok", providerData: { accountId: "acct-9" } }),
  );

  expect(sent.provider).toBe("openai");
  expect(sent.method).toBe("POST");
  expect(sent.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(sent.body).toBe(BODY);
  expect(sent.headers.map(([name]) => name)).toEqual([
    "Content-Type",
    "Authorization",
    "chatgpt-account-id",
    "originator",
    "Version",
    "Openai-Beta",
    "X-Codex-Beta-Features",
    "Accept",
    "User-Agent",
  ]);
  expect(sent.headers).toContainEqual(["Authorization", "Bearer oa-tok"]);
  expect(sent.headers).toContainEqual(["chatgpt-account-id", "acct-9"]);
  expect(sent.headers).toContainEqual(["originator", "codex_cli_rs"]);
});

test("an OAuth credential with no account id omits the header rather than sending it empty", async () => {
  // An empty `chatgpt-account-id` is not the same as an absent one: the backend
  // reads it to select billing, and a blank value is a request it cannot place.
  const sent = await sentFor(creds({ accessToken: "oa-tok" }));

  expect(sent.headers.some(([name]) => name === "chatgpt-account-id")).toBe(false);
});

test("an API key goes to the public host, with no account header at all", async () => {
  const sent = await sentFor(creds({ apiKey: "sk-oa" }));

  expect(sent.url).toBe("https://api.openai.com/v1/responses");
  expect(sent.body).toBe(BODY);
  expect(sent.headers).toContainEqual(["Authorization", "Bearer sk-oa"]);
  expect(sent.headers.some(([name]) => name === "chatgpt-account-id")).toBe(false);
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
  const sent = await sentFor(creds({ apiKey: "sk-oa" }), { ...request, stream: false });

  expect(sent.body).toBe(BODY);
});

test("a credential with neither token is an AUTH failure, and sends nothing", async () => {
  const capture = capturing();
  const attempt = openaiAdapter.send({
    request,
    model: "gpt-5-codex",
    credentials: creds(),
    http: capture.http,
    signal: new AbortController().signal,
  });

  await expect(attempt).rejects.toThrow(GatewayError);
  await attempt.catch((e: unknown) => expect((e as GatewayError).code).toBe("AUTH"));
  expect(capture.sent).toEqual([]);
});
