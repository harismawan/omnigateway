#!/usr/bin/env bun
/**
 * Conformance for the admin auth core (roadmap A4): `GET /api/status`,
 * `POST /api/setup`, `POST /api/login`, `POST /api/logout`, the session
 * cookie, session lifetime, and password-hash compatibility — the TS gateway
 * binary and the Rust one, each on its own copy of one CLI-seeded root.
 *
 *   bun scripts/build-binary.ts /tmp/opencode/a4/bin/ts-omnigateway
 *   cargo build --release -p omni-gateway
 *   bun conformance/e2e/admin-auth.ts --ts /tmp/opencode/a4/bin/ts-omnigateway \
 *     --rust target/release/omnigateway --out /tmp/opencode/a4/admin-auth
 *
 * Every exchange is raw HTTP/1.1 over a socket (request head written as
 * Latin-1, so header bytes above 0x7f reach the server as written), compared
 * as status, headers (names lowercased, sorted) and body bytes. Each step runs
 * against the session cookies *that binary* issued earlier in the same
 * sequence: `{{A}}` in a header is the token captured as `A`.
 *
 * Masks (validated; anything failing validation is compared raw):
 * - header `date`: an IMF date within ±120 s of now (any IMF date in the
 *   faketime configuration, whose clock is deliberately moved);
 * - the session token in `set-cookie: omni_admin=<token>; …`: unpadded
 *   base64url decoding to exactly 32 bytes, and never seen before in the
 *   run (every token minted across both binaries is distinct).
 *
 * Beyond the exchanges:
 * - the `admin …` log lines (level, message, fields; timestamps dropped) are
 *   compared in order;
 * - the stored `adminPasswordHash` after setup has the TS format on both
 *   (`$argon2id$v=19$m=19456,t=2,p=1$<43>$<43>`), and both binaries are
 *   booted on the database TS's setup wrote and on the one Rust's wrote
 *   (a password set by either verifies in the other);
 * - a configuration whose hashes `Bun.password.hash` wrote (TS's own code
 *   path) checks Rust verifies them, viewer included.
 *
 * Divergence, asserted exactly: a request whose `content-length` exceeds the
 * 128 MiB body limit is refused 413 by both; Bun's 413 carries no headers,
 * hyper's carries `content-length: 0`.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    "skip-big": { type: "boolean", default: false },
  },
});
if (flags.ts === undefined || flags.rust === undefined) {
  console.error("usage: admin-auth.ts --ts <binary> --rust <binary> [--out dir]");
  process.exit(2);
}

const REPO = resolve(import.meta.dir, "../..");
const KEY = "conformance-admin-auth-encryption-key-0123";
const PORT = 18442;
const FAKETIME_LIB = "/home/linuxbrew/.linuxbrew/lib/faketime/libfaketimeMT.so.1";
mkdirSync("/tmp/opencode", { recursive: true });
const work = mkdtempSync("/tmp/opencode/omni-admin-auth-");
const out = flags.out ?? join(work, "out");
mkdirSync(out, { recursive: true });
const children: Subprocess[] = [];
process.on("exit", () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PASSWORD = "correct-horse-battery";
const VIEWER = "viewer-password-42";
const LIMIT = 128 * 1024 * 1024;

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
async function cli(args: string[]): Promise<void> {
  const p = Bun.spawn(
    [...(flags.cli ?? "").split(/\s+/).filter(Boolean), "--root", seedRoot, "--json", ...args],
    {
      cwd: REPO,
      env: { ...env, OMNI_DB_PATH: join(seedRoot, "omni.db") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [e, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`omni ${args.join(" ")}: ${e}`);
}
writeFileSync(
  join(seedRoot, ".env"),
  `OMNI_ENCRYPTION_KEY=${KEY}\nOMNI_DB_PATH=${join(seedRoot, "omni.db")}\n`,
);
await cli(["keys", "create", "--label", "k1"]);

/** A copy of the seed database with these settings rows. */
function seededDb(name: string, rows: Record<string, string>): string {
  const file = join(work, `${name}.db`);
  copyFileSync(join(seedRoot, "omni.db"), file);
  const d = new Database(file);
  for (const [k, v] of Object.entries(rows))
    d.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [k, v]);
  d.close();
  return file;
}
// Hashes written by TS's own code path (`Bun.password.hash(_, ARGON2)`).
const ARGON2 = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;
const tsAdminHash = await Bun.password.hash(PASSWORD, ARGON2);
const tsViewerHash = await Bun.password.hash(VIEWER, ARGON2);
/** `@node-rs/argon2`'s format (16-byte salt), from `adminAuth.test.ts`. */
const LEGACY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$l3SA90jOgwe6OXTFGCdu6Q$MlCWIoHV+Wa1DwZZkoJpnR4syDmJlkdiJdeDzjzHL9o";

