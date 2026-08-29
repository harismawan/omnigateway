import { expect, test } from "bun:test";
import type { AccountQuota, AccountQuotaSample, ClientRequestLog } from "../../src/api/types.ts";

/**
 * The console's half of three hand-kept mirrors.
 *
 * `ClientRequestLog`, `AccountQuota` and `AccountQuotaSample` are declared in
 * `@omni/control`, which the dashboard may not import, so each exists twice.
 * The control side of all three is pinned by key-set assertions in that
 * package's own tests; `apps/gateway/test/routes/clientLogShape.test.ts` pins
 * the projection against the list below. This file is the missing hop — without
 * it, three copies existed and only two were held to each other, so a column
 * added on the server could be mirrored wrongly here and nothing would say so.
 *
 * A `Record<keyof T, true>` rather than a runtime sample: it is the type itself
 * being checked, so a field added to the mirror without a line here is a
 * compile error, and a line here without the field is one too. The literals are
 * the same lists the two server-side tests assert against — a reader comparing
 * them is diffing two sorted arrays, which is the point of writing them out.
 */
const CLIENT_REQUEST_LOG: Record<keyof ClientRequestLog, true> = {
  at: true,
  attempts: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  costUsd: true,
  degradations: true,
  durationMs: true,
  errorCode: true,
  id: true,
  inputTokens: true,
  outputTokens: true,
  requestedModel: true,
  resolvedModel: true,
  resolvedProvider: true,
  rtkApplied: true,
  rtkEstimatedTokensSaved: true,
  state: true,
  status: true,
  ttftMs: true,
};

const ACCOUNT_QUOTA: Record<keyof AccountQuota, true> = {
  credentialId: true,
  exhaustsAt: true,
  label: true,
  observedAt: true,
  provider: true,
  ratePerHourRatio: true,
  resetsAt: true,
  rolledOver: true,
  stale: true,
  survives: true,
  usedRatio: true,
  windowMs: true,
  windowType: true,
};

const ACCOUNT_QUOTA_SAMPLE: Record<keyof AccountQuotaSample, true> = {
  credentialId: true,
  label: true,
  observedAt: true,
  provider: true,
  resetsAt: true,
  usedRatio: true,
  windowMs: true,
  windowType: true,
};

test("the console's client log mirror matches the projection's field list", () => {
  // The same list `clientLogShape.test.ts` asserts `toClientLog` produces.
  expect(Object.keys(CLIENT_REQUEST_LOG).sort()).toEqual([
    "at",
    "attempts",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd",
    "degradations",
    "durationMs",
    "errorCode",
    "id",
    "inputTokens",
    "outputTokens",
    "requestedModel",
    "resolvedModel",
    "resolvedProvider",
    "rtkApplied",
    "rtkEstimatedTokensSaved",
    "state",
    "status",
    "ttftMs",
  ]);
});

test("the console's quota mirrors match what @omni/control publishes", () => {
  // The lists `headroom.test.ts` and `clientHistory.test.ts` assert on their
  // own payloads, kept here as strings so a server-side change that this file
  // was not updated for fails rather than passing quietly.
  expect(Object.keys(ACCOUNT_QUOTA).sort().join(",")).toBe(
    "credentialId,exhaustsAt,label,observedAt,provider,ratePerHourRatio,resetsAt,rolledOver,stale,survives,usedRatio,windowMs,windowType",
  );
  expect(Object.keys(ACCOUNT_QUOTA_SAMPLE).sort().join(",")).toBe(
    "credentialId,label,observedAt,provider,resetsAt,usedRatio,windowMs,windowType",
  );
});
