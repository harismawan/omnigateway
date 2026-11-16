#!/usr/bin/env bun
/** Real-duration socket probe: ~285 seconds. Run only inside a loopback netns.
 * No shortened production timeout. Ports 18670..18672 are private to this driver.
 * Evidence is retained in --work; --rust can be the baseline or final binary.
 */
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";

const { values: f } = parseArgs({ options: {
  ts: { type: "string" }, rust: { type: "string" }, work: { type: "string" },
} });
if (!f.ts || !f.rust || !f.work) throw Error("--ts --rust --work required");
const work = resolve(f.work);
mkdirSync(work, { recursive: true });
const seed = join(work, "seed");
const assets = join(work, "static");
mkdirSync(seed, { recursive: true });
mkdirSync(assets, { recursive: true });
writeFileSync(join(seed, ".env"), `OMNI_ENCRYPTION_KEY=idle-timeout-test-key-0123456789012345\nOMNI_DB_PATH=${join(seed, "omni.db")}\n`);
writeFileSync(join(assets, "large.txt"), Buffer.alloc(32 * 1024 * 1024, 120));
writeFileSync(join(assets, "index.html"), "idle probe");
const env = { ...process.env, OMNI_ENCRYPTION_KEY: "idle-timeout-test-key-0123456789012345",
  OMNI_DB_PATH: join(seed, "omni.db"), OMNI_HOST: "127.0.0.1", OMNI_LOG_LEVEL: "warn",
  OMNI_STATIC_DIR: assets };
async function cli(args: string[], stdin?: string) {
  const p = Bun.spawn(["bun", "--no-env-file", "apps/cli/src/index.ts", "--root", seed, "--json", ...args], {
    cwd: resolve(import.meta.dir, "../.."), env, stdin: stdin ? Buffer.from(stdin) : "ignore",
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw Error(err);
  return JSON.parse(out);
}
await cli(["credentials", "add-key", "custom", "--label", "idle", "--endpoint-id", "idle",
  "--endpoint-label", "idle", "--origin", "http://127.0.0.1:18670", "--protocol", "chat-completions"], "sk-idle\n");
const model = join(seed, "model.json");
writeFileSync(model, JSON.stringify({ id: "idle", strategy: "priority", isAlias: false, targets: [{
  provider: "custom", endpointId: "idle", model: "idle", tier: 1, weight: 1,
  costPerMTok: { input: 1, output: 2 }, capabilities: { tools: true, images: true, reasoning: true },
}] }));
await cli(["models", "put", "idle", "-f", model]);
const jsonModel = JSON.parse(await Bun.file(model).text());
jsonModel.id = "idle-json";
jsonModel.targets[0].model = "idle-json";
writeFileSync(model, JSON.stringify(jsonModel));
await cli(["models", "put", "idle-json", "-f", model]);
const key = (await cli(["keys", "create", "--label", "idle"])).key;
{
  const db = new Database(env.OMNI_DB_PATH);
  db.run("INSERT OR REPLACE INTO settings(key,value) VALUES('adminPasswordHash',?)", [await Bun.password.hash("idle-probe-password")]);
  db.close();
}
const delta = new TextEncoder().encode(`data: ${JSON.stringify({ id: "idle", object: "chat.completion.chunk", model: "idle", choices: [{ index: 0, delta: { content: "x".repeat(65536) } }] })}\n\n`);
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 18670, idleTimeout: 0, async fetch(req) {
  const body = await req.json() as { model: string };
  let n = 0;
  return new Response(new ReadableStream({ async pull(c) {
    // Pace production to bound queued data even if a runtime eagerly pulls.
    await Bun.sleep(200);
    if (body.model === "idle-json" && n++ >= 96) {
      c.enqueue(new TextEncoder().encode('data: {"id":"idle","model":"idle","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n'));
      c.close();
    } else c.enqueue(delta);
  } }), { headers: { "content-type": "text/event-stream" } });
} });
const children: Bun.Subprocess[] = [];
try {
  for (const [label, binary, port] of [["ts", f.ts, 18671], ["rust", f.rust, 18672]] as const) {
    const root = join(work, label);
    mkdirSync(root, { recursive: true });
    copyFileSync(env.OMNI_DB_PATH, join(root, "omni.db"));
    children.push(Bun.spawn([binary], { cwd: work, env: { ...env, OMNI_ROOT: root,
      OMNI_DB_PATH: join(root, "omni.db"), OMNI_PORT: String(port) }, stdout: Bun.file(join(root, "stdout")), stderr: Bun.file(join(root, "stderr")) }));
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
      await Bun.sleep(50);
    }
    if (!ready) throw Error(`${label} boot failed`);
  }
  const cookies: string[] = [];
  for (const port of [18671, 18672]) {
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "idle-probe-password" }) });
    cookies.push(login.headers.get("set-cookie")?.split(";")[0] ?? "");
  }
  const p = Bun.spawn(["python3", join(import.meta.dir, "idle-timeout-probe.py"), work, key, ...cookies], { stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  if (code) throw Error(`socket probe failed: ${code}`);
} finally {
  for (const [i, p] of children.entries()) {
    console.log("gateway-before-cleanup", ["ts", "rust"][i], "exit", p.exitCode, "signal", p.signalCode);
    if (p.exitCode === null) p.kill("SIGTERM");
  }
  await Promise.all(children.map(p => p.exited));
  upstream.stop(true);
  for (const label of ["ts", "rust"]) {
    const path = join(work, label, "omni.db");
    const db = new Database(path, { readonly: true });
    writeFileSync(join(work, label, "request-logs.json"), JSON.stringify(db.query("SELECT status,error_code FROM request_logs ORDER BY at").all(), null, 2));
    db.close();
  }
}
