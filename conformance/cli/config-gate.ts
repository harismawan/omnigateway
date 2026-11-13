import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIAGNOSTICS } from "./config-diagnostics.ts";

const source = readFileSync("packages/control/src/config.ts", "utf8");
const prefixes = [...source.matchAll(/throw new Error\(\s*(["`])([\s\S]*?)(?=\$\{|\1)/g)].map(
  (m) => m[2],
);
assert.deepEqual(prefixes, CONFIG_DIAGNOSTICS);
assert.equal((source.match(/throw new Error/g) ?? []).length, CONFIG_DIAGNOSTICS.length);
const root = mkdtempSync("/tmp/opencode/e1-e5/config-gate-");
let suite = readFileSync("conformance/cli/model-puts.ts", "utf8");
suite = suite.replace(/from "(\.[^"]+)"/g, (_, p) => `from "${resolve("conformance/cli", p)}"`);
suite = suite.replaceAll("import.meta.dir", JSON.stringify(resolve("conformance/cli")));
assert(suite.includes("env,"));
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
assert((out + err).includes("environment OMNI_CLUSTER_MODE"));
console.log("PASS 7 frozen config diagnostics and same-exit negative suite");
