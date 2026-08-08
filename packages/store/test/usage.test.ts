import { expect, test } from "bun:test";
import { deriveKey } from "../src/encryption.ts";
import { openDb } from "../src/sqlite/db.ts";
import { backfillDaily, startOfLocalDay } from "../src/sqlite/rollup.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { RequestLog, Store } from "../src/types.ts";

const DAY_MS = 86_400_000;

async function store(): Promise<Store> {
  return createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
}

function log(patch: Partial<RequestLog> & { id: string; at: number }): RequestLog {
  return {
    apiKeyId: "k1",
    requestedModel: "fast",
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    ttftMs: 300,
    durationMs: 1200,
    costUsd: 0.005,
    degradations: [],
    ...patch,
  };
}

/** Noon, so a test's arithmetic never straddles a local midnight by accident. */
function noon(daysAgo: number): number {
  return startOfLocalDay(Date.now() - daysAgo * DAY_MS) + 12 * 3_600_000;
}

test("appending a log rolls it into the day it happened on", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(0) }));
  await s.usage.append(log({ id: "r2", at: noon(0) + 60_000, status: 500 }));
  await s.usage.append(log({ id: "r3", at: noon(1) }));

  const days = await s.usage.aggregate({ since: noon(3), grain: "daily", groupBy: "day" });
  const today = days.find((row) => row.key === String(startOfLocalDay(noon(0))));
  expect(today?.requests).toBe(2);
  expect(today?.errors).toBe(1);
  expect(today?.inputTokens).toBe(200);
  expect(today?.cacheReadTokens).toBe(40);
  expect(today?.durationMsSum).toBe(2400);
  expect(days.find((row) => row.key === String(startOfLocalDay(noon(1))))?.requests).toBe(1);
  s.close();
});

test("the rollup outlives the raw logs it summarizes", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(200) }));

  expect(await s.usage.prune(Date.now() - 30 * DAY_MS)).toBe(1);
  expect(await s.usage.recent(10)).toHaveLength(0);

  const days = await s.usage.aggregate({ since: noon(365), grain: "daily", groupBy: "day" });
  expect(days).toHaveLength(1);
  expect(days[0]?.requests).toBe(1);
  s.close();
});

test("pruneDaily drops rollup rows past its own, longer horizon", async () => {
  const s = await store();
  await s.usage.append(log({ id: "old", at: noon(401) }));
  await s.usage.append(log({ id: "new", at: noon(1) }));

  expect(await s.usage.pruneDaily(Date.now() - 400 * DAY_MS)).toBe(1);
  const days = await s.usage.aggregate({ since: noon(500), grain: "daily", groupBy: "day" });
  expect(days).toHaveLength(1);
  expect(days[0]?.key).toBe(String(startOfLocalDay(noon(1))));
  s.close();
});

test("a daily window includes the whole of its first, partial day", async () => {
  const s = await store();
  const at = startOfLocalDay(Date.now()) + 3_600_000;
  await s.usage.append(log({ id: "r1", at }));

  // Asking from mid-morning still reports the request logged at 01:00.
  const days = await s.usage.aggregate({
    since: at + 8 * 3_600_000,
    grain: "daily",
    groupBy: "day",
  });
  expect(days[0]?.requests).toBe(1);
  s.close();
});

test("both grains group by provider and by the model the client asked for", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(0) }));
  await s.usage.append(
    log({
      id: "r2",
      at: noon(0),
      resolvedProvider: "openai",
      resolvedModel: "gpt-5",
      requestedModel: "cheap",
    }),
  );

  for (const grain of ["raw", "daily"] as const) {
    const providers = await s.usage.aggregate({ since: noon(2), grain, groupBy: "provider" });
    expect(providers.map((row) => row.key).sort()).toEqual(["anthropic", "openai"]);

    const requested = await s.usage.aggregate({
      since: noon(2),
      grain,
      groupBy: "requestedModel",
    });
    expect(requested.map((row) => row.key).sort()).toEqual(["cheap", "fast"]);
  }
  s.close();
});

test("splitBy yields one bucket per pair, which is what stacks a time series", async () => {
  const s = await store();
  await s.usage.append(log({ id: "r1", at: noon(0) }));
  await s.usage.append(log({ id: "r2", at: noon(0), resolvedProvider: "openai" }));
  await s.usage.append(log({ id: "r3", at: noon(1) }));

  const rows = await s.usage.aggregate({
    since: noon(3),
    grain: "daily",
    groupBy: "day",
    splitBy: "provider",
  });
  const today = String(startOfLocalDay(noon(0)));
  expect(rows.filter((row) => row.key === today)).toHaveLength(2);
  expect(rows.find((row) => row.key === today && row.split === "openai")?.requests).toBe(1);
  expect(rows.every((row) => row.split !== undefined)).toBe(true);
  s.close();
});

test("a request with no credential or key is bucketed, not dropped", async () => {
  const s = await store();
  await s.usage.append(
    log({
      id: "r1",
      at: noon(0),
      apiKeyId: null,
      credentialId: null,
      resolvedProvider: null,
      resolvedModel: null,
      status: 401,
    }),
  );

  const keys = await s.usage.aggregate({ since: noon(2), grain: "daily", groupBy: "apiKey" });
  expect(keys).toEqual([expect.objectContaining({ key: "unknown", requests: 1, errors: 1 })]);
  s.close();
});

test("a grain cannot be asked for a dimension it does not carry", async () => {
  const s = await store();
  await expect(s.usage.aggregate({ since: 0, grain: "daily", groupBy: "hour" })).rejects.toThrow(
    "cannot group by hour",
  );
  await expect(s.usage.aggregate({ since: 0, grain: "raw", groupBy: "day" })).rejects.toThrow(
    "cannot group by day",
  );
  s.close();
});

test("the migration seeds the rollup from logs already on disk", () => {
  const db = openDb(":memory:");
  const at = startOfLocalDay(Date.now()) + 3_600_000;
  for (const [id, status] of [
    ["r1", 200],
    ["r2", 200],
    ["r3", 500],
  ] as const) {
    db.run(
      `INSERT INTO request_logs
         (id, at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
          attempts, status, error_code, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, ttft_ms, duration_ms, cost_usd, degradations)
       VALUES (?,?,'k1','fast','anthropic','claude-opus-4','c1',1,?,NULL,10,5,0,0,NULL,100,0.01,'[]')`,
      [id, at, status],
    );
  }
  db.run("DELETE FROM usage_daily");

  expect(backfillDaily(db)).toBe(1);
  const row = db
    .query<{ day: number; requests: number; errors: number; input_tokens: number }, []>(
      "SELECT day, requests, errors, input_tokens FROM usage_daily",
    )
    .get();
  expect(row?.day).toBe(startOfLocalDay(at));
  expect(row?.requests).toBe(3);
  expect(row?.errors).toBe(1);
  expect(row?.input_tokens).toBe(30);
  db.close();
});
