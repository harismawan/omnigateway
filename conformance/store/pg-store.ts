#!/usr/bin/env bun
/**
 * The frozen TS Postgres store, driven from JSON, for the Rust cross-read
 * tests: `write` fills a database through the store's own repositories, and
 * `read` reports what the store's own repositories read back, so either side
 * can be compared against the other.
 *
 *   echo '{"url":"postgres://…","op":"write"|"read", ...}' | bun conformance/store/pg-store.ts
 *
 * The encryption key is `secret`, derived with the store's `deriveKey`.
 */
import { deriveKey } from "../../packages/store/src/encryption.ts";
import { createPostgresStore } from "../../packages/store/src/postgres/store.ts";

type Input = {
  url: string;
  op: "write" | "read";
  secret: string;
  dayOffsetMinutes: number;
  /** `read`: sliding sums and seed reads to answer. */
  sums?: Array<{ key: string; since: number; model?: string }>;
  buckets?: Array<{ key: string; since: number; grain: number; model?: string }>;
  bodies?: string[];
  /** `write`: what to put. */
  credentials?: Array<Record<string, unknown>>;
  keys?: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  health?: Array<Record<string, unknown>>;
  quota?: Array<Record<string, unknown>>;
  logs?: Array<Record<string, unknown>>;
  body?: Array<Record<string, unknown>>;
};

const input = JSON.parse(await Bun.stdin.text()) as Input;
const store = await createPostgresStore({
  url: input.url,
  encryptionKey: await deriveKey(input.secret),
  nodeId: "node-ts",
  dayOffsetMinutes: input.dayOffsetMinutes,
});

try {
  if (input.op === "write") {
    for (const c of input.credentials ?? []) await store.credentials.create(c as never);
    for (const k of input.keys ?? []) await store.keys.create(k as never);
    for (const m of input.models ?? []) await store.config.putModel(m as never);
    if (input.settings !== undefined) await store.config.putSettings(input.settings as never);
    for (const h of input.health ?? []) {
      const row = h as { credentialId: string; model: string };
      await store.credentials.updateHealth(row.credentialId, row.model, () => h as never);
    }
    if (input.quota !== undefined) await store.credentials.saveQuota(input.quota as never);
    for (const l of input.logs ?? []) await store.usage.append(l as never);
    for (const b of input.body ?? []) await store.bodies.put(b as never);
    console.log(JSON.stringify({ ok: true }));
  } else {
    const credentials = [];
    for (const c of await store.credentials.list()) {
      const { secrets, openForInference, openForRefresh, openForUsage, ...meta } = c;
      credentials.push({ ...meta, secrets: await secrets() });
    }
    const sums = [];
    for (const q of input.sums ?? []) {
      sums.push(await store.usage.sumSince(q.key, q.since, q.model));
    }
    const buckets = [];
    for (const q of input.buckets ?? []) {
      buckets.push(
        (await store.usage.sumBuckets(q.key, q.since, q.grain, q.model)).sort(
          (a, b) => a[0] - b[0],
        ),
      );
    }
    const bodies = [];
    for (const id of input.bodies ?? []) {
      const read = await store.bodies.get(id);
      bodies.push(read);
    }
    console.log(
      JSON.stringify({
        keys: await store.keys.list(),
        credentials,
        health: await store.credentials.listHealth(),
        quota: await store.credentials.listQuota(),
        models: await store.config.listModels(),
        settings: await store.config.getSettings(),
        recent: await store.usage.recent(1000),
        audit: await store.usage.auditRollup(),
        sums,
        buckets,
        bodies,
        version: store.routing.version(),
      }),
    );
  }
} finally {
  store.close();
}
