#!/usr/bin/env bun
/** Frozen HTTP oracle; invoke only via antigravity-ns.sh. No live credentials.
 * Port 18526 is reserved for this driver. Quota boot traffic is retained but
 * outside B4 (B10); request/refresh traffic is compared without reserialization.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { deriveKey, encrypt, decrypt } from "../../packages/store/src/encryption.ts";
import { normalize, normalizedEqual, REQUEST_UUID } from "./masks.ts";

const { values: f } = parseArgs({ options: Object.fromEntries(
  ["ts", "rust", "work", "cert", "key"].map(k => [k, { type: "string" as const }]),
) });
for (const k of ["ts", "rust", "work", "cert", "key"]) if (!f[k]) throw Error(`--${k} required`);
const work = resolve(f.work!);
if (!["/tmp/opencode/b4/e2e/", "/tmp/opencode/b4/connect2/"].some(p => work.startsWith(p))) throw Error("private evidence directory required");
const seed = join(work, "seed");
mkdirSync(seed, { recursive: true });
const env = {
  PATH: process.env.PATH!, HOME: seed, TMPDIR: work,
  NODE_EXTRA_CA_CERTS: f.cert!, SSL_CERT_FILE: f.cert!,
  OMNI_ENCRYPTION_KEY: "b4-antigravity-fixture-0123456789012345",
  OMNI_HOST: "127.0.0.1", OMNI_PORT: "18526", OMNI_LOG_LEVEL: "debug",
  OMNI_STATIC_DIR: join(work, "absent"), OMNI_DAY_OFFSET_MINUTES: "0",
};
const seedDb = join(seed, "omnigateway.db");
async function cli(args: string[]) {
  const p = Bun.spawn(["bun", "--no-env-file", "apps/cli/src/index.ts", "--root", seed, "--json", ...args], {
    cwd: resolve(import.meta.dir, "../.."), env: { ...env, OMNI_DB_PATH: seedDb },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (await p.exited) throw Error(err);
  return JSON.parse(out);
}
const key = (await cli(["keys", "create", "--label", "fixture"])).key;
const fieldKey = await deriveKey(env.OMNI_ENCRYPTION_KEY);
for (const alias of ["test-model", "antigravity-alias"]) {
  const file = join(seed, `${alias}.json`);
  await Bun.write(file, JSON.stringify({ id: alias, strategy: "priority", isAlias: alias !== "test-model", targets: [{
    provider: "antigravity", model: "gemini-2.5-pro", tier: 1, weight: 1,
    costPerMTok: { input: 1, output: 2 }, capabilities: { tools: true, images: true, reasoning: true },
  }] }));
  await cli(["models", "put", alias, "-f", file]);
}
const db = new Database(seedDb);
for (const [id, tier] of [["primary", 1], ["secondary", 2]] as const) {
  db.run(`INSERT INTO credentials (id,provider,label,auth_type,enabled,tier,weight,expires_at,provider_data,access_token,refresh_token,created_at,updated_at,token_version)
    VALUES (?,'antigravity',?,'oauth',1,?,1,4102444800000,?,?,?,1000,1000,0)`,
    [id, id, tier, JSON.stringify({ projectId: `project-${id}`, tier: "fixture" }),
      await encrypt(fieldKey, `${id}-access`), await encrypt(fieldKey, `${id}-refresh`)]);
}
db.close();

type Case = { name: string; path: string; stream?: boolean; code?: number; kind?: string; failover?: boolean; profile?: string };
const cases: Case[] = [];
for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
  for (const stream of [false, true]) {
    for (const kind of ["rich", "tools", "truncated", "unknown-finish"]) cases.push({ name: `${path}/${stream}/${kind}`, path, stream, kind });
  }
}
for (const code of [400, 401, 403, 404, 429, 500, 503]) {
  for (const failover of [false, true]) cases.push({ name: `http-${code}/failover-${failover}`, path: "/v1/chat/completions", code, failover });
}
for (const kind of ["bare", "missing-project", "refresh", "invalid-grant"]) cases.push({ name: kind, path: "/v1/chat/completions", kind });
for (const profile of ["version", "all"]) cases.push({ name: `profile-${profile}`, path: "/v1/chat/completions", profile });
// Listing row: plain equality since the catalog-aware /v1/models listing merged (b5597230).
cases.push({ name: "listing-alias", path: "/v1/models", kind: "listing" });

type Wire = { url: string; method: string; headers: string[]; body: string };
let recorded: Wire[] = [], boot: Wire[] = [];
let current: Case = cases[0]!;
let phase = 0, active = false;
const frame = (response: any) => `data: ${JSON.stringify({ response })}\n\n`;
const stub = Bun.listen<{ buffer: Buffer }>({ hostname: "127.0.0.1", port: 443,
  tls: { cert: Bun.file(f.cert!), key: Bun.file(f.key!) }, socket: {
    open(s) { s.data = { buffer: Buffer.alloc(0) }; },
    data(s, chunk) {
      s.data.buffer = Buffer.concat([s.data.buffer, chunk]);
      const raw = s.data.buffer.toString();
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = raw.slice(0, end).split("\r\n");
      const size = Number(head.find(h => /^content-length:/i.test(h))?.split(":")[1] ?? 0);
      if (s.data.buffer.length < end + 4 + size) return;
      const [method, path] = head.shift()!.split(" ");
      const host = head.find(h => /^host:/i.test(h))!.slice(5).trim();
      const body = s.data.buffer.subarray(end + 4, end + 4 + size).toString();
      const wire = { url: `https://${host}${path}`, method: method!, headers: head, body };
      s.data.buffer = s.data.buffer.subarray(end + 4 + size);
      const quota = path!.includes("retrieveUserQuotaSummary");
      (active && !quota ? recorded : boot).push(wire);
      const token = host === "oauth2.googleapis.com";
      let status = quota ? 200 : token ? (current.kind === "invalid-grant" ? 400 : 200) :
        current.code && (!current.failover || !head.some(h => h === "Authorization: Bearer secondary-access")) ? current.code : 200;
      let reply = quota ? '{}' : token ? (status === 400 ? '{"error":"invalid_grant"}' : '{"access_token":"new-access","refresh_token":"new-refresh"}') :
        status !== 200 ? JSON.stringify({ error: { code: status, message: "fixture refusal", status: ({400:"INVALID_ARGUMENT",401:"UNAUTHENTICATED",403:"PERMISSION_DENIED",404:"NOT_FOUND",429:"RESOURCE_EXHAUSTED",500:"INTERNAL",503:"UNAVAILABLE"} as any)[status] } }) : "";
      if (!token && !quota && status === 200) {
        const parts: any[] = current.kind === "tools" && phase === 0 ? [{ functionCall: { id: "call_fixture", name: current.path === "/v1/responses" ? "_1read_file" : "read_file", args: { path: "x" } } }] :
          [{ thought: true, text: "consider" }, { text: "hello" }];
        reply = frame({ responseId: "upstream-fixture", modelVersion: "gemini-2.5-pro", candidates: [{ content: { role: "model", parts } }] });
        if (current.kind !== "truncated") reply += frame({ candidates: [{ finishReason: current.kind === "unknown-finish" ? "FUTURE_REASON" : "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2, cachedContentTokenCount: 1 } });
      }
      s.write(`HTTP/1.1 ${status} Fixture\r\nContent-Type: ${!token && !quota && status === 200 ? "text/event-stream" : "application/json"}\r\nContent-Length: ${Buffer.byteLength(reply)}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n${reply}`);
      s.end();
    },
  },
});

function request(c: Case, roundtrip = false): any {
  const model = c.kind === "bare" ? "gemini-2.5-pro" : "test-model";
  // Responses rejects spaces before dispatch, but permits a leading digit;
  // Cloud Code rejects that digit, exercising cloak through this surface too.
  const name = c.path === "/v1/responses" ? "1read_file" : "read file";
  const common = { model, stream: !!c.stream, max_tokens: 128 };
  if (c.path === "/v1/messages") return { ...common, system: "fixture system", thinking: { type: "enabled", budget_tokens: 1024 },
    tools: [{ name, input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] },
      ...(roundtrip ? [{ role: "assistant", content: [{ type: "tool_use", id: "call_fixture", name, input: { path: "x" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_fixture", content: "file contents" }] }] : [])] };
  if (c.path === "/v1/responses") return { model, stream: !!c.stream, instructions: "fixture system", reasoning: { effort: "high" },
    tools: [{ type: "function", name, parameters: { type: "object", properties: { path: { type: "string" } } } }],
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: "data:image/png;base64,aGk=" }] },
      ...(roundtrip ? [{ type: "function_call", call_id: "call_fixture", name, arguments: '{"path":"x"}' }, { type: "function_call_output", call_id: "call_fixture", output: "file contents" }] : [])] };
  return { ...common, reasoning_effort: "high", tools: [{ type: "function", function: { name, parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    messages: [{ role: "system", content: "fixture system" }, { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }] },
      ...(roundtrip ? [{ role: "assistant", content: null, tool_calls: [{ id: "call_fixture", type: "function", function: { name, arguments: '{"path":"x"}' } }] }, { role: "tool", tool_call_id: "call_fixture", content: "file contents" }] : [])] };
}
const logMask = (row: any) => Object.fromEntries(Object.entries(row).filter(([k]) => !["id", "at", "duration_ms", "ttft_ms", "updated_at", "node_id"].includes(k)));
async function run(binary: string, label: string) {
  const rows: any[] = [];
  for (const [i, c] of cases.entries()) {
    current = c; phase = 0; active = false; recorded = []; boot = [];
    const root = join(work, `${label}-${i}`); mkdirSync(root);
    const file = join(root, "omni.db"); copyFileSync(seedDb, file);
    const writer = new Database(file);
    if (!c.failover) writer.run("DELETE FROM credentials WHERE id='secondary'");
    if (c.kind === "missing-project") writer.run("UPDATE credentials SET provider_data='{}'");
    writer.close();
    const profile = c.profile ? { OMNI_ANTIGRAVITY_IDE_VERSION: "9.8.7", ...(c.profile === "all" ? { OMNI_UA_ANTIGRAVITY: "fixture-antigravity/9.8.7", OMNI_ORDER_ANTIGRAVITY: "Host,User-Agent,Authorization,Accept,Content-Type,Content-Length,Accept-Encoding" } : {}) } : {};
    const child = Bun.spawn([resolve(binary)], { cwd: root, env: { ...env, ...profile, HOME: root, OMNI_ROOT: root, OMNI_DB_PATH: file }, stdout: Bun.file(join(root,"stdout")), stderr: Bun.file(join(root,"stderr")) });
    try {
      let ready = false;
      for (let n = 0; n < 200; n++) {
        try { if ((await fetch("http://127.0.0.1:18526/health", { keepalive: false })).ok) { ready = true; break; } } catch {}
        await Bun.sleep(25);
      }
      if (!ready) throw Error(`boot failed: ${root}`);
      await Bun.sleep(400);
      if (["refresh", "invalid-grant"].includes(c.kind!)) {
        const w = new Database(file); w.run("UPDATE credentials SET expires_at=1"); w.close();
        await Bun.sleep(1500); // frozen and Rust external-store watchers
      }
      active = true; recorded = [];
      const clients = [];
      for (phase = 0; phase < (c.kind === "tools" ? 2 : 1); phase++) {
        try {
        const response = await fetch("http://127.0.0.1:18526" + c.path, {
          method: c.kind === "listing" ? "GET" : "POST", keepalive: false,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: c.kind === "listing" ? undefined : JSON.stringify(request(c, phase === 1)), signal: AbortSignal.timeout(20000),
        });
        clients.push({ status: response.status, headers: [...response.headers.entries()], body: Buffer.from(await response.arrayBuffer()).toString(), route: c.path });
        } catch (error) {
          // A refused streaming response can close before headers (negative
          // control). Retain it as a failing row, never abort the red table.
          clients.push({ status: 0, headers: [], body: `TRANSPORT:${(error as any).code ?? String(error)}`, route: c.path });
        }
      }
      active = false;
      child.kill("SIGTERM"); await child.exited;
      const d = new Database(file);
      const credentials = d.query("SELECT * FROM credentials ORDER BY id").all() as any[];
      for (const r of credentials) {
        for (const k of ["api_key", "access_token", "refresh_token", "id_token"]) if (r[k] !== null) r[k] = await decrypt(fieldKey, r[k]);
        delete r.updated_at;
        if (r.disabled_at !== null) r.disabled_at = "<disabled-time>";
      }
      const logs = d.query("SELECT * FROM request_logs ORDER BY rowid").all().map(logMask); d.close();
      rows.push({ name: c.name, clients, upstream: [...recorded], credentials, logs, boot: [...boot] });
    } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
  }
  return rows;
}

// Only the envelope's generated requestId is masked upstream; all other bytes,
// including header order/case, URL, form bytes and content length stay literal.
function wireMask(w: Wire) {
  return { ...w, body: w.body.replace(new RegExp(`("requestId":")req_${REQUEST_UUID}("(?=,))`, "g"), '$1req_<id>$2') };
}
function norm(c: any) {
  return normalize({ ...c, body: Buffer.from(c.body), headers: c.headers.filter(([k]: string[]) => !["date", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(k!)) });
}
function valid(row: any, c: Case): boolean {
  if (row.clients.length !== (c.kind === "tools" ? 2 : 1)) return false;
  if (c.kind === "listing") return row.clients[0].status === 200 && row.clients[0].body.includes("antigravity-alias");
  if (row.logs.length !== row.clients.length) return false;
  const tokens = row.upstream.filter((w: Wire) => w.url === "https://oauth2.googleapis.com/token");
  const inference = row.upstream.filter((w: Wire) => w.url.includes(":streamGenerateContent?alt=sse"));
  if (c.kind === "missing-project") return row.clients[0].status === 503 && inference.length === 0;
  if (c.kind === "invalid-grant") return tokens.length === 1 && inference.length === 0 && row.credentials[0].enabled === 0 && row.credentials[0].disabled_reason === "tokenRejected";
  if (c.kind === "refresh" && (tokens.length !== 1 || row.upstream[0] !== tokens[0] || row.credentials[0].access_token !== "new-access" || row.credentials[0].refresh_token !== "new-refresh" || row.credentials[0].token_version !== 1)) return false;
  if (!inference.length) return false;
  if (c.kind === "tools") {
    const name = c.path === "/v1/responses" ? "1read_file" : "read file";
    const cloaked = c.path === "/v1/responses" ? "_1read_file" : "read_file";
    if (!row.clients[0].body.includes(name) || inference.length !== 2 || !inference.every((w: Wire) => w.body.includes(`"name":"${cloaked}"`) && !w.body.includes(`"name":"${name}"`)) || !inference[1].body.includes('"functionResponse"')) return false;
  }
  if (c.code) {
    const succeeds = c.failover && c.code !== 400;
    const expected = succeeds ? 200 : c.code === 400 ? 400 : 503;
    const expectedCalls = c.code === 401 || c.code === 403 ? (succeeds ? 3 : 2) : succeeds ? 2 : 1;
    if (row.clients[0].status !== expected || inference.length !== expectedCalls) return false;
    if (succeeds && !inference.at(-1).headers.includes("Authorization: Bearer secondary-access")) return false;
  }
  if (c.profile) {
    const ua = c.profile === "all" ? "fixture-antigravity/9.8.7" : "antigravity/ide/9.8.7 darwin/arm64";
    if (!inference[0].headers.includes(`User-Agent: ${ua}`)) return false;
    // Host is transport-appended, not a profile header. Profile order begins
    // at User-Agent on the actual frozen wire.
    if (c.profile === "all" && inference[0].headers[0] !== `User-Agent: ${ua}`) return false;
  }
  if (!c.code && !["truncated", "unknown-finish"].includes(c.kind!) && row.clients.some((x: any) => x.status !== 200)) return false;
  return true;
}
try {
  const ts = await run(f.ts!, "ts"), rust = await run(f.rust!, "rust");
  await Bun.write(join(work, "ts.rows.json"), JSON.stringify(ts, null, 2));
  await Bun.write(join(work, "rust.rows.json"), JSON.stringify(rust, null, 2));
  let failed = 0, equal = 0;
  const classes = {};
  console.log("| row | client | upstream | stored | scenario |\n|---|---|---|---|---|");
  for (const [i, c] of cases.entries()) {
    const a = ts[i]!, b = rust[i]!;
    const client = a.clients.length === b.clients.length && a.clients.every((x: any, j: number) => normalizedEqual(norm(x),norm(b.clients[j])));
    const upstream = isDeepStrictEqual(a.upstream.map(wireMask),b.upstream.map(wireMask));
    const stored = isDeepStrictEqual(a.credentials,b.credentials) && isDeepStrictEqual(a.logs,b.logs);
    const scenario = valid(a,c) && valid(b,c);
    const pass = client && upstream && stored && scenario;
    if (pass) equal++; else failed++;
    console.log(`| ${c.name} | ${client} | ${upstream} | ${stored} | ${scenario ? "PASS" : "FAIL"} |`);
  }
  console.log(JSON.stringify({ rows: cases.length, equal, failed, classes, work }));
  process.exitCode = failed ? 1 : 0;
} finally { stub.stop(true); }
