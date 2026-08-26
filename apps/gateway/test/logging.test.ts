import { expect, test } from "bun:test";
import type { RequestLog, Store } from "@omni/store";
import { finishLog, newCompletedRequestLog, newPendingRequestLog } from "../src/logging.ts";
import type { Invalidator } from "../src/stream/broadcaster.ts";

/** A store that records appends, and can be told to fail one. */
function stubStore(opts: { failAppend?: boolean } = {}): { store: Store; appends: RequestLog[] } {
  const appends: RequestLog[] = [];
  const store = {
    usage: {
      async append(log: RequestLog) {
        if (opts.failAppend === true) throw new Error("disk full");
        appends.push(log);
      },
    },
  } as unknown as Store;
  return { store, appends };
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
