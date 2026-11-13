import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROVIDER_DESCRIPTORS } from "../../packages/providers/src/descriptors.ts";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/setup-limits-");
const binary = resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni");
await Bun.write(
  join(root, "manifest.json"),
  JSON.stringify({
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
    binary,
    sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  }),
);
const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: "setup-golden-secret",
  PTY_NO_COLOR: "1",
  HOME: root,
  PTY_ANSWERS: JSON.stringify(["pool", "", "", "", ""]),
};
const store = await createStore({
  path: join(root, "db"),
  encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
});
store.close();
const db = new Database(join(root, "db"));
const commands = [
  ["bun", "--no-env-file", resolve("conformance/cli/setup-seam.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let count = 0;
for (const credentials of [[], ["oauth"], ["apiKey"], ["oauth", "apiKey"]])
  for (const credentialId of [undefined, "c0", "c1", "missing"])
    for (const targets of [
      [{ provider: "openai", model: "gpt-6-astra" }],
      [{ provider: "openai", model: "gpt-6-astra", contextWindow: 999, maxOutputTokens: 111 }],
      [
        { provider: "openai", model: "gpt-6-astra" },
        { provider: "anthropic", model: "claude-sonnet-5" },
      ],
      [{ provider: "unknown", model: "unknown" }],
    ]) {
      for (const target of targets) {
        if (target.provider !== "unknown")
          assert(
            PROVIDER_DESCRIPTORS[target.provider]?.catalog.models.some(
              (m) => m.id === target.model,
            ),
            `missing catalog fixture ${target.model}`,
          );
      }
      db.run("DELETE FROM virtual_models");
      db.run("DELETE FROM credentials");
      db.run("INSERT INTO virtual_models VALUES ('pool', ?, 'weighted', 0)", [
        JSON.stringify(targets.map((t) => ({ ...t, credentialId }))),
      ]);
      for (const [i, auth] of credentials.entries())
        db.run(
          "INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES (?, 'openai', 'label', ?, 1, 1)",
          [`c${i}`, auth],
        );
      const before = snapshot();
      const results = [];
      for (const cmd of commands) {
        const p = Bun.spawn(
          [
            "python3",
            resolve("conformance/cli/pty.py"),
            "",
            ...cmd,
            "--root",
            root,
            "--db",
            "db",
            "setup",
            "opencode",
            "--dry-run",
            "--json",
          ],
          { cwd: root, env, stdout: "pipe", stderr: "pipe" },
        );
        results.push({
          out: await new Response(p.stdout).text(),
          err: await new Response(p.stderr).text(),
          code: await p.exited,
        });
        const result = results.at(-1);
        assert(result);
        assert.equal(result.code, 0);
        assert.equal(result.err, "");
        const nested = JSON.parse(result.out);
        assert.equal(nested.code, 0);
        const transcript = Buffer.from(nested.bytes, "hex").toString();
        const config = JSON.parse(
          JSON.parse(transcript.slice(transcript.indexOf("{"))).files[0].contents,
        );
        const model = config.provider.omnigateway.models.pool;
        if (targets[0]?.provider === "unknown") assert.equal(model.limit, undefined);
        else {
          const pinned =
            credentialId === undefined ? undefined : credentials[Number(credentialId.slice(1))];
          const oauth = pinned === undefined ? credentials.includes("oauth") : pinned === "oauth";
          assert.deepEqual(
            model.limit,
            targets[0]?.contextWindow === 999
              ? { context: 999, output: 111 }
              : { context: oauth ? 272000 : 922000, output: 128000 },
          );
        }
        assert.deepEqual(snapshot(), before, "setup must preserve every database table");
      }
      await Bun.write(
        join(root, `${count}.json`),
        JSON.stringify({ credentials, credentialId, targets, results }),
      );
      assert.deepEqual(results[1], results[0]);
      count++;
    }
function snapshot() {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]);
}
db.close();
for (const client of ["claude", "opencode"]) {
  for (const dir of [undefined, "", "nested/../target"]) {
    const results = [];
    for (const cmd of commands) {
      const p = Bun.spawn(
        [
          "python3",
          resolve("conformance/cli/pty.py"),
          "",
          ...cmd,
          "--root",
          root,
          "--db",
          "db",
          "setup",
          client,
          "--dry-run",
          "--key",
          "key",
          ...(dir === undefined ? [] : ["--dir", dir]),
        ],
        {
          cwd: root,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      results.push({
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
        code: await p.exited,
      });
    }
    assert.deepEqual(results[1], results[0]);
    for (const result of results) {
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.out).code, 0);
    }
    count++;
  }
}
console.log(`PASS ${count} setup catalog/auth/pin/limit and whole-DB comparisons (${root})`);
let parserCount = 0;
for (const client of ["claude", "opencode"]) {
  for (const flags of [
    ["--wat"],
    ["--key"],
    ["--dir"],
    ["--dry-run=true"],
    ["--key", "--json"],
    ["--yes=true"],
  ]) {
    const results = [];
    const rust = commands[1];
    assert(rust);
    for (const cmd of [["bun", "--no-env-file", resolve("apps/cli/src/index.ts")], rust]) {
      const p = Bun.spawn([...cmd, "setup", client, ...flags], {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      results.push({
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
        code: await p.exited,
      });
    }
    assert.deepEqual(results[1], results[0]);
    for (const result of results) assert.equal(result.code, 2);
    parserCount++;
  }
}
console.log(`PASS ${parserCount} setup parser error comparisons`);
