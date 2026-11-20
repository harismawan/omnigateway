import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { frozenPostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/db20-path-types-");
const env = { ...process.env, OMNI_ENCRYPTION_KEY: "database-golden-secret", NO_COLOR: "1" };
const store = await createStore({
  path: join(root, "seed"),
  encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
});
store.close();
const commands = [
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let count = 0,
  failures = 0;
try {
  for (const [sql, noAffinity, error, name] of [
    ["X'626f6479'", false, "object", "body"],
    ["12", true, "number", "12"],
    ["12.5", true, "number", "12.5"],
    ["12", false, null, "12"],
    ["NULL", false, null, "body"],
    ["CAST(X'ff' AS TEXT)", false, null, "�"],
  ] as const)
    for (const position of [0, 1, 2]) {
      const results = [];
      for (const cmd of commands) {
        rmSync(join(root, "request_bodies"), { recursive: true, force: true });
        mkdirSync(join(root, "request_bodies"));
        for (const s of ["", "-wal", "-shm"]) rmSync(join(root, `db${s}`), { force: true });
        copyFileSync(join(root, "seed"), join(root, "db"));
        for (const file of ["valid0", "valid1", name])
          writeFileSync(join(root, "request_bodies", file), "claim");
        const db = new Database(join(root, "db"));
        if (noAffinity)
          db.run(
            "DROP TABLE request_bodies; CREATE TABLE request_bodies(request_id,at INTEGER,rel_path,size_bytes INTEGER,sha256 TEXT,detail_state TEXT,truncated INTEGER)",
          );
        const paths = ["'valid0'", "'valid1'"];
        paths.splice(position, 0, sql);
        for (const [i, path] of paths.entries())
          db.run(`INSERT INTO request_bodies(request_id,at,rel_path) VALUES('id${i}',1,${path})`);
        const query =
          "SELECT hex(request_id) AS id,typeof(request_id) AS idType,at,hex(rel_path) AS path,typeof(rel_path) AS pathType FROM request_bodies ORDER BY rowid";
        const before = db.query(query).all();
        db.close();
        const p = goldenSpawn(
          [...cmd, "--root", root, "--db", "db", "db", "clear-bodies", "--yes", "--json"],
          { env, stdout: "pipe", stderr: "pipe" },
        );
        const out = await new Response(p.stdout).text(),
          err = await new Response(p.stderr).text(),
          code = await p.exited;
        const state = frozenPostState(root); // Whole-root capture precedes inspection.
        const check = new Database(join(root, "db"));
        const rows = check.query(query).all();
        check.close();
        results.push({ out, err, code, state, rows });
        if (cmd === commands[0]) {
          assert.equal(code, error ? 1 : 0);
          assert.equal(
            err,
            error ? `The "paths[1]" property must be of type string, got ${error}\n` : "",
          );
          if (error) {
            assert.equal(out, "");
            assert.deepEqual(rows, before);
            for (const [i, path] of paths.entries())
              if (i !== position)
                assert.equal(
                  existsSync(join(root, "request_bodies", path.slice(1, -1))),
                  i > position,
                );
            assert.ok(existsSync(join(root, "request_bodies", name)));
          } else assert.deepEqual(rows, []);
        }
      }
      try {
        assert.deepEqual(results[1], results[0]);
        console.log(`PASS ${sql} position=${position}`);
      } catch {
        console.log(
          `FAILED ${sql} position=${position}`,
          results.map(({ state, ...r }) => r),
        );
        failures++;
      }
      count++;
    }
  await verifyGoldenExits("db-clear-path-types");
  console.log(`${count} histogram rows; ${failures} failed`);
  assert.equal(failures, 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}
