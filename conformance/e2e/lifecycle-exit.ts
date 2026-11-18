#!/usr/bin/env bun
// Actual executable exit, not merely listener shutdown. Wrapper owns isolation.
import { mkdirSync } from "node:fs";
const [binary, out] = process.argv.slice(2);
if (!binary || !out) throw Error("binary and output directory required");
mkdirSync(out, { recursive: true });
const failures: string[] = [];
for (const action of ["shutdown", "restart", "signal"] as const) {
  const root = `${out}/${action}`;
  mkdirSync(root, { recursive: true });
  const child = Bun.spawn([binary], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root,
      OMNI_ROOT: root, OMNI_DB_PATH: `${root}/db.sqlite`,
      OMNI_ENCRYPTION_KEY: "a10-child-exit-private-key-0123456789",
      OMNI_HOST: "127.0.0.1", OMNI_PORT: "18463", OMNI_LOG_LEVEL: "info" },
    stdout: Bun.file(`${root}/stdout.log`), stderr: Bun.file(`${root}/stderr.log`),
  });
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { await (await fetch("http://127.0.0.1:18463/health")).text(); ready = true; break; }
      catch { await Bun.sleep(25); }
    }
    if (!ready) throw Error("startup failed");
    const setup = await fetch("http://127.0.0.1:18463/api/setup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a10-child-exit-password" }),
    });
    const cookie = setup.headers.get("set-cookie")?.split(";")[0];
    if (setup.status !== 200 || !cookie) throw Error(`setup ${await setup.text()}`);
    await setup.text();
    const capability = await fetch("http://127.0.0.1:18463/api/lifecycle", { headers: { cookie } });
    const state = await capability.json() as { supervisor: string };
    if (state.supervisor !== "container") throw Error(`unsafe test environment ${JSON.stringify(state)}`);
    if (action === "signal") child.kill("SIGTERM"); // Only this harness-owned child.
    else {
      const response = await fetch(`http://127.0.0.1:18463/api/lifecycle/${action}`, {
        method: "POST", headers: { cookie },
      });
      const body = await response.text();
      if (response.status !== 200 || body !== '{"ok":true}') throw Error(`reply ${response.status} ${body}`);
      console.log(`${action}: complete 200 response flushed`);
    }
    const exit = await Promise.race([child.exited, Bun.sleep(5000).then(() => null)]);
    if (exit !== 0) throw Error(exit === null ? "child still alive after successful stop reply" : `child exit ${exit}`);
    console.log(`${action}: child exited cleanly (0)`);
  } catch (error) {
    failures.push(`${action}: ${String(error)}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL"); // Never an unrelated process.
    await child.exited;
  }
}
if (failures.length) throw Error(failures.join("\n"));
