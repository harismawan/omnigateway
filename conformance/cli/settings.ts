import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, DEFAULT_SETTINGS, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/settings-golden-");
const repo = resolve(import.meta.dir, "../..");
const env = { ...process.env, NO_COLOR: "1", OMNI_ENCRYPTION_KEY: "settings-golden-secret" };
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
  const s = await createStore({
    path: join(dir, "db"),
    encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
  });
  s.close();
  const db = new Database(join(dir, "db"));
  for (const key of ["adminPasswordHash", "viewerPasswordHash", "internal-setting"])
    db.run("INSERT INTO settings(key,value) VALUES (?,?)", [key, "secret-sentinel"]);
  db.close();
}
let successfulCommands = 0;
async function run(i: number, args: string[], dir = roots[i]) {
  const command = commands[i];
  assert(dir && command);
  const db = new Database(join(dir, "db"));
  const before = db.query("SELECT * FROM settings ORDER BY key").all();
  const p = goldenSpawn([...command, "--root", dir, "--db", "db", "settings", ...args], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = Buffer.from(await new Response(p.stdout).arrayBuffer());
  const err = Buffer.from(await new Response(p.stderr).arrayBuffer());
  const code = await p.exited;
  if (code === 0 && !args.includes("--help")) successfulCommands++;
  assert(
    !err.includes("OMNI_PORT must"),
    "unrelated configuration failure is not a settings oracle",
  );
  const rows = db.query("SELECT * FROM settings ORDER BY key").all();
  db.close();
  if (code !== 0) assert.deepEqual(rows, before, "invalid mutation atomicity");
  assert(!out.includes("secret-sentinel"));
  return { out, err, code, rows };
}
let count = 0;
async function compare(args: string[]) {
  const rust = await run(1, args);
  const ts = await run(0, args);
  await Bun.write(join(root, `${count}-ts.json`), JSON.stringify({ args, ...ts }));
  await Bun.write(join(root, `${count}-rust.json`), JSON.stringify({ args, ...rust }));
  assert.deepEqual(rust, ts, JSON.stringify(args));
  count++;
}
for (const args of [
  ["get"],
  ["get", "--json"],
  ["get", "extra"],
  ["get", "--help"],
  ["set", "--help"],
  ["set"],
  ["set", "rtkEnabled"],
  ["set", "", "1"],
  ["get", "--wat"],
])
  await compare(args);
for (const path of ["maxAttempts", "requestDeadlineMs", "breakerCooldownMs", "weights.cost"]) {
  for (const raw of [
    "-1",
    "-0",
    "-9007199254740992",
    "\ufeff 2 \u00a0",
    "1_000",
    "+0x10",
    "1e-7",
    "1e21",
  ]) {
    await compare(["set", "--json", "--", path, raw]);
  }
}
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  const paths =
    key === "weights" ? Object.keys(DEFAULT_SETTINGS.weights).map((k) => `weights.${k}`) : [key];
  for (const path of paths) {
    const raw =
      key === "weights"
        ? "0.4"
        : typeof value === "boolean"
          ? " TrUe "
          : typeof value === "number"
            ? "2"
            : value === null
              ? " model "
              : key === "ponytailMode"
                ? " full "
                : " policy ";
    await compare(["set", path, raw]);
    await compare(["get", "--json"]);
  }
}
for (const path of ["guardrailModel", "smartRouterClassifierModel", "smartRouterLocalModel"])
  for (const raw of ["null", " NULL ", " ", "x".repeat(257)])
    await compare(["set", path, raw, "--json"]);
for (const path of [
  "rtkEnabled",
  "bodyLoggingEnabled",
  "ponytailMode",
  "maxAttempts",
  "requestDeadlineMs",
  "weights.cost",
])
  for (const raw of [
    "",
    " ",
    "true",
    "false",
    "yes",
    "0",
    "0x10",
    "0b10",
    "0o10",
    "1e2",
    "1.5",
    "Infinity",
    "NaN",
    "9007199254740992",
  ])
    await compare(["set", path, raw, "--json"]);
for (const path of [
  "missing",
  "__proto__",
  "constructor",
  "toString",
  "0",
  ".",
  "weights",
  "weights.",
  "weights.nope",
  "weights.__proto__",
  "weights.constructor",
  "weights.cost.extra",
  "rtkEnabled.x",
])
  await compare(["set", path, "2"]);
for (const [path, max] of [
  ["maxAttempts", 10],
  ["bodyRetentionDays", 3650],
  ["snapshotKeepLatest", 100],
  ["snapshotMaxAgeDays", 3650],
  ["guardrailTimeoutMs", 60000],
  ["guardrailHistoryTurns", 10],
  ["smartRouterTimeoutMs", 60000],
] as const)
  for (const raw of ["0", String(max), String(max + 1)])
    await compare(["set", path, raw, "--json"]);
for (const raw of [
  "broken",
  "null",
  "[]",
  '{"maxAttempts":"bad","weights":{"cost":7,"retired":9},"rtkEnabled":"true"}',
  '{"2":"two","extra":{"x":1},"maxAttempts":null}',
  '{"maxAttempts":false}',
  '{"maxAttempts":1.5}',
  '{"extra":{"nested":{"toString":null}}}',
  '{"bodyLoggingEnabled":true,"extra":"\\ud800","\\ud800":1,"\\ud801":2}',
  '{"extra":"\\udc00","�":1,"\\ud800":2,"\\ud800":3,"😀":"\\ud83d\\ude00"}',
  '{"guardrailModel":" \\ud800 ","smartRouterPolicy":" \\udc00 ","smartRouterLocalModel":"\\ud801","smartRouterClassifierModel":"\\ud83d\\ude00"}',
  '{"maxAttempts":0,"extra":"\\ud800","\\ud800":1,"\\ud801":2}',
  ...["1e400", "-1e400"].flatMap((n) => [
    `{"maxAttempts":${n},"bodyLoggingEnabled":true}`,
    `{"extra":${n},"bodyLoggingEnabled":true}`,
    `{"weights":{"cost":${n}},"bodyLoggingEnabled":true}`,
    `{"guardrailModel":${n},"bodyLoggingEnabled":true}`,
  ]),
  ...[130, 1000].flatMap((depth) => {
    const deep = `${"[".repeat(depth)}0${"]".repeat(depth)}`;
    return [
      `{"extra":${deep},"bodyLoggingEnabled":true}`,
      `{"maxAttempts":${deep},"bodyLoggingEnabled":true}`,
      `{"weights":${deep},"bodyLoggingEnabled":true}`,
      `{"extra":${deep},"extra":2,"bodyLoggingEnabled":true}`,
      `{"extra":${deep},"maxAttempts":1e400,"bodyLoggingEnabled":true}`,
    ];
  }),
]) {
  for (const dir of roots) {
    const db = new Database(join(dir, "db"));
    db.run(
      "INSERT INTO settings(key,value) VALUES ('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [raw],
    );
    db.close();
  }
  await compare(["get"]);
  await compare(["get", "--json"]);
  await compare(["set", "rtkEnabled", "false"]);
  await compare(["set", "maxAttempts", "3"]);
}
assert.deepEqual(
  await run(0, ["get", "--json"], roots[1]),
  await run(1, ["get", "--json"], roots[0]),
);
assert(successfulCommands > 0, "must exercise successful settings commands");
console.log(
  `PASS ${count} settings raw-byte/status/whole-row comparisons; crossread; artifacts ${root}`,
);

await verifyGoldenExits("settings");
