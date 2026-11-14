#!/usr/bin/env bun
/**
 * Conformance for `/metrics`, static dashboard serving and the plugin
 * routes: the TS gateway binary and the Rust one, each on its own copy of one
 * CLI-seeded root, each with the same dashboard directory and the same plugin
 * directory, both pointed at one scripted upstream. Every exchange is raw
 * HTTP/1.1 over a socket (no client-side path normalization), compared as
 * status, headers (names lowercased, order kept) and body bytes.
 *
 *   bun scripts/build-binary.ts /tmp/opencode/a1-a2/bin/ts-omnigateway
 *   cargo build --release -p omni-gateway
 *   bun conformance/e2e/surface.ts --ts /tmp/opencode/a1-a2/bin/ts-omnigateway \
 *     --rust target/release/omnigateway --out /tmp/opencode/a1-a2/surface
 *
 * Headers are compared as `run.ts` compares them: sorted by name, values
 * exact. Every request here asks `connection: close` (so a response's end is
 * the socket's end); hyper echoes `connection: close` on such a response and
 * Bun does not, so that one header with that one value is dropped.
 *
 * Masks (all validated; anything that fails validation is compared raw):
 * - header `date`: an IMF date within ±120 s of now;
 * - `/health`'s `nodeId`: a v4 uuid;
 * - `/metrics` 200 GET: `content-length`, after checking it equals the
 *   received body's length (it varies with the masked values' digits); on
 *   HEAD, after checking it is a positive integer;
 * - `/metrics` after traffic: the value of `*_sum` samples and of
 *   `*_bucket` samples of the three timing histograms
 *   (`omni_request_duration_seconds`, `omni_ttft_seconds`,
 *   `omni_upstream_duration_seconds`), each a finite non-negative number,
 *   the buckets of one series non-decreasing and ending at its `_count`.
 *   Series names, labels, `_count`, the `+Inf` bucket and every other sample
 *   are compared exactly.
 *
 * Divergences, each asserted exactly (an expected-divergence row passes only
 * if both exchanges succeeded, TS's answer has the stated status, and Rust's
 * is the stated answer byte for byte; a transport error is never equal and
 * never an expected divergence):
 * - hyper refuses a request-target containing `<`, `>` or `` ` `` with a bare
 *   400 before any route; Bun rewrites and answers it. (Backslashes do reach
 *   the router and compare equal.)
 * - the spec's plugin 501, where TS answers from its live plugin surface;
 * - a directory: Rust gives Bun's production 500, TS without `NODE_ENV` its
 *   development stack page (compared equal against production TS);
 * - fix round 1 (A2 I1, a security divergence): a dashboard `index.html` that
 *   links outside the root is never served; TS serves the outside file for
 *   any missing navigation route.
 */
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";

const { values: flags } = parseArgs({
  options: {
    ts: { type: "string" },
    rust: { type: "string" },
    cli: { type: "string", default: "bun apps/cli/src/index.ts" },
    out: { type: "string" },
    only: { type: "string" },
  },
});
if (flags.ts === undefined || flags.rust === undefined) {
  console.error("usage: surface.ts --ts <binary> --rust <binary> [--out dir]");
  process.exit(2);
}

const REPO = resolve(import.meta.dir, "../..");
const KEY = "conformance-surface-encryption-key-0123456";
const UPSTREAM_PORT = 18431;
const PORT = 18432;
const TOKEN = "metrics-token-xyz";
mkdirSync("/tmp/opencode", { recursive: true });
const work = mkdtempSync("/tmp/opencode/omni-surface-");
// Equal isolated executable layouts: default dashboard discovery must not
// accidentally resolve apps/dashboard/dist in the developer's checkout.
const binaries = Object.fromEntries(
  (["ts", "rust"] as const).map((side) => {
    const dir = join(work, side, "install", "bin");
    mkdirSync(dir, { recursive: true });
    const binary = join(dir, "omnigateway");
    copyFileSync(resolve(REPO, flags[side] as string), binary);
    return [side, binary];
  }),
);
const out = flags.out ?? join(work, "out");
mkdirSync(out, { recursive: true });
const children: Subprocess[] = [];
process.on("exit", () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ upstream

const frame = (model: string, choice: string) =>
  `data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[${choice}]}\n\n`;
const chunk = (s: string) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`;
function answer(model: string): string | null {
  // Reads the request and never answers: only cancellation ends the attempt.
  if (model === "silent") return null;
  if (model === "fail500") {
    const b = '{"error":{"message":"boom"}}';
    return `HTTP/1.1 500 X\r\ncontent-type: application/json\r\ncontent-length: ${b.length}\r\nConnection: keep-alive\r\n\r\n${b}`;
  }
  const parts = [
    frame(model, '{"index":0,"delta":{"role":"assistant","content":""}}'),
    frame(model, '{"index":0,"delta":{"content":"hi"}}'),
    frame(model, '{"index":0,"delta":{},"finish_reason":"stop"}'),
    `data: {"id":"chatcmpl-s","model":"${model}","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n`,
    "data: [DONE]\n\n",
  ];
  return `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nConnection: keep-alive\r\ntransfer-encoding: chunked\r\n\r\n${parts.map(chunk).join("")}0\r\n\r\n`;
}
Bun.listen<{ buf: Buffer }>({
  hostname: "127.0.0.1",
  port: UPSTREAM_PORT,
  socket: {
    open(s) {
      s.data = { buf: Buffer.alloc(0) };
    },
    data(s, d) {
      s.data.buf = Buffer.concat([s.data.buf, d]);
      for (;;) {
        const end = s.data.buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = s.data.buf.subarray(0, end).toString("latin1");
        const len = Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? 0);
        if (s.data.buf.length < end + 4 + len) return;
        const body = s.data.buf.subarray(end + 4, end + 4 + len).toString("latin1");
        s.data.buf = s.data.buf.subarray(end + 4 + len);
        const reply = answer(/"model":"([^"]*)"/.exec(body)?.[1] ?? "");
        if (reply !== null) s.write(reply);
      }
    },
  },
});

