import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileState, frozenPostState } from "./db-file-state.ts";
import { goldenSpawn } from "./exit-gate.ts";

export async function refusalStateCases(
  commands: string[][],
  seed: string,
  env: Record<string, string | undefined>,
) {
  const root = mkdtempSync("/tmp/opencode/e1-e5/db-refusal-state-");
  mkdirSync(join(root, "request_bodies"));
  writeFileSync(join(root, "request_bodies/sentinel"), "body sentinel");
  try {
    for (const mode of ["delete", "wal"]) {
      const results = [];
      for (const cmd of commands) {
        for (const s of ["", "-wal", "-shm"]) rmSync(join(root, "db") + s, { force: true });
        copyFileSync(seed, join(root, "db"));
        mkdirSync(join(root, "snapshots"), { recursive: true });
        writeFileSync(join(root, "snapshots", "sentinel"), "snapshot sentinel");
        const db = new Database(join(root, "db"));
        db.run(`PRAGMA journal_mode=${mode === "delete" ? "DELETE" : "WAL"}`);
        if (mode === "wal") {
          db.run("PRAGMA wal_autocheckpoint=0");
          db.run("CREATE TABLE refusal_sentinel(value)");
          db.run("INSERT INTO refusal_sentinel VALUES ('sentinel')");
          // Preserve a nonempty WAL after the holder exits, without a close checkpoint.
          const files = ["", "-wal", "-shm"].map((suffix) => {
            const path = join(root, `db${suffix}`);
            return { path, bytes: readFileSync(path) };
          });
          db.close();
          for (const { path, bytes } of files) writeFileSync(path, bytes);
        } else db.close();
        const before = fileState(root);
        const p = goldenSpawn(
          [
            ...cmd,
            "--root",
            root,
            "--db",
            "db",
            "db",
            "restore",
            "db_2000-01-01T00-00-00-000Z_manual.sqlite",
          ],
          { env, stdout: "pipe", stderr: "pipe" },
        );
        const result = {
          out: await new Response(p.stdout).text(),
          err: await new Response(p.stderr).text(),
          code: await p.exited,
        };
        assert.equal(result.code, 1);
        assert.match(result.err, /BAD_REQUEST: no such snapshot/);
        assert.notDeepEqual(fileState(root), before, `${mode}: frozen open writes`);
        results.push({
          ...result,
          state:
            process.env.OMNI_RAW_REFUSAL_STATE === "1" ? fileState(root) : frozenPostState(root),
        });
      }
      assert.deepEqual(results[1], results[0], mode);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return 2;
}
