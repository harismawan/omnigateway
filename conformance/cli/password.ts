import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/password-");
const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: "password-golden-secret",
  NO_COLOR: "1",
  PTY_NO_COLOR: "1",
};
const store = await createStore({
  path: join(root, "db"),
  encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
});
store.close();
const commands = [
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let count = 0;
for (const json of [false, true])
  for (const tty of [false, true])
    for (const password of [
      "",
      "short",
      "correct-horse-battery",
      "  correct-horse-battery\n",
      "😀😀😀😀😀😀",
    ])
      for (const mismatch of tty ? [false, true] : [false]) {
        const results = [];
        for (const [i, cmd] of commands.entries()) {
          const db = new Database(join(root, "db"));
          db.run("DELETE FROM settings WHERE key='adminPasswordHash'");
          db.run("INSERT OR REPLACE INTO settings VALUES ('sentinel','keep')");
          db.close();
          const entry =
            tty && i === 0
              ? ["bun", "--no-env-file", resolve("conformance/cli/password-seam.ts")]
              : cmd;
          const args = [
            ...entry,
            "--root",
            root,
            "--db",
            "db",
            "admin",
            "set-password",
            ...(json ? ["--json"] : []),
          ];
          const answers = [
            password.replace(/\n/g, ""),
            mismatch ? "different" : password.replace(/\n/g, ""),
          ];
          const p = Bun.spawn(
            tty ? ["python3", resolve("conformance/cli/pty.py"), "", ...args] : args,
            {
              cwd: root,
              env: { ...env, PTY_ANSWERS: JSON.stringify(answers) },
              stdin: tty ? "ignore" : new Blob([password]),
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const result = {
            out: await new Response(p.stdout).text(),
            err: await new Response(p.stderr).text(),
            code: await p.exited,
          };
          assert.equal(
            tty ? JSON.parse(result.out).code : result.code,
            mismatch || password.trim().length < 12 ? 1 : 0,
          );
          const d = new Database(join(root, "db"));
          const rows = d.query("SELECT * FROM settings ORDER BY key").all() as {
            key: string;
            value: string;
          }[];
          d.close();
          for (const row of rows)
            if (row.key === "adminPasswordHash") {
              assert.match(row.value, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
              assert(await Bun.password.verify(password.trim(), row.value));
              row.value = "<validated argon2id hash>";
            }
          results.push({ ...result, rows });
        }
        await Bun.write(
          join(root, `${count}.json`),
          JSON.stringify({ json, tty, password, mismatch, results }),
        );
        assert.deepEqual(results[1], results[0]);
        count++;
      }
console.log(`PASS ${count} password output/status/settings/hash comparisons (${root})`);
for (const json of [false, true]) {
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
        "admin",
        "set-password",
        ...(json ? ["--json"] : []),
      ],
      {
        cwd: root,
        env: { ...env, PTY_WAIT_RAW: "1", PTY_ANSWERS: JSON.stringify(["\u0003"]) },
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
}
console.log("PASS 2 real-TS single-secret cancellation comparisons");
