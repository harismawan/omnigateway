#!/usr/bin/env bun
/** Black-box body capture. Run through body-capture-ns.sh: no external network.
 * Only request UUIDs and generated times are variable.
 * Both encrypted corpora are opened by the unchanged frozen artifact reader.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { readArtifact } from "../../packages/store/src/bodies/artifact.ts";
import { boundValue } from "../../packages/store/src/bodies/bound.ts";
import { maskSecrets } from "../../packages/store/src/bodies/mask.ts";
import { deriveKey, encrypt } from "../../packages/store/src/encryption.ts";
import { canonical } from "./body-capture-normalize.ts";

const { values: f } = parseArgs({
  options: Object.fromEntries(
    ["ts", "rust", "scratch", "cert", "key"].map((k) => [k, { type: "string" as const }]),
  ),
});
for (const k of ["ts", "rust", "scratch", "cert", "key"]) if (!f[k]) throw Error(`--${k} required`);
const work = resolve(f.scratch!);
mkdirSync(work, { recursive: true }); // Driver owns its scratch, including direct invocations.
const seed = join(work, "seed");
mkdirSync(seed);
mkdirSync(join(work, "home"));
const repo = resolve(import.meta.dir, "../..");
// Explicit allowlist, never spread process.env (in particular never inherit OMNI_*).
const env = {
  HOME: join(work, "home"),
  CARGO_HOME: "/home/homebrew/.cargo",
  PATH: "/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin",
  NODE_EXTRA_CA_CERTS: resolve(f.cert!),
  SSL_CERT_FILE: resolve(f.cert!),
  OMNI_ENCRYPTION_KEY: "body-capture-e2e-key-012345678901234567",
  OMNI_DB_PATH: join(seed, "omnigateway.db"),
  OMNI_ROOT: seed,
  OMNI_HOST: "127.0.0.1",
  OMNI_LOG_LEVEL: "warn",
  OMNI_STATIC_DIR: join(work, "absent"),
};
async function cli(args: string[], stdin?: string) {
  const p = Bun.spawn(
    ["bun", "--no-env-file", "apps/cli/src/index.ts", "--root", seed, "--json", ...args],
    {
      cwd: repo,
      env,
      stdin: stdin ? new TextEncoder().encode(stdin) : "ignore",
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
await cli(["credentials", "add-key", "anthropic", "--label", "fixture"], "provider-secret\n");
await Bun.write(
  join(seed, "model.json"),
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
await cli(["models", "put", "test-model", "-f", join(seed, "model.json")]);
const apiKey = (await cli(["keys", "create", "--label", "capture"])).key;
const optKey = await cli(["keys", "create", "--label", "opt-out"]);
const fieldKey = await deriveKey(env.OMNI_ENCRYPTION_KEY);
const passwords = { admin: "body-admin-password", viewer: "body-viewer-password" };
{
  const db = new Database(env.OMNI_DB_PATH);
  db.run("UPDATE api_keys SET body_logging_opt_out=1 WHERE id=?", [optKey.id]);
  for (const role of ["admin", "viewer"] as const)
    db.run("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)", [
      `${role}PasswordHash`,
      await Bun.password.hash(passwords[role], {
        algorithm: "argon2id",
        memoryCost: 4096,
        timeCost: 1,
      }),
    ]);
  db.close();
}
const secret = "sk-bodySecret123456789";
const headerSecret = "header-only-secret-123";
const sse = (text: string) =>
  'event: message_start\ndata: {"message":{"id":"msg_fixed","model":"claude-opus-5-5","usage":{"input_tokens":10}}}\n\n' +
  'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n' +
  `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text } })}\n\n` +
  'event: content_block_stop\ndata: {"index":0}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {}\n\n';
type Cell = { name: string; path: string; stream: boolean; gate: string; special?: string };
const cells: Cell[] = [];
for (const path of ["chat/completions", "messages", "responses"])
  for (const stream of [false, true])
    for (const gate of ["on", "opt-out", "setting-off", "env-off"])
      cells.push({ name: `${path.replaceAll("/", "-")}-${stream}-${gate}`, path, stream, gate });
for (const special of [
  "delayed-tail",
  "held-tail",
  "shutdown-tail",
  "string-bound",
  "artifact-omission",
  "retry",
  "abandon",
])
  cells.push({
    name: special,
    path: "messages",
    stream: special === "abandon",
    gate: "on",
    special,
  });
let active: Cell;
let inference = 0;
let refresh = 0;
let drained = false;
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 443,
  idleTimeout: 0,
  tls: { cert: Bun.file(f.cert!), key: Bun.file(f.key!) },
  async fetch(req) {
    await req.text();
    if (new URL(req.url).pathname === "/v1/oauth/token") {
      refresh++;
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        account: { email_address: "new@example.com" },
      });
    }
    if (new URL(req.url).pathname !== "/v1/messages") return Response.json({}); // boot quota probe
    inference++;
    if (active.special === "retry" && inference === 1)
      return Response.json(
        { error: { type: "authentication_error", message: "retry fixture" } },
        { status: 401 },
      );
    const bytes = new TextEncoder().encode(sse(`hello ${secret}`));
    if (active.special?.endsWith("-tail")) {
      const delay = active.special === "delayed-tail" ? 1000 : 60000;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            const timer = setTimeout(() => {
              try {
                controller.enqueue(new TextEncoder().encode("TAIL_AFTER_TERMINAL\n\n"));
                controller.close();
              } catch {}
            }, delay);
            timer.unref();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (active.special !== "abandon")
      return new Response(bytes, { headers: { "content-type": "text/event-stream" } });
    let offset = 0;
    const split = bytes.indexOf(10, bytes.indexOf(10) + 1) + 1;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (offset === 0) {
            controller.enqueue(bytes.slice(0, split));
            offset = split;
            return;
          }
          // Deliberately hold the provider tail until the client has seen the first frame.
          await Bun.sleep(100);
          controller.enqueue(bytes.slice(offset));
          controller.close();
          drained = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
function request(c: Cell) {
  let text = `hello ${secret}`;
  if (c.special === "string-bound") text = "x ".repeat(40000);
  const extra =
    c.special === "artifact-omission"
      ? Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, "x ".repeat(32768)]))
      : {};
  const common = { model: "test-model", stream: c.stream, max_tokens: 128, ...extra };
  if (c.path === "responses") return { ...common, input: text };
  return {
    ...common,
    messages: [
      { role: "user", content: text },
      {
        role: "assistant",
        content:
          c.path === "messages"
            ? [{ type: "tool_use", id: "tool_fixed", name: "fixture", input: { token: secret } }]
            : null,
        ...(c.path === "messages"
          ? {}
          : {
              tool_calls: [
                {
                  id: "tool_fixed",
                  type: "function",
                  function: { name: "fixture", arguments: JSON.stringify({ token: secret }) },
                },
              ],
            }),
      },
      ...(c.path === "messages"
        ? [
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "tool_fixed", content: "ok" }],
            },
          ]
        : [{ role: "tool", tool_call_id: "tool_fixed", content: "ok" }]),
    ],
    tools:
      c.path === "messages"
        ? [{ name: "fixture", input_schema: { type: "object" } }]
        : [{ type: "function", function: { name: "fixture", parameters: { type: "object" } } }],
  };
}
async function until<T>(
  read: () => Promise<T> | T,
  ready: (x: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 15000;
  do {
    const x = await read();
    if (ready(x)) return x;
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  throw Error(`deadline: ${label}`);
}
function files(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
      .sort();
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
}
let rows = 0;
function equal(label: string, a: unknown, b: unknown) {
  rows++;
  if (!isDeepStrictEqual(a, b)) {
    throw Error(`row ${rows} ${label} differs (see scratch JSON)`);
  }
}
async function run(binary: string, label: string, c: Cell, port: number) {
  active = c;
  inference = 0;
  refresh = 0;
  drained = false;
  const root = join(work, `${c.name}-${label}`);
  mkdirSync(root);
  const path = join(root, "omni.db");
  copyFileSync(env.OMNI_DB_PATH, path);
  const db = new Database(path);
  db.run("PRAGMA busy_timeout=5000");
  db.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('settings',?)", [
    JSON.stringify({
      bodyLoggingEnabled: c.gate !== "setting-off",
      bodyLoggingCaptureStreamChunks: true,
    }),
  ]);
  if (c.special === "retry")
    db.run(
      "UPDATE credentials SET auth_type='oauth',api_key=NULL,access_token=?,refresh_token=?,expires_at=4102444800000",
      [await encrypt(fieldKey, "old-access"), await encrypt(fieldKey, "old-refresh")],
    );
  const p = Bun.spawn([resolve(binary)], {
    cwd: root,
    env: {
      ...env,
      OMNI_ROOT: root,
      OMNI_DB_PATH: path,
      OMNI_PORT: String(port),
      OMNI_BODY_LOGGING_ALLOWED: c.gate === "env-off" ? "0" : "1",
    },
    stdout: Bun.file(join(root, "stdout")),
    stderr: Bun.file(join(root, "stderr")),
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await until(
      async () => {
        try {
          return (await fetch(base + "/health")).ok;
        } catch {
          return false;
        }
      },
      Boolean,
      "boot",
    );
    const res = await fetch(base + "/v1/" + c.path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.gate === "opt-out" ? optKey.key : apiKey}`,
        "content-type": "application/json",
        "x-secret": headerSecret,
      },
      body: JSON.stringify(request(c)),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status !== 200) throw Error(`${label} ${c.name}: ${res.status} ${await res.text()}`);
    let client: string;
    if (c.special === "abandon") {
      const reader = res.body!.getReader();
      const first = await reader.read();
      client = new TextDecoder().decode(first.value);
      await reader.cancel();
    } else client = await res.text();
    let exitClass: string | null = null;
    async function stop() {
      p.kill("SIGTERM");
      const prompt = await Promise.race([
        p.exited.then(() => true),
        Bun.sleep(5000).then(() => false),
      ]);
      if (!prompt) {
        p.kill("SIGKILL");
        await p.exited;
        throw Error(`${label}: shutdown exceeded 5s`);
      }
      exitClass = "under-5s";
    }
    if (c.special === "shutdown-tail") await stop();
    const on = c.gate === "on";
    await until(
      () => db.query(`SELECT * FROM ${on ? "request_bodies" : "request_logs"}`).all(),
      (x) => x.length === 1,
      `${label} ${c.name} persistence`,
    );
    const bodyRows = db
      .query<
        {
          at: number;
          size_bytes: number;
          truncated: number;
          sha256: string;
          rel_path: string;
        },
        []
      >("SELECT * FROM request_bodies")
      .all();
    const log = db.query<{ id: string }, []>("SELECT id FROM request_logs LIMIT 1").get();
    if (!log) throw Error("missing persisted request log");
    const artifacts = [];
    for (const row of bodyRows) {
      if (
        typeof row.at !== "number" ||
        typeof row.size_bytes !== "number" ||
        ![0, 1].includes(row.truncated) ||
        !/^[a-f0-9]{64}$/.test(row.sha256)
      )
        throw Error("invalid typed row");
      const read = await readArtifact(
        fieldKey,
        join(root, "request_bodies"),
        row.rel_path,
        row.sha256,
      );
      if (!read.ok) throw Error(`frozen reader rejected ${label}: ${read.failure}`);
      const plain = JSON.stringify(read.artifact);
      if (plain.includes(secret) || plain.includes(headerSecret)) throw Error("secret leaked");
      if (
        c.special === "string-bound" &&
        (!read.artifact.client.truncated || plain.includes("x ".repeat(32769)))
      )
        throw Error("64 KiB string was not bounded");
      const request = read.artifact.client.request;
      if (
        c.special === "artifact-omission" &&
        (!request ||
          typeof request !== "object" ||
          !("omitted" in request) ||
          !request.omitted ||
          !read.artifact.client.truncated)
      )
        throw Error("512 KiB artifact not omitted");
      if (!c.special) {
        // Pin capture to independently received bytes, not just gateway-vs-gateway.
        const captured = read.artifact.client.response;
        if (c.stream) {
          const wireFrames = boundValue(maskSecrets(client.split("\n\n").filter(Boolean))).value;
          if (!isDeepStrictEqual(captured, wireFrames))
            throw Error("captured client frames differ from wire");
        } else {
          const wire = boundValue(maskSecrets(JSON.parse(client))).value;
          if (!isDeepStrictEqual(captured, wire))
            throw Error("captured client response differs from wire");
        }
      }
      if (c.special === "retry" && (read.artifact.attempts.length !== 2 || refresh !== 1))
        throw Error("retry must capture two inference attempts, not refresh");
      if (
        c.special?.endsWith("-tail") &&
        (!row.truncated ||
          !read.artifact.attempts[0]?.truncated ||
          plain.includes("TAIL_AFTER_TERMINAL"))
      )
        throw Error("terminal drain must abort with partial bytes");
      if (
        c.special === "abandon" &&
        (!drained || !JSON.stringify(read.artifact.attempts).includes("message_stop"))
      )
        throw Error("tee failed to drain abandoned provider");
      artifacts.push(read.artifact);
    }
    const routes = [];
    for (const role of (c.special === "shutdown-tail" ? [] : ["admin", "viewer", "none"]) as (
      | "admin"
      | "viewer"
      | "none"
    )[]) {
      let cookie = "";
      if (role !== "none") {
        const login = await fetch(base + "/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            password: passwords[role],
            ...(role === "viewer" ? { mode: "viewer" } : {}),
          }),
        });
        if (!login.ok) throw Error("login failed");
        cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      }
      for (const id of ["absent", log.id]) {
        const r = await fetch(base + `/api/requests/${id}/body`, {
          headers: cookie ? { cookie } : {},
        });
        routes.push({
          role,
          present: id !== "absent",
          status: r.status,
          type: r.headers.get("content-type"),
          cache: r.headers.get("cache-control"),
          body: await r.json(),
        });
      }
    }
    if (exitClass === null) await stop();
    const layout = files(join(root, "request_bodies"));
    if (!on && (layout.length || db.query("SELECT * FROM request_bodies").all().length))
      throw Error("OFF wrote bodies");
    // Ciphertext digest is independently verified above; random nonces make it unequal.
    const typedRows = bodyRows.map(({ sha256, ...row }) => row);
    return {
      requestId: log.id,
      typedRows,
      artifacts,
      layout,
      routes,
      exitClass,
      client: c.special === "abandon" ? null : client,
    };
  } finally {
    p.kill("SIGTERM");
    await p.exited;
    db.close();
  }
}
try {
  for (const c of cells) {
    const ts = await run(f.ts!, "ts", c, 18491);
    const rust = await run(f.rust!, "rust", c, 18492);
    await Bun.write(join(work, `${c.name}.json`), JSON.stringify({ ts, rust }, null, 2));
    const a = canonical(ts, ts.requestId),
      b = canonical(rust, rust.requestId);
    for (const k of ["typedRows", "artifacts", "layout", "routes", "client", "exitClass"] as const)
      equal(`${c.name}/${k}`, a[k], b[k]);
    console.log(`equal ${c.name} (6 rows)`);
  }
  console.log(`${rows} equal / 0 failed; ${cells.length} cells; scratch ${work}`);
} finally {
  stub.stop(true);
}
