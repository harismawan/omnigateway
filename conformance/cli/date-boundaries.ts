import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/date-boundaries-");
const repo = resolve(import.meta.dir, "../..");
const env = {
  ...process.env,
  TZ: process.env.TZ ?? "UTC",
  NO_COLOR: "1",
  OMNI_ENCRYPTION_KEY: "date-boundary-golden-secret",
};
const commands = [
  ["bun", "--no-env-file", join(repo, "apps/cli/src/index.ts")],
  [
    resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni"),
    ...(process.env.OMNI_CLI_SUBCOMMAND === "1" ? ["omni"] : []),
  ],
];
const years = [584557000, 2147483647, 2147483648, 9223372036854775807n];
const invalid = years.flatMap((y) => [`${y}/01/01`, `01/01/${y}`, `-${y}/01/01`]);
invalid.push(
  "584557000/4294967295/01",
  "584557000/01/2147483647",
  "+999999-12-31T24:00:00-23:59",
  "-999999-01-01T00:00:00+23:59",
);
const edges = [
  "+275760-09-13T00:00:00Z",
  "+275760-09-13T00:00:00.001Z",
  "+275760-09-13T00:00:00",
  "+275760-09-13T01:00:00+01:00",
  "+275760-08-31T24:00:00Z",
  "275760/09/13",
  "275760/09/14",
  "02/30/2030",
];
let count = 0;
try {
  const roots = [join(root, "ts"), join(root, "rust")];
  for (const dir of roots) {
    mkdirSync(dir);
    const store = await createStore({
      path: join(dir, "db"),
      encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
    });
    store.close();
  }
  for (const date of [...invalid, ...edges])
    for (const kind of ["create", "expiry"]) {
      // Valid creation randomness remains covered by the main validated-mask oracle.
      if (kind === "create" && !invalid.includes(date)) continue;
      const results = [];
      for (const i of [0, 1]) {
        const dir = roots[i],
          cmd = commands[i];
        assert(dir && cmd);
        const db = new Database(join(dir, "db"));
        db.run("DELETE FROM api_keys");
        db.run(
          "INSERT INTO api_keys(id,label,prefix,hash,limits,created_at) VALUES('k','fixture','prefix','hash','{}',1)",
        );
        const before = db.query("SELECT * FROM api_keys").all();
        const args =
          kind === "create" ? ["create", `--expires=${date}`] : ["expiry", "k", `--at=${date}`];
        const p = goldenSpawn([...cmd, "keys", ...args, "--json", "--root", dir, "--db", "db"], {
          cwd: dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = Buffer.from(await new Response(p.stdout).arrayBuffer()),
          err = Buffer.from(await new Response(p.stderr).arrayBuffer()),
          code = await p.exited;
        const rows = db.query("SELECT * FROM api_keys ORDER BY id").all();
        db.close();
        results.push({ out, err, code, rows });
        if (invalid.includes(date)) {
          assert.equal(code, 2, `${kind} ${date}: ${err}`);
          assert.deepEqual(rows, before);
        }
      }
      assert.deepEqual(results[1], results[0], `${kind} ${date}`);
      count++;
    }
  console.log(`PASS ${count} date boundary byte/status/whole-row comparisons`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

await verifyGoldenExits("date-boundaries");
