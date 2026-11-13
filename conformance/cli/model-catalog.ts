// Real frozen-TS `models catalog` / `models put --from-catalog` versus Rust:
// raw stdout/stderr/status and whole-DB before/after on independent seeded roots.
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PROVIDER_DESCRIPTORS } from "../../packages/providers/src/descriptors.ts";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/model-catalog-");
console.log(root);
const repo = resolve(import.meta.dir, "../..");
const secret = "model-golden-secret";
const base = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("OMNI_")),
);
const env: Record<string, string | undefined> = {
  ...base,
  NO_COLOR: "1",
  HOME: root,
  OMNI_ENCRYPTION_KEY: secret,
};
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
    encryptionKey: await deriveKey(secret),
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
  // The database `--root` alone resolves to, for the ambient OMNI_DB_PATH cases.
  copyFileSync(join(dir, "db"), join(dir, "omnigateway.db"));
  // A plain file in the plugins directory: discovery lists only directories,
  // so the registry is exactly the built-ins on both sides.
  mkdirSync(join(dir, "plugins"));
  writeFileSync(join(dir, "plugins", "README"), "not a plugin");
}
function snapshot(path: string) {
  const db = new Database(path);
  const rows = (
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
  db.close();
  return rows;
}
type Options = {
  pty?: boolean;
  rootEnv?: boolean;
  db?: boolean;
  extraEnv?: Record<string, string | undefined>;
  prefix?: string[];
  /** Only for cases that must not touch either root's databases. */
  readOnly?: boolean;
};
let count = 0;
let successfulCommands = 0;
let red = 0;
async function compare(args: string[], options: Options = {}) {
  const { pty = false, rootEnv = false, db = true, extraEnv = {}, prefix = [] } = options;
  const results = [];
  for (let i = 0; i < 2; i++) {
    const dir = roots[i];
    const entrypoint = commands[i];
    assert(dir && entrypoint);
    const files = readdirSync(dir).sort();
    const before = [snapshot(join(dir, "db")), snapshot(join(dir, "omnigateway.db"))];
    const command = [
      ...entrypoint,
      ...prefix,
      ...(rootEnv ? [] : ["--root", dir]),
      ...(db ? ["--db", "db"] : []),
      "models",
      ...args,
    ];
    const runEnv = { ...env, ...(rootEnv ? { OMNI_ROOT: dir } : {}), ...extraEnv };
    for (const [k, v] of Object.entries(runEnv)) if (v === undefined) delete runEnv[k];
    const p = Bun.spawn(
      pty ? ["python3", join(repo, "conformance/cli/pty.py"), "", ...command] : command,
      { cwd: dir, env: runEnv, stdout: "pipe", stderr: "pipe" },
    );
    // Each side runs in its own root; that directory alone is normalised.
    const own = (b: ArrayBuffer) =>
      Buffer.from(Buffer.from(b).toString("latin1").replaceAll(dir, "<root>"), "latin1");
    const out = own(await new Response(p.stdout).arrayBuffer());
    const err = own(await new Response(p.stderr).arrayBuffer());
    const code = await p.exited;
    if (code === 0 && !args.includes("--help")) successfulCommands++;
    const rows = [snapshot(join(dir, "db")), snapshot(join(dir, "omnigateway.db"))];
    const status = pty ? JSON.parse(out.toString()).code : code;
    assert.deepEqual(readdirSync(dir).sort(), files, "no files created");
    if (status !== 0 || args[0] === "catalog" || options.readOnly) {
      assert.deepEqual(rows, before, "failed or read-only command preserves every table");
    } else {
      for (const [n, snap] of rows.entries()) {
        const old = before[n];
        assert(old);
        assert.deepEqual(
          snap.filter((r) => r[0] !== "virtual_models"),
          old.filter((r) => r[0] !== "virtual_models"),
          "successful put preserves every other table",
        );
      }
    }
    assert(!out.includes("secret-sentinel") && !err.includes("secret-sentinel"));
    const result = { out, err, code, before, rows };
    await Bun.write(join(root, `${count}-${i}.json`), JSON.stringify({ args, options, ...result }));
    results.push(result);
  }
  try {
    assert.deepEqual(results[1], results[0], `${count}: ${JSON.stringify(args)}`);
  } catch (e) {
    if (process.env.OMNI_CLI_COLLECT_RED !== "1") throw e;
    red++;
    console.error(
      `RED ${count}: ${JSON.stringify(args)} ${JSON.stringify(options)} TS=${results[0]?.code}/${results[0]?.err} Rust=${results[1]?.code}/${results[1]?.err}`,
    );
  }
  count++;
}
function reset(
  models: Array<[string, string]> = [],
  accounts: Array<[string, string, string, string]> = [],
) {
  for (const dir of roots) {
    for (const file of ["db", "omnigateway.db"]) {
      const db = new Database(join(dir, file));
      db.run("DELETE FROM virtual_models");
      db.run("DELETE FROM credentials");
      for (const [id, targets] of models)
        db.run("INSERT INTO virtual_models VALUES (?,?,'score',0)", [id, targets]);
      for (const [id, provider, auth, data] of accounts)
        db.run(
          "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES (?,?,?,?,?,1,1)",
          [id, provider, id, auth, data],
        );
      db.close();
    }
  }
}

// ------------------------------------------------------------------ catalog
const ids = Object.keys(PROVIDER_DESCRIPTORS);
for (const args of [
  ["catalog"],
  ["catalog", "--json"],
  ["catalog", "--help"],
  ["catalog", "-h"],
  ["catalog", "ignored", "positional"],
  ["catalog", "--provider"],
  ["catalog", "--provider", "--json"],
  ["catalog", "--provider="],
  ["catalog", "--provider", ""],
  ["catalog", "--provider", "", "--json"],
  ["catalog", "--provider", "unknown"],
  ["catalog", "--provider", "unknown", "--json"],
  ["catalog", "--provider", "constructor"],
  ["catalog", "--provider", "__proto__", "--json"],
  ["catalog", "--provider", "Anthropic"],
  ["catalog", "--provider", "openai", "--provider", "kimi"],
  ["catalog", "--provider=grok", "--json"],
  ["catalog", "--wat"],
  ["catalog", "--json=1"],
  ["catalog", "--alias"],
  ["catalog", "-p", "openai"],
  ["catalog", "--no-color", "--yes"],
  ["catalog", "--yes=1"],
  ["catalog", "--help=1"],
  ["catalog", "--no-color=1"],
  ["catalog", "-yh"],
  ["catalog", "-y1"],
  ["catalog", "-1"],
  ["catalog", "-yé"],
  ["catalog", "-é"],
])
  await compare(args);
for (const id of ids) {
  await compare(["catalog", "--provider", id]);
  await compare(["catalog", "--provider", id, "--json"]);
  await compare(["catalog", "--provider", id], { pty: true });
}
await compare(["catalog"], { pty: true });
await compare(["catalog", "--json"], { pty: true });
await compare(["catalog", "--no-color"], { pty: true });
// pty.py drops the ambient NO_COLOR; PTY_NO_COLOR reaches the terminal as NO_COLOR.
for (const value of ["x", "0", ""])
  await compare(["catalog", "--provider", "openai"], {
    pty: true,
    extraEnv: { PTY_NO_COLOR: value },
  });
await compare(["catalog"], { pty: true, extraEnv: { PTY_NO_COLOR: "1" } });
await compare(["catalog", "--provider", "openai"], { rootEnv: true });
await compare(["catalog", "--provider", "kimi"], { prefix: ["--json"] });
// Catalog never opens the store, so configuration it cannot load is irrelevant.
await compare(["catalog", "--provider", "kimi"], { extraEnv: { OMNI_ENCRYPTION_KEY: undefined } });
await compare(["catalog", "--provider", "kimi"], { extraEnv: { OMNI_PORT: "nope" } });
await compare(["catalog", "--provider", "kimi"], {
  db: false,
  extraEnv: { OMNI_DB_PATH: "/wrong.db" },
});
await compare(["catalog", "--provider", "missing"], {
  db: false,
  extraEnv: { OMNI_DB_PATH: "/wrong.db", OMNI_ENCRYPTION_KEY: undefined },
});

// ------------------------------------------------------- put --from-catalog
reset();
const put = (spec: string | string[], ...rest: string[]) => [
  "put",
  "m",
  ...(Array.isArray(spec) ? spec : [spec]).flatMap((s) => ["--from-catalog", s]),
  ...rest,
];
await compare(put("anthropic:claude-opus-5"));
await compare(put("anthropic:claude-opus-5", "--json"));
for (const [id, descriptor] of Object.entries(PROVIDER_DESCRIPTORS))
  for (const model of descriptor.catalog.models) await compare(put(`${id}:${model.id}`, "--json"));
await compare(put(["openai:gpt-6-astra", "kimi:k3", "grok:grok-4.20"]));
await compare(put(["kimi:k3", "kimi:k3"], "--json"));
await compare(put(["muse:muse-spark-1.3", "antigravity:gemini-3.1-pro-high"], "--json"));
for (const strategy of ["score", "priority", "roundRobin", "weighted", "garbage", "", "SCORE"])
  await compare(put("kimi:k3", "--strategy", strategy));
await compare(put("kimi:k3", "--strategy=priority", "--json"));
await compare(put("kimi:k3", "--strategy", "garbage", "--strategy", "weighted"));
await compare(put("kimi:k3", "--strategy"));
await compare(put("kimi:k3", "--strategy", "--json"));
await compare(put("kimi:k3", "--alias", "--json"));
await compare(put("kimi:k3", "--alias", "--strategy", "roundRobin"));
await compare(put("kimi:k3", "--alias=true"));
await compare(put("kimi:k3", "--alias", "--alias"));
for (const spec of [
  "",
  ":",
  ":x",
  "anthropic",
  "anthropic:",
  "anthropic:x",
  "Anthropic:claude-opus-5",
  "constructor:x",
  "__proto__:x",
  "toString:x",
  "hasOwnProperty:claude-opus-5",
  "custom:x",
  "custom:",
  "qoder:x",
  "plugin:x",
  "anthropic:claude-opus-5:",
  " anthropic:claude-opus-5",
  "anthropic: claude-opus-5",
  "anthropic:claude-opus-5 ",
  "anthropic:CLAUDE-OPUS-5",
  "😀:x",
  "anthropic:é",
  "anthropic:claude-opus-5\u0001",
  "kilo:nvidia/nemotron-3-ultra-550b-a55b:free",
  "kilo:nvidia/nemotron-3-ultra-550b-a55b",
  "openai:gpt-5.6",
  "anthropic::claude-opus-5",
  "a:b:c",
])
  await compare(put(spec));
await compare(put(["kimi:k3", "kimi:missing", "nope:x"]));
await compare(put(["nope:x", "kimi:missing"]));
await compare(put(["kimi:k3", ":x"]));
await compare(["put", "m", "--from-catalog"]);
await compare(["put", "m", "--from-catalog", "--json"]);
await compare(["put", "m", "--from-catalog="]);
await compare(["put", "m", "--from-catalog=kimi:k3", "--json"]);
await compare(["put", "m", "--from-catalog", "kimi:k3", "-f", "model.json"]);
await compare(["put", "m", "-f", "missing.json", "--from-catalog", "nope:x"]);
await compare(["put", "m", "-fmissing.json", "--from-catalog=kimi:k3"]);
await compare(["put", "--from-catalog", "kimi:k3"]);
await compare(["put", "", "--from-catalog", "kimi:k3"]);
await compare(["put", "--from-catalog", "kimi:k3", "--", ""]);
await compare(["put", "a😀 b", "--from-catalog", "kimi:k3", "--json"]);
await compare(["put", "a😀 b", "--from-catalog", "kimi:k3"]);
await compare(["put", "m", "extra", "--from-catalog", "kimi:k3"]);
await compare(["put", "m", "--from-catalog", "kimi:k3", "--provider", "kimi"]);
await compare(["put", "m", "--from-catalog", "kimi:k3", "--wat"]);
await compare(["put", "--help"]);
await compare(["put", "m", "--from-catalog", "kimi:k3", "--help"]);
await compare(["put", "m", "-yf"]);
await compare(["put", "m", "-xfmodel.json"]);
await compare(["put", "m", "-yxf"]);
await compare(["put", "m", "-y1", "--from-catalog", "kimi:k3"]);
await compare(["put", "m", "-1", "--from-catalog", "kimi:k3"]);
await compare(put("kimi:k3", "-y", "--no-color"));
await compare(put("kimi:k3"), { prefix: ["--json"] });
await compare(put("kimi:k3"), { rootEnv: true });
await compare(put("kimi:k3"), { pty: true });
await compare(put("nope:x"), { pty: true });
await compare(put("kimi:k3", "--json"), { pty: true });

// Usage errors in the target list precede opening the store, whose
// configuration errors precede the schema.
for (const extraEnv of [{ OMNI_ENCRYPTION_KEY: undefined }, { OMNI_PORT: "nope" }]) {
  await compare(put("kimi:k3"), { extraEnv });
  await compare(put("nope:x"), { extraEnv });
  await compare(put("kimi:k3", "--strategy", "garbage"), { extraEnv });
}
// The ambient-database warning precedes every outcome, including usage errors.
for (const args of [put("kimi:k3"), put("nope:x"), put("kimi:k3", "--json"), ["put", "m"]])
  await compare(args, { db: false, extraEnv: { OMNI_DB_PATH: "/wrong.db" } });
await compare(put("kimi:k3"), {
  db: false,
  extraEnv: { OMNI_DB_PATH: "/wrong.db", OMNI_ENCRYPTION_KEY: undefined },
});

// Replacing, grandfathering, malformed stored state and credential reach.
const kiloFree = "nvidia/nemotron-3-ultra-550b-a55b:free";
const stored = (provider: string, model: string) =>
  JSON.stringify([
    {
      provider,
      model,
      tier: 3,
      weight: 2,
      costPerMTok: { input: 9, output: 9 },
      capabilities: { tools: false, images: false, reasoning: false },
    },
  ]);
reset([["m", stored("kimi", "old")]]);
await compare(put("kimi:k3", "--json"));
await compare(put(["openai:gpt-6-luna", "kimi:k3"], "--alias", "--strategy", "weighted"));
for (const raw of ["broken", "null", "{}", "[null]", "1e400"]) {
  reset([["m", raw]]);
  await compare(put("kimi:k3"));
}
for (const [provider, auth, spec] of [
  ["kilo", "oauth", `kilo:${kiloFree}`],
  ["kilo", "apiKey", `kilo:${kiloFree}`],
  ["kilo", "oauth", "kilo:kilo-auto/frontier"],
  ["kilo", "oauth", "kilo:anthropic/claude-opus-5"],
  ["antigravity", "apiKey", "antigravity:gemini-3.1-pro-high"],
  ["antigravity", "oauth", "antigravity:gemini-3.1-pro-high"],
  ["openai", "oauth", "openai:gpt-5.6"],
  ["openai", "apiKey", "openai:gpt-5.6"],
  ["anthropic", "oauth", "kilo:kilo-auto/small"],
] as const) {
  reset([], [["acct", provider, auth, "{}"]]);
  await compare(put(spec));
  await compare(put(["kimi:k3", spec], "--json"));
}
reset([["m", stored("kilo", kiloFree)]], [["acct", "kilo", "oauth", "{}"]]);
await compare(put(`kilo:${kiloFree}`));
reset([["other", stored("kilo", kiloFree)]], [["acct", "kilo", "oauth", "{}"]]);
await compare(put(`kilo:${kiloFree}`));
reset([], [["c", "custom", "apiKey", "null"]]);
await compare(put("kimi:k3"));
reset([], [["c", "custom", "apiKey", "broken"]]);
await compare(put("kimi:k3"));
reset([], [["c", "custom", "apiKey", '{"endpointId":"ep"}']]);
await compare(put("kimi:k3", "--json"));
await compare(put("kimi:k3", "--yes=x"));
await compare(put("kimi:k3", "--help=x"));
reset();

// --------------------------------------------- plugin discovery, no providers
// Frozen discovery imports a plugin's server entry only when its directory name
// is a plugin id, its manifest reads, parses and passes the schema, declares
// `provider`, is loadable and names a server entry. Every other installation
// has exactly the built-in registry; catalog and put print no plugin failures.
// Each server.js here writes a sentinel into the root if it is ever imported,
// which the unchanged-file-list check would catch.
const valid = { id: "acme", name: "Acme", version: "1.0.0", api: 3, server: "server.js" };
const provider = { ...valid, capabilities: ["provider"], origins: ["https://upstream.test"] };
const sentinel = (dir: string) =>
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "imported"))}, "yes");\nexport default { setup() { return {}; } };\n`;
type Setup = (pluginsDir: string, rootDir: string) => void;
function plugins(setup: Setup) {
  for (const dir of roots) {
    const home = join(dir, "plugins");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home);
    writeFileSync(join(home, "README"), "not a plugin");
    setup(home, dir);
  }
}
const place =
  (name: string, manifest: unknown, files: Record<string, string | null> = {}): Setup =>
  (home, dir) => {
    const at = join(home, name);
    mkdirSync(at, { recursive: true });
    if (manifest !== undefined)
      writeFileSync(
        join(at, "omni-plugin.json"),
        typeof manifest === "string" ? manifest : JSON.stringify(manifest),
      );
    for (const [file, text] of Object.entries({ "server.js": sentinel(dir), ...files }))
      if (text === null) mkdirSync(join(at, file), { recursive: true });
      else writeFileSync(join(at, file), text);
  };
const noProviders: Array<[string, Setup]> = [
  ["no plugins dir", (home) => rmSync(home, { recursive: true })],
  [
    "plugins is a file",
    (home) => {
      rmSync(home, { recursive: true });
      writeFileSync(home, "x");
    },
  ],
  ["empty subdirectory", (home) => mkdirSync(join(home, "acme"))],
  [
    "non-id directories",
    (home) => {
      for (const name of ["BAD", ".hidden", "-x", "a".repeat(33), "é", "1a"])
        place(name, provider)(home, join(home, ".."));
    },
  ],
  ["broken symlink", (home) => symlinkSync(join(home, "missing"), join(home, "acme"))],
  ["no manifest", place("acme", undefined)],
  ["manifest is a directory", place("acme", undefined, { "omni-plugin.json": null })],
  ["empty manifest", place("acme", "")],
  ["broken JSON", place("acme", '{"id":"acme","ca')],
  ["BOM manifest", place("acme", `\ufeff${JSON.stringify(provider)}`)],
  ...(["null", "[]", '"acme"', "3"] as const).map((raw): [string, Setup] => [
    `JSON ${raw}`,
    place("acme", raw),
  ]),
  ["server-only, no capabilities", place("acme", valid)],
  ["empty capabilities", place("acme", { ...valid, capabilities: [] })],
  ["storage capability", place("acme", { ...valid, capabilities: ["storage", "files"] })],
  [
    "net:outbound only",
    place("acme", { ...valid, capabilities: ["net:outbound"], origins: ["https://a.test"] }),
  ],
  [
    "UI-only plugin",
    place(
      "acme",
      { id: "acme", name: "Acme", version: "1", api: 3, ui: "ui.js", sdk: "^1" },
      { "ui.js": "x" },
    ),
  ],
  [
    "UI-only plugin, unloadable",
    place("acme", { id: "acme", name: "Acme", version: "1", api: 99, ui: "gone.js", sdk: "^9" }),
  ],
  // Provider-capable but schema-invalid: never imported.
  ["provider without origins", place("acme", { ...valid, capabilities: ["provider"] })],
  ["provider, empty origins", place("acme", { ...provider, origins: [] })],
  ...[
    "https://upstream.test/path",
    "HTTPS://upstream.test",
    "https://Upstream.test",
    "https://upstream.test:443",
    "http://upstream.test:80",
    "https://upstream.test?q",
    "https://upstream.test#f",
    "ftp://upstream.test",
    "https://",
    "upstream.test",
    "",
  ].map((origin): [string, Setup] => [
    `provider origin ${origin}`,
    place("acme", { ...provider, origins: [origin] }),
  ]),
  ["provider, unknown key", place("acme", { ...provider, extra: 1 })],
  [
    "provider, __proto__ key",
    place("acme", `{"__proto__":{},${JSON.stringify(provider).slice(1)}`),
  ],
  ["provider, name too long", place("acme", { ...provider, name: `${"😀".repeat(64)}x` })],
  ["provider, empty name", place("acme", { ...provider, name: "" })],
  ["provider, long version", place("acme", { ...provider, version: "1".repeat(33) })],
  ["provider, fractional api", place("acme", { ...provider, api: 3.5 })],
  ["provider, string api", place("acme", { ...provider, api: "3" })],
  ["provider, negative api", place("acme", { ...provider, api: -1 })],
  ["provider, bad capability", place("acme", { ...provider, capabilities: ["provider", "x"] })],
  ["provider, null capabilities", place("acme", { ...provider, capabilities: null })],
  ["provider, ui without sdk", place("acme", { ...provider, ui: "ui.js" })],
  ["provider, empty sdk", place("acme", { ...provider, sdk: "" })],
  ["provider, defaults array", place("acme", { ...provider, defaults: [] })],
  ["provider, defaults null", place("acme", { ...provider, defaults: null })],
  ["provider, nav extra", place("acme", { ...provider, nav: { label: "x", y: 1 } })],
  ["provider, long nav", place("acme", { ...provider, nav: { label: "x".repeat(33) } })],
  ["provider, absolute server", place("acme", { ...provider, server: "/server.js" })],
  ["provider, dotdot server", place("acme", { ...provider, server: "a/../server.js" })],
  ["provider, empty server", place("acme", { ...provider, server: "" })],
  ["provider, uppercase id", place("acme", { ...provider, id: "Acme" })],
  ["provider, no entries", place("acme", { ...provider, server: undefined })],
  // Valid provider manifests that are not loadable, or have no server entry.
  ["provider, id mismatch", place("acme", { ...provider, id: "other" })],
  ["provider, old api", place("acme", { ...provider, api: 2 })],
  ["provider, missing server file", place("acme", { ...provider, server: "gone.js" })],
  ["provider, server is a directory", place("acme", { ...provider, server: "lib" }, { lib: null })],
  ["provider, server is the plugin dir", place("acme", { ...provider, server: "." })],
  [
    "provider, ui-only entry",
    place("acme", { ...provider, server: undefined, ui: "ui.js", sdk: "^1" }, { "ui.js": "x" }),
  ],
];
for (const [name, setup] of noProviders) {
  plugins(setup);
  for (const args of [
    ["catalog", "--provider", "kimi", "--json"],
    ["catalog", "--provider", "kimi"],
    put("kimi:k3", "--json"),
    put("nope:x"),
  ]) {
    try {
      await compare(args, { readOnly: args[0] === "catalog" });
    } catch (e) {
      console.error(`case: ${name}`);
      throw e;
    }
  }
}
// Unreadable manifest: TS reads null and records a failure; nothing is imported.
plugins(place("acme", provider));
for (const dir of roots) chmodSync(join(dir, "plugins", "acme", "omni-plugin.json"), 0);
await compare(["catalog", "--provider", "kimi", "--json"]);
await compare(put("kimi:k3"));
for (const dir of roots) chmodSync(join(dir, "plugins", "acme", "omni-plugin.json"), 0o644);

// ------------------------------------------- actual provider plugins: refused
// Documented divergence, not a golden. A plugin that passes every check above
// is imported by frozen TS, which merges whatever providers it declares. Rust
// cannot run plugin code, so it refuses rather than answer from the built-ins
// alone. Each case first proves TS imports the entry, then that Rust refuses
// without importing or writing.
const declaring = (dir: string) =>
  `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "imported"))}, "yes");
