// Review A5-R1: a key whose stored limits and allowlist hold lone surrogates
// (what the `/api` surface stores for a client's JS strings) beside a real
// U+FFFD, through the CLI's list and edit paths. Frozen TS and Rust run on
// equal roots; stdout, stderr, exit code and the whole `api_keys` table are
// compared after every command.
//
// The last block is the review's own repro: keys created over `/api` by the
// Rust gateway (`OMNI_GATEWAY_BIN`, default `target/debug/omnigateway`), then
// listed by both CLIs from copies of that one database.
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/lone-surrogates-");
const repo = resolve(import.meta.dir, "../..");
const secret = "lone-surrogate-golden-secret";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OMNI_")));
Object.assign(env, { OMNI_ENCRYPTION_KEY: secret, NO_COLOR: "1", HOME: root });
const commands = [
  ["bun", "--no-env-file", join(repo, "apps/cli/src/index.ts")],
  [
    resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni"),
    ...(process.env.OMNI_CLI_SUBCOMMAND === "1" ? ["omni"] : []),
  ],
];
const LIMITS =
  '{"requests":{"1m":5},"models":{"\\ud800":{"concurrency":1},"\\ufffd":{"requests":{"1m":2}},"7":{"tokens":{"5h":9}},"\\udc00x":{"spend":{"1w":1.5}}}}';