// ------------------------------------------------------------ seeding

const seedRoot = join(work, "seed");
mkdirSync(seedRoot);
const env = {
  ...process.env,
  OMNI_ENCRYPTION_KEY: KEY,
  OMNI_HOST: "127.0.0.1",
  OMNI_PORT: String(PORT),
  OMNI_LOG_LEVEL: "info",
  OMNI_DAY_OFFSET_MINUTES: "0",
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
  const [o, e, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`omni ${args.join(" ")}: ${e}`);
  return JSON.parse(o);
}
async function seed(): Promise<Record<string, string>> {
  writeFileSync(
    join(seedRoot, ".env"),
    `OMNI_ENCRYPTION_KEY=${KEY}\nOMNI_DB_PATH=${join(seedRoot, "omni.db")}\n`,
  );
  const ids: Record<string, string> = {};
  for (const e of ["ok", "bad"]) {
    ids[e] = (
      await cli(
        [
          "credentials",
          "add-key",
          "custom",
          "--label",
          `c-${e}`,
          "--endpoint-id",
          e,
          "--endpoint-label",
          e,
          "--origin",
          `http://127.0.0.1:${UPSTREAM_PORT}`,
          "--protocol",
          "chat-completions",
        ],
        `sk-up-${e}\n`,
      )
    ).id;
  }
  const t = (endpointId: string, model: string, tier: number) => ({
    provider: "custom",
    endpointId,
    model,
    tier,
    weight: 1,
    costPerMTok: { input: 1, output: 2 },
    capabilities: { tools: true, images: true, reasoning: true },
  });
  const models: Record<string, unknown[]> = {
    ok: [t("ok", "ok", 1)],
    "other-model": [t("ok", "ok", 1)],
    "fo-500": [t("bad", "fail500", 1), t("ok", "ok", 2)],
    dead: [t("bad", "fail500", 1)],
    silent: [t("ok", "silent", 1)],
  };
  for (const [id, targets] of Object.entries(models)) {
    const file = join(seedRoot, `${id}.json`);
    writeFileSync(file, JSON.stringify({ id, strategy: "priority", isAlias: false, targets }));
    await cli(["models", "put", id, "-f", file]);
  }
  const keys: Record<string, string> = {};
  for (const l of ["k1", "k2", "k3", "k4"])
    keys[l] = (await cli(["keys", "create", "--label", l])).key;
  keys.lim = (await cli(["keys", "create", "--label", "lim", "--limit", "requests:1m=1"])).key;
  keys.lim5h = (await cli(["keys", "create", "--label", "lim5h", "--limit", "tokens:5h=1"])).key;
  return keys;
}

// ------------------------------------------------------------ dashboard fixture

