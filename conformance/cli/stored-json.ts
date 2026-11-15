// Extra terminal consumers of unreadable rows, beyond keys-list/models/status.
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/cli-fix/stored-json-");
const path = join(root, "db");
const secret = "stored-json-golden-secret";
const store = await createStore({ path, encryptionKey: await deriveKey(secret) });
store.close();
const db = new Database(path);
db.run("INSERT INTO api_keys(id,label,prefix,hash,model_allowlist,created_at) VALUES('k','k','p','h','broken',1)");
db.run("INSERT INTO virtual_models VALUES('v','broken','weighted',0)");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OMNI_")));
Object.assign(env, { HOME: root, OMNI_ENCRYPTION_KEY: secret, NO_COLOR: "1" });
let count = 0;
for (const args of [
  ["keys", "limits", "k", "--set", "requests:1h=1"],
  ["keys", "expiry", "k", "--never"],
  ["keys", "models", "k", "--all"],
  ["keys", "guardrail", "k", "--clear"],
  ["keys", "smart-routing", "k", "--on"],
  ["setup", "opencode", "--dir", root],
  ["setup", "claude"],
]) {
  const results = [];
  for (const cmd of [["bun", "--no-env-file", resolve("apps/cli/src/index.ts")], [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")]]) {
    const child = goldenSpawn([...cmd, "--root", root, "--db", "db", ...args, "--json"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    results.push({ out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text(), code: await child.exited });
  }
  assert.deepEqual(results[1], results[0], args.join(" "));
  assert.deepEqual(results[0], { out: "", err: 'JSON Parse error: Unexpected identifier "broken"\n', code: 1 });
  count++;
}
db.close();
console.log(`PASS ${count} stored JSON terminal comparisons`);
await verifyGoldenExits("stored-json");