// ------------------------------------------------------------ raw HTTP

type Ex = { status: number; head: [string, string][]; body: Buffer };
type Req = {
  method?: string;
  target: string;
  headers?: [string, string][];
  body?: string;
  /** A body of `size` spaces, sent with content-length (or chunked). */
  big?: { size: number; chunked?: boolean; headOnly?: boolean };
};

function parse(all: Buffer): Ex {
  const end = all.indexOf("\r\n\r\n");
  if (end < 0) return { status: 0, head: [], body: all };
  const lines = all.subarray(0, end).toString("latin1").split("\r\n");
  const status = Number(lines[0]?.split(" ")[1] ?? 0);
  const head = lines.slice(1).map((l): [string, string] => {
    const i = l.indexOf(":");
    return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()];
  });
  return { status, head, body: all.subarray(end + 4) };
}

function exchange(r: Req): Promise<Ex> {
  return new Promise((res, rej) => {
    const s = connect(PORT, "127.0.0.1");
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      s.destroy();
      rej(new Error(`timeout ${r.method ?? "GET"} ${r.target}`));
    }, 60_000);
    s.on("data", (d) => chunks.push(d));
    // A server that answers and closes while a big body is still going out
    // resets the socket; what it answered is still in `chunks`.
    s.on("error", () => {});
    s.on("close", () => {
      clearTimeout(timer);
      res(parse(Buffer.concat(chunks)));
    });
    const method = r.method ?? "GET";
    const h = (r.headers ?? []).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    let framing = "";
    if (r.big !== undefined) {
      framing = r.big.chunked
        ? "transfer-encoding: chunked\r\n"
        : `content-length: ${r.big.size}\r\n`;
    } else if (r.body !== undefined || method === "POST") {
      framing = `content-length: ${Buffer.byteLength(r.body ?? "")}\r\n`;
    }
    s.write(
      Buffer.from(
        `${method} ${r.target} HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\nconnection: close\r\n${h}${framing}\r\n`,
        "latin1",
      ),
    );
    if (r.big === undefined) {
      if (r.body !== undefined) s.write(Buffer.from(r.body, "utf8"));
      return;
    }
    if (r.big.headOnly) return;
    const chunk = Buffer.alloc(1 << 20, 0x20);
    let left = r.big.size;
    const chunked = r.big.chunked === true;
    const pump = () => {
      while (left > 0 && !s.destroyed) {
        const n = Math.min(left, chunk.length);
        left -= n;
        const piece = chunked
          ? Buffer.concat([
              Buffer.from(`${n.toString(16)}\r\n`),
              chunk.subarray(0, n),
              Buffer.from("\r\n"),
            ])
          : chunk.subarray(0, n);
        if (!s.write(piece)) {
          s.once("drain", pump);
          return;
        }
      }
      if (chunked && !s.destroyed) s.write("0\r\n\r\n");
    };
    pump();
  });
}

// ------------------------------------------------------------ masks

const seenTokens = new Set<string>();
const TOKEN = /^omni_admin=([^;]*)(;.*)$/;

/** Masks a minted token after validating its format and uniqueness. */
function maskCookie(v: string): { masked: string; token: string | null } {
  const m = TOKEN.exec(v);
  if (m === null) return { masked: v, token: null };
  const token = m[1] as string;
  if (token === "") return { masked: v, token: null };
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { masked: v, token: null };
  if (Buffer.from(token, "base64url").length !== 32) return { masked: v, token: null };
  if (seenTokens.has(token)) throw new Error(`session token minted twice: ${token}`);
  seenTokens.add(token);
  return { masked: `omni_admin=<token>${m[2]}`, token };
}

