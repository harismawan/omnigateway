import { expect, test } from "bun:test";
import { SQL } from "bun";
import { deriveKey } from "../src/encryption.ts";
import { createPostgresStore } from "../src/postgres/store.ts";
import { NARROWED_SQL } from "../src/postgres/usage.ts";

/**
 * Which index the Postgres planner opens for the per-model long-window reads.
 *
 * The SQLite copy of this lives in `migrations.test.ts`. Here a handful of rows
 * would always plan as a sequential scan, so sequential scans are switched off
 * for the session: the question is not whether an index beats reading eight
 * rows, but which index answers the narrowed predicate when one is used — and
 * the answer must seek on the model, not filter it per row off
 * `idx_request_logs_key_at`. Measured at 500,000 rows the planner chose this
 * index unprompted (bitmap or plain index scan); the switch only makes the
 * small fixture say the same.
 */
const url = process.env.OMNI_TEST_DATABASE_URL;

if (url === undefined || url === "") {
  test.skip("postgres: OMNI_TEST_DATABASE_URL unset, Postgres plan test not run", () => {});
} else {
  test("the narrowed reads seek idx_request_logs_key_model_at on Postgres", async () => {
    const admin = new SQL({ url, max: 1 });
    await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await admin.close();
    const store = await createPostgresStore({
      url,
      encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
    });
    const sql = new SQL({ url, max: 1 });
    try {
      const [index] = await sql.unsafe<Array<{ indexdef: string }>>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_request_logs_key_model_at'",
      );
      expect(index?.indexdef).toContain("(api_key_id, requested_model, at)");

      await sql.unsafe("SET enable_seqscan = off");
      // The store's own statements, not copies: a copy keeps passing when the
      // real query is edited into one the index cannot serve — e.g.
      // `(requested_model || '') = $4` returns the same rows and is no seek.
      for (const [query, args] of [
        [NARROWED_SQL.sumSince, ["k1", "opus", 0]],
        [NARROWED_SQL.sumBuckets, [60_000, 60_000, "k1", "opus", 0]],
        [NARROWED_SQL.oldestSince, ["k1", "opus", 0]],
      ] as const) {
        const plan = (
          await sql.unsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN ${query}`, [...args])
        )
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(plan).toContain("idx_request_logs_key_model_at");
        expect(plan).toMatch(/Index Cond: .*requested_model = /);
      }
    } finally {
      await sql.close();
      store.close();
    }
  });
}
