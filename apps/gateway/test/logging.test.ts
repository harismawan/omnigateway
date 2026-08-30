import { expect, test } from "bun:test";
import { OAUTH_PROVIDERS } from "@omni/control";
import { createLogger, GatewayError } from "@omni/ir";
import type { RequestLog, Store } from "@omni/store";
import {
  beginLog,
  finishLog,
  newCompletedRequestLog,
  newPendingRequestLog,
  reasonField,
  routeLog,
} from "../src/logging.ts";
import type { Invalidator } from "../src/stream/broadcaster.ts";

/** A store that records appends, and can be told to fail one. */
function stubStore(opts: { failAppend?: boolean; failBegin?: boolean; failRoute?: boolean } = {}): {
  store: Store;
  appends: RequestLog[];
  begins: RequestLog[];
} {
  const appends: RequestLog[] = [];
  const begins: RequestLog[] = [];
  const store = {
    usage: {
      async append(log: RequestLog) {
        if (opts.failAppend === true) throw new Error("disk full");
        appends.push(log);
      },
      async begin(log: RequestLog) {
        if (opts.failBegin === true) throw new Error("disk full");
        begins.push(log);
      },
      async route() {
        if (opts.failRoute === true) throw new Error("disk full");
      },
    },
  } as unknown as Store;
  return { store, appends, begins };
}

function pending(over: Partial<RequestLog> = {}): Omit<RequestLog, "state"> {
  return {
    ...newCompletedRequestLog("req_1", 1_000, { requestedModel: "fast", status: 0 }),
    ...over,
  };
}

/** Records the topics an emitter names, in order. */
function recorder(): Invalidator & { topics: string[] } {
  const topics: string[] = [];
  return { topics, invalidate: (topic) => void topics.push(topic) };
}

function completed(over: Partial<RequestLog> = {}): RequestLog {
  return {
    ...newCompletedRequestLog("req_1", 1_000, { requestedModel: "fast", status: 200 }),
    inputTokens: 10,
    outputTokens: 20,
    ...over,
  };
}

test("pending request logs carry lifecycle placeholders", () => {
  const log = newPendingRequestLog({
    id: "req_1",
    at: 1_000,
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
  });

  expect(log).toMatchObject({
    id: "req_1",
    state: "pending",
    status: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    costUsd: 0,
  });
});

test("completed request logs carry completed lifecycle defaults", () => {
  const log = newCompletedRequestLog("req_1", 1_000, {
    requestedModel: "fast",
    status: 200,
  });

  expect(log).toMatchObject({
    id: "req_1",
    state: "done",
    status: 200,
    requestedModel: "fast",
  });
});

test("completed request logs pin caller-owned identity and lifecycle", () => {
  const widerLog = newCompletedRequestLog("req_other", 9_999, {
    requestedModel: "other",
    status: 500,
  });
  widerLog.state = "pending";

  const log = newCompletedRequestLog("req_1", 1_000, widerLog);

  expect(log).toMatchObject({
    id: "req_1",
    at: 1_000,
    state: "done",
  });
});

test("pending request logs ignore measurements from wider inputs", () => {
  const widerLog = newCompletedRequestLog("req_1", 1_000, {
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 3,
    status: 500,
    inputTokens: 5_000,
    outputTokens: 2_000,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 500,
    ttftMs: 450,
    durationMs: 12_000,
    costUsd: 1.23,
  });

  const log = newPendingRequestLog(widerLog);

  expect(log).toMatchObject({
    state: "pending",
    status: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 0,
    costUsd: 0,
  });
});

test("completed request logs require an explicit status", () => {
  // @ts-expect-error completed logs require an explicit status
  const log = newCompletedRequestLog("req_1", 1_000, { requestedModel: "fast" });

  expect(log.status).toBe(0);
});

test("a request that has only started invalidates logs, so it is visible while it runs", async () => {
  // The console stops polling `res:logs` the moment the socket declares it
  // pushed, so a transition that emits nothing is a transition nobody sees.
  // Beginning a request is one: the row exists, it is `pending`, and the logs
  // page counts it as running. Without this the row first appears when it
  // completes — by which time it is not running any more, and the only view of
  // in-flight work is empty on a busy gateway.
  const { store } = stubStore();
  const stream = recorder();

  await beginLog(store, pending(), "key_1", undefined, stream);

  // Not `res:usage`: nothing has been counted yet. The row carries placeholder
  // zeros, and a usage refetch would re-read numbers that have not moved.
  expect(stream.topics).toEqual(["res:logs"]);
});

test("a request that could not be recorded invalidates nothing", async () => {
  // Same rule `finishLog` follows: the invalidation says "re-read the list",
  // and there is nothing new in the list to read.
  const { store } = stubStore({ failBegin: true });
  const stream = recorder();

  await beginLog(store, pending(), "key_1", undefined, stream);

  expect(stream.topics).toEqual([]);
});