function normalize(x: Ex, anyDate: boolean): { text: string; token: string | null } {
  const now = Date.now() / 1000;
  let token: string | null = null;
  const head = x.head
    .filter(([k, v]) => !(k === "connection" && v === "close"))
    .map(([k, v]) => {
      if (k === "date") {
        const t = Date.parse(v);
        if (!Number.isNaN(t) && (anyDate || Math.abs(t / 1000 - now) < 120)) return "date: <date>";
      }
      if (k === "set-cookie") {
        const c = maskCookie(v);
        token = c.token;
        return `${k}: ${c.masked}`;
      }
      return `${k}: ${v}`;
    })
    .sort();
  return { text: `${x.status}\n${head.join("\n")}\n\n${x.body.toString("latin1")}`, token };
}

// ------------------------------------------------------------ the matrix

type Step =
  | ({
      kind?: "http";
      name: string;
      /** Store the issued token under this name. */
      capture?: string;
      /** An asserted divergence: TS's status, and Rust's exact answer. */
      expectDiff?: string;
      tsStatus?: number;
      rustExact?: string;
    } & Req)
  | { kind: "restart"; name: string }
  | { kind: "faketime"; name: string; offset: string };

const json: [string, string] = ["content-type", "application/json"];
const login = (
  body: string,
  extra: [string, string][] = [],
  capture?: string,
  target = "/api/login",
): Step => ({
  name: `login ${target} ${JSON.stringify(extra)} ${body.length > 80 ? `${body.slice(0, 60)}…(${body.length})` : body}`,
  method: "POST",
  target,
  headers: [json, ...extra],
  body,
  ...(capture === undefined ? {} : { capture }),
});
const status = (label: string, headers: [string, string][] = [], target = "/api/status"): Step => ({
  name: `status ${label}`,
  target,
  headers,
});
const cookie = (t: string): [string, string] => ["cookie", `omni_admin={{${t}}}`];
const pw = JSON.stringify({ password: PASSWORD });
/** Bun's bare 413 against hyper's. */
const RUST_413 = "413\ncontent-length: 0\n\n";

const deep = (n: number) => `{"x":${"[".repeat(n)}${"]".repeat(n)},"password":"${PASSWORD}"}`;

function freshSteps(): Step[] {
  const s: Step[] = [
    status("fresh anonymous"),
    { name: "status fresh HEAD", method: "HEAD", target: "/api/status" },
    status("fresh query", [], "/api/status?x=1"),
    status("fresh slash", [], "/api/status/"),
    status("fresh dotdot", [], "/x/../api/status"),
    status("fresh double slash", [], "/api/status//"),
    status("fresh encoded", [], "/api/%73tatus"),
    { name: "status POST", method: "POST", target: "/api/status" },
    { name: "setup GET", target: "/api/setup" },
    { name: "setup HEAD", method: "HEAD", target: "/api/setup" },
    { name: "setup PUT", method: "PUT", target: "/api/setup", body: pw },
    { name: "login GET", target: "/api/login" },
    { name: "logout GET", target: "/api/logout" },
    { name: "login DELETE", method: "DELETE", target: "/api/login" },
    { name: "login OPTIONS", method: "OPTIONS", target: "/api/login" },
    login(pw),
    login(JSON.stringify({ password: PASSWORD, mode: "viewer" })),
  ];
  for (const body of [
    "",
    " ",
    "{bad",
    "[]",
    "null",
    '"str"',
    "5",
    "{}",
    '{"password":5}',
    '{"password":null}',
    '{"password":"short"}',
    `{"password":"${"é".repeat(11)}"}`,
    `{"password":"${"x".repeat(11)}"}`,
    '{"password":""}',
    "[1,2]",
    '{"password":"ok-length-pass"} trailing',
  ]) {
    s.push({
      name: `setup body ${JSON.stringify(body)}`,
      method: "POST",
      target: "/api/setup",
      headers: [json],
      body,
    });
  }
  s.push(
    {
      name: "setup ok",
      method: "POST",
      target: "/api/setup",
      headers: [json, ["x-forwarded-proto", "https"]],
      body: pw,
      capture: "A",
    },
    { name: "setup again", method: "POST", target: "/api/setup", headers: [json], body: pw },
    { name: "setup again bad json", method: "POST", target: "/api/setup", body: "{bad" },
    { name: "setup again empty", method: "POST", target: "/api/setup" },
    status("admin A", [cookie("A")]),
    status("admin A HEAD", [cookie("A")]),
    status("anonymous configured"),
  );
  return s;
}

