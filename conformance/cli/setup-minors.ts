import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/setup-minors-");
const store = await createStore({
  path: join(root, "db"),
  encryptionKey: await deriveKey("setup-golden-secret"),
});
store.close();
const db = new Database(join(root, "db"));
for (const scenario of ["prototype", "io-error", "read-error"]) {
  const id = scenario === "prototype" ? "__proto__" : "pool";
  db.run("DELETE FROM virtual_models");
  db.run("INSERT INTO virtual_models VALUES (?, ?, 'weighted', 0)", [
    id,
    JSON.stringify([{ provider: "openai", model: "gpt-6-astra" }]),
  ]);
  writeFileSync(join(root, "blocked"), "file");
  if (scenario === "read-error") mkdirSync(join(root, "settings.json"));
  const results = [];
  for (const cmd of [
    ["bun", "--no-env-file", resolve("conformance/cli/setup-seam.ts")],
    [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
  ]) {
    const p = Bun.spawn(
      [
        "python3",
        resolve("conformance/cli/pty.py"),
        "",
        ...cmd,
        "--root",
        root,
        "--db",
        "db",
        "setup",
        scenario === "read-error" ? "claude" : "opencode",
        "--dir",
        scenario === "io-error" ? join(root, "blocked/sub") : root,
        "--json",
        ...(scenario === "prototype" ? ["--dry-run"] : []),
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          OMNI_ENCRYPTION_KEY: "setup-golden-secret",
          PTY_NO_COLOR: "1",
          PTY_ANSWERS: JSON.stringify([id, "", "", "", ""]),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const r = JSON.parse(await new Response(p.stdout).text());
    assert.equal(await p.exited, 0);
    assert.equal(await new Response(p.stderr).text(), "");
    assert.equal(r.code, scenario === "prototype" ? 0 : 1);
    const out = Buffer.from(r.bytes, "hex").toString();
    if (scenario === "prototype") {
      const v = JSON.parse(out.slice(out.indexOf("{")));
      assert.deepEqual(JSON.parse(v.files[0].contents).provider.omnigateway.models, {});
    } else if (scenario === "io-error")
      assert(out.includes(`ENOTDIR: not a directory, mkdir '${root}/blocked/sub'`));
    else assert(out.includes(`EISDIR: illegal operation on a directory, read`));
    results.push(r);
  }
  assert.deepEqual(results[1], results[0]);
}
db.close();
console.log(`PASS 3 setup minor regressions (${root})`);
