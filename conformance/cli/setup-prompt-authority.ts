// Pin the frozen real CLI's multi-question stdin failure before choosing whether
// migration should reproduce it or intentionally repair the interactive flow.

import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/setup-authority-");
const secret = "setup-golden-secret";
const store = await createStore({ path: join(root, "db"), encryptionKey: await deriveKey(secret) });
store.close();
const db = new Database(join(root, "db"));
db.run("INSERT INTO virtual_models VALUES ('pool', '[]', 'weighted', 0)");
db.close();
let count = 0;
for (const client of ["claude", "opencode"])
  for (const dry of [false, true])
    for (const json of [false, true]) {
      const p = Bun.spawn(
        [
          "python3",
          resolve("conformance/cli/pty.py"),
          "",
          "bun",
          "--no-env-file",
          resolve("apps/cli/src/index.ts"),
          "--root",
          root,
          "--db",
          "db",
          "setup",
          client,
          "--dir",
          root,
          ...(dry ? ["--dry-run"] : []),
          ...(json ? ["--json"] : []),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            OMNI_ENCRYPTION_KEY: secret,
            PTY_NO_COLOR: "1",
            PTY_ANSWERS: JSON.stringify(["pool", "", "", "", ""]),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = await new Response(p.stdout).text();
      assert.equal(await new Response(p.stderr).text(), "");
      assert.equal(await p.exited, 0);
      const result = JSON.parse(out);
      assert.equal(result.code, 1);
      assert.equal(
        Buffer.from(result.bytes, "hex").toString(),
        "Default model [pool]: \r\nFable model (blank to omit) [pool]: \r\nThe operation was aborted\r\n",
      );
      assert(!existsSync(join(root, client === "claude" ? "settings.json" : "opencode.json")));
      await Bun.write(join(root, `${count++}.json`), JSON.stringify({ client, dry, json, result }));
    }
console.log(`PASS ${count} frozen TS setup prompt failure reproductions (${root})`);