function loginSteps(): Step[] {
  const s: Step[] = [];
  // Failures.
  for (const body of [
    "",
    "{bad",
    "[1]",
    "null",
    "{}",
    '{"password":5}',
    '{"password":"wrong-password-123"}',
    `{"password":"${PASSWORD} "}`,
    JSON.stringify({ password: PASSWORD.toUpperCase() }),
    JSON.stringify({ password: PASSWORD, mode: "viewer" }),
    '{"password":"\\ud800bcdefghijklmn"}',
    "\ufeff",
  ]) {
    s.push(login(body));
  }
  // Successes: every one mints a token.
  let n = 0;
  const ok = (body: string, extra: [string, string][] = [], target = "/api/login") =>
    s.push(login(body, extra, `L${n++}`, target));
  ok(pw);
  ok(JSON.stringify({ password: PASSWORD, mode: "admin" }));
  ok(JSON.stringify({ password: PASSWORD, mode: "viewer " }));
  ok(JSON.stringify({ password: PASSWORD, mode: 1 }));
  ok('{"password":"x","password":"correct-horse-battery"}');
  ok('{"pass\\u0077ord":"correct-horse-\\u0062attery"}');
  ok(`\ufeff${pw}`);
  ok(`  ${pw}\n`);
  ok(`{"x":1e400,"y":"\\udc00","password":"${PASSWORD}"}`);
  ok(deep(50_000));
  ok(`{"password":"${PASSWORD}","x":"\u00ff\u4e2d\ud83d\ude00"}`);
  ok(pw, [["content-type", "text/plain"]]);
  ok(pw, [["content-type", "application/x-www-form-urlencoded"]]);
  ok(pw, [["content-type", "multipart/form-data; boundary=x"]]);
  ok(pw, [], "/api/login/");
  ok(pw, [], "/x/../api/login");
  ok(pw, [], "/api/login?x=1");
  // The `Secure` rule: x-forwarded-proto's first hop, trimmed, any case.
  for (const xfp of [
    "https",
    "HTTPS",
    "HTTPS , http",
    "https, http",
    ", https",
    "http",
    "",
    "\u00a0https",
    "https\u00a0",
    "\u00e9https",
    "httpsx",
    "wss",
  ]) {
    ok(pw, [["x-forwarded-proto", xfp]]);
  }
  ok(pw, [
    ["x-forwarded-proto", "https"],
    ["x-forwarded-proto", "http"],
  ]);
  ok(pw, [
    ["x-forwarded-proto", "http"],
    ["x-forwarded-proto", "https"],
  ]);
  s.push(
    { name: "login wrong path", method: "POST", target: "/api/login//", headers: [json], body: pw },
    { name: "login case", method: "POST", target: "/API/login", headers: [json], body: pw },
  );
  // Cookie reading: first `omni_admin` wins; parts trimmed; several headers.
  s.push(
    status("cookie plain", [cookie("L0")]),
    status("cookie among others", [["cookie", "a=b; omni_admin={{L0}}; c=d"]]),
    status("cookie first wins (bad first)", [["cookie", "omni_admin=bad; omni_admin={{L0}}"]]),
    status("cookie first wins (good first)", [["cookie", "omni_admin={{L0}}; omni_admin=bad"]]),
    status("cookie two headers", [
      ["cookie", "a=b"],
      ["cookie", "omni_admin={{L1}}"],
    ]),
    status("cookie padded", [["cookie", "x=1 ;   omni_admin={{L1}}   ; y=2"]]),
    status("cookie nbsp", [["cookie", "\u00a0omni_admin={{L1}}"]]),
    status("cookie trailing =", [["cookie", "omni_admin={{L1}}="]]),
    status("cookie case", [["cookie", "OMNI_ADMIN={{L1}}"]]),
    status("cookie empty", [["cookie", "omni_admin="]]),
    status("cookie bare", [["cookie", "omni_admin"]]),
    status("cookie garbage", [["cookie", "omni_admin=not-a-token"]]),
  );
  return s;
}

