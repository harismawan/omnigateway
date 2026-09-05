/**
 * The wire Muse puts on the socket, pinned against literals.
 *
 * Unlike the providers converted onto the codec contract, there is no earlier
 * hand-written adapter here whose bytes could be captured — Muse arrived on the
 * contract. So the literals below are written from the dialect rather than
 * quoted from a capture, and the two cache keys are computed **outside** this
 * repository: `sha256` of the stated JSON, truncated to 32 characters. A test
 * that derived them the way the encoder does would agree with any encoder,
 * including one that had started keying on something that moves.
 */

import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError } from "@omni/ir";
import { museAdapter } from "../src/muse/index.ts";
import type { AdapterCredentials, HttpRequest, HttpResponse } from "../src/types.ts";

const request: ChatRequest = {
  model: "pool",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

/** `sha256('{"instructions":"","firstInput":{…}}')`, first 32 hex characters. */
const KEY = "af75e45150ba5505736d80ccdd119119";
/** `sha256('{"conversation":"conv-7"}')`, likewise. */
const CONVERSATION_KEY = "1f539b57dc35d78bb9f3b30497db4581";

const BODY =
  '{"model":"muse-spark-1.3","stream":true,"input":[{"type":"message","role":"user",' +
  `"content":[{"type":"input_text","text":"hi"}]}],"store":false,"prompt_cache_key":"${KEY}"}`;

function capturing(sse = "data: [DONE]\n\n"): {
  sent: HttpRequest[];
  http: (r: HttpRequest) => Promise<HttpResponse>;
} {
  const sent: HttpRequest[] = [];
  return {
    sent,
    http: async (r) => {
      sent.push(r);
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new Response(sse).body as ReadableStream<Uint8Array>,
        text: async () => sse,
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

async function sentFor(
  credentials: AdapterCredentials,
  shape: ChatRequest = request,
): Promise<HttpRequest> {
  const capture = capturing();
  await museAdapter.send({
    request: shape,
    model: "muse-spark-1.3",
    credentials,
    http: capture.http,
    signal: new AbortController().signal,
  });
  expect(capture.sent).toHaveLength(1);
  return capture.sent[0] as HttpRequest;
}

test("a minted key goes to the Model API front door as a bearer", async () => {
  const sent = await sentFor(creds({ apiKey: "meta-key" }));

  expect(sent.provider).toBe("muse");
  expect(sent.method).toBe("POST");
  expect(sent.url).toBe("https://api.meta.ai/v1/responses");
  expect(sent.body).toBe(BODY);
  expect(sent.headers.map(([name]) => name)).toEqual([
    "Content-Type",
    "Authorization",
    "x-meta-ai-gateway-session-id",
    "x-api-version",
    "Accept",
    "User-Agent",
  ]);
  expect(sent.headers).toContainEqual(["Authorization", "Bearer meta-key"]);
  expect(sent.headers).toContainEqual(["x-api-version", "1.0.0"]);
});

test("an OAuth credential sends its minted key, never the device-flow token", async () => {
  // The whole shape of this provider: the OAuth grant buys a key and the key is
  // what the front door accepts. A credential carrying both must not send the
  // token — that request 401s, and the 401 names nothing.
  const sent = await sentFor(creds({ accessToken: "oauth-tok", apiKey: "meta-key" }));

  expect(sent.headers).toContainEqual(["Authorization", "Bearer meta-key"]);
  expect(sent.headers.some(([, value]) => value.includes("oauth-tok"))).toBe(false);
});

test("an OAuth credential whose mint never ran is refused here, not upstream", async () => {
  // Deliberately not falling back to `accessToken`. A credential with a token
  // and no key is one whose mint failed; sending the token would turn a
  // diagnosable local state into an opaque upstream 401.
  const capture = capturing();
  const attempt = museAdapter.send({
    request,
    model: "muse-spark-1.3",
    credentials: creds({ accessToken: "oauth-tok" }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  await expect(attempt).rejects.toThrow(GatewayError);
  await expect(attempt).rejects.toMatchObject({ code: "AUTH" });
  expect(capture.sent).toHaveLength(0);
});

test("the session header and the body's cache key are one value", async () => {
  // Derived at different layers — the encoder returns the key, the codec places
  // the header — so the two can drift apart, and a backend handed two names for
  // one session caches under neither.
  const sent = await sentFor(creds({ apiKey: "meta-key" }));

  expect(sent.headers).toContainEqual(["x-meta-ai-gateway-session-id", KEY]);
  expect(sent.body).toContain(`"prompt_cache_key":"${KEY}"`);
});

test("a client's own conversation id decides the key, hashed rather than forwarded", async () => {
  const sent = await sentFor(creds({ apiKey: "meta-key" }), {
    ...request,
    conversationId: "conv-7",
  });

  expect(sent.headers).toContainEqual(["x-meta-ai-gateway-session-id", CONVERSATION_KEY]);
  expect(sent.body).toContain(`"prompt_cache_key":"${CONVERSATION_KEY}"`);
  // `conversationId` reaches us from Anthropic's `metadata.user_id`, which on
  // Claude Code carries a device id and an account uuid. It must not appear.
  expect(sent.body).not.toContain("conv-7");
});

test("a non-streaming client request still asks upstream for a stream", async () => {
  // Dispatch collects the stream for a non-streaming client. Sending
  // `stream: false` would have the front door answer one JSON body the decoder
  // has no path for.
  const sent = await sentFor(creds({ apiKey: "meta-key" }), { ...request, stream: false });

  expect(sent.body).toContain('"stream":true');
});

test("the vendor bag cannot put back a cache key the encoder rejected", async () => {
  // The merge copies the client's bag verbatim, so assigning the resolved key
  // before it would let an empty string win — and this is the only mechanism
  // there is on this path.
  const sent = await sentFor(creds({ apiKey: "meta-key" }), {
    ...request,
    vendor: { openai: { prompt_cache_key: "" } },
  });

  expect(sent.body).toContain(`"prompt_cache_key":"${KEY}"`);
});

test("passthrough rides the dialect's bag, which is `openai` and not `muse`", async () => {
  // Both Responses-shaped ingresses write `vendor = { openai: extras }`, and
  // nothing constructs a `muse` bag. Reading one dropped every field a client
  // sent — silently, since a bag nobody writes is indistinguishable from a
  // client that sent nothing. Asserted through a field that reaches the wire.
  const sent = await sentFor(creds({ apiKey: "meta-key" }), {
    ...request,
    vendor: { openai: { service_tier: "priority" } },
  });

  expect(sent.body).toContain('"service_tier":"priority"');
});

test("a client's own cache key is taken from the dialect's bag", async () => {
  // The *other* read of the bag. `suppliedKey` looks there before deriving one,
  // and it is a separate line from the merge below — so a fork that fixed only
  // the merge would still ignore a key the client chose, and the header and the
  // body would both carry a hash of ours instead.
  const sent = await sentFor(creds({ apiKey: "meta-key" }), {
    ...request,
    vendor: { openai: { prompt_cache_key: "client-chosen" } },
  });

  expect(sent.body).toContain('"prompt_cache_key":"client-chosen"');
  expect(sent.headers).toContainEqual(["x-meta-ai-gateway-session-id", "client-chosen"]);
});

test("a `muse` bag is ignored, so a stray one cannot smuggle fields onto the wire", async () => {
  const sent = await sentFor(creds({ apiKey: "meta-key" }), {
    ...request,
    vendor: { muse: { service_tier: "priority" } },
  });

  expect(sent.body).not.toContain("service_tier");
});

test("`include` from the client is what turns native reasoning on", async () => {
  // The decode side of the same bag. `include: ["reasoning.encrypted_content"]`
  // is how a client says it will replay reasoning items itself; reading the
  // wrong bag left this permanently false and every muse reasoning item came
  // back as a plain thinking block, unreplayable under `store: false`.
  const capture = capturing(
    [
      "event: response.output_item.added",
      'data: {"output_index":0,"item":{"type":"reasoning"}}',
      "",
      "event: response.reasoning_summary_text.delta",
      'data: {"output_index":0,"delta":"weighing it"}',
      "",
      "event: response.output_item.done",
      'data: {"output_index":0,"item":{"type":"reasoning","encrypted_content":"opaque"}}',
      "",
      "event: response.completed",
      'data: {"response":{"status":"completed"}}',
      "",
    ].join("\n"),
  );
  const result = await museAdapter.send({
    request: {
      ...request,
      vendor: { openai: { include: ["reasoning.encrypted_content"] } },
    },
    model: "muse-spark-1.3",
    credentials: creds({ apiKey: "meta-key" }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  const events = [];
  for await (const event of result.events) events.push(event);

  const start = events.find((e) => e.type === "blockStart");
  expect(start?.type === "blockStart" ? start.block : null).toEqual({
    type: "providerNative",
    provider: "muse",
    blockType: "reasoning",
    data: {},
  });
  // Tagged `muse`, never `openai`: the block's `provider` is what the router
  // reads to decide which targets may receive this history, so a wrong tag pins
  // the conversation to the wrong vendor.
  // **Every** provider-native delta, not the first. The decoder tags three
  // places — the block start, the streaming summary, and the fold that carries
  // `encrypted_content` — and asserting one of them let a wrong tag survive on
  // the other two. The summary path in particular had no fixture at all.
  const tags = events.flatMap((e) =>
    e.type === "blockDelta" && e.delta.type === "providerNative" ? [e.delta.provider] : [],
  );
  expect(tags).toEqual(["muse", "muse"]);
  expect(tags.length).toBe(2);
});

test("a tool call ends the turn as toolUse, not endTurn", async () => {
  // `endTurn` on a turn that asked for a tool is the one wrong answer nobody
  // notices: the client reads a finished reply and stops, never running the
  // tool the model asked for.
  const capture = capturing(
    [
      "event: response.output_item.added",
      'data: {"output_index":0,"item":{"type":"function_call","call_id":"c1","name":"ls"}}',
      "",
      "event: response.completed",
      'data: {"response":{"status":"completed"}}',
      "",
    ].join("\n"),
  );
  const result = await museAdapter.send({
    request,
    model: "muse-spark-1.3",
    credentials: creds({ apiKey: "meta-key" }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  const events = [];
  for await (const event of result.events) events.push(event);
  const end = events.find((e) => e.type === "end");
  expect(end?.type === "end" ? end.stopReason : null).toBe("toolUse");
});

test("cached input is subtracted, so it is not billed as ordinary input too", async () => {
  // `Usage.inputTokens` is *uncached* input. `input_tokens` arrives inclusive of
  // the cached part, so failing to subtract prices the same tokens twice — once
  // at the input rate and once as a cache read.
  const capture = capturing(
    [
      "event: response.completed",
      'data: {"response":{"status":"completed","usage":{"input_tokens":100,' +
        '"output_tokens":5,"input_tokens_details":{"cached_tokens":80}}}}',
      "",
    ].join("\n"),
  );
  const result = await museAdapter.send({
    request,
    model: "muse-spark-1.3",
    credentials: creds({ apiKey: "meta-key" }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  const events = [];
  for await (const event of result.events) events.push(event);
  const end = events.find((e) => e.type === "end");
  const usage = end?.type === "end" ? end.usage : null;
  expect(usage?.inputTokens).toBe(20);
  expect(usage?.cacheReadTokens).toBe(80);
});

test("an upstream error keeps its class, and an unknown event names muse", async () => {
  const authed = capturing(
    ["event: error", 'data: {"error":{"code":"invalid_api_key","message":"bad key"}}', ""].join(
      "\n",
    ),
  );
  const a = await museAdapter.send({
    request,
    model: "muse-spark-1.3",
    credentials: creds({ apiKey: "meta-key" }),
    http: authed.http,
    signal: new AbortController().signal,
  });
  const first = [];
  for await (const event of a.events) first.push(event);
  // `AUTH`, not `UPSTREAM`: the breaker and the retry policy read this, and a
  // dead key retried as a transient fault burns every attempt.
  expect(first.find((e) => e.type === "error")).toMatchObject({ code: "AUTH" });

  const unknown = capturing(["event: response.hallucinated", "data: {}", ""].join("\n"));
  const b = await museAdapter.send({
    request,
    model: "muse-spark-1.3",
    credentials: creds({ apiKey: "meta-key" }),
    http: unknown.http,
    signal: new AbortController().signal,
  });
  const second = [];
  for await (const event of b.events) second.push(event);
  // Fails visibly rather than skipping, and says whose stream it was — a fork
  // that still named OpenAI here sent a reader to the wrong provider's docs.
  expect(second.find((e) => e.type === "error")).toMatchObject({
    message: 'unrecognized muse stream event "response.hallucinated"',
  });
});

test("what this dialect cannot express is recorded, not dropped in silence", async () => {
  const capture = capturing();
  const result = await museAdapter.send({
    request: {
      ...request,
      messages: [
        { role: "system", content: [{ type: "text", text: "be brief" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hmm", signature: "sig" },
            { type: "providerNative", provider: "anthropic", blockType: "reasoning", data: {} },
          ],
        },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      tools: [
        {
          kind: "provider",
          provider: "anthropic",
          family: "webSearch",
          type: "web_search_20250305",
          name: "web_search",
          wire: {},
        },
      ],
      reasoning: { mode: "budget", budgetTokens: 4096 },
    },
    model: "muse-spark-1.3",
    credentials: creds({ apiKey: "meta-key" }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  expect(result.degradations).toEqual([
    "muse:system-turn-as-developer",
    "muse:thinking-dropped",
    "muse:foreign-native-block-dropped",
    "muse:provider-tool-dropped",
    "muse:reasoning-budget-dropped",
  ]);
  // The mid-conversation system turn keeps its position and its standing.
  expect(capture.sent[0]?.body).toContain('"role":"developer"');
});

test("its own reasoning item goes home without the id it cannot resolve", async () => {
  const sent = await sentFor(creds({ apiKey: "meta-key" }), {
    ...request,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "providerNative",
            provider: "muse",
            blockType: "reasoning",
            data: { id: "rs_1", encrypted_content: "opaque" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  });

  // Under `store: false` no server-assigned id resolves, and an item still
  // carrying one is rejected outright.
  expect(sent.body).toContain('"encrypted_content":"opaque"');
  expect(sent.body).not.toContain("rs_1");
});

test("an unanswered tool call is completed rather than removed", async () => {
  // Removing it would rewrite what the model said; leaving it bare is refused
  // by the API. A turn interrupted between the call and the client running it
  // produces exactly this.
  const sent = await sentFor(creds({ apiKey: "meta-key" }), {
    ...request,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "ls", input: {} }],
      },
    ],
  });

  expect(sent.body).toContain('{"type":"function_call","call_id":"call_1"');
  expect(sent.body).toContain('{"type":"function_call_output","call_id":"call_1","output":""}');
});

test("a stream decodes to text and usage", async () => {
  const sse = [
    "event: response.content_part.added",
    'data: {"output_index":0,"content_index":0,"part":{"type":"output_text"}}',
    "",
    "event: response.output_text.delta",
    'data: {"output_index":0,"content_index":0,"delta":"he"}',
    "",
    "event: response.output_text.delta",
    'data: {"output_index":0,"content_index":0,"delta":"llo"}',
    "",
    "event: response.completed",
    'data: {"response":{"status":"completed","usage":' +
      '{"input_tokens":11,"output_tokens":2,"total_tokens":13}}}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");

  const capture = capturing(sse);
  const result = await museAdapter.send({
    request,
    model: "muse-spark-1.3",
    credentials: creds({ apiKey: "meta-key" }),
    http: capture.http,
    signal: new AbortController().signal,
  });

  const events = [];
  for await (const event of result.events) events.push(event);

  const text = events
    .map((e) => (e.type === "blockDelta" && e.delta.type === "text" ? e.delta.text : ""))
    .join("");
  expect(text).toBe("hello");

  const end = events.find((e) => e.type === "end");
  expect(end?.type === "end" ? end.stopReason : null).toBe("endTurn");
  // `inputTokens` is uncached input; this payload reports no cached part.
  expect(end?.type === "end" ? end.usage?.inputTokens : null).toBe(11);
  expect(end?.type === "end" ? end.usage?.outputTokens : null).toBe(2);
});

test("the base url the mint stated is where inference goes", async () => {
  // Muse's own client follows `base_url` from the login rather than a compiled
  // constant, and a credential minted against another deployment reaches it.
  const sent = await sentFor(
    creds({ apiKey: "meta-key", providerData: { baseUrl: "https://api.meta.ai/v2" } }),
  );

  expect(sent.url).toBe("https://api.meta.ai/v2/responses");
});

test("a stored base url is validated at the read that attaches the key", async () => {
  // `providerData` is parsed back out of the database with a bare `JSON.parse`
  // and a restored snapshot bypasses every schema, so the mint-time check is
  // not a guarantee this read may lean on. Each of these would otherwise send
  // `Authorization: Bearer <minted key>` to a host Meta does not control.
  for (const baseUrl of [
    "https://evil.example/v1",
    "https://api.meta.ai@evil.example/v1",
    "https://evilmeta.ai/v1",
    "https://api.meta.ai.attacker.example/v1",
    "http://api.meta.ai/v1",
    "https://api.meta.ai/v1?x=1",
    "https://api.meta.ai/v1#f",
    "",
    7,
    "ftp://api.meta.ai/v1",
  ]) {
    const sent = await sentFor(creds({ apiKey: "meta-key", providerData: { baseUrl } }));
    expect({ baseUrl, url: sent.url }).toEqual({
      baseUrl,
      url: "https://api.meta.ai/v1/responses",
    });
  }
});

test("a base url Meta really could have published is honoured", async () => {
  for (const [baseUrl, url] of [
    ["https://api.meta.ai/v1", "https://api.meta.ai/v1/responses"],
    ["https://api.meta.ai/v1/", "https://api.meta.ai/v1/responses"],
    ["https://eu.api.meta.ai/v2", "https://eu.api.meta.ai/v2/responses"],
  ] as const) {
    const sent = await sentFor(creds({ apiKey: "meta-key", providerData: { baseUrl } }));
    expect({ baseUrl, url: sent.url }).toEqual({ baseUrl, url });
  }
});