export default {
  providers: [{
    descriptor: {
      id: "acme",
      capabilities: { tools: true, images: false, reasoning: false },
      writeOverInput: { fiveMinute: 0, oneHour: 0 },
      catalog: { defaultModel: "acme-1", authTypes: ["apiKey"], models: [{
        id: "acme-1", label: "Acme One",
        pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
        limits: { contextWindow: 123000, maxOutputTokens: 4096 },
      }] },
      modelPrefixes: [],
      presentation: { label: "Acme", order: 90, tone: "cyan", colour: { light: "x", dark: "y" } },
    },
    codec: { buildRequest: () => ({}), decode: async function* () {} },
  }],
  setup() { return {}; },
};
`;
let refused = 0;
for (const [name, files, contributes] of [
  ["declares a provider", (dir: string) => ({ "server.js": declaring(dir) }), true],
  ["imports but declares none", (dir: string) => ({ "server.js": sentinel(dir) }), false],
  [
    "valid via symlinked directory and odd entry spelling",
    (dir: string) => ({ "server.js": declaring(dir) }),
    true,
  ],
] as const) {
  const [tsRoot, rustRoot] = roots;
  const [tsCommand, rustCommand] = commands;
  assert(tsRoot && rustRoot && tsCommand && rustCommand);
  const symlinked = name.startsWith("valid via symlinked");
  for (const dir of roots) {
    const home = join(dir, "plugins");
    rmSync(home, { recursive: true, force: true });
    rmSync(join(dir, "imported"), { force: true });
    rmSync(join(dir, "elsewhere"), { recursive: true, force: true });
    mkdirSync(home);
    const at = symlinked ? join(dir, "elsewhere") : join(home, "acme");
    place(
      "",
      { ...provider, ...(symlinked ? { server: "./server.js", sdk: "^99", ui: "gone.js" } : {}) },
      files(dir),
    )(at, dir);
    if (symlinked) symlinkSync(at, join(home, "acme"));
  }
  const ts = Bun.spawn(
    [...tsCommand, "--root", tsRoot, "--db", "db", "models", "catalog", "--json"],
    { cwd: tsRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  const tsOut = await new Response(ts.stdout).text();
  assert.equal(await ts.exited, 0, name);
  assert(existsSync(join(tsRoot, "imported")), `${name}: TS imported the plugin`);
  assert.equal(tsOut.includes('"provider": "acme"'), contributes, name);
  for (const args of [["catalog"], ["catalog", "--json"], put("kimi:k3"), put("nope:x")]) {
    const before = snapshot(join(rustRoot, "db"));
    const p = Bun.spawn([...rustCommand, "--root", rustRoot, "--db", "db", "models", ...args], {
      cwd: rustRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    assert.equal(await p.exited, 1, JSON.stringify(args));
    assert.equal(out, "");
    assert.equal(
      err,
      `plugin providers are not supported by this Rust CLI; acme in ${join(rustRoot, "plugins")} declares one\n`,
    );
    assert.deepEqual(snapshot(join(rustRoot, "db")), before);
    assert(!existsSync(join(rustRoot, "imported")), "Rust never imports plugin code");
    refused++;
  }
}
for (const dir of roots) {
  rmSync(join(dir, "imported"), { force: true });
  rmSync(join(dir, "elsewhere"), { recursive: true, force: true });
}
plugins(() => {});
console.log(`PASS plugin refusal ${refused} Rust-only checks`);
if (red > 0) {
  console.log(`RED ${red} of ${count} catalog comparisons`);
  process.exit(1);
}
assert(successfulCommands > 0, "must exercise successful catalog commands");
console.log(`PASS ${count} catalog comparisons`);
