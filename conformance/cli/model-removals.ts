import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/model-removals-");
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
  db.run(
    "INSERT INTO credentials(id,provider,label,auth_type,api_key,created_at,updated_at) VALUES ('c','custom','account','apiKey','secret-sentinel',1,1)",
  );
  db.run(
    "INSERT INTO api_keys(id,label,prefix,hash,created_at) VALUES ('k','key','prefix','secret-sentinel',1)",
  );
  db.run(
    "INSERT INTO request_logs(id,at,requested_model,status,duration_ms,api_key_id,credential_id) VALUES ('r',1,'a😀',200,1,'k','c')",
  );
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
async function compare(args: string[], pty: string | false = false, rootEnv = false) {
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
      pty !== false ? ["python3", join(repo, "conformance/cli/pty.py"), pty, ...command] : command,
      { cwd: dir, env: { ...env, OMNI_ROOT: dir }, stdout: "pipe", stderr: "pipe" },
    );
    const out = Buffer.from(await new Response(p.stdout).arrayBuffer());
    const err = Buffer.from(await new Response(p.stderr).arrayBuffer());
    const code = await p.exited;
    if ((pty !== false ? JSON.parse(out.toString()).code : code) === 0 && !args.includes("--help"))
      successfulCommands++;
    assert(
      !err.includes("OMNI_PORT must") &&
        !out.includes(Buffer.from("OMNI_PORT must").toString("hex")),
      "unrelated configuration failure is not a model oracle",
    );
    const rows = snapshot(db);
    const expected = structuredClone(before);
    const removed = pty === false ? code === 0 : JSON.parse(out.toString()).code === 0;
    if (removed && args[0] === "rm" && !args.includes("--help")) {
      const table = expected.find(([name]) => name === "virtual_models");
      assert(table);
      table[1] = (table[1] as { id: string }[]).filter((row) => row.id !== args[1]);
    }
    assert.deepEqual(rows, expected, "only requested model may change");
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
  ["rm"],
  ["rm", ""],
  ["rm", "missing"],
  ["rm", "missing", "-y"],
  ["rm", "--help"],
  ["rm", "x", "--wat"],
  ["rm", "x", "--yes=true"],
])
  await compare(args);
for (const raw of [
  "[]",
  "null",
  "1e400",
  "{}",
  '"\\ud800"',
  `${"[".repeat(20000)}0${"]".repeat(20000)}`,
  "broken",
]) {
  seed(raw);
  await compare(["rm", "a😀"]);
  await compare(["rm", "z", "-y", "--json"]);
  seed(raw);
  await compare(["rm", "a😀", "-y", "--json"]);
  await compare(["rm", "a😀", "-y"]);
}
for (const answer of ["", "n", "YES", " y ", "yes", "no", "yep", "\ufeffyes\ufeff", "\u0085yes"]) {
  seed("[]");
  await compare(["rm", "a😀", "--json"], answer);
}
seed("[]");
await compare(["rm", "a😀", "--yes"], "");
seed("[]");
await compare(["rm", "a😀", "-y", "ignored"]);
seed("[]");
await compare(["rm", "a😀", "-y"], false, true);
assert(successfulCommands > 0, "must exercise successful model removals");
console.log(`PASS ${count} removal comparisons`);

await verifyGoldenExits("model-removals");
