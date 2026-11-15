import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/models-golden-");
console.log(root);
const repo = resolve(import.meta.dir, "../..");
const env = { ...process.env, NO_COLOR: "1", OMNI_ENCRYPTION_KEY: "model-golden-secret" };
let bin = resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni");
if (process.env.OMNI_CLI_SYMLINK === "1") {
  symlinkSync(bin, join(root, "omni"));
  bin = join(root, "omni");
}
const commands = [
  ["bun", "--no-env-file", join(repo, "apps/cli/src/index.ts")],
  [bin, ...(process.env.OMNI_CLI_SUBCOMMAND === "1" ? ["omni"] : [])],
];
const roots = [join(root, "ts"), join(root, "rust")];
for (const dir of roots) {
  mkdirSync(dir);
  const store = await createStore({
    path: join(dir, "db"),
    encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
  });
  store.close();
  const db = new Database(join(dir, "db"));
  db.run("UPDATE migrations SET applied_at=1700000000000");
  db.run("INSERT INTO settings(key,value) VALUES ('adminPasswordHash','secret-sentinel')");
  db.close();
}
function snapshot(db: Database) {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map(({ name }) => [
    name,
    db
      .query(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
}
let count = 0;
let successfulCommands = 0;
async function compare(args: string[], pty = false, rootEnv = false) {
  const results = [];
  for (let i = 0; i < 2; i++) {
    const dir = roots[i];
    const entrypoint = commands[i];
    assert(dir && entrypoint);
    const db = new Database(join(dir, "db"));
    const before = snapshot(db);
    const command = [
      ...entrypoint,
      ...(rootEnv ? [] : ["--root", dir]),
      "--db",
      "db",
      "models",
      ...args,
    ];
    const p = goldenSpawn(
      pty ? ["python3", join(repo, "conformance/cli/pty.py"), "", ...command] : command,
      { cwd: dir, env: { ...env, OMNI_ROOT: dir }, stdout: "pipe", stderr: "pipe" },
    );
    const out = Buffer.from(await new Response(p.stdout).arrayBuffer());
    const err = Buffer.from(await new Response(p.stderr).arrayBuffer());
    const code = await p.exited;
    if ((pty ? JSON.parse(out.toString()).code : code) === 0 && !args.includes("--help"))
      successfulCommands++;
    assert(
      !err.includes("OMNI_PORT must") &&
        !out.includes(Buffer.from("OMNI_PORT must").toString("hex")),
      "unrelated configuration failure is not a model oracle",
    );
    const rows = snapshot(db);
    assert.deepEqual(rows, before, "read-only whole database");
    assert(!out.includes("secret-sentinel"));
    db.close();
    const result = { out, err, code, before, rows };
    await Bun.write(join(root, `${count}-${i}.json`), JSON.stringify({ args, pty, ...result }));
    results.push(result);
  }
  assert.deepEqual(results[1], results[0], JSON.stringify(args));
  count++;
}
function seed(raw: string, strategy = "weighted", alias = 1) {
  for (const dir of roots) {
    const db = new Database(join(dir, "db"));
    db.run("DELETE FROM virtual_models");
    db.run("INSERT INTO virtual_models VALUES ('z', '[]', 'unknown-strategy', 2)");
    db.run("INSERT INTO virtual_models VALUES ('a😀', ?, ?, ?)", [raw, strategy, alias]);
    db.close();
  }
}
for (const args of [
  ["list"],
  ["list", "--json"],
  ["list", "--help"],
  ["show", "--help"],
  ["show"],
  ["show", ""],
  ["show", "absent"],
  ["list", "--wat"],
  ["show", "x", "--json=true"],
])
  await compare(args);
const target = {
  provider: "openai",
  model: "m😀",
  tier: 1,
  weight: 2,
  costPerMTok: { input: 1.125, output: 2.675 },
  capabilities: { tools: true, images: false, reasoning: true },
};
seed(JSON.stringify([target]));
for (const args of [
  ["list"],
  ["list", "--json"],
  ["show", "a😀"],
  ["show", "a😀", "--json"],
  ["show", "z"],
  ["list", "ignored"],
])
  await compare(args);
await compare(["list"], false, true);
for (const n of [
  0, -0.001, -1.125, 1.005, 1.125, 2.675, 1e-7, 999.9995, 1234.5678, 1e20, 1e21, 1e100,
]) {
  seed(
    JSON.stringify([
      {
        ...target,
        costPerMTok: { input: n, output: n, cacheRead: 0, cacheWrite5m: n, cacheWrite1h: n },
        contextWindow: n,
        maxOutputTokens: n,
      },
    ]),
  );
  await compare(["show", "a😀"]);
  await compare(["show", "a😀", "--json"]);
}
seed(
  JSON.stringify(
    [
      "openai",
      "anthropic",
      "kimi",
      "grok",
      "kilo",
      "antigravity",
      "qoder",
      "muse",
      "custom",
      "plugin",
      "openai",
    ].map((provider, i) => ({
      ...target,
      provider,
      ...(i === 0 ? { credentialId: "public-pin" } : i === 1 ? { credentialId: null } : {}),
      capabilities: { z: [], "10": true, "2": "yes", false: 0, null: null, obj: {}, tools: true },
    })),
  ),
);
for (const args of [
  ["list"],
  ["show", "a😀"],
  ["show", "a😀", "--json"],
  ["show", "a😀", "--no-color"],
]) {
  await compare(args);
  await compare(args, true);
}
for (const raw of [
  JSON.stringify([{ ...target, extra: { unknown: null }, credentialId: null }]),
  JSON.stringify([
    { ...target, model: "\ud800", capabilities: { "\ud801": true, "�": true }, extra: "\udc00" },
  ]),
  JSON.stringify([target])
    .replace('"input":1.125', '"input":1e400')
    .replace('"output":2.675', '"output":-1e400'),
  `[${JSON.stringify(target).slice(0, -1)},"deep":${"[".repeat(1000)}0${"]".repeat(1000)}}]`,
  JSON.stringify([{ ...target, costPerMTok: { input: 1, output: 2, cacheRead: null } }]),
  "broken",
  "null",
  "{}",
  "[null]",
  "[{}]",
  JSON.stringify([
    { ...target, provider: "\ud800" },
    { ...target, provider: "\ud801" },
    { ...target, provider: "\ud800" },
  ]),
  JSON.stringify([{ ...target, credentialId: "pin" }, null]),
  JSON.stringify([{ ...target, capabilities: "😀x" }]),
  JSON.stringify([{ ...target, capabilities: null }]),
  JSON.stringify([{ ...target, contextWindow: null }]),
  JSON.stringify([{ ...target, costPerMTok: { input: null, output: 2 } }]),
  JSON.stringify([{ ...target, costPerMTok: { output: 2 } }]),
  JSON.stringify([{ ...target, credentialId: 42 }]),
  JSON.stringify([{ ...target, model: null }]),
  JSON.stringify([{ ...target, provider: null }]),
  JSON.stringify([{ ...target, contextWindow: 1e300, maxOutputTokens: -0.0001 }]),
]) {
  seed(raw, "future-strategy", 2);
  for (const args of [
    ["list"],
    ["list", "--json"],
    ["show", "a😀"],
    ["show", "a😀", "--json"],
    ["show", "missing"],
  ])
    await compare(args);
}
for (const field of ["contextWindow", "maxOutputTokens"]) {
  for (const value of [
    [1000, 2000],
    [[1000], null, [], [false, "x", {}]],
    [],
    { toLocaleString: null },
    { toLocaleString: 42 },
    { toLocaleString: "abc" },
    { toLocaleString: {} },
    { toLocaleString: [] },
    { toString: 42 },
    [{ toLocaleString: null }],
    [[{ toString: null }]],
    true,
    "\ud800",
  ]) {
    seed(JSON.stringify([{ ...target, [field]: value }]));
    await compare(["show", "a😀"]);
    await compare(["show", "a😀", "--json"]);
  }
  for (const leaf of ["1000", '{"toLocaleString":null}', '{"toString":42}']) {
    seed(
      `[${JSON.stringify(target).slice(0, -1)},"${field}":${"[".repeat(1000)}${leaf}${"]".repeat(1000)}}]`,
    );
    await compare(["show", "a😀"]);
    await compare(["show", "a😀", "--json"]);
  }
}
for (const [contextWindow, maxOutputTokens] of [
  [{ toLocaleString: null, toString: 42 }, { toString: null }],
  [[1000, { toString: 42 }, { toLocaleString: null }], { toLocaleString: 42 }],
  [[null, null, [], [null, 2000]], { valueOf: 42 }],
  [{ toLocaleString: "\ud800" }, { toString: 42 }],
]) {
  seed(JSON.stringify([{ ...target, contextWindow, maxOutputTokens }]));
  await compare(["show", "a😀"]);
  await compare(["show", "a😀", "--json"]);
}
for (const field of ["contextWindow", "maxOutputTokens"]) {
  seed(`[${JSON.stringify(target).slice(0, -1)},"${field}":[1e400,-1e400,-0,null,1000]}]`);
  await compare(["show", "a😀"]);
}
for (const tail of ["\ufeff", "\u0085", "\u001c", "\u00a0"]) {
  seed(
    JSON.stringify([
      { ...target, provider: `provider${tail}`, capabilities: { [`tail${tail}`]: true } },
    ]),
  );
  await compare(["list"]);
  await compare(["show", "a😀"]);
}
for (const method of [null, 42, "abc", {}, []]) {
  seed(JSON.stringify({ some: method, map: method }));
  await compare(["list"]);
  await compare(["show", "a😀"]);
  for (const field of ["input", "output", "cacheRead"]) {
    seed(
      JSON.stringify([
        { ...target, costPerMTok: { ...target.costPerMTok, [field]: { toFixed: method } } },
      ]),
    );
    await compare(["show", "a😀"]);
  }
}
seed("[]");
for (const dir of roots) {
  const db = new Database(join(dir, "db"));
  db.run("INSERT INTO virtual_models VALUES (NULL, '[]', 'score', 0)");
  db.close();
}
await compare(["list"]);
await compare(["list", "--json"]);
assert(successfulCommands > 0, "must exercise successful model reads");
console.log(`PASS models ${count}: ${root}`);

await verifyGoldenExits("model-reads");
