// Real frozen TS/Rust bytes and whole rows, using isolated equivalent roots.
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey, hashApiKey, keyUsable } from "../../packages/store/src/index.ts";
import { requestLog } from "../../packages/testkit/src/index.ts";

const root = mkdtempSync("/tmp/opencode/key-mutations-");
const repo = resolve(import.meta.dir, "../..");
const secret = "mutation-golden-secret";
const rawKey = `sk-omni-${"a".repeat(43)}`;
const hash = await hashApiKey(rawKey);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OMNI_")));
Object.assign(env, { OMNI_ENCRYPTION_KEY: secret, NO_COLOR: "1", HOME: root });
const commands = [
  ["bun", "--no-env-file", join(repo, "apps/cli/src/index.ts")],
  [
    resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni"),
    ...(process.env.OMNI_CLI_SUBCOMMAND === "1" ? ["omni"] : []),
  ],
];
if (process.env.OMNI_CLI_SYMLINK === "1") {
  const link = join(root, "omni");
  const binary = commands[1]?.[0];
  assert(binary);
  symlinkSync(binary, link);
  commands[1] = [link];
}
let count = 0;
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
    db.run("INSERT INTO api_keys (id,label,prefix,hash,limits,created_at) VALUES (?,?,?,?,?,?)", [
      "k",
      "staff",
      "sk-omni-test",
      hash,
      "{}",
      1700000000000,
    ]);
    db.close();
  }
  writeFileSync(join(root, "policy"), "  Work only.\nRefuse roleplay.\n");
  const cases = [
    ["limits", "k", "--model-limit", "m:concurrency=2", "--json"],
    ["limits", "k", "--unset", "models", "--json"],
    ["limits", "k", "--unset", "models:m", "--set", "concurrency=3", "--json"],
    ...["limits", "expiry", "models", "guardrail", "smart-routing", "revoke"].map((c) => [
      c,
      "",
      "--json",
    ]),
    ...[
      "+275760-09-13T00:00:00",
      "+275760-09-13T00:00:00.001",
      "+275760-09-13T01:00:00+01:00",
      "02/30/2030",
      "02/29/2028",
      "02/29/2030",
      "04/31/2030",
      "02/32/2030",
      "13/01/2030",
    ].map((at) => ["expiry", "k", "--at", at, "--json"]),
    ["limits", "k", "--set", "spend:5h=1.125"],
    ["limits", "k", "--set", "spend:5h=1e21"],
    ...["2030-03-10 02:30:00", "2030-11-03 01:30:00"].map((at) => [
      "expiry",
      "k",
      "--at",
      at,
      "--json",
    ]),
    ...[256, 257].map((n) => [
      "limits",
      "k",
      "--model-limit",
      `${"🌍".repeat(n)}:concurrency=1`,
      "--json",
    ]),
    ...[64, 65].map((n) => [
      "limits",
      "k",
      ...Array.from({ length: n }, (_, i) => ["--model-limit", `m${i}:concurrency=1`]).flat(),
      "--json",
    ]),
    ...["2030/01/01", "01/02/30", "2030-03-10T02:30:00", "2030-11-03T01:30:00"].map((at) => [
      "expiry",
      "k",
      "--at",
      at,
      "--json",
    ]),
    ["limits", "k"],
    ["limits", "k", "--set", "requests:1m=0x10", "--set", "concurrency=2", "--json"],
    [
      "limits",
      "k",
      "--model-limit",
      "llama3:8b:tokens:1w=100",
      "--model-limit",
      "2:concurrency=1",
      "--model-limit",
      "constructor:requests:5h=2",
      "--json",
    ],
    ["limits", "k", "--unset", "requests:1m", "--set", "requests:1m=5", "--json"],
    ["limits", "k", "--unset-model-limit", "llama3:8b:tokens:1w", "--json"],
    ["limits", "k"],
    ["limits", "k", "--set", "spend:5h=0.01"],
    ["limits", "k", "--unset-model-limit", "absent:concurrency"],
    ["limits", "k", "--unset", "__proto__"],
    ["limits", "k", "--unset", "concurrency", "--unset", "concurrency"],
    ["limits", "k", "--set", "spend:5h=2.5", "--set", "tokens:1w=0b100"],
    [
      "limits",
      "k",
      "--model-limit",
      "tier=gold:concurrency=2",
      "--model-limit",
      "toString:tokens:1m=3",
      "--json",
    ],
    ["limits", "k", "--model-limit", "__proto__:concurrency=1"],
    ["limits", "k", "--model-limit", "x:requests=1"],
    [
      "limits",
      "k",
      "--model-limit",
      "x:requests:1m=2",
      "--model-limit",
      "x:requests:1m=3",
      "--json",
    ],
    ["limits", "k", "--set", "foo🌍=2"],
    ["limits", "k", "--set", "requests:1m=9007199254740992"],
    ["limits", "k", "--set", "requests=2"],
    ["limits", "k", "--set", "concurrency:1m=2"],
    ...[
      "requests",
      "requests:__proto__=2",
      "models=2",
      "foo=1",
      "requests:9m=2",
      "tokens:1m=1.2",
      "spend:1m=1",
      "concurrency=0",
      "requests:1m=",
      "requests:1m=Infinity",
    ].map((set) => ["limits", "k", "--set", set]),
    ["limits", "k", "--unset", "requests:5h"],
    ["limits", "missing", "--set", "bad"],
    ["expiry", "k"],
    ["expiry", "k", "--at", "2030-01-01"],
    ...[
      "2030",
      "2030-01",
      "2030-1-1",
      " 2030-01-01 ",
      "12/31/2030",
      "January 1, 2030",
      "Tue, 01 Jan 2030 00:00:00 GMT",
      "0",
      "1",
      "49",
      "50",
      "99",
      "100",
      "2030-13-01",
      "2030-01-32",
      "2030-01-01T25:00:00Z",
      "2030-01-01T00:00:00.123456Z",
      "2030-01-01T00:00:00.🌍Z",
      "2030-01-01T00:00:00+🌍",
      "2030-01-01T00:00:00.Z",
    ].map((at) => ["expiry", "k", "--at", at, "--json"]),
    ["expiry", "k", "--at", "2001-01-01", "--json"],
    ["expiry", "k", "--never"],
    ["expiry", "k", "--at", "2030-02-30", "--json"],
    ["expiry", "k", "--at", "2030-01-01T24:00:00Z", "--json"],
    ["expiry", "k", "--at", "2030-01-01T00:00:00+02:00", "--json"],
    ["expiry", "k", "--at", "2030-01-01T12:00:00", "--json"],
    ["expiry", "k", "--at", "+275760-09-13", "--json"],
    ["expiry", "k", "--at", "+275760-09-14"],
    ["expiry", "k", "--at", "1970-01-01"],
    ["expiry", "k", "--at", "1969-01-01"],
    ["expiry", "k", "--at", "not-a-date"],
    ...[
      "2030-01-01T-1:00Z",
      "2030-01-01T00:-1Z",
      "2030-01-01T00:00:-1Z",
      "2030-01-01T00:00:00+00:-1",
      "2030-01-01T00:00:00+0:000",
      "+275760-09-13T00:00:00.001Z",
      "-271821-04-20",
      "-000000-01-01",
    ].map((at) => ["expiry", "k", `--at=${at}`]),
    ["expiry", "k", "--at", "2030", "--never"],
    ["expiry", "missing", "--at", "bad"],
    ["expiry", "k", "--never", "--json"],
    ["smart-routing", "k", "--on"],
    ["smart-routing", "k", "--off", "--json"],
    ["smart-routing", "k"],
    ["smart-routing", "k", "--on", "--off"],
    ["smart-routing", "missing", "--on"],
    ["smart-routing", "--on"],
    ["models", "k"],
    ["models", "k", "--none"],
    ["models", "k", "--all", "--json"],
    ["models", "k", "--allow", "llama3:8b", "--allow", "constructor", "--allow", "2"],
    ["models", "k", "--json"],
    ["models", "k", "--all", "--none"],
    ["models", "k", "--allow", "a,b", "--allow", "a,b"],
    ["models", "k", "--allow="],
    ["models", "missing", "--all", "--none"],
    ["guardrail", "k"],
    ["guardrail", "k", "--policy", "  Work only.  "],
    ["guardrail", "k", "--policy-file", join(root, "policy"), "--json"],
    ["guardrail", "k", "--policy", "   "],
    ["guardrail", "k", "--policy", "x", "--clear"],
    ["guardrail", "k", "--policy-file", "absent"],
    ["guardrail", "k", "--clear"],
    ["guardrail", "k", "--policy", "first", "--policy", "last", "--json"],
    ["guardrail", "k", "--policy", "p".repeat(4000), "--json"],
    ["guardrail", "k", "--policy", "p".repeat(4001)],
    ["guardrail", "k", "--policy", "🌍".repeat(2001)],
    ["guardrail", "k", "--policy", "🌍".repeat(4001)],
    ["guardrail", "k", "--policy", "\ufeff x \ufeff"],
    ["guardrail", "k", "--policy-file", "-"],
    ["models", "k", "--help"],
    ["guardrail", "k", "--help"],
    ["smart-routing", "--help"],
    ["revoke", "--help"],
    ["revoke", "k"],
    ["revoke", "missing", "-y"],
    ["revoke", "k", "-y"],
    ["revoke", "k", "--yes", "--json"],
  ];
  for (const args of cases) {
    if (
      args.some((a) => a.startsWith("🌍") || a === "m0:concurrency=1") ||
      args.join(" ") === "expiry k --at 2030/01/01 --json"
    ) {
      for (const dir of roots) {
        const db = new Database(join(dir, "db"));
        db.run("UPDATE api_keys SET limits='{}'");
        db.close();
      }
    }
    const before = Date.now();
    const outputs = [],
      rows = [];
    for (const i of [0, 1]) {
      const command = commands[i];
      const dir = roots[i];
      assert(command && dir);
      const proc = Bun.spawn([...command, "keys", ...args, "--root", dir, "--db", "db"], {
        cwd: roots[i],
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.end("yes\n");
      outputs.push({
        out: Buffer.from(await new Response(proc.stdout).arrayBuffer()),
        err: Buffer.from(await new Response(proc.stderr).arrayBuffer()),
        code: await proc.exited,
      });
      const db = new Database(join(dir, "db"));
      rows.push(db.query("SELECT * FROM api_keys ORDER BY id").all() as Record<string, unknown>[]);
      db.close();
      const store = await createStore({
        path: join(dir, "db"),
        encryptionKey: await deriveKey(secret),
      });
      const key = await store.keys.findByHash(await hashApiKey(rawKey));
      assert(key);
      assert.equal(
        keyUsable(key, Date.now()),
        key.revokedAt === null && (key.expiresAt === null || key.expiresAt > Date.now()),
      );
      store.close();
    }
    assert.deepEqual(outputs[1], outputs[0], JSON.stringify(args));
    for (const rs of rows)
      for (const row of rs) {
        if (args[0] === "revoke" && !args.includes("--help") && outputs[0]?.code === 0) {
          assert(
            typeof row.revoked_at === "number" &&
              row.revoked_at >= before &&
              row.revoked_at <= Date.now(),
          );
          row.revoked_at = "validated-revoke-time";
        }
      }
    assert.deepEqual(rows[1], rows[0], `persisted ${JSON.stringify(args)}`);
    for (const out of outputs) {
      assert(!out.out.includes(hash));
      assert(!out.out.includes(rawKey));
    }
    count++;
  }
  for (const value of [
    '["a,b",["c","d"],null,{},2]',
    '""',
    "123",
    '{"join":1}',
    '{"length":0}',
    "[1e999]",
    `${"[".repeat(1000)}"deep"${"]".repeat(1000)}`,
  ]) {
    const outputs = [];
    for (let i = 0; i < 2; i++) {
      const command = commands[i];
      const dir = roots[i];
      assert(command && dir);
      const db = new Database(join(dir, "db"));
      db.run("UPDATE api_keys SET model_allowlist=?, revoked_at=NULL WHERE id='k'", [value]);
      db.close();
      for (const json of [false, true]) {
        const proc = Bun.spawn(
          [
            ...command,
            "keys",
            "models",
            "k",
            ...(json ? ["--json"] : []),
            "--root",
            dir,
            "--db",
            "db",
          ],
          { cwd: roots[i], env, stdout: "pipe", stderr: "pipe" },
        );
        outputs.push({
          out: Buffer.from(await new Response(proc.stdout).arrayBuffer()),
          err: Buffer.from(await new Response(proc.stderr).arrayBuffer()),
          code: await proc.exited,
        });
      }
    }
    assert.deepEqual(outputs[2], outputs[0]);
    assert.deepEqual(outputs[3], outputs[1]);
    count += 2;
  }
  console.log(`${count} key mutation subprocess/DB comparisons passed`);
  for (const args of [
    ["limits", "k"],
    ["limits", "k", "--unset", "concurrency"],
    ["limits", "k", "--set", "requests:1m=3"],
    ["limits", "k", "--model-limit", "m:concurrency=2", "--json"],
  ]) {
    const outputs = [],
      rows = [];
    for (let i = 0; i < 2; i++) {
      const dir = roots[i],
        command = commands[i];
      assert(dir && command);
      const db = new Database(join(dir, "db"));
      db.run(
        "UPDATE api_keys SET limits='broken',model_allowlist=NULL,revoked_at=NULL WHERE id='k'",
      );
      db.close();
      const p = Bun.spawn([...command, "keys", ...args, "--root", dir, "--db", "db"], {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      outputs.push({
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
        code: await p.exited,
      });
      const after = new Database(join(dir, "db"));
      rows.push(after.query("SELECT * FROM api_keys").all());
      after.close();
    }
    assert.deepEqual(outputs[1], outputs[0]);
    assert.deepEqual(rows[1], rows[0]);
  }
  console.log("4 unreadable-limit repair byte/DB comparisons passed");
  const usageAt = Date.now() - 10000;
  for (const dir of roots) {
    const db = new Database(join(dir, "db"));
    db.run("UPDATE api_keys SET limits=?,model_allowlist=NULL,revoked_at=NULL WHERE id='k'", [
      '{"requests":{"1m":10,"5h":null},"tokens":{"1m":100},"spend":{"5h":2},"models":{"m":{"requests":{"1m":5}}}}',
    ]);
    db.close();
    const store = await createStore({
      path: join(dir, "db"),
      encryptionKey: await deriveKey(secret),
    });
    await store.usage.append(
      requestLog({
        id: "usage",
        apiKeyId: "k",
        at: usageAt,
        requestedModel: "m",
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.125,
      }),
    );
    store.close();
  }
  for (const extra of [[], ["--json"], ["--set", "concurrency=2", "--json"]]) {
    const results = [],
      rows = [];
    for (let i = 0; i < 2; i++) {
      const dir = roots[i],
        command = commands[i];
      assert(dir && command);
      const p = Bun.spawn(
        [...command, "keys", "limits", "k", ...extra, "--root", dir, "--db", "db"],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      results.push({
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
        code: await p.exited,
      });
      const db = new Database(join(dir, "db"));
      rows.push(db.query("SELECT * FROM api_keys").all());
      db.close();
    }
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(rows[1], rows[0]);
  }
  console.log("3 committed-usage/null-pruning comparisons passed");
  for (const [args, answer] of [
    [["expiry", "k", "--at", "2001-01-01"], ""],
    [["limits", "k"], ""],
    [["limits", "k", "--set", "concurrency=2"], ""],
    [["revoke", "k"], "no"],
    [["revoke", "k"], "yes"],
  ] as const) {
    const outputs = [];
    for (let i = 0; i < 2; i++) {
      const dir = roots[i],
        command = commands[i];
      assert(dir && command);
      const db = new Database(join(dir, "db"));
      db.run("UPDATE api_keys SET limits='broken',revoked_at=NULL WHERE id='k'");
      db.close();
      const p = Bun.spawn(
        [
          "python3",
          join(repo, "conformance/cli/pty.py"),
          answer,
          ...command,
          "keys",
          ...args,
          "--root",
          dir,
          "--db",
          "db",
        ],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      outputs.push(JSON.parse(await new Response(p.stdout).text()));
      assert.equal(await p.exited, 0);
    }
    assert.deepEqual(outputs[1], outputs[0], JSON.stringify(args));
  }
  console.log("5 PTY ANSI/confirmation comparisons passed");
  for (const flags of [
    ...[
      "+275760-09-13T00:00:00",
      "+275760-09-13T00:00:00.001",
      "+275760-09-13T01:00:00+01:00",
      "02/30/2030",
      "02/29/2028",
      "02/29/2030",
      "04/31/2030",
      "02/32/2030",
      "13/01/2030",
    ].map((at) => ["--expires", at, "--json"]),
    [],
    ["--json"],
    [
      "--json",
      "--label",
      "staff",
      "--allow",
      "llama3:8b",
      "--limit",
      "requests:1m=0x10",
      "--model-limit",
      "2:concurrency=2",
      "--no-bodies",
      "--policy",
      "  work  ",
      "--smart-routing",
      "--expires",
      "2030-01-01",
    ],
    ["--label="],
    ["--limit", "requests:1m=0"],
    ["--expires", "bad"],
    ["--policy", " "],
  ]) {
    const results = [],
      persisted = [];
    for (let i = 0; i < 2; i++) {
      const dir = roots[i],
        command = commands[i];
      assert(dir && command);
      const db = new Database(join(dir, "db"));
      db.run("DELETE FROM api_keys");
      db.close();
      const before = Date.now();
      const proc = Bun.spawn(
        [...command, "keys", "create", ...flags, "--root", dir, "--db", "db"],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      let out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text(),
        code = await proc.exited;
      const after = Date.now();
      const database = new Database(join(dir, "db"));
      const rows = database.query("SELECT * FROM api_keys").all() as Record<string, unknown>[];
      database.close();
      if (code === 0) {
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert(row);
        const raw = flags.includes("--json") ? JSON.parse(out).key : out.trim();
        assert.match(raw, /^sk-omni-[A-Za-z0-9_-]{43}$/);
        assert.equal(Buffer.from(raw.slice(8), "base64url").length, 32);
        assert.equal(Buffer.from(raw.slice(8), "base64url").toString("base64url"), raw.slice(8));
        assert.match(
          String(row.id),
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        );
        assert.equal(row.prefix, raw.slice(0, 12));
        assert.equal(row.hash, await hashApiKey(raw));
        assert(
          typeof row.created_at === "number" && row.created_at >= before && row.created_at <= after,
        );
        if (flags.includes("--json")) {
          const parsed = JSON.parse(out);
          assert.equal(parsed.id, row.id);
          assert.equal(parsed.prefix, row.prefix);
          assert.equal(parsed.label, row.label);
        }
        out = out
          .replaceAll(String(row.id), "<uuid>")
          .replaceAll(raw, "<secret>")
          .replaceAll(String(row.prefix), "<prefix>");
        Object.assign(row, {
          id: "<uuid>",
          prefix: "<prefix>",
          hash: "<sha256>",
          created_at: "<time>",
        });
        const listing = Bun.spawn(
          [...command, "keys", "list", "--json", "--root", dir, "--db", "db"],
          { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
        );
        const listed = await new Response(listing.stdout).text();
        assert.equal(await listing.exited, 0);
        assert(!listed.includes(raw));
        assert(!listed.includes(await hashApiKey(raw)));
        const store = await createStore({
          path: join(dir, "db"),
          encryptionKey: await deriveKey(secret),
        });
        assert(await store.keys.findByHash(await hashApiKey(raw)));
        store.close();
      } else {
        assert.equal(rows.length, 0);
      }
      results.push({ out: Buffer.from(out), err: Buffer.from(err), code });
      persisted.push(rows);
    }
    assert.deepEqual(results[1], results[0], JSON.stringify(flags));
    assert.deepEqual(persisted[1], persisted[0]);
  }
  console.log("16 creation byte/DB/secret comparisons passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
