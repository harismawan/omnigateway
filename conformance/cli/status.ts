import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = mkdtempSync("/tmp/opencode/e1-e5/status-");
const state = join(root, "state", "omnigateway");
mkdirSync(state, { recursive: true });
const commands = [
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let count = 0;
for (const seeded of [false, true]) {
  if (seeded) {
    const db = new Database(join(root, "omnigateway.db"));
    db.run(
      "INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES ('c','openai','account','oauth',1,1)",
    );
    db.run(
      "INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at) VALUES ('c','fiveHour',0,95,100,1,1)",
    );
    db.run("INSERT INTO settings VALUES ('adminPasswordHash','configured')");
    db.close();
  }
  for (const pid of [undefined, String(process.pid), "999999999", "garbage"])
    for (const bad of [false, true])
      for (const json of [false, true])
        for (const tty of [false, true]) {
          const results = [];
          for (const cmd of commands) {
            rmSync(join(state, "gateway.pid"), { force: true });
            if (pid !== undefined) writeFileSync(join(state, "gateway.pid"), pid);
            const args = [...cmd, "--root", root, "status", ...(json ? ["--json"] : [])];
            const p = Bun.spawn(
              tty ? ["python3", resolve("conformance/cli/pty.py"), "", ...args] : args,
              {
                cwd: root,
                env: {
                  ...process.env,
                  HOME: root,
                  XDG_STATE_HOME: join(root, "state"),
                  OMNI_ENCRYPTION_KEY: bad ? "short" : "status-golden-secret",
                  NO_COLOR: "1",
                },
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
          await Bun.write(
            join(root, `${count}.json`),
            JSON.stringify({ pid, bad, json, tty, results }),
          );
          assert.deepEqual(results[1], results[0]);
          count++;
        }
}
console.log(`PASS ${count} status process/config/human/JSON/PTY comparisons (${root})`);
// Actual running gateway, advertised by its supervisor pidfile.
const gateway = Bun.spawn(
  [resolve(process.env.OMNI_GATEWAY_BIN ?? "/tmp/opencode/e1-e5/gateway-settled")],
  {
    cwd: root,
    env: {
      ...process.env,
      OMNI_ENCRYPTION_KEY: "status-golden-secret",
      OMNI_HOST: "127.0.0.1",
      OMNI_PORT: "18448",
      OMNI_DB_PATH: join(root, "live.db"),
    },
    stdout: "ignore",
    stderr: "ignore",
  },
);
try {
  let ready = false;
  for (let n = 0; n < 400; n++) {
    try {
      if ((await fetch("http://127.0.0.1:18448/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(25);
  }
  assert(ready);
  writeFileSync(join(state, "gateway.pid"), String(gateway.pid));
  for (const json of [false, true]) {
    const results = [];
    for (const cmd of commands) {
      const p = Bun.spawn(
        [...cmd, "--root", root, "--db", "live.db", "status", ...(json ? ["--json"] : [])],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            XDG_STATE_HOME: join(root, "state"),
            OMNI_ENCRYPTION_KEY: "status-golden-secret",
            NO_COLOR: "1",
          },
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
    assert.equal(results[0]?.code, 0);
  }
} finally {
  gateway.kill("SIGTERM");
  await gateway.exited;
}
console.log("PASS 2 live gateway status comparisons");
