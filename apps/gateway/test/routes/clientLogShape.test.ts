import { expect, test } from "bun:test";
import { toClientLog } from "@omni/control";
import { requestLog } from "@omni/testkit";

/**
 * The client log projection, pinned to the shape the console mirrors.
 *
 * `toClientLog` enumerates what a key holder may see. The dashboard cannot
 * import `@omni/control`, so `ClientRequestLog` in `apps/dashboard/src/api/
 * types.ts` is a hand-kept copy, and this file is what keeps the two honest —
 * the same job `limitVocabulary.test.ts` does for the plugin API's limit
 * vocabulary, in the same place, because `apps/gateway` is where both sides are
 * reachable.
 *
 * Direction matters: `toClientLog` is the source of truth. A failure here means
 * the projection gained or lost a column and the console's copy is stale; the
 * fix is to update the console, never to edit the projection to match it.
 *
 * TypeScript will not catch this drift on its own. The console's fetch is an
 * unchecked cast, so the type is the only statement of what arrives — and it was
 * wrong once: the row was typed as the operator's `RequestLog`, a shared
 * component read `rtkFilters` off it, and the client's detail modal threw on
 * every open while every test stayed green because the fixture was a full
 * operator row.
 */
const CLIENT_LOG_FIELDS = [
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
] as const;

test("the client log projection carries exactly the columns the console mirrors", () => {
  const projected = toClientLog(requestLog({ id: "req-1" }));

  expect(Object.keys(projected).sort()).toEqual([...CLIENT_LOG_FIELDS]);
});

/**
 * The columns the operator's row has and the client's must not.
 *
 * Asserted separately from the list above, because a projection built by
 * *removing* keys would satisfy that list today and hand over every column
 * added to `RequestLog` tomorrow — which is the shape `toClientLog`'s own
 * docblock rejects.
 */
test("the operator's identity and RTK accounting stay off the client row", () => {
  const projected = toClientLog(requestLog({ id: "req-1" })) as Record<string, unknown>;

  for (const field of [
    "apiKeyId",
    "credentialId",
    "rtkFilters",
    "rtkFilterHits",
    "rtkOriginalCodeUnits",
    "rtkCompressedCodeUnits",
  ]) {
    expect({ field, present: field in projected }).toEqual({ field, present: false });
  }
});
