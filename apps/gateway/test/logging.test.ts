import { expect, test } from "bun:test";
import { newCompletedRequestLog, newPendingRequestLog } from "../src/logging.ts";

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