function dashboard(dir: string, outside: string): void {
  mkdirSync(join(dir, "assets/sub"), { recursive: true });
  mkdirSync(join(dir, "shared"), { recursive: true });
  mkdirSync(join(dir, "dirx"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>omni</title><div id=root></div>\n");
  writeFileSync(join(dir, "assets/app-abc123.js"), "console.log('omni');\n");
  writeFileSync(join(dir, "assets/app.css"), "body{margin:0}\n");
  writeFileSync(join(dir, "assets/sub/font.woff2"), "wOF2fake");
  writeFileSync(join(dir, "assets/empty.js"), "");
  writeFileSync(join(dir, "shared/react.js"), "export default 1;\n");
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>\n");
  writeFileSync(join(dir, "plain.txt"), "hello world\n");
  writeFileSync(join(dir, "empty.txt"), "");
  writeFileSync(join(dir, "data.json"), '{"a":1}\n');
  writeFileSync(join(dir, "noext"), "binary?");
  writeFileSync(join(dir, "doc.pdf"), "%PDF-1.4");
  writeFileSync(join(dir, "feed.xml"), "<x/>");
  writeFileSync(join(dir, "a.png"), "\x89PNG");
  writeFileSync(join(dir, "ü.txt"), "umlaut");
  writeFileSync(join(dir, "sp ace.txt"), "space");
  writeFileSync(join(dir, "UPPER.HTML"), "<p>upper</p>");
  writeFileSync(join(dir, "page.htm"), "<p>htm</p>");
  writeFileSync(join(dir, ".hidden"), "dot");
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(200_000, 7));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
  symlinkSync(join(outside, "secret.txt"), join(dir, "escape.txt"));
  symlinkSync(outside, join(dir, "escapedir"));
  symlinkSync("plain.txt", join(dir, "inlink.txt"));
  // Relative, so it stays inside each run's copy of the fixture.
  symlinkSync("assets", join(dir, "assetlink"));
  symlinkSync(join(dir, "missing-target"), join(dir, "dangling.txt"));
}

/** A dashboard whose `index.html` links outside its root (A2 I1). */
function escapingDashboard(dir: string): void {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets/app.js"), "x");
  symlinkSync("../outside/secret.txt", join(dir, "index.html"));
}

function plugins(root: string): void {
  // Two directories without manifests, a plain file, a symlink to a plugin
  // directory, and `gamma`: a valid plugin whose `setup` writes a marker file
  // beside it. TS loads gamma (and runs setup); Rust must warn once per real
  // directory (alpha, beta, gamma), ignore the file and the symlink, and never
  // run setup — the marker must not exist after a Rust run.
  mkdirSync(join(root, "plugins/alpha"), { recursive: true });
  mkdirSync(join(root, "plugins/beta"), { recursive: true });
  mkdirSync(join(root, "plugins/gamma"), { recursive: true });
  writeFileSync(join(root, "plugins/README"), "not a plugin");
  symlinkSync("alpha", join(root, "plugins/zlink"));
  writeFileSync(
    join(root, "plugins/gamma/omni-plugin.json"),
    JSON.stringify({ id: "gamma", name: "Gamma", version: "1.0.0", api: 3, server: "server.js" }),
  );
  writeFileSync(
    join(root, "plugins/gamma/server.js"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "export default {",
      "  setup() {",
      '    writeFileSync(join(import.meta.dir, "setup-ran"), "ran");',
      "    return { routes: [] };",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

// ------------------------------------------------------------ raw HTTP

type Ex = { status: number; head: [string, string][]; body: Buffer };

function raw(
  target: string,
  method = "GET",
  headers: [string, string][] = [],
  body = "",
  abortAfterMs?: number,
): Promise<Ex> {
  return new Promise((res, rej) => {
    const s = connect(PORT, "127.0.0.1");
    let aborted = false;
    if (abortAfterMs !== undefined)
      setTimeout(() => {
        // Resolved first: `destroy` emits `close`, which must not resolve
        // with whatever partial answer had arrived.
        aborted = true;
        res({ status: -1, head: [], body: Buffer.from("aborted") });
        s.destroy();
      }, abortAfterMs);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      s.destroy();
      rej(new Error(`timeout ${method} ${target}`));
    }, 10_000);
    s.on("data", (d) => chunks.push(d));
    s.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    s.on("close", () => {
      clearTimeout(timer);
      if (aborted) return;
      const all = Buffer.concat(chunks);
      const end = all.indexOf("\r\n\r\n");
      if (end < 0) return res({ status: 0, head: [], body: all });
      const lines = all.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(lines[0]?.split(" ")[1] ?? 0);
      const head = lines.slice(1).map((l): [string, string] => {
        const i = l.indexOf(":");
        return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()];
      });
      let rest = all.subarray(end + 4);
      if (head.some(([k, v]) => k === "transfer-encoding" && v === "chunked")) {
        const parts: Buffer[] = [];
        for (;;) {
          const nl = rest.indexOf("\r\n");
          if (nl < 0) break;
          const n = Number.parseInt(rest.subarray(0, nl).toString(), 16);
          if (!(n > 0)) break;
          parts.push(rest.subarray(nl + 2, nl + 2 + n));
          rest = rest.subarray(nl + 2 + n + 2);
        }
        rest = Buffer.concat(parts);
      }
      res({ status, head, body: rest });
    });
    const h = headers.map(([k, v]) => `${k}: ${v}\r\n`).join("");
    const len =
      body.length > 0 || method === "POST" ? `content-length: ${Buffer.byteLength(body)}\r\n` : "";
    s.write(
      Buffer.from(
        `${method} ${target} HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\nconnection: close\r\n${h}${len}\r\n${body}`,
        "utf8",
      ),
    );
  });
}

// ------------------------------------------------------------ masks

const NODE = /"nodeId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/;
const TIMED =
  /^(omni_request_duration_seconds|omni_ttft_seconds|omni_upstream_duration_seconds)_(bucket|sum)(\{.*\})? (\S+)$/;

/** Masks timing samples after validating them; throws on anything unexpected. */
function maskMetrics(text: string): string {
  const series = new Map<string, { buckets: number[]; count?: number; inf?: number }>();
  const lines = text.split("\n").map((line) => {
    const m = TIMED.exec(line);
    const countM =
      /^(omni_(?:request_duration|ttft|upstream_duration)_seconds)_count(\{.*\})? (\S+)$/.exec(
        line,
      );
    if (countM) {
      const key = `${countM[1]}${countM[2] ?? ""}`;
      const s = series.get(key) ?? { buckets: [] };
      s.count = Number(countM[3]);
      series.set(key, s);
      return line;
    }
    if (m === null) return line;
    const value = Number(m[4]);
    if (!(Number.isFinite(value) && value >= 0))
      throw new Error(`timing sample not a non-negative number: ${line}`);
    if (m[2] === "sum") return `${m[1]}_sum${m[3] ?? ""} <t>`;
    const labels = m[3] ?? "";
    if (labels.includes('le="+Inf"')) {
      const key = `${m[1]}${labels.replace(/,?le="\+Inf"/, "").replace("{}", "")}`;
      const s = series.get(key) ?? { buckets: [] };
      s.inf = value;
      series.set(key, s);
      return line; // compared exactly: it is the count
    }
    const key = `${m[1]}${labels.replace(/,?le="[^"]*"/, "").replace("{}", "")}`;
    const s = series.get(key) ?? { buckets: [] };
    s.buckets.push(value);
    series.set(key, s);
    return `${m[1]}_bucket${labels} <n>`;
  });
  for (const [key, s] of series) {
    for (let i = 1; i < s.buckets.length; i++)
      if ((s.buckets[i] as number) < (s.buckets[i - 1] as number))
        throw new Error(`${key}: buckets decrease`);
    if (s.buckets.length !== 13) throw new Error(`${key}: ${s.buckets.length} finite buckets`);
    if (s.inf !== s.count) throw new Error(`${key}: +Inf ${s.inf} != count ${s.count}`);
    if ((s.buckets.at(-1) as number) > (s.count as number))
      throw new Error(`${key}: bucket above count`);
  }
  return lines.join("\n");
}

function normalize(x: Ex, kind: "plain" | "metrics" | "metrics-head" | "health"): string {
  const now = Date.now() / 1000;
  const head = x.head
    .filter(([k, v]) => !(k === "connection" && v === "close"))
    .map(([k, v]) => {
      if (k === "date" && Math.abs(Date.parse(v) / 1000 - now) < 120) return `${k}: <date>`;
      return `${k}: ${v}`;
    })
    .sort();
  let body = x.body.toString("latin1");
  if (kind === "health") body = body.replace(NODE, '"nodeId":"<node>"');
  if (kind === "metrics" && x.status === 200 && x.body.length > 0) {
    // The masked timing values' digit counts differ run to run, so the
    // length is checked against the body it frames, then masked.
    const len = x.head.find(([k]) => k === "content-length")?.[1];
    if (len !== String(x.body.length))
      throw new Error(`metrics content-length ${len} != ${x.body.length}`);
    body = maskMetrics(body);
    return `${x.status}\n${head.map((h) => (h.startsWith("content-length: ") ? "content-length: <len>" : h)).join("\n")}\n\n${body}`;
  }
  if (kind === "metrics-head" && x.status === 200 && x.body.length === 0) {
    const len = x.head.find(([k]) => k === "content-length")?.[1] ?? "";
    if (!/^[1-9]\d{0,6}$/.test(len)) throw new Error(`metrics HEAD content-length ${len}`);
    return `${x.status}\n${head.map((h) => (h.startsWith("content-length: ") ? "content-length: <len>" : h)).join("\n")}\n\n`;
  }
  return `${x.status}\n${head.join("\n")}\n\n${body}`;
}

// ------------------------------------------------------------ the matrix

type Row = {
  name: string;
  /** Compared on status alone (bodies carry ids `run.ts` masks and checks). */
  statusOnly?: boolean;
  /** Hang up this long after sending; the row records `aborted`. */
  abortAfterMs?: number;
  /** Wait before sending (lets a cancelled attempt settle). */
  settleMs?: number;
  /** The divergence is the spec's: the Rust answer must be exactly this. */
  rust?: string;
  target: string;
  method?: string;
  headers?: [string, string][];
  body?: string;
  kind?: "plain" | "metrics" | "metrics-head" | "health";
  /** An asserted divergence: why, TS's status, and Rust's exact answer. */
  expectDiff?: string;
  tsStatus?: number;
  rustExact?: string;
};
const html: [string, string] = ["accept", "text/html,application/xhtml+xml"];
/** hyper's answer to a request-target it refuses: no body, no date. */
const HYPER_400 = "400\ncontent-length: 0\n\n";
/** Bun's production-mode 500 for a file response that is a directory. */
const DIR_500 = (head: boolean) =>
  `500\ncontent-length: 21\ncontent-type: text/plain${head ? "" : "\ndate: <date>"}\n\n${head ? "" : "Something went wrong!"}`;
/** TS's 404 for an unrouted GET of `path`. */
const notFound = (path: string, head = false) => {
  const b = `{"error":{"code":"NOT_FOUND","message":"no route for ${path}"}}`;
  return `404\ncontent-length: ${b.length}\ncontent-type: application/json;charset=utf-8${head ? "" : "\ndate: <date>"}\n\n${head ? "" : b}`;
};
const auth: [string, string] = ["authorization", `Bearer ${TOKEN}`];

function staticRows(prefix: string): Row[] {
  const rows: Row[] = [
    { name: `${prefix}client login invalid key`, target: "/api/client/login", method: "POST", headers: [["content-type", "application/json"]], body: '{"key":"unknown"}' },
    { name: `${prefix}client logout anonymous`, target: "/api/client/logout", method: "POST" },
  ];
  const add = (target: string, extra: Partial<Row> = {}) =>
    rows.push({
      name: `${prefix}${extra.method ?? "GET"} ${target}${extra.headers?.length ? ` ${JSON.stringify(extra.headers)}` : ""}`,
      target,
      ...extra,
    });
  for (const t of [
    "/",
    "/index.html",
    "/assets/app-abc123.js",
    "/assets/app.css",
    "/assets/sub/font.woff2",
    "/assets/empty.js",
    "/shared/react.js",
    "/favicon.svg",
    "/plain.txt",
    "/empty.txt",
    "/data.json",
    "/noext",
    "/doc.pdf",
    "/feed.xml",
    "/a.png",
    "/%C3%BC.txt",
    "/sp%20ace.txt",
    "/UPPER.HTML",
    "/page.htm",
    "/.hidden",
    "/big.bin",
    "/inlink.txt",
    "/assetlink/app.css",
    "/dangling.txt",
    "/plain.txt?x=1&y=%2f",
    "/plain.txt/",
    "/index.html/",
    "//plain.txt",
    "/assets//app.css",
  ]) {
    add(t);
    add(t, { headers: [html] });
  }
  for (const t of [
    "/nested/route",
    "/a/b/c/d",
    "/settings?tab=keys",
    "/missing.js",
    "/assets/missing.js",
    "/api",
    "/api/",
    "/api/x",
    "/api/nope/deeper",
    "/v1",
    "/v1/",
    "/v1/nope",
    "/apix",
    "/v1x",
    "/oauth/cb",
    "/plugin-assets",
    "/plugin-assets/",
    "/plugin-assets/foo",
    "/plugin-assets/foo/",
    "/plugin-assets/foo/x.js",
    "/plugin-assets//x",
    "/metrics/",
    "/health/",
    "/Metrics",
    "/.hidden/x",
  ]) {
    add(t);
    add(t, { headers: [html] });
  }
  // Traversal and encodings.
  for (const t of [
    "/../../etc/passwd",
    "/a/../plain.txt",
    "/a/./plain.txt",
    "/assets/../plain.txt",
    "/x/..",
    "/x/.",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/%2E%2E/plain.txt",
    "/.%2e/plain.txt",
    "/x/%2e%2e/plain.txt",
    "/%252e%252e/etc/passwd",
    "/..%2fetc%2fpasswd",
    "/..%2Fplain.txt",
    "/a%2fb",
    "/a%5cb",
    "/..%5c..%5cetc",
    "/%2e%2e%2f%2e%2e%2fetc",
    "/escape.txt",
    "/escapedir/secret.txt",
    "/escapedir",
    "/assets/../escape.txt",
    "/%",
    "/%zz",
    "/a%2",
    "/%E0%A4%A",
    "/%C0%AF",
    "/%ED%A0%80",
    "/%00",
    "/%FF.txt",
    "/plain%2etxt",
    "/x/../api/x",
    "/x/%2e%2e/api/nope",
    "/%61pi/x",
    "/api%2fx",
    "/x/../v1/nope",
    "/a{b}",
    '/a"b',
    "/a^b",
    "/a|b",
    "/a[b]",
    "/a~b",
    "/a'b",
  ]) {
    add(t);
    add(t, { headers: [html] });
  }
  for (const t of ["/a\\b", "/..\\..\\etc\\passwd", "/assets\\app.css", "/x\\..\\plain.txt"]) {
    add(t);
    add(t, { headers: [html] });
  }
  add("/\u00fc", { headers: [html] });
  for (const t of ["/a<b>", "/a`b"]) {
    add(t, {
      headers: [html],
      expectDiff: "hyper refuses a request-target Bun rewrites (400)",
      tsStatus: prefix === "nodir " ? 404 : 200,
      rustExact: HYPER_400,
    });
  }
  // HEAD, ranges, conditionals, other methods.
  for (const t of [
    "/",
    "/plain.txt",
    "/noext",
    "/doc.pdf",
    "/nested/route",
    "/missing.js",
    "/escape.txt",
  ]) {
    add(t, { method: "HEAD", headers: [html] });
  }
  for (const r of [
    "bytes=0-0",
    "bytes=2-",
    "bytes=-3",
    "bytes=100-",
    "bytes=0-0,2-2",
    "bytes=x",
    "Bytes = 1-2",
    "bytes=-0",
    "bytes=5-2",
  ]) {
    add("/plain.txt", { headers: [["range", r]] });
    add("/doc.pdf", { headers: [["range", r]] });
  }
  add("/plain.txt", { method: "HEAD", headers: [["range", "bytes=0-0"]] });
  add("/plain.txt", {
    headers: [
      ["range", "bytes=0-0"],
      ["if-range", '"etag"'],
    ],
  });
  add("/nested", { headers: [html, ["range", "bytes=0-3"]] });
  add("/big.bin", { headers: [["range", "bytes=65530-65545"]] });
  add("/plain.txt", { headers: [["if-none-match", "*"]] });
  add("/plain.txt", { headers: [["if-modified-since", "Wed, 01 Jan 2099 00:00:00 GMT"]] });
  add("/plain.txt", { method: "POST" });
  add("/plain.txt", { method: "PUT" });
  add("/nested", { method: "DELETE", headers: [html] });
  add("/", { headers: [["accept", "application/json"]] });
  add("/nested", { headers: [["accept", "text/htm"]] });
  add("/nested", { headers: [["accept", "TEXT/HTML"]] });
  add("/nested", {
    headers: [
      ["accept", "a"],
      ["accept", "text/html"],
    ],
  });
  return rows;
}

/** Spec (non-goals, Plugins): HTTP 501 with the usual `/api` error body. */
const UNSUPPORTED =
  '{"error":{"code":"UNSUPPORTED","message":"plugins are not supported in this release"}}';
const unsupported = (head: boolean) =>
  `501\ncontent-length: ${UNSUPPORTED.length}\ncontent-type: application/json;charset=utf-8${head ? "" : "\ndate: <date>"}\n\n${head ? "" : UNSUPPORTED}`;
const pluginRows: Row[] = [
  ...[
    "/api/plugins",
    "/api/plugins/",
    "/api/plugins/alpha",
    "/api/plugins/alpha/x/y",
    "/x/../api/plugins",
    "/api/plugins?x=1",
  ].flatMap((t): Row[] =>
    ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"].map((m) => ({
      name: `plugins ${m} ${t}`,
      target: t,
      method: m,
      rust: unsupported(m === "HEAD"),
    })),
  ),
  // Not plugin routes: compared with TS exactly.
  { name: "plugins GET /api/pluginsx", target: "/api/pluginsx" },
  { name: "plugins POST /api/pluginsx", target: "/api/pluginsx", method: "POST" },
];
/** TS answers a directory with Bun's 500; in production mode, its plain one. */
const directoryRows: Row[] = [
  "/dirx",
  "/dirx/",
  "/assets",
  "/assets/",
  "/shared/",
  "/assetlink",
].flatMap((t): Row[] => [
  { name: `dir GET ${t}`, target: t },
  { name: `dir GET ${t} html`, target: t, headers: [html] },
  { name: `dir HEAD ${t}`, target: t, method: "HEAD" },
]);

