// Real frozen TS/Rust bytes and whole rows, using isolated equivalent roots.
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey, hashApiKey, keyUsable } from "../../packages/store/src/index.ts";
const root = mkdtempSync("/tmp/opencode/key-mutations-");
const repo = resolve(import.meta.dir, "../..");
const secret = "mutation-golden-secret";
const rawKey = "sk-omni-" + "a".repeat(43);
const hash = await hashApiKey(rawKey);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OMNI_")));
Object.assign(env, { OMNI_ENCRYPTION_KEY: secret, NO_COLOR: "1", HOME: root });
const commands = [["bun", "--no-env-file", join(repo, "apps/cli/src/index.ts")], [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni"), ...(process.env.OMNI_CLI_SUBCOMMAND === "1" ? ["omni"] : [])]];
if (process.env.OMNI_CLI_SYMLINK === "1") {
  const link = join(root, "omni");
  symlinkSync(commands[1]![0]!, link);
  commands[1] = [link];
}
let count = 0;
try {
  const roots = [join(root, "ts"), join(root, "rs")];
  for (const dir of roots) {
    mkdirSync(dir);
    const store = await createStore({ path: join(dir, "db"), encryptionKey: await deriveKey(secret) });
    store.close();
    const db = new Database(join(dir, "db"));
    db.run("INSERT INTO api_keys (id,label,prefix,hash,limits,created_at) VALUES (?,?,?,?,?,?)", ["k", "staff", "sk-omni-test", hash, "{}", 1700000000000]);
    db.close();
  }
  writeFileSync(join(root, "policy"), "  Work only.\nRefuse roleplay.\n");
  const cases = [
    ["smart-routing", "k", "--on"], ["smart-routing", "k", "--off", "--json"],
    ["smart-routing", "k"], ["smart-routing", "k", "--on", "--off"],
    ["smart-routing", "missing", "--on"], ["smart-routing", "--on"],
    ["models", "k"], ["models", "k", "--none"], ["models", "k", "--all", "--json"],
    ["models", "k", "--allow", "llama3:8b", "--allow", "constructor", "--allow", "2"],
    ["models", "k", "--json"], ["models", "k", "--all", "--none"],
    ["models", "k", "--allow", "a,b", "--allow", "a,b"],
    ["models", "k", "--allow="], ["models", "missing", "--all", "--none"],
    ["guardrail", "k"], ["guardrail", "k", "--policy", "  Work only.  "],
    ["guardrail", "k", "--policy-file", join(root, "policy"), "--json"],
    ["guardrail", "k", "--policy", "   "], ["guardrail", "k", "--policy", "x", "--clear"],
    ["guardrail", "k", "--policy-file", "absent"], ["guardrail", "k", "--clear"],
    ["guardrail", "k", "--policy", "first", "--policy", "last", "--json"],
    ["guardrail", "k", "--policy", "p".repeat(4000), "--json"],
    ["guardrail", "k", "--policy", "p".repeat(4001)],
    ["guardrail", "k", "--policy", "🌍".repeat(2001)],
    ["guardrail", "k", "--policy", "🌍".repeat(4001)],
    ["guardrail", "k", "--policy", "\ufeff x \ufeff"],
    ["guardrail", "k", "--policy-file", "-"],
    ["models", "k", "--help"], ["guardrail", "k", "--help"],
    ["smart-routing", "--help"], ["revoke", "--help"],
    ["revoke", "k"], ["revoke", "missing", "-y"], ["revoke", "k", "-y"],
    ["revoke", "k", "--yes", "--json"],
  ];
  for (const args of cases) {
    const before = Date.now();
    const outputs = [], rows = [];
    for (let i = 0; i < 2; i++) {
      const proc = Bun.spawn([...commands[i]!, "keys", ...args, "--root", roots[i]!, "--db", "db"], { cwd: roots[i], env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      proc.stdin.end("yes\n");
      outputs.push({ out: Buffer.from(await new Response(proc.stdout).arrayBuffer()), err: Buffer.from(await new Response(proc.stderr).arrayBuffer()), code: await proc.exited });
      const db = new Database(join(roots[i]!, "db"));
      rows.push(db.query("SELECT * FROM api_keys ORDER BY id").all() as Record<string, unknown>[]);
      db.close();
      const store = await createStore({ path: join(roots[i]!, "db"), encryptionKey: await deriveKey(secret) });
      const key = await store.keys.findByHash(await hashApiKey(rawKey));
      assert(key);
      assert.equal(keyUsable(key, Date.now()), key.revokedAt === null);
      store.close();
    }
    assert.deepEqual(outputs[1], outputs[0], JSON.stringify(args));
    for (const rs of rows) for (const row of rs) {
      if (args[0] === "revoke" && !args.includes("--help") && outputs[0]!.code === 0) {
        assert(typeof row.revoked_at === "number" && row.revoked_at >= before && row.revoked_at <= Date.now());
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
  for (const value of ['["a,b",["c","d"],null,{},2]', '""', '123', '{"join":1}', '[1e999]', '['.repeat(1000) + '"deep"' + ']'.repeat(1000)]) {
    const outputs = [];
    for (let i = 0; i < 2; i++) {
      const db = new Database(join(roots[i]!, "db"));
      db.run("UPDATE api_keys SET model_allowlist=?, revoked_at=NULL WHERE id='k'", [value]);
      db.close();
      for (const json of [false, true]) {
        const proc = Bun.spawn([...commands[i]!, "keys", "models", "k", ...(json ? ["--json"] : []), "--root", roots[i]!, "--db", "db"], { cwd: roots[i], env, stdout: "pipe", stderr: "pipe" });
        outputs.push({ out: Buffer.from(await new Response(proc.stdout).arrayBuffer()), err: Buffer.from(await new Response(proc.stderr).arrayBuffer()), code: await proc.exited });
      }
    }
    assert.deepEqual(outputs[2], outputs[0]);
    assert.deepEqual(outputs[3], outputs[1]);
    count += 2;
  }
  console.log(`${count} key mutation subprocess/DB comparisons passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
