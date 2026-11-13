import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/db-reads-");
const bin = resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni");
await Bun.write(
  join(root, "manifest.json"),
  JSON.stringify({
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
    binary: bin,
    sha256: createHash("sha256").update(readFileSync(bin)).digest("hex"),
  }),
);
const env = { ...process.env, OMNI_ENCRYPTION_KEY: "database-golden-secret", NO_COLOR: "1" };
const store = await createStore({
  path: join(root, "db"),
  encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
});
store.close();
mkdirSync(join(root, "snapshots"));
for (const name of [
  "junk",
  "db_2024-01-01T00-00-00-000Z_manual.sqlite",
  "db_2025-02-01T01-02-03-456Z_beforeRestore.sqlite",
  "db_2025-99-01T00-00-00-000Z_manual.sqlite",
  "db_2025-02-30T00-00-00-000Z_manual.sqlite",
  "db_2025-01-01T24-00-00-000Z_manual.sqlite",
])
  writeFileSync(join(root, "snapshots", name), "fixture");
const commands = [["bun", "--no-env-file", resolve("apps/cli/src/index.ts")], [bin]];
let count = 0;
for (const seeded of [false, true]) {
  if (seeded) {
    mkdirSync(join(root, "request_bodies", "nested"), { recursive: true });
    writeFileSync(join(root, "request_bodies", "nested", "data"), "captured-body");
    symlinkSync(
      join(root, "request_bodies", "nested", "data"),
      join(root, "request_bodies", "link"),
    );
    const d = new Database(join(root, "db"));
    d.run("INSERT INTO settings VALUES ('sentinel','retained')");
    d.close();
    rmSync(join(root, "snapshots"), { recursive: true });
  }
  for (const verb of ["snapshots", "stats"])
    for (const json of [false, true])
      for (const bad of [false, true]) {
        const results = [];
        for (const cmd of commands) {
          const p = Bun.spawn(
            [...cmd, "--root", root, "--db", "db", "db", verb, ...(json ? ["--json"] : [])],
            {
              cwd: root,
              env: { ...env, ...(bad ? { OMNI_ENCRYPTION_KEY: "short" } : {}) },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          let out = await new Response(p.stdout).text();
          const err = await new Response(p.stderr).text();
          const code = await p.exited;
          // Free filesystem blocks are shared with concurrent builds. Validate type then
          // mask only that live measurement, never database sizes/table accounting.
          if (verb === "stats" && code === 0) {
            if (json) {
              const data = JSON.parse(out);
              assert(typeof data.freeDiskBytes === "number" && data.freeDiskBytes >= 0);
              data.freeDiskBytes = "<free disk>";
              out = JSON.stringify(data);
            } else {
              assert.match(out, /free disk +[\d.]+ [KMB]+/);
              out = out.replace(/(free disk +)[^\n]+/, "$1<free disk>");
            }
          }
          const db = new Database(join(root, "db"));
          const rows = (
            db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
              name: string;
            }[]
          ).map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]);
          db.close();
          results.push({ out, err, code, rows });
        }
        await Bun.write(join(root, `${count}.json`), JSON.stringify({ verb, json, bad, results }));
        assert.deepEqual(results[1], results[0]);
        count++;
      }
}
console.log(`PASS ${count} database read output/status/whole-DB comparisons (${root})`);
