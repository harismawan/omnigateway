import { expect, test } from "bun:test";
import type { RequestCompleted } from "@omni/plugins";
import type { RequestLog, Store } from "@omni/store";
import { newCompletedRequestLog } from "../../src/logging.ts";
import { finishLog } from "../../src/logging.ts";

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

function log(over: Partial<RequestLog> = {}): RequestLog {
  return {
    ...newCompletedRequestLog("req_1", 1_000, { requestedModel: "fast", status: 200 }),
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-5",
    credentialId: "cred_secret",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    costUsd: 1.5,
    durationMs: 250,
    ...over,
  };
}

test("one finishLog is one event, carrying the narrowed payload", async () => {
  const { store } = stubStore();
  const events: RequestCompleted[] = [];

  await finishLog(store, log(), "key_1", undefined, undefined, undefined, (e) => events.push(e));

  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    requestId: "req_1",
    apiKeyId: "key_1",
    provider: "anthropic",
    model: "claude-opus-5",
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    costUsd: 1.5,
    durationMs: 250,
    ok: true,
    at: 1_000,
  });
});

test("the payload carries no credential id and no field beyond the contract", async () => {
  // Asserted as an exact key set rather than a subset. This payload crosses into
  // code authored outside the repository, so widening it is a security change —
  // and it should take a deliberate edit to this test, not an unnoticed spread.
  const { store } = stubStore();
  const events: RequestCompleted[] = [];

  await finishLog(store, log(), "key_1", undefined, undefined, undefined, (e) => events.push(e));

  const event = events[0];
  expect(event).toBeDefined();
  if (event === undefined) return;
  expect(Object.keys(event).sort()).toEqual([
    "apiKeyId",
    "at",
    "costUsd",
    "durationMs",
    "model",
    "ok",
    "provider",
    "requestId",
    "tokens",
  ]);
  expect(JSON.stringify(event)).not.toContain("cred_secret");
});

test("an unauthenticated request emits nothing", async () => {
  // Every consumer attributes to a key. A request that never authenticated has
  // nothing to attribute to, and inventing an attribution would be worse than
  // the gap.
  const { store } = stubStore();
  const events: RequestCompleted[] = [];

  await finishLog(store, log(), null, undefined, undefined, undefined, (e) => events.push(e));

  expect(events).toEqual([]);
});

test("a failed row still emits, because the request still happened", async () => {
  // The same reasoning the debit beside it is documented with: a key that spent
  // the tokens spent them, and a write that failed under load must not erase
  // that. `finishLog` never throws, so the emit has to survive the failure too.
  const { store, appends } = stubStore({ failAppend: true });
  const events: RequestCompleted[] = [];

  await finishLog(store, log(), "key_1", undefined, undefined, undefined, (e) => events.push(e));

  expect(appends).toEqual([]);
  expect(events).toHaveLength(1);
});

test("a failed request is reported as not ok, and falls back to the requested model", async () => {
  const { store } = stubStore();
  const events: RequestCompleted[] = [];

  await finishLog(
    store,
    log({ status: 502, errorCode: "UPSTREAM", resolvedProvider: null, resolvedModel: null }),
    "key_1",
    undefined,
    undefined,
    undefined,
    (e) => events.push(e),
  );

  expect(events[0]).toMatchObject({ ok: false, provider: null, model: "fast" });
});

test("a throwing emit does not turn a finished request into an error", async () => {
  // `finishLog` never throws — that is what keeps a logging failure from turning
  // a successful proxied request into one the client sees. A plugin emit is one
  // more thing that must not be able to.
  const { store, appends } = stubStore();

  await finishLog(store, log(), "key_1", undefined, undefined, undefined, () => {
    throw new Error("bus exploded");
  });

  expect(appends).toHaveLength(1);
});
