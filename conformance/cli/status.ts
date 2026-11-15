import "./driver-env.ts";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/status-");
const state = join(root, "state", "omnigateway");
mkdirSync(state, { recursive: true });
const commands = [
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let count = 0;
const initial = await createStore({
  path: join(root, "omnigateway.db"),
  encryptionKey: await deriveKey("status-golden-secret"),
});
initial.close();
function dump() {
  const db = new Database(join(root, "omnigateway.db"));
  const state = (
    db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]);
  db.close();
  return state;
}
for (const seeded of [false, true]) {
  if (seeded) {
    const db = new Database(join(root, "omnigateway.db"));
    db.run(
      "INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES ('c','openai','account','oauth',1,1)",
    );
    db.run(
      "INSERT INTO credentials(id,provider,label,auth_type,enabled,tier,created_at,updated_at) VALUES ('a','anthropic','first','apiKey',2,-1,2,2)",
    );
    db.run(
      "INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at) VALUES ('c','fiveHour',0,95,100,1,1)",
    );
    db.run(
      "INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at) VALUES ('a','weekly',0,0,100,?,?)",
      [Date.now() + 86400000, Date.now() + 60000],
    );
    db.run("INSERT INTO settings VALUES ('adminPasswordHash','')");
    db.close();
  }
  const before = dump();
  copyFileSync(join(root, "omnigateway.db"), join(root, "fixture.db"));
  for (const pid of [undefined, String(process.pid), "999999999", "garbage"])
    for (const bad of [false, true])
      for (const json of [false, true])
        for (const tty of [false, true]) {
          const results = [];
          for (const cmd of commands) {
            for (const suffix of ["", "-wal", "-shm"])
              rmSync(join(root, `omnigateway.db${suffix}`), { force: true });
            copyFileSync(join(root, "fixture.db"), join(root, "omnigateway.db"));
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
            const result = results.at(-1);
            assert(result);
            assert.equal(result.code, 0);
            const nested = tty ? JSON.parse(result.out) : null;
            if (tty) assert.equal(nested.code, 0);
            const output = tty ? Buffer.from(nested.bytes, "hex").toString() : result.out;
            if (json) {
              const data = JSON.parse(output);
              assert.equal(data.process.running, pid === String(process.pid));
              assert.equal(data.adminConfigured, seeded && !bad);
              assert.equal(data.credentials.length, bad || !seeded ? 0 : 2);
              assert.equal(data.storeError === null, !bad);
            } else {
              assert(output.includes(pid === String(process.pid) ? "running" : "stopped"));
            }
            assert.deepEqual(dump(), before);
            const retained = pid !== undefined && pid !== "999999999";
            assert.equal(existsSync(join(state, "gateway.pid")), retained);
            if (retained) assert.equal(readFileSync(join(state, "gateway.pid"), "utf8"), pid);
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
    for (const r of results) {
      assert.equal(r.code, 0);
      assert.equal(r.err, "");
      if (json) {
        const d = JSON.parse(r.out);
        assert.equal(d.process.running, true);
        assert.equal(d.process.pid, gateway.pid);
      } else assert(r.out.includes("running"));
    }
    assert.equal(readFileSync(join(state, "gateway.pid"), "utf8"), String(gateway.pid));
  }
} finally {
  gateway.kill("SIGTERM");
  await gateway.exited;
}
console.log("PASS 2 live gateway status comparisons");
mkdirSync(join(root, ".config/systemd/user"), { recursive: true });
writeFileSync(join(root, ".config/systemd/user/omnigateway.service"), "fixture");
mkdirSync(join(root, "bin"));
writeFileSync(
  join(root, "bin/systemctl"),
  '#!/bin/sh\ncase "$*" in *is-active*) echo "$FIXTURE_STATE";; *show*) echo 123;; esac\n',
  { mode: 0o755 },
);
let systemdCount = 0;
for (const state of ["active", "inactive", "failed"])
  for (const json of [false, true]) {
    const results = [];
    for (const cmd of commands) {
      const p = Bun.spawn([...cmd, "--root", root, "status", ...(json ? ["--json"] : [])], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          FIXTURE_STATE: state,
          OMNI_ENCRYPTION_KEY: "status-golden-secret",
          NO_COLOR: "1",
        },
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
    systemdCount++;
    for (const result of results) {
      assert.equal(result.code, 0);
      assert.equal(result.err, "");
      if (json) {
        const data = JSON.parse(result.out);
        assert.equal(data.process.state, state);
        assert.equal(data.process.running, state === "active");
        assert.equal(data.process.pid, 123);
      } else assert(result.out.includes(state === "active" ? "running" : "stopped"));
    }
  }
console.log(`PASS ${systemdCount} systemd supervisor comparisons`);
