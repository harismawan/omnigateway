#!/usr/bin/env bun
/**
 * Conformance e2e: the same request matrix against the TS gateway binary and
 * the Rust one, each on its own copy of one CLI-seeded root, both pointed at
 * one recording upstream. Asserts, with ids and timestamps masked:
 *
 * - client status, headers and body bytes are equal;
 * - the upstream request bytes are equal (raw: header names, order, casing,
 *   body);
 * - the final `request_logs`, `usage_daily`, `usage_rollup` and
 *   `credential_health` rows are equal.
 *
 *   bun scripts/build-binary.ts /tmp/opencode/e2e/ts-omnigateway
 *   cargo build --release -p omni-gateway
 *   bun conformance/e2e/run.ts --ts /tmp/opencode/e2e/ts-omnigateway \
 *     --rust target/release/omnigateway
 *
 * The mask list is `MASKS` below and in the task report. Exit 0 when every
 * row passes.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";

const { values: flags } = parseArgs({
  options: {
    ts: { type: "string" },
    rust: { type: "string" },
    cli: { type: "string", default: "bun apps/cli/src/index.ts" },
    keep: { type: "boolean", default: false },
    only: { type: "string" },
  },
});
if (flags.ts === undefined || flags.rust === undefined) {
  console.error("usage: run.ts --ts <ts binary> --rust <rust binary>");
  process.exit(2);
}

const REPO = resolve(import.meta.dir, "../..");
const KEY = "conformance-e2e-encryption-key-0123456789";
const UPSTREAM_PORT = 18411;
const GATEWAY_PORT = 18412;
mkdirSync("/tmp/opencode", { recursive: true });
const work = mkdtempSync("/tmp/opencode/omni-e2e-");
const seedRoot = join(work, "seed");
mkdirSync(seedRoot);
const children: Subprocess[] = [];
process.on("exit", () => {
  for (const c of children) c.kill("SIGKILL");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the upstream

/** Raw requests the upstream received, in arrival order. */
let recorded: string[] = [];

const frame = (model: string, choice: string) =>
  `data: {"id":"chatcmpl-e2e","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[${choice}]}\n\n`;