const metricsRows = (stage: string): Row[] => [
  { name: `${stage} metrics ok`, target: "/metrics", headers: [auth], kind: "metrics" },
  { name: `${stage} metrics query`, target: "/metrics?x=1", headers: [auth], kind: "metrics" },
  {
    name: `${stage} metrics HEAD`,
    target: "/metrics",
    method: "HEAD",
    headers: [auth],
    kind: "metrics-head",
  },
  { name: `${stage} metrics none`, target: "/metrics" },
  {
    name: `${stage} metrics wrong`,
    target: "/metrics",
    headers: [["authorization", `Bearer ${TOKEN}x`]],
  },
  { name: `${stage} metrics short`, target: "/metrics", headers: [["authorization", "Bearer "]] },
  {
    name: `${stage} metrics lower`,
    target: "/metrics",
    headers: [["authorization", `bearer ${TOKEN}`]],
  },
  {
    name: `${stage} metrics basic`,
    target: "/metrics",
    headers: [["authorization", `Basic ${TOKEN}`]],
  },
  { name: `${stage} metrics twice`, target: "/metrics", headers: [auth, auth] },
  { name: `${stage} metrics POST`, target: "/metrics", method: "POST", headers: [auth] },
  { name: `${stage} metrics slash`, target: "/metrics/", headers: [auth], kind: "metrics" },
  { name: `${stage} metrics dotdot`, target: "/x/../metrics", headers: [auth], kind: "metrics" },
];

