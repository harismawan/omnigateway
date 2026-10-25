import { expect, test } from "bun:test";
import type { ExportDestination } from "@omni/store/types";
import { requestLog } from "@omni/testkit";
import {
  type DeliveryOutcome,
  deliver,
  droppedSummary,
  IncompleteResponseError,
  type Prepared,
  prepare,
  REFUSALS,
  ResponseTooLargeError,
  type Sender,
  type Transport,
} from "../../src/export/deliver.ts";
import { BULK_CONTENT_TYPE } from "../../src/export/encoders/elasticsearch.ts";
import { buildRecord } from "../../src/export/record.ts";
import { asTransportResponse } from "./harness.ts";

/**
 * Per-destination delivery: what is sent where, with which headers, and what a
 * receiver's answer means. The loop's tests drive the same code through a fake
 * receiver; these pin the edges one at a time.
 */

const NOW = Date.UTC(2026, 9, 25, 12);

function destination(over: Partial<ExportDestination>): ExportDestination {
  return {
    id: "d",
    generation: "g",
    type: "webhook",
    enabled: true,
    config: { url: "https://hooks.internal/in/" },
    filter: {},
    filterMalformed: false,
    includeBodies: false,
    maxRequestBytes: null,
    startAt: 0,
    hasSecret: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

type Seen = { url: string; headers: Record<string, string>; body: string };

/** A receiver answering `respond`, recording each request with its body decompressed. */
function receiver(respond: () => Response): { transport: Transport; seen: Seen[] } {
  const seen: Seen[] = [];
  const transport: Transport = async (url, init) => {
    const raw = new Uint8Array(
      typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body,
    );
    const gzip = init.headers["content-encoding"] === "gzip";
    seen.push({
      url,
      headers: init.headers,
      body: new TextDecoder().decode(gzip ? Bun.gunzipSync(raw) : raw),
    });
    return asTransportResponse(respond());
  };
  return { transport, seen };
}

const timers = { setTimeout, clearTimeout };

function senderOf(d: ExportDestination, secret: string | null = null): Sender {
  const prepared = prepare(d, secret);
  if (!prepared.ok) throw new Error(`refused: ${prepared.error}`);
  return prepared.sender;
}

async function sendOne(
  sender: Sender,
  transport: Transport,
  signal = new AbortController().signal,
): Promise<DeliveryOutcome> {
  const part = sender.part(buildRecord(requestLog({ id: "req_1", at: NOW }), { keyLabel: null }));
  return deliver(sender, [part], { transport, signal, timers, now: () => NOW });
}

test("a destination whose stored filter is unreadable is refused, with a fixed message", () => {
  const prepared = prepare(destination({ filterMalformed: true }), null);
  expect(prepared).toEqual({ ok: false, error: REFUSALS.filter });
  expect(REFUSALS.filter).toBe("filter unreadable");
});

test("a config that no longer parses is refused without quoting it", () => {
  const es = destination({
    type: "elasticsearch",
    config: { url: "https://es.internal:9200", index: "Secret*Index", auth: "none" },
  });
  expect(prepare(es, null)).toEqual({ ok: false, error: REFUSALS.config });
});

test("secrets are held to the strict per-type schemas; a bad one is refused whole", () => {
  const es = (auth: string) =>
    destination({
      type: "elasticsearch",
      hasSecret: true,
      config: { url: "https://es.internal:9200", auth },
    });
  const hook = destination({ hasSecret: true });
  const otlp = destination({
    type: "otlp",
    hasSecret: true,
    config: { endpoint: "https://otel.internal:4318", signal: "logs" },
  });
  const refused: Prepared = { ok: false, error: REFUSALS.secret };

  expect(prepare(es("apiKey"), '{"username":"u","password":"p"}')).toEqual(refused);
  expect(prepare(es("basic"), '{"apiKey":"k"}')).toEqual(refused);
  expect(prepare(es("apiKey"), '{"apiKey":"k","extra":1}')).toEqual(refused);
  expect(prepare(es("apiKey"), null)).toEqual(refused);
  expect(prepare(es("apiKey"), "not json")).toEqual(refused);
  expect(prepare(hook, '{"headers":{"x-key":"v"},"extra":true}')).toEqual(refused);
  expect(prepare(hook, '{"headers":{"bad name":"v"}}')).toEqual(refused);
  expect(prepare(otlp, '{"headers":{}}')).toEqual(refused);
  expect(prepare(otlp, "[]")).toEqual(refused);
  // A secret header that is also a plain one would be sent twice or lost.
  const clash = destination({
    hasSecret: true,
    config: { url: "https://hooks.internal/in", headers: { "X-Key": "plain" } },
  });
  expect(prepare(clash, '{"headers":{"x-key":"secret"}}')).toEqual(refused);

  expect(prepare(es("apiKey"), '{"apiKey":"k"}').ok).toBe(true);
  expect(prepare(es("none"), null).ok).toBe(true);
  expect(prepare(hook, '{"signingSecret":"s"}').ok).toBe(true);
  expect(prepare(otlp, '{"headers":{"authorization":"Bearer t"}}').ok).toBe(true);
});

test("Elasticsearch: `<base>/_bulk`, NDJSON content type, gzip, credential in a header", async () => {
  const ok = () => Response.json({ errors: false, items: [] });
  const apiKey = receiver(ok);
  const sender = senderOf(
    destination({
      type: "elasticsearch",
      hasSecret: true,
      config: { url: "https://es.internal:9200/base", auth: "apiKey" },
    }),
    '{"apiKey":"abc"}',
  );
  expect(await sendOne(sender, apiKey.transport)).toMatchObject({ kind: "ok", dropped: 0 });
  const [req] = apiKey.seen;
  expect(req?.url).toBe("https://es.internal:9200/base/_bulk");
  expect(req?.headers["content-type"]).toBe(BULK_CONTENT_TYPE);
  expect(req?.headers["content-encoding"]).toBe("gzip");
  expect(req?.headers.authorization).toBe("ApiKey abc");
  expect(req?.body.split("\n")[0]).toContain('"_id":"req_1"');

  const basic = receiver(ok);
  const b = senderOf(
    destination({
      type: "elasticsearch",
      hasSecret: true,
      config: { url: "https://es.internal:9200", auth: "basic" },
    }),
    '{"username":"elastic","password":"pw"}',
  );
  await sendOne(b, basic.transport);
  expect(basic.seen[0]?.headers.authorization).toBe(`Basic ${btoa("elastic:pw")}`);
});

test("OTLP: `<base>/v1/<signal>`, JSON, gzip, the secret's headers", async () => {
  const r = receiver(() => Response.json({}));
  const sender = senderOf(
    destination({
      type: "otlp",
      hasSecret: true,
      config: { endpoint: "https://otel.internal:4318/otlp", signal: "traces" },
    }),
    '{"headers":{"authorization":"Bearer t"}}',
  );
  expect(await sendOne(sender, r.transport)).toMatchObject({ kind: "ok", dropped: 0 });
  expect(r.seen[0]?.url).toBe("https://otel.internal:4318/otlp/v1/traces");
  expect(r.seen[0]?.headers).toMatchObject({
    "content-type": "application/json",
    "content-encoding": "gzip",
    authorization: "Bearer t",
  });
  expect(JSON.parse(r.seen[0]?.body ?? "")).toHaveProperty("resourceSpans");
});

test("webhook: the URL exactly as stored, plain and secret headers, a verifiable signature", async () => {
  const r = receiver(() => new Response(null, { status: 204 }));
  const sender = senderOf(
    destination({
      hasSecret: true,
      config: { url: "https://hooks.internal/in/", headers: { "x-team": "a" } },
    }),
    '{"headers":{"x-token":"t"},"signingSecret":"sign-me"}',
  );
  // Posted to as stored, trailing slash included: the receiver's path is not ours.
  expect(await sendOne(sender, r.transport)).toMatchObject({ kind: "ok", status: 204 });
  const req = r.seen[0] as Seen;
  expect(req.url).toBe("https://hooks.internal/in/");
  expect(req.headers).toMatchObject({
    "content-type": "application/json",
    "x-team": "a",
    "x-token": "t",
  });
  expect(req.headers["content-encoding"]).toBeUndefined();
  const stamp = req.headers["x-omni-timestamp"] as string;
  expect(stamp).toBe(String(Math.floor(NOW / 1000)));
  const mac = new Bun.CryptoHasher("sha256", "sign-me")
    .update(`${stamp}.${req.body}`)
    .digest("hex");
  expect(req.headers["x-omni-signature"]).toBe(`sha256=${mac}`);
});

test("each status class: 2xx ok, 408/429/5xx retry (Retry-After read), 3xx and other 4xx fail", async () => {
  const sender = senderOf(destination({}));
  const outcome = (res: () => Response) => sendOne(sender, receiver(res).transport);

  expect(await outcome(() => new Response("ok"))).toMatchObject({ kind: "ok", status: 200 });
  for (const status of [408, 429, 500, 502, 503]) {
    expect(await outcome(() => new Response("no", { status }))).toMatchObject({
      kind: "retry",
      status,
      error: `HTTP ${status}`,
    });
  }
  expect(
    await outcome(() => new Response("", { status: 429, headers: { "retry-after": "30" } })),
  ).toMatchObject({ kind: "retry", retryAfterMs: 30_000 });
  for (const status of [301, 302, 307, 400, 401, 403, 404, 413]) {
    expect(
      await outcome(
        () => new Response("body with a secret", { status, headers: { location: "x" } }),
      ),
    ).toEqual({ kind: "failed", status, error: `HTTP ${status}` });
  }
});

test("Elasticsearch partial errors: permanent items drop, retryable items retry, unreadable fails", async () => {
  const sender = senderOf(
    destination({ type: "elasticsearch", config: { url: "https://es:9200", auth: "none" } }),
  );
  const answer = (json: unknown, status = 200) =>
    sendOne(sender, receiver(() => Response.json(json, { status })).transport);
  const item = (status: number, type?: string) => ({
    index: { _id: "x", status, ...(type ? { error: { type, reason: "doc text" } } : {}) },
  });

  expect(
    await answer({ errors: true, items: [item(201), item(400, "mapper_parsing_exception")] }),
  ).toEqual({ kind: "ok", status: 200, dropped: 1, reasons: ["mapper_parsing_exception"] });
  expect(await answer({ errors: true, items: [item(429)] })).toMatchObject({ kind: "retry" });
  // Carry: a `failure` is a hard failure, never a commit.
  expect(await answer({ nonsense: true })).toEqual({
    kind: "failed",
    status: 200,
    error: "HTTP 200 unreadable-bulk-response",
  });
  expect(await answer({ error: { type: "security_exception" } }, 401)).toEqual({
    kind: "failed",
    status: 401,
    error: "HTTP 401 security_exception",
  });
});

test("OTLP partialSuccess rejections count as dropped", async () => {
  const sender = senderOf(
    destination({
      type: "otlp",
      config: { endpoint: "https://otel:4318", signal: "logs" },
    }),
  );
  const r = receiver(() =>
    Response.json({ partialSuccess: { rejectedLogRecords: "1", errorMessage: "doc text" } }),
  );
  expect(await sendOne(sender, r.transport)).toEqual({
    kind: "ok",
    status: 200,
    dropped: 1,
    reasons: [],
  });
});

test("the drop summary is fixed text: counts and at most three identifiers", () => {
  expect(droppedSummary(0, 5, ["a"])).toBeNull();
  expect(droppedSummary(2, 5, [])).toBe("dropped 2 of 5");
  expect(droppedSummary(4, 5, ["a", "b", "a", "c", "d"])).toBe("dropped 4 of 5: a, b, c");
});

test("a transport error is a retry with a fixed summary, never the error's own text", async () => {
  const sender = senderOf(destination({}));
  const failing: Transport = async () => {
    throw new Error("connect ECONNREFUSED https://user:pw@hooks.internal/in");
  };
  expect(await sendOne(sender, failing)).toEqual({
    kind: "retry",
    status: null,
    error: "network error",
    retryAfterMs: null,
  });
});

test("the request timeout aborts the exchange and reads as a retryable timeout", async () => {
  const sender = senderOf(destination({}));
  const pending: Array<() => void> = [];
  const fake = {
    setTimeout: (fn: () => void) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimeout: () => {},
  };
  const hanging: Transport = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const part = sender.part(buildRecord(requestLog({ id: "r", at: NOW }), { keyLabel: null }));
  const sent = deliver(sender, [part], {
    transport: hanging,
    signal: new AbortController().signal,
    timers: fake,
    now: () => NOW,
  });
  for (const fire of pending.splice(0)) fire();
  expect(await sent).toEqual({ kind: "retry", status: null, error: "timeout", retryAfterMs: null });
});

test("an abort from the caller propagates, so the caller decides what it means", async () => {
  const sender = senderOf(destination({}));
  const controller = new AbortController();
  controller.abort(new Error("pause"));
  await expect(
    sendOne(sender, receiver(() => new Response("ok")).transport, controller.signal),
  ).rejects.toThrow("pause");
});

test("an index name the encoder refuses becomes a fixed refusal, never the thrown message", () => {
  // The pattern is valid for every real day; a row from year -1000 expands it
  // to a name starting with `-`, which the encoder refuses — quoting the name.
  const sender = senderOf(
    destination({
      type: "elasticsearch",
      config: { url: "https://es:9200", auth: "none", index: "{yyyy.MM.dd}-team-secret" },
    }),
  );
  const row = requestLog({ id: "r", at: Date.UTC(-1000, 0, 1) });
  const part = () => sender.part(buildRecord(row, { keyLabel: null }));
  expect(part).toThrow(REFUSALS.index);
  try {
    part();
  } catch (error) {
    expect(String(error)).not.toContain("team-secret");
  }
});

test("a timeout while the reply body is being read is a timeout, not an unreadable reply", async () => {
  const sender = senderOf(
    destination({ type: "elasticsearch", config: { url: "https://es:9200", auth: "none" } }),
  );
  const pending: Array<() => void> = [];
  const fake = {
    setTimeout: (fn: () => void) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimeout: () => {},
  };
  const slowBody: Transport = async () => ({
    status: 200,
    headers: new Headers(),
    text: async () => {
      for (const fire of pending.splice(0)) fire();
      return '{"errors":tr';
    },
    discard: async () => {},
  });
  const part = sender.part(buildRecord(requestLog({ id: "r", at: NOW }), { keyLabel: null }));
  expect(
    await deliver(sender, [part], {
      transport: slowBody,
      signal: new AbortController().signal,
      timers: fake,
      now: () => NOW,
    }),
  ).toEqual({ kind: "retry", status: null, error: "timeout", retryAfterMs: null });
});

/** A 2xx whose body read fails the way `httpTransport` fails it. */
const brokenBody =
  (error: Error): Transport =>
  async () => ({
    status: 200,
    headers: new Headers(),
    text: async () => {
      throw error;
    },
    // As `httpTransport`: a cut connection rejects; an over-limit body is just dropped.
    discard: async () => {
      if (error instanceof IncompleteResponseError) throw error;
    },
  });

test("an incomplete 2xx reply is a retryable transport failure for every format, never ok", async () => {
  const senders = [
    senderOf(destination({})),
    senderOf(
      destination({ type: "elasticsearch", config: { url: "https://es:9200", auth: "none" } }),
    ),
    senderOf(
      destination({ type: "otlp", config: { endpoint: "https://otel:4318", signal: "logs" } }),
    ),
  ];
  for (const sender of senders) {
    expect(await sendOne(sender, brokenBody(new IncompleteResponseError()))).toEqual({
      kind: "retry",
      status: 200,
      error: "incomplete response",
      retryAfterMs: null,
    });
  }
});

test("an over-limit 2xx: webhook needs only the status; ES and OTLP must not commit", async () => {
  const tooBig = brokenBody(new ResponseTooLargeError());
  // A webhook's 2xx is the whole answer; its body is discarded, never read.
  expect(await sendOne(senderOf(destination({})), tooBig)).toMatchObject({
    kind: "ok",
    status: 200,
  });
  const es = senderOf(
    destination({ type: "elasticsearch", config: { url: "https://es:9200", auth: "none" } }),
  );
  expect(await sendOne(es, tooBig)).toEqual({
    kind: "failed",
    status: 200,
    error: "HTTP 200 response too large",
  });
  const otlp = senderOf(
    destination({ type: "otlp", config: { endpoint: "https://otel:4318", signal: "logs" } }),
  );
  expect(await sendOne(otlp, tooBig)).toEqual({
    kind: "failed",
    status: 200,
    error: "HTTP 200 response too large",
  });
});