const chunk = (s: string) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`;
const SSE_HEAD =
  "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nConnection: keep-alive\r\ntransfer-encoding: chunked\r\n\r\n";

function plain(status: number, extra: string, body: string): string {
  return `HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\n${extra}content-length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`;
}

type Sock = { write(s: string): void; end(): void };

/** Scripted by the upstream model name the gateway forwards. */
async function answer(model: string, sock: Sock): Promise<void> {
  const first = frame(model, '{"index":0,"delta":{"role":"assistant","content":""}}');
  const delta = frame(model, '{"index":0,"delta":{"content":"lorem ipsum "}}');
  const finish = frame(model, '{"index":0,"delta":{},"finish_reason":"stop"}');
  const usage = `data: {"id":"chatcmpl-e2e","model":"${model}","choices":[],"usage":{"prompt_tokens":64,"completion_tokens":6,"total_tokens":70}}\n\n`;
  const done = "data: [DONE]\n\n";
  switch (model) {
    case "ok":
      sock.write(
        SSE_HEAD +
          [first, delta, delta, delta, finish, usage, done].map(chunk).join("") +
          "0\r\n\r\n",
      );
      return;
    case "fail500":
      sock.write(plain(500, "", '{"error":{"message":"upstream exploded"}}'));
      return;
    case "fail429":
      sock.write(plain(429, "retry-after: 1\r\n", '{"error":{"message":"slow down"}}'));
      return;
    case "mid":
      sock.write(`${SSE_HEAD + [first, delta].map(chunk).join("")}0\r\n\r\n`);
      return;
    case "slow":
      sock.write(SSE_HEAD + [first, delta].map(chunk).join(""));
      await sleep(1500);
      try {
        sock.write(`${[delta, finish, usage, done].map(chunk).join("")}0\r\n\r\n`);
      } catch {
        // the gateway hung up
      }
      return;
    default:
      sock.write(plain(400, "", '{"error":{"message":"unknown script"}}'));
  }
}

Bun.listen<{ buf: Buffer; busy: Promise<void> }>({
  hostname: "127.0.0.1",
  port: UPSTREAM_PORT,
  socket: {
    open(s) {
      s.data = { buf: Buffer.alloc(0), busy: Promise.resolve() };
    },
    data(s, data) {
      s.data.buf = Buffer.concat([s.data.buf, data]);
      for (;;) {
        const end = s.data.buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = s.data.buf.subarray(0, end).toString("latin1");
        const m = /\r\ncontent-length: *(\d+)/i.exec(head);
        const len = m === null ? 0 : Number(m[1]);
        if (s.data.buf.length < end + 4 + len) return;
        const raw = s.data.buf.subarray(0, end + 4 + len).toString("utf8");
        s.data.buf = s.data.buf.subarray(end + 4 + len);
        recorded.push(raw);
        const model = /"model":"([^"]*)"/.exec(raw.slice(end + 4))?.[1] ?? "";
        const sock: Sock = {
          write: (x) => {
            s.write(x);
          },
          end: () => s.end(),
        };
        s.data.busy = s.data.busy.then(() => answer(model, sock));
      }
    },
  },
});

// ------------------------------------------------------------ seeding

const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: KEY,
  OMNI_HOST: "127.0.0.1",
  OMNI_PORT: String(GATEWAY_PORT),
  OMNI_LOG_LEVEL: "warn",
};
const CLI = (flags.cli ?? "").split(/\s+/).filter(Boolean);

async function cli(args: string[], stdin?: string): Promise<{ id: string; key: string }> {
  const p = Bun.spawn([...CLI, "--root", seedRoot, "--json", ...args], {
    cwd: REPO,
    env: { ...env, OMNI_DB_PATH: join(seedRoot, "omni.db") },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`omni ${args.join(" ")}: ${err}`);
  return JSON.parse(out);
}

async function seed(): Promise<Record<string, string>> {
  writeFileSync(
    join(seedRoot, ".env"),
    `OMNI_ENCRYPTION_KEY=${KEY}\nOMNI_DB_PATH=${join(seedRoot, "omni.db")}\n`,
  );
  const ids: Record<string, string> = {};
  for (const e of ["ok", "f500", "f429", "mid", "dead", "off"]) {
    ids[e] = (
      await cli(
        [
          "credentials",
          "add-key",
          "custom",
          "--label",
          `cred-${e}`,
          "--endpoint-id",
          e,
          "--endpoint-label",
          e,
          "--origin",
          `http://127.0.0.1:${e === "dead" ? 9 : UPSTREAM_PORT}`,
          "--protocol",
          "chat-completions",
        ],
        `sk-upstream-${e}\n`,
      )
    ).id;
  }
  await cli(["credentials", "disable", ids.off as string, "--yes"]);
  const target = (endpointId: string, model: string, tier: number) => ({
    provider: "custom",
    endpointId,
    model,
    tier,
    weight: 1,
    costPerMTok: { input: 1, output: 2 },
    capabilities: { tools: true, images: true, reasoning: true },
  });
  const models: Record<string, unknown[]> = {
    ok: [target("ok", "ok", 1)],
    "fo-500": [target("f500", "fail500", 1), target("ok", "ok", 2)],
    "fo-429": [target("f429", "fail429", 1), target("ok", "ok", 2)],
    "all-fail": [target("dead", "ok", 1), target("f500", "fail500", 2)],
    mid: [target("mid", "mid", 1)],
    slow: [target("ok", "slow", 1)],
    "no-cands": [target("off", "ok", 1)],
  };
  for (const [id, targets] of Object.entries(models)) {
    const file = join(seedRoot, `${id}.json`);
    writeFileSync(file, JSON.stringify({ id, strategy: "priority", isAlias: false, targets }));
    await cli(["models", "put", id, "-f", file]);
  }
  const keys: Record<string, string> = {};
  keys.plain = (await cli(["keys", "create", "--label", "plain"])).key;
  keys.allow = (await cli(["keys", "create", "--label", "allow", "--allow", "ok"])).key;
  keys.lim1m = (await cli(["keys", "create", "--label", "lim1m", "--limit", "requests:1m=2"])).key;
  keys.limc = (await cli(["keys", "create", "--label", "limc", "--limit", "concurrency=1"])).key;
  keys.policy = (await cli(["keys", "create", "--label", "policy", "--policy", "no secrets"])).key;
  keys.smart = (await cli(["keys", "create", "--label", "smart", "--smart-routing"])).key;
  const revoked = await cli(["keys", "create", "--label", "revoked"]);
  keys.revoked = revoked.key;
  await cli(["keys", "revoke", revoked.id, "--yes"]);
  const expired = await cli(["keys", "create", "--label", "expired"]);
  keys.expired = expired.key;
  await cli(["keys", "expiry", expired.id, "--at", "2000-01-01"]);
  return keys;
}