test("failing over to another target invalidates logs, because the row just changed", async () => {
  // `routeLog` is the failover path: the row already exists and its resolved
  // provider and model are being rewritten to whatever dispatch moved to. That
  // is a change to the list the console is showing, and on a pushed topic a
  // change that emits nothing is a change nobody sees — the row keeps naming
  // the account that already failed until the request ends.
  const { store } = stubStore();
  const stream = recorder();

  await routeLog(
    store,
    "req_1",
    { provider: "anthropic", model: "claude-opus-4", credentialId: "c2" },
    undefined,
    stream,
  );

  expect(stream.topics).toEqual(["res:logs"]);
});

test("a failover that could not be recorded invalidates nothing", async () => {
  const { store } = stubStore({ failRoute: true });
  const stream = recorder();

  await routeLog(
    store,
    "req_1",
    { provider: "anthropic", model: "claude-opus-4", credentialId: "c2" },
    undefined,
    stream,
  );

  expect(stream.topics).toEqual([]);
});

test("a finished request invalidates usage and logs, once each", async () => {
  const { store } = stubStore();
  const stream = recorder();

  await finishLog(store, completed(), "key_1", undefined, undefined, undefined, undefined, stream);

  // Order asserted as well as membership: both are floored at a second, so a
  // duplicate here is a duplicate the coalescer would forward on the first tick.
  expect(stream.topics).toEqual(["res:usage", "res:logs"]);
});

test("an unauthenticated request still invalidates, because the row is still a row", async () => {
  // Unlike the plugin event beside it, which needs a key to attribute to. The
  // console shows every request, so a row nobody authenticated is one it shows.
  const { store } = stubStore();
  const stream = recorder();

  await finishLog(store, completed(), null, undefined, undefined, undefined, undefined, stream);

  expect(stream.topics).toEqual(["res:usage", "res:logs"]);
});

test("a row that never landed invalidates nothing", async () => {
  // The one place this parts company with the debit above it. A debit claims
  // tokens were spent, which they were; an invalidation claims a refetch will
  // show something new, and against a write that failed it will not.
  const { store, appends } = stubStore({ failAppend: true });
  const stream = recorder();

  await finishLog(store, completed(), "key_1", undefined, undefined, undefined, undefined, stream);

  expect(appends).toEqual([]);
  expect(stream.topics).toEqual([]);
});

test("a throwing invalidation does not turn a finished request into an error", async () => {
  // `finishLog` never throws. A frame that could not be queued is one more
  // thing that must not be able to change what the client already received.
  const { store, appends } = stubStore();

  await finishLog(store, completed(), "key_1", undefined, undefined, undefined, undefined, {
    invalidate: () => {
      throw new Error("registry exploded");
    },
  });

  expect(appends).toHaveLength(1);
});

/**
 * The log line an operator reads when their accounts stop refreshing.
 *
 * `reasonField` withholds a message when the error names a provider and is not
 * gateway-authored, because `httpError` builds one from up to 500 characters of
 * an upstream body. The five built-in OAuth flows are the other case: their
 * text comes from literals and from `tokenErrorMessage`, which reads an error
 * identifier *without* the body.
 *
 * Porting them onto the plugin contract silenced all of it for one commit —
 * `fail` stamped `provider` and left the flag off, so both arms went false and
 * a refresh failure printed a bare code. Owned here because this is the only
 * layer that may import both the flows and the line that reads them.
 */
test("a built-in oauth failure still explains itself at default level", async () => {
  const quiet = createLogger({ level: "info", write: () => {}, now: () => 0 });
  const dead = async () => {
    throw new Error("connection reset");
  };

  // Walked from the registry rather than listed, so a sixth built-in is covered
  // the day it is added — the instrument `providerTables.test.ts` uses, for the
  // reason it gives: a list of what to check has exactly the property the thing
  // it checks lacks.
  const providers = Object.values(OAUTH_PROVIDERS);
  expect(providers.length).toBeGreaterThan(0);
  for (const provider of providers) {
    const error: GatewayError = await provider
      .refresh("a-refresh-token", { http: dead as never, now: () => 0 }, {})
      .then(() => {
        throw new Error(`${provider.id} refresh resolved against a dead transport`);
      })
      .catch((raised: unknown) => raised as GatewayError);

    expect({ provider: provider.id, printed: "reason" in reasonField(error, quiet) }).toEqual({
      provider: provider.id,
      printed: true,
    });
  }
});

test("an upstream body is still withheld at default level", () => {
  // The control. A change that printed everything would satisfy the test above
  // while putting prompt text on stdout, which is why the flag is opt-in.
  const quiet = createLogger({ level: "info", write: () => {}, now: () => 0 });
  expect(
    reasonField(
      new GatewayError("UPSTREAM", "context length exceeded: <prompt text>", {
        provider: "anthropic",
      }),
      quiet,
    ),
  ).toEqual({});
});
