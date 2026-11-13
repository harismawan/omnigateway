import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

const root = mkdtempSync("/tmp/opencode/e1-e5/password-cross-");
const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: "password-golden-secret",
  OMNI_HOST: "127.0.0.1",
  OMNI_PORT: "18449",
  OMNI_DB_PATH: join(root, "db"),
  OMNI_ROOT: root,
  OMNI_STATIC_DIR: join(root, "absent"),
};
const cli = [
  [resolve(process.env.OMNI_CLI_BIN ?? "/tmp/opencode/e1-e5/omni-password")],
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
];
const gateways = [
  process.env.OMNI_TS_GATEWAY_BIN ?? "/tmp/opencode/e1-e5/ts-gateway",
  process.env.OMNI_GATEWAY_BIN ?? "/tmp/opencode/e1-e5/gateway-settled",
];
async function password(cmd: string[], value: string) {
  const p = Bun.spawn(
    [...cmd, "--root", root, "--db", env.OMNI_DB_PATH, "admin", "set-password", "--json"],
    { env, cwd: root, stdin: new Blob([value]), stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(await new Response(p.stderr).text(), "");
  assert.equal(await new Response(p.stdout).text(), '{\n  "ok": true\n}\n');
  assert.equal(await p.exited, 0);
}
let count = 0;
for (const [i, gateway] of gateways.entries()) {
  const cmd = cli[i];
  assert(cmd);
  await password(cmd, "correct-horse-battery");
  const p = Bun.spawn([resolve(gateway)], { cwd: root, env, stdout: "ignore", stderr: "ignore" });
  let oldCookie: string | undefined;
  try {
    let ready = false;
    for (let n = 0; n < 400; n++) {
      try {
        if ((await fetch("http://127.0.0.1:18449/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(25);
    }
    assert(ready, "gateway ready");
    const login = async (value: string) =>
      fetch("http://127.0.0.1:18449/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: value }),
      });
    const first = await login("correct-horse-battery");
    assert.equal(first.status, 200);
    count++;
    const cookie = first.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    oldCookie = cookie;
    await password(cmd, "replacement-password");
    assert.equal((await login("correct-horse-battery")).status, 401);
    count++;
    assert.equal((await login("replacement-password")).status, 200);
    count++;
    assert.equal(
      (await fetch("http://127.0.0.1:18449/api/keys", { headers: { cookie } })).status,
      200,
      "CLI change leaves gateway session alive until restart",
    );
    count++;
  } finally {
    p.kill("SIGTERM");
    await p.exited;
  }
  assert(oldCookie);
  const restarted = Bun.spawn([resolve(gateway)], {
    cwd: root,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let ready = false;
    for (let n = 0; n < 400; n++) {
      try {
        if ((await fetch("http://127.0.0.1:18449/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(25);
    }
    assert(ready);
    assert.equal(
      (await fetch("http://127.0.0.1:18449/api/keys", { headers: { cookie: oldCookie } })).status,
      401,
    );
    count++;
  } finally {
    restarted.kill("SIGTERM");
    await restarted.exited;
  }
}
console.log(`PASS ${count} real gateway cross-login/password-change/session checks (${root})`);
