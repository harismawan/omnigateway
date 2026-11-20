#!/usr/bin/env bun
/** Frozen screening oracle. Invoke through smart-router-ns.sh only.
 * Reserved ports: gateway 18540, local custom stub 18541, external TLS stub 443.
 * Each case owns a database/process; its two requests share process-local caches.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { deriveKey, encrypt } from "../../packages/store/src/encryption.ts";
import { normalize } from "./masks.ts";

const { values: f } = parseArgs({
  options: Object.fromEntries(
    ["ts", "rust", "work", "cert", "key"].map((k) => [k, { type: "string" as const }]),
  ),
});
for (const k of ["ts", "rust", "work", "cert", "key"]) if (!f[k]) throw Error(`--${k} required`);
const work = resolve(f.work!);
if (!work.startsWith("/tmp/opencode/c1/w-")) throw Error("private w- evidence directory required");
const seed = join(work, "seed");
mkdirSync(seed);
const env = {
  PATH: process.env.PATH!,
  HOME: seed,
  TMPDIR: work,
  NODE_EXTRA_CA_CERTS: f.cert!,
  SSL_CERT_FILE: f.cert!,
  OMNI_ENCRYPTION_KEY: "c1-screening-fixture-0123456789012345",
  OMNI_HOST: "127.0.0.1",
  OMNI_PORT: "18540",
  OMNI_LOG_LEVEL: "debug",
  OMNI_STATIC_DIR: join(work, "absent"),
  OMNI_DAY_OFFSET_MINUTES: "0",
};
const seedDb = join(seed, "omnigateway.db");
async function cli(args: string[]) {
  const p = Bun.spawn(
    ["bun", "--no-env-file", "apps/cli/src/index.ts", "--root", seed, "--json", ...args],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...env, OMNI_DB_PATH: seedDb },
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
const key = (await cli(["keys", "create", "--label", "screening"])).key;
const fieldKey = await deriveKey(env.OMNI_ENCRYPTION_KEY);
const db = new Database(seedDb);
for (const [id, provider, data] of [
  [
    "local",
    "custom",
    {
      endpointId: "fixture",
      endpointLabel: "Fixture",
      origin: "http://127.0.0.1:18541",
      protocol: "chat_completions",
    },
  ],
  ["external", "openai", {}],
] as const) {
  db.run(
    `INSERT INTO credentials (id,provider,label,auth_type,enabled,tier,weight,provider_data,api_key,created_at,updated_at,token_version)
    VALUES (?,?,?,'apiKey',1,1,1,?,?,1000,1000,0)`,
    [id, provider, id, JSON.stringify(data), await encrypt(fieldKey, "fixture-key")],
  );
}
db.close();
for (const id of ["external-model", "local-model", "classifier", "judge"]) {
  const external = id === "external-model";
  const file = join(seed, `${id}.json`);
  await Bun.write(
    file,
    JSON.stringify({
      id,
      strategy: "priority",
      isAlias: false,
      targets: [
        {
          provider: external ? "openai" : "custom",
          model: external ? "gpt-4o" : id,
          ...(external ? {} : { endpointId: "fixture" }),
          tier: 1,
          weight: 1,
          costPerMTok: { input: 1, output: 2 },
          capabilities: { tools: true, images: true, reasoning: true },
        },
      ],
    }),
  );
  await cli(["models", "put", id, "-f", file]);
}

type Kind =
  | "public"
  | "confidential"
  | "garbage"
  | "timeout"
  | "5xx"
  | "off"
  | "already-local"
  | "oversize"
  | "unconfigured"
  | "guard-allow"
  | "guard-deny"
  | "guard-garbage"
  | "guard-timeout"
  | "guard-5xx"
  | "guard-unconfigured"
  | "both-public"
  | "both-local";
type Case = { name: string; path: string; stream: boolean; kind: Kind };
const cases: Case[] = [];
for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"])
  for (const stream of [false, true])
    for (const kind of [
      "public",
      "confidential",
      "garbage",
      "timeout",
      "5xx",
      "off",
      "already-local",
      "oversize",
      "unconfigured",
      "guard-allow",
      "guard-deny",
      "guard-garbage",
      "guard-timeout",
      "guard-5xx",
      "guard-unconfigured",
      "both-public",
      "both-local",
    ] as Kind[])
      cases.push({ name: `${path}/${stream}/${kind}`, path, stream, kind });

type Wire = { target: string; head: string[]; body: string };
let wires: Wire[] = [],
  current = cases[0]!;
function listener(
  port: number,
  tls?: { cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> },
) {
  return Bun.listen<{ buffer: Buffer }>({
    hostname: "127.0.0.1",
    port,
    ...(tls ? { tls } : {}),
    socket: {
      open(s) {
        s.data = { buffer: Buffer.alloc(0) };
      },
      data(s, chunk) {
        s.data.buffer = Buffer.concat([s.data.buffer, chunk]);
        const raw = s.data.buffer.toString(),
          end = raw.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = raw.slice(0, end).split("\r\n");
        const size = Number(head.find((h) => /^content-length:/i.test(h))?.split(":")[1] ?? 0);
        if (s.data.buffer.length < end + 4 + size) return;
        const body = s.data.buffer.subarray(end + 4, end + 4 + size).toString();
        s.data.buffer = s.data.buffer.subarray(end + 4 + size);
        wires.push({ target: tls ? "external" : "local", head, body });
        const request = JSON.parse(body);
        const classifier = request.model === "classifier" || request.model === "judge";
        const guard =
          request.model === "judge" ||
          body.includes("usage policy") ||
          body.includes("usage-policy");
        if (classifier && current.kind.includes("timeout")) return; // closed by gateway deadline
        const status = classifier && current.kind.includes("5xx") ? 500 : 200;
        const text = !classifier
          ? "hello"
          : current.kind.includes("garbage")
            ? "not a verdict"
            : guard
              ? current.kind.includes("deny")
                ? "DENY"
                : "ALLOW"
              : ["confidential", "both-local"].includes(current.kind)
                ? "CONFIDENTIAL"
                : "PUBLIC";
        const payload = {
          id: "fixture",
          object: "chat.completion",
          created: 1000,
          model: request.model,
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        };
        // Adapters force streaming on their upstream; retain non-stream compatibility too.
        const responses = [
          { type: "response.created", response: { id: "resp_fixed", model: request.model } },
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
          { type: "response.output_text.delta", output_index: 0, delta: text },
          {
            type: "response.content_part.done",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_fixed",
              model: request.model,
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            },
          },
        ]
          .map((x) => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`)
          .join("");
        const reply =
          status !== 200
            ? '{"error":{"message":"fixture failure","type":"server_error"}}'
            : tls
              ? responses
              : request.stream
                ? `data: ${JSON.stringify({ ...payload, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...payload, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
                : JSON.stringify(payload);
        const respond = () => {
          s.write(
            `HTTP/1.1 ${status} Fixture\r\nContent-Type: ${request.stream && status === 200 ? "text/event-stream" : "application/json"}\r\nContent-Length: ${Buffer.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`,
          );
          s.end();
        };
        if (classifier && pendingCase(current)) setTimeout(respond, 2000);
        else respond();
      },
    },
  });
}
const local = listener(18541),
  external = listener(443, { cert: Bun.file(f.cert!), key: Bun.file(f.key!) });
function request(c: Case) {
  const model = c.kind === "already-local" ? "local-model" : "external-model";
  const text = c.kind === "oversize" ? "x".repeat(8000 * 65) : "fixture human";
  if (c.path === "/v1/responses") return { model, stream: c.stream, input: text };
  return { model, stream: c.stream, max_tokens: 128, messages: [{ role: "user", content: text }] };
}
type Client = { status: number; headers: [string, string][]; body: string; route: string };
type CapturedClient = Client & {
  normalized?: (Omit<NonNullable<ReturnType<typeof norm>>, "body"> & { body: string }) | null;
};
const logMask = (row: object) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([k]) => !["id", "at", "duration_ms", "ttft_ms", "updated_at", "node_id"].includes(k),
    ),
  );
const pendingCase = (c: Case) =>
  c.kind === "guard-allow" && c.path === "/v1/chat/completions" && !c.stream;
async function run(binary: string, label: string) {
  const rows = [];
  for (const [i, c] of cases.entries()) {
    current = c;
    wires = [];
    const root = join(work, `${label}-${i}`);
    mkdirSync(root);
    const file = join(root, "omni.db");
    copyFileSync(seedDb, file);
    const d = new Database(file);
    const guard = c.kind.startsWith("guard-") || c.kind.startsWith("both-");
    d.run("UPDATE api_keys SET smart_routing=?,guardrail_policy=?", [
      c.kind.startsWith("guard-") ? 0 : 1,
      guard ? "Only fixture questions are allowed." : null,
    ]);
    const old = d
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key='settings'")
      .get();
    const settings = {
      ...(old ? JSON.parse(old.value) : {}),
      smartRouterEnabled: c.kind !== "off",
      smartRouterClassifierModel: c.kind === "unconfigured" ? null : "classifier",
      smartRouterLocalModel: "local-model",
      smartRouterPolicy: "Private account data is confidential.",
      smartRouterTimeoutMs: 100,
      guardrailModel: c.kind === "guard-unconfigured" ? null : "judge",
      guardrailTimeoutMs: pendingCase(c) ? 5000 : 100,
      guardrailHistoryTurns: 3,
    };
    d.run(
      "INSERT INTO settings(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(settings)],
    );
    d.close();
    const child = Bun.spawn([resolve(binary)], {
      cwd: root,
      env: { ...env, HOME: root, OMNI_ROOT: root, OMNI_DB_PATH: file },
      stdout: Bun.file(join(root, "stdout")),
      stderr: Bun.file(join(root, "stderr")),
    });
    try {
      let ready = false;
      for (let n = 0; n < 200; n++) {
        try {
          if ((await fetch("http://127.0.0.1:18540/health", { keepalive: false })).ok) {
            ready = true;
            break;
          }
        } catch {}
        await Bun.sleep(25);
      }
      if (!ready) throw Error(`boot failed: ${root}`);
      const clients: CapturedClient[] = [],
        rounds: Wire[][] = [],
        pending: { requested_model: string; status: number; api_key_id: string | null }[][] = [];
      for (let round = 0; round < 2; round++) {
        wires = [];
        const snapshot =
          pendingCase(c) && round === 0
            ? setTimeout(() => {
                const reader = new Database(file);
                pending.push(
                  reader
                    .query<(typeof pending)[number][number], []>(
                      "SELECT requested_model,status,api_key_id FROM request_logs ORDER BY rowid",
                    )
                    .all(),
                );
                reader.close();
              }, 700)
            : undefined;
        try {
          const response = await fetch("http://127.0.0.1:18540" + c.path, {
            method: "POST",
            keepalive: false,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify(request(c)),
            signal: AbortSignal.timeout(20000),
          });
          clients.push({
            status: response.status,
            headers: [...response.headers.entries()],
            body: await response.text(),
            route: c.path,
          });
        } catch (error) {
          clients.push({
            status: 0,
            headers: [],
            body: `TRANSPORT:${(error && typeof error === "object" && "code" in error ? error.code : undefined) ?? String(error)}`,
            route: c.path,
          });
        }
        clearTimeout(snapshot);
        // Apply time-sensitive masks at receipt, not minutes later after both tables.
        const client = clients.at(-1);
        if (!client) throw Error("missing captured client response");
        const normalized = norm(client);
        client.normalized = normalized && {
          ...normalized,
          body: Buffer.from(normalized.body).toString("hex"),
        };
        rounds.push([...wires]);
      }
      child.kill("SIGTERM");
      await child.exited;
      const reader = new Database(file);
      const logs = reader.query("SELECT * FROM request_logs ORDER BY rowid").all().map(logMask);
      reader.close();
      rows.push({ name: c.name, clients, upstream: rounds, logs, pending });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
    }
  }
  return rows;
}
function norm(c: Client) {
  return normalize({
    ...c,
    body: Buffer.from(c.body),
    headers: c.headers.filter(
      ([k]: string[]) =>
        !["date", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(k!),
    ),
  });
}
function valid(row: Awaited<ReturnType<typeof run>>[number], c: Case) {
  const failure = [
    "garbage",
    "timeout",
    "5xx",
    "unconfigured",
    "guard-deny",
    "guard-garbage",
    "guard-timeout",
    "guard-5xx",
    "guard-unconfigured",
  ].includes(c.kind);
  const status = c.stream
    ? 200
    : c.kind.includes("unconfigured")
      ? 500
      : c.kind === "guard-deny"
        ? 400
        : failure
          ? 502
          : 200;
  if (row.clients.length !== 2 || row.clients.some((r) => r.status !== status)) return false;
  if (
    pendingCase(c) &&
    (row.pending.length !== 1 ||
      row.pending[0].length !== 1 ||
      row.pending[0][0].requested_model !== "judge" ||
      row.pending[0][0].status !== 0 ||
      !row.pending[0][0].api_key_id)
  )
    return false;
  const calls = (r: Wire[]) =>
    r.filter((w) => ["classifier", "judge"].includes(JSON.parse(w.body).model));
  const cached = [
    "public",
    "confidential",
    "guard-allow",
    "guard-deny",
    "both-public",
    "both-local",
  ].includes(c.kind);
  if (cached && (calls(row.upstream[0]).length === 0 || calls(row.upstream[1]).length !== 0))
    return false;
  if (
    ["off", "already-local", "oversize", "unconfigured", "guard-unconfigured"].includes(c.kind) &&
    row.upstream.some((r: Wire[]) => calls(r).length)
  )
    return false;
  const all = row.upstream.flat() as Wire[];
  const classifierCalls = calls(all);
  const classifierRows = row.logs.filter((l) =>
    JSON.parse(l.degradations).some((n: string) => n.endsWith(":classifier")),
  );
  // This corpus uses one smart segment per ordinary request (oversize bypasses).
  if (
    row.logs.length !== 2 + classifierRows.length ||
    classifierRows.length !== classifierCalls.length
  )
    return false;
  const main = all.filter((w) => !["classifier", "judge"].includes(JSON.parse(w.body).model));
  if (main.length !== (failure ? 0 : 2)) return false;
  const local = ["confidential", "already-local", "oversize", "both-local"].includes(c.kind);
  if (main.some((w) => w.target !== (local ? "local" : "external"))) return false;
  for (const client of row.clients) {
    const route = client.headers.find(([k]: string[]) => k === "x-omni-route")?.[1];
    const judged = !c.kind.startsWith("guard-") && c.kind !== "off";
    if (route !== (!c.stream && !failure && judged ? (local ? "local" : "external") : undefined))
      return false;
  }
  return true;
}
try {
  const ts = await run(f.ts!, "ts"),
    rust = await run(f.rust!, "rust");
  await Bun.write(join(work, "ts.rows.json"), JSON.stringify(ts, null, 2));
  await Bun.write(join(work, "rust.rows.json"), JSON.stringify(rust, null, 2));
  let failed = 0,
    equal = 0,
    oracleInvalid = 0;
  console.log(
    "| row | client | upstream | stored | oracle | scenario |\n|---|---|---|---|---|---|",
  );
  for (const [i, c] of cases.entries()) {
    const a = ts[i]!,
      b = rust[i]!;
    const client = a.clients.every(
      (x, j) => x.normalized !== null && isDeepStrictEqual(x.normalized, b.clients[j].normalized),
    );
    const upstream = isDeepStrictEqual(a.upstream, b.upstream),
      stored = isDeepStrictEqual(a.logs, b.logs) && isDeepStrictEqual(a.pending, b.pending);
    const oracle = valid(a, c),
      scenario = valid(b, c);
    if (!oracle) oracleInvalid++;
    if (client && upstream && stored && oracle && scenario) equal++;
    else failed++;
    console.log(`| ${c.name} | ${client} | ${upstream} | ${stored} | ${oracle} | ${scenario} |`);
  }
  console.log(JSON.stringify({ equal, failed, total: cases.length, oracleInvalid }));
  process.exitCode = failed ? 1 : 0;
} finally {
  local.stop(true);
  external.stop(true);
}
