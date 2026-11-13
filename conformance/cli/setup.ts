import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/setup-");
const repo = resolve(import.meta.dir, "../..");
const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: "setup-golden-secret",
  OMNI_BASE_URL: "http://localhost:3000",
  NO_COLOR: "1",
  PTY_NO_COLOR: "1",
};
const store = await createStore({
  path: join(root, "db"),
  encryptionKey: await deriveKey("setup-golden-secret"),
});
store.close();
const db = new Database(join(root, "db"));
db.run("INSERT INTO virtual_models VALUES ('pool', ?, 'weighted', 0)", [
  JSON.stringify([{ provider: "openai", model: "gpt-5", weight: 1 }]),
]);
db.close();
const commands = [
  ["bun", "--no-env-file", join(repo, "apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let count = 0;
for (const key of [undefined, "", "secret-key"])
  for (const client of ["claude", "opencode"])
    for (const dry of [false, true])
      for (const json of [false, true])
        for (const existing of [
          undefined,
          '{"custom":true,"env":{"KEEP":"yes","ANTHROPIC_MODEL":"old","CLAUDE_CODE_MAX_CONTEXT_TOKENS":"1"}}',
          "[]",
          "{",
          '{"env":[1],"value":"\\ud800","2":2,"1":1}',
        ])
          for (const answers of [
            ["pool", "", "pool", "", ""],
            ["missing", "", "", "", ""],
            ["pool", "missing", "", "", ""],
            ["", "", "", "", ""],
            null,
          ]) {
            const results = [];
            for (const cmd of commands) {
              const dir = join(root, "client");
              rmSync(dir, { recursive: true, force: true });
              mkdirSync(dir);
              const path = join(dir, client === "claude" ? "settings.json" : "opencode.json");
              if (existing !== undefined) writeFileSync(path, existing);
              const entry =
                answers && answers[0] !== "" && cmd[0] === "bun"
                  ? ["bun", "--no-env-file", join(repo, "conformance/cli/setup-seam.ts")]
                  : cmd;
              const args = [
                ...entry,
                "--root",
                root,
                "--db",
                "db",
                "setup",
                client,
                "--dir",
                dir,
                ...(key === undefined ? [] : ["--key", key]),
                ...(dry ? ["--dry-run"] : []),
                ...(json ? ["--json"] : []),
              ];
              const p = Bun.spawn(
                answers ? ["python3", join(repo, "conformance/cli/pty.py"), "", ...args] : args,
                {
                  cwd: root,
                  env: { ...env, PTY_ANSWERS: JSON.stringify(answers) },
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                },
              );
              results.push({
                out: await new Response(p.stdout).text(),
                err: await new Response(p.stderr).text(),
                code: await p.exited,
                file: existsSync(path) ? readFileSync(path, "utf8") : null,
              });
            }
            await Bun.write(
              join(root, `${count}.json`),
              JSON.stringify({ client, dry, json, existing, answers, results }),
            );
            assert.deepEqual(results[1], results[0]);
            const expectedCode =
              answers === null ||
              answers[0] !== "pool" ||
              answers[1] === "missing" ||
              (client === "claude" && (existing === "[]" || existing === "{"))
                ? 1
                : 0;
            const ts = results[0];
            assert(ts);
            assert.equal(
              answers ? JSON.parse(ts.out).code : ts.code,
              expectedCode,
              "exercise intended success/error rather than an unrelated shared failure",
            );
            count++;
          }
console.log(`PASS ${count} setup byte/status/file comparisons (${root})`);
// Pre-prompt errors use the real entrypoint, never the injected seam.
for (const client of ["claude", "opencode"]) {
  for (const invalidConfig of [false, true]) {
    const db = new Database(join(root, "db"));
    db.run("DELETE FROM virtual_models");
    db.close();
    const results = [];
    for (const cmd of commands) {
      const p = Bun.spawn([...cmd, "--root", root, "--db", "db", "setup", client], {
        cwd: root,
        env: { ...env, ...(invalidConfig ? { OMNI_ENCRYPTION_KEY: "short" } : {}) },
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
  }
}
console.log("PASS 4 real-CLI pre-prompt error comparisons");
