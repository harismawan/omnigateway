import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = mkdtempSync("/tmp/opencode/e1-e5/plugins-");
const bin = resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni");
mkdirSync(join(root, "plugins", "sentinel"), { recursive: true });
const sentinel = join(root, "plugins", "sentinel", "index.js");
writeFileSync(sentinel, "throw new Error('plugin code must never run');\n");
let requests = 0;
const server = Bun.serve({
  port: 0,
  fetch() {
    requests++;
    return new Response("unexpected request", { status: 500 });
  },
});
let count = 0;
for (const verb of ["list", "verify", "install", "update", "remove"]) {
  for (const flags of [
    [],
    ["--json"],
    ["--purge", "--yes"],
    ["--registry", server.url.toString()],
  ]) {
    const args = [
      "--root",
      root,
      "plugin",
      verb,
      new URL("plugin.tgz", server.url).toString(),
      ...flags,
    ];
    const p = Bun.spawn([bin, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    assert.deepEqual(
      { out, err, code },
      { out: "", err: "plugins are not supported in this release\n", code: 1 },
    );
    count++;
  }
}
server.stop();
assert.equal(requests, 0, "refusal must not contact the network");
assert.deepEqual(readdirSync(root), ["plugins"], "refusal must not write any installation files");
assert.deepEqual(readdirSync(join(root, "plugins")), ["sentinel"]);
assert.deepEqual(readdirSync(join(root, "plugins", "sentinel")), ["index.js"]);
assert.equal(readFileSync(sentinel, "utf8"), "throw new Error('plugin code must never run');\n");
// The TS runner renders operator errors on stderr even under --json.
const ts = Bun.spawn(
  [
    "bun",
    "--no-env-file",
    resolve("apps/cli/src/index.ts"),
    "--root",
    root,
    "plugin",
    "update",
    "--json",
  ],
  { cwd: root, stdout: "pipe", stderr: "pipe" },
);
assert.equal(await new Response(ts.stdout).text(), "");
assert((await new Response(ts.stderr).text()).startsWith("plugin id is required\n"));
assert.equal(await ts.exited, 2);
console.log(`PASS ${count} plugin refusals; TS JSON error-channel check (${join(root)})`);
