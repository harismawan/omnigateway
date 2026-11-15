#!/usr/bin/env bun
/** A15 red-first differential, isolated by connect-ns.sh. No live networking.
 * Current coverage: start/validation/auth, non-device poll, failed exchange.
 * Success persistence uses the frozen store decrypt path for both databases.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deriveKey, decrypt, encrypt } from "../../packages/store/src/encryption.ts";

const { values: f } = parseArgs({ options: Object.fromEntries(
  ["ts", "rust", "work", "cert", "key"].map(k => [k, { type: "string" as const }]),
) });
for (const k of ["ts", "rust", "work", "cert", "key"]) if (!f[k]) throw Error(`--${k} required`);
const work = resolve(f.work!);
if (!work.startsWith("/tmp/opencode/a15/")) throw Error("work must be under /tmp/opencode/a15/");
const seed = join(work, "seed");
mkdirSync(seed, { recursive: true });
const baseEnv = {
  PATH: process.env.PATH!, HOME: work, TMPDIR: work,
  OMNI_ENCRYPTION_KEY: "a15-connect-key-01234567890123456789",
  OMNI_HOST: "127.0.0.1", OMNI_PORT: "18515", OMNI_LOG_LEVEL: "warn",
  OMNI_DAY_OFFSET_MINUTES: "0",
  NODE_EXTRA_CA_CERTS: f.cert!, SSL_CERT_FILE: f.cert!,
};
const seedDb = join(seed, "omnigateway.db");
const fieldKey = await deriveKey(baseEnv.OMNI_ENCRYPTION_KEY);
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cli = Bun.spawn(["bun", "--no-env-file", "apps/cli/src/index.ts", "--root", seed, "--json", "keys", "create", "--label", "seed"], {
  cwd: resolve(import.meta.dir, "../.."), env: { ...baseEnv, OMNI_DB_PATH: seedDb },
  stdout: Bun.file(join(work, "seed.log")), stderr: Bun.file(join(work, "seed.err")),
});
if (await cli.exited) throw Error("seed failed; see seed.err");
const password = "a15-admin-password";
const db = new Database(seedDb);
db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('adminPasswordHash',?)", [await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 })]);
// Identical SQL on the stopped seed DB; both gateways receive the same copy.
for (const provider of ["anthropic", "openai"]) for (const kind of ["full", "missing", "deleted", "key"]) {
  db.run(`INSERT INTO credentials (id,provider,label,auth_type,enabled,tier,weight,expires_at,account_email,provider_data,access_token,refresh_token,id_token,created_at,updated_at,disabled_reason,disabled_at,token_version)
    VALUES (?,?,?,?,0,3,2.5,4102444800000,'old@example.test',?,?,?,?,1000,2000,'fixture disabled',1500,7)`,
    [`${provider}-${kind}`, provider, "old label", kind === "key" ? "apiKey" : "oauth",
     JSON.stringify({ installationId: "11111111-1111-4111-8111-111111111111", idSalt: "a".repeat(64), accountId: "old-account", old: true }),
     await encrypt(fieldKey, "old-access"), await encrypt(fieldKey, "old-refresh"), await encrypt(fieldKey, "old-id")]);
}
db.close();

type Wire = { line: string; headers: string[]; body: string };
let wires: Wire[] = [];
let tokenStatus = 400;
let tokenBody = '{"error":"fixture_refusal"}';
let transport: "normal" | "close" | "partial" = "normal";
let tokenDelay = 0;
const stub = Bun.listen<{ buffer: Buffer }>({ hostname: "127.0.0.1", port: 443,
  tls: { cert: Bun.file(f.cert!), key: Bun.file(f.key!) },
  socket: {
    open(s) { s.data = { buffer: Buffer.alloc(0) }; },
    data(s, chunk) {
      s.data.buffer = Buffer.concat([s.data.buffer, chunk]);
      const end = s.data.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [line, ...headers] = s.data.buffer.subarray(0, end).toString().split("\r\n");
      const length = Number(headers.find(h => /^content-length:/i.test(h))?.split(":")[1] ?? 0);
      if (s.data.buffer.length < end + 4 + length) return;
      wires.push({ line: line!, headers, body: s.data.buffer.subarray(end + 4, end + 4 + length).toString() });
      if (transport === "close") { s.end(); return; }
      if (transport === "partial") { s.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{"access_token":'); return; }
      const reply = `HTTP/1.1 ${tokenStatus} Fixture\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(tokenBody)}\r\nConnection: close\r\n\r\n${tokenBody}`;
      if (tokenDelay) setTimeout(() => s.end(reply), tokenDelay);
      else s.end(reply);
    },
  },
});
type Row = { name: string; response: unknown; wire: Wire[] };
async function run(label: string, binary: string): Promise<Row[]> {
  const root = join(work, label);
  mkdirSync(root, { recursive: true });
  const file = join(root, "omni.db");
  copyFileSync(seedDb, file);
  const proc = Bun.spawn([resolve(binary)], { cwd: root,
    env: { ...baseEnv, OMNI_ROOT: root, OMNI_DB_PATH: file, OMNI_STATIC_DIR: join(root, "absent") },
    stdout: Bun.file(join(work, `${label}.log`)), stderr: Bun.file(join(work, `${label}.err`)),
  });
  const rows: Row[] = [];
  let cookie = "";
  async function request(path: string, body: string | undefined, auth = cookie, method = "POST") {
    const r = await fetch(`http://127.0.0.1:18515${path}`, { method, headers: {
      "content-type": "application/json", ...(auth ? { cookie: auth } : {}),
    }, body: method === "GET" ? undefined : body });
    const text = await r.text();
    let bodyValue: any;
    try { bodyValue = JSON.parse(text); } catch { bodyValue = text; }
    return { status: r.status, type: r.headers.get("content-type"), body: bodyValue, cookie: r.headers.get("set-cookie") };
  }
  async function row(name: string, route: string, body?: string, auth = cookie, method = "POST") {
    wires = [];
    const { cookie: _, ...response } = await request(`/api/connect/${route}`, body, auth, method);
    rows.push({ name, response, wire: wires.map(w => ({ ...w, headers: [...w.headers] })) });
    return response.body;
  }
  async function storedRow(id: string) {
    const reader = new Database(file, { readonly: true });
    const stored = reader.query("SELECT * FROM credentials WHERE id = ?").get(id) as any;
    reader.close();
    if (!stored) throw Error(`missing ${id}`);
    for (const field of ["access_token", "refresh_token", "id_token", "api_key"])
      if (stored[field] !== null) stored[field] = await decrypt(fieldKey, stored[field]);
    return stored;
  }
  async function successRows(provider: string, reconnect?: "full" | "missing") {
      const name = reconnect ? `${provider}/reconnect-${reconnect}` : `${provider}/success`;
      const credentialId = reconnect ? `${provider}-${reconnect}` : undefined;
      const prior = credentialId ? await storedRow(credentialId) : undefined;
      if (prior) rows.push({ name: `${name}/before`, response: prior, wire: [] });
      // Frozen decodeClaims requires a nonempty third segment, even though it
      // does not verify signatures. This fixture is deliberately not signed.
      const idToken = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ email: "fixture@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", organizations: [{ id: "fixture-org", is_default: true }] } })).toString("base64url")}.unsigned`;
      tokenStatus = 200;
      tokenBody = JSON.stringify({ access_token: `${provider}-new-access`, refresh_token: `${provider}-new-refresh`, expires_in: 3600,
        ...(provider === "openai" ? { id_token: idToken } : { account: { email_address: "fixture@example.test" } }) });
      if (reconnect === "missing") tokenBody = JSON.stringify({ access_token: `${provider}-new-access`, expires_in: 3600 });
      const success = await row(`${name}/start`, "start", JSON.stringify({ provider, label: "success label", credentialId: credentialId ? `  ${credentialId}  ` : undefined }));
      const successUrl = validateStart(success);
      const before = Date.now();
      const finished = await row(`${name}/finish`, "finish", JSON.stringify({ flowId: success.flowId, code: `fixture-code#${successUrl.searchParams.get("state")}` }));
      const after = Date.now();
      for (const wire of rows.at(-1)!.wire) {
        const json = wire.headers.some(h => /content-type: application\/json/i.test(h));
        const fields = json ? JSON.parse(wire.body) : Object.fromEntries(new URLSearchParams(wire.body));
        if (!/^[\w-]{43}$/.test(fields.code_verifier) || createHash("sha256").update(fields.code_verifier).digest("base64url") !== successUrl.searchParams.get("code_challenge")) throw Error("success PKCE invalid");
        if (Number(wire.headers.find(h => /^content-length:/i.test(h))?.split(":")[1]) !== Buffer.byteLength(wire.body)) throw Error("success length invalid");
        fields.code_verifier = "<verifier>";
        if (fields.state !== undefined) {
          if (fields.state !== successUrl.searchParams.get("state")) throw Error("success state invalid");
          fields.state = "<state>";
        }
        wire.headers = wire.headers.map(h => /^content-length:/i.test(h) ? "content-length: <validated>" : h);
        wire.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
      }
      if (finished?.id) {
        if (credentialId ? finished.id !== credentialId : !uuid4.test(finished.id)) throw Error("credential id invalid");
        const reader = new Database(file, { readonly: true });
        const stored = reader.query("SELECT * FROM credentials WHERE id = ?").get(finished.id) as any;
        reader.close();
        if (!stored || stored.id !== finished.id) throw Error("successful credential missing");
        for (const field of ["access_token", "refresh_token", "id_token", "api_key"]) {
          if (stored[field] !== null) stored[field] = await decrypt(fieldKey, stored[field]);
        }
        await Bun.write(join(root, `${provider}-${reconnect ?? "success"}.raw.json`), JSON.stringify({ before, after, prior, stored }, null, 2));
        // 2s clock/serialization tolerance, validated before any time masking.
        for (const [field, delta] of [["expires_at", 3600000], ["created_at", 0], ["updated_at", 0]] as const) {
          if (prior && field === "created_at") { if (stored[field] !== prior[field]) throw Error("created_at changed"); continue; }
          if (!Number.isSafeInteger(stored[field]) || stored[field] < before + delta - 2000 || stored[field] > after + delta + 2000) throw Error(`invalid ${field}`);
          stored[field] = `<request-time+${delta};tolerance=2000ms>`;
        }
        if (provider === "openai") {
          const data = JSON.parse(stored.provider_data);
          if (!uuid4.test(data.installationId) || !/^[0-9a-f]{64}$/.test(data.idSalt)) throw Error("invalid Codex randomness");
          // Replace only validated random bytes; preserve JSON spacing/key order.
          if (!prior) stored.provider_data = stored.provider_data.replace(data.installationId, "<installation>").replace(data.idSalt, "<salt>");
        }
        if (!prior) { stored.id = "<uuid4>"; finished.id = "<uuid4>"; }
        else stored.token_version_delta = stored.token_version - prior.token_version;
        rows.push({ name: `${name}/persistence`, response: stored, wire: [] });
      } else rows.push({ name: `${name}/persistence`, response: { missing: true }, wire: [] });
    }
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      try { await request("/health", undefined, "", "GET"); break; } catch {
        if (proc.exitCode !== null || Date.now() > deadline) throw Error(`${label} failed to boot`);
        await Bun.sleep(50);
      }
    }
    const login = await request("/api/login", JSON.stringify({ password }), "");
    if (login.status !== 200 || !login.cookie) throw Error(`${label} login failed`);
    cookie = login.cookie.split(";")[0]!;
    for (const route of ["start", "finish", "poll"]) {
      for (const auth of ["", "omni_session=bad"]) await row(`${route}/auth/${auth}`, route, "{}", auth);
      await row(`${route}/GET`, route, undefined, cookie, "GET");
      for (const body of [undefined, "{", "null", "[]", "1", "{}"])
        await row(`${route}/body/${body}`, route, body);
    }
    for (const provider of ["unknown", "plugin-fixture", "custom", "kimi", "kilo", "grok", "antigravity", "muse", "qoder", "qwen", "xai", "constructor", null, 1])
      await row(`start/provider/${provider}`, "start", JSON.stringify({ provider }));
    for (const route of ["finish", "poll"])
      for (const flowId of ["", "unknown", null, 1])
        await row(`${route}/flow/${flowId}`, route, JSON.stringify({ flowId, code: "code" }));
    for (const provider of ["anthropic", "openai"]) {
      for (const credentialId of ["unknown", "", "  ", null, 1])
        await row(`${provider}/reconnect/${credentialId}`, "start", JSON.stringify({ provider, credentialId }));
      for (const labelValue of [undefined, " label ", 3]) {
        const start = await row(`${provider}/start/${labelValue}`, "start", JSON.stringify({ provider, label: labelValue }));
        if (!start.flowId) continue; // Missing Rust route stays a red row, not a harness crash.
        validateStart(start);
      }
      tokenStatus = 400; tokenBody = '{"error":"fixture_refusal"}';
      const start = await row(`${provider}/poll/start`, "start", JSON.stringify({ provider }));
      if (start.flowId) {
        validateStart(start);
        await row(`${provider}/poll`, "poll", JSON.stringify({ flowId: start.flowId }));
        for (const wire of rows.at(-1)!.wire) {
          const url = validateStart(start);
          const json = wire.headers.some(h => /content-type: application\/json/i.test(h));
          const fields = json ? JSON.parse(wire.body) : Object.fromEntries(new URLSearchParams(wire.body));
          if (fields.code !== "" || !/^[\w-]{43}$/.test(fields.code_verifier) || createHash("sha256").update(fields.code_verifier).digest("base64url") !== url.searchParams.get("code_challenge")) throw Error("poll PKCE invalid");
          if (fields.state !== undefined && fields.state !== url.searchParams.get("state")) throw Error("poll state invalid");
          if (Number(wire.headers.find(h => /^content-length:/i.test(h))?.split(":")[1]) !== Buffer.byteLength(wire.body)) throw Error("poll length invalid");
          fields.code_verifier = "<verifier>";
          if (fields.state !== undefined) fields.state = "<state>";
          wire.headers = wire.headers.map(h => /^content-length:/i.test(h) ? "content-length: <validated>" : h);
          wire.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
        }
        await row(`${provider}/poll/consumed`, "poll", JSON.stringify({ flowId: start.flowId }));
      }
      for (const [status, body] of [[400, '{"error":"fixture_refusal"}'], [401, '{}'], [429, '{}'], [500, '{}'], [200, '{'], [200, '{}']] as const) {
        tokenStatus = status; tokenBody = body;
        const start = await row(`${provider}/token/${status}/${body}/start`, "start", JSON.stringify({ provider }));
        if (!start.flowId) continue;
        const url = validateStart(start);
        await row(`${provider}/token/${status}/${body}/finish`, "finish", JSON.stringify({ flowId: start.flowId, code: `fixture-code#${url.searchParams.get("state")}` }));
        for (const wire of rows.at(-1)!.wire) {
          const json = wire.headers.some(h => /content-type: application\/json/i.test(h));
          const fields = json ? JSON.parse(wire.body) : Object.fromEntries(new URLSearchParams(wire.body));
          const verifier = fields.code_verifier;
          if (typeof verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== url.searchParams.get("code_challenge")) throw Error("PKCE relation invalid");
          fields.code_verifier = "<verifier>";
          if (fields.state !== undefined) {
            if (fields.state !== url.searchParams.get("state")) throw Error("wire state invalid");
            fields.state = "<state>";
          }
          // Length is validated against the original bytes before masking random values.
          const length = wire.headers.find(h => /^content-length:/i.test(h));
          if (Number(length?.split(":")[1]) !== Buffer.byteLength(wire.body)) throw Error("wire length invalid");
          wire.headers = wire.headers.map(h => /^content-length:/i.test(h) ? "content-length: <validated>" : h);
          wire.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
        }
        await row(`${provider}/token/${status}/${body}/used`, "finish", JSON.stringify({ flowId: start.flowId, code: "code" }));
      }
    }
    for (const provider of ["anthropic", "openai"]) await successRows(provider);
    for (const provider of ["anthropic", "openai"]) {
      await successRows(provider, "full");
      await successRows(provider, "missing");
      for (const [kind, credentialId] of Object.entries({ other: `${provider === "openai" ? "anthropic" : "openai"}-full`, apiKey: `${provider}-key`, object: {} }))
        await row(`${provider}/reconnect-refusal/${kind}`, "start", JSON.stringify({ provider, credentialId }));
      const start = await row(`${provider}/deleted/start`, "start", JSON.stringify({ provider, credentialId: `${provider}-deleted` }));
      const url = validateStart(start);
      const writer = new Database(file);
      writer.run("DELETE FROM credentials WHERE id = ?", [`${provider}-deleted`]); writer.close();
      await row(`${provider}/deleted/finish`, "finish", JSON.stringify({ flowId: start.flowId, code: `fixture-code#${url.searchParams.get("state")}` }));
      await row(`${provider}/deleted/consumed`, "finish", JSON.stringify({ flowId: start.flowId, code: "code" }));
    }
    for (const provider of ["anthropic", "openai"]) {
      for (const mode of ["close", "partial"] as const) for (const route of ["finish", "poll"]) {
        const name = `${provider}/transport/${mode}/${route}`;
        const start = await row(`${name}/start`, "start", JSON.stringify({ provider }));
        const url = validateStart(start);
        transport = mode;
        await row(name, route, JSON.stringify({ flowId: start.flowId, code: `fixture-code#${url.searchParams.get("state")}` }));
        for (const wire of rows.at(-1)!.wire) {
          const json = wire.headers.some(h => /content-type: application\/json/i.test(h));
          const fields = json ? JSON.parse(wire.body) : Object.fromEntries(new URLSearchParams(wire.body));
          if (!/^[\w-]{43}$/.test(fields.code_verifier) || createHash("sha256").update(fields.code_verifier).digest("base64url") !== url.searchParams.get("code_challenge")) throw Error("transport PKCE invalid");
          if (Number(wire.headers.find(h => /^content-length:/i.test(h))?.split(":")[1]) !== Buffer.byteLength(wire.body)) throw Error("transport length invalid");
          fields.code_verifier = "<verifier>";
          if (fields.state !== undefined) {
            if (fields.state !== url.searchParams.get("state")) throw Error("transport state invalid");
            fields.state = "<state>";
          }
          wire.headers = wire.headers.map(h => /^content-length:/i.test(h) ? "content-length: <validated>" : h);
          wire.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
        }
        transport = "normal";
        await row(`${name}/consumed`, route, JSON.stringify({ flowId: start.flowId, code: "code" }));
      }
    }
    for (const provider of ["anthropic", "openai"]) {
      const name = `${provider}/disconnect`;
      tokenStatus = 200;
      tokenBody = JSON.stringify({ access_token: `${provider}-disconnect-access`, refresh_token: "disconnect-refresh", expires_in: 3600 });
      const start = await row(`${name}/start`, "start", JSON.stringify({ provider, label: name }));
      const url = validateStart(start);
      tokenDelay = 1000;
      wires = [];
      const controller = new AbortController();
      const response = fetch("http://127.0.0.1:18515/api/connect/finish", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ flowId: start.flowId, code: `fixture-code#${url.searchParams.get("state")}` }), signal: controller.signal }).then(() => "responded", () => "aborted");
      await Bun.sleep(200);
      controller.abort();
      if (await response !== "aborted") throw Error("disconnect request did not abort");
      await Bun.sleep(2000);
      tokenDelay = 0;
      const reader = new Database(file, { readonly: true });
      const stored = reader.query("SELECT access_token FROM credentials WHERE label = ?").all(name) as any[];
      reader.close();
      rows.push({ name, response: { requests: wires.length, credentials: stored.length, access: await Promise.all(stored.map(r => decrypt(fieldKey, r.access_token))) }, wire: [] });
      await row(`${name}/consumed`, "finish", JSON.stringify({ flowId: start.flowId, code: "code" }));
    }
    return rows;
  } finally { proc.kill(); await proc.exited; }
}
function validateStart(start: any): URL {
  if (!/^[\w-]{43}$/.test(start.flowId)) throw Error("invalid flow id");
  const url = new URL(start.authorizeUrl);
  if (!/^[\w-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") || url.searchParams.get("code_challenge_method") !== "S256" || !/^[\w-]{43}$/.test(url.searchParams.get("state") ?? "")) throw Error("invalid authorize randomness");
  return url;
}
function masked(rows: Row[]): Row[] {
  return rows.map(row => {
    const r = structuredClone(row);
    const body = (r.response as any).body;
    if (["grok", "antigravity", "muse", "qoder"].some(p => r.name === `start/provider/${p}`)) return r;
    if (body?.flowId) {
      const url = validateStart(body);
      body.flowId = "<flow>";
      url.searchParams.set("state", "<state>"); url.searchParams.set("code_challenge", "<challenge>");
      body.authorizeUrl = url.toString();
    }
    return r;
  });
}
try {
  const ts = masked(await run("ts", f.ts!));
  const rust = masked(await run("rust", f.rust!));
  await Bun.write(join(work, "ts.rows.json"), JSON.stringify(ts, null, 2));
  await Bun.write(join(work, "rust.rows.json"), JSON.stringify(rust, null, 2));
  const names = new Set([...ts, ...rust].map(r => r.name));
  let failed = 0, expectedDivergences = 0;
  for (const name of names) {
    const a = ts.find(r => r.name === name), b = rust.find(r => r.name === name);
    const ar = a?.response as any, br = b?.response as any;
    const frozen = "provider must be one of anthropic, openai, kimi, kilo, grok, antigravity, muse, qoder";
    if (name === "start/provider/grok" || name === "start/provider/muse") {
      const expected = name === "start/provider/grok" ? "grok oauth start threw" : "muse oauth begin threw";
      if (ar?.status === 502 && ar.body.error.code === "UPSTREAM" && ar.body.error.message === expected && br?.status === 400 && br.body.error.code === "BAD_REQUEST" && br.body.error.message === "provider must be one of anthropic, openai") { expectedDivergences++; continue; }
    }
    if (["grok", "antigravity", "muse", "qoder"].some(p => name === `start/provider/${p}`)) {
      if (ar?.status === 200 && typeof ar.body.authorizeUrl === "string" && /^[\w-]{43}$/.test(ar.body.flowId) && br?.status === 400 && br.body.error.code === "BAD_REQUEST" && br.body.error.message === "provider must be one of anthropic, openai") { expectedDivergences++; continue; }
    }
    if (ar?.body?.error?.message === frozen || name === "start/provider/kimi" || name === "start/provider/kilo") {
      const expected = name === "start/provider/kimi" ? "kimi oauth begin threw" : name === "start/provider/kilo" ? "kilo oauth begin threw" : frozen;
      if (ar.body.error.message === expected && br?.status === 400 && br.body.error.code === "BAD_REQUEST" && br.body.error.message === "provider must be one of anthropic, openai") { expectedDivergences++; continue; }
    }
    if (!isDeepStrictEqual(a,b)) { failed++; console.log(`FAILED ${name}`); }
  }
  console.log(JSON.stringify({ rows: names.size, failed, expectedDivergences }));
  process.exitCode = failed ? 1 : 0;
} finally { stub.stop(true); }