function logoutSteps(): Step[] {
  return [
    login(pw, [], "B"),
    login(pw, [], "C"),
    status("B before logout", [cookie("B")]),
    { name: "logout B", method: "POST", target: "/api/logout", headers: [cookie("B")] },
    status("B after logout", [cookie("B")]),
    status("C after B's logout", [cookie("C")]),
    { name: "logout B again", method: "POST", target: "/api/logout", headers: [cookie("B")] },
    { name: "logout none", method: "POST", target: "/api/logout" },
    {
      name: "logout garbage",
      method: "POST",
      target: "/api/logout",
      headers: [["cookie", "omni_admin=zzz"]],
    },
    {
      name: "logout empty",
      method: "POST",
      target: "/api/logout",
      headers: [["cookie", "omni_admin="]],
    },
    {
      name: "logout https",
      method: "POST",
      target: "/api/logout",
      headers: [["x-forwarded-proto", "https"]],
    },
    { name: "logout body", method: "POST", target: "/api/logout", headers: [json], body: "{bad" },
    { name: "logout slash", method: "POST", target: "/api/logout/" },
    { name: "logout dotdot", method: "POST", target: "/x/%2e%2e/api/logout" },
    { name: "logout double slash", method: "POST", target: "/api/logout//" },
    {
      name: "logout C",
      method: "POST",
      target: "/api/logout",
      headers: [cookie("C"), ["x-forwarded-proto", "HTTPS"]],
    },
    status("C after logout", [cookie("C")]),
  ];
}

function bigSteps(): Step[] {
  if (flags["skip-big"]) return [];
  return [
    {
      name: "login content-length over limit",
      method: "POST",
      target: "/api/login",
      big: { size: LIMIT + 1, headOnly: true },
      expectDiff: "413 framing: Bun sends no headers",
      tsStatus: 413,
      rustExact: RUST_413,
    },
    {
      name: "setup content-length over limit",
      method: "POST",
      target: "/api/setup",
      big: { size: LIMIT + 1, headOnly: true },
      expectDiff: "413 framing: Bun sends no headers",
      tsStatus: 413,
      rustExact: RUST_413,
    },
    {
      name: "logout content-length over limit",
      method: "POST",
      target: "/api/logout",
      big: { size: LIMIT + 1, headOnly: true },
      expectDiff: "413 framing: Bun sends no headers",
      tsStatus: 413,
      rustExact: RUST_413,
    },
    { name: "login body at limit", method: "POST", target: "/api/login", big: { size: LIMIT } },
    {
      name: "login chunked over limit",
      method: "POST",
      target: "/api/login",
      big: { size: LIMIT + 1, chunked: true },
      expectDiff: "413 framing: Bun sends no headers",
      tsStatus: 413,
      rustExact: RUST_413,
    },
    status("status with a big content-length", [["content-length", String(LIMIT + 1)]]),
  ];
}

function viewerSteps(): Step[] {
  return [
    status("seeded anonymous"),
    login(JSON.stringify({ password: VIEWER })),
    login(JSON.stringify({ password: PASSWORD, mode: "viewer" })),
    login(JSON.stringify({ password: VIEWER, mode: "viewer" }), [], "V"),
    login(JSON.stringify({ password: VIEWER, mode: "VIEWER" })),
    login(pw, [], "A"),
    status("viewer", [cookie("V")]),
    status("admin", [cookie("A")]),
    { name: "setup when seeded", method: "POST", target: "/api/setup", headers: [json], body: pw },
    { name: "logout viewer", method: "POST", target: "/api/logout", headers: [cookie("V")] },
    status("viewer after logout", [cookie("V")]),
    status("admin after viewer logout", [cookie("A")]),
  ];
}