/** Deterministic traffic: every path that records a metric today. */
function traffic(keys: Record<string, string>): Row[] {
  const chat = (model: string, stream: boolean) =>
    JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] });
  const msg = (model: string, stream: boolean) =>
    JSON.stringify({ model, max_tokens: 8, stream, messages: [{ role: "user", content: "hi" }] });
  const b = (k: string): [string, string][] => [
    ["authorization", `Bearer ${k}`],
    ["content-type", "application/json"],
  ];
  const rows: Row[] = [];
  const post = (name: string, target: string, k: string, body: string) =>
    rows.push({
      name: `traffic ${name}`,
      target,
      method: "POST",
      headers: b(k),
      body,
      statusOnly: true,
    });
  post("chat stream k1", "/v1/chat/completions", keys.k1 as string, chat("ok", true));
  post("chat buffered k1", "/v1/chat/completions", keys.k1 as string, chat("ok", false));
  post("messages stream k2", "/v1/messages", keys.k2 as string, msg("ok", true));
  post("messages buffered k3", "/v1/messages", keys.k3 as string, msg("other-model", false));
  post(
    "responses k4",
    "/v1/responses",
    keys.k4 as string,
    JSON.stringify({ model: "ok", input: "hi" }),
  );
  post("failover k1", "/v1/chat/completions", keys.k1 as string, chat("fo-500", false));
  post("dead k2", "/v1/chat/completions", keys.k2 as string, chat("dead", false));
  post("dead again k2", "/v1/chat/completions", keys.k2 as string, chat("dead", false));
  post("dead third k2", "/v1/chat/completions", keys.k2 as string, chat("dead", false));
  post("unknown model k1", "/v1/chat/completions", keys.k1 as string, chat("nope", false));
  post("bad json k1", "/v1/messages", keys.k1 as string, "{bad");
  post("no auth", "/v1/messages", "", msg("ok", false));
  post("lim first", "/v1/chat/completions", keys.lim as string, chat("ok", false));
  post("lim refused", "/v1/chat/completions", keys.lim as string, chat("ok", false));
  post("lim5h first", "/v1/chat/completions", keys.lim5h as string, chat("ok", false));
  post("lim5h refused", "/v1/chat/completions", keys.lim5h as string, chat("ok", false));
  post("count_tokens lim", "/v1/messages/count_tokens", keys.lim as string, msg("ok", false));
  return rows;
}

