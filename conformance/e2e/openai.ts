#!/usr/bin/env bun
/** Actual gateway HTTP differential. Run via openai-ns.sh, never live providers. */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decrypt, deriveKey, encrypt } from "../../packages/store/src/encryption.ts";
import { normalize, normalizedEqual, show } from "./masks.ts";

const { values: f } = parseArgs({
  options: Object.fromEntries(
    ["ts", "rust", "work", "cert", "key"].map((k) => [k, { type: "string" as const }]),
  ),
});
for (const k of ["ts", "rust", "work", "cert", "key"]) if (!f[k]) throw Error(`--${k} required`);
const work = resolve(f.work!);
const seed = join(work, "seed");
mkdirSync(seed, { recursive: true });
const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: "openai-e2e-key-01234567890123456789",
  OMNI_DB_PATH: join(seed, "omnigateway.db"),
  OMNI_PORT: "18482",
  OMNI_HOST: "127.0.0.1",
  OMNI_LOG_LEVEL: "warn",
  OMNI_STATIC_DIR: join(work, "absent"),
};
async function cli(args: string[], input?: string) {
  const p = Bun.spawn(
    ["bun", "--no-env-file", "apps/cli/src/index.ts", "--root", seed, "--json", ...args],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env,
      stdin: input ? new TextEncoder().encode(input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (await p.exited) throw Error(err);
  return JSON.parse(out);
}
await cli(["credentials", "add-key", "openai", "--label", "openai"], "test-key\n");
const modelFile = join(seed, "model.json");
await Bun.write(
  modelFile,
  JSON.stringify({
    id: "test-model",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "openai",
        model: "gpt-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 1, output: 2 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  }),
);
await cli(["models", "put", "test-model", "-f", modelFile]);
const key = (await cli(["keys", "create", "--label", "test"])).key;
const fieldKey = await deriveKey(env.OMNI_ENCRYPTION_KEY);
const oauthToken = await encrypt(fieldKey, "oauth-access");
const refreshToken = await encrypt(fieldKey, "oauth-refresh");
const winnerAccess = await encrypt(fieldKey, "winner-access");
const winnerRefresh = await encrypt(fieldKey, "winner-refresh");
let activeDb = "";
const refreshedId = `fixture.${Buffer.from(JSON.stringify({ email: "refreshed@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "refreshed-account" } })).toString("base64url")}.fixture`;
const identity = {
  accountId: "account-fixture",
  installationId: "11111111-1111-4111-8111-111111111111",
  idSalt: "ab".repeat(32),
};
type Wire = { line: string; headers: string[]; body: string };
let sockets = 0;
let inferenceSockets = new Set<number>();
let closedSockets = new Set<number>();
let focused = "";
let recorded: Wire[] = [];
let status = 200;
const sse = [
  { type: "response.created", response: { id: "resp_fixed", model: "gpt-5" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "msg_fixed", type: "message", role: "assistant", content: [] },
  },
  {
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  },
  { type: "response.output_text.delta", output_index: 0, delta: "hello" },
  {
    type: "response.content_part.done",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "hello" },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_fixed",
      model: "gpt-5",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  },
]
  .map((x) => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`)
  .join("");
const listener = Bun.listen<{ buffer: Buffer; id: number }>({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: Bun.file(f.cert!), key: Bun.file(f.key!) },
  socket: {
    open(s) {
      s.data = { buffer: Buffer.alloc(0), id: ++sockets };
    },
    close(s) {
      closedSockets.add(s.data.id);
    },
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
      recorded.push({
        line: line!,
        headers: headers.filter((h) => !/^content-length:/i.test(h)),
        body: body.toString(),
      });
      s.data.buffer = s.data.buffer.subarray(end + 4 + length);
      if (line === "POST /oauth/token HTTP/1.1") {
        if (focused === "refresh-cas-loser") {
          const db = new Database(activeDb);
          db.run(
            "UPDATE credentials SET access_token=?,refresh_token=?,expires_at=4102444800000,token_version=token_version+1",
            [winnerAccess, winnerRefresh],
          );
          db.close();
        }
        const response = JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          id_token: refreshedId,
          expires_in: 3600,
        });
        s.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(response)}\r\nConnection: close\r\n\r\n${response}`,
        );
        return;
      }
      const probe = line!.startsWith("GET ");
      if (!probe) inferenceSockets.add(s.data.id);
      const code = probe
        ? 200
        : focused === "failover" && recorded.filter((x) => x.line.startsWith("POST ")).length === 1
          ? 503
          : status;
      let response = probe
        ? "{}"
        : code === 200
          ? sse
          : '{"error":{"message":"fixture refusal","type":"invalid_request_error","code":"fixture"}}';
      if (!probe && focused === "throw")
        response =
          sse.slice(0, sse.indexOf("event: response.content_part.done")) +
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":{"toString":null}}\n\n';
      if (!probe && focused === "cancel") {
        response = sse.slice(0, sse.indexOf("event: response.content_part.done"));
        s.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(response).toString(16)}\r\n${response}\r\n`,
        );
        return;
      }
      if (!probe && focused === "late") {
        s.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n${Buffer.byteLength(response).toString(16)}\r\n${response}\r\n`,
        );
        // Inside the transport's 100ms bounded background drain budget.
        setTimeout(() => {
          try {
            s.write("0\r\n\r\n");
          } catch {}
        }, 30);
        return;
      }
      s.write(
        `HTTP/1.1 ${code} Fixture\r\nContent-Type: ${!probe && code === 200 ? "text/event-stream" : "application/json"}\r\nContent-Length: ${Buffer.byteLength(response)}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n${response}`,
      );
      s.end();
    },
  },
});
const cases = [false, true].flatMap((oauth) =>
  ["/v1/chat/completions", "/v1/messages", "/v1/responses"].flatMap((path) =>
    [false, true].flatMap((stream) =>
      [200, 400, 429, 500].map((code) => ({ oauth, path, stream, code, kind: "ordinary" })),
    ),
  ),
);
cases.push(
  ...["failover", "late"].map((kind) => ({
    oauth: false,
    path: "/v1/chat/completions",
    stream: true,
    code: 200,
    kind,
  })),
);
cases.push({ oauth: false, path: "/v1/chat/completions", stream: true, code: 200, kind: "throw" });
cases.push(
  ...["refresh-preserved", "refresh-backfill", "refresh-cas-loser"].map((kind) => ({
    oauth: true,
    path: "/v1/chat/completions",
    stream: false,
    code: 200,
    kind,
  })),
);
cases.push(
  ...["/v1/chat/completions", "/v1/responses"].map((path) => ({
    oauth: false,
    path,
    stream: true,
    code: 200,
    kind: "cancel",
  })),
);
if (process.env.OPENAI_REFRESH_ONLY === "1")
  cases.splice(0, cases.length, ...cases.filter((c) => c.kind.startsWith("refresh-")));
