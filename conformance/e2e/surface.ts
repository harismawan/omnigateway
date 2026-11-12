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
 * Divergences that are this harness's own and not the gateway's: Bun answers
 * a request-target containing `\`, `<`, `>` or `` ` `` after rewriting it,
 * while hyper refuses it with 400 before any route. Those targets are run and
 * recorded as an expected divergence (`expectDiff`), never as equal.
 */
import {
  copyFileSync,
  cpSync,
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
function answer(model: string): string {
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
        s.write(answer(/"model":"([^"]*)"/.exec(body)?.[1] ?? ""));
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

function plugins(root: string): void {
  // Two plugin directories and a plain file: TS loads neither (no manifest),
  // the Rust gateway warns once per directory and loads nothing.
  mkdirSync(join(root, "plugins/alpha"), { recursive: true });
  mkdirSync(join(root, "plugins/beta"), { recursive: true });
  writeFileSync(join(root, "plugins/README"), "not a plugin");
}

// ------------------------------------------------------------ raw HTTP

type Ex = { status: number; head: [string, string][]; body: Buffer };

function raw(
  target: string,
  method = "GET",
  headers: [string, string][] = [],
  body = "",
): Promise<Ex> {
  return new Promise((res, rej) => {
    const s = connect(PORT, "127.0.0.1");
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
  /** The divergence is the spec's: the Rust answer must be exactly this. */
  rust?: string;
  target: string;
  method?: string;
  headers?: [string, string][];
  body?: string;
  kind?: "plain" | "metrics" | "metrics-head" | "health";
  /** Hyper refuses what Bun rewrites; recorded, required to differ. */
  expectDiff?: string;
};
const html: [string, string] = ["accept", "text/html,application/xhtml+xml"];
const auth: [string, string] = ["authorization", `Bearer ${TOKEN}`];

function staticRows(prefix: string): Row[] {
  const rows: Row[] = [];
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
    add(t, { headers: [html], expectDiff: "hyper refuses a request-target Bun rewrites (400)" });
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

type Config = {
  label: string;
  staticDir: string | null;
  metrics: boolean;
  /** Extra environment for the TS binary only. */
  tsEnv?: Record<string, string>;
  /** `OMNI_METRICS_MAX_SERIES`, for both. */
  capEnv?: string;
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
  const e: Record<string, string | undefined> = {
    ...env,
    OMNI_DB_PATH: join(root, "omni.db"),
    OMNI_ROOT: root,
    OMNI_STATIC_DIR: cfg.staticDir === null ? undefined : join(root, cfg.staticDir),
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
      try {
        x = await raw(row.target, row.method, row.headers, row.body);
      } catch (err) {
        results.set(row.name, `ERROR ${String(err)}`);
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
  return results;
}

const fixture = join(work, "fixture");
mkdirSync(join(fixture, "outside"), { recursive: true });
mkdirSync(join(fixture, "dash"), { recursive: true });
dashboard(join(fixture, "dash"), join(fixture, "outside"));
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
      })),
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
  const ts = await runOne("ts", resolve(REPO, flags.ts as string), cfg, keys, fixture);
  const rs = await runOne("rust", resolve(REPO, flags.rust as string), cfg, keys, fixture);
  const rows = cfg.rows(keys);
  for (const row of rows) {
    const a = ts.get(row.name);
    const b = rs.get(row.name);
    if (a === undefined && b === undefined) continue;
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
      if (same) {
        failures++;
        report.push(`UNEXPECTED-EQUAL ${cfg.label}: ${row.name}`);
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
