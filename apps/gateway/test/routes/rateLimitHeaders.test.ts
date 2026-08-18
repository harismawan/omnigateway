import { expect, test } from "bun:test";
import type { StreamEvent } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import type { LimitConfig } from "@omni/ratelimit/catalog";
import {
  captureLogger,
  memoryStore,
  requestLog,
  seedApiKey,
  seedCredential,
  stubAdapters,
  target,
  virtualModel,
} from "@omni/testkit";
import { ApiKeyRateLimiter } from "../../src/auth/rateLimit.ts";
import { proxyRoutes } from "../../src/routes/proxy.ts";

/**
 * 2026-08-18T09:32:07Z. Fixed and named, because a reset asserted against
 * `Date.now()` reduces to "some digits and a Z" and would pass for any
 * arithmetic at all.
 */
const NOW = Date.UTC(2026, 7, 18, 9, 32, 7);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;

const EVENTS: StreamEvent[] = [
  { type: "start", id: "upstream_1", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3 },
  },
];

type Surface = "anthropic" | "openai";

const PATH: Record<Surface, string> = {
  anthropic: "/v1/messages",
  openai: "/v1/chat/completions",
};

/** One finished request already on the key's ledger, inside every window. */
type Seeded = { at: number; tokens?: number };

async function harness(limits: LimitConfig, seeded: Seeded[] = []) {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const { raw, key } = await seedApiKey(store, { limits });
  for (const [index, row] of seeded.entries()) {
    await store.usage.append(
      requestLog({
        id: `seed_${index}`,
        apiKeyId: key.id,
        at: row.at,
        inputTokens: row.tokens ?? 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
  }

  const logger = captureLogger();
  const now = () => NOW;
  let n = 0;
  const app = proxyRoutes({
    store,
    adapters: stubAdapters(EVENTS),
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    now,
    rand: () => 0.5,
    refresh: async (credential) => await credential.secrets(),
    requestId: () => `req_${++n}`,
    rateLimiter: new ApiKeyRateLimiter({ store, now, logger }),
    logger,
  });

  const call = (
    surface: Surface,
    body: Record<string, unknown> = {},
    auth: "bearer" | "x-api-key" = "bearer",
  ) =>
    app.handle(
      new Request(`http://localhost${PATH[surface]}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth === "bearer" ? { authorization: `Bearer ${raw}` } : { "x-api-key": raw }),
        },
        body: JSON.stringify({
          model: "fast",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          ...body,
        }),
      }),
    );

  return { store, call, keyId: key.id };
}

/** Only the rate-limit headers, so an assertion states the whole dialect. */
function limitHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name.startsWith("anthropic-ratelimit-") || name.startsWith("x-ratelimit-")) {
      headers[name] = value;
    }
  });
  return headers;
}

/**
 * 1996 rather than 1997: three rows are already on the ledger and the request
 * being answered is the fourth. Both vendors define `remaining` as what is left
 * once this response is accounted for.
 */
const ANTHROPIC_5H = {
  "anthropic-ratelimit-requests-limit": "2000",
  "anthropic-ratelimit-requests-remaining": "1996",
  "anthropic-ratelimit-requests-reset": "2026-08-18T14:32:07Z",
};

const OPENAI_5H = {
  "x-ratelimit-limit-requests": "2000",
  "x-ratelimit-remaining-requests": "1996",
  "x-ratelimit-reset-requests": "5h0m0s",
};

/** Three requests already inside the five-hour window. */
const THREE: Seeded[] = [{ at: NOW - 4 * HOUR }, { at: NOW - 2 * HOUR }, { at: NOW - MINUTE }];

test("a non-streaming success carries each surface's own dialect", async () => {
  const anthropic = await harness({ requests: { "5h": 2000 } }, THREE);
  const first = await anthropic.call("anthropic");
  expect(first.status).toBe(200);
  expect(limitHeaders(first)).toEqual(ANTHROPIC_5H);
  anthropic.store.close();

  const openai = await harness({ requests: { "5h": 2000 } }, THREE);
  const second = await openai.call("openai");
  expect(second.status).toBe(200);
  expect(limitHeaders(second)).toEqual(OPENAI_5H);
  openai.store.close();
});

/**
 * The off-by-one a client would feel. A fresh key limited to two per minute
 * must advertise one remaining on its first response, not two — a client that
 * believed two and sent two more would be refused on the second.
 *
 * Only `requests` is counted forward. `tokens` debits when the response
 * completes, so at the instant the head is written this request's token cost is
 * genuinely unknown and the figure stays at what the window already held.
 */
test("remaining counts the request being answered, and only for requests", async () => {
  const { store, call } = await harness({ requests: { "1m": 2 }, tokens: { "1m": 100 } });
  const response = await call("anthropic");
  expect(response.status).toBe(200);
  expect(limitHeaders(response)).toEqual({
    "anthropic-ratelimit-requests-limit": "2",
    "anthropic-ratelimit-requests-remaining": "1",
    // `now`, not `now + 1m`: the ring is empty, so the window is already free.
    // `tokens` has no ring to ask and falls back to the far end of the window.
    "anthropic-ratelimit-requests-reset": "2026-08-18T09:32:07Z",
    "anthropic-ratelimit-tokens-limit": "100",
    "anthropic-ratelimit-tokens-remaining": "100",
    "anthropic-ratelimit-tokens-reset": "2026-08-18T09:33:07Z",
  });
  store.close();
});

/**
 * A refusal claimed no slot, so it reports every window untouched.
 *
 * The refused dimension is deliberately NOT `requests`. At its own ceiling
 * `remaining` is already floored to zero, so subtracting the request again
 * would be invisible there and this would assert nothing. Refusing on `tokens`
 * while `requests` still has room is the only arrangement where counting a
 * refusal forward can be seen at all: one row is on the ledger, so a correct
 * refusal reports 1999 and a wrong one reports 1998.
 */
test("a refusal does not count itself against any window", async () => {
  const { store, call } = await harness({ requests: { "5h": 2000 }, tokens: { "5h": 100 } }, [
    { at: NOW - HOUR, tokens: 500 },
  ]);
  const response = await call("anthropic");
  expect(response.status).toBe(429);
  expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("1999");
  expect(response.headers.get("anthropic-ratelimit-tokens-remaining")).toBe("0");
  store.close();
});

/**
 * The head is sent before a token has been counted, so these are the pre-flight
 * figures and there is nowhere to revise them to afterwards. Asserted on the
 * response head rather than after the body drains, which is the whole point.
 */
test("a streaming success carries the headers on the response head", async () => {
  const anthropic = await harness({ requests: { "5h": 2000 } }, THREE);
  const first = await anthropic.call("anthropic", { stream: true });
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(limitHeaders(first)).toEqual(ANTHROPIC_5H);
  await first.text();
  anthropic.store.close();

  const openai = await harness({ requests: { "5h": 2000 } }, THREE);
  const second = await openai.call("openai", { stream: true });
  expect(second.status).toBe(200);
  expect(second.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(limitHeaders(second)).toEqual(OPENAI_5H);
  await second.text();
  openai.store.close();
});

/**
 * At the ceiling, with the oldest of the two rows four hours into a five-hour
 * window — so a slot frees in an hour, and that is what both dialects and the
 * `Retry-After` beside them say.
 */
const REFUSED: Seeded[] = [{ at: NOW - 4 * HOUR }, { at: NOW - HOUR }];

test("a 429 carries the headers and a Retry-After, on both surfaces", async () => {
  const anthropic = await harness({ requests: { "5h": 2 } }, REFUSED);
  const first = await anthropic.call("anthropic");
  expect(first.status).toBe(429);
  expect(first.headers.get("retry-after")).toBe("3600");
  expect(limitHeaders(first)).toEqual({
    "anthropic-ratelimit-requests-limit": "2",
    "anthropic-ratelimit-requests-remaining": "0",
    "anthropic-ratelimit-requests-reset": "2026-08-18T10:32:07Z",
  });
  anthropic.store.close();

  const openai = await harness({ requests: { "5h": 2 } }, REFUSED);
  const second = await openai.call("openai");
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).toBe("3600");
  expect(limitHeaders(second)).toEqual({
    "x-ratelimit-limit-requests": "2",
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-reset-requests": "1h0m0s",
  });
  openai.store.close();
});

/**
 * The figure a `Retry-After` would otherwise carry, and the reason the deny path
 * takes a second read at all: the oldest row here frees a slot in an hour, and
 * the window's far end is a week away.
 */
test("the deny path reports the exact reset from the oldest retained row", async () => {
  const { store, call } = await harness({ requests: { "1w": 2 } }, [
    { at: NOW - WEEK + HOUR },
    { at: NOW - MINUTE },
  ]);
  const response = await call("anthropic");

  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("3600");
  // The header and the `Retry-After` name the same instant; a response that
  // disagreed with itself would be obeyed according to whichever the SDK reads.
  expect(response.headers.get("anthropic-ratelimit-requests-reset")).toBe("2026-08-18T10:32:07Z");
  store.close();
});

/**
 * The request is already being refused. A reset that could not be computed must
 * not turn that 429 into a 500 — so the overstated figure stands, which is the
 * one every other path reports anyway.
 */
test("a failing oldest-row read falls back to the overstated reset rather than failing", async () => {
  const { store, call } = await harness({ requests: { "1w": 2 } }, [
    { at: NOW - WEEK + HOUR },
    { at: NOW - MINUTE },
  ]);
  store.usage.oldestSince = async () => {
    throw new Error("database is locked");
  };

  const response = await call("anthropic");
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe(String(WEEK / 1000));
  expect(response.headers.get("anthropic-ratelimit-requests-reset")).toBe("2026-08-25T09:32:07Z");
  store.close();
});

/** The allow path keeps the overstatement; nothing acts on it, and it is free. */
test("the allow path does not take the extra read", async () => {
  const { store, call } = await harness({ requests: { "1w": 2000 } }, [{ at: NOW - MINUTE }]);
  let reads = 0;
  store.usage.oldestSince = async () => {
    reads++;
    return null;
  };

  const response = await call("anthropic");
  expect(response.status).toBe(200);
  expect(reads).toBe(0);
  // A week out, not a minute: the far end of the window, unrefined.
  expect(response.headers.get("anthropic-ratelimit-requests-reset")).toBe("2026-08-25T09:32:07Z");
  store.close();
});

/**
 * One header per dimension and up to three windows behind it. Reporting the
 * shortest unconditionally would show this key a comfortable 60-per-minute
 * figure while it sits one request from a weekly ceiling.
 */
test("the reported window is the one nearest exhaustion, not the shortest", async () => {
  const seeded: Seeded[] = Array.from({ length: 9 }, (_, index) => ({
    at: NOW - WEEK + HOUR + index,
  }));
  const { store, call } = await harness({ requests: { "1m": 60, "1w": 10 } }, seeded);

  const response = await call("anthropic");
  expect(response.status).toBe(200);
  expect(limitHeaders(response)).toEqual({
    "anthropic-ratelimit-requests-limit": "10",
    "anthropic-ratelimit-requests-remaining": "0",
    "anthropic-ratelimit-requests-reset": "2026-08-25T09:32:07Z",
  });
  store.close();
});

test("a key with no token limit emits no token headers, and one with no limits emits none", async () => {
  const requestsOnly = await harness({ requests: { "5h": 2000 } }, THREE);
  const first = await requestsOnly.call("anthropic");
  expect(limitHeaders(first)).toEqual(ANTHROPIC_5H);
  requestsOnly.store.close();

  const unlimited = await harness({});
  const second = await unlimited.call("anthropic");
  expect(second.status).toBe(200);
  expect(limitHeaders(second)).toEqual({});
  unlimited.store.close();

  const openai = await harness({});
  const third = await openai.call("openai");
  expect(third.status).toBe(200);
  expect(limitHeaders(third)).toEqual({});
  openai.store.close();
});

test("a token limit is reported alongside the request limit it shares a key with", async () => {
  const { store, call } = await harness({ requests: { "5h": 2000 }, tokens: { "5h": 100_000 } }, [
    { at: NOW - HOUR, tokens: 25_000 },
  ]);

  const response = await call("anthropic");
  expect(limitHeaders(response)).toEqual({
    "anthropic-ratelimit-requests-limit": "2000",
    "anthropic-ratelimit-requests-remaining": "1998",
    "anthropic-ratelimit-requests-reset": "2026-08-18T14:32:07Z",
    "anthropic-ratelimit-tokens-limit": "100000",
    "anthropic-ratelimit-tokens-remaining": "75000",
    "anthropic-ratelimit-tokens-reset": "2026-08-18T14:32:07Z",
  });
  store.close();
});

/** `spend` has no header on either surface, so a key limited only in dollars gets none. */
test("a spend limit renders nothing, even when it is the only limit", async () => {
  const { store, call } = await harness({ spend: { "1w": 25 } }, [{ at: NOW - HOUR }]);
  const response = await call("anthropic");
  expect(response.status).toBe(200);
  expect(limitHeaders(response)).toEqual({});
  store.close();
});

test("Bearer and x-api-key reach the same headers", async () => {
  const bearer = await harness({ requests: { "5h": 2000 } }, THREE);
  const first = await bearer.call("anthropic", {}, "bearer");
  bearer.store.close();

  const header = await harness({ requests: { "5h": 2000 } }, THREE);
  const second = await header.call("anthropic", {}, "x-api-key");
  header.store.close();

  expect(second.status).toBe(200);
  expect(limitHeaders(second)).toEqual(limitHeaders(first));
  expect(limitHeaders(second)).toEqual(ANTHROPIC_5H);
});

test("Bearer and x-api-key reach the same refusal", async () => {
  const bearer = await harness({ requests: { "5h": 2 } }, REFUSED);
  const first = await bearer.call("openai", {}, "bearer");
  bearer.store.close();

  const header = await harness({ requests: { "5h": 2 } }, REFUSED);
  const second = await header.call("openai", {}, "x-api-key");
  header.store.close();

  expect(first.status).toBe(429);
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).toBe(first.headers.get("retry-after"));
  expect(limitHeaders(second)).toEqual(limitHeaders(first));
});
