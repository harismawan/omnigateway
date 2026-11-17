#!/usr/bin/env bun
// Isolated namespace only. Partial step-3a corpus: the 14 ported admin publishers.
// No normalization: resource frames contain no generated IDs or timestamps.
import { mkdirSync, writeFileSync } from "node:fs";
const [ts, rust, work] = process.argv.slice(2);
if (!ts || !rust || !work) throw Error("frozen rust work required");
mkdirSync(work, { recursive: true });
const children: ReturnType<typeof Bun.spawn>[] = [];
const sockets: WebSocket[] = [];
async function run(binary: string, port: number, name: string) {
  const root = `${work}/${name}`;
  mkdirSync(root, { recursive: true });
  const child = Bun.spawn([binary], { cwd: root, env: { ...process.env,
    OMNI_ROOT: root, OMNI_DB_PATH: `${root}/omni.db`,
    OMNI_ENCRYPTION_KEY: "stream-test-encryption-key-0123456789",
    OMNI_HOST: "127.0.0.1", OMNI_PORT: String(port), OMNI_LOG_LEVEL: "warn" },
    stdout: Bun.file(`${root}/stdout`), stderr: Bun.file(`${root}/stderr`) });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await Bun.sleep(25);
  }
  let cookie = "";
  const api = async (path: string, body: unknown, method = "POST") => {
    const res = await fetch(base + path, { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw Error(`${name} ${method} ${path}: ${res.status} ${text}`);
    return { data: JSON.parse(text), cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  await api("/api/setup", { password: "stream-test-password" });
  cookie = (await api("/api/login", { password: "stream-test-password" })).cookie;
  await api("/api/settings/viewer-password", { password: "stream-viewer-password" }, "PUT");
  const viewer = (await api("/api/login", { password: "stream-viewer-password", mode: "viewer" })).cookie;
  const key = (await api("/api/keys", { label: "stream-session" })).data;
  const client = (await api("/api/client/login", { key: key.key })).cookie;
  // Let setup invalidations leave the coalescer before opening subscribers.
  await Bun.sleep(1100);
  const frames: Record<string, any[]> = {};
  const topics = ["res:credentials", "res:models", "res:keys", "res:settings"];
  for (const [role, token] of [["admin", cookie], ["viewer", viewer], ["client", client]]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, { headers: { cookie: token } });
    sockets.push(ws);
    frames[role] = [];
    ws.onmessage = e => frames[role].push({ at: performance.now(), frame: JSON.parse(String(e.data)) });
    await new Promise<void>((yes, no) => { ws.onopen = () => yes(); ws.onerror = no; });
    for (const topic of topics) ws.send(JSON.stringify({ type: "subscribe", topic }));
    for (let i = 0; frames[role].length < 4 && i < 100; i++) await Bun.sleep(10);
    if (frames[role].length !== 4) throw Error(`${name} ${role} missing acknowledgments`);
    for (const item of frames[role]) if (item.frame.type !== (role === "client" ? "error" : "ack")) throw Error("grant mismatch");
    frames[role] = [];
  }
  return { api, frames, key };
}
try {
  const a = await run(ts, 18781, "ts"), b = await run(rust, 18782, "rust");
  const transcript: any[] = [];
  const check = async (name: string, topic: string, mutate: (x: typeof a) => Promise<unknown>, floor: number) => {
    for (const x of [a, b]) for (const role in x.frames) x.frames[role] = [];
    await Promise.all([mutate(a), mutate(b)]);
    await Bun.sleep(150);
    for (const x of [a, b]) {
      for (const role of ["admin", "viewer", "client"]) {
        const got = x.frames[role].map(v => v.frame);
        const expected = role === "client" ? [] : [{ type: "event", topic }];
        if (JSON.stringify(got) !== JSON.stringify(expected)) throw Error(`${name} ${x === a ? "ts" : "rust"} ${role}: ${JSON.stringify(got)}`);
      }
    }
    transcript.push({ name, topic, frames: a.frames.admin.map(v => v.frame) });
    await Bun.sleep(floor + 30);
  };
  const ids = new Map<typeof a, string>();
  await check("credential create", "res:credentials", async x => {
    const r = await x.api("/api/credentials", { provider: "custom", apiKey: "test-secret", endpointId: "stream", endpointLabel: "Stream", origin: "http://127.0.0.1:18789", protocol: "chat_completions" });
    ids.set(x, r.data.credential.id);
  }, 5000);
  await check("credential patch", "res:credentials", x => x.api(`/api/credentials/${ids.get(x)}`, { enabled: false }, "PATCH"), 5000);
  await check("credential delete", "res:credentials", x => x.api(`/api/credentials/${ids.get(x)}`, {}, "DELETE"), 5000);
  await check("model put", "res:models", x => x.api("/api/models/stream", { id: "stream", strategy: "score", isAlias: false, targets: [{ provider: "anthropic", model: "claude-x", tier: 1, weight: 1, costPerMTok: { input: 1, output: 2 }, capabilities: { tools: true, images: false, reasoning: true } }] }, "PUT"), 1000);
  await check("model delete", "res:models", x => x.api("/api/models/stream", {}, "DELETE"), 1000);
  await check("key create", "res:keys", async x => { x.key = (await x.api("/api/keys", { label: "mutation" })).data; }, 1000);
  for (const [edit, body] of [["limits", { limits: {} }], ["models", { modelAllowlist: null }], ["expiry", { expiresAt: null }], ["guardrail", { policy: null }], ["smart-routing", { enabled: false }]] as const) {
    await check(`key ${edit}`, "res:keys", x => x.api(`/api/keys/${x.key.id}/${edit}`, body, "PUT"), 1000);
  }
  await check("key delete", "res:keys", x => x.api(`/api/keys/${x.key.id}`, {}, "DELETE"), 1000);
  // Removing viewers would close their session on the next heartbeat; keep it last.
  await check("settings put", "res:settings", x => x.api("/api/settings", { weights: { tier: 1, health: 2, quota: 3, cost: 4, latency: 5, load: 6 }, maxAttempts: 3, requestDeadlineMs: 0, breakerThreshold: 3, breakerCooldownMs: 30000, logRetentionDays: 30, quotaPollIntervalMs: 0, rtkEnabled: false, autoCacheEnabled: true, ponytailMode: "off", bodyLoggingEnabled: false, bodyLoggingCaptureStreamChunks: false }, "PUT"), 1000);
  await check("viewer password", "res:settings", x => x.api("/api/settings/viewer-password", { password: "stream-viewer-new-password" }, "PUT"), 1000);
  writeFileSync(`${work}/frames.json`, JSON.stringify(transcript, null, 2));
  console.log("14 paired admin resource publishers; admin/viewer exact frames; client denied; no generated-field normalization");
} finally {
  for (const ws of sockets) ws.close();
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map(p => p.exited));
}