// ------------------------------------------------------------ the matrix

type Exchange = { status: number; headers: [string, string][]; body: string };
type Row = {
  name: string;
  /** Changes stored settings for this row (the gateway's database), restored after. */
  settings?: Record<string, unknown>;
  run: (base: string, keys: Record<string, string>) => Promise<Exchange[]>;
};

const msg = (model: string, stream: boolean) =>
  JSON.stringify({
    model,
    max_tokens: 16,
    stream,
    messages: [{ role: "user", content: "Say hi." }],
  });
const chatBody = (model: string, stream: boolean) =>
  JSON.stringify({ model, stream, messages: [{ role: "user", content: "Say hi." }] });
const respBody = (model: string, stream: boolean) =>
  JSON.stringify({ model, stream, input: "Say hi." });

async function send(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Exchange> {
  const res = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
}

const bearer = (k: string) => ({
  authorization: `Bearer ${k}`,
  "content-type": "application/json",
});
const one =
  (
    method: string,
    path: string,
    key: (k: Record<string, string>) => Record<string, string>,
    body?: string,
  ): Row["run"] =>
  async (base, keys) => [await send(base, method, path, key(keys), body)];

const ROWS: Row[] = [
  { name: "health", run: one("GET", "/health", () => ({})) },
  { name: "404 get", run: one("GET", "/nope", () => ({})) },
  { name: "404 post", run: one("POST", "/v1/nope", () => ({}), "{}") },
  {
    name: "anthropic buffered",
    run: one("POST", "/v1/messages", (k) => bearer(k.plain), msg("ok", false)),
  },
  {
    name: "anthropic stream",
    run: one("POST", "/v1/messages", (k) => bearer(k.plain), msg("ok", true)),
  },
  {
    name: "chat buffered",
    run: one("POST", "/v1/chat/completions", (k) => bearer(k.plain), chatBody("ok", false)),
  },
  {
    name: "chat stream",
    run: one("POST", "/v1/chat/completions", (k) => bearer(k.plain), chatBody("ok", true)),
  },
  {
    name: "responses buffered",
    run: one("POST", "/v1/responses", (k) => bearer(k.plain), respBody("ok", false)),
  },
  {
    name: "responses stream",
    run: one("POST", "/v1/responses", (k) => bearer(k.plain), respBody("ok", true)),
  },
  {
    name: "count_tokens",
    run: one("POST", "/v1/messages/count_tokens", (k) => bearer(k.plain), msg("ok", false)),
  },
  { name: "models", run: one("GET", "/v1/models", (k) => ({ "x-api-key": k.plain })) },
  { name: "models allowlisted", run: one("GET", "/v1/models", (k) => ({ "x-api-key": k.allow })) },
  { name: "auth none", run: one("POST", "/v1/messages", () => ({}), msg("ok", false)) },
  {
    name: "auth bad",
    run: one(
      "POST",
      "/v1/chat/completions",
      () => bearer("sk-omni-not-a-key"),
      chatBody("ok", false),
    ),
  },
  {
    name: "auth both headers",
    run: one(
      "POST",
      "/v1/messages",
      (k) => ({ ...bearer(k.plain), "x-api-key": "other" }),
      msg("ok", false),
    ),
  },
  {
    name: "auth revoked",
    run: one("POST", "/v1/responses", (k) => bearer(k.revoked), respBody("ok", false)),
  },
  {
    name: "auth expired",
    run: one("POST", "/v1/messages", (k) => bearer(k.expired), msg("ok", false)),
  },
  {
    name: "auth bad on models",
    run: one("GET", "/v1/models", () => ({ "x-api-key": "sk-omni-nope" })),
  },
  {
    name: "model not allowed",
    run: one("POST", "/v1/messages", (k) => bearer(k.allow), msg("fo-500", false)),
  },
  { name: "invalid json", run: one("POST", "/v1/messages", (k) => bearer(k.plain), "{bad") },
  {
    name: "invalid json (chat)",
    run: one("POST", "/v1/chat/completions", (k) => bearer(k.plain), "[1,]"),
  },
  {
    name: "wrong types",
    run: one("POST", "/v1/messages", (k) => bearer(k.plain), '{"model":1,"messages":"x"}'),
  },
  {
    name: "wrong types (responses)",
    run: one("POST", "/v1/responses", (k) => bearer(k.plain), '{"model":"ok","input":5}'),
  },
  {
    name: "unknown model",
    run: one("POST", "/v1/chat/completions", (k) => bearer(k.plain), chatBody("nope", false)),
  },
  {
    name: "no candidates",
    run: one("POST", "/v1/messages", (k) => bearer(k.plain), msg("no-cands", true)),
  },
  {
    name: "failover on 500 (stream)",
    run: one("POST", "/v1/messages", (k) => bearer(k.plain), msg("fo-500", true)),
  },
  {
    name: "failover on 429 (buffered)",
    run: one("POST", "/v1/chat/completions", (k) => bearer(k.plain), chatBody("fo-429", false)),
  },
  {
    name: "all candidates fail",
    run: one("POST", "/v1/responses", (k) => bearer(k.plain), respBody("all-fail", false)),
  },
  {
    name: "mid-stream error (stream)",
    run: one("POST", "/v1/messages", (k) => bearer(k.plain), msg("mid", true)),
  },
  {
    name: "mid-stream error (buffered)",
    run: one("POST", "/v1/chat/completions", (k) => bearer(k.plain), chatBody("mid", false)),
  },
  {
    name: "client disconnects mid-stream",
    run: async (base, keys) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: bearer(keys.plain),
        body: msg("slow", true),
        signal: ac.signal,
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let seen = "";
      while (!seen.includes("lorem ipsum")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      ac.abort();
      await sleep(2500);
      // Only the head is compared: the body is cut by the client.
      return [{ status: res.status, headers: [...res.headers.entries()], body: "" }];
    },
  },
  {
    name: "policy key, guardrail unconfigured (buffered)",
    run: one("POST", "/v1/messages", (k) => bearer(k.policy), msg("ok", false)),
  },
  {
    name: "policy key, guardrail unconfigured (anthropic stream)",
    run: one("POST", "/v1/messages", (k) => bearer(k.policy), msg("ok", true)),
  },
  {
    name: "policy key, guardrail unconfigured (chat stream)",
    run: one("POST", "/v1/chat/completions", (k) => bearer(k.policy), chatBody("ok", true)),
  },
  {
    name: "policy key, guardrail unconfigured (responses stream)",
    run: one("POST", "/v1/responses", (k) => bearer(k.policy), respBody("ok", true)),
  },
  {
    name: "smart-routing key, smart routing off",
    run: one("POST", "/v1/chat/completions", (k) => bearer(k.smart), chatBody("ok", false)),
  },
  {
    name: "smart-routing key, smart routing on, unconfigured (buffered)",
    settings: { smartRouterEnabled: true },
    run: one("POST", "/v1/messages", (k) => bearer(k.smart), msg("ok", false)),
  },
  {
    name: "smart-routing key, smart routing on, unconfigured (responses stream)",
    settings: { smartRouterEnabled: true },
    run: one("POST", "/v1/responses", (k) => bearer(k.smart), respBody("ok", true)),
  },
  {
    name: "rate limit 1m hit",
    run: async (base, keys) => {
      const out: Exchange[] = [];
      for (let i = 0; i < 3; i += 1)
        out.push(
          await send(
            base,
            "POST",
            "/v1/chat/completions",
            bearer(keys.lim1m),
            chatBody("ok", false),
          ),
        );
      return out;
    },
  },
  {
    name: "concurrency limit hit",
    run: async (base, keys) => {
      const first = send(base, "POST", "/v1/messages", bearer(keys.limc), msg("slow", true));
      await sleep(400);
      const second = await send(base, "POST", "/v1/messages", bearer(keys.limc), msg("ok", false));
      return [await first, second];
    },
  },
];

// ------------------------------------------------------------ masks

const MASKS: [RegExp, string][] = [
  [/req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "req_<id>"],
  [/"nodeId":"[0-9a-f-]{36}"/g, '"nodeId":"<node>"'],
  [/"created(_at)?":\d+/g, '"created$1":<t>'],
];
const MASKED_HEADERS = new Set(["date"]);
/** Headers whose values are instants or waits measured from the clock. */
const TIMED_HEADER = /^(retry-after|x-ratelimit-reset-.*|anthropic-ratelimit-.*-reset)$/;

function mask(s: string): string {
  return MASKS.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

function normalize(x: Exchange): Exchange {
  return {
    status: x.status,
    headers: x.headers
      .filter(([k]) => !MASKED_HEADERS.has(k))
      .map(([k, v]): [string, string] => [k, TIMED_HEADER.test(k) ? "<t>" : v])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    body: mask(x.body),
  };
}

// ------------------------------------------------------------ running

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`)).ok) return;
    } catch {
      // not yet
    }
    await sleep(20);
  }
  throw new Error("gateway did not become healthy");
}

type Run = { exchanges: Map<string, Exchange[]>; upstream: Map<string, string[]>; db: string };

async function runAgainst(
  label: string,
  binary: string,
  keys: Record<string, string>,
): Promise<Run> {
  const root = join(work, label);
  mkdirSync(root);
  const db = join(root, "omni.db");
  copyFileSync(join(seedRoot, "omni.db"), db);
  const proc = Bun.spawn([binary], {
    cwd: root,
    env: { ...env, OMNI_DB_PATH: db, OMNI_STATIC_DIR: join(root, "none") },
    stdout: Bun.file(join(root, "gateway.log")),
    stderr: Bun.file(join(root, "gateway.err")),
  });
  children.push(proc);
  await waitHealthy();
  const base = `http://127.0.0.1:${GATEWAY_PORT}`;
  const exchanges = new Map<string, Exchange[]>();
  const upstream = new Map<string, string[]>();
  const only = flags.only?.split(",");
  for (const row of ROWS) {
    if (only !== undefined && !only.includes(row.name)) continue;
    recorded = [];
    let restore: string | null = null;
    if (row.settings !== undefined) {
      const d = new Database(db);
      const cur = d.query("SELECT value FROM settings WHERE key = 'settings'").get() as {
        value: string;
      } | null;
      restore = cur?.value ?? "{}";
      d.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)", [
        JSON.stringify({ ...(JSON.parse(restore) as object), ...row.settings }),
      ]);
      d.close();
      // Both gateways rebuild on `data_version`; Rust polls every 500 ms.
      await sleep(1200);
    }
    exchanges.set(row.name, await row.run(base, keys));
    if (restore !== null) {
      const d = new Database(db);
      d.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)", [restore]);
      d.close();
      await sleep(1200);
    }
    await sleep(50);
    upstream.set(row.name, recorded);
  }
  proc.kill("SIGTERM");
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} exited ${code}`);
  return { exchanges, upstream, db };
}

function table(db: string, sql: string): unknown[][] {
  const d = new Database(db, { readonly: true });
  const rows = d.query(sql).values() as unknown[][];
  d.close();
  return rows;
}

/** Final rows, with per-run columns masked (see MASKS in the report). */
function dbState(db: string): Record<string, unknown[][]> {
  return {
    request_logs: table(
      db,
      `SELECT api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
        attempts, status, error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        ttft_ms IS NOT NULL, cost_usd, degradations, state, rtk_applied, rtk_filter_hits,
        rtk_original_code_units, rtk_compressed_code_units, rtk_estimated_tokens_saved, rtk_filters
        FROM request_logs ORDER BY at, rowid`,
    ),
    usage_daily: table(
      db,
      `SELECT day, provider, credential_id, requested_model, resolved_model, api_key_id,
        requests, errors, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
        rtk_saved_tokens, rtk_applied_requests FROM usage_daily ORDER BY 1,2,3,4,5,6`,
    ),
    usage_rollup: table(db, "SELECT * FROM usage_rollup ORDER BY api_key_id, hour"),
    credential_health: table(
      db,
      `SELECT credential_id, model, breaker_state, consecutive_failures,
        opened_at IS NOT NULL, rate_limited_until IS NOT NULL FROM credential_health ORDER BY 1, 2`,
    ),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  console.error(`work ${work}`);
  const keys = await seed();
  const ts = await runAgainst("ts", resolve(REPO, flags.ts as string), keys);
  const rs = await runAgainst("rust", resolve(REPO, flags.rust as string), keys);

  let failures = 0;
  const report: string[] = ["| row | client | upstream |", "|---|---|---|"];
  for (const [name, tsx] of ts.exchanges) {
    const rsx = rs.exchanges.get(name) ?? [];
    const client = same(tsx.map(normalize), rsx.map(normalize));
    const up = same(ts.upstream.get(name), rs.upstream.get(name));
    report.push(`| ${name} | ${client ? "pass" : "FAIL"} | ${up ? "pass" : "FAIL"} |`);
    if (!client) {
      failures += 1;
      console.error(
        `\n--- ${name}: client differs\nTS:   ${JSON.stringify(tsx.map(normalize))}\nRust: ${JSON.stringify(rsx.map(normalize))}`,
      );
    }
    if (!up) {
      failures += 1;
      console.error(
        `\n--- ${name}: upstream bytes differ\nTS:   ${JSON.stringify(ts.upstream.get(name))}\nRust: ${JSON.stringify(rs.upstream.get(name))}`,
      );
    }
  }
  const tsDb = dbState(ts.db);
  const rsDb = dbState(rs.db);
  for (const t of Object.keys(tsDb)) {
    const ok = same(tsDb[t], rsDb[t]);
    report.push(`| db: ${t} (${tsDb[t]?.length} rows) | ${ok ? "pass" : "FAIL"} | |`);
    if (!ok) {
      failures += 1;
      const a = tsDb[t] ?? [];
      const b = rsDb[t] ?? [];
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (!same(a[i], b[i]))
          console.error(
            `\n--- ${t}[${i}]\nTS:   ${JSON.stringify(a[i])}\nRust: ${JSON.stringify(b[i])}`,
          );
      }
    }
  }
  console.log(report.join("\n"));
  console.log(failures === 0 ? "\nall rows equal" : `\n${failures} difference(s)`);
  if (!flags.keep) rmSync(work, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

await main();
