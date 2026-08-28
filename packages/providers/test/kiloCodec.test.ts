import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError, type StreamEvent } from "@omni/ir";
import { codecAdapter } from "../src/codecAdapter.ts";
import { kiloCodec } from "../src/kilo/codec.ts";
import { kiloDescriptor } from "../src/kilo/descriptor.ts";
import { kiloAdapter } from "../src/kilo/index.ts";
import type { AdapterCredentials, HttpRequest, HttpResponse } from "../src/types.ts";

/**
 * The codec contract, judged against a provider that already exists.
 *
 * The question this file answers is not whether `kiloCodec` works but whether
 * the *contract* can express a real adapter without loss — which is the whole
 * bet of the sub-project, and the kind of thing that is easy to believe from a
 * type signature and wrong in the details. So it asserts that the two paths put
 * **identical bytes** on the wire, rather than that each produces something
 * plausible.
 *
 * The comparison is byte-for-byte on purpose. Header order is load-bearing for
 * this provider — `kiloProfile.order` exists because the upstream fingerprints
 * clients — so a test comparing header *sets* would pass while the wire changed.
 */

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

/** Captures the request and replays a fixed stream. */
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
  model: "pool",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const credentials = (over: Partial<AdapterCredentials> = {}): AdapterCredentials => ({
  accessToken: "kilo-oauth-token",
  apiKey: null,
  providerData: {},
  ...over,
});

async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const bridged = codecAdapter("kilo", kiloDescriptor.capabilities, kiloCodec);

/** Everything but the signal, which is an object identity and not wire bytes. */
function wire(r: HttpRequest) {
  return { provider: r.provider, url: r.url, method: r.method, headers: r.headers, body: r.body };
}

test("the codec and the adapter put identical bytes on the wire", async () => {
  for (const creds of [
    // Both credential shapes, because kilo picks its URL from them and crossing
    // the two fails as a billing error rather than a routing one.
    credentials(),
    credentials({ accessToken: null, apiKey: "kilo-api-key" }),
    // An organization header is added only when the credential carries one.
    credentials({ providerData: { orgId: "org-42" } }),
  ]) {
    const direct = capturing();
    const viaCodec = capturing();

    await kiloAdapter.send({
      request,
      model: "anthropic/claude-sonnet-5",
      credentials: creds,
      http: direct.http,
      signal: new AbortController().signal,
    });
    await bridged.send({
      request,
      model: "anthropic/claude-sonnet-5",
      credentials: creds,
      http: viaCodec.http,
      signal: new AbortController().signal,
    });

    expect(viaCodec.sent).toHaveLength(1);
    expect(wire(viaCodec.sent[0] as HttpRequest)).toEqual(wire(direct.sent[0] as HttpRequest));
  }
});

test("the codec and the adapter decode the same events", async () => {
  const direct = capturing();
  const viaCodec = capturing();

  const a = await kiloAdapter.send({
    request,
    model: "anthropic/claude-sonnet-5",
    credentials: credentials(),
    http: direct.http,
    signal: new AbortController().signal,
  });
  const b = await bridged.send({
    request,
    model: "anthropic/claude-sonnet-5",
    credentials: credentials(),
    http: viaCodec.http,
    signal: new AbortController().signal,
  });

  expect(await drain(b.events)).toEqual(await drain(a.events));
  expect(b.degradations).toEqual(a.degradations);
});

test("the bridge reports the provider it was registered as, not one the codec names", async () => {
  // `provider` is stamped by the host. It reaches `LogFields.provider` and the
  // error a client sees, so a codec must not be able to claim another
  // provider's name by putting it in the request it describes.
  const { sent, http } = capturing();
  await bridged.send({
    request,
    model: "anthropic/claude-sonnet-5",
    credentials: credentials(),
    http,
    signal: new AbortController().signal,
  });
  expect(sent[0]?.provider).toBe("kilo");
});

test("a failing upstream throws before any event, as the adapter does", async () => {
  const failing = async (): Promise<HttpResponse> => ({
    status: 429,
    headers: new Headers(),
    body: null,
    text: async () => '{"error":{"message":"slow down"}}',
  });

  const attempt = bridged.send({
    request,
    model: "anthropic/claude-sonnet-5",
    credentials: credentials(),
    http: failing,
    signal: new AbortController().signal,
  });

  await expect(attempt).rejects.toMatchObject({ code: "RATE_LIMIT", provider: "kilo" });
});

test("an empty body is refused rather than decoded into nothing", async () => {
  const empty = async (): Promise<HttpResponse> => ({
    status: 200,
    headers: new Headers(),
    body: null,
    text: async () => "",
  });

  await expect(
    bridged.send({
      request,
      model: "anthropic/claude-sonnet-5",
      credentials: credentials(),
      http: empty,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "UPSTREAM", provider: "kilo" });
});

test("a codec's classifyError replaces the default, and only when it answers", async () => {
  // Anthropic's fingerprint refusal is the real case: a 400 whose body says
  // something no status code expresses. The hook has to be able to override,
  // and to decline — returning `undefined` must leave the default in place, or
  // a codec special-casing one status would swallow every other.
  const seen: { status: number; body: string }[] = [];
  const withHook = codecAdapter("kilo", kiloDescriptor.capabilities, {
    ...kiloCodec,
    classifyError({ status, body }) {
      seen.push({ status, body });
      return status === 400
        ? new GatewayError("FINGERPRINT_REFUSED", "refused by fingerprint", { provider: "kilo" })
        : undefined;
    },
  });

  const responding = (status: number, body: string) => async (): Promise<HttpResponse> => ({
    status,
    headers: new Headers(),
    body: null,
    text: async () => body,
  });

  // Overridden: the hook's error, not the `BAD_REQUEST` a 400 maps to.
  await expect(
    withHook.send({
      request,
      model: "anthropic/claude-sonnet-5",
      credentials: credentials(),
      http: responding(400, "fingerprint refused"),
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "FINGERPRINT_REFUSED" });
  // The hook sees the body the host already read, not a stream it could re-read.
  expect(seen).toEqual([{ status: 400, body: "fingerprint refused" }]);

  // Declined: 500 keeps the host's own classification.
  await expect(
    withHook.send({
      request,
      model: "anthropic/claude-sonnet-5",
      credentials: credentials(),
      http: responding(500, "upstream down"),
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "UPSTREAM" });
});
