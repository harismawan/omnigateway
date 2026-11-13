import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/model-puts-");
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
  db.run("INSERT INTO settings VALUES ('adminPasswordHash','secret-sentinel')");
  db.run(
    "INSERT INTO api_keys(id,label,prefix,hash,created_at) VALUES ('keep','keep','keep','keep',1)",
  );
  db.run(
    "INSERT INTO request_logs(id,at,requested_model,status,duration_ms) VALUES ('keep',1,'m',200,1)",
  );
  db.close();
}
function snapshot(db: Database) {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]);
}
let count = 0;
let successfulCommands = 0;
async function compare(
  raw: string | Uint8Array,
  args = ["put", "m", "-f", "model.json", "--json"],
) {
  const results = [];
  for (let i = 0; i < 2; i++) {
    const dir = roots[i];
    assert(dir);
    await Bun.write(join(dir, "model.json"), raw);
    const db = new Database(join(dir, "db"));
    const before = snapshot(db);
    const p = Bun.spawn([...(commands[i] ?? []), "--root", dir, "--db", "db", "models", ...args], {
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
      "unrelated configuration failure is not a model oracle",
    );
    const rows = snapshot(db);
    db.close();
    if (code !== 0) assert.deepEqual(rows, before, "failed put atomicity");
    else
      assert.deepEqual(
        rows.filter((r) => r[0] !== "virtual_models"),
        before.filter((r) => r[0] !== "virtual_models"),
      );
    const result = { out, err, code, before, rows };
    results.push(result);
    await Bun.write(join(root, `${count}-${i}.json`), JSON.stringify({ raw, args, ...result }));
  }
  assert.deepEqual(results[1], results[0], `${count}: ${raw.slice(0, 500)}`);
  count++;
}
const target = {
  provider: "openai",
  model: "upstream",
  tier: 1,
  weight: 1,
  costPerMTok: { input: 0, output: 1 },
  capabilities: { tools: true, images: false, reasoning: true },
};
const model = { id: "m", strategy: "score", isAlias: false, targets: [target] };
await compare(JSON.stringify(model));
for (const value of [null, {}, [], false, 1, "x"]) await compare(JSON.stringify(value));
for (const key of Object.keys(model)) {
  for (const value of [undefined, null, false, 0, "", [], {}])
    await compare(JSON.stringify({ ...model, [key]: value }));
}
for (const key of [
  ...Object.keys(target),
  "credentialId",
  "endpointId",
  "contextWindow",
  "maxOutputTokens",
]) {
  for (const value of [undefined, null, false, 0, -1, 1.5, 9007199254740992, "", [], {}])
    await compare(JSON.stringify({ ...model, targets: [{ ...target, [key]: value }] }));
}
for (const key of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"])
  for (const value of [undefined, null, -1, 0, 1.5, "x"])
    await compare(
      JSON.stringify({
        ...model,
        targets: [{ ...target, costPerMTok: { ...target.costPerMTok, [key]: value } }],
      }),
    );
for (const strategy of ["score", "priority", "roundRobin", "weighted"])
  await compare(JSON.stringify({ ...model, strategy }));
for (const provider of [
  "anthropic",
  "openai",
  "kilo",
  "qoder",
  "antigravity",
  "plugin",
  "custom",
  "A",
  "a".repeat(33),
])
  await compare(JSON.stringify({ ...model, targets: [{ ...target, provider }] }));
for (const raw of [
  "broken",
  "",
  "{}{}",
  JSON.stringify(model).replace('"tier":1', '"tier":1e400'),
  JSON.stringify(model).replace('"weight":1', '"weight":1e400'),
  JSON.stringify({ ...model, unknown: 0 }).replace(
    '"unknown":0',
    `"unknown":${"[".repeat(20000)}0${"]".repeat(20000)}`,
  ),
])
  await compare(raw);
await compare(JSON.stringify({ ...model, id: "other" }));
await compare(JSON.stringify(model), ["put"]);
await compare(JSON.stringify(model), ["put", "m"]);
await compare(JSON.stringify(model), [
  "put",
  "m",
  "-f",
  "model.json",
  "--from-catalog",
  "openai:x",
]);
for (const provider of ["custom", "qoder", "antigravity", "kilo", "openai", "plugin"]) {
  for (const auth of ["oauth", "apiKey"]) {
    for (const dir of roots) {
      const db = new Database(join(dir, "db"));
      db.run("DELETE FROM credentials");
      db.run("DELETE FROM virtual_models");
      db.run(
        "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('pin',?,'Account',?,'{\"endpointId\":\"ep\"}',1,1)",
        [provider, auth],
      );
      db.close();
    }
    const t = {
      ...target,
      provider,
      model: "kilo-auto/frontier",
      ...(provider === "custom" ? { endpointId: " ep " } : {}),
    };
    await compare(JSON.stringify({ ...model, targets: [t] }));
    await compare(JSON.stringify({ ...model, targets: [{ ...t, credentialId: " pin " }] }));
    await compare(JSON.stringify({ ...model, targets: [{ ...t, credentialId: "missing" }] }));
  }
}
for (const key of ["provider", "credentialId", "endpointId", "model"]) {
  for (const value of ["\ud800", "😀", " x ", "a".repeat(64), "a".repeat(65)])
    await compare(JSON.stringify({ ...model, targets: [{ ...target, [key]: value }] }));
}
for (const raw of [
  JSON.stringify({
    ...model,
    extra: 1,
    targets: [
      {
        ...target,
        costPerMTok: { ...target.costPerMTok, unknown: 2 },
        capabilities: { ...target.capabilities, unknown: true },
      },
    ],
  }),
  JSON.stringify({ ...model, targets: [{ ...target, unknown: 1 }] }),
  JSON.stringify(model).replace('"weight":1', '"weight":0,"weight":2'),
  JSON.stringify(model).replace('"model":"upstream"', '"model":"\\ud800"'),
])
  await compare(raw);
for (const args of [
  ["put", "m", "--file=model.json", "--strategy=garbage", "--alias"],
  ["put", "m", "-fmodel.json"],
  ["put", "m", "-f"],
  ["put", "m", "--file"],
  ["put", "m", "-f", "--json"],
  ["put", "m", "--file", "--json"],
  ["put", "m", "-f", "missing.json"],
  ["put", "m", "-f", "."],
])
  await compare(JSON.stringify(model), args);
for (const raw of ["[]", "null", "{}", "[null]", "[1]", "broken"]) {
  for (const dir of roots) {
    const db = new Database(join(dir, "db"));
    db.run("DELETE FROM virtual_models");
    db.run("INSERT INTO virtual_models VALUES ('m',?,'score',0)", [raw]);
    db.close();
  }
  await compare(JSON.stringify(model));
}
for (const dir of roots) {
  const db = new Database(join(dir, "db"));
  db.run("DELETE FROM virtual_models");
  db.run("DELETE FROM credentials");
  db.close();
}
await compare(`\ufeff${JSON.stringify(model)}`);
await compare(
  JSON.stringify(model).replace(
    '"model":"upstream"',
    `"model":${"[".repeat(20000)}0${"]".repeat(20000)}`,
  ),
);
await compare(JSON.stringify(model), ["put", "m", "-fmodel.json", "--", "-f"]);
for (const data of [
  "null",
  "broken",
  '{"endpointId":"ep"}',
  `{"unknown":${"[".repeat(20000)}0${"]".repeat(20000)}}`,
]) {
  for (const dir of roots) {
    const db = new Database(join(dir, "db"));
    db.run("DELETE FROM credentials");
    db.run(
      "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('c','custom','c','apiKey',?,1,1)",
      [data],
    );
    db.close();
  }
  await compare(JSON.stringify(model));
}
await compare(
  new Uint8Array(
    [...Buffer.from(JSON.stringify(model).replace("upstream", "X"))].map((b) =>
      b === 88 ? 255 : b,
    ),
  ),
);
await compare(JSON.stringify(model), ["show", "m", "--json"]);
for (const dir of roots) {
  const db = new Database(join(dir, "db"));
  db.run("DELETE FROM credentials");
  db.run(
    "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('pin','qoder','c','apiKey','null',1,1)",
  );
  db.close();
}
await compare(
  JSON.stringify({ ...model, targets: [{ ...target, provider: "qoder", credentialId: "pin" }] }),
);
function reset(
  old: unknown,
  accounts: Array<[string, string, string, string, number]> = [["pin", "qoder", "apiKey", "{}", 1]],
) {
  for (const dir of roots) {
    const db = new Database(join(dir, "db"));
    db.run("DELETE FROM credentials");
    db.run("DELETE FROM virtual_models");
    if (old !== undefined)
      db.run("INSERT INTO virtual_models VALUES ('m',?,'score',0)", [JSON.stringify(old)]);
    for (const [id, provider, auth, data, enabled] of accounts)
      db.run(
        "INSERT INTO credentials(id,provider,label,auth_type,provider_data,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)",
        [id, provider, id, auth, data, enabled],
      );
    db.close();
  }
}
const q = { ...target, provider: "qoder" };
const group = process.env.MODEL_FIX_GROUP;
for (const old of [123, true, null, {}, [null, "x"], { toString: 1 }]) {
  reset([{ ...q, model: old }]);
  await compare(
    JSON.stringify({
      ...model,
      targets: [
        {
          ...q,
          model:
            typeof old === "object" &&
            old !== null &&
            "toString" in old &&
            Object.hasOwn(old, "toString")
              ? "x"
              : String(old),
        },
      ],
    }),
  );
}
if (!group || group === "I1") {
  for (const old of ["\ud800", ["\ud800"], [["\ud800"]]]) {
    for (const next of ["\ud801", "�", "\ud800"]) {
      reset([{ ...q, model: old }]);
      await compare(JSON.stringify({ ...model, targets: [{ ...q, model: next }] }));
    }
  }
  for (const pin of [undefined, "pin", "oauth", "missing"]) {
    reset(
      [{ ...q, model: "\ud800" }],
      [
        ["pin", "qoder", "apiKey", "{}", 1],
        ["oauth", "qoder", "oauth", "{}", 0],
      ],
    );
    await compare(
      JSON.stringify({ ...model, targets: [{ ...q, model: "\ud800", credentialId: pin }] }),
    );
  }
  for (const accounts of [
    [
      ["pin", "openai", "oauth", "{}", 1],
      ["key", "qoder", "apiKey", "{}", 1],
    ],
    [
      ["pin", "qoder", "oauth", '{"endpointId":"other"}', 1],
      ["key", "qoder", "apiKey", "{}", 1],
    ],
  ] as Array<Array<[string, string, string, string, number]>>) {
    reset(undefined, accounts);
    await compare(JSON.stringify({ ...model, targets: [{ ...q, credentialId: "pin" }] }));
  }
  reset(undefined, [["pin", "qoder", "oauth", "{}", 0]]);
  await compare(JSON.stringify({ ...model, targets: [{ ...q, credentialId: "pin" }] }));
  reset(undefined);
  await compare(JSON.stringify({ ...model, targets: [target, q] }));
  reset(undefined, [
    ["a", "qoder", "apiKey", "null", 1],
    ["pin", "qoder", "oauth", "{}", 1],
  ]);
  await compare(JSON.stringify({ ...model, targets: [{ ...q, credentialId: "pin" }] }));
}
if (!group || group === "M1") {
  reset(undefined, []);
  await compare(
    JSON.stringify({ ...model, targets: [target] }).replace(
      '"provider":"openai"',
      '"9":0,"2":0,"provider":"openai"',
    ),
  );
}
if (!group || group === "M2") {
  reset(undefined, []);
  for (const args of [
    ["put", "m", "-yfmodel.json"],
    ["put", "m", "-yf", "model.json"],
    ["put", "m", "-yyfmodel.json"],
    ["put", "m", "-yf"],
    ["put", "m", "-yf", "--json"],
  ])
    await compare(JSON.stringify(model), args);
}
assert(successfulCommands > 0, "must exercise successful model puts");
console.log(`PASS ${count} put comparisons`);
