import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../apps/cli/src/registry.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/help-");
const repo = resolve(import.meta.dir, "../..");
const bin = resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni");
const commands = [["bun", "--no-env-file", join(repo, "apps/cli/src/index.ts")], [bin]];
const cases: string[][] = [
  [],
  ["--help"],
  ["-h"],
  ["--json"],
  ["--root"],
  ["--root", "missing"],
  ["unknown", "one", "two"],
  ["unknown", "--help"],
  ["--root=x", "unknown"],
  ["--db", "--help"],
  ["--", "unknown"],
  ["keys", "--json", "list"],
  ["--root", "--json", "unknown"],
  ["--version", "unknown", "--help"],
];
for (const name of Object.keys(COMMANDS)) {
  for (const prefix of [[], ["--root", "/missing"], ["--db=x", "--json"], ["--wat"]]) {
    cases.push([...prefix, ...name.split(" "), "--help"]);
    cases.push([...prefix, ...name.split(" "), "extra", "more", "-h"]);
  }
}
for (const [i, args] of cases.entries()) {
  const results = [];
  for (const command of commands) {
    const p = goldenSpawn([...command, ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1", OMNI_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    results.push({
      out: Buffer.from(await new Response(p.stdout).arrayBuffer()),
      err: Buffer.from(await new Response(p.stderr).arrayBuffer()),
      code: await p.exited,
    });
  }
  await Bun.write(join(root, `${i}.json`), JSON.stringify({ args, results }));
  assert.deepEqual(results[1], results[0], JSON.stringify(args));
}
assert(
  readdirSync(root).every((name) => /^\d+\.json$/.test(name)),
  "help must not create installation files",
);
let implemented = 0;
let unsupported = 0;
const probe = "--omni-help-dispatch-probe";
for (const [name, command] of Object.entries(COMMANDS)) {
  // E4 and its predecessors implemented every registered non-plugin command.
  // Reach the real argument parser, but never launch a service or mutate state.
  const plugin = name.startsWith("plugin ");
  const p = goldenSpawn([bin, "--root", root, ...name.split(" "), probe], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(await new Response(p.stdout).text(), "");
  assert.equal(
    await new Response(p.stderr).text(),
    plugin
      ? "plugins are not supported in this release\n"
      : `Unknown option '${probe}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "${probe}"\nusage: omni ${command.usage}\n`,
    name,
  );
  assert.equal(await p.exited, plugin ? 1 : 2, name);
  if (plugin) unsupported++;
  else implemented++;
}
assert(
  readdirSync(root).every((name) => /^\d+\.json$/.test(name)),
  "dispatch probes must not create installation files",
);
console.log(`PASS ${cases.length} help/resolution comparisons (${root})`);
console.log(`PASS ${implemented} implemented dispatches and ${unsupported} plugin refusals`);

await verifyGoldenExits("help");
