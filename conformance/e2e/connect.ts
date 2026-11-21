#!/usr/bin/env bun
/** A15 red-first differential, isolated by connect-ns.sh. No live networking.
 * Current coverage: start/validation/auth, non-device poll, failed exchange.
 * Success persistence uses the frozen store decrypt path for both databases.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { decrypt, deriveKey, encrypt } from "../../packages/store/src/encryption.ts";

const { values: f } = parseArgs({
  options: Object.fromEntries(
    ["ts", "rust", "work", "cert", "key"].map((k) => [k, { type: "string" as const }]),
  ),
});
for (const k of ["ts", "rust", "work", "cert", "key"]) if (!f[k]) throw Error(`--${k} required`);
const work = resolve(f.work!);
if (!["/tmp/opencode/a15/", "/tmp/opencode/b4/connect2/"].some((p) => work.startsWith(p)))
  throw Error("invalid private work directory");
const seed = join(work, "seed");
mkdirSync(seed, { recursive: true });
const baseEnv = {
  PATH: process.env.PATH!,
  HOME: work,
  TMPDIR: work,
  OMNI_ENCRYPTION_KEY: "a15-connect-key-01234567890123456789",
  OMNI_HOST: "127.0.0.1",
  OMNI_PORT: "18515",
  OMNI_LOG_LEVEL: "debug",
  OMNI_DAY_OFFSET_MINUTES: "0",
  NODE_EXTRA_CA_CERTS: f.cert!,
  SSL_CERT_FILE: f.cert!,
};
const seedDb = join(seed, "omnigateway.db");
const fieldKey = await deriveKey(baseEnv.OMNI_ENCRYPTION_KEY);
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cli = Bun.spawn(
  [
    "bun",
    "--no-env-file",
    "apps/cli/src/index.ts",
    "--root",
    seed,
    "--json",
    "keys",
    "create",
    "--label",
    "seed",
  ],
  {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...baseEnv, OMNI_DB_PATH: seedDb },
    stdout: Bun.file(join(work, "seed.log")),
    stderr: Bun.file(join(work, "seed.err")),
  },
);
if (await cli.exited) throw Error("seed failed; see seed.err");
const password = "a15-admin-password";
const db = new Database(seedDb);
db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('adminPasswordHash',?)", [
  await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 }),
]);
// Identical SQL on the stopped seed DB; both gateways receive the same copy.
for (const provider of ["anthropic", "openai", "antigravity"])
  for (const kind of ["full", "missing", "deleted", "key"]) {
    db.run(
      `INSERT INTO credentials (id,provider,label,auth_type,enabled,tier,weight,expires_at,account_email,provider_data,access_token,refresh_token,id_token,created_at,updated_at,disabled_reason,disabled_at,token_version)
    VALUES (?,?,?,?,0,3,2.5,4102444800000,'old@example.test',?,?,?,?,1000,2000,'fixture disabled',1500,7)`,
      [
        `${provider}-${kind}`,
        provider,
        "old label",
        kind === "key" ? "apiKey" : "oauth",
        JSON.stringify({
          installationId: "11111111-1111-4111-8111-111111111111",
          idSalt: "a".repeat(64),
          accountId: "old-account",
          old: true,
        }),
        await encrypt(fieldKey, "old-access"),
        await encrypt(fieldKey, "old-refresh"),
        await encrypt(fieldKey, "old-id"),
      ],
    );
  }
db.close();

type Wire = { line: string; headers: string[]; body: string };
let wires: Wire[] = [];
let tokenStatus = 400;
let tokenBody = '{"error":"fixture_refusal"}';
let transport: "normal" | "close" | "partial" = "normal";
let tokenDelay = 0;
let inference = false;
let google: {
  emailStatus: number;
  loadStatus: number;
  onboardStatus: number;
  load: unknown;
  onboard: unknown;
} = {
  emailStatus: 200,
  loadStatus: 200,
  onboardStatus: 200,
  load: { cloudaicompanionProject: "fixture-project", currentTier: { id: "fixture-tier" } },
  onboard: { response: { cloudaicompanionProject: "onboard-project" } },
};
const stub = Bun.listen<{ buffer: Buffer }>({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: Bun.file(f.cert!), key: Bun.file(f.key!) },
  socket: {
    open(s) {
      s.data = { buffer: Buffer.alloc(0) };
    },
    data(s, chunk) {
      s.data.buffer = Buffer.concat([s.data.buffer, chunk]);
      const end = s.data.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [line, ...headers] = s.data.buffer.subarray(0, end).toString().split("\r\n");
      const length = Number(headers.find((h) => /^content-length:/i.test(h))?.split(":")[1] ?? 0);
      if (s.data.buffer.length < end + 4 + length) return;
      wires.push({
        line: line!,
        headers,
        body: s.data.buffer.subarray(end + 4, end + 4 + length).toString(),
      });
      if (
        /oauth2\/v1\/userinfo|:loadCodeAssist|:onboardUser|:retrieveUserQuotaSummary|:fetchAvailableModels/.test(
          line!,
        )
      ) {
        const email = line!.includes("userinfo"),
          load = line!.includes(":loadCodeAssist"),
          onboard = line!.includes(":onboardUser");
        const status = email
          ? google.emailStatus
          : load
            ? google.loadStatus
            : onboard
              ? google.onboardStatus
              : 200;
        const body = JSON.stringify(
          email
            ? { email: "google@example.test" }
            : load
              ? google.load
              : onboard
                ? google.onboard
                : {},
        );
        s.end(
          `HTTP/1.1 ${status} Fixture\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }
      if (inference) {
        if (line!.includes("streamGenerateContent")) {
          const body = `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "fixture answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } } })}\n\n`;
          s.end(
            `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
          return;
        }
        const anthropic = line!.includes("/v1/messages");
        const body = anthropic
          ? [
              {
                type: "message_start",
                message: {
                  id: "msg_fixture",
                  type: "message",
                  role: "assistant",
                  model: "claude-sonnet-4-5",
                  content: [],
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "fixture answer" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 2 },
              },
              { type: "message_stop" },
            ]
              .map((x) => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`)
              .join("")
          : [
              { type: "response.created", response: { id: "resp_fixture", model: "gpt-5" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { id: "msg_fixture", type: "message", role: "assistant", content: [] },
              },
              {
                type: "response.content_part.added",
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "" },
              },
              { type: "response.output_text.delta", output_index: 0, delta: "fixture answer" },
              {
                type: "response.content_part.done",
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "fixture answer" },
              },
              {
                type: "response.completed",
                response: {
                  id: "resp_fixture",
                  model: "gpt-5",
                  status: "completed",
                  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
                },
              },
            ]
              .map((x) => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`)
              .join("");
        s.end(
          `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }
      if (transport === "close") {
        s.end();
        return;
      }
      if (transport === "partial") {
        s.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{"access_token":',
        );
        return;
      }
      const reply = `HTTP/1.1 ${tokenStatus} Fixture\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(tokenBody)}\r\nConnection: close\r\n\r\n${tokenBody}`;
      if (tokenDelay) setTimeout(() => s.end(reply), tokenDelay);
      else s.end(reply);
    },
  },
});
type Row = { name: string; response: unknown; wire: Wire[] };
type TimedReply = {
  status: number;
  valid?: boolean;
  body?: StartReply & { error?: { code: string; message: string } };
};
type StartReply = { flowId: string; authorizeUrl: string };
type ChatReply = { choices?: { message?: { content?: string } }[] };
type StoredCredential = Record<string, unknown> & {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  api_key: string | null;
  created_at: number | string;
  updated_at: number | string;
  expires_at: number | string | null;
  provider_data: string;
};
async function run(label: string, binary: string): Promise<Row[]> {
  const root = join(work, label);
  mkdirSync(root, { recursive: true });
  const file = join(root, "omni.db");
  copyFileSync(seedDb, file);
  const proc = Bun.spawn([resolve(binary)], {
    cwd: root,
    env: { ...baseEnv, OMNI_ROOT: root, OMNI_DB_PATH: file, OMNI_STATIC_DIR: join(root, "absent") },
    stdout: Bun.file(join(work, `${label}.log`)),
    stderr: Bun.file(join(work, `${label}.err`)),
  });
  const rows: Row[] = [];
  let cookie = "";
  async function request(path: string, body: string | undefined, auth = cookie, method = "POST") {
    const r = await fetch(`http://127.0.0.1:18515${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth ? { cookie: auth } : {}),
      },
      body: method === "GET" ? undefined : body,
    });
    const text = await r.text();
    let bodyValue: unknown;
    try {
      bodyValue = JSON.parse(text);
    } catch {
      bodyValue = text;
    }
    return {
      status: r.status,
      type: r.headers.get("content-type"),
      body: bodyValue,
      cookie: r.headers.get("set-cookie"),
    };
  }
  async function row(name: string, route: string, body?: string, auth = cookie, method = "POST") {
    wires = [];
    const { cookie: _, ...response } = await request(`/api/connect/${route}`, body, auth, method);
    rows.push({ name, response, wire: wires.map((w) => ({ ...w, headers: [...w.headers] })) });
    return response.body;
  }
  async function storedRow(id: string) {
    const reader = new Database(file, { readonly: true });
    const stored = reader
      .query<StoredCredential, [string]>("SELECT * FROM credentials WHERE id = ?")
      .get(id);
    reader.close();
    if (!stored) throw Error(`missing ${id}`);
    for (const field of ["access_token", "refresh_token", "id_token", "api_key"] as const)
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
    tokenBody = JSON.stringify({
      access_token: `${provider}-new-access`,
      refresh_token: `${provider}-new-refresh`,
      expires_in: 3600,
      ...(provider === "openai"
        ? { id_token: idToken }
        : { account: { email_address: "fixture@example.test" } }),
    });
    if (reconnect === "missing")
      tokenBody = JSON.stringify({ access_token: `${provider}-new-access`, expires_in: 3600 });
    const success = await row(
      `${name}/start`,
      "start",
      JSON.stringify({
        provider,
        label: "success label",
        credentialId: credentialId ? `  ${credentialId}  ` : undefined,
      }),
    );
    if (!success.flowId) return;
    const successUrl = validateStart(success);
    const before = Date.now();
    const finished = await row(
      `${name}/finish`,
      "finish",
      JSON.stringify({
        flowId: success.flowId,
        code: `fixture-code#${successUrl.searchParams.get("state")}`,
      }),
    );
    const after = Date.now();
    for (const wire of rows.at(-1)!.wire) {
      const json = wire.headers.some((h) => /content-type: application\/json/i.test(h));
      const fields = json
        ? JSON.parse(wire.body)
        : Object.fromEntries(new URLSearchParams(wire.body));
      if (
        !/^[\w-]{43}$/.test(fields.code_verifier) ||
        createHash("sha256").update(fields.code_verifier).digest("base64url") !==
          successUrl.searchParams.get("code_challenge")
      )
        throw Error("success PKCE invalid");
      if (
        Number(wire.headers.find((h) => /^content-length:/i.test(h))?.split(":")[1]) !==
        Buffer.byteLength(wire.body)
      )
        throw Error("success length invalid");
      fields.code_verifier = "<verifier>";
      if (fields.state !== undefined) {
        if (fields.state !== successUrl.searchParams.get("state"))
          throw Error("success state invalid");
        fields.state = "<state>";
      }
      wire.headers = wire.headers.map((h) =>
        /^content-length:/i.test(h) ? "content-length: <validated>" : h,
      );
      wire.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
    }
    if (finished?.id) {
      if (credentialId ? finished.id !== credentialId : !uuid4.test(finished.id))
        throw Error("credential id invalid");
      const reader = new Database(file, { readonly: true });
      const stored = reader
        .query<StoredCredential, [string]>("SELECT * FROM credentials WHERE id = ?")
        .get(finished.id);
      reader.close();
      if (!stored || stored.id !== finished.id) throw Error("successful credential missing");
      for (const field of ["access_token", "refresh_token", "id_token", "api_key"] as const) {
        if (stored[field] !== null) stored[field] = await decrypt(fieldKey, stored[field]);
      }
      await Bun.write(
        join(root, `${provider}-${reconnect ?? "success"}.raw.json`),
        JSON.stringify({ before, after, prior, stored }, null, 2),
      );
      // 2s clock/serialization tolerance, validated before any time masking.
      for (const [field, delta] of [
        ["expires_at", 3600000],
        ["created_at", 0],
        ["updated_at", 0],
      ] as const) {
        if (prior && field === "created_at") {
          if (stored[field] !== prior[field]) throw Error("created_at changed");
          continue;
        }
        if (
          !Number.isSafeInteger(stored[field]) ||
          stored[field] < before + delta - 2000 ||
          stored[field] > after + delta + 2000
        )
          throw Error(`invalid ${field}`);
        stored[field] = `<request-time+${delta};tolerance=2000ms>`;
      }
      if (provider === "openai") {
        const data = JSON.parse(stored.provider_data);
        if (!uuid4.test(data.installationId) || !/^[0-9a-f]{64}$/.test(data.idSalt))
          throw Error("invalid Codex randomness");
        // Replace only validated random bytes; preserve JSON spacing/key order.
        if (!prior)
          stored.provider_data = stored.provider_data
            .replace(data.installationId, "<installation>")
            .replace(data.idSalt, "<salt>");
      }
      if (!prior) {
        stored.id = "<uuid4>";
        finished.id = "<uuid4>";
      } else stored.token_version_delta = stored.token_version - prior.token_version;
      rows.push({ name: `${name}/persistence`, response: stored, wire: [] });
    } else rows.push({ name: `${name}/persistence`, response: { missing: true }, wire: [] });
  }
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        await request("/health", undefined, "", "GET");
        break;
      } catch {
        if (proc.exitCode !== null || Date.now() > deadline) throw Error(`${label} failed to boot`);
        await Bun.sleep(50);
      }
    }
    const login = await request("/api/login", JSON.stringify({ password }), "");
    if (login.status !== 200 || !login.cookie) throw Error(`${label} login failed`);
    cookie = login.cookie.split(";")[0]!;
    for (const route of ["start", "finish", "poll"]) {
      for (const auth of ["", "omni_session=bad"])
        await row(`${route}/auth/${auth}`, route, "{}", auth);
      await row(`${route}/GET`, route, undefined, cookie, "GET");
      for (const body of [undefined, "{", "null", "[]", "1", "{}"])
        await row(`${route}/body/${body}`, route, body);
    }
    for (const provider of [
      "unknown",
      "plugin-fixture",
      "custom",
      "kimi",
      "kilo",
      "grok",
      "antigravity",
      "muse",
      "qoder",
      "qwen",
      "xai",
      "constructor",
      null,
      1,
    ])
      await row(`start/provider/${provider}`, "start", JSON.stringify({ provider }));
    for (const route of ["finish", "poll"])
      for (const flowId of ["", "unknown", null, 1])
        await row(`${route}/flow/${flowId}`, route, JSON.stringify({ flowId, code: "code" }));
    for (const provider of ["anthropic", "openai"]) {
      for (const credentialId of ["unknown", "", "  ", null, 1])
        await row(
          `${provider}/reconnect/${credentialId}`,
          "start",
          JSON.stringify({ provider, credentialId }),
        );
      for (const labelValue of [undefined, " label ", 3]) {
        const start = await row(
          `${provider}/start/${labelValue}`,
          "start",
          JSON.stringify({ provider, label: labelValue }),
        );
        if (!start.flowId) continue; // Missing Rust route stays a red row, not a harness crash.
        validateStart(start);
      }
      tokenStatus = 400;
      tokenBody = '{"error":"fixture_refusal"}';
      const start = await row(`${provider}/poll/start`, "start", JSON.stringify({ provider }));
      if (start.flowId) {
        validateStart(start);
        await row(`${provider}/poll`, "poll", JSON.stringify({ flowId: start.flowId }));
        for (const wire of rows.at(-1)!.wire) {
          const url = validateStart(start);
          const json = wire.headers.some((h) => /content-type: application\/json/i.test(h));
          const fields = json
            ? JSON.parse(wire.body)
            : Object.fromEntries(new URLSearchParams(wire.body));
          if (
            fields.code !== "" ||
            !/^[\w-]{43}$/.test(fields.code_verifier) ||
            createHash("sha256").update(fields.code_verifier).digest("base64url") !==
              url.searchParams.get("code_challenge")
          )
            throw Error("poll PKCE invalid");
          if (fields.state !== undefined && fields.state !== url.searchParams.get("state"))
            throw Error("poll state invalid");
          if (
            Number(wire.headers.find((h) => /^content-length:/i.test(h))?.split(":")[1]) !==
            Buffer.byteLength(wire.body)
          )
            throw Error("poll length invalid");
          fields.code_verifier = "<verifier>";
          if (fields.state !== undefined) fields.state = "<state>";
          wire.headers = wire.headers.map((h) =>
            /^content-length:/i.test(h) ? "content-length: <validated>" : h,
          );
          wire.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
        }
        await row(`${provider}/poll/consumed`, "poll", JSON.stringify({ flowId: start.flowId }));
      }
      for (const [status, body] of [
        [400, '{"error":"fixture_refusal"}'],
        [401, "{}"],
        [429, "{}"],
        [500, "{}"],
        [200, "{"],
        [200, "{}"],
      ] as const) {
        tokenStatus = status;
        tokenBody = body;
        const start = await row(
          `${provider}/token/${status}/${body}/start`,
          "start",
          JSON.stringify({ provider }),
        );
        if (!start.flowId) continue;
        const url = validateStart(start);
        await row(
          `${provider}/token/${status}/${body}/finish`,
          "finish",
          JSON.stringify({
            flowId: start.flowId,
            code: `fixture-code#${url.searchParams.get("state")}`,
          }),
        );
        for (const wire of rows.at(-1)!.wire) {
          const json = wire.headers.some((h) => /content-type: application\/json/i.test(h));
          const fields = json
            ? JSON.parse(wire.body)
            : Object.fromEntries(new URLSearchParams(wire.body));
          const verifier = fields.code_verifier;
          if (
            typeof verifier !== "string" ||
            !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) ||
            createHash("sha256").update(verifier).digest("base64url") !==
              url.searchParams.get("code_challenge")
          )
            throw Error("PKCE relation invalid");
          fields.code_verifier = "<verifier>";
          if (fields.state !== undefined) {
            if (fields.state !== url.searchParams.get("state")) throw Error("wire state invalid");
            fields.state = "<state>";
          }
          // Length is validated against the original bytes before masking random values.
          const length = wire.headers.find((h) => /^content-length:/i.test(h));
          if (Number(length?.split(":")[1]) !== Buffer.byteLength(wire.body))
            throw Error("wire length invalid");
          wire.headers = wire.headers.map((h) =>
            /^content-length:/i.test(h) ? "content-length: <validated>" : h,
          );
          wire.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
        }
        await row(
          `${provider}/token/${status}/${body}/used`,
          "finish",
          JSON.stringify({ flowId: start.flowId, code: "code" }),
        );
      }
    }
    for (const provider of ["anthropic", "openai"]) {
      const cases: [string, unknown, string][] = [];
      for (const shape of [{}, [], [1]])
        for (const route of ["finish", "poll"]) cases.push(["email", shape, route]);
      for (const field of ["expires_in", "refresh_token", "access_token", "id_token"])
        for (const shape of [{}, [], 1, true, null]) cases.push([field, shape, "finish"]);
      for (const [field, shape, route] of cases) {
        const name = `${provider}/shape/${field}/${JSON.stringify(shape)}/${route}`;
        const payload: Record<string, unknown> = {
          access_token: "shape-access",
          refresh_token: "shape-refresh",
          expires_in: 3600,
        };
        if (field !== "email") payload[field] = shape;
        else if (provider === "anthropic") payload.account = { email_address: shape };
        else
          payload.id_token = `e30.${Buffer.from(JSON.stringify({ email: shape })).toString("base64url")}.unsigned`;
        tokenStatus = 200;
        tokenBody = JSON.stringify(payload);
        const start = await row(
          `${name}/start`,
          "start",
          JSON.stringify({ provider, label: name }),
        );
        if (!start.flowId) continue;
        const url = validateStart(start);
        const logBefore = readFileSync(join(work, `${label}.log`), "utf8").length;
        const r = await request(
          `/api/connect/${route}`,
          JSON.stringify({ flowId: start.flowId, code: `code#${url.searchParams.get("state")}` }),
        );
        if (field === "email") {
          const logs = readFileSync(join(work, `${label}.log`), "utf8").slice(logBefore);
          if (/shape-access|shape-refresh|Binding expected/.test(logs))
            throw Error("email failure leaked details into log");
          await Bun.write(
            join(root, `${provider}-email-${JSON.stringify(shape)}-${route}.log`),
            logs,
          );
        }
        const reader = new Database(file, { readonly: true });
        const stored = reader
          .query("SELECT account_email FROM credentials WHERE label = ?")
          .all(name);
        if (r.body.id !== undefined) {
          const saved = reader
            .query<{ id: string; label: string }, [string]>(
              "SELECT id, label FROM credentials WHERE id = ?",
            )
            .all(typeof r.body.id === "string" ? r.body.id : "");
          if (
            typeof r.body.id !== "string" ||
            !uuid4.test(r.body.id) ||
            saved.length !== 1 ||
            saved[0].label !== name
          )
            throw Error(`FAILED ${name}: invalid saved credential id`);
        }
        reader.close();
        rows.push({
          name,
          response: {
            status: r.status,
            body: r.body.id ? { ...r.body, id: "<uuid>" } : r.body,
            stored,
          },
          wire: [],
        });
        await row(
          `${name}/consumed`,
          route,
          JSON.stringify({ flowId: start.flowId, code: "code" }),
        );
      }
    }
    for (const provider of ["anthropic", "openai"]) await successRows(provider);
    for (const provider of ["anthropic", "openai"]) {
      await successRows(provider, "full");
      await successRows(provider, "missing");
      for (const [kind, credentialId] of Object.entries({
        other: `${provider === "openai" ? "anthropic" : "openai"}-full`,
        apiKey: `${provider}-key`,
        object: {},
      }))
        await row(
          `${provider}/reconnect-refusal/${kind}`,
          "start",
          JSON.stringify({ provider, credentialId }),
        );
      const start = await row(
        `${provider}/deleted/start`,
        "start",
        JSON.stringify({ provider, credentialId: `${provider}-deleted` }),
      );
      if (!start.flowId) continue;
      const url = validateStart(start);
      const writer = new Database(file);
      writer.run("DELETE FROM credentials WHERE id = ?", [`${provider}-deleted`]);
      writer.close();
      await row(
        `${provider}/deleted/finish`,
        "finish",
        JSON.stringify({
          flowId: start.flowId,
          code: `fixture-code#${url.searchParams.get("state")}`,
        }),
      );
      await row(
        `${provider}/deleted/consumed`,
        "finish",
        JSON.stringify({ flowId: start.flowId, code: "code" }),
      );
    }
    for (const provider of ["anthropic", "openai"]) {
      for (const mode of ["close", "partial"] as const)
        for (const route of ["finish", "poll"]) {
          const name = `${provider}/transport/${mode}/${route}`;
          const start = await row(`${name}/start`, "start", JSON.stringify({ provider }));
          if (!start.flowId) continue;
          const url = validateStart(start);
          transport = mode;
          await row(
            name,
            route,
            JSON.stringify({
              flowId: start.flowId,
              code: `fixture-code#${url.searchParams.get("state")}`,
            }),
          );
          for (const wire of rows.at(-1)!.wire) {
            const json = wire.headers.some((h) => /content-type: application\/json/i.test(h));
            const fields = json
              ? JSON.parse(wire.body)
              : Object.fromEntries(new URLSearchParams(wire.body));
            if (
              !/^[\w-]{43}$/.test(fields.code_verifier) ||
              createHash("sha256").update(fields.code_verifier).digest("base64url") !==
                url.searchParams.get("code_challenge")
            )
              throw Error("transport PKCE invalid");
            if (
              Number(wire.headers.find((h) => /^content-length:/i.test(h))?.split(":")[1]) !==
              Buffer.byteLength(wire.body)
            )
              throw Error("transport length invalid");
            fields.code_verifier = "<verifier>";
            if (fields.state !== undefined) {
              if (fields.state !== url.searchParams.get("state"))
                throw Error("transport state invalid");
              fields.state = "<state>";
            }
            wire.headers = wire.headers.map((h) =>
              /^content-length:/i.test(h) ? "content-length: <validated>" : h,
            );
            wire.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
          }
          transport = "normal";
          await row(
            `${name}/consumed`,
            route,
            JSON.stringify({ flowId: start.flowId, code: "code" }),
          );
        }
    }
    for (const provider of ["anthropic", "openai"])
      for (const route of ["finish", "poll"]) {
        const name = `${provider}/disconnect${route === "poll" ? "-poll" : ""}`;
        tokenStatus = 200;
        tokenBody = JSON.stringify({
          access_token: `${provider}-disconnect-access`,
          refresh_token: "disconnect-refresh",
          expires_in: 3600,
        });
        const start = await row(
          `${name}/start`,
          "start",
          JSON.stringify({ provider, label: name }),
        );
        if (!start.flowId) continue;
        const url = validateStart(start);
        tokenDelay = 500;
        wires = [];
        const controller = new AbortController();
        const response = fetch(`http://127.0.0.1:18515/api/connect/${route}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            flowId: start.flowId,
            code: `fixture-code#${url.searchParams.get("state")}`,
          }),
          signal: controller.signal,
        }).then(
          () => "responded",
          () => "aborted",
        );
        await Bun.sleep(100);
        controller.abort();
        if ((await response) !== "aborted") throw Error("disconnect request did not abort");
        await Bun.sleep(2000);
        tokenDelay = 0;
        const reader = new Database(file, { readonly: true });
        const stored = reader
          .query<{ access_token: string }, [string]>(
            "SELECT access_token FROM credentials WHERE label = ?",
          )
          .all(name);
        reader.close();
        rows.push({
          name,
          response: {
            requests: wires.length,
            credentials: stored.length,
            access: await Promise.all(stored.map((r) => decrypt(fieldKey, r.access_token))),
          },
          wire: [],
        });
        const { cookie: _, ...consumed } = await request(
          "/api/connect/finish",
          JSON.stringify({ flowId: start.flowId, code: "code" }),
        );
        const after = new Database(file, { readonly: true });
        const count = after
          .query<{ n: number }, [string]>("SELECT count(*) AS n FROM credentials WHERE label = ?")
          .get(name)?.n;
        if (count === undefined) throw Error("missing credential count");
        after.close();
        rows.push({
          name: `${name}/consumed`,
          response: { ...consumed, requests: wires.length, credentials: count },
          wire: [],
        });
      }
    for (const provider of ["anthropic", "openai"])
      for (const success of [false, true]) {
        const name = `${provider}/concurrent/${success ? "success" : "refusal"}`;
        tokenStatus = success ? 200 : 400;
        tokenBody = success
          ? JSON.stringify({
              access_token: `${provider}-concurrent-access`,
              refresh_token: "concurrent-refresh",
              expires_in: 3600,
            })
          : '{"error":"fixture_refusal"}';
        const start = await row(
          `${name}/start`,
          "start",
          JSON.stringify({ provider, label: name }),
        );
        if (!start.flowId) continue;
        validateStart(start);
        tokenDelay = 500;
        wires = [];
        const responses = await Promise.all(
          [0, 1].map(() => request("/api/connect/poll", JSON.stringify({ flowId: start.flowId }))),
        );
        tokenDelay = 0;
        const reader = new Database(file, { readonly: true });
        const credentials = reader
          .query<{ id: string; access_token: string }, [string]>(
            "SELECT id,access_token FROM credentials WHERE label = ?",
          )
          .all(name);
        reader.close();
        const ids = responses.map((r) => r.body?.id);
        if (
          success &&
          (responses.some((r) => r.status !== 200 || r.body.status !== "complete") ||
            ids[0] !== ids[1] ||
            !uuid4.test(ids[0]) ||
            credentials.length !== 1 ||
            credentials[0].id !== ids[0])
        )
          throw Error(`${name}: invalid shared success`);
        if (
          !success &&
          responses.some(
            (r) =>
              r.status !== 401 ||
              r.body.error?.code !== "AUTH" ||
              r.body.error?.message !== "token endpoint rejected the request: fixture_refusal",
          )
        )
          throw Error(`${name}: invalid shared refusal`);
        const normalized = responses
          .map(({ cookie: _, ...r }) => {
            if (success) r.body.id = "<uuid4>";
            return r;
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        rows.push({
          name,
          response: {
            requests: wires.length,
            responses: normalized,
            credentials: credentials.length,
            access: await Promise.all(credentials.map((c) => decrypt(fieldKey, c.access_token))),
          },
          wire: [],
        });
        await row(`${name}/consumed`, "poll", JSON.stringify({ flowId: start.flowId }));
      }
    for (const provider of ["anthropic", "openai"])
      for (const reconnect of [false, true])
        for (const route of ["finish", "poll"])
          for (
            let trial = 0;
            trial < (process.env.A15_VISIBILITY_TRIALS === "10" ? 10 : 1);
            trial++
          ) {
            const name = `${provider}/${reconnect ? "reconnect-first" : "fresh-first"}/${route}/${trial}`;
            const model = `inference-${provider}-${reconnect}`;
            const key = await request("/api/keys", JSON.stringify({ label: model }));
            const target = (credentialId?: string) =>
              JSON.stringify({
                id: model,
                strategy: "priority",
                isAlias: false,
                targets: [
                  {
                    provider,
                    model: provider === "openai" ? "gpt-5" : "claude-sonnet-4-5",
                    credentialId,
                    tier: 1,
                    weight: 1,
                    costPerMTok: { input: 1, output: 2 },
                    capabilities: { tools: true, images: true, reasoning: true },
                  },
                ],
              });
            await request(`/api/models/${model}`, target(), cookie, "PUT");
            const disable = new Database(file);
            disable.run("UPDATE credentials SET enabled = 0 WHERE provider = ?", [provider]);
            disable.close();
            await Bun.sleep(650);
            tokenStatus = 200;
            tokenBody = JSON.stringify({
              access_token: `${provider}-inference-access-${trial}`,
              refresh_token: "inference-refresh",
              expires_in: 3600,
            });
            const start = await row(
              `${name}/start`,
              "start",
              JSON.stringify({ provider, label: "inference" }),
            );
            if (!start.flowId) continue;
            const url = validateStart(start);
            const connected = await request(
              `/api/connect/${route}`,
              JSON.stringify({
                flowId: start.flowId,
                code: `code#${url.searchParams.get("state")}`,
              }),
            );
            if (connected.status !== 200 || !uuid4.test(connected.body.id))
              throw Error("inference connect failed");
            const expectedToken = `${provider}-inference-access-${trial}${reconnect ? "-second" : ""}`;
            if (reconnect) {
              tokenBody = JSON.stringify({
                access_token: expectedToken,
                refresh_token: "second-refresh",
                expires_in: 3600,
              });
              const again = await request(
                "/api/connect/start",
                JSON.stringify({ provider, credentialId: connected.body.id, label: "inference" }),
              );
              const againUrl = validateStart(again.body);
              const done = await request(
                `/api/connect/${route}`,
                JSON.stringify({
                  flowId: again.body.flowId,
                  code: `code#${againUrl.searchParams.get("state")}`,
                }),
              );
              if (done.status !== 200 || done.body.id !== connected.body.id)
                throw Error("immediate reconnect failed");
            }
            if (key.status !== 200 || typeof key.body.key !== "string")
              throw Error(`key create: ${JSON.stringify(key)}`);
            inference = true;
            wires = [];
            const r = await fetch("http://127.0.0.1:18515/v1/chat/completions", {
              method: "POST",
              headers: {
                authorization: `Bearer ${key.body.key}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model,
                messages: [{ role: "user", content: "hello" }],
                max_tokens: 32,
                stream: false,
              }),
            });
            const status = r.status,
              answer = (await r.json()) as ChatReply;
            inference = false;
            await Bun.write(
              join(root, `${provider}-${reconnect}-${route}-${trial}-routable.json`),
              JSON.stringify({ status, answer, wires }, null, 2),
            );
            const valid =
              status === 200 &&
              answer.choices?.[0]?.message?.content === "fixture answer" &&
              wires.length === 1 &&
              wires[0]!.headers.some(
                (h) => h.toLowerCase() === `authorization: bearer ${expectedToken}`,
              );
            console.log(`FIRST ${label} ${name} ${valid ? "PASS" : "FAIL"}`);
            rows.push({ name: `${name}/result`, response: { status, valid }, wire: [] });
          }
    for (const kind of ["changed-label", "equal-priority", "equal-roundRobin", "invalid-utf8"])
      for (const provider of ["anthropic", "openai"])
        for (const route of ["finish", "poll"])
          for (
            let trial = 0;
            trial < (process.env.A15_VISIBILITY_TRIALS === "10" ? 10 : 1);
            trial++
          ) {
            const name = `${provider}/${kind}/${route}/${trial}`;
            const model = `order-${kind}-${provider}-${route}-${trial}`;
            const key = await request("/api/keys", JSON.stringify({ label: model }));
            const saved = await request(
              `/api/models/${model}`,
              JSON.stringify({
                id: model,
                strategy: kind === "equal-roundRobin" ? "roundRobin" : "priority",
                isAlias: false,
                targets: [
                  {
                    provider,
                    model,
                    tier: 1,
                    weight: 1,
                    costPerMTok: { input: 1, output: 2 },
                    capabilities: { tools: true, images: true, reasoning: true },
                  },
                ],
              }),
              cookie,
              "PUT",
            );
            if (key.status !== 200 || typeof key.body.key !== "string" || saved.status !== 200)
              throw Error("order fixture failed");
            const writer = new Database(file);
            writer.run("UPDATE credentials SET enabled=0 WHERE provider=?", [provider]);
            writer.run("UPDATE credentials SET enabled=1,tier=1,weight=1,label='a' WHERE id=?", [
              `${provider}-full`,
            ]);
            writer.run("UPDATE credentials SET enabled=1,tier=1,weight=1,label='b' WHERE id=?", [
              `${provider}-missing`,
            ]);
            writer.close();
            await Bun.sleep(650);
            tokenStatus = 200;
            tokenBody = JSON.stringify({
              access_token: `${provider}-order-access-${route}-${trial}`,
              refresh_token: "order-refresh",
              expires_in: 3600,
            });
            if (kind === "invalid-utf8") {
              const db = new Database(file);
              db.run("UPDATE credentials SET label=CAST(x'80' AS TEXT) WHERE id=?", [
                `${provider}-full`,
              ]);
              db.run("UPDATE credentials SET label='é' WHERE id=?", [`${provider}-missing`]);
              db.close();
            } else {
              const edited = await request(
                `/api/credentials/${provider}-full`,
                JSON.stringify({ label: kind === "changed-label" ? "z" : "b" }),
                cookie,
                "PATCH",
              );
              if (edited.status !== 200) throw Error("label patch failed");
            }
            const start = await request(
              "/api/connect/start",
              JSON.stringify({ provider, credentialId: `${provider}-full` }),
            );
            const url = validateStart(start.body);
            const done = await request(
              `/api/connect/${route}`,
              JSON.stringify({
                flowId: start.body.flowId,
                code: `code#${url.searchParams.get("state")}`,
              }),
            );
            if (done.status !== 200 || done.body.id !== `${provider}-full`)
              throw Error("order reconnect failed");
            inference = true;
            wires = [];
            const r = await fetch("http://127.0.0.1:18515/v1/chat/completions", {
              method: "POST",
              headers: {
                authorization: `Bearer ${key.body.key}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model,
                messages: [{ role: "user", content: "hello" }],
                max_tokens: 32,
                stream: false,
              }),
            });
            const answer = (await r.json()) as ChatReply;
            inference = false;
            const bearer = wires.map((w) =>
              w.headers.find((h) => /^authorization:/i.test(h))?.replace(/^authorization:\s*/i, ""),
            );
            // Unique upstream model: no health/load/recent history. Frozen roundRobin
            // has equal spent/load/idle, so its stable sort retains SQLite arrival order.
            const db = new Database(file, { readonly: true });
            const expectedId = db
              .query<{ id: string }, [string]>(
                "SELECT id FROM credentials WHERE enabled=1 AND provider=? ORDER BY tier, label LIMIT 1",
              )
              .get(provider)?.id;
            db.close();
            if (!expectedId) throw Error("missing expected credential");
            const expectedBearer = `Bearer ${(await storedRow(expectedId)).access_token}`;
            const valid =
              r.status === 200 &&
              answer.choices?.[0]?.message?.content === "fixture answer" &&
              bearer.length === 1 &&
              bearer[0] === expectedBearer;
            console.log(`FIRST ${label} ${name} ${valid && r.status === 200 ? "PASS" : "FAIL"}`);
            await Bun.write(
              join(root, `${model}-routable.json`),
              JSON.stringify(
                { status: r.status, answer, wires, bearer, expectedId, expectedBearer, valid },
                null,
                2,
              ),
            );
            rows.push({
              name,
              response: {
                status: r.status,
                answer: answer.choices?.[0]?.message?.content,
                bearer,
                valid,
              },
              wire: [],
            });
            const cleanup = new Database(file);
            cleanup.run("UPDATE credentials SET label='a' WHERE id=?", [`${provider}-full`]);
            cleanup.close();
          }
    for (const scenario of [
      "url",
      "bare",
      "mismatch",
      "invalid-url",
      "missing-state",
      "poll",
      "reconnect",
      "object-project",
      "onboard",
      "empty-onboard",
      "onboard-failure",
      "load-failure",
      "email-failure",
      "token-400",
      "token-401",
      "token-500",
      "immediate",
    ]) {
      const name = `antigravity/connect/${scenario}`;
      google = {
        emailStatus: scenario === "email-failure" ? 500 : 200,
        loadStatus: scenario === "load-failure" ? 500 : 200,
        onboardStatus: scenario === "onboard-failure" ? 500 : 200,
        load: ["onboard", "empty-onboard", "onboard-failure", "load-failure"].includes(scenario)
          ? { allowedTiers: [{ id: "chosen-tier", isDefault: true }] }
          : {
              cloudaicompanionProject:
                scenario === "object-project" ? { id: " fixture-project " } : "fixture-project",
              currentTier: { id: "fixture-tier" },
            },
        onboard:
          scenario === "empty-onboard"
            ? { done: false }
            : { response: { cloudaicompanionProject: { id: "onboard-project" } } },
      };
      tokenStatus = scenario.startsWith("token-") ? Number(scenario.slice(6)) : 200;
      tokenBody =
        tokenStatus === 200
          ? JSON.stringify({
              access_token: "google-new-access",
              refresh_token: "google-new-refresh",
              expires_in: 3600,
            })
          : '{"error":"fixture_refusal"}';
      let inferenceKey = "";
      if (scenario === "immediate") {
        const key = await request("/api/keys", JSON.stringify({ label: name }));
        inferenceKey = key.body.key;
        await request(
          "/api/models/google-immediate",
          JSON.stringify({
            id: "google-immediate",
            strategy: "priority",
            isAlias: false,
            targets: [
              {
                provider: "antigravity",
                model: "gemini-2.5-pro",
                tier: 1,
                weight: 1,
                costPerMTok: { input: 1, output: 2 },
                capabilities: { tools: true, images: true, reasoning: true },
              },
            ],
          }),
          cookie,
          "PUT",
        );
        const writer = new Database(file);
        writer.run("UPDATE credentials SET enabled=0 WHERE provider='antigravity'");
        writer.close();
        await Bun.sleep(650);
      }
      const start = await row(
        `${name}/start`,
        "start",
        JSON.stringify({
          provider: "antigravity",
          label: " google label ",
          ...(scenario === "reconnect" ? { credentialId: "antigravity-full" } : {}),
        }),
      );
      if ((rows.at(-1)?.response as TimedReply | undefined)?.status !== 200)
        throw Error(`Google ${scenario} start status`);
      validateStart(start);
      if (!start.flowId) {
        for (const suffix of [
          "exchange",
          "persistence",
          ...(scenario === "immediate" ? ["inference"] : []),
        ])
          rows.push({ name: `${name}/${suffix}`, response: { missing: true }, wire: [] });
        continue;
      }
      const url = validateStart(start),
        state = url.searchParams.get("state")!;
      const code =
        scenario === "url"
          ? `https://antigravity.google/oauth-callback?code=%20fixture-code%20&state=${state}`
          : scenario === "invalid-url"
            ? "https://wrong.test/callback?code=x&state=x"
            : scenario === "missing-state"
              ? "https://antigravity.google/oauth-callback?code=x"
              : `fixture-code#${scenario === "mismatch" ? "wrong" : state}`;
      const before = Date.now();
      const done = await row(
        `${name}/exchange`,
        scenario === "poll" ? "poll" : "finish",
        JSON.stringify({ flowId: start.flowId, code }),
      );
      const after = Date.now();
      const expectedStatus = ["mismatch"].includes(scenario)
        ? 401
        : ["invalid-url", "missing-state"].includes(scenario)
          ? 400
          : scenario === "token-400" || scenario === "token-401"
            ? 401
            : scenario === "token-500"
              ? 502
              : 200;
      if ((rows.at(-1)?.response as TimedReply | undefined)?.status !== expectedStatus)
        throw Error(`Google ${scenario} expected ${expectedStatus}`);
      if (
        expectedStatus === 200 &&
        (scenario === "reconnect" ? done.id !== "antigravity-full" : !uuid4.test(done.id))
      )
        throw Error(`Google ${scenario} invalid id`);
      if (
        expectedStatus !== 200 &&
        (!done.error || typeof done.error.message !== "string" || done.id !== undefined)
      )
        throw Error(`Google ${scenario} invalid error`);
      // Only the token request carries random verifier bytes. Retain all other wire bytes.
      for (const wire of rows.at(-1)!.wire)
        if (wire.line.includes("/token ")) {
          const fields = new URLSearchParams(wire.body),
            verifier = fields.get("code_verifier")!;
          if (
            createHash("sha256").update(verifier).digest("base64url") !==
            url.searchParams.get("code_challenge")
          )
            throw Error("Google PKCE invalid");
          if (
            Number(wire.headers.find((h) => /^content-length:/i.test(h))?.split(":")[1]) !==
            Buffer.byteLength(wire.body)
          )
            throw Error("Google length invalid");
          fields.set("code_verifier", "<verifier>");
          wire.body = fields.toString();
          wire.headers = wire.headers.map((h) =>
            /^content-length:/i.test(h) ? "content-length: <validated>" : h,
          );
        }
      if (done.id) {
        const stored = await storedRow(done.id);
        const projectId = ["empty-onboard", "onboard-failure"].includes(scenario)
          ? ""
          : ["onboard", "load-failure"].includes(scenario)
            ? "onboard-project"
            : "fixture-project";
        const tier = ["onboard", "empty-onboard", "onboard-failure"].includes(scenario)
          ? "chosen-tier"
          : scenario === "load-failure"
            ? "legacy-tier"
            : "fixture-tier";
        const data = JSON.parse(stored.provider_data);
        if (
          stored.provider !== "antigravity" ||
          stored.auth_type !== "oauth" ||
          stored.enabled !== 1 ||
          stored.access_token !== "google-new-access" ||
          stored.refresh_token !== "google-new-refresh" ||
          stored.account_email !== (scenario === "email-failure" ? null : "google@example.test") ||
          data.projectId !== projectId ||
          data.tier !== tier ||
          stored.token_version !== (scenario === "reconnect" ? 8 : 0) ||
          stored.disabled_at !== null ||
          stored.disabled_reason !== null
        )
          throw Error(`Google ${scenario} invalid persistence`);
        await Bun.write(join(root, `google-${scenario}.raw.json`), JSON.stringify(stored, null, 2));
        for (const [field, delta] of [
          ["expires_at", 3600000],
          ["created_at", 0],
          ["updated_at", 0],
        ] as const) {
          if (!Number.isSafeInteger(stored[field])) throw Error(`Google invalid ${field} type`);
          if (scenario === "reconnect" && field === "created_at") {
            if (stored[field] !== 1000) throw Error("Google reconnect creation changed");
            continue;
          }
          if (stored[field] < before + delta || stored[field] > after + delta)
            throw Error(`Google invalid ${field}`);
          stored[field] = `<request-time+${delta}>`;
        }
        if (scenario !== "reconnect") {
          stored.id = "<uuid4>";
          done.id = "<uuid4>";
        }
        rows.push({ name: `${name}/persistence`, response: stored, wire: [] });
      } else rows.push({ name: `${name}/persistence`, response: null, wire: [] });
      if (scenario === "immediate") {
        inference = true;
        wires = [];
        const r = await fetch("http://127.0.0.1:18515/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${inferenceKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "google-immediate",
            messages: [{ role: "user", content: "hello" }],
            max_tokens: 32,
          }),
        });
        const answer = (await r.json()) as ChatReply;
        inference = false;
        const valid =
          r.status === 200 &&
          answer.choices?.[0]?.message?.content === "fixture answer" &&
          wires.length === 1 &&
          wires[0]!.headers.some(
            (h) => h.toLowerCase() === "authorization: bearer google-new-access",
          );
        rows.push({ name: `${name}/inference`, response: { status: r.status, valid }, wire: [] });
      }
    }
    return rows;
  } finally {
    proc.kill();
    await proc.exited;
  }
}
function validateStart(start: StartReply): URL {
  if (!/^[\w-]{43}$/.test(start.flowId)) throw Error("invalid flow id");
  const url = new URL(start.authorizeUrl);
  if (
    !/^[\w-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[\w-]{43}$/.test(url.searchParams.get("state") ?? "")
  )
    throw Error("invalid authorize randomness");
  return url;
}
function masked(rows: Row[]): Row[] {
  return rows.map((row) => {
    const r = structuredClone(row);
    const body = (r.response as TimedReply | undefined)?.body;
    if (["grok", "muse", "qoder"].some((p) => r.name === `start/provider/${p}`)) return r;
    if (body?.flowId) {
      const url = validateStart(body);
      body.flowId = "<flow>";
      url.searchParams.set("state", "<state>");
      url.searchParams.set("code_challenge", "<challenge>");
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
  const names = new Set([...ts, ...rust].map((r) => r.name));
  let failed = 0,
    expectedDivergences = 0;
  const classes = { "unported-provider": 0, "provider-list": 0 };
  for (const name of names) {
    const a = ts.find((r) => r.name === name),
      b = rust.find((r) => r.name === name);
    const ar = a?.response as TimedReply | undefined,
      br = b?.response as TimedReply | undefined;
    if (name === "antigravity/connect/immediate/inference" && (!ar?.valid || !br?.valid)) {
      failed++;
      console.log(`FAILED ${name}`);
      continue;
    }
    if (
      ["changed-label", "equal-priority", "equal-roundRobin", "invalid-utf8"].some((kind) =>
        name.includes(`/${kind}/`),
      ) &&
      (!ar?.valid || !br?.valid)
    ) {
      failed++;
      console.log(`FAILED ${name} expected bearer`);
      continue;
    }
    if (
      (name.includes("/reconnect-first/") || name.includes("/fresh-first/")) &&
      name.endsWith("/result")
    ) {
      if (ar?.status !== 200 || !ar.valid || br?.status !== 200 || !br.valid) {
        failed++;
        console.log(`FAILED ${name}`);
      }
      continue;
    }
    const frozen =
      "provider must be one of anthropic, openai, kimi, kilo, grok, antigravity, muse, qoder";
    if (["kimi", "kilo", "grok", "muse"].some((p) => name === `start/provider/${p}`)) {
      const provider = name.split("/").at(-1);
      const expected = `${provider} oauth ${provider === "grok" ? "start" : "begin"} threw`;
      if (
        ar?.status === 502 &&
        ar.body.error.code === "UPSTREAM" &&
        ar.body.error.message === expected &&
        br?.status === 400 &&
        br.body.error.code === "BAD_REQUEST" &&
        br.body.error.message === "provider must be one of anthropic, openai, antigravity"
      ) {
        expectedDivergences++;
        classes["unported-provider"]++;
        continue;
      }
    }
    if (["qoder"].some((p) => name === `start/provider/${p}`)) {
      if (
        ar?.status === 200 &&
        ar.body.error === undefined &&
        typeof ar.body.authorizeUrl === "string" &&
        /^[\w-]{43}$/.test(ar.body.flowId) &&
        br?.status === 400 &&
        br.body.error.code === "BAD_REQUEST" &&
        br.body.error.message === "provider must be one of anthropic, openai, antigravity"
      ) {
        expectedDivergences++;
        classes["unported-provider"]++;
        continue;
      }
    }
    if (ar?.body?.error?.message === frozen) {
      if (
        ar.status === 400 &&
        ar.body.error.code === "BAD_REQUEST" &&
        br?.status === 400 &&
        br.body.error.code === "BAD_REQUEST" &&
        br.body.error.message === "provider must be one of anthropic, openai, antigravity"
      ) {
        expectedDivergences++;
        classes["provider-list"]++;
        continue;
      }
    }
    if (!isDeepStrictEqual(a, b)) {
      failed++;
      console.log(`FAILED ${name}`);
    }
  }
  for (const [name, count] of Object.entries({ "unported-provider": 5, "provider-list": 12 })) {
    if (classes[name as keyof typeof classes] !== count) {
      failed++;
      console.log(
        `FAILED divergence count ${name}: expected ${count}, got ${classes[name as keyof typeof classes]}`,
      );
    }
  }
  console.log(JSON.stringify({ rows: names.size, failed, expectedDivergences, classes }));
  process.exitCode = failed ? 1 : 0;
} finally {
  stub.stop(true);
}