// ------------------------------------------------------------ running

/** A failed exchange: never equal to anything, never an expected divergence. */
const TRANSPORT_ERROR = "TRANSPORT-ERROR";

type Config = {
  label: string;
  staticDir: string | null;
  metrics: boolean;
  /** Extra environment for the TS binary only. */
  tsEnv?: Record<string, string>;
  /** `OMNI_METRICS_MAX_SERIES`, for both. */
  capEnv?: string;
  /** Pass `OMNI_STATIC_DIR` relative to the gateway's cwd. */
  relativeStatic?: boolean;
  /** `requestDeadlineMs` written to the copied database before boot. */
  deadlineMs?: number;
  rows: (keys: Record<string, string>) => Row[];
};

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const x = await raw("/health");
      if (x.status === 200) return;
    } catch {}
    await sleep(25);
  }
  throw new Error("not healthy");
}

async function runOne(
  label: string,
  binary: string,
  cfg: Config,
  keys: Record<string, string>,
  fixture: string,
) {
  const root = join(work, `${cfg.label}-${label}`);
  cpSync(fixture, root, { recursive: true, verbatimSymlinks: true });
  copyFileSync(join(seedRoot, "omni.db"), join(root, "omni.db"));
  if (cfg.deadlineMs !== undefined) {
    const d = new Database(join(root, "omni.db"));
    const cur = d.query("SELECT value FROM settings WHERE key = 'settings'").get() as {
      value: string;
    } | null;
    const next = {
      ...(JSON.parse(cur?.value ?? "{}") as object),
      requestDeadlineMs: cfg.deadlineMs,
    };
    d.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)", [
      JSON.stringify(next),
    ]);
    d.close();
  }
  const e: Record<string, string | undefined> = {
    ...env,
    OMNI_DB_PATH: join(root, "omni.db"),
    OMNI_ROOT: root,
    OMNI_STATIC_DIR:
      cfg.staticDir === null
        ? undefined
        : cfg.relativeStatic
          ? cfg.staticDir
          : join(root, cfg.staticDir),
    OMNI_METRICS_TOKEN: cfg.metrics ? TOKEN : undefined,
    OMNI_VERSION: "9.9.9-conformance",
    ...(cfg.capEnv === undefined ? {} : { OMNI_METRICS_MAX_SERIES: cfg.capEnv }),
    ...(label === "ts" ? (cfg.tsEnv ?? {}) : {}),
  };
  const proc = Bun.spawn([binary], {
    cwd: root,
    env: e,
    stdout: Bun.file(join(out, `${cfg.label}-${label}.log`)),
    stderr: Bun.file(join(out, `${cfg.label}-${label}.err`)),
  });
  children.push(proc);
  const results = new Map<string, string>();
  try {
    await waitHealthy();
    for (const row of cfg.rows(keys)) {
      if (flags.only !== undefined && !row.name.includes(flags.only)) continue;
      let x: Ex;
      if (row.settleMs !== undefined) await sleep(row.settleMs);
      try {
        x = await raw(row.target, row.method, row.headers, row.body, row.abortAfterMs);
      } catch (err) {
        results.set(row.name, `${TRANSPORT_ERROR} ${String(err)}`);
        continue;
      }
      if (row.abortAfterMs !== undefined) {
        results.set(
          row.name,
          x.status === -1 ? "aborted" : `${TRANSPORT_ERROR} answered before abort`,
        );
        continue;
      }
      results.set(
        row.name,
        row.statusOnly
          ? String(x.status)
          : normalize(x, row.kind ?? (row.target.startsWith("/health") ? "health" : "plain")),
      );
      // Past the Rust writer's commit-then-debit lag (one batch, ~200 ms;
      // slice 1, accepted), so a long-window refusal lands where TS's does.
      if (row.name.startsWith("traffic")) await sleep(400);
    }
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }
  const marker = existsSync(join(root, "plugins/gamma/setup-ran"));
  const log = await Bun.file(join(out, `${cfg.label}-${label}.log`)).text();
  return { results, marker, log };
}

