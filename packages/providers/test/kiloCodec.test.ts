import { expect, test } from "bun:test";
import { type ChatRequest, GatewayError, RETRYABLE, type StreamEvent } from "@omni/ir";
import type { CodecErrorInput, CodecInput, ProviderCodec } from "../src/codec.ts";
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
  // Both request shapes. With only `stream: true`, the codec's own
  // `stream: true` override is a no-op — `toKiloWire` already emits it — so
  // dropping that override survived every assertion here. The failure it guards
  // is silent and total: a non-streaming upstream returns JSON, `parseSse`
  // yields nothing, and the client gets an empty response.
  for (const shape of [request, { ...request, stream: false }])
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
        request: shape,
        model: "anthropic/claude-sonnet-5",
        credentials: creds,
        http: direct.http,
        signal: new AbortController().signal,
      });
      await bridged.send({
        request: shape,
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

test("a failed response is never read twice, and its body getter is never fired", async () => {
  // `bodyCapture` wraps the response so that `body` is a getter which tees the
  // upstream stream and starts a capture drain. Object spread reads getters, so
  // handing `httpError` a `{ ...res }` invoked it on a response nothing was
  // going to read — recording the error body twice in the forensic artifact and
  // leaving an abandoned tee branch buffering it.
  //
  // Counted rather than asserted structurally: what matters is that the bridge
  // touches `body` zero times on the failure path, whatever the response object
  // happens to be.
  let bodyReads = 0;
  let textReads = 0;
  const capturing = async (): Promise<HttpResponse> => ({
    status: 429,
    headers: new Headers({ "retry-after": "11" }),
    get body(): ReadableStream<Uint8Array> | null {
      bodyReads += 1;
      return null;
    },
    text: async () => {
      textReads += 1;
      return '{"error":{"message":"slow down"}}';
    },
  });

  const failure = await bridged
    .send({
      request,
      model: "anthropic/claude-sonnet-5",
      credentials: credentials(),
      http: capturing,
      signal: new AbortController().signal,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(bodyReads).toBe(0);
  // Read once, by the bridge, and handed to `httpError` already read.
  expect(textReads).toBe(1);
  // And the error is still fully formed: headers reach `httpError`, so
  // `Retry-After` survives the hand-off.
  expect(failure).toMatchObject({ code: "RATE_LIMIT", retryAfterMs: 11_000 });
});

test("classifyError sees what the request gave up, and can carry it on the error", async () => {
  // Anthropic's fingerprint refusal is thrown *carrying* degradations, and
  // `dispatch` writes `error.degradations` into `request_logs`. A hook that
  // could not see them turned "the request was reduced in these ways and then
  // refused" into a refusal with no diagnosis — measured on a real conversion,
  // which dropped `anthropic:oauth-system-prefix` and
  // `anthropic:context-1m-dropped` on the floor.
  const seen: CodecErrorInput[] = [];
  const withNotes = codecAdapter("kilo", kiloDescriptor.capabilities, {
    buildRequest: (input) => ({
      ...kiloCodec.buildRequest(input),
      degradations: ["kilo:something-dropped"],
      decodeState: { marker: 1 },
    }),
    decode: kiloCodec.decode,
    classifyError(errorInput) {
      seen.push(errorInput);
      return new GatewayError("BAD_REQUEST", "refused", {
        provider: "kilo",
        degradations: [...errorInput.degradations, "kilo:refused-for-that"],
      });
    },
  });

  const failure = await withNotes
    .send({
      request,
      model: "anthropic/claude-sonnet-5",
      credentials: credentials(),
      http: async () => ({
        status: 400,
        headers: new Headers(),
        body: null,
        text: async () => "no",
      }),
      signal: new AbortController().signal,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(seen[0]?.degradations).toEqual(["kilo:something-dropped"]);
  // And the state the build step produced, for a codec whose refusal depends on
  // what it did rather than only on what came back.
  expect(seen[0]?.decodeState).toEqual({ marker: 1 });
  expect(failure).toMatchObject({
    code: "BAD_REQUEST",
    degradations: ["kilo:something-dropped", "kilo:refused-for-that"],
  });
});

// --- What the bridge forwards, and what it does when a codec misbehaves ------

/** A codec that records what it was handed and returns a fixed request. */
function recording(over: Partial<ProviderCodec> = {}) {
  const seen: CodecInput[] = [];
  const codecUnderTest: ProviderCodec = {
    buildRequest(input) {
      seen.push(input);
      return {
        request: { url: "https://x.test", method: "POST", headers: [], body: "{}" },
        degradations: ["x:dropped-something"],
        cloakedTools: 3,
        decodeState: { alias: "Session" },
      };
    },
    decode: async function* ({ decodeState }) {
      yield { type: "start", id: "m", model: JSON.stringify(decodeState) } as StreamEvent;
    },
    ...over,
  };
  return { seen, adapter: codecAdapter("kilo", kiloDescriptor.capabilities, codecUnderTest) };
}

const ok = async (): Promise<HttpResponse> => ({
  status: 200,
  headers: new Headers(),
  body: sseBody(),
  text: async () => "",
});

test("every value the bridge forwards actually arrives", async () => {
  // Five of the seven had no coverage anywhere: deleting the forwarding of
  // `degradations`, `cloakedTools`, `decodeState`, `autoCacheEnabled` or
  // `requestId` survived the entire suite. `kiloCodec` uses none of them, so the
  // equivalence test compared `[]` to `[]` and proved nothing about any.
  //
  // Each matters on its own: `decodeState` is what carries Anthropic's tool
  // cloak, so losing it returns every tool result under its alias and silently
  // degrades RTK classification; `autoCacheEnabled` lost means auto-caching
  // quietly stops and every request pays full input price forever.
  const { seen, adapter } = recording();

  const result = await adapter.send({
    request,
    model: "anthropic/claude-sonnet-5",
    credentials: credentials(),
    http: ok,
    signal: new AbortController().signal,
    requestId: "req_abc",
    autoCache: true,
  });

  expect(seen[0]?.requestId).toBe("req_abc");
  expect(seen[0]?.autoCacheEnabled).toBe(true);
  expect(seen[0]?.model).toBe("anthropic/claude-sonnet-5");
  expect(seen[0]?.credentials.accessToken).toBe("kilo-oauth-token");

  expect(result.degradations).toEqual(["x:dropped-something"]);
  expect(result.cloakedTools).toBe(3);
  // `decodeState` reaching `decode` verbatim, which is the mechanism the whole
  // contract calls load-bearing.
  const events = await drain(result.events);
  expect(events[0]).toMatchObject({ model: JSON.stringify({ alias: "Session" }) });
});

test("a codec that throws fails over instead of ending the request", async () => {
  // `RETRYABLE.INTERNAL` is false, so an unguarded plugin `TypeError` ended the
  // request after one attempt with a 500 while the rest of the pool sat unused.
  // Rule 15: a plugin's failure is skipped and reported, never fatal.
  //
  // **`decode` is declared here as an `async function*`, which is the shape the
  // contract declares and the one that matters.** An earlier version of this
  // test used a plain function that threw synchronously — a fixture that passes
  // whether or not the guard works, because calling an `async function*` returns
  // its generator without running a line of the body. The guard wrapped the call
  // and caught nothing; the raw `TypeError` escaped, `classify` read it as
  // `INTERNAL`, and the request died unretryably. The fixture shape *was* the
  // bug's hiding place.
  const cases: ReadonlyArray<readonly [string, Partial<ProviderCodec>]> = [
    [
      "buildRequest",
      {
        buildRequest: () => {
          throw new TypeError("plugin bug");
        },
      },
    ],
    // Throws when constructed.
    [
      "decode",
      {
        decode: () => {
          throw new TypeError("plugin bug");
        },
      },
    ],
    // Throws when iterated — the declared shape.
    [
      "decode",
      {
        // Throwing before the first yield is the shape under test: it is where
        // the guard used to catch nothing.
        // biome-ignore lint/correctness/useYield: intentional, see above
        decode: async function* () {
          throw new TypeError("plugin bug");
        },
      },
    ],
    // Throws mid-stream, after yielding.
    [
      "decode",
      {
        decode: async function* () {
          yield { type: "start", id: "m", model: "m" } as StreamEvent;
          throw new TypeError("plugin bug");
        },
      },
    ],
  ];

  for (const [hook, broken] of cases) {
    const { adapter } = recording(broken);
    const failure = await (async () => {
      try {
        const result = await adapter.send({
          request,
          model: "m",
          credentials: credentials(),
          http: ok,
          signal: new AbortController().signal,
        });
        await drain(result.events);
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure).toMatchObject({ code: "UPSTREAM", provider: "kilo" });
    expect((failure as Error).message).toContain(hook);
    // The codec's own message never reaches the error: it is authored outside
    // this repository and `LogFields` is a closed allowlist.
    expect((failure as Error).message).not.toContain("plugin bug");
    expect(RETRYABLE[(failure as GatewayError).code]).toBe(true);
  }
});

test("a codec's own GatewayError keeps its classification", async () => {
  // The other half, and the one the guard got wrong. `kiloCodec.buildRequest`
  // throws `AUTH` when the credential carries no token — deliberate and
  // correctly classified. Flattening it to `UPSTREAM` cost the request its
  // self-healing path: `dispatch` gates the OAuth credential-refresh retry on
  // `code === "AUTH"`, so an expired token would fail over rather than be
  // refreshed, and on a single-candidate pool would fail outright.
  const cases: ReadonlyArray<readonly [string, Partial<ProviderCodec>]> = [
    [
      "buildRequest",
      {
        buildRequest: () => {
          throw new GatewayError("AUTH", "no token", { provider: "kilo" });
        },
      },
    ],
    [
      "decode",
      {
        // A codec that classifies its own failure before yielding anything.
        // biome-ignore lint/correctness/useYield: intentional, see above
        decode: async function* () {
          throw new GatewayError("CONTENT_FILTER", "refused", { provider: "kilo" });
        },
      },
    ],
  ];

  for (const [, deliberate] of cases) {
    const { adapter } = recording(deliberate);
    const failure = await (async () => {
      try {
        const result = await adapter.send({
          request,
          model: "m",
          credentials: credentials(),
          http: ok,
          signal: new AbortController().signal,
        });
        await drain(result.events);
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(GatewayError);
    // Its own code, not the guard's.
    expect((failure as GatewayError).code).not.toBe("UPSTREAM");
  }

  // And the real codec: the adapter and the codec agree on the classification,
  // which is the equivalence the whole sub-project rests on.
  const noToken = { accessToken: null, apiKey: null, providerData: {} };
  const viaAdapter = await kiloAdapter
    .send({
      request,
      model: "m",
      credentials: noToken,
      http: ok,
      signal: new AbortController().signal,
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  const viaCodec = await bridged
    .send({
      request,
      model: "m",
      credentials: noToken,
      http: ok,
      signal: new AbortController().signal,
    })
    .then(
      () => null,
      (e: unknown) => e,
    );

  expect((viaCodec as GatewayError).code).toBe((viaAdapter as GatewayError).code);
  expect((viaCodec as GatewayError).code).toBe("AUTH");
});

test("a codec returning a malformed request is refused before the transport", async () => {
  // Junk in, named error out — rather than `undefined is not an object` from
  // inside the bridge, which reads as a gateway bug and is not retryable.
  for (const bad of [
    {},
    { request: {} },
    { request: { url: "https://x", method: "POST" } },
    { request: { url: 1, method: "POST", headers: [], body: "{}" } },
  ]) {
    let called = false;
    const { adapter } = recording({ buildRequest: () => bad as never });
    const failure = await adapter
      .send({
        request,
        model: "m",
        credentials: credentials(),
        http: async () => {
          called = true;
          return ok();
        },
        signal: new AbortController().signal,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({ code: "UPSTREAM", provider: "kilo" });
    expect((failure as Error).message).toContain("did not return a usable request");
    // Nothing was sent: a malformed request never reaches the network.
    expect(called).toBe(false);
  }
});

test("a throwing classifyError does not mask the upstream failure", async () => {
  const { adapter } = recording({
    classifyError: () => {
      throw new TypeError("hook bug");
    },
  });

  const failure = await adapter
    .send({
      request,
      model: "m",
      credentials: credentials(),
      http: async () => ({
        status: 500,
        headers: new Headers(),
        body: null,
        text: async () => "upstream down",
      }),
      signal: new AbortController().signal,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  // Still retryable, still attributable, and still not the plugin's text.
  expect(failure).toMatchObject({ code: "UPSTREAM", provider: "kilo" });
  expect((failure as Error).message).toContain("classifyError");
});

test("a codec cannot write unbounded free text into request_logs", async () => {
  // `degradations` lands in a stored column, and a codec is third-party code.
  // The field beside it carries a *count* of cloaked tool names precisely
  // because names are client free text and `LogFields` is the redaction
  // boundary; handing the same untrusted source an unbounded string array would
  // be that mistake in a different shape.
  //
  // Capped rather than refused: a chatty codec loses detail, not its request.
  const { adapter } = recording({
    buildRequest: () => ({
      request: { url: "https://x.test", method: "POST", headers: [], body: "{}" },
      degradations: [
        "x".repeat(500),
        ...Array.from({ length: 50 }, (_, i) => `note-${i}`),
        // Not a string: dropped rather than coerced, because `[object Object]`
        // looks like data and explains nothing.
        { toString: () => "sneaky" } as unknown as string,
      ],
    }),
  });

  const result = await adapter.send({
    request,
    model: "m",
    credentials: credentials(),
    http: ok,
    signal: new AbortController().signal,
  });

  expect(result.degradations).toHaveLength(16);
  expect(result.degradations[0]).toHaveLength(64);
  expect(result.degradations.some((d) => d.includes("object Object"))).toBe(false);
});
