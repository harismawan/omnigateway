#!/usr/bin/env bun
/** Actual gateway HTTP differential. Run via openai-ns.sh, never live providers. */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { deriveKey, encrypt } from "../../packages/store/src/encryption.ts";
import { normalize, normalizedEqual, show } from "./masks.ts";

const { values: f } = parseArgs({ options: Object.fromEntries(
  ["ts", "rust", "work", "cert", "key"].map(k => [k, { type: "string" as const }]),
) });
for (const k of ["ts", "rust", "work", "cert", "key"]) if (!f[k]) throw Error(`--${k} required`);
const work = resolve(f.work!);
const seed = join(work, "seed");
mkdirSync(seed, { recursive: true });
const env = { ...process.env, OMNI_ENCRYPTION_KEY: "openai-e2e-key-01234567890123456789",
  OMNI_DB_PATH: join(seed, "omnigateway.db"), OMNI_PORT: "18482", OMNI_HOST: "127.0.0.1",
  OMNI_LOG_LEVEL: "warn", OMNI_STATIC_DIR: join(work, "absent") };
async function cli(args: string[], input?: string) {
  const p = Bun.spawn(["bun", "apps/cli/src/index.ts", "--root", seed, "--json", ...args], {
    cwd: resolve(import.meta.dir, "../.."), env, stdin: input ? new TextEncoder().encode(input) : "ignore",
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (await p.exited) throw Error(err);
  return JSON.parse(out);
}
await cli(["credentials", "add-key", "openai", "--label", "openai"], "test-key\n");
const modelFile = join(seed, "model.json");
await Bun.write(modelFile, JSON.stringify({ id: "test-model", strategy: "priority", isAlias: false,
  targets: [{ provider: "openai", model: "gpt-5", tier: 1, weight: 1,
    costPerMTok: { input: 1, output: 2 }, capabilities: { tools: true, images: true, reasoning: true } }] }));
await cli(["models", "put", "test-model", "-f", modelFile]);
const key = (await cli(["keys", "create", "--label", "test"])).key;
const fieldKey = await deriveKey(env.OMNI_ENCRYPTION_KEY);
const oauthToken = await encrypt(fieldKey, "oauth-access");
const refreshToken = await encrypt(fieldKey, "oauth-refresh");
const identity = { accountId: "account-fixture", installationId: "11111111-1111-4111-8111-111111111111", idSalt: "ab".repeat(32) };
type Wire = { line: string; headers: string[]; body: string };
let recorded: Wire[] = [];
let status = 200;
const sse = [
  { type: "response.created", response: { id: "resp_fixed", model: "gpt-5" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_fixed", type: "message", role: "assistant", content: [] } },
  { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", output_index: 0, delta: "hello" },
  { type: "response.content_part.done", output_index: 0, content_index: 0, part: { type: "output_text", text: "hello" } },
  { type: "response.completed", response: { id: "resp_fixed", model: "gpt-5", status: "completed", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
].map(x => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`).join("");
const listener = Bun.listen<{ buffer: Buffer }>({ hostname: "127.0.0.1", port: 443,
  tls: { cert: Bun.file(f.cert!), key: Bun.file(f.key!) },
  socket: {
    open(s) { s.data = { buffer: Buffer.alloc(0) }; },
    data(s, chunk) {
      s.data.buffer = Buffer.concat([s.data.buffer, chunk]);
      const end = s.data.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = s.data.buffer.subarray(0, end).toString();
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
      if (s.data.buffer.length < end + 4 + length) return;
      let body = s.data.buffer.subarray(end + 4, end + 4 + length);
      if (/content-encoding: zstd/i.test(head)) body = Buffer.from(Bun.zstdDecompressSync(body));
      const [line, ...headers] = head.split("\r\n");
      // Compression implementations need not produce equal frame lengths.
      recorded.push({ line: line!, headers: headers.filter(h => !/^content-length:/i.test(h)), body: body.toString() });
      s.data.buffer = s.data.buffer.subarray(end + 4 + length);
      const probe = line!.startsWith("GET ");
      const code = probe ? 200 : status;
      const response = probe ? "{}" : code === 200 ? sse : '{"error":{"message":"fixture refusal","type":"invalid_request_error","code":"fixture"}}';
      s.write(`HTTP/1.1 ${code} Fixture\r\nContent-Type: ${!probe && code === 200 ? "text/event-stream" : "application/json"}\r\nContent-Length: ${Buffer.byteLength(response)}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n${response}`);
      s.end();
    },
  },
});
const cases = [false, true].flatMap(oauth => ["/v1/chat/completions", "/v1/messages", "/v1/responses"].flatMap(path =>
  [false, true].flatMap(stream => [200, 400, 429, 500].map(code => ({ oauth, path, stream, code })))));
function request(path: string, stream: boolean) {
  return path === "/v1/responses" ? { model: "test-model", stream, input: "hello" } :
    { model: "test-model", stream, max_tokens: 128, messages: [{ role: "user", content: "hello" }] };
}
async function run(binary: string, label: string) {
  const output = [];
  for (const [i, c] of cases.entries()) {
    const root = join(work, `${label}-${i}`);
    mkdirSync(root);
    const dbPath = join(root, "omni.db");
    copyFileSync(env.OMNI_DB_PATH, dbPath);
    if (c.oauth) {
      const db = new Database(dbPath);
      db.run("UPDATE credentials SET auth_type='oauth',api_key=NULL,access_token=?,refresh_token=?,expires_at=?,provider_data=?",
        [oauthToken, refreshToken, 4102444800000, JSON.stringify(identity)]);
      db.close();
    }
    const child = Bun.spawn([binary], { cwd: work, env: { ...env, OMNI_ROOT: root, OMNI_DB_PATH: dbPath },
      stdout: "ignore", stderr: Bun.file(join(root, "stderr")) });
    try {
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try { if ((await fetch("http://127.0.0.1:18482/health")).ok) { ready = true; break; } } catch {}
        await Bun.sleep(50);
      }
      if (!ready) throw Error(`boot failed ${root}`);
      await Bun.sleep(100);
      recorded = [];
      status = c.code;
      const res = await fetch(`http://127.0.0.1:18482${c.path}`, { method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(request(c.path, c.stream)), signal: AbortSignal.timeout(15000) });
      const body = new Uint8Array(await res.arrayBuffer());
      const upstream = recorded.filter(x => x.line.startsWith("POST "));
      if (upstream.length !== 1) throw Error(`upstream count ${label}/${i}: ${upstream.length}`);
      if (c.code === 200 && res.status !== 200) throw Error(`success status ${label}/${i}: ${res.status}`);
      if (c.code === 200 && !Buffer.from(body).includes("hello")) throw Error(`missing text ${label}/${i}`);
      const expected = c.oauth ? "/backend-api/codex/responses" : "/v1/responses";
      if (upstream[0]!.line !== `POST ${expected} HTTP/1.1`) throw Error("wrong upstream route");
      if (c.oauth && !upstream[0]!.headers.includes("chatgpt-account-id: account-fixture")) throw Error("account identity missing");
      output.push({ case: c, status: res.status, headers: [...res.headers.entries()], body: Buffer.from(body).toString(), upstream });
    } finally { child.kill("SIGTERM"); await child.exited; }
  }
  await Bun.write(join(work, `${label}.json`), JSON.stringify(output, null, 2));
  return output;
}
try {
  const ts = await run(resolve(f.ts!), "ts");
  const rust = await run(resolve(f.rust!), "rust");
  let failed = 0;
  for (const [i, c] of cases.entries()) {
    const norm = (row: typeof ts[number]) => normalize({ status: row.status, route: c.path,
      body: Buffer.from(row.body), headers: row.headers.filter(([k]) => !["date", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(k)) });
    const a = norm(ts[i]!); const b = norm(rust[i]!);
    const upstream = JSON.stringify(maskWire(ts[i]!.upstream, c.oauth)) === JSON.stringify(maskWire(rust[i]!.upstream, c.oauth));
    if (!normalizedEqual(a, b) || !upstream) {
      failed++;
      console.error("DIFF", i, c, { upstream, ts: show(a), rust: show(b) });
    }
  }
  console.log({ work, rows: cases.length, failed });
  if (failed) process.exitCode = 1;
} finally { listener.stop(true); }

// Only request-clock fields and the message UUID derived from that clock vary.
// Keep original ordered bytes, validate exact fixture paths and clock proximity,
// then replace their literal spans (including the nested metadata JSON string).
function maskWire(rows: Wire[], oauth: boolean): Wire[] {
  if (!oauth) return rows;
  return rows.map(row => {
    const body = JSON.parse(row.body);
    const metadataHeader = row.headers.find(h => h.startsWith("x-codex-turn-metadata: "))!;
    const metadata = metadataHeader.slice("x-codex-turn-metadata: ".length);
    const time = JSON.parse(metadata).turn_started_at_unix_ms;
    if (!Number.isInteger(time) || Math.abs(time - Date.now()) > 120000) throw Error("unexpected request clock");
    if (body.client_metadata["x-codex-turn-metadata"] !== metadata) throw Error("metadata header/body mismatch");
    const item = body.input[0];
    if (body.input.length !== 1 || item.type !== "message" || item.internal_chat_message_metadata_passthrough.create_time !== time / 1000 ||
      !/^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)) throw Error("unexpected time-derived message");
    const maskedMetadata = metadata.replace(`"turn_started_at_unix_ms":${time}`, '"turn_started_at_unix_ms":0');
    return { ...row, headers: row.headers.map(h => h === metadataHeader ? `x-codex-turn-metadata: ${maskedMetadata}` : h),
      body: row.body.replace(JSON.stringify(metadata), JSON.stringify(maskedMetadata))
        .replace(`"create_time":${time / 1000}`, '"create_time":0')
        .replace(`"id":"${item.id}"`, '"id":"msg_<clock-derived>"') };
  });
}
