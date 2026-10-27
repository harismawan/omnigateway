import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  bodiesDirFor,
  prepareArtifact,
  relPathFor,
  sealArtifact,
  writeArtifact,
} from "../../src/bodies/artifact.ts";
import { deriveKey } from "../../src/encryption.ts";
import {
  createPostgresExportReader,
  type ExportReader,
  openSqliteExportReader,
} from "../../src/exportReader.ts";
import type { BodyPublication, BodyState, NewRequestLog, Store } from "../../src/types.ts";
import { type Backend, exec, forEachStore, logRow } from "./harness.ts";

/**
 * `request_logs.body_state`: whether a request's body made it to the store,
 * written beside the pointer that says where it is. Design:
 * docs/superpowers/specs/2026-10-24-log-export-design.md (*Capture state on
 * the row*).
 */
const SECRET = "test-secret-value-for-unit-tests";
const AT = Date.UTC(2026, 9, 26, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/**
 * What the body writer does before it asks the main thread to publish: the
 * sealed bytes land where the backend keeps them — the final file on SQLite,
 * the `bytea` row on Postgres through `writeRow` — and then `publish` runs.
 */
async function land(
  backend: Pick<Backend, "name">,
  s: Store,
  requestId: string,
  omitted = false,
): Promise<{ published: boolean; row: BodyPublication }> {
  const prepared = prepareArtifact({
    schemaVersion: 1,
    requestId,
    at: AT,
    client: { request: { prompt: "hi" }, response: { text: "hello" }, truncated: false },
    attempts: [],
    error: null,
  });
  const sealed = await sealArtifact(await deriveKey(SECRET), prepared.json);
  const row: BodyPublication = {
    requestId,
    at: AT,
    relPath: relPathFor(requestId, AT),
    sizeBytes: sealed.bytes.length,
    sha256: sealed.sha256,
    truncated: false,
    omitted,
  };
  if (backend.name === "postgres") await s.bodies.writeRow({ ...row, bytes: sealed.bytes });
  else await writeArtifact(bodiesDirFor(s.databasePath), row.relPath, sealed.bytes);
  return { published: await s.bodies.publish(row), row };
}

const pending = (id: string) =>
  logRow({ id, at: AT, state: "pending", status: 0, bodyState: "pending" });

const stateOf = async (s: Store, id: string) => (await s.usage.get(id))?.bodyState;

forEachStore((backend) => {
  test("a row begun without capture has no body state; one begun with it is pending", async () => {
    const s = await backend.fresh();
    await s.usage.begin(logRow({ id: "plain", at: AT, state: "pending", status: 0 }));
    await s.usage.begin(pending("captured"));
    expect(await stateOf(s, "plain")).toBeNull();
    expect(await stateOf(s, "captured")).toBe("pending");

    // Completion keeps what began.
    await s.usage.append(logRow({ id: "plain", at: AT }));
    await s.usage.append(logRow({ id: "captured", at: AT }));
    expect(await stateOf(s, "plain")).toBeNull();
    expect(await stateOf(s, "captured")).toBe("pending");
    // And every read carries it, the export cursor's included.
    const rows = await s.usage.exportPage({
      after: { completedAt: 0, id: "" },
      settledBefore: Number.MAX_SAFE_INTEGER,
      limit: 10,
    });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.bodyState]))).toEqual({
      plain: null,
      captured: "pending",
    });
    expect((await s.usage.recent(10)).map((r) => r.bodyState).sort()).toEqual([null, "pending"]);
  });

  // The type refuses these (`bodyStateTypes.test.ts`); this is the run-time
  // half, for a caller that got past it — a cast, or plain JavaScript.
  test("a write can only ask for pending: a terminal state on input is ignored", async () => {
    const s = await backend.fresh();
    const smuggled = (id: string, state: BodyState, over: Partial<NewRequestLog> = {}) =>
      ({ ...logRow({ id, at: AT, ...over }), bodyState: state }) as unknown as NewRequestLog;
    for (const state of ["ready", "omitted", "failed"] as const) {
      await s.usage.begin(smuggled(`b-${state}`, state, { state: "pending" }));
      await s.usage.append(smuggled(`a-${state}`, state));
      expect(await stateOf(s, `b-${state}`)).toBeNull();
      expect(await stateOf(s, `a-${state}`)).toBeNull();
    }
  });

  test("append sets pending only on a row that has none, and never overwrites a later state", async () => {
    const s = await backend.fresh();
    // Failed before routing: no `begin`, so the completing write is the first.
    await s.usage.append(logRow({ id: "unbegun", at: AT, status: 400, bodyState: "pending" }));
    expect(await stateOf(s, "unbegun")).toBe("pending");

    // Began without it, completed with it.
    await s.usage.begin(logRow({ id: "late", at: AT, state: "pending", status: 0 }));
    await s.usage.append(logRow({ id: "late", at: AT, bodyState: "pending" }));
    expect(await stateOf(s, "late")).toBe("pending");

    // Began with it, completed by a log that does not carry it.
    await s.usage.begin(pending("kept"));
    await s.usage.append(logRow({ id: "kept", at: AT }));
    expect(await stateOf(s, "kept")).toBe("pending");

    // The body landed while the request was still in flight; its completion
    // must not put it back to pending.
    await s.usage.begin(pending("early"));
    expect((await land(backend, s, "early")).published).toBe(true);
    await s.usage.append(logRow({ id: "early", at: AT, bodyState: "pending" }));
    expect(await stateOf(s, "early")).toBe("ready");
    expect((await s.usage.get("early"))?.state).toBe("done");
  });

  test("publish moves pending to ready or omitted and leaves a readable pointer", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "r-ready", at: AT, bodyState: "pending" }));
    await s.usage.append(logRow({ id: "r-omitted", at: AT, bodyState: "pending" }));

    const ready = await land(backend, s, "r-ready");
    const omitted = await land(backend, s, "r-omitted", true);
    expect(ready.published).toBe(true);
    expect(omitted.published).toBe(true);
    expect(await stateOf(s, "r-ready")).toBe("ready");
    expect(await stateOf(s, "r-omitted")).toBe("omitted");

    const read = await s.bodies.get("r-ready");
    expect(read?.row).toEqual({
      requestId: "r-ready",
      at: AT,
      relPath: ready.row.relPath,
      sizeBytes: ready.row.sizeBytes,
      sha256: ready.row.sha256,
      detailState: "ready",
      truncated: false,
    });
    expect(read?.artifact?.client.request).toEqual({ prompt: "hi" });
    expect((await s.bodies.get("r-omitted"))?.row.detailState).toBe("ready");
  });

  test("publish on a row that is not pending writes nothing and returns false", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "never", at: AT }));
    await s.usage.append(logRow({ id: "failed", at: AT, bodyState: "pending" }));
    await s.bodies.fail("failed");

    for (const id of ["never", "failed", "absent"]) {
      expect(`${id}: ${(await land(backend, s, id)).published}`).toBe(`${id}: false`);
      expect(await s.bodies.get(id)).toBeNull();
    }
    expect(await stateOf(s, "never")).toBeNull();
    expect(await stateOf(s, "failed")).toBe("failed");
    expect(await s.usage.get("absent")).toBeNull();
  });

  test("a second publish for a published row is refused and changes no state", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "twice", at: AT, bodyState: "pending" }));
    const first = await land(backend, s, "twice");
    expect(first.published).toBe(true);
    expect((await land(backend, s, "twice", true)).published).toBe(false);
    expect(await stateOf(s, "twice")).toBe("ready");
    if (backend.name === "sqlite") {
      // The refused publication wrote no pointer: the row still names the first.
      expect((await s.bodies.get("twice"))?.row.sha256).toBe(first.row.sha256);
    } else {
      // The refusal removes only what no published state protects: the body a
      // `ready` row points at is still there to read.
      expect((await s.bodies.get("twice"))?.row.detailState).toBe("ready");
      expect((await s.bodies.get("twice"))?.row.sha256).toBe(first.row.sha256);
    }
  });

  test("fail moves pending to failed and leaves every other state alone", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "p", at: AT, bodyState: "pending" }));
    await s.usage.append(logRow({ id: "r", at: AT, bodyState: "pending" }));
    await s.usage.append(logRow({ id: "n", at: AT }));
    await land(backend, s, "r");

    await s.bodies.fail("p");
    await s.bodies.fail("r");
    await s.bodies.fail("n");
    await s.bodies.fail("absent");
    expect(await stateOf(s, "p")).toBe("failed");
    expect(await stateOf(s, "r")).toBe("ready");
    expect(await stateOf(s, "n")).toBeNull();
    // A failed body is not pending, so a late acknowledgement cannot land.
    expect((await land(backend, s, "p")).published).toBe(false);
  });

  test("sweepPending fails bodies still pending an hour after completion, and only those", async () => {
    const s = await backend.fresh("node-a");
    const now = Date.now();
    await s.usage.append(logRow({ id: "stale", at: AT, bodyState: "pending" }));
    await s.usage.append(logRow({ id: "fresh", at: AT, bodyState: "pending" }));
    await s.usage.append(logRow({ id: "done-ready", at: AT, bodyState: "pending" }));
    await s.usage.append(logRow({ id: "uncaptured", at: AT }));
    await land(backend, s, "done-ready");
    // Two hours ago by either clock: far enough that the database clock on
    // Postgres and this process's agree about which side of the hour it is.
    await exec(
      backend,
      s,
      `UPDATE request_logs SET completed_at = ${now - 2 * HOUR}
        WHERE id IN ('stale', 'done-ready', 'uncaptured')`,
    );
    // In flight, own node: the sweep retires it as interrupted, stamping its
    // completion now, so its body has another hour.
    await s.usage.begin(pending("inflight"));

    expect(await s.usage.sweepPending(now)).toBe(1);
    expect(await stateOf(s, "stale")).toBe("failed");
    expect(await stateOf(s, "fresh")).toBe("pending");
    expect(await stateOf(s, "done-ready")).toBe("ready");
    expect(await stateOf(s, "uncaptured")).toBeNull();
    const inflight = await s.usage.get("inflight");
    expect(inflight?.errorCode).toBe("interrupted");
    expect(inflight?.bodyState).toBe("pending");
  });

  if (backend.name === "sqlite") {
    test("sqlite: the hour is measured on the clock sweepPending is handed", async () => {
      const s = await backend.fresh();
      const T = 1_800_000_000_000;
      await s.usage.append(logRow({ id: "at-hour", at: AT, bodyState: "pending" }));
      await s.usage.append(logRow({ id: "under", at: AT, bodyState: "pending" }));
      await exec(
        backend,
        s,
        `UPDATE request_logs SET completed_at = ${T - HOUR} WHERE id = 'at-hour'`,
        `UPDATE request_logs SET completed_at = ${T - HOUR + 1} WHERE id = 'under'`,
      );
      await s.usage.sweepPending(T);
      expect(await stateOf(s, "at-hour")).toBe("failed");
      expect(await stateOf(s, "under")).toBe("pending");
    });

    /**
     * The pointer upsert and the state update are one transaction: a pointer
     * row whose state never moved would be a body the export waits on forever,
     * and a state that moved with no pointer one it reads as never captured.
     */
    test("sqlite: publish is one transaction — a failing pointer write leaves the state pending", async () => {
      const s = await backend.fresh();
      await s.usage.append(logRow({ id: "atomic", at: AT, bodyState: "pending" }));
      await exec(
        backend,
        s,
        `CREATE TRIGGER refuse_bodies BEFORE INSERT ON request_bodies
         BEGIN SELECT RAISE(ABORT, 'injected'); END`,
      );
      await expect(land(backend, s, "atomic")).rejects.toThrow(/injected/);
      expect(await stateOf(s, "atomic")).toBe("pending");
      await exec(backend, s, "DROP TRIGGER refuse_bodies");
      expect(await s.bodies.get("atomic")).toBeNull();
      // And with the fault gone the same publication lands whole.
      expect((await land(backend, s, "atomic")).published).toBe(true);
      expect(await stateOf(s, "atomic")).toBe("ready");
    });

    // Every later delete joins `rel_path` under the bodies directory, so a
    // pointer naming anything but this request's own path is refused unwritten.
    test("sqlite: publish refuses a path that is not the request's own", async () => {
      const s = await backend.fresh();
      await s.usage.append(logRow({ id: "req_p", at: AT, bodyState: "pending" }));
      const row = {
        requestId: "req_p",
        at: AT,
        sizeBytes: 1,
        sha256: "0".repeat(64),
        truncated: false,
        omitted: false,
      };
      for (const relPath of ["../../escape.json.enc", relPathFor("req_other", AT)]) {
        await expect(s.bodies.publish({ ...row, relPath })).rejects.toThrow(/artifact path/);
      }
      expect(await stateOf(s, "req_p")).toBe("pending");
      expect(await s.bodies.get("req_p")).toBeNull();
    });

    test("sqlite: writeRow is refused — the pointer is written by publish alone", async () => {
      const s = await backend.fresh();
      await expect(
        s.bodies.writeRow({
          requestId: "r",
          at: AT,
          relPath: relPathFor("r", AT),
          sizeBytes: 1,
          sha256: "0".repeat(64),
          truncated: false,
          omitted: false,
          bytes: new Uint8Array([1]),
        }),
      ).rejects.toThrow("writeRow is Postgres-only");
    });
  }

  if (backend.name === "postgres") {
    test("postgres: the hour is measured on the database clock, not the caller's", async () => {
      const s = await backend.fresh();
      await s.usage.append(logRow({ id: "stale", at: AT, bodyState: "pending" }));
      await exec(
        backend,
        s,
        `UPDATE request_logs SET completed_at = ${Date.now() - 2 * HOUR} WHERE id = 'stale'`,
      );
      // A caller's clock at the epoch would find nothing an hour old.
      await s.usage.sweepPending(0);
      expect(await stateOf(s, "stale")).toBe("failed");
    });
  }

  test("the export reader's rows carry the body state, read-only", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "x", at: AT, bodyState: "pending" }));
    let reader: ExportReader;
    let pool: SQL | null = null;
    if (backend.name === "sqlite") {
      reader = openSqliteExportReader(s.databasePath, await deriveKey(SECRET), () => 0);
    } else {
      pool = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
      reader = createPostgresExportReader(pool, await deriveKey(SECRET));
    }
    try {
      const rows = await reader.exportPage({
        after: { completedAt: 0, id: "" },
        settledBefore: Number.MAX_SAFE_INTEGER,
        limit: 10,
      });
      expect(rows.map((r) => r.bodyState)).toEqual(["pending"]);
      expect((await reader.getLog("x"))?.bodyState).toBe("pending");
    } finally {
      reader.close();
      await pool?.close();
    }
  });

  test("the migration leaves every row that predates it with no body state", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "old", at: AT }));
    // One migration on SQLite; the column and its index apart on Postgres.
    const ids = backend.name === "sqlite" ? "23" : "11, 12";
    await exec(
      backend,
      s,
      "DROP INDEX idx_request_logs_body_pending",
      "ALTER TABLE request_logs DROP COLUMN body_state",
      `DELETE FROM migrations WHERE id IN (${ids})`,
    );
    const reopened = await backend.sibling();
    expect((await reopened.usage.get("old"))?.bodyState).toBeNull();
    await reopened.usage.begin(pending("new"));
    expect(await stateOf(reopened, "new")).toBe("pending");
  });
});
