// Standalone suite, not a helper: `OMNI_CLI_BIN=<omni> bun conformance/cli/config-gate.ts`.
//
// 1. The environment gate's list is every diagnostic the frozen loader throws.
// 2. Negative test: one model-puts case is run under an unrelated cluster
//    configuration error. Both CLIs still exit 1 and still compare equal, so
//    only the gate can notice; the disturbed suite must FAIL.

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../../packages/control/src/config.ts";
import {
  assertCoversFrozenLoader,
  CONFIG_DIAGNOSTICS,
  isConfigDiagnostic,
} from "./config-diagnostics.ts";

assertCoversFrozenLoader();

// Each one as the frozen loader really words it, plain and JSON-escaped.
const key = { OMNI_ENCRYPTION_KEY: "config-gate-golden-secret" };
const triggers: Record<string, string>[] = [
  {},
  { ...key, OMNI_PORT: "invalid" },
  { ...key, OMNI_CLUSTER_MODE: "true", OMNI_DATABASE_URL: "invalid" },
  { ...key, OMNI_CLUSTER_MODE: "true", OMNI_DATABASE_URL: "postgres://localhost/omni" },
  { ...key, OMNI_REDIS_URL: "redis://localhost" },
  { ...key, OMNI_METRICS_MAX_SERIES: "0" },
  { ...key, OMNI_TRACE_SAMPLE: "bogus" },
];
assert.equal(triggers.length, CONFIG_DIAGNOSTICS.length);
for (const [i, env] of triggers.entries()) {
  let message = "";
  try {
    loadConfig(env);
  } catch (error) {
    message = (error as Error).message;
  }
  const prefix = CONFIG_DIAGNOSTICS[i];
  assert(prefix !== undefined && message.startsWith(prefix), `${i}: ${message}`);
  assert(isConfigDiagnostic(message), message);
  assert(isConfigDiagnostic(JSON.stringify({ storeError: message })), message);
}
loadConfig(key);
assert(!isConfigDiagnostic("OMNI_PORT=9000 OMNI_CLUSTER_MODE=true"));

const root = mkdtempSync("/tmp/opencode/e1-e5/config-gate-");
let suite = readFileSync("conformance/cli/model-puts.ts", "utf8");
suite = suite.replace(/from "(\.[^"]+)"/g, (_, p) => `from "${resolve("conformance/cli", p)}"`);
suite = suite.replaceAll("import.meta.dir", JSON.stringify(resolve("conformance/cli")));
assert(suite.includes("\n        env,"));
suite = suite.replace(
  "\n        env,",
  '\n        env: raw === "null" ? {...env,OMNI_CLUSTER_MODE:"true",OMNI_DATABASE_URL:"invalid"} : env,',
);
writeFileSync(join(root, "model-puts.ts"), suite);
const p = Bun.spawn(["bun", join(root, "model-puts.ts")], {
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
const out = await new Response(p.stdout).text(),
  err = await new Response(p.stderr).text();
writeFileSync(join(root, "result.log"), out + err);
assert.notEqual(await p.exited, 0, "same-exit cluster substitution must fail");
// Same-exit: every comparison still passed, and the gate alone objected.
assert.match(out, /^PASS \d+ put comparisons$/m);
assert.match(out, /^EXIT HISTOGRAM model-puts .*"environment OMNI_CLUSTER_MODE":1/m);
assert(err.includes("model-puts: frozen exits/environment failures changed"));
console.log(
  `PASS ${CONFIG_DIAGNOSTICS.length} frozen config diagnostics and same-exit negative suite (${root})`,
);
