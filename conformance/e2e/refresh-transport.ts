#!/usr/bin/env bun
/** Real 30s deadlines; namespace-only negative OAuth refresh oracle. */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isDeepStrictEqual as eq } from "node:util";
import { deriveKey, encrypt, decrypt } from "../../packages/store/src/encryption.ts";
const { values: f } = parseArgs({ options: Object.fromEntries(["ts", "rust", "work", "cert", "key"].map(k => [k, { type: "string" as const }])) });
for (const k of ["ts", "rust", "work", "cert", "key"]) if (!f[k]) throw Error(`missing ${k}`);
const work = resolve(f.work!), seed = join(work, "seed"); mkdirSync(seed, { recursive: true });
const env = { PATH: process.env.PATH!, HOME: seed, TMPDIR: work, OMNI_ENCRYPTION_KEY: "refresh-transport-fixture-012345678901", OMNI_HOST: "127.0.0.1", OMNI_PORT: "18527", OMNI_LOG_LEVEL: "debug", OMNI_STATIC_DIR: join(work, "absent"), OMNI_DAY_OFFSET_MINUTES: "0", NODE_EXTRA_CA_CERTS: f.cert!, SSL_CERT_FILE: f.cert! };
const seedDb = join(seed, "omnigateway.db");
async function cli(args: string[]) {
  const p = Bun.spawn(["bun", "--no-env-file", "apps/cli/src/index.ts", "--root", seed, "--json", ...args], { cwd: resolve(import.meta.dir, "../.."), env: { ...env, OMNI_DB_PATH: seedDb }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (await p.exited) throw Error(err); return JSON.parse(out);
}
const apiKey = (await cli(["keys", "create", "--label", "fixture"])).key;
const key = await deriveKey(env.OMNI_ENCRYPTION_KEY), providers = ["antigravity", "anthropic", "openai"];
for (const provider of providers) {
  const file = join(seed, `${provider}.json`);
  await Bun.write(file, JSON.stringify({ id: provider, strategy: "priority", isAlias: false, targets: [{ provider, model: provider === "antigravity" ? "gemini-2.5-pro" : provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5", tier: 1, weight: 1, costPerMTok: { input: 1, output: 2 }, capabilities: { tools: true, images: true, reasoning: true } }] }));
  await cli(["models", "put", provider, "-f", file]);
}
type Wire = { line: string; headers: string[]; body: string };
let mode = "close", wire: Wire[] = [];
const stub = Bun.listen<{ buffer: Buffer }>({ hostname: "127.0.0.1", port: 443, tls: { cert: Bun.file(f.cert!), key: Bun.file(f.key!) }, socket: {
  open(s) { s.data = { buffer: Buffer.alloc(0) }; },
  data(s, chunk) {
    s.data.buffer = Buffer.concat([s.data.buffer, chunk]);
    const end = s.data.buffer.indexOf("\r\n\r\n"); if (end < 0) return;
    const [line, ...headers] = s.data.buffer.subarray(0, end).toString().split("\r\n");
    const size = Number(headers.find(h => /^content-length:/i.test(h))?.split(":")[1] ?? 0);
    if (s.data.buffer.length < end + 4 + size) return;
    const body = s.data.buffer.subarray(end + 4, end + 4 + size).toString(); s.data.buffer = Buffer.alloc(0);
    if (!body.includes("refresh_token")) { s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'); return; }
    wire.push({ line: line!, headers, body });
    if (mode === "close") s.end();
    else if (mode === "truncated") s.end('HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{');
    // timeout: leave socket open until the host's real step deadline.
  },
} });
async function credential(db: Database) {
  const row = db.query("SELECT * FROM credentials").get() as any;
  for (const k of ["access_token", "refresh_token", "api_key", "id_token"]) if (row[k] !== null) row[k] = await decrypt(key, row[k]);
  return row;
}
async function run(binary: string, label: string) {
  const rows: any[] = [];
  for (const provider of providers) for (const kind of ["close", "truncated", "timeout"]) {
    mode = kind; wire = [];
    const root = join(work, `${label}-${provider}-${kind}`); mkdirSync(root);
    const file = join(root, "omni.db"); copyFileSync(seedDb, file);
    const d = new Database(file);
    d.run(`INSERT INTO credentials (id,provider,label,auth_type,enabled,tier,weight,expires_at,provider_data,access_token,refresh_token,created_at,updated_at,token_version) VALUES ('only',?,?,'oauth',1,1,1,4102444800000,?,?,?,1000,1000,0)`, [provider, provider, JSON.stringify({ projectId: "fixture-project", tier: "fixture" }), await encrypt(key, "old-access"), await encrypt(key, "old-refresh")]); d.close();
    const child = Bun.spawn([resolve(binary)], { cwd: root, env: { ...env, HOME: root, OMNI_ROOT: root, OMNI_DB_PATH: file }, stdout: Bun.file(join(root, "stdout")), stderr: Bun.file(join(root, "stderr")) });
    try {
      let ready = false;
      for (let n = 0; n < 200; n++) { try { if ((await fetch("http://127.0.0.1:18527/health")).ok) { ready = true; break; } } catch {} await Bun.sleep(25); }
      if (!ready) throw Error(`boot failed ${root}`);
      const writer = new Database(file); writer.run("UPDATE credentials SET expires_at=1"); const before = await credential(writer); writer.close();
      await Bun.sleep(1500); wire = [];
      const started = Date.now();
      const r = await fetch("http://127.0.0.1:18527/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: provider, messages: [{ role: "user", content: "hello" }], max_tokens: 32 }), signal: AbortSignal.timeout(45000) });
      const body = await r.text(), elapsed = Date.now() - started;
      child.kill("SIGTERM"); await child.exited;
      const db = new Database(file); const after = await credential(db);
      const logs = db.query("SELECT * FROM request_logs").all().map((row: any) => Object.fromEntries(Object.entries(row).filter(([k]) => !["id", "at", "duration_ms", "ttft_ms", "updated_at", "node_id"].includes(k)))); db.close();
      rows.push({ provider, kind, status: r.status, body, elapsed, wire: [...wire], before, after, logs });
    } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
  }
  return rows;
}
function valid(r: any) {
  const body = JSON.parse(r.body);
  return r.status === 503 && body.error?.message === `${r.provider} oauth refresh threw` && body.error?.type === "server_error" && r.wire.length === 1 && r.wire[0].body.includes("refresh_token") && r.after.enabled === 1 && eq(r.before, r.after) && r.logs.length === 1 && r.logs[0].error_code === "ALL_CANDIDATES_FAILED" && (r.kind !== "timeout" || (r.elapsed >= 29000 && r.elapsed < 40000));
}
try {
  const ts = await run(f.ts!, "ts"), rust = await run(f.rust!, "rust");
  await Bun.write(join(work, "ts.rows.json"), JSON.stringify(ts, null, 2)); await Bun.write(join(work, "rust.rows.json"), JSON.stringify(rust, null, 2));
  let failed = 0;
  for (let i = 0; i < ts.length; i++) {
    const a = ts[i], b = rust[i], equal = eq({ ...a, elapsed: 0 }, { ...b, elapsed: 0 });
    const pass = equal && valid(a) && valid(b); if (!pass) failed++;
    console.log(`${pass ? "PASS" : "FAILED"} ${a.provider}/${a.kind} equality=${equal} frozen-valid=${valid(a)} rust-valid=${valid(b)}`);
  }
  console.log(JSON.stringify({ rows: ts.length, failed, equal: ts.length - failed, perProvider: 3 })); process.exitCode = failed ? 1 : 0;
} finally { stub.stop(true); }