function request(path: string, stream: boolean) {
  return path === "/v1/responses"
    ? { model: "test-model", stream, input: "hello" }
    : {
        model: "test-model",
        stream,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      };
}
async function run(binary: string, label: string) {
  const output = [];
  for (const [i, c] of cases.entries()) {
    const root = join(work, `${label}-${i}`);
    mkdirSync(root);
    const dbPath = join(root, "omni.db");
    activeDb = dbPath;
    copyFileSync(env.OMNI_DB_PATH, dbPath);
    if (c.kind === "failover") {
      const db = new Database(dbPath);
      const row = db.query("SELECT * FROM credentials LIMIT 1").get() as Record<string, unknown>;
      row.id = "failover-second";
      row.label = "second";
      row.api_key = await encrypt(fieldKey, "second-key");
      const columns = Object.keys(row);
      db.run(
        `INSERT INTO credentials (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        Object.values(row) as import("bun:sqlite").SQLQueryBindings[],
      );
      db.close();
    }
    if (c.oauth) {
      const db = new Database(dbPath);
      db.run(
        "UPDATE credentials SET auth_type='oauth',api_key=NULL,access_token=?,refresh_token=?,expires_at=?,provider_data=?",
        [
          oauthToken,
          refreshToken,
          4102444800000,
          JSON.stringify(
            c.kind === "refresh-backfill" ? { accountId: identity.accountId } : identity,
          ),
        ],
      );
      db.close();
    }
    const child = Bun.spawn([binary], {
      cwd: work,
      env: { ...env, OMNI_ROOT: root, OMNI_DB_PATH: dbPath },
      stdout: "ignore",
      stderr: Bun.file(join(root, "stderr")),
    });
    try {
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch("http://127.0.0.1:18482/health")).ok) {
            ready = true;
            break;
          }
        } catch {}
        await Bun.sleep(50);
      }
      if (!ready) throw Error(`boot failed ${root}`);
      await Bun.sleep(100);
      if (c.kind.startsWith("refresh-")) {
        const db = new Database(dbPath);
        db.run("UPDATE credentials SET expires_at=1");
        db.close();
        await Bun.sleep(1500);
      }
      recorded = [];
      inferenceSockets = new Set();
      closedSockets = new Set();
      focused = c.kind;
      status = c.code;
      const catalog = await fetch("http://127.0.0.1:18482/v1/models", {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      const catalogBody = await catalog.json();
      if (
        catalog.status !== 200 ||
        !catalogBody.data.some((x: { id: string }) => x.id === "test-model")
      )
        throw Error("catalog missing configured model");
      const started = performance.now();
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:18482${c.path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(request(c.path, c.stream)),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      let body: Uint8Array;
      if (c.kind === "cancel") {
        const reader = res.body!.getReader();
        const parts: Uint8Array[] = [];
        while (!Buffer.concat(parts).includes("hello")) {
          const next = await reader.read();
          if (next.done) throw Error("cancel fixture ended before prefix");
          parts.push(next.value);
        }
        body = Buffer.concat(parts);
        controller.abort();
        await reader.cancel().catch(() => {});
        const deadline = performance.now() + 2000;
        while (
          ![...inferenceSockets].every((id) => closedSockets.has(id)) &&
          performance.now() < deadline
        )
          await Bun.sleep(10);
        if (![...inferenceSockets].every((id) => closedSockets.has(id)))
          throw Error(`${label} upstream cancellation did not close within 2s`);
      } else body = new Uint8Array(await res.arrayBuffer());
      if (c.kind === "late") {
        await Bun.sleep(1000);
        const second = await fetch(`http://127.0.0.1:18482${c.path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(request(c.path, c.stream)),
          signal: AbortSignal.timeout(5000),
        });
        const text = await second.text();
        if (second.status !== 200 || !text.includes("[DONE]")) throw Error("second End incomplete");
        if (!Buffer.from(body).includes("[DONE]") || performance.now() - started > 5000)
          throw Error("End/drain deadline");
        const expectedSockets = label === "rust" ? 1 : 2;
        if (inferenceSockets.size !== expectedSockets)
          throw Error(
            `${label} late sockets ${inferenceSockets.size}, expected ${expectedSockets}`,
          );
      }
      const tokenRequests = recorded.filter((x) => x.line === "POST /oauth/token HTTP/1.1");
      const upstream = recorded.filter(
        (x) => x.line.startsWith("POST ") && x.line !== "POST /oauth/token HTTP/1.1",
      );
      if (
        c.kind === "throw" &&
        (!Buffer.from(body).includes("openai codec decode threw") ||
          Buffer.from(body).includes("[DONE]"))
      )
        throw Error("throw did not preserve prefix then fail");
      if (upstream.length !== (["late", "failover"].includes(c.kind) ? 2 : 1))
        throw Error(`upstream count ${label}/${i}: ${upstream.length}`);
      if (
        c.kind === "failover" &&
        upstream[0]!.headers.find((h) => h.startsWith("authorization:")) ===
          upstream[1]!.headers.find((h) => h.startsWith("authorization:"))
      )
        throw Error("credential did not change");
      if (c.code === 200 && res.status !== 200)
        throw Error(`success status ${label}/${i}: ${res.status}`);
      if (c.code === 200 && !Buffer.from(body).includes("hello"))
        throw Error(`missing text ${label}/${i}`);
      const expected = c.oauth ? "/backend-api/codex/responses" : "/v1/responses";
      if (upstream[0]!.line !== `POST ${expected} HTTP/1.1`) throw Error("wrong upstream route");
      if (c.oauth && !upstream[0]!.headers.includes("chatgpt-account-id: account-fixture"))
        throw Error("account identity missing");
      // Shutdown flushes the asynchronous request-log/accounting writer.
      child.kill("SIGTERM");
      await child.exited;
      const db = new Database(dbPath);
      const credentials = db
        .query("SELECT id,disabled_reason,provider_data,token_version FROM credentials ORDER BY id")
        .all();
      let lifecycle: unknown = null;
      if (c.kind.startsWith("refresh-")) {
        const loser = c.kind === "refresh-cas-loser";
        if (
          tokenRequests.length !== 1 ||
          !upstream[0]!.headers.includes(
            `authorization: Bearer ${loser ? "winner-access" : "refreshed-access"}`,
          )
        )
          throw Error("refresh request/secrets not used");
        const row = db
          .query(
            "SELECT access_token,refresh_token,id_token,expires_at,account_email,provider_data,token_version,enabled,disabled_reason FROM credentials",
          )
          .get() as {
          access_token: string | null;
          refresh_token: string | null;
          id_token: string | null;
          expires_at: number | string;
          account_email: string | null;
          provider_data: string;
          token_version: number;
        };
        for (const col of ["access_token", "refresh_token", "id_token"] as const)
          if (row[col] !== null) row[col] = await decrypt(fieldKey, row[col]);
        if (
          row.access_token !== (loser ? "winner-access" : "refreshed-access") ||
          row.refresh_token !== (loser ? "winner-refresh" : "refreshed-refresh") ||
          row.id_token !== (loser ? null : refreshedId) ||
          row.token_version !== 1
        )
          throw Error("refresh persistence mismatch");
        if (loser) {
          if (row.expires_at !== 4102444800000 || row.account_email !== null)
            throw Error("losing metadata overwrote winner");
        } else {
          if (
            typeof row.expires_at !== "number" ||
            Math.abs(row.expires_at - Date.now() - 3600000) > 10000
          )
            throw Error("refresh expiry outside window");
          row.expires_at = "<validated refresh clock + 3600s>";
        }
        const data = JSON.parse(row.provider_data);
        if (data.accountId !== (loser ? identity.accountId : "refreshed-account"))
          throw Error("refresh account persistence mismatch");
        if (c.kind !== "refresh-backfill") {
          if (data.installationId !== identity.installationId || data.idSalt !== identity.idSalt)
            throw Error("prior identity replaced");
        } else {
          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              data.installationId,
            ) ||
            !/^[0-9a-f]{64}$/.test(data.idSalt)
          )
            throw Error("backfill malformed");
          data.installationId = "<validated uuid4>";
          data.idSalt = "<validated 32 random bytes>";
        }
        row.provider_data = JSON.stringify(data);
        const credential = credentials[0] as { provider_data: string } | undefined;
        if (!credential) throw Error("missing persisted credential");
        credential.provider_data = row.provider_data;
        const accounting = Object.fromEntries(
          ["request_logs", "usage_daily", "usage_rollup", "credential_health"].map((table) => {
            const order = {
              request_logs: "at, rowid",
              usage_daily:
                "day, provider, credential_id, requested_model, resolved_model, api_key_id",
              usage_rollup: "api_key_id, hour",
              credential_health: "credential_id, model",
            }[table];
            const rows = db.query(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<
              string,
              unknown
            >[];
            for (const r of rows) {
              for (const col of table === "request_logs"
                ? ["id", "at", "duration_ms", "node_id"]
                : table === "usage_daily"
                  ? ["duration_ms_sum"]
                  : []) {
                const value = r[col];
                if (col === "id" || col === "node_id") {
                  if (
                    typeof value !== "string" ||
                    !/^(req_)?[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                      value,
                    )
                  )
                    throw Error(`invalid ${col}`);
                } else if (
                  !Number.isFinite(value) ||
                  value < 0 ||
                  (col === "at" && Math.abs(value - Date.now()) > 10000)
                )
                  throw Error(`invalid ${col}`);
                delete r[col];
              }
              if (table === "request_logs") {
                if (r.ttft_ms !== null && (!Number.isFinite(r.ttft_ms) || r.ttft_ms < 0))
                  throw Error("invalid ttft");
                r.ttft_ms = r.ttft_ms !== null;
              }
            }
            return [table, rows];
          }),
        );
        if (
          accounting.request_logs.length !== 1 ||
          accounting.usage_daily.length !== 1 ||
          accounting.usage_rollup.length !== 1
        )
          throw Error("missing lifecycle accounting");
        lifecycle = { tokenRequests, persisted: row, accounting };
      }
      db.close();
      output.push({
        case: c,
        status: res.status,
        headers: [...res.headers.entries()],
        body: Buffer.from(body).toString(),
        upstream,
        catalog: catalogBody,
        credentials,
        lifecycle,
        sockets: inferenceSockets.size,
      });
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
  await Bun.write(join(work, `${label}.json`), JSON.stringify(output, null, 2));
  return output;
}
try {
  const ts = await run(resolve(f.ts!), "ts");
  const rust = await run(resolve(f.rust!), "rust");
  let failed = 0;
  for (const [i, c] of cases.entries()) {
    const norm = (row: (typeof ts)[number]) =>
      normalize({
        status: row.status,
        route: c.path,
        body: Buffer.from(row.body),
        headers: row.headers.filter(
          ([k]) =>
            !["date", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(
              k,
            ),
        ),
      });
    const a = norm(ts[i]!);
    const b = norm(rust[i]!);
    const upstream =
      JSON.stringify(maskWire(ts[i]!.upstream, c.oauth)) ===
      JSON.stringify(maskWire(rust[i]!.upstream, c.oauth));
    const state =
      JSON.stringify(ts[i]!.credentials) === JSON.stringify(rust[i]!.credentials) &&
      JSON.stringify(ts[i]!.lifecycle) === JSON.stringify(rust[i]!.lifecycle) &&
      JSON.stringify(ts[i]!.catalog) === JSON.stringify(rust[i]!.catalog);
    if (!normalizedEqual(a, b) || !upstream || !state) {
      failed++;
      console.error("DIFF", i, c, { upstream, state, ts: show(a), rust: show(b) });
    }
  }
  console.log({ work, rows: cases.length, failed });
  if (failed) process.exitCode = 1;
} finally {
  listener.stop(true);
}

// Only request-clock fields and the message UUID derived from that clock vary.
// Keep original ordered bytes, validate exact fixture paths and clock proximity,
// then replace their literal spans (including the nested metadata JSON string).
function maskWire(rows: Wire[], oauth: boolean): Wire[] {
  if (!oauth) return rows;
  return rows.map((row) => {
    const body = JSON.parse(row.body);
    const metadataHeader = row.headers.find((h) => h.startsWith("x-codex-turn-metadata: "))!;
    const metadata = metadataHeader.slice("x-codex-turn-metadata: ".length);
    const time = JSON.parse(metadata).turn_started_at_unix_ms;
    if (!Number.isInteger(time) || Math.abs(time - Date.now()) > 120000)
      throw Error("unexpected request clock");
    if (body.client_metadata["x-codex-turn-metadata"] !== metadata)
      throw Error("metadata header/body mismatch");
    const item = body.input[0];
    if (
      body.input.length !== 1 ||
      item.type !== "message" ||
      item.internal_chat_message_metadata_passthrough.create_time !== time / 1000 ||
      !/^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)
    )
      throw Error("unexpected time-derived message");
    const maskedMetadata = metadata.replace(
      `"turn_started_at_unix_ms":${time}`,
      '"turn_started_at_unix_ms":0',
    );
    return {
      ...row,
      headers: row.headers.map((h) =>
        h === metadataHeader ? `x-codex-turn-metadata: ${maskedMetadata}` : h,
      ),
      body: row.body
        .replace(JSON.stringify(metadata), JSON.stringify(maskedMetadata))
        .replace(`"create_time":${time / 1000}`, '"create_time":0')
        .replace(`"id":"${item.id}"`, '"id":"msg_<clock-derived>"'),
    };
  });
}