const ALLOW = '["\\ud800","\\ufffd","x","\\udc00"]';
// The cap counts every override: 63 well-formed names and one lone surrogate
// are the 64 a key may hold, so one more is refused and a removal makes room.
const FULL = `{"models":{${[
  ...Array.from({ length: 63 }, (_, i) => `"m${i}":{"concurrency":1}`),
  '"\\ud800":{"concurrency":2}',
].join(",")}}}`;
// Only lone-surrogate overrides: an edit that names none of them keeps them.
const ONLY = '{"models":{"\\udc00":{"requests":{"1m":3}},"\\ud800":{"concurrency":1}}}';
let count = 0;
let failures = 0;
try {
  const roots = [join(root, "ts"), join(root, "rs")];
  for (const dir of roots) {
    mkdirSync(dir);
    const store = await createStore({
      path: join(dir, "db"),
      encryptionKey: await deriveKey(secret),
    });
    store.close();
    const db = new Database(join(dir, "db"));
    db.run(
      "INSERT INTO api_keys (id,label,prefix,hash,limits,model_allowlist,created_at) VALUES (?,?,?,?,?,?,?)",
      ["k", "lone", "sk-omni-test", "h", LIMITS, ALLOW, 1700000000000],
    );
    for (const [id, limits, at] of [
      ["full", FULL, 1700000000001],
      ["only", ONLY, 1700000000002],
      [
        "order-exact",
        '{"models":{"a":{"concurrency":1},"\\ud800":{"concurrency":1},"b":{"concurrency":1}}}',
        1700000000005,
      ],
      [
        "nulls",
        '{"models":{"\\ud800":{"requests":{"1m":null},"tokens":{},"concurrency":1}}}',
        1700000000003,
      ],
      [
        "order",
        '{"models":{"a":{"concurrency":1},"\\ud800":{"concurrency":1},"b":{"concurrency":1},"�":{"concurrency":1}}}',
        1700000000004,
      ],
    ] as const)
      db.run("INSERT INTO api_keys (id,label,prefix,hash,limits,created_at) VALUES (?,?,?,?,?,?)", [
        id,
        id,
        "sk-omni-test",
        `h-${id}`,
        limits,
        at,
      ]);
    db.close();
  }
  const run = async (i: number, args: string[], dirs = roots) => {
    const command = commands[i];
    const dir = dirs[i];
    assert(command && dir);
    const p = Bun.spawn([...command, "--root", dir, "--db", "db", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    const db = new Database(join(dir, "db"), { readonly: true });
    const rows = db.query("SELECT * FROM api_keys ORDER BY id").all();
    db.close();
    return { out, err, code, rows };
  };
  for (const args of [
    [
      "keys",
      "limits",
      "order-exact",
      "--unset-model-limit",
      "a:concurrency",
      "--model-limit",
      "a:concurrency=2",
      "--json",
    ],
    ["keys", "limits", "nulls", "--set", "concurrency=2", "--json"],
    [
      "keys",
      "limits",
      "order",
      "--unset-model-limit",
      "a:concurrency",
      "--model-limit",
      "a:concurrency=2",
      "--json",
    ],
    // OS argv encodes lone JS strings as U+FFFD in both processes. These
    // attempts must edit the real replacement name, never its lone sibling.
    ["keys", "limits", "order", "--unset-model-limit", "\ud800:concurrency", "--json"],
    ["keys", "limits", "order", "--model-limit", "\ud800:concurrency=3", "--json"],
    [
      "keys",
      "limits",
      "order",
      "--unset-model-limit",
      "\ud800:concurrency",
      "--model-limit",
      "\ud800:concurrency=4",
      "--json",
    ],
    ["keys", "models", "order", "--allow", "\ud800", "--allow", "b", "--allow", "�", "--json"],
    [
      "keys",
      "limits",
      "order",
      "--unset-model-limit",
      "b:concurrency",
      "--model-limit",
      "b:concurrency=5",
      "--json",
    ],
    ["keys", "list"],
    ["keys", "list", "--json"],
    ["keys", "limits", "k"],
    ["keys", "limits", "k", "--json"],
    ["keys", "models", "k"],
    ["keys", "limits", "k", "--set", "concurrency=3", "--json"],
    ["keys", "limits", "k", "--model-limit", "m:concurrency=2"],
    ["keys", "limits", "k", "--unset-model-limit", "7:tokens:5h", "--json"],
    ["keys", "expiry", "k", "--never", "--json"],
    ["keys", "smart-routing", "k", "--on", "--json"],
    ["keys", "guardrail", "k", "--policy", "p", "--json"],
    ["keys", "list", "--json"],
    ["keys", "models", "k", "--allow", "y", "--json"],
    ["keys", "list"],
    ["keys", "limits", "full", "--model-limit", "one-more:concurrency=1", "--json"],
    ["keys", "limits", "full", "--model-limit", "one-more:concurrency=1"],
    ["keys", "limits", "full", "--model-limit", "m5:concurrency=9", "--json"],
    ["keys", "limits", "full", "--unset-model-limit", "m0:concurrency", "--json"],
    ["keys", "limits", "full", "--model-limit", "one-more:concurrency=1", "--json"],
    ["keys", "limits", "only", "--set", "requests:1m=4", "--json"],
    ["keys", "limits", "only", "--model-limit", "a:concurrency=1", "--json"],
    ["keys", "limits", "only", "--unset-model-limit", "a:concurrency", "--json"],
    ["keys", "limits", "only", "--unset", "requests:1m"],
    ["keys", "limits", "only"],
    ["keys", "list", "--json"],
    ["keys", "list"],
  ]) {
    const [ts, rs] = [await run(0, args), await run(1, args)];
    count++;
    try {
      assert.deepEqual(rs, ts, JSON.stringify(args));
    } catch (e) {
      failures++;
      console.error(`FAIL ${JSON.stringify(args)}\n${(e as Error).message.slice(0, 1500)}`);
    }
  }

  // Keys created over the API, as an operator's client would.
  const gateway = resolve(process.env.OMNI_GATEWAY_BIN ?? "target/debug/omnigateway");
  assert(existsSync(gateway), `no gateway binary at ${gateway}: cargo build -p omni-gateway`);
  const apiRoots = [join(root, "api-ts"), join(root, "api-rs")];
  for (const dir of apiRoots) mkdirSync(dir);
  const [tsRoot, rsRoot] = apiRoots as [string, string];
  const port = 18617;
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([gateway], {
    cwd: rsRoot,
    env: {
      ...env,
      OMNI_DB_PATH: join(rsRoot, "db"),
      OMNI_ROOT: rsRoot,
      OMNI_HOST: "127.0.0.1",
      OMNI_PORT: String(port),
      OMNI_STATIC_DIR: join(rsRoot, "no-dashboard"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const ids: string[] = [];
  try {
    let healthy = false;
    for (let i = 0; i < 400 && !healthy; i++) {
      healthy = await fetch(`${base}/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (!healthy) await Bun.sleep(25);
    }
    assert(healthy, "the gateway did not come up");
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      body: '{"password":"correct-horse-battery"}',
    });
    const cookie = setup.headers.get("set-cookie")?.split(";")[0];
    assert(cookie, `setup: ${setup.status}`);
    for (const body of [
      // The review's body, verbatim.
      '{"limits":{"models":{"\\ud800":{"concurrency":1}}}}',
      `{"label":"mixed","limits":${LIMITS},"modelAllowlist":${ALLOW}}`,
    ]) {
      const made = await fetch(`${base}/api/keys`, { method: "POST", headers: { cookie }, body });
      assert.equal(made.status, 200, await made.clone().text());
      ids.push(((await made.json()) as { id: string }).id);
    }
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }
  // One database, two copies: whatever the gateway left in its WAL included.
  const made = new Database(join(rsRoot, "db"));
  made.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const stored = made.query("SELECT limits FROM api_keys ORDER BY created_at, rowid").all();
  made.close();
  assert.deepEqual(
    stored[0],
    { limits: '{"models":{"\\ud800":{"concurrency":1}}}' },
    "the API stores the lone override as its escape",
  );
  copyFileSync(join(rsRoot, "db"), join(tsRoot, "db"));
  for (const args of [
    ["keys", "list", "--json"],
    ["keys", "list"],
    ...ids.flatMap((id) => [
      ["keys", "limits", id, "--json"],
      ["keys", "limits", id],
      ["keys", "models", id, "--json"],
    ]),
    ["keys", "limits", ids[0] as string, "--set", "requests:5h=7", "--json"],
    ["keys", "list", "--json"],
  ]) {
    const [ts, rs] = [await run(0, args, apiRoots), await run(1, args, apiRoots)];
    count++;
    try {
      assert.deepEqual(rs, ts, JSON.stringify(args));
      if (args.join(" ") === "keys list --json")
        assert(
          ts.out.includes('"\\ud800": {\n            "concurrency": 1') &&
            ts.out.includes('"model": "\\ud800"'),
          "the listing shows the lone override and its limitUsage entry",
        );
    } catch (e) {
      failures++;
      console.error(`FAIL api ${JSON.stringify(args)}\n${(e as Error).message.slice(0, 1500)}`);
    }
  }
  assert.equal(failures, 0, `${failures}/${count} lone-surrogate CLI comparisons differ`);
  console.log(`PASS ${count} lone-surrogate CLI comparisons (bytes, status, whole api_keys table)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
