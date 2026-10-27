import { expect, test } from "bun:test";
import { SQL } from "bun";
import { deriveKey } from "../src/encryption.ts";
import bodyState011 from "../src/postgres/migrations/011_body_state.sql" with { type: "text" };
import bodyStateIndex012 from "../src/postgres/migrations/012_body_state_index.sql" with {
  type: "text",
};
import { createPostgresStore } from "../src/postgres/store.ts";

/**
 * The body-state column and its index are two migrations on Postgres, so each
 * commits on its own, and this watches the locks that buys.
 *
 * The runner applies a migration in one transaction. `ADD COLUMN` takes ACCESS
 * EXCLUSIVE — no reads, no writes — but is metadata-only and commits at once on
 * its own. A non-concurrent `CREATE INDEX` scans the table, and alone it holds
 * only SHARE: reads go on, writes wait for the scan. In one transaction the
 * index's scan would run under the column's ACCESS EXCLUSIVE, refusing even
 * reads of `request_logs` for the length of it.
 *
 * Asserted by running each file's own SQL in an open transaction on one
 * connection and asking from a second, under a short `lock_timeout`, what it
 * may still do.
 */
const url = process.env.OMNI_TEST_DATABASE_URL;

if (url === undefined || url === "") {
  test.skip("postgres: OMNI_TEST_DATABASE_URL unset, Postgres migration lock test not run", () => {});
} else {
  test("011 adds the column alone and 012 builds the index alone, under SHARE", async () => {
    // The statements, not the headers that explain them.
    const code = (sql: string): string =>
      sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
    expect(code(bodyState011)).not.toMatch(/CREATE\s+INDEX/i);
    expect(code(bodyState011)).toMatch(/ADD COLUMN body_state/i);
    expect(code(bodyStateIndex012)).toMatch(/CREATE INDEX idx_request_logs_body_pending/i);
    expect(code(bodyStateIndex012)).not.toMatch(/ALTER\s+TABLE/i);

    const admin = new SQL({ url, max: 1 });
    await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await admin.close();
    const store = await createPostgresStore({
      url,
      encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
    });
    store.close();

    const holder = new SQL({ url, max: 1 });
    const other = new SQL({ url, max: 1 });
    // Fails rather than waits when the lock it needs is held, and keeps nothing.
    const attempt = async (statement: string): Promise<"ran" | "blocked"> => {
      await other.unsafe("BEGIN");
      try {
        await other.unsafe("SET LOCAL lock_timeout = '300ms'");
        await other.unsafe(statement);
        return "ran";
      } catch (error) {
        if (/lock timeout/i.test(String(error))) return "blocked";
        throw error;
      } finally {
        await other.unsafe("ROLLBACK");
      }
    };
    const read = "SELECT count(*) FROM request_logs";
    const write = `INSERT INTO request_logs (id, state, node_id, at, requested_model, attempts, status,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms,
        cost_usd, degradations, rtk_applied, rtk_filter_hits, rtk_original_code_units,
        rtk_compressed_code_units, rtk_estimated_tokens_saved, rtk_filters)
      VALUES ('w', 'done', 'n', 1, 'm', 1, 200, 0, 0, 0, 0, 0, 0, '[]', false, 0, 0, 0, 0, '[]')`;
    try {
      await holder.unsafe(
        "DROP INDEX idx_request_logs_body_pending; ALTER TABLE request_logs DROP COLUMN body_state",
      );

      // The column, mid-transaction: nothing gets in, which is why it commits alone.
      await holder.unsafe("BEGIN");
      await holder.unsafe(bodyState011);
      expect(await attempt(read)).toBe("blocked");
      await holder.unsafe("COMMIT");

      // The index, mid-transaction: reads go on, writes wait for its scan.
      await holder.unsafe("BEGIN");
      await holder.unsafe(bodyStateIndex012);
      expect(await attempt(read)).toBe("ran");
      expect(await attempt(write)).toBe("blocked");
      await holder.unsafe("COMMIT");
    } finally {
      await holder.close();
      await other.close();
    }
  });

  test("both are recorded, in order, on a fresh database", async () => {
    const admin = new SQL({ url, max: 1 });
    await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const store = await createPostgresStore({
      url,
      encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
    });
    try {
      const ids: { id: number }[] = await admin.unsafe("SELECT id FROM migrations ORDER BY id");
      expect(ids.map((r) => r.id).slice(-3)).toEqual([11, 12, 13]);
    } finally {
      store.close();
      await admin.close();
    }
  });
}