type Config = {
  label: string;
  /** The database to boot on: a seeded copy, or what an earlier run wrote. */
  db: () => string;
  env?: Record<string, string>;
  faketime?: boolean;
  steps: () => Step[];
};

/** The database each binary's `fresh` run left behind (setup's hash in it). */
const written: { byTs?: string; byRust?: string } = {};

const configs: Config[] = [
  {
    label: "fresh",
    db: () => seededDb("fresh", {}),
    steps: () => [...freshSteps(), ...loginSteps(), ...logoutSteps(), ...bigSteps()],
  },
  // Both binaries on the database TS's setup wrote (TS hash → Rust verify),
  // then on the one Rust's setup wrote (Rust hash → TS verify).
  {
    label: "cross-ts-written",
    db: () => written.byTs as string,
    steps: () => [
      status("on TS-written db"),
      login(JSON.stringify({ password: "wrong-password-123" })),
      login(pw, [], "X"),
      status("admin on TS-written db", [cookie("X")]),
    ],
  },
  {
    label: "cross-rust-written",
    db: () => written.byRust as string,
    steps: () => [
      status("on Rust-written db"),
      login(JSON.stringify({ password: "wrong-password-123" })),
      login(pw, [], "X"),
      status("admin on Rust-written db", [cookie("X")]),
    ],
  },
  {
    label: "bun-hashes",
    db: () =>
      seededDb("bun-hashes", { adminPasswordHash: tsAdminHash, viewerPasswordHash: tsViewerHash }),
    steps: viewerSteps,
  },
  {
    label: "legacy-hash",
    db: () => seededDb("legacy", { adminPasswordHash: LEGACY_HASH }),
    steps: () => [
      login(JSON.stringify({ password: "testpassword123" }), [], "A"),
      login(JSON.stringify({ password: "testpassword124" })),
      status("legacy admin", [cookie("A")]),
    ],
  },
  {
    label: "broken-hash",
    db: () => seededDb("broken", { adminPasswordHash: "not-a-phc-string", viewerPasswordHash: "" }),
    steps: () => [
      status("broken anonymous"),
      login(pw),
      login(JSON.stringify({ password: "x", mode: "viewer" })),
      login(JSON.stringify({ password: "", mode: "viewer" })),
      {
        name: "setup over a broken hash",
        method: "POST",
        target: "/api/setup",
        headers: [json],
        body: pw,
      },
    ],
  },
  // Sessions live in process memory: a restart ends every one of them.
  {
    label: "restart",
    db: () => seededDb("restart", { adminPasswordHash: tsAdminHash }),
    steps: () => [
      login(pw, [], "A"),
      status("before restart", [cookie("A")]),
      { kind: "restart", name: "restart" },
      status("after restart", [cookie("A")]),
      login(pw, [], "B"),
      status("new session after restart", [cookie("B")]),
    ],
  },
  // The configured public origin decides `Secure` on its own.
  ...(
    [
      ["base-https", "https://gateway.example.com"],
      ["base-upper", "HTTPS://gateway.example.com"],
      ["base-path", "http://gateway.example.com/https:/x"],
      ["base-bad", "not a url"],
      ["base-trailing", "https://gateway.example.com///"],
    ] as const
  ).map(
    ([label, base]): Config => ({
      label,
      db: () => seededDb(label, { adminPasswordHash: tsAdminHash }),
      env: { OMNI_BASE_URL: base },
      steps: () => [
        login(pw, [], "A"),
        login(pw, [["x-forwarded-proto", "http"]], "B"),
        { name: "logout", method: "POST", target: "/api/logout", headers: [cookie("A")] },
      ],
    }),
  ),
  // Session expiry against a moved wall clock (libfaketime): valid up to
  // the TTL, gone at it, and still gone when the clock comes back.
  {
    label: "expiry",
    db: () =>
      seededDb("expiry", { adminPasswordHash: tsAdminHash, viewerPasswordHash: tsViewerHash }),
    faketime: true,
    steps: () => [
      login(pw, [], "A"),
      login(JSON.stringify({ password: VIEWER, mode: "viewer" }), [], "V"),
      { kind: "faketime", name: "clock +43190s", offset: "+43190" },
      status("admin 10 s before expiry", [cookie("A")]),
      login(pw, [], "B"),
      { kind: "faketime", name: "clock +43199s", offset: "+43199" },
      status("viewer 1 s before expiry", [cookie("V")]),
      { kind: "faketime", name: "clock +43201s", offset: "+43201" },
      status("admin after expiry", [cookie("A")]),
      status("viewer after expiry", [cookie("V")]),
      status("later session still valid", [cookie("B")]),
      { kind: "faketime", name: "clock back to +0", offset: "+0" },
      status("expired admin stays gone", [cookie("A")]),
      status("later session after clock return", [cookie("B")]),
      { kind: "faketime", name: "clock +86400s", offset: "+86400" },
      status("later session past its own expiry", [cookie("B")]),
    ],
  },
];

