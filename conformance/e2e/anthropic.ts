#!/usr/bin/env bun
/** Run inside an isolated network/mount namespace mapping api.anthropic.com
 * to loopback. Trust the supplied local certificate in both runtimes. */
import { Database } from "bun:sqlite";
import { mkdirSync, copyFileSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { normalize, normalizedEqual } from "./masks.ts";
import { deriveKey, encrypt, decrypt } from "../../packages/store/src/encryption.ts";
const { values: f } = parseArgs({
  options: {
    ts: { type: "string" },
    rust: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    oauth: { type: "boolean", default: false },
    "boot-oauth": { type: "boolean", default: false },
  },
});
if (!f.ts || !f.rust || !f.cert || !f.key) throw Error("--ts --rust --cert --key required");
const repo = resolve(import.meta.dir, "../..");
const work = mkdtempSync("/tmp/opencode/anthropic-e2e-");
const seed = join(work, "seed");
mkdirSync(seed);
const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: "anthropic-e2e-key-012345678901234567",
  OMNI_DB_PATH: join(seed, "omnigateway.db"),
  OMNI_PORT: "18482",
  OMNI_HOST: "127.0.0.1",
  OMNI_LOG_LEVEL: "warn",
  OMNI_STATIC_DIR: join(work, "absent"),
};
async function cli(args: string[], stdin?: string) {
  const p = Bun.spawn(["bun", "apps/cli/src/index.ts", "--root", seed, "--json", ...args], {
    cwd: repo,
    env,
    stdin: stdin ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  if (await p.exited) throw Error(err);
  return JSON.parse(out);
}
await cli(["credentials", "add-key", "anthropic", "--label", "anthropic"], "test-key\n");
const modelFile = join(seed, "model.json");
await Bun.write(
  modelFile,
  JSON.stringify({
    id: "test-model",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-5-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 4, output: 20 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  }),
);
await cli(["models", "put", "test-model", "-f", modelFile]);
const key = (await cli(["keys", "create", "--label", "test"])).key;
const fieldKey = await deriveKey(env.OMNI_ENCRYPTION_KEY);
async function seedOAuth(db: Database, expired: boolean) {
  db.run("UPDATE credentials SET enabled=1,disabled_reason=NULL,disabled_at=NULL,auth_type='oauth',access_token=?,refresh_token=?,api_key=NULL,expires_at=?,token_version=0,account_email=NULL", [await encrypt(fieldKey, "old-access"), await encrypt(fieldKey, "old-refresh"), expired ? 1 : 4102444800000]);
}
if (f["boot-oauth"]) f.oauth = true;
if (f.oauth) {
  const db = new Database(env.OMNI_DB_PATH);
  await seedOAuth(db, !!f["boot-oauth"]);
  db.close();
}
let status = 200;
let inferenceCalls = 0;
let reactive = false;
let recorded: string[] = [];
let sequence: string[] = [];
let scenario = 0;
let currentDatabase = "";
const sse =
  'event: message_start\ndata: {"message":{"id":"msg_fixed","model":"claude-opus-5-5","usage":{"input_tokens":10}}}\n\nevent: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: content_block_stop\ndata: {"index":0}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {}\n\n';
const listener = Bun.listen<{ buffer: Buffer }>({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: Bun.file(f.cert), key: Bun.file(f.key) },
  socket: {
    open(s) {
      s.data = { buffer: Buffer.alloc(0) };
    },
    async data(s, chunk) {
      s.data.buffer = Buffer.concat([s.data.buffer, chunk]);
      const raw = s.data.buffer.toString();
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(raw.slice(0, end))?.[1] ?? 0);
      if (s.data.buffer.length < end + 4 + length) return;
      recorded.push(s.data.buffer.subarray(0, end + 4 + length).toString());
      sequence.push(raw.split("\r\n")[0]!);
      s.data.buffer = s.data.buffer.subarray(end + 4 + length);
      const token = raw.startsWith("POST /v1/oauth/token ");
      if (token && [4,6].includes(scenario)) await Bun.sleep(200);
      if (token && scenario === 5) {
        const db = new Database(currentDatabase);
        db.run("UPDATE credentials SET access_token=?,refresh_token=?,expires_at=NULL,token_version=token_version+1", [await encrypt(fieldKey,"winner-access"),await encrypt(fieldKey,"winner-refresh")]);
        db.close();
      }
      const responseStatus = token ? ([2,3,6].includes(scenario) ? 400 : 200) : reactive && inferenceCalls++ === 0 ? 401 : status;
      const body = token ? (responseStatus === 400 ? '{"error":"invalid_grant"}' : JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", account: { email_address: "new@example.com" } })) :
        responseStatus === 200
          ? sse
          : JSON.stringify({
              error: {
                type: status === 529 ? "overloaded_error" : "api_error",
                message: "fixture refusal",
              },
            });
      s.write(
        `HTTP/1.1 ${responseStatus} Fixture\r\nContent-Type: ${!token && responseStatus === 200 ? "text/event-stream" : "application/json"}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n${body}`,
      );
      s.end();
    },
  },
});
const cases = [];
for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses"])
  for (const stream of [false, true])
    for (const code of [200, 400, 429, 500, 529]) cases.push({ path, stream, code });
if (f.oauth) cases.splice(0, cases.length, ...Array.from({length:f["boot-oauth"] ? 2 : 7},()=>({path:"/v1/messages",stream:false,code:200})));
function request(path: string, stream: boolean) {
  const common = { model: "test-model", stream, max_tokens: 128 };
  if (path === "/v1/responses")
    return {
      model: "test-model",
      stream,
      input: "hello",
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
    };
  if (path === "/v1/messages")
    return {
      ...common,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
          ],
        },
      ],
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
    };
  return {
    ...common,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  };
}
async function run(binary: string, label: string) {
  recorded = [];
  reactive = false;
  inferenceCalls = 0;
  const root = join(work, label);
  scenario = 0;
  currentDatabase = join(root, "omni.db");
  mkdirSync(root);
  copyFileSync(env.OMNI_DB_PATH, join(root, "omni.db"));
  let child = Bun.spawn([binary], {
    cwd: work,
    env: { ...env, OMNI_ROOT: root, OMNI_DB_PATH: join(root, "omni.db") },
    stdout: "ignore",
    stderr: Bun.file(join(root, "stderr")),
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch("http://127.0.0.1:18482/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(50);
    }
    if (!ready) throw Error("boot failed");
    await Bun.sleep(500); // Let the independent boot quota probe settle before expiry mutation.
    const output = [];
    // Counting is local even for Anthropic: no upstream request and no request log.
    if (!f.oauth) recorded = [];
    const count = await fetch("http://127.0.0.1:18482/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi there" }],
      }),
    });
    const counted = await count.text();
    if (counted !== '{"input_tokens":10}' || (!f.oauth && recorded.length))
      throw Error(`count mismatch ${counted}`);
    const bootTraffic: string[][] = [];
    for (const c of cases) {
      scenario = f.oauth ? output.length : -1;
      reactive = !!f.oauth && output.length === 1;
      inferenceCalls = 0;
      status = c.code;
      if (f.oauth) {
        bootTraffic.push([...recorded]);
        if (!f["boot-oauth"] && recorded.some(x => x.startsWith("POST /v1/oauth/token "))) throw Error("token refreshed before request while valid at boot");
        if (output.length !== 1 && !f["boot-oauth"]) {
          const db = new Database(join(root, "omni.db"));
          db.run("UPDATE credentials SET expires_at=1");
          if (scenario === 3) {
            db.run("UPDATE credentials SET weight=100000");
            db.run("INSERT INTO credentials (id,provider,label,auth_type,api_key,created_at,updated_at) VALUES ('fallback','anthropic','fallback','apiKey',?,0,0)", [await encrypt(fieldKey,"fallback-key")]);
          }
          db.close();
          await Bun.sleep(1500); // Both frozen TS and Rust poll external store changes.
          if (recorded.some(x => x.startsWith("POST /v1/oauth/token "))) throw Error("background task refreshed post-boot token before request");
        }
      }
      recorded = [];
      sequence = ["client request sent"];
      const send = () => fetch("http://127.0.0.1:18482" + c.path, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(request(c.path, c.stream)),
        signal: AbortSignal.timeout(15000),
      });
      const responses = await Promise.all(Array.from({length:[4,6].includes(scenario) ? 4 : 1}, send));
      const res = responses[0]!;
      const extra = await Promise.all(responses.slice(1).map(async r=>({status:r.status,headers:[...r.headers.entries()],body:new Uint8Array(await r.arrayBuffer())})));
      const body = new Uint8Array(await res.arrayBuffer());
      output.push({
        case: c,
        status: res.status,
        headers: [...res.headers.entries()],
        body,
        upstream: [...recorded],
        sequence: [...sequence],
        extra,
      });
      // Independent rows: no breaker/rate-limit state from the previous refusal.
      child.kill("SIGTERM");
      await child.exited;
      const db = new Database(join(root, "omni.db"));
      if (f.oauth) {
        const rows = db.query("SELECT * FROM credentials ORDER BY id").all() as any[];
        for (const row of rows) {
          for (const secret of ["access_token", "refresh_token", "api_key", "id_token"]) if (row[secret] !== null) row[secret] = await decrypt(fieldKey, row[secret]);
          delete row.updated_at;
          if (row.disabled_at !== null) row.disabled_at = "<disabled-time>";
        }
        (output.at(-1) as any).credential = rows;
        db.run("DELETE FROM credentials WHERE id='fallback'");
        db.run("UPDATE credentials SET weight=1");
        await seedOAuth(db, false);
      }
      db.exec("DELETE FROM credential_health");
      db.close();
      recorded = [];
      child = Bun.spawn([binary], {
        cwd: work,
        env: { ...env, OMNI_ROOT: root, OMNI_DB_PATH: join(root, "omni.db") },
        stdout: "ignore",
        stderr: Bun.file(join(root, "stderr")),
      });
      let restartReady = false;
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch("http://127.0.0.1:18482/health")).ok) {
            restartReady = true;
            break;
          }
        } catch {}
        await Bun.sleep(50);
      }
      if (!restartReady) throw Error("gateway restart did not become ready");
      await Bun.sleep(500);
    }
    await Bun.sleep(500);
    const db = new Database(join(root, "omni.db"));
    const logs = db.query("SELECT * FROM request_logs ORDER BY rowid").all();
    db.close();
    return { output, logs, bootTraffic };
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}
try {
  const ts = await run(resolve(f.ts), "ts");
  const rust = await run(resolve(f.rust), "rust");
  await Bun.write(join(work, "ts.json"), JSON.stringify(ts, null, 2));
  await Bun.write(join(work, "rust.json"), JSON.stringify(rust, null, 2));
  let failed = 0;
  if (f.oauth) console.log("Known B10 boot quota-poller difference (full bytes retained)", {ts:ts.bootTraffic.map(x=>x.map(y=>y.split("\r\n")[0])),rust:rust.bootTraffic.map(x=>x.map(y=>y.split("\r\n")[0]))});
  if (f["boot-oauth"]) {
    console.log({work, scenario:"boot-expired-quota-refresh", classification:"known B10 difference; not dispatch parity"});
    process.exit(0);
  }
  for (let i = 0; i < cases.length; i++) {
    for (const run of [ts, rust]) {
      const row = run.output[i]!;
      if (f.oauth && i >= 2) {
        const tokens = row.upstream.filter(x=>x.startsWith("POST /v1/oauth/token "));
        if (tokens.length !== 1 || row.sequence[1] !== "POST /v1/oauth/token HTTP/1.1") throw Error("expected one request-triggered refresh");
        const credentials = (row as any).credential;
        const oauth = credentials.find((c:any)=>c.auth_type === "oauth");
        if ([2,3,6].includes(i) && (oauth.enabled !== 0 || oauth.disabled_reason !== "tokenRejected")) throw Error("rejected token not disabled");
        if (i === 2 && (row.status !== 503 || !(run.logs[i] as any).error_code?.includes("ALL_CANDIDATES_FAILED"))) throw Error("expected TS aggregate rejection");
        if (i === 5 && (oauth.token_version !== 1 || oauth.access_token !== "winner-access" || oauth.account_email !== null)) throw Error("CAS winner overwritten");
      }
      if (f.oauth && i < 2) {
        const expected = i === 0 ? ["client request sent", "POST /v1/oauth/token HTTP/1.1", "POST /v1/messages HTTP/1.1"] : ["client request sent", "POST /v1/messages HTTP/1.1", "POST /v1/oauth/token HTTP/1.1", "POST /v1/messages HTTP/1.1"];
        if (JSON.stringify(row.sequence) !== JSON.stringify(expected)) throw Error(`refresh ordering: ${JSON.stringify(row.sequence)}`);
      }
      if (row.upstream.length !== (f.oauth ? [2,3,1,2,5,2,1][i] : 1) || (row.case.code === 200 && !(f.oauth && [2,6].includes(i)) && row.status !== 200)) {
        throw Error(
          `scenario did not reach the upstream exactly once: ${JSON.stringify(row.case)}`,
        );
      }
    }
    const norm = (x: any) =>
      normalize({
        status: x.status,
        headers: x.headers.filter(
          ([k]: string[]) =>
            !["date", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(
              k!,
            ),
        ),
        body: Buffer.from(x.body),
        route: x.case.path,
      });
    const a = norm(ts.output[i]);
    const b = norm(rust.output[i]);
    if (f.oauth) for (let n=0;n<ts.output[i]!.extra.length;n++) {
      const left = ts.output[i]!.extra[n]!;
      const right = rust.output[i]!.extra[n]!;
      if (!right || !normalizedEqual(norm({...ts.output[i],...left}), norm({...rust.output[i],...right}))) { console.error("DIFF concurrent client",n); failed++; }
    }
    const upstream =
      JSON.stringify(ts.output[i]!.upstream) === JSON.stringify(rust.output[i]!.upstream);
    if (!normalizedEqual(a, b) || !upstream) {
      console.error("DIFF", cases[i], { client: normalizedEqual(a, b), upstream });
      failed++;
    }
    if (f.oauth && JSON.stringify((ts.output[i] as any).credential) !== JSON.stringify((rust.output[i] as any).credential)) {
      console.error("DIFF credential", i);
      failed++;
    }
  }
  const logMask = (rows: any[]) =>
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([k]) => !["id", "at", "duration_ms", "ttft_ms", "updated_at", "node_id"].includes(k),
        ),
      ),
    );
  // Counting must not create a row; each inference must create exactly one.
   if (ts.logs.length !== cases.length + (f.oauth ? 6 : 0) || rust.logs.length !== cases.length + (f.oauth ? 6 : 0)) {
    throw Error(`request log count: TS=${ts.logs.length}, Rust=${rust.logs.length}`);
  }
  if (JSON.stringify(logMask(ts.logs)) !== JSON.stringify(logMask(rust.logs))) {
    console.error("DIFF request_logs");
    failed++;
  }
  console.log({ work, cases: cases.length, failed });
  if (failed) process.exitCode = 1;
} finally {
  listener.stop(true);
}
