import { expect, test } from "bun:test";
import { requestLog } from "@omni/testkit";
import { isClientVisibleDegradation, toClientLog } from "../src/clientLog.ts";

const CRED = "cred-7f3a-secret";

/**
 * The leak this projection exists for.
 *
 * `/api/client/logs` returned `RequestLog` rows verbatim for one commit. The
 * row names the account that served the request, so a key holder could read the
 * operator's credential ids off their own traffic — while `providerHeadroom`,
 * three files away, was carefully stripping the same ids from quota. Two
 * surfaces, one fact, and only one of them was guarded.
 */
test("no credential id survives, from either place it hides", () => {
  const projected = toClientLog(
    requestLog({
      id: "r1",
      credentialId: CRED,
      apiKeyId: "key-1",
      degradations: [`excluded:${CRED}:disabled`, "anthropic:context-1m-dropped"],
    }),
  );

  const payload = JSON.stringify(projected);
  // Asserted on the serialized payload, because that is what reaches the wire —
  // a key absent from the type but present on the object would pass a
  // property check and still ship.
  expect(payload).not.toContain(CRED);
  expect(payload).not.toContain("credentialId");
  expect(Object.keys(projected)).not.toContain("credentialId");
});

/**
 * Every `excluded:*` line goes, rather than being parsed to remove the id.
 *
 * `reason` is an open string that may contain a colon, and dispatch writes both
 * `excluded:<id>:<reason>` and `excluded:<reason>` down the same column, so no
 * parse is right for both shapes: splitting on the second colon turned
 * `excluded:capability:anthropicTools` into `excluded:anthropicTools`, which is
 * how this test found the first attempt at a redaction. The ambiguity is in the
 * stored format, so the safe reading is to drop the line.
 */
test("every excluded line is dropped, whichever shape it was written in", () => {
  expect(isClientVisibleDegradation(`excluded:${CRED}:disabled`)).toBe(false);
  expect(isClientVisibleDegradation(`excluded:${CRED}:quota:spent`)).toBe(false);
  // The id-less shape too: it is operator routing diagnostics either way.
  expect(isClientVisibleDegradation("excluded:capability:anthropicTools")).toBe(false);
});

test("a degradation about the client's own request is kept", () => {
  // These name a capability rather than an account, and they are the honest
  // answer to "what happened to what I sent".
  for (const entry of [
    "anthropic:context-1m-dropped",
    "anthropic:cache-breakpoint-added",
    "anthropic:history-cache-breakpoint-added",
    "openai:reasoning-effort-dropped",
  ]) {
    expect(isClientVisibleDegradation(entry)).toBe(true);
  }
});

/**
 * The projection enumerates its fields rather than deleting three from a copy.
 *
 * A column added to `RequestLog` later must be absent here until somebody
 * decides it belongs. This asserts the shape exactly, so adding a field to the
 * store and expecting it to appear on the client surface fails loudly.
 */
test("the client shape is an allowlist, so a new store column does not ship by default", () => {
  const projected = toClientLog(requestLog({ id: "r1" }));
  expect(Object.keys(projected).sort()).toEqual(
    [
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
      "sessionId",
      "turnId",
      "agent",
      "tags",
      "traceMetadata",
      "clientRequestId",
    ].sort(),
  );
});

test("what the client is entitled to is still there", () => {
  const projected = toClientLog(
    requestLog({ id: "r1", status: 200, costUsd: 0.25, requestedModel: "fast" }),
  );
  expect(projected.id).toBe("r1");
  expect(projected.status).toBe(200);
  expect(projected.costUsd).toBeCloseTo(0.25, 10);
  expect(projected.requestedModel).toBe("fast");
  // The provider, yes; the account, no.
  expect(projected.resolvedProvider).toBe("anthropic");
});

/**
 * The caller supplied its trace, so it reads it back. The provider's request id
 * names a request on the operator's account and stays operator-only.
 */
test("trace fields the caller sent are kept; the upstream request id is not", () => {
  const UPSTREAM = "req_upstream_secret_42";
  const projected = toClientLog(
    requestLog({
      id: "r1",
      sessionId: "claude-code:s1",
      turnId: "t1",
      agent: "claude-code",
      tags: ["team-a"],
      traceMetadata: { owner: "ops" },
      clientRequestId: "cli-1",
      upstreamRequestId: UPSTREAM,
    }),
  );
  expect(projected).toMatchObject({
    sessionId: "claude-code:s1",
    turnId: "t1",
    agent: "claude-code",
    tags: ["team-a"],
    traceMetadata: { owner: "ops" },
    clientRequestId: "cli-1",
  });
  expect(JSON.stringify(projected)).not.toContain(UPSTREAM);
});
