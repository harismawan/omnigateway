// Real frozen-TS entrypoint versus Rust process: bytes, streams, and status.
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { requestLog } from "../../packages/testkit/src/index.ts";

const repo = resolve(import.meta.dir, "../..");
const binary = resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni");
const rust = [binary, ...(process.env.OMNI_CLI_SUBCOMMAND === "1" ? ["omni"] : [])];
const root = mkdtempSync("/tmp/opencode/cli-golden-");
const secret = "golden-secret-at-least-sixteen";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OMNI_")));
Object.assign(env, { OMNI_ENCRYPTION_KEY: secret, NO_COLOR: "1", HOME: root });
const ts = ["bun", "--no-env-file", join(repo, "apps/cli/src/index.ts")];
async function invoke(cmd: string[], args: string[], cwd = root, extra = {}) {
  const p = Bun.spawn([...cmd, ...args], {
    cwd,
    env: { ...env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err, code };
}
let count = 0;
async function check(args: string[], cwd = root, extra = {}) {
  const expected = await invoke(ts, args, cwd, extra);
  const actual = await invoke(rust, args, cwd, extra);
  assert.deepEqual(actual, expected, JSON.stringify(args));
  assert(!actual.out.includes("confidential-hash"));
  count++;
}
try {
  writeFileSync(
    join(root, ".env"),
    `export OMNI_ENCRYPTION_KEY='${secret}'\nOMNI_DB_PATH="keys.db"\n`,
  );
  await check(["keys", "list"]);
  await check(["--json", "keys", "list"]);
  const store = await createStore({
    path: join(root, "keys.db"),
    encryptionKey: await deriveKey(secret),
  });
  store.close();
  const db = new Database(join(root, "keys.db"));
  for (const [i, limits, models, expiry, revoked] of [
    [1, "{}", null, null, null],
    [
      2,
      '{"spend":{"1w":0.0000001},"requests":{"5h":10,"1m":5},"concurrency":2,"models":{"z":{"tokens":{"1w":100}}}}',
      '["m","z"]',
      1,
      null,
    ],
    [3, "bad", "[]", 9000000000000000, 100],
  ] as const) {
    db.run(
      `INSERT INTO api_keys (id,label,prefix,hash,model_allowlist,limits,created_at,expires_at,revoked_at,body_logging_opt_out,guardrail_policy,smart_routing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `k${i}`,
        `label ${i} 🌍`,
        "sk-omni-test",
        `confidential-hash-${i}`,
        models,
        limits,
        1700000000000 + i,
        expiry,
        revoked,
        i === 2 ? 1 : 0,
        i === 2 ? "policy" : null,
        i === 2 ? 1 : 0,
      ],
    );
  }
  db.close();
  const usage = await createStore({
    path: join(root, "keys.db"),
    encryptionKey: await deriveKey(secret),
  });
  const now = Date.now();
  for (const [i, age, model] of [
    [1, 10_000, "z"],
    [2, 7_200_000, "other"],
    [3, 20_000_000, "z"],
    [4, 700_000_000, "z"],
  ] as const) {
    await usage.usage.append(
      requestLog({
        id: `r${i}`,
        apiKeyId: "k2",
        at: now - age,
        requestedModel: model,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        costUsd: 0.125,
      }),
    );
  }
  usage.close();
  const pending = new Database(join(root, "keys.db"));
  // Pending traffic must not inflate committed usage; the key-wide reader
  // also needs its rollup, while the model reader scans only matching logs.
  pending.run("UPDATE request_logs SET state='pending' WHERE id='r1'");
  pending.close();
  for (const args of [
    ["keys", "list"],
    ["keys", "list", "--json"],
    ["--root", root, "--json", "keys", "list"],
    ["keys", "list", "ignored", "--", "--bad"],
    ["keys", "list", "-yy", "--no-color"],
    ["keys", "list", "--db=keys.db", "--json"],
    ["keys", "list", "--db", " "],
    ["keys", "list", "--bad"],
    ["keys", "list", "--system"],
    ["keys", "list", "-x"],
    ["keys", "list", "--json=true"],
    ["keys", "list", "--db"],
    ["keys", "list", "--db", "--json"],
    ["keys", "list", "--bad", "--help"],
    ["keys", "list", "--version"],
    ["nonsense"],
    [`--root=${root}`, "keys", "list", "--json", "--json"],
    ["keys", "list", "--root", `${root}/sub/..`, "--db", "keys.db"],
    ["keys", "list", "--db=--dash.db"],
    ["keys", "list", "--db", "missing/path.db"],
  ])
    await check(args);
  await check(["keys", "list"], root, { OMNI_PORT: "bad" });
  await check(["keys", "list"], root, { OMNI_TRACE_SAMPLE: "bad" });
  await check(["keys", "list", "--root", root], root, {
    OMNI_ENCRYPTION_KEY: "wrong",
    OMNI_DB_PATH: "/wrong.db",
  });
  const fresh = join(root, "fresh");
  mkdirSync(fresh);
  await check(["--root", fresh, "keys", "list"], root, { OMNI_DB_PATH: "/wrong.db" });
  await check(["keys", "list"], fresh, { OMNI_ROOT: root });
  mkdirSync(join(root, ".config/omnigateway"), { recursive: true });
  await check(["keys", "list"], fresh);
  await check(["--root", fresh, "keys", "list"], root, { OMNI_ENCRYPTION_KEY: "" });
  await check(["keys", "list", "--root", fresh, "--db", "", "--json"], root, {
    OMNI_DB_PATH: "/wrong.db",
  });
  for (const extra of [
    { OMNI_PORT: "0" },
    { OMNI_METRICS_MAX_SERIES: "0" },
    { OMNI_CLUSTER_MODE: "true" },
    { OMNI_DATABASE_URL: "postgres://x" },
  ])
    await check(["keys", "list"], root, extra);
  writeFileSync(
    join(fresh, ".env"),
    `# own-line comment\nexport OMNI_ENCRYPTION_KEY = '${secret}'\nOMNI_DB_PATH = "literal-$HOME\\n.db"\nignored line\n`,
  );
  await check(["keys", "list", "--root", fresh, "--json"], root, {
    OMNI_DB_PATH: "/wrong.db",
    OMNI_ENCRYPTION_KEY: "bad",
  });
  if (process.env.OMNI_CLI_BENCH === "1") {
    const batches = [];
    for (let batch = 0; batch < 3; batch++) {
      const times = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        const result = await invoke(rust, ["--root", root, "--json", "keys", "list"]);
        assert.equal(result.code, 0);
        JSON.parse(result.out);
        times.push(performance.now() - start);
      }
      const sorted = [...times].sort((a, b) => a - b);
      batches.push({ timesMs: times, p50Ms: sorted[4], maxMs: sorted[9] });
    }
    console.log(
      JSON.stringify(
        {
          binary,
          sha256: new Bun.CryptoHasher("sha256")
            .update(await Bun.file(binary).arrayBuffer())
            .digest("hex"),
          batches,
        },
        null,
        2,
      ),
    );
  }
  console.log(`PASS ${count} real TS/Rust golden comparisons`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
