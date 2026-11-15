import "./driver-env.ts";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/setup-minors-");
const store = await createStore({
  path: join(root, "db"),
  encryptionKey: await deriveKey("setup-golden-secret"),
});
store.close();
const db = new Database(join(root, "db"));
for (const scenario of [
  "prototype",
  "io-error",
  "read-error",
  "read-denied",
  "write-denied",
  "rename-directory",
  "write-full",
]) {
  const id = scenario === "prototype" ? "__proto__" : "pool";
  db.run("DELETE FROM virtual_models");
  db.run("INSERT INTO virtual_models VALUES (?, ?, 'weighted', 0)", [
    id,
    JSON.stringify([{ provider: "openai", model: "gpt-6-astra" }]),
  ]);
  writeFileSync(join(root, "blocked"), "file");
  if (scenario === "read-error") mkdirSync(join(root, "settings.json"));
  if (scenario === "read-denied") {
    rmSync(join(root, "settings.json"), { recursive: true });
    writeFileSync(join(root, "settings.json"), "{}");
    chmodSync(join(root, "settings.json"), 0);
  }
  const results = [];
  const destination = join(root, scenario);
  if (scenario === "write-denied") {
    mkdirSync(destination);
    chmodSync(destination, 0o500);
  }
  if (scenario === "rename-directory")
    mkdirSync(join(destination, "opencode.json"), { recursive: true });
  for (const cmd of [
    ["bun", "--no-env-file", resolve("conformance/cli/setup-seam.ts")],
    [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
  ]) {
    const p = Bun.spawn(
      [
        "python3",
        resolve("conformance/cli/pty.py"),
        "",
        ...(scenario === "write-full"
          ? ["python3", resolve("conformance/cli/full-disk.py"), destination]
          : []),
        ...cmd,
        "--root",
        root,
        "--db",
        "db",
        "setup",
        scenario.startsWith("read-") ? "claude" : "opencode",
        "--dir",
        scenario === "io-error"
          ? join(root, "blocked/sub")
          : ["write-denied", "rename-directory", "write-full"].includes(scenario)
            ? destination
            : root,
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
    else if (scenario === "read-error")
      assert(out.includes(`EISDIR: illegal operation on a directory, read`));
    else if (scenario === "read-denied")
      assert(out.includes(`EACCES: permission denied, open '${root}/settings.json'`));
    else if (scenario === "write-denied")
      assert.match(out, /EACCES: permission denied, open '.*opencode.json\.\d+\.tmp'/);
    else if (scenario === "write-full")
      assert(out.includes("ENOSPC: no space left on device, write\r\n"));
    else
      assert.match(
        out,
        /EISDIR: illegal operation on a directory, rename '.*opencode.json\.\d+\.tmp' -> '.*opencode.json'/,
      );
    // Only process-specific sibling temporary filename PID differs.
    results.push({
      ...r,
      bytes: Buffer.from(out.replace(/(opencode\.json\.)\d+(\.tmp)/g, "$1<PID>$2")).toString("hex"),
    });
  }
  assert.deepEqual(results[1], results[0]);
}
db.close();
console.log(`PASS 7 setup minor regressions (${root})`);