// ------------------------------------------------------------ running

const TRANSPORT_ERROR = "TRANSPORT-ERROR";

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const x = await exchange({ target: "/health" });
      if (x.status === 200) return;
    } catch {}
    await sleep(25);
  }
  throw new Error("not healthy");
}

async function runOne(label: "ts" | "rust", binary: string, cfg: Config) {
  const root = join(work, `${cfg.label}-${label}`);
  mkdirSync(root, { recursive: true });
  const db = join(root, "omni.db");
  copyFileSync(cfg.db(), db);
  const clockFile = join(root, "faketime");
  writeFileSync(clockFile, "+0\n");
  const e: Record<string, string | undefined> = {
    ...env,
    OMNI_DB_PATH: db,
    OMNI_ROOT: root,
    OMNI_STATIC_DIR: join(root, "no-dashboard"),
    ...(cfg.env ?? {}),
    ...(cfg.faketime
      ? {
          LD_PRELOAD: FAKETIME_LIB,
          FAKETIME_TIMESTAMP_FILE: clockFile,
          FAKETIME_NO_CACHE: "1",
          FAKETIME_DONT_FAKE_MONOTONIC: "1",
        }
      : {}),
  };
  let boots = 0;
  const logs: string[] = [];
  let proc: Subprocess | undefined;
  const boot = async () => {
    const logFile = join(out, `${cfg.label}-${label}-${boots++}.log`);
    logs.push(logFile);
    proc = Bun.spawn([binary], {
      cwd: root,
      env: e,
      stdout: Bun.file(logFile),
      stderr: Bun.file(`${logFile}.err`),
    });
    children.push(proc);
    await waitHealthy();
  };
  const stop = async () => {
    proc?.kill("SIGTERM");
    await proc?.exited;
  };
  const tokens = new Map<string, string>();
  const results = new Map<string, string>();
  try {
    await boot();
    for (const step of cfg.steps()) {
      if (flags.only !== undefined && !step.name.includes(flags.only) && step.kind === undefined)
        continue;
      if (step.kind === "restart") {
        await stop();
        await boot();
        continue;
      }
      if (step.kind === "faketime") {
        writeFileSync(clockFile, `${step.offset}\n`);
        await sleep(50);
        continue;
      }
      const headers = (step.headers ?? []).map(([k, v]): [string, string] => [
        k,
        v.replace(/\{\{(\w+)\}\}/g, (_, t: string) => tokens.get(t) ?? `<missing ${t}>`),
      ]);
      let x: Ex;
      try {
        x = await exchange({ ...step, headers });
      } catch (err) {
        results.set(step.name, `${TRANSPORT_ERROR} ${String(err)}`);
        continue;
      }
      if (x.status === 0) {
        results.set(step.name, `${TRANSPORT_ERROR} no response (${x.body.length} bytes)`);
        continue;
      }
      const n = normalize(x, cfg.faketime === true);
      if (step.capture !== undefined) {
        if (n.token === null) results.set(step.name, `${n.text}\n(no token to capture)`);
        else tokens.set(step.capture, n.token);
      }
      if (!results.has(step.name)) results.set(step.name, n.text);
    }
  } finally {
    await stop();
  }
  const d = new Database(db, { readonly: true });
  const hash = (
    d.query("SELECT value FROM settings WHERE key = 'adminPasswordHash'").get() as {
      value: string;
    } | null
  )?.value;
  d.close();
  const authLines = logs
    .flatMap((f) => readFileSync(f, "utf8").split("\n"))
    .map((l) => l.replace(/^\S+ /, ""))
    .filter((l) => /^\w+ +admin /.test(l));
  return { results, db, hash, authLines };
}

const PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{43}\$[A-Za-z0-9+/]{43}$/;
let failures = 0;
let equal = 0;
let expected = 0;
const report: string[] = [];
for (const cfg of configs) {
  if (cfg.label.startsWith("cross") && flags.only !== undefined) continue;
  const tsRun = await runOne("ts", resolve(REPO, flags.ts as string), cfg);
  const rsRun = await runOne("rust", resolve(REPO, flags.rust as string), cfg);
  if (cfg.label === "fresh") {
    // Cross-compat inputs: each side's written database.
    const keep = (side: "ts" | "rust", file: string) => {
      const copy = join(work, `written-${side}.db`);
      copyFileSync(file, copy);
      return copy;
    };
    written.byTs = keep("ts", tsRun.db);
    written.byRust = keep("rust", rsRun.db);
    for (const [side, run] of [
      ["ts", tsRun],
      ["rust", rsRun],
    ] as const) {
      if (run.hash === undefined || !PHC.test(run.hash)) {
        failures++;
        report.push(
          `HASH ${side}: stored adminPasswordHash ${JSON.stringify(run.hash)} is not the TS format`,
        );
      } else equal++;
    }
  }
  const [ts, rs] = [tsRun.results, rsRun.results];
  for (const step of cfg.steps()) {
    if (step.kind !== undefined && step.kind !== "http") continue;
    const a = ts.get(step.name);
    const b = rs.get(step.name);
    if (a === undefined && b === undefined) continue;
    if (
      a === undefined ||
      b === undefined ||
      a.startsWith(TRANSPORT_ERROR) ||
      b.startsWith(TRANSPORT_ERROR)
    ) {
      failures++;
      report.push(`TRANSPORT ${cfg.label}: ${step.name}\n--- ts\n${a}\n--- rust\n${b}\n`);
      continue;
    }
    if (step.expectDiff !== undefined) {
      const tsOk = a.split("\n")[0] === String(step.tsStatus);
      const rsOk = b === step.rustExact;
      if (a === b || !tsOk || !rsOk) {
        failures++;
        report.push(
          `${a === b ? "UNEXPECTED-EQUAL" : "WRONG-DIVERGENCE"} ${cfg.label}: ${step.name} (${step.expectDiff})\n--- want ts status ${step.tsStatus}, rust\n${step.rustExact}\n--- ts\n${a}\n--- rust\n${b}\n`,
        );
      } else {
        expected++;
        report.push(`expected-diff ${cfg.label}: ${step.name} (${step.expectDiff})`);
      }
      continue;
    }
    if (a === b) {
      equal++;
      continue;
    }
    failures++;
    report.push(`DIFF ${cfg.label}: ${step.name}\n--- ts\n${a}\n--- rust\n${b}\n`);
  }
  if (JSON.stringify(tsRun.authLines) === JSON.stringify(rsRun.authLines)) equal++;
  else {
    failures++;
    report.push(
      `LOGS ${cfg.label}:\n--- ts\n${tsRun.authLines.join("\n")}\n--- rust\n${rsRun.authLines.join("\n")}\n`,
    );
  }
  writeFileSync(join(out, `${cfg.label}-ts.json`), JSON.stringify(Object.fromEntries(ts), null, 1));
  writeFileSync(
    join(out, `${cfg.label}-rust.json`),
    JSON.stringify(Object.fromEntries(rs), null, 1),
  );
}
const summary = `admin-auth: ${equal} equal, ${expected} expected divergences, ${failures} failures, ${seenTokens.size} distinct tokens`;
writeFileSync(join(out, "report.txt"), `${report.join("\n")}\n${summary}\n`);
console.log(report.join("\n"));
console.log(summary);
rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