const fixture = join(work, "fixture");
mkdirSync(join(fixture, "outside"), { recursive: true });
mkdirSync(join(fixture, "dash"), { recursive: true });
dashboard(join(fixture, "dash"), join(fixture, "outside"));
mkdirSync(join(fixture, "evil"), { recursive: true });
escapingDashboard(join(fixture, "evil"));
plugins(fixture);

const keys = await seed();
const configs: Config[] = [
  {
    label: "full",
    staticDir: "dash",
    metrics: true,
    rows: (k) => [
      ...metricsRows("boot"),
      ...staticRows(""),
      ...pluginRows,
      ...traffic(k),
      ...metricsRows("after"),
    ],
  },
  // A directory that does not exist, and none configured at all.
  {
    label: "nodir",
    staticDir: "missing",
    metrics: false,
    rows: () => [...staticRows("nodir "), ...metricsRows("off")],
  },
  // The cardinality cap live: 6 raw series, so the traffic folds keys.
  {
    label: "cap",
    staticDir: "dash",
    metrics: true,
    capEnv: "6",
    rows: (k) => [...traffic(k), ...metricsRows("cap")],
  },
  // Bun's error page differs by mode: dev (no NODE_ENV, as `run.ts` and the
  // Dockerfile run it) prints a stack page; production prints a plain 500.
  // The Rust binary answers the production one; rows against dev TS are
  // recorded as an expected divergence, against production TS compared.
  {
    label: "dirs-prod",
    staticDir: "dash",
    metrics: false,
    tsEnv: { NODE_ENV: "production" },
    rows: () => directoryRows,
  },
  {
    label: "dirs-dev",
    staticDir: "dash",
    metrics: false,
    rows: () =>
      directoryRows.map((r) => ({
        ...r,
        expectDiff: "Bun development-mode error page (stack trace)",
        tsStatus: 500,
        rustExact: DIR_500(r.method === "HEAD"),
      })),
  },
  // A2 I1: the SPA fallback never serves an index.html that escapes the root.
  {
    label: "evil-index",
    staticDir: "evil",
    metrics: false,
    rows: () =>
      ["/missing/route", "/", "/index.html"].flatMap((t): Row[] =>
        [
          { m: "GET", h: [html] as [string, string][] },
          { m: "HEAD", h: [html] as [string, string][] },
          { m: "GET", h: [html, ["range", "bytes=0-3"]] as [string, string][] },
        ].map(({ m, h }) => {
          // TS serves the outside file for a missing navigation route only:
          // `/` maps to `/index.html`, which TS's realpath check refuses too.
          const escapes = t === "/missing/route";
          return {
            name: `evil ${m} ${t} ${h.length > 1 ? "range" : ""}`,
            target: t,
            method: m,
            headers: h,
            ...(escapes
              ? {
                  expectDiff: "security: escaping SPA index is never served",
                  tsStatus: h.length > 1 ? 206 : 200,
                  rustExact: notFound(t, m === "HEAD"),
                }
              : {}),
          };
        }),
      ),
  },
  // `OMNI_STATIC_DIR` relative to the gateway's working directory.
  {
    label: "relative",
    staticDir: "dash",
    relativeStatic: true,
    metrics: false,
    rows: () => [
      { name: "relative GET /", target: "/", headers: [html] },
      { name: "relative GET /plain.txt", target: "/plain.txt" },
      { name: "relative GET /nested", target: "/nested", headers: [html] },
      { name: "relative GET /escape.txt", target: "/escape.txt" },
    ],
  },
  // A1 I2: an upstream attempt cancelled before its head is still one
  // `omni_upstream_duration_seconds` observation (TS: once-guarded trace from
  // the destroyed request's error event), for a request deadline and a client
  // hang-up. Counts are compared exactly.
  {
    label: "cancel",
    staticDir: null,
    metrics: true,
    deadlineMs: 300,
    rows: (k) => [
      {
        name: "cancel deadline",
        target: "/v1/chat/completions",
        method: "POST",
        headers: [
          ["authorization", `Bearer ${k.k1}`],
          ["content-type", "application/json"],
        ],
        body: JSON.stringify({
          model: "silent",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
        statusOnly: true,
      },
      {
        name: "cancel metrics after deadline",
        target: "/metrics",
        headers: [auth],
        kind: "metrics",
      },
    ],
  },
  // The same for a client hang-up before the head, with no deadline.
  {
    label: "abort",
    staticDir: null,
    metrics: true,
    rows: (k) => [
      {
        name: "cancel client abort",
        target: "/v1/chat/completions",
        method: "POST",
        headers: [
          ["authorization", `Bearer ${k.k2}`],
          ["content-type", "application/json"],
        ],
        body: JSON.stringify({
          model: "silent",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
        abortAfterMs: 150,
      },
      {
        name: "cancel metrics after abort",
        target: "/metrics",
        headers: [auth],
        kind: "metrics",
        settleMs: 700,
      },
    ],
  },
  {
    label: "unset",
    staticDir: null,
    metrics: false,
    rows: () => [
      { name: "unset GET /", target: "/", headers: [html] },
      { name: "unset GET /nested", target: "/nested", headers: [html] },
    ],
  },
];

let failures = 0;
let equal = 0;
let expected = 0;
const report: string[] = [];
for (const cfg of configs) {
  const tsRun = await runOne("ts", binaries.ts as string, cfg, keys, fixture);
  const rsRun = await runOne("rust", binaries.rust as string, cfg, keys, fixture);
  const [ts, rs] = [tsRun.results, rsRun.results];
  // Plugins (spec non-goal): TS runs gamma's setup; Rust never does, and
  // warns once per plugin directory with the release wording.
  {
    const warns = [
      ...rsRun.log.matchAll(
        /WARN {2}plugin skipped {2}plugin=(\S+) reason="plugins are not supported in this release"/g,
      ),
    ].map((m) => m[1]);
    const loaded = /INFO {2}plugins resolved {2}count=0 path=\S+\/plugins\n/.test(rsRun.log);
    const problems: string[] = [];
    if (JSON.stringify(warns) !== JSON.stringify(["alpha", "beta", "gamma"]))
      problems.push(`warnings ${JSON.stringify(warns)}`);
    if (!loaded) problems.push("no `plugins resolved count=0` line");
    if (rsRun.marker) problems.push("Rust ran a plugin's setup");
    if (!tsRun.marker) problems.push("TS did not run gamma's setup (fixture not loadable?)");
    if (/plugin (loaded|unavailable)/.test(rsRun.log)) problems.push("Rust logged a plugin load");
    if (problems.length > 0) {
      failures++;
      report.push(`PLUGINS ${cfg.label}: ${problems.join("; ")}`);
    } else equal++;
  }
  const rows = cfg.rows(keys);
  for (const row of rows) {
    const a = ts.get(row.name);
    const b = rs.get(row.name);
    if (a === undefined && b === undefined) continue;
    if (
      a === undefined ||
      b === undefined ||
      a.startsWith(TRANSPORT_ERROR) ||
      b.startsWith(TRANSPORT_ERROR)
    ) {
      failures++;
      report.push(`TRANSPORT ${cfg.label}: ${row.name}\n--- ts\n${a}\n--- rust\n${b}\n`);
      continue;
    }
    const same = a === b;
    if (row.rust !== undefined) {
      if (b === row.rust && a !== b) {
        expected++;
        report.push(`spec-diff ${cfg.label}: ${row.name} ts=${(a ?? "").split("\n")[0]} rust=501`);
      } else {
        failures++;
        report.push(
          `DIFF ${cfg.label}: ${row.name} (spec answer)\n--- want\n${row.rust}\n--- rust\n${b}\n--- ts\n${a}\n`,
        );
      }
      continue;
    }
    if (row.expectDiff !== undefined) {
      const tsStatusOk = row.tsStatus === undefined || a.split("\n")[0] === String(row.tsStatus);
      const rustOk = row.rustExact === undefined || b === row.rustExact;
      if (same || !tsStatusOk || !rustOk) {
        failures++;
        report.push(
          `${same ? "UNEXPECTED-EQUAL" : "WRONG-DIVERGENCE"} ${cfg.label}: ${row.name} (${row.expectDiff})\n--- want ts status ${row.tsStatus}, rust\n${row.rustExact}\n--- ts\n${a}\n--- rust\n${b}\n`,
        );
      } else {
        expected++;
        report.push(
          `expected-diff ${cfg.label}: ${row.name} (${row.expectDiff}) rust=${(b ?? "").split("\n")[0]}`,
        );
      }
      continue;
    }
    if (same) {
      equal++;
      continue;
    }
    failures++;
    report.push(`DIFF ${cfg.label}: ${row.name}\n--- ts\n${a}\n--- rust\n${b}\n`);
  }
  writeFileSync(join(out, `${cfg.label}-ts.json`), JSON.stringify(Object.fromEntries(ts), null, 1));
  writeFileSync(
    join(out, `${cfg.label}-rust.json`),
    JSON.stringify(Object.fromEntries(rs), null, 1),
  );
}
const summary = `surface: ${equal} equal, ${expected} expected divergences, ${failures} failures`;
writeFileSync(join(out, "report.txt"), `${report.join("\n")}\n${summary}\n`);
console.log(report.join("\n"));
console.log(summary);
rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
