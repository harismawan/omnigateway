#!/usr/bin/env bun
/**
 * Conformance for the admin keys/models/catalog/settings/password routes
 * (roadmap A5): the TS gateway binary and the Rust one, each on its own copy
 * of one seeded database, raw HTTP/1.1, compared as status + sorted headers +
 * body bytes, plus the whole database after every step.
 *
 *   bun conformance/e2e/admin-routes.ts --ts <ts-binary> --rust <rust-binary> --out <dir>
 *
 * Every step runs as one of three callers: `admin` and `viewer` (cookies
 * each binary minted at the start of its own run) or `anon`. A configuration
 * boots both binaries on copies of one seed; after each step the database
 * (every table but the ones the gateway itself writes on its own clock) is
 * dumped and the two dumps compared, so a write must land identically and a
 * refusal must change nothing.
 *
 * Masks, each validated first (anything failing validation is compared raw):
 * - header `date` (IMF, within ±120 s);
 * - a minted key's `id` (UUID v4), `prefix` and `key` (`sk-omni-` + 43
 *   base64url, prefix its first 12): mapped to `<id#n>` / `<key#n>` in
 *   mint order, per binary, so a later step names "the key minted second";
 * - `createdAt` / `revokedAt` / timestamps: an integer within ±120 s of now
 *   reads `<now>`;
 * - in the database dump, the same id/key/hash/prefix maps and timestamps.
 *
 * `{{id:n}}` in a target or body is the n-th minted key's id *for that
 * binary*; `{{seed}}` the seeded key's id.
 *
 * Beyond equality, asserted on each binary by itself:
 * - a raw key occurs exactly once, textually, in everything the driver
 *   reads back (every response's head and body, and the process's stdout and
 *   stderr): in the body of its own creation's answer. Nothing else the
 *   gateway writes (the database aside, which is dumped and compared) is
 *   inspected;
 * - every response's `content-length` is the length of the body it sent
 *   (a HEAD answer and a 204/304 send none, whatever length they declare);
 * - a key minted over the API authenticates on `/v1/models` within 1 s, and
 *   one revoked over the API is refused within 1 s (the spec's snapshot
 *   invalidation bound);
 * - a password change ends every session (the caller's included), a viewer
 *   password change ends viewer sessions only.
 */
import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
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
  },
});
if (flags.ts === undefined || flags.rust === undefined) {
  console.error("usage: admin-routes.ts --ts <binary> --rust <binary> [--out dir] [--only config]");
  process.exit(2);
}

const REPO = resolve(import.meta.dir, "../..");
const KEY = "conformance-admin-routes-encryption-key-01";
const FIELD_KEY = pbkdf2Sync(KEY, "omnigateway-field-encryption-v1", 210000, 32, "sha256");
const PORT = Number(process.env.A7_TEST_PORT ?? 18443);
mkdirSync("/tmp/opencode", { recursive: true });
const work = mkdtempSync("/tmp/opencode/omni-admin-routes-");
const out = flags.out ?? join(work, "out");
mkdirSync(out, { recursive: true });
const children: Subprocess[] = [];
const credentialUpstream = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT + 1,
  fetch: (request) =>
    request.headers.get("authorization") !== "Bearer secret-a6-2"
      ? new Response("wrong credential", { status: 401 })
      : new Response(
          'data: {"id":"chatcmpl-a6","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-a6","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
});
process.on("exit", () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PASSWORD = "correct-horse-battery";
const VIEWER = "viewer-password-42";
const ARGON2 = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;
const adminHash = await Bun.password.hash(PASSWORD, ARGON2);
const viewerHash = await Bun.password.hash(VIEWER, ARGON2);

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
async function cli(args: string[]): Promise<unknown> {
  const p = Bun.spawn(
    [...(flags.cli ?? "").split(/\s+/).filter(Boolean), "--root", seedRoot, "--json", ...args],
    {
      cwd: REPO,
      env: { ...env, OMNI_DB_PATH: join(seedRoot, "omni.db") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [o, e, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`omni ${args.join(" ")}: ${e}`);
  return JSON.parse(o);
}
writeFileSync(
  join(seedRoot, ".env"),
  `OMNI_ENCRYPTION_KEY=${KEY}\nOMNI_DB_PATH=${join(seedRoot, "omni.db")}\n`,
);
const seeded = (await cli([
  "keys",
  "create",
  "--label",
  "seed",
  "--limit",
  "requests:1m=50",
  "--model-limit",
  "m1:tokens:5h=1000",
])) as { id: string; key: string };
const SEED_ID = seeded.id;
const SEED_KEY = seeded.key;
const seedDb = join(seedRoot, "omni.db");
{
  const d = new Database(seedDb);
  d.run("PRAGMA busy_timeout=5000");
  // Fixed timestamps: the seed's own rows must not read as "now".
  d.run("UPDATE api_keys SET created_at = 1700000000000");
  d.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('adminPasswordHash', ?)", [
    adminHash,
  ]);
  d.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('viewerPasswordHash', ?)", [
    viewerHash,
  ]);
  d.close();
}
const CREDS_SQL = [
  `INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('cred-kilo','kilo','Kilo OAuth','oauth','{}',1,1)`,
  `INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('cred-custom','custom','Local','apiKey','{"endpointId":"ep1"}',1,1)`,
  `INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('cred-q1','qoder','Q1','oauth','{"modelCatalog":{"version":1,"models":[{"id":"zeta","name":"Zeta","limits":{"contextWindow":2000,"maxOutputTokens":100}},{"id":"alpha","name":"Alpha"},{"id":"Beta","name":"B1","limits":{"contextWindow":5}},{"id":"_u","name":"U"},{"id":"bad\\u0001","name":"x"}]}}',1,1)`,
  `INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('cred-q2','qoder','Q2','oauth','{"modelCatalog":{"version":1,"models":[{"id":"zeta","name":"Zeta2","limits":{"contextWindow":1000,"maxOutputTokens":300}},{"id":"\\u00e9clair","name":"E"},{"id":"alpha","name":"A2","limits":{"contextWindow":7}}]}}',1,1)`,
];

/** A copy of the seed database with these statements applied. */
function db(name: string, sql: string[] = []): string {
  const file = join(work, `${name}.db`);
  copyFileSync(seedDb, file);
  const d = new Database(file);
  d.run("PRAGMA busy_timeout=5000");
  for (const s of sql) d.run(s);
  d.close();
  return file;
}

// ------------------------------------------------------------ raw HTTP

type Ex = { status: number; head: [string, string][]; body: Buffer };
type Who = "admin" | "viewer" | "anon";
type Req = {
  method?: string;
  target: string;
  headers?: [string, string][];
  timestamps?: "unchanged" | "disable" | "enable";
  body?: string;
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
    s.on("error", () => {});
    s.on("close", () => {
      clearTimeout(timer);
      res(parse(Buffer.concat(chunks)));
    });
    const method = r.method ?? "GET";
    const h = (r.headers ?? []).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    const body = r.body === undefined ? undefined : Buffer.from(r.body, "utf8");
    const framing =
      body !== undefined || ["POST", "PUT", "PATCH", "DELETE"].includes(method)
        ? `content-length: ${body?.length ?? 0}\r\n`
        : "";
    s.write(
      Buffer.from(
        `${method} ${r.target} HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\nconnection: close\r\n${h}${framing}\r\n`,
        "latin1",
      ),
    );
    if (body !== undefined) s.write(body);
  });
}

// ------------------------------------------------------------ masks

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RAW = /^sk-omni-[A-Za-z0-9_-]{43}$/;
const allRawKeys = new Map<string, string>(); // raw key -> binary label
const nearNow = (n: unknown) =>
  typeof n === "number" && Number.isInteger(n) && Math.abs(n - Date.now()) < 120_000;

/** Occurrences of `needle` in `hay`, overlapping ones included. */
function occurrences(hay: Buffer, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/**
 * What is wrong with one response's framing, judged by itself (so two
 * binaries wrong alike still fail), or `null`.
 *
 * A HEAD answer and a 1xx/204/304 carry no body: none may arrive, and a
 * declared length (the representation's, for HEAD) need only be a number.
 * Any other answer that declares a length declares it once, in digits, and
 * sends exactly that many bytes. A chunked answer declares none. An answer
 * with neither is delimited by the close and has nothing to check.
 */
function lengthProblem(method: string, x: Ex): string | null {
  const lengths = x.head.filter(([k]) => k === "content-length").map(([, v]) => v);
  const chunked = x.head.some(([k, v]) => k === "transfer-encoding" && /chunked/i.test(v));
  for (const v of lengths) if (!/^\d+$/.test(v)) return `content-length "${v}" is not a number`;
  if (lengths.length > 1) return `${lengths.length} content-length headers`;
  if ((x.status < 200 || x.status === 204) && lengths.length > 0)
    return `content-length forbidden on ${x.status}`;
  if (method === "HEAD" || x.status === 204 || x.status === 304 || x.status < 200)
    return x.body.length === 0
      ? null
      : `${x.body.length} body bytes on a ${method} ${x.status} answer`;
  if (chunked) return lengths.length > 0 ? "content-length beside chunked encoding" : null;
  const [declared] = lengths;
  return declared === undefined || Number(declared) === x.body.length
    ? null
    : `content-length ${declared}, body ${x.body.length}`;
}
{
  // The check checks: equal wrong lengths are wrong, no-body answers are not.
  const ex = (status: number, head: [string, string][], body = ""): Ex => ({
    status,
    head,
    body: Buffer.from(body),
  });
  const cl = (v: string): [string, string] => ["content-length", v];
  const cases: [string, Ex, boolean][] = [
    ["GET", ex(200, [cl("1")], "x"), true],
    ["GET", ex(200, [cl("99")], "x"), false],
    ["GET", ex(200, [cl("1"), cl("1")], "x"), false],
    ["GET", ex(200, [cl("1x")], "x"), false],
    ["GET", ex(200, [], "x"), true],
    ["HEAD", ex(200, [cl("99")]), true],
    ["HEAD", ex(200, [cl("1")], "x"), false],
    ["DELETE", ex(204, []), true],
    ["DELETE", ex(204, [], "x"), false],
    ["GET", ex(304, [cl("12")]), true],
    ["GET", ex(200, [["transfer-encoding", "chunked"]], "1\r\nx\r\n0\r\n\r\n"), true],
    ["GET", ex(200, [["transfer-encoding", "chunked"], cl("1")], "x"), false],
    ...([200, 101, 204, 304] as const).map((status): [string, Ex, boolean] => [
      status === 200 ? "HEAD" : "GET",
      ex(status, [["transfer-encoding", "chunked"]], "x"),
      false,
    ]),
    ["GET", ex(101, [cl("0")]), false],
    ["GET", ex(204, [cl("0")]), false],
  ];
  for (const [method, x, ok] of cases)
    if ((lengthProblem(method, x) === null) !== ok)
      throw new Error(`lengthProblem self-check: ${method} ${JSON.stringify(x.head)}`);
  if (occurrences(Buffer.from("aXaXa"), "aXa") !== 2) throw new Error("occurrences self-check");
}

/** Per-binary state: the ids, keys, prefixes and hashes it minted. */
class Masker {
  ids: string[] = [];
  keys: string[] = [];
  /**
   * Every textual occurrence of a raw key in anything this binary sent:
   * `where\u0000raw`, once per occurrence.
   */
  sightings: string[] = [];
  /** The step that minted each key, by raw key. */
  mintedIn = new Map<string, string>();

  /** Records a creation answer (validated) and returns its body masked. */
  mint(body: unknown, step: string, side: string): void {
    if (typeof body !== "object" || body === null) return;
    const b = body as Record<string, unknown>;
    const credential = b.credential as { id?: string } | undefined;
    if (credential?.id && UUID.test(credential.id)) {
      if (this.ids.includes(credential.id)) throw new Error("credential id minted twice");
      this.ids.push(credential.id);
      return;
    }
    if (typeof b.id !== "string" || !UUID.test(b.id)) return;
    if (typeof b.key !== "string" || !RAW.test(b.key)) return;
    if (b.prefix !== b.key.slice(0, 12)) return;
    if (this.ids.includes(b.id)) throw new Error(`${side}: id minted twice`);
    if (allRawKeys.has(b.key)) throw new Error(`raw key minted twice (${side}, ${step})`);
    allRawKeys.set(b.key, side);
    this.mintedIn.set(b.key, step);
    this.ids.push(b.id);
    this.keys.push(b.key);
  }

  text(s: string): string {
    let t = s;
    this.ids.forEach((id, i) => {
      t = t.replaceAll(id, `<id#${i}>`);
    });
    this.keys.forEach((k, i) => {
      t = t.replaceAll(k, `<key#${i}>`);
      t = t.replaceAll(k.slice(0, 12), `<prefix#${i}>`);
      t = t.replaceAll(new Bun.CryptoHasher("sha256").update(k).digest("hex"), `<hash#${i}>`);
    });
    return t;
  }
}

/** Masks timestamps within ±120 s inside JSON text, by key. */
function maskTimes(json: string): string {
  return json.replace(
    /"(createdAt|revokedAt|created_at|revoked_at|updatedAt|updated_at|disabledAt|disabled_at)":(\d{13})/g,
    (m, k, v) => (nearNow(Number(v)) ? `"${k}":"<now>"` : m),
  );
}

function normalize(x: Ex, m: Masker): string {
  const now = Date.now() / 1000;
  const head = x.head
    .filter(([k, v]) => !(k === "connection" && v === "close"))
    .map(([k, v]) => {
      if(k==="content-disposition") {
        const match=/^attachment; filename="omnigateway-logs-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.(csv|jsonl)"$/.exec(v);
        if(match && Math.abs(Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`)-Date.now())<120000)return `content-disposition: attachment; filename="omnigateway-logs-<now>.${match[5]}"`;
      }
      if (k === "date") {
        const t = Date.parse(v);
        if (!Number.isNaN(t) && Math.abs(t / 1000 - now) < 120) return "date: <date>";
      }
      // Masked where it is this body's length (masked ids and timestamps
      // change it); otherwise compared raw, as a HEAD answer's is. Whether
      // it is *right* is `lengthProblem`'s, per binary.
      if (k === "content-length" && /^\d+$/.test(v) && Number(v) === x.body.length)
        return "content-length: <body length>";
      return `${k}: ${v}`;
    })
    .sort();
  let body=x.body;
  if(x.head.some(([k,v])=>k==="transfer-encoding"&&v==="chunked")) {
    const parts:Buffer[]=[];let at=0;
    for(;;){const end=body.indexOf("\r\n",at);if(end<0)throw new Error("invalid chunk header");const n=Number.parseInt(body.subarray(at,end).toString(),16);if(!Number.isFinite(n))throw new Error("invalid chunk size");at=end+2;if(n===0)break;parts.push(body.subarray(at,at+n));at+=n+2;}
    body=Buffer.concat(parts);
  }
  return `${x.status}\n${head.join("\n")}\n\n${maskTimes(m.text(body.toString("latin1")))}`;
}

/**
 * A `/v1` answer: [`normalize`], with the instants a refusal reports (a
 * reset, a `retry-after`) masked, since the two binaries answer at different
 * instants. Masked only: nothing here reads them against the clock, so this
 * driver shows the headers' presence and shape, not that a reset is right.
 */
function normalizeV1(x: Ex, m: Masker): string {
  return normalize(x, m)
    .replace(/^(anthropic-ratelimit-[a-z-]+-reset): \S+$/gm, "$1: <instant>")
    .replace(/^(x-ratelimit-reset-[a-z-]+): \S+$/gm, "$1: <duration>")
    .replace(/^retry-after: \d+$/gm, "retry-after: <s>");
}

/** Every table but the ones the gateway writes on its own clock, sorted. */
function dump(file: string, m: Masker): string {
  const d = new Database(file, { readonly: true });
  d.run("PRAGMA busy_timeout=5000");
  const tables = (
    d.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter(
      (n) => !["nodes", "request_logs", "usage_rollup", "usage_daily", "migrations"].includes(n),
    );
  const parts: string[] = [];
  for (const t of tables) {
    const rows = d
      .query(`SELECT * FROM "${t}"`)
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        if (t === "credentials")
          for (const col of ["access_token", "refresh_token", "api_key", "id_token"]) {
            if (row[col] === null) continue;
            const parts = String(row[col]).split(":");
            if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1")
              throw new Error(`unencrypted ${col}`);
            const decipher = createDecipheriv(
              "aes-256-gcm",
              FIELD_KEY,
              Buffer.from(parts[2] ?? "", "hex"),
            );
            decipher.setAuthTag(Buffer.from(parts[4] ?? "", "hex"));
            row[col] = Buffer.concat([
              decipher.update(Buffer.from(parts[3] ?? "", "hex")),
              decipher.final(),
            ]).toString("utf8");
          }
        // Password hashes are salted: equal iff both are the seed's, or
        // both changed (verified by login elsewhere).
        if (t === "settings" && /PasswordHash$/.test(String(row.key))) {
          const v = String(row.value);
          row.value =
            v === adminHash
              ? "<seed-admin>"
              : v === viewerHash
                ? "<seed-viewer>"
                : /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/.test(v)
                  ? "<new-argon2id>"
                  : v;
        }
        return maskTimes(
          m.text(JSON.stringify(row, (_, v) => (typeof v === "bigint" ? `${v}n` : v))),
        );
      })
      .sort();
    parts.push(`${t}: ${rows.join("\n  ")}`);
  }
  d.close();
  return parts.join("\n");
}

// ------------------------------------------------------------ steps

type HttpStep = {
  expectedStatus?: number;
  kind?: "http";
  name: string;
  who: Who;
  method?: string;
  target: string;
  body?: string;
  headers?: [string, string][];
};
type Step =
  | { kind: "logs-walk"; name: string }
  | { kind: "usage-traffic"; name: string }
  | HttpStep
  | { kind: "restart-other"; name: string }
  | { kind: "credential-routing"; name: string; enabled: boolean; model?: string }
  /** `n` copies of `step` at once; statuses compared as a multiset, DB after. */
  | {
      kind: "concurrent";
      name: string;
      steps: HttpStep[];
      /** For an outcome the scheduler picks: a verdict instead of a DB dump. */
      settle?: (file: string) => string;
    }
  /**
   * Poll `/v1/models` with a raw key until it answers `expect`. Asserted on
   * each binary on its own: the answer must come from a request that both
   * started and finished within 1 s of the step's start.
   */
  | { kind: "admitted"; name: string; keyIndex: number | string; expect: number }
  /** Poll `/v1/models` with the seeded key until `id` is (or is not) listed, ≤ 1 s, per binary. */
  | { kind: "listed"; name: string; id: string; present: boolean }
  /**
   * One `/v1` request authenticated by a raw key (a minted key's index, or
   * a literal raw key), compared like any exchange.
   */
  | {
      kind: "v1";
      name: string;
      key: number | string;
      method?: string;
      target: string;
      body?: string;
      /**
       * A documented divergence, pinned on both sides: each binary's answer
       * must be exactly its text here, and the two must differ. Anything
       * else (equal answers, or a different difference) fails. Counted as an
       * expected divergence, never as equal; the database after the step is
       * still compared.
       */
      expectDiff?: { why: string; ts: string; rust: string };
    }
  /** Log in again (after a session-ending change). */
  | { kind: "relogin"; name: string; who: "admin" | "viewer"; password: string; mode?: string }
  /** A hand edit while the gateway runs. */
  | { kind: "sql"; name: string; sql: string[] }
  /** Let the gateway's own writes land (a completed row, its debit). */
  | { kind: "counter-barrier"; name: string; id: string; status: number };

const J: [string, string] = ["content-type", "application/json"];
const as = (who: Who, method: string, target: string, body?: string, name?: string): HttpStep => ({
  name:
    name ??
    `${who} ${method} ${target} ${body === undefined ? "" : body.length > 100 ? `${body.slice(0, 80)}…(${body.length})` : body}`,
  who,
  method,
  target,
  ...(body === undefined ? {} : { body, headers: [J] }),
});
/** The same request as each caller: anon and viewer first (refusals for writes). */
const everyone = (method: string, target: string, body?: string): HttpStep[] => [
  as("anon", method, target, body),
  as("viewer", method, target, body),
  as("admin", method, target, body),
];

const TARGET = {
  provider: "anthropic",
  model: "claude-x",
  tier: 1,
  weight: 1,
  costPerMTok: { input: 1, output: 2 },
  capabilities: { tools: true, images: false, reasoning: true },
};
const model = (id: string, extra: Record<string, unknown> = {}, targets: unknown[] = [TARGET]) =>
  JSON.stringify({ id, strategy: "score", isAlias: false, targets, ...extra });
const deep = (n: number, inner = "0") => `${"[".repeat(n)}${inner}${"]".repeat(n)}`;

function readSteps(): Step[] {
  const s: Step[] = [];
  for (const t of ["/api/models", "/api/catalog", "/api/keys", "/api/settings"]) {
    s.push(...everyone("GET", t));
    s.push(as("admin", "HEAD", t), as("viewer", "HEAD", t));
    s.push(as("admin", "GET", `${t}?x=1`), as("admin", "GET", `${t}/`));
    s.push(as("admin", "POST", t, "{}"), as("admin", "PATCH", t, "{}"), as("admin", "DELETE", t));
  }
  s.push(as("admin", "GET", "/api/models/x"), as("admin", "GET", "/api/keys/x"));
  // Body shapes `request.json()` accepts or refuses, on every body-reading route.
  for (const [method, target, good] of [
    ["PUT", "/api/models/shape", model("shape")],
    ["POST", "/api/keys", '{"label":"shape"}'],
    ["PUT", "/api/settings", settings()],
    ["PUT", "/api/settings/viewer-password", '{"password":"viewer-password-42"}'],
  ] as const) {
    for (const body of [`\ufeff${good}`, `  ${good}\n`, `${good} x`, `${good}}`, "\ufeff", "  "]) {
      s.push(as("admin", method, target, body));
    }
    for (const ct of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      s.push({
        ...as("admin", method, target, good),
        name: `admin ${method} ${target} as ${ct}`,
        headers: [["content-type", ct]],
      });
    }
    s.push({ ...as("admin", method, target), name: `admin ${method} ${target} with no body` });
  }
  s.push(as("admin", "PUT", "/api/models/deep", `{"x":${deep(50_000)},${model("deep").slice(1)}`));
  s.push(as("admin", "POST", "/api/keys", `{"x":${deep(50_000, "{}")},"label":"deep"}`));
  s.push(
    as("admin", "GET", "/api/settings/password"),
    as("admin", "POST", "/api/settings/password", "{}"),
  );
  return s;
}

function modelSteps(): Step[] {
  const s: Step[] = [];
  s.push(...everyone("PUT", "/api/models/m-a", model("m-a")));
  s.push(...everyone("DELETE", "/api/models/m-a"));
  s.push(as("admin", "PUT", "/api/models/m-a", model("m-a")));
  for (const body of [
    "",
    " ",
    "{bad",
    "null",
    "[]",
    "5",
    "1e400",
    '"s"',
    "{}",
    model("other"),
    model("m-b", { extra: 1 }),
    model("m-b", { strategy: "Score" }),
    // Spliced as text: `JSON.stringify(Infinity)` would send `null`.
    model("m-b", { isAlias: "INF" }).replace('"INF"', "1e400"),
    model("m-b", {}, []),
    model("m-b", {}, [null]),
    model("m-b", {}, [{ ...TARGET, tier: 0 }]),
    model("m-b", {}, [{ ...TARGET, provider: "Bad" }]),
    model("m-b", {}, [{ ...TARGET, provider: "custom" }]),
    model("m-b", {}, [{ ...TARGET, provider: "custom", endpointId: "nope" }]),
    model("m-b", {}, [{ ...TARGET, provider: "custom", endpointId: " ep1 " }]),
    model("m-b", {}, [{ ...TARGET, credentialId: "a b" }]),
    model("m-b", {}, [{ ...TARGET, zz: 1, 5: 2 }]),
    model("m-b", {}, [{ ...TARGET, provider: "kilo", model: "kilo-auto/free" }]),
    model("m-b", {}, [{ ...TARGET, provider: "kilo", model: "anthropic/claude-fable-5" }]),
    model("m-b", {}, [{ ...TARGET, provider: "plugin-x" }]),
    `{"id":"m-b","strategy":"score","isAlias":false,"targets":[${JSON.stringify(TARGET)}],"__proto__":{"x":1}}`,
    `{"id":"m-b","id":"m-b","strategy":"score","isAlias":false,"targets":[${JSON.stringify(TARGET)}],"deep":${deep(20000)}}`,
    `{"id":"m-b","strategy":"score","isAlias":false,"targets":[{"provider":"anthropic","model":"\\ud800x","tier":1,"weight":1e-300,"costPerMTok":{"input":0,"output":1e308,"cacheRead":0.1},"capabilities":{"tools":true,"images":true,"reasoning":false}}]}`,
  ]) {
    s.push(as("admin", "PUT", "/api/models/m-b", body));
  }
  // Path ids: encoded, numeric, unicode, undecodable, slashes, case.
  s.push(as("admin", "PUT", "/api/models/a%20b", model("a b")));
  s.push(as("admin", "PUT", "/api/models/a+b", model("a b")));
  s.push(as("admin", "PUT", "/api/models/a%2Fb", model("a/b")));
  s.push(as("admin", "PUT", "/api/models/a%2Fb", model("a%2Fb")));
  s.push(as("admin", "PUT", "/api/models/%E2%82%AC", model("€")));
  s.push(as("admin", "PUT", "/api/models/123", model("123")));
  s.push(
    as(
      "admin",
      "PUT",
      "/api/models/123",
      JSON.stringify({ id: 123, strategy: "score", isAlias: false, targets: [TARGET] }),
    ),
  );
  s.push(as("admin", "PUT", "/api/models/%ZZ", model("%ZZ")));
  s.push(as("admin", "PUT", "/api/models/%ED%A0%80", model("\ud800")));
  s.push(as("admin", "PUT", "/api/models/%ED%A0%80", "{}"));
  s.push(as("admin", "PUT", "/api/models/x/../m-c", model("m-c")));
  s.push(as("admin", "PUT", "/api/models/m-d/", model("m-d")));
  s.push(as("admin", "PUT", "/api/models/", model("")));
  s.push(as("admin", "PUT", "/api/models/a/b", model("a/b")));
  s.push(as("admin", "PUT", "/API/models/m-e", model("m-e")));
  // Replace, grandfathering, removal.
  s.push(
    as(
      "admin",
      "PUT",
      "/api/models/kilo-m",
      model("kilo-m", {}, [{ ...TARGET, provider: "kilo", model: "anthropic/claude-fable-5" }]),
    ),
  );
  s.push(
    as("admin", "PUT", "/api/models/m-a", model("m-a", { strategy: "weighted", isAlias: true })),
  );
  s.push(as("admin", "GET", "/api/models"));
  s.push({
    kind: "listed",
    name: "a model put over the API is listed on /v1 within 1 s",
    id: "m-a",
    present: true,
  });
  s.push(as("admin", "DELETE", "/api/models/m-a"));
  s.push({
    kind: "listed",
    name: "a model removed over the API leaves /v1 within 1 s",
    id: "m-a",
    present: false,
  });
  s.push(as("admin", "DELETE", "/api/models/m-a"));
  s.push(as("admin", "DELETE", "/api/models/nope"));
  s.push(as("admin", "DELETE", "/api/models/%ZZ"));
  s.push(as("admin", "DELETE", "/api/models/a%2Fb"));
  s.push(as("admin", "DELETE", "/api/models/a%2Fb", "{bad"));
  s.push(as("admin", "GET", "/api/models"));
  s.push({
    kind: "concurrent",
    name: "8 concurrent puts of one model",
    steps: Array.from({ length: 8 }, (_, i) =>
      as(
        "admin",
        "PUT",
        "/api/models/race",
        model("race", {
          strategy:
            ["score", "priority", "roundRobin", "weighted"][i % 4] === "score" ? "score" : "score",
        }),
      ),
    ),
  });
  s.push(as("admin", "GET", "/api/models"));
  return s;
}

const keyEdits = (id: string) =>
  [
    [
      "limits",
      '{"limits":{"requests":{"1m":5},"spend":{"5h":2.5},"models":{"m1":{"concurrency":2}}}}',
    ],
    ["models", '{"modelAllowlist":["a","\\ud800"]}'],
    ["expiry", '{"expiresAt":4102444800000}'],
    ["guardrail", '{"policy":"  only code  "}'],
    ["smart-routing", '{"enabled":true}'],
  ].map(([e, b]) => [`/api/keys/${id}/${e}`, b] as const);

function keySteps(): Step[] {
  const s: Step[] = [];
  s.push(...everyone("POST", "/api/keys", "{}"));
  for (const body of [
    "",
    "{bad",
    "null",
    "[]",
    "5",
    '{"label":""}',
    '{"label":1e400}',
    '{"zz":1,"5":2}',
    '{"__proto__":{"a":1}}',
    '{"limits":{"__proto__":{}}}',
    '{"limits":{"requests":{"__proto__":60}}}',
    '{"limits":{"models":{"__proto__":{"concurrency":1}}}}',
    '{"limits":{"models":{"m":{}}}}',
    '{"limits":{"models":{"":{"concurrency":1}}}}',
    '{"expiresAt":0}',
    '{"expiresAt":8640000000000001}',
    '{"modelAllowlist":["a",""]}',
    '{"guardrailPolicy":"   "}',
    `{"guardrailPolicy":"${"p".repeat(4001)}"}`,
    `{"x":${deep(30000)}}`,
  ]) {
    s.push(as("admin", "POST", "/api/keys", body));
  }
  // Successful mints (key indices 0..).
  for (const body of [
    "{}",
    '{"label":"full","modelAllowlist":["m1","\\ud800x"],"limits":{"requests":{"1m":5,"5h":null},"spend":{"1w":1.5},"concurrency":3,"models":{"9":{"tokens":{"1w":7}},"m1":{"requests":{"1m":1}},"\\udc00":{"concurrency":1}}},"bodyLoggingOptOut":true,"expiresAt":4102444800000,"guardrailPolicy":"  code only \\ud800 ","smartRouting":true}',
    '{"label":"dup","label":"last wins","modelAllowlist":[],"expiresAt":4.1024448e12}',
    '{"label":"lone \\ud800 label"}',
    `{"label":"deepish","limits":{"models":{"${"m".repeat(256)}":{"concurrency":1}}}}`,
  ]) {
    s.push(as("admin", "POST", "/api/keys", body));
  }
  s.push({
    kind: "admitted",
    name: "minted key #0 admitted on /v1 within 1 s",
    keyIndex: 0,
    expect: 200,
  });
  // Its allowlist and a model override name lone surrogates: still readable.
  s.push({
    kind: "admitted",
    name: "minted key #1 (lone surrogates) admitted on /v1 within 1 s",
    keyIndex: 1,
    expect: 200,
  });
  s.push(as("admin", "GET", "/api/keys"));
  s.push(as("viewer", "GET", "/api/keys"));
  // Edits: every caller, then admin variants, then unknown ids.
  for (const [t, b] of keyEdits("{{id:1}}")) s.push(...everyone("PUT", t, b));
  for (const [t, b] of keyEdits("{{seed}}")) s.push(as("admin", "PUT", t, b));
  for (const [t, b] of keyEdits("nope")) s.push(as("admin", "PUT", t, b));
  for (const [t, b] of keyEdits("%ZZ")) s.push(as("admin", "PUT", t, b));
  for (const [edit, body] of [
    ["limits", "{}"],
    ["limits", '{"limits":null}'],
    ["limits", '{"limits":{}}'],
    ["limits", '{"limits":{"bogus":1}}'],
    ["limits", '{"limits":{"requests":{"1m":0}},"x":1}'],
    ["limits", "[]"],
    ["limits", "{bad"],
    ["models", "{}"],
    ["models", '{"modelAllowlist":null}'],
    ["models", '{"modelAllowlist":[]}'],
    ["models", '{"modelAllowlist":[""]}'],
    ["expiry", "{}"],
    ["expiry", '{"expiresAt":null}'],
    ["expiry", '{"expiresAt":1}'],
    ["expiry", '{"expiresAt":1.5}'],
    ["guardrail", "{}"],
    ["guardrail", '{"policy":null}'],
    ["guardrail", '{"policy":"\\ud800 only"}'],
    ["guardrail", '{"policy":" "}'],
    ["smart-routing", "{}"],
    ["smart-routing", '{"enabled":false}'],
    ["smart-routing", '{"enabled":1}'],
  ] as const) {
    s.push(as("admin", "PUT", `/api/keys/{{id:2}}/${edit}`, body));
  }
  s.push(as("admin", "PUT", "/api/keys/{{id:2}}/other", "{}"));
  s.push(as("admin", "POST", "/api/keys/{{id:2}}/limits", "{}"));
  s.push(as("admin", "PUT", "/api/keys/{{id:2}}/limits/", '{"limits":{}}'));
  s.push(as("admin", "GET", "/api/keys"));
  s.push({
    kind: "concurrent",
    name: "6 concurrent edits of one key",
    steps: [
      as("admin", "PUT", "/api/keys/{{id:3}}/limits", '{"limits":{"requests":{"1m":9}}}'),
      as("admin", "PUT", "/api/keys/{{id:3}}/models", '{"modelAllowlist":["x"]}'),
      as("admin", "PUT", "/api/keys/{{id:3}}/expiry", '{"expiresAt":4102444800001}'),
      as("admin", "PUT", "/api/keys/{{id:3}}/guardrail", '{"policy":"g"}'),
      as("admin", "PUT", "/api/keys/{{id:3}}/smart-routing", '{"enabled":true}'),
      as("admin", "PUT", "/api/keys/{{id:3}}/limits", '{"limits":{"requests":{"1m":9}}}'),
    ],
  });
  // Revocation.
  s.push(...everyone("DELETE", "/api/keys/{{id:0}}"));
  s.push({
    kind: "admitted",
    name: "revoked key #0 refused on /v1 within 1 s",
    keyIndex: 0,
    expect: 401,
  });
  s.push(as("admin", "DELETE", "/api/keys/{{id:0}}"));
  s.push(as("admin", "DELETE", "/api/keys/nope"));
  s.push(as("admin", "DELETE", "/api/keys/%ZZ"));
  s.push(as("admin", "DELETE", "/api/keys/{{id:1}}/x"));
  s.push(as("admin", "PUT", "/api/keys/{{id:0}}/limits", '{"limits":{}}'));
  s.push(as("admin", "GET", "/api/keys"));
  // Last: rows minted in the same millisecond list in insertion order,
  // which is the scheduler's choice; the (sorted) database dump compares them.
  s.push({
    kind: "concurrent",
    name: "4 concurrent mints",
    steps: Array.from({ length: 4 }, (_, i) =>
      as("admin", "POST", "/api/keys", `{"label":"race ${i}"}`),
    ),
  });
  return s;
}

const SETTINGS = {
  weights: { tier: 1, health: 2, quota: 3, cost: 4, latency: 5, load: 6 },
  maxAttempts: 4,
  requestDeadlineMs: 0,
  breakerThreshold: 3,
  breakerCooldownMs: 30000,
  logRetentionDays: 30,
  quotaPollIntervalMs: 0,
  rtkEnabled: false,
  autoCacheEnabled: true,
  ponytailMode: "off",
  bodyLoggingEnabled: false,
  bodyLoggingCaptureStreamChunks: false,
};
const settings = (extra: Record<string, unknown> = {}) => JSON.stringify({ ...SETTINGS, ...extra });

function settingsSteps(): Step[] {
  const s: Step[] = [];
  s.push(...everyone("PUT", "/api/settings", settings()));
  for (const body of [
    "",
    "{bad",
    "null",
    "1e400",
    "{}",
    settings({ maxAttempts: 0 }),
    settings({ maxAttempts: "INF" }).replace('"INF"', "1e400"),
    settings({ maxAttempts: "INF" }).replace('"INF"', "-1e400"),
    settings({ weights: { tier: 1 } }),
    settings({ weights: { ...SETTINGS.weights, recency: 1 } }),
    settings({ ponytailMode: "LITE" }),
    settings({ guardrailModel: "   " }),
    settings({ guardrailModel: "x".repeat(257) }),
    settings({ smartRouterTimeoutMs: 60001 }),
    `{${settings().slice(1, -1)},"guardrailModel":-1e400}`,
  ]) {
    s.push(as("admin", "PUT", "/api/settings", body));
  }
  s.push(as("admin", "GET", "/api/settings"));
  for (const body of [
    settings({ extra: { deep: [1, 2] }, __proto__: undefined }),
    `{${settings().slice(1, -1)},"__proto__":{"rtkEnabled":true},"z\\ud800":"\\udc00"}`,
    settings({
      guardrailModel: "  g  ",
      smartRouterEnabled: true,
      smartRouterClassifierModel: "loc",
      smartRouterLocalModel: "anthropic/claude-x",
      smartRouterPolicy: " p ",
    }),
    settings({ bodyRetentionDays: 7, snapshotKeepLatest: 100 }),
    settings({ guardrailModel: null, smartRouterLocalModel: "nothing-resolves" }),
    settings({ smartRouterClassifierModel: "loc", smartRouterLocalModel: "kilo-m" }),
    settings({ smartRouterClassifierModel: "custom/x", smartRouterLocalModel: "claude-y" }),
  ]) {
    s.push(as("admin", "PUT", "/api/settings", body));
    s.push(as("viewer", "GET", "/api/settings"));
  }
  s.push(
    as(
      "admin",
      "PUT",
      "/api/models/loc",
      model("loc", {}, [{ ...TARGET, provider: "custom", endpointId: "ep1" }]),
    ),
  );
  s.push(as("admin", "GET", "/api/settings"));
  // Concurrent whole-object saves: last writer wins, and which one is last is
  // the scheduler's choice. Asserted: each succeeds, and the stored value is
  // exactly one of the four (never a mixture); then a sequential save puts
  // both databases back in step.
  s.push({
    kind: "concurrent",
    name: "4 concurrent settings saves",
    steps: [1, 2, 3, 4].map((n) =>
      as("admin", "PUT", "/api/settings", settings({ maxAttempts: n })),
    ),
    settle: (file: string) => {
      const d = new Database(file, { readonly: true });
      d.run("PRAGMA busy_timeout=5000");
      const row = d.query("SELECT value FROM settings WHERE key='settings'").get() as {
        value: string;
      } | null;
      d.close();
      if (row === null) return "no settings row";
      const v = JSON.parse(row.value) as Record<string, unknown>;
      // Every field the four bodies share must be the shared value.
      const shared = Object.entries({ ...SETTINGS, maxAttempts: undefined }).every(([k, want]) => {
        if (want === undefined) return true;
        const canon = (x: unknown) =>
          JSON.stringify(x, (_, o) =>
            o !== null && typeof o === "object" && !Array.isArray(o)
              ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
              : o,
          );
        return canon(v[k]) === canon(want);
      });
      return shared && [1, 2, 3, 4].includes(v.maxAttempts as number)
        ? `one of the four saves, whole (maxAttempts ${typeof v.maxAttempts})`
        : `MIXED ${row.value}`;
    },
  });
  s.push(as("admin", "PUT", "/api/settings", settings({ maxAttempts: 4 })));
  s.push(as("admin", "GET", "/api/settings"));
  return s;
}

function passwordSteps(): Step[] {
  const s: Step[] = [];
  s.push(...everyone("PUT", "/api/settings/viewer-password", '{"password":"another-viewer-pw"}'));
  s.push(
    as("viewer", "GET", "/api/keys", undefined, "viewer still in after the viewer password change"),
  );
  for (const body of [
    "",
    "{bad",
    "null",
    "[]",
    "{}",
    '{"password":5}',
    '{"password":"short"}',
    `{"password":"${"é".repeat(11)}"}`,
    '{"password":"\\ud800bcdefghijk"}',
  ]) {
    s.push(as("admin", "PUT", "/api/settings/viewer-password", body));
  }
  s.push(as("admin", "PUT", "/api/settings/viewer-password", '{"password":"viewer-password-77"}'));
  s.push(
    as("viewer", "GET", "/api/keys", undefined, "viewer session ended by a viewer password change"),
  );
  s.push(
    as("admin", "GET", "/api/keys", undefined, "admin session survives a viewer password change"),
  );
  s.push({
    kind: "relogin",
    name: "viewer logs in with the new password",
    who: "viewer",
    password: "viewer-password-77",
    mode: "viewer",
  });
  s.push(as("viewer", "GET", "/api/keys", undefined, "viewer back in"));
  s.push(as("admin", "PUT", "/api/settings/viewer-password", '{"password":null}'));
  s.push(as("viewer", "GET", "/api/keys", undefined, "viewer gone after clear"));
  s.push(as("anon", "GET", "/api/status", undefined, "status after viewer clear"));
  s.push(as("admin", "PUT", "/api/settings/viewer-password", '{"password":"viewer-password-42"}'));
  s.push({ kind: "relogin", name: "viewer back", who: "viewer", password: VIEWER, mode: "viewer" });
  // Admin password.
  s.push(
    ...everyone(
      "PUT",
      "/api/settings/password",
      `{"current":"wrong-password-1","password":"new-password-1234"}`,
    ),
  );
  for (const body of [
    "",
    "{bad",
    "null",
    "{}",
    '{"current":"x"}',
    '{"current":5,"password":"new-password-1234"}',
    `{"current":"${PASSWORD}","password":"short"}`,
    '{"current":"wrong","password":"short"}',
    `{"current":"${PASSWORD} ","password":"new-password-1234"}`,
  ]) {
    s.push(as("admin", "PUT", "/api/settings/password", body));
  }
  s.push(as("admin", "GET", "/api/keys", undefined, "admin still in after refused changes"));
  s.push(
    as(
      "admin",
      "PUT",
      "/api/settings/password",
      `{"current":"${PASSWORD}","password":"new-password-1234"}`,
    ),
  );
  s.push(as("admin", "GET", "/api/keys", undefined, "admin session ended by the password change"));
  s.push(
    as(
      "viewer",
      "GET",
      "/api/keys",
      undefined,
      "viewer session ended by the admin password change",
    ),
  );
  s.push({ kind: "relogin", name: "old admin password refused", who: "admin", password: PASSWORD });
  s.push({
    kind: "relogin",
    name: "new admin password",
    who: "admin",
    password: "new-password-1234",
  });
  s.push(as("admin", "GET", "/api/keys", undefined, "admin back in"));
  return s;
}

/** A database whose stored values TS reads as `JSON.parse` does. */
function oddRowSteps(): Step[] {
  return [
    ...everyone("GET", "/api/keys"),
    as("admin", "GET", "/api/models"),
    as("admin", "GET", "/api/settings"),
    as("admin", "GET", "/api/catalog"),
    as("admin", "PUT", "/api/keys/odd-limits/smart-routing", '{"enabled":true}'),
    as("admin", "PUT", "/api/keys/odd-allow/expiry", '{"expiresAt":null}'),
    as("admin", "PUT", "/api/keys/odd-frac/smart-routing", '{"enabled":true}'),
    as("admin", "PUT", "/api/keys/odd-frac/guardrail", '{"policy":"p"}'),
    as("admin", "PUT", "/api/keys/odd-null/limits", '{"limits":{}}'),
    as("admin", "PUT", "/api/models/m-new", model("m-new")),
  ];
}

/**
 * Review A5-I1: model identity is exact UTF-16 on both sides. A lone
 * surrogate is never the U+FFFD SQLite stores it as, nor another lone
 * surrogate; distinct per-model overrides stay distinct.
 */
const IDENTITY_SQL = [
  `INSERT INTO virtual_models (id,targets,strategy) VALUES ('\ufffd','${JSON.stringify([TARGET])}','score')`,
  `INSERT INTO virtual_models (id,targets,strategy) VALUES ('plain','${JSON.stringify([TARGET])}','score')`,
  ...(
    [
      ["id-k1", '["\\ud800","plain"]', "{}"],
      ["id-k2", '["\\ufffd"]', "{}"],
      [
        "id-k3",
        null,
        '{"models":{"\\ud800":{"concurrency":1},"\\ufffd":{"requests":{"1m":1}},"\\udc00":{"requests":{"1m":5}}}}',
      ],
      ["id-k4", null, '{"requests":{"1m":50}}'],
      // Review A5-R2: one U+FFFD request per 5 h.
      ["id-k5", null, '{"requests":{"5h":1},"models":{"\\ufffd":{"requests":{"5h":1}}}}'],
      // ...and the key-wide subject, which that failed request does debit.
      ["id-k6", null, '{"requests":{"5h":1}}'],
    ] as const
  ).map(
    ([id, allow, limits]) =>
      `INSERT INTO api_keys (id,label,prefix,hash,model_allowlist,limits,created_at) VALUES ('${id}','${id}','${rawOf(id).slice(0, 12)}','${new Bun.CryptoHasher("sha256").update(rawOf(id)).digest("hex")}',${allow === null ? "NULL" : `'${allow}'`},'${limits}',1600000000000)`,
  ),
];

/** A fixed raw key for a hand-written row (never minted, never secret). */
function rawOf(id: string): string {
  return `sk-omni-${id.padEnd(43, "0")}`;
}

type ExpectDiff = { why: string; ts: string; rust: string };

/** The OpenAI-dialect 500 for an unencodable model, with `extra` headers. */
function refusal(extra: string[]): string {
  const head = [
    "content-length: <body length>",
    "content-type: application/json",
    "date: <date>",
    ...extra,
  ].sort();
  return `500\n${head.join("\n")}\n\n{"error":{"message":"String contained an illegal UTF-16 sequence.","type":"server_error","code":"server_error"}}`;
}

function identitySteps(): Step[] {
  const chat = (m: string) => `{"model":"${m}","messages":[{"role":"user","content":"hi"}]}`;
  const s: Step[] = [];
  for (const k of ["id-k1", "id-k2", "id-k3"]) {
    s.push({
      kind: "v1",
      name: `${k} GET /v1/models`,
      key: rawOf(k),
      method: "GET",
      target: "/v1/models",
    });
  }
  // The allowlist: refusals (401) where TS refuses, on both routes that parse.
  for (const [k, models] of [
    ["id-k1", ["\\ufffd", "\ufffd", "\\ud801", "\\udc00", "plain-not"]],
    ["id-k2", ["\\ud800", "\\ud801", " \\ud800 ", "\\ud800[1m]", "plain"]],
  ] as const) {
    for (const m of models) {
      s.push({
        kind: "v1",
        name: `${k} chat ${m}`,
        key: rawOf(k),
        target: "/v1/chat/completions",
        body: chat(m),
      });
      s.push({
        kind: "v1",
        name: `${k} count ${m}`,
        key: rawOf(k),
        target: "/v1/messages/count_tokens",
        body: chat(m),
      });
    }
  }
  // Per-model limits: U+FFFD's own 1/min, `\udc00`'s 5/min and `\ud801`
  // (no override) never alias each other.
  for (const m of ["\\ufffd", "\\ufffd", "\\ud801", "\\ud801", "\\udc00x", "\ufffd"]) {
    s.push({
      kind: "v1",
      name: `id-k3 count ${m} #${s.length}`,
      key: rawOf("id-k3"),
      target: "/v1/messages/count_tokens",
      body: chat(m),
    });
  }
  // A lone-surrogate override, named exactly: TS's URIError.
  s.push({
    kind: "v1",
    name: "id-k3 count \\ud800",
    key: rawOf("id-k3"),
    target: "/v1/messages/count_tokens",
    body: chat("\\ud800"),
  });
  // A count for a well-formed model under a key-wide limit, then U+FFFD's.
  s.push({
    kind: "v1",
    name: "id-k4 count plain",
    key: rawOf("id-k4"),
    target: "/v1/messages/count_tokens",
    body: chat("plain"),
  });
  // Review A5-R2, live counters: a count seeds U+FFFD's 5 h window (a count
  // files no row); a chat for `\ud800` then fails; once its row has landed,
  // U+FFFD's budget is as it was. TS debits the key, then throws building
  // the lone model's subject, so no model is debited; the lossy name the
  // row stores must not stand in for it.
  const on =
    (k: string) =>
    (name: string, target: string, m: string, expectDiff?: ExpectDiff): Step => ({
      kind: "v1",
      name: `${k} ${name}`,
      key: rawOf(k),
      target,
      body: chat(m),
      ...(expectDiff === undefined ? {} : { expectDiff }),
    });
  const k5 = on("id-k5");
  const k6 = on("id-k6");
  s.push(
    k5("count \\ufffd seeds the window", "/v1/messages/count_tokens", "\\ufffd"),
    k5("chat \\ud800 fails", "/v1/chat/completions", "\\ud800", {
      why: "early refusal precedes key-wide admission",
      ts: refusal([
        "x-ratelimit-limit-requests: 1",
        "x-ratelimit-remaining-requests: 0",
        "x-ratelimit-reset-requests: <duration>",
      ]),
      rust: refusal([]),
    }),
    { kind: "counter-barrier", name: "k5 committed and delivered", id: "id-k5", status: 429 },
    {
      kind: "sql",
      name: "remove barrier ceiling",
      sql: [
        `UPDATE api_keys SET limits='{"models":{"\\ufffd":{"requests":{"5h":1}}}}' WHERE id='id-k5'`,
      ],
    },
    { kind: "counter-barrier", name: "k5 barrier ceiling removed", id: "id-k5", status: 200 },
    k5("count \\ufffd is not debited #1", "/v1/messages/count_tokens", "\\ufffd"),
    k5("count \\ufffd is not debited #2", "/v1/messages/count_tokens", "\\ufffd"),
    // The key-wide subject is debited by that same kind of request: its one
    // request per 5 h is spent by the failed chat.
    k6("count plain seeds the key's window", "/v1/messages/count_tokens", "plain"),
    // TS admits the request against the key-wide subject and fails later, so
    // its 500 carries that admission's rate-limit headers; Rust refuses
    // before admitting anything and has none to render.
    k6("chat \\ud800 fails", "/v1/chat/completions", "\\ud800", {
      why: "the early refusal precedes admission: no x-ratelimit-* headers",
      ts: refusal([
        "x-ratelimit-limit-requests: 1",
        "x-ratelimit-remaining-requests: 0",
        "x-ratelimit-reset-requests: <duration>",
      ]),
      rust: refusal([]),
    }),
    { kind: "counter-barrier", name: "k6 committed and delivered", id: "id-k6", status: 429 },
    k6("count plain: the key was debited", "/v1/messages/count_tokens", "plain"),
  );
  // Review A5-R3: a literal U+FFFD model beside a 20,000-key object answers
  // as any other body does (the exact-model recovery reads it in one pass).
  const wide = Array.from({ length: 20_000 }, (_, i) => `"k${i}":${i}`).join(",");
  s.push({
    kind: "v1",
    name: "id-k2 count U+FFFD beside a 20,000-key object",
    key: rawOf("id-k2"),
    target: "/v1/messages/count_tokens",
    body: `{"model":"\ufffd","metadata":{${wide}},"messages":[{"role":"user","content":"hi"}]}`,
  });
  return s;
}

/**
 * Review A5-I2 at boot: rows TS reads lazily and the Rust gateway once
 * refused to boot on, present before boot. Every other key, the models and
 * settings are served; the bad key alone is refused with TS's error.
 */
const BAD_KEY_SQL = [
  `INSERT INTO api_keys (id,label,prefix,hash,model_allowlist,limits,created_at) VALUES ('bk-allow','b','${rawOf("bk-allow").slice(0, 12)}','${new Bun.CryptoHasher("sha256").update(rawOf("bk-allow")).digest("hex")}','{bad','{}',1600000000000)`,
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,expires_at) VALUES ('bk-frac','f','${rawOf("bk-frac").slice(0, 12)}','${new Bun.CryptoHasher("sha256").update(rawOf("bk-frac")).digest("hex")}','{}',1700000000000.5,4102444800000.5)`,
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,revoked_at) VALUES ('bk-rev','r','${rawOf("bk-rev").slice(0, 12)}','${new Bun.CryptoHasher("sha256").update(rawOf("bk-rev")).digest("hex")}','{}',1600000000001,1.5)`,
  // An empty column: `JSON.parse("")`'s message, not an empty body's.
  `INSERT INTO api_keys (id,label,prefix,hash,model_allowlist,limits,created_at) VALUES ('bk-empty','e','${rawOf("bk-empty").slice(0, 12)}','${new Bun.CryptoHasher("sha256").update(rawOf("bk-empty")).digest("hex")}','','{}',1600000000003)`,
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at) VALUES ('bk-lim','l','${rawOf("bk-lim").slice(0, 12)}','${new Bun.CryptoHasher("sha256").update(rawOf("bk-lim")).digest("hex")}','{"requests":{"9m":1}}',1600000000002)`,
];

function badKeySteps(): Step[] {
  return [
    ...["bk-allow", "bk-empty", "bk-frac", "bk-rev", "bk-lim"].map(
      (k): Step => ({
        kind: "v1",
        name: `${k} GET /v1/models`,
        key: rawOf(k),
        method: "GET",
        target: "/v1/models",
      }),
    ),
    {
      kind: "v1",
      name: "seed key served beside them",
      key: SEED_KEY,
      method: "GET",
      target: "/v1/models",
    },
    // The listing reads every row: TS's `keys.list()` throws on the bad one.
    as("admin", "GET", "/api/keys"),
    as("admin", "GET", "/api/models"),
    as("admin", "GET", "/api/settings"),
    // An edit of the bad key reads it too; an edit of a good one does not.
    as("admin", "PUT", "/api/keys/bk-allow/smart-routing", '{"enabled":true}'),
    as("admin", "PUT", "/api/keys/bk-frac/smart-routing", '{"enabled":true}'),
    // TS's edit reads the row first (`keys.get`), so it cannot repair it:
    // refused as the listing is.
    as("admin", "PUT", "/api/keys/bk-allow/models", '{"modelAllowlist":null}'),
    as("admin", "GET", "/api/keys"),
  ];
}

/**
 * Review A5-I2 live: a key served from the snapshot, another corrupted
 * behind the gateway's back, then the first revoked over `/api` and a model
 * and setting changed: every change lands within 1 s.
 */
function livePoisonSteps(): Step[] {
  return [
    as("admin", "POST", "/api/keys", '{"label":"live a"}'),
    as("admin", "POST", "/api/keys", '{"label":"live b"}'),
    { kind: "admitted", name: "a served", keyIndex: 0, expect: 200 },
    { kind: "admitted", name: "b served", keyIndex: 1, expect: 200 },
    {
      kind: "sql",
      name: "corrupt b",
      sql: ["UPDATE api_keys SET model_allowlist = '{bad' WHERE label = 'live b'"],
    },
    // TS reads the row per request; the Rust snapshot within a poll.
    { kind: "admitted", name: "b refused within 1 s of its corruption", keyIndex: 1, expect: 500 },
    { kind: "v1", name: "b refused once corrupted", key: 1, method: "GET", target: "/v1/models" },
    as("admin", "DELETE", "/api/keys/{{id:0}}"),
    { kind: "admitted", name: "a refused within 1 s of its revocation", keyIndex: 0, expect: 401 },
    as("admin", "PUT", "/api/models/live-m", model("live-m")),
    {
      kind: "listed",
      name: "a model put after the corruption is listed within 1 s",
      id: "live-m",
      present: true,
    },
    as("admin", "PUT", "/api/settings", settings({ maxAttempts: 7 })),
    as("admin", "GET", "/api/settings"),
  ];
}
const ODD_SQL = [
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,model_allowlist) VALUES ('odd-limits','l','p1','h1','{"requests":{"1m":0}}',1600000000000,'["a",5,null,{"x":1}]')`,
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,model_allowlist) VALUES ('odd-allow','l','p2','h2','{"models":{"\\ud800":{"concurrency":1}}}',1600000000001,'"str"')`,
  // Every date as INTEGER, fractional REAL and NULL (review A5-I3).
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,expires_at,revoked_at) VALUES ('odd-dates','l','p3','h3','{}',1500000000000,2500,3)`,
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,expires_at,revoked_at) VALUES ('odd-frac','l','p4','h4','{}',1500000000000.5,2500.25,1.5)`,
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,expires_at,revoked_at) VALUES ('odd-null','l','p5','h5','{}',1500000000001,NULL,NULL)`,
  `INSERT INTO virtual_models VALUES ('odd-m','[{"provider":"anthropic","model":"\\ud800","x":[1,{"y":1e400}]}]','weird',2)`,
  `INSERT INTO settings(key,value) VALUES('settings','{"maxAttempts":"x","extra":[1,{"a":"\\udc00"}],"guardrailModel":"  g ","smartRouterLocalModel":"odd-m"}')`,
];

type Config = { label: string; db: () => string; steps: () => Step[]; dayOffset?: string };
let healthSeed: string | undefined;
const nodesNow = Date.now();
const configs: Config[] = [
  {label:"nodes",db:()=>db("nodes",[]),steps:()=>["empty","one","several","unusual"].flatMap((name,i)=>[
    {kind:"sql" as const,name:`nodes seed ${name}`,sql:["DELETE FROM nodes",...(i===0?[]:[`INSERT INTO nodes VALUES('peer',${nodesNow+600000})`]),...(i<2?[]:[`INSERT INTO nodes VALUES('older',${nodesNow+500000}),('stale',1)`]),...(i<3?[]:["INSERT INTO nodes VALUES(CAST(x'ff' AS TEXT),'text-time'),(x'0102',1e999),(NULL,'zzz')"])]},
    ...everyone("GET","/api/nodes").map(s=>({...s,name:`nodes ${name} ${s.who}`,expectedStatus:s.who==="anon"?401:200}))
  ])},
  ...[1,2,3].map(run=>({label:`export-volume-${run}`,db:()=>db(`export-volume-${run}`,["WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<30000) INSERT INTO request_logs(id,at,requested_model,resolved_model,resolved_provider,credential_id,api_key_id,status,error_code,duration_ms,input_tokens) SELECT printf('export-%05d',i),100+i,'requested_'||(i%7),'resolved','custom','cred','key',CASE WHEN i%2=0 THEN 500 ELSE 200 END,'ERROR_CODE',10,3 FROM n"]),steps:()=>["csv","jsonl"].flatMap(format=>everyone("GET",`/api/logs/export?since=0&until=40000&format=${format}&cursor=invalid&limit=1&format=${format}&limit=2`).map(s=>({...s,expectedStatus:s.who==="anon"?401:200})))})),
  {label:"export-matrix",db:()=>db("export-matrix",[
    ...["comma,quote\"","CR\rLF\n","=formula","+plus","-minus","@at","\t=tab","é😀"].map((s,i)=>`INSERT INTO request_logs(id,at,requested_model,resolved_model,resolved_provider,api_key_id,credential_id,error_code,status,duration_ms,degradations) VALUES('matrix-${i}',100,'${s.replace(/'/g,"''")}','resolved','custom','key','cred','ERROR_CODE',500,1,'["grep"]')`),
    "INSERT INTO request_logs(id,at,requested_model,status,duration_ms,input_tokens,degradations) VALUES('raw',101,CAST(x'ff' AS TEXT),200,x'0102','numeric-text','null')",
  ]),steps:()=>["csv","jsonl"].flatMap(format=>["","state=done","state=pending","failed=true","failed=false","provider=custom","requestedModel=comma","resolvedModel=sol","model=resolved","credentialId=cred","apiKeyId=key","errorCode=ERROR_","since=102","until=0"].flatMap((filter,i)=>everyone("GET",`/api/logs/export?since=0&until=200&format=${format}&${filter}`).map(s=>({...s,name:`matrix ${format} ${i} ${s.who}`,expectedStatus:s.who==="anon"?401:200}))))},
  {label:"logs-export",db:()=>db("logs-export",["INSERT INTO request_logs(id,at,requested_model,status,duration_ms,degradations) VALUES('export',100,'=a,\"b',200,1,'[\"x\"]')"]),steps:()=>["","since=0","since=0&until=200","since=0&until=200&format=jsonl","since=0&until=200&format=bad","since=0&until=200&cursor=bad","since=0&until=200&provider=INVALID"].flatMap((q,i)=>everyone("GET",`/api/logs/export?${q}`).map(s=>({...s,name:`export ${i} ${s.who}`,expectedStatus:s.who==="anon"?401:[0,1,4,6].includes(i)?400:200})))},
  {label:"logs-identity",db:()=>db("logs-identity",["INSERT INTO request_logs(id,at,requested_model,status,duration_ms) VALUES ('a',100,'x',200,1),('�',100,'x',200,1),('z',100,'x',200,1),('😀',100,'x',200,1)"]),steps:()=>[
    ...["\ud800","�","z"].flatMap(id=>everyone("GET",`/api/logs?cursor=${Buffer.from(JSON.stringify({v:1,at:100,id})).toString("base64url")}`).map(s=>({...s,expectedStatus:s.who==="anon"?401:200}))),
    ...[`since=${"9".repeat(310)}`,`since=-${"9".repeat(310)}`,...['{"v":1,"at":0,"id":"x"} ','{"at":0,"v":1,"id":"x"}','{"v":3,"at":0,"id":"x"}'].map(s=>`cursor=${Buffer.from(s).toString("base64url")}!`)].flatMap((q,i)=>everyone("GET",`/api/logs?${q}`).map(s=>({...s,name:`mutation ${i} ${s.who}`,expectedStatus:s.who==="anon"?401:400}))),
  ]},
  {label:"logs-cells",db:()=>db("logs-cells",["INSERT INTO request_logs(id,at,requested_model,status,duration_ms,input_tokens,resolved_model,degradations,rtk_filters) VALUES('odd',1794000000000,'odd','text',x'1234','words',NULL,x'3132','[\"grep\",\"bad\",3,\"git-diff\"]')"]),steps:()=>everyone("GET","/api/logs").map(s=>({...s,expectedStatus:s.who==="anon"?401:200}))},
  {label:"logs-empty",db:()=>db("logs-empty",[]),steps:()=>everyone("GET","/api/logs").map(s=>({...s,expectedStatus:s.who==="anon"?401:200}))},
  {label:"logs-validation",db:()=>db("logs-validation",[]),steps:()=>[
    "provider=1bad","provider=-bad",`provider=${"a".repeat(33)}`,"since=-9007199254740992","until=9007199254740992","bad%0Akey=x",
    `cursor=${Buffer.from('{"v":2,"at":0,"id":"x"}').toString("base64url")}!!!`,
    `cursor=${Buffer.from('{"v":2,"at":0,"id":"x"}').toString("base64url")}=`,
  ].flatMap((q,i)=>everyone("GET",`/api/logs?${q}`).map(s=>({...s,name:`validation ${i} ${s.who}`,expectedStatus:s.who==="anon"?401:400})))},
  {
    label: "usage-traffic",
    db: () => db("usage-traffic", ["INSERT INTO virtual_models VALUES('routing-a6','[{\"provider\":\"custom\",\"endpointId\":\"routing-a6\",\"model\":\"m\",\"tier\":1,\"weight\":1,\"capabilities\":{\"tools\":false,\"images\":false,\"reasoning\":false},\"costPerMTok\":{\"input\":0,\"output\":0}}]','score',1)"]),
    steps: () => [
      {...as("admin", "POST", "/api/credentials", '{"provider":"custom","apiKey":"secret-a6-2","endpointId":"routing-a6","endpointLabel":"Routing","origin":"http://127.0.0.1:18444","protocol":"chat_completions"}'), expectedStatus:200},
      {kind:"usage-traffic",name:"one real request usage"},
    ],
  },
  {
    label: "logs",
    db: () => db("logs", ["WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<503) INSERT INTO request_logs(id,at,requested_model,resolved_model,resolved_provider,credential_id,api_key_id,status,error_code,duration_ms) SELECT printf('log-%04d',i),1794000000000+i/3,'requested_model','resolved','custom','cred','key',CASE WHEN i%2=0 THEN 500 ELSE 200 END,'ERROR_CODE',10 FROM n"]),
    steps: () => ["", "limit=1", "limit=500", "limit=9999", "limit=0", "limit=bad", "since=1794000000001", "until=1794000000001", "state=done", "state=pending", "failed=true", "failed=false", "provider=custom", "requestedModel=MODEL", "resolvedModel=sol", "model=requested", "credentialId=cred", "apiKeyId=key", "errorCode=ERROR_", "cursor=bad", "state=bad", "failed=bad", "since=bad", "since=2&until=1", "wat=x"].flatMap((q,i) => everyone("GET", `/api/logs?${q}`).map(s => ({...s, name:`logs ${i} ${s.who}`, expectedStatus:s.who === "anon" ? 401 : i>=19 ? 400 : 200}))),
  },
  {
    label: "usage-large",
    db: () => db("usage-large", ["WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<300000) INSERT INTO request_logs(id,at,requested_model,resolved_model,api_key_id,status,duration_ms,input_tokens) SELECT 'large-'||i,1794000000000+i,'requested','model-'||(i%7),'key-'||(i%10000),200,10,2 FROM n"]),
    steps: () => everyone("GET", "/api/usage?groupBy=apiKey&splitBy=model&until=1e20").map(s => ({...s, expectedStatus: s.who === "anon" ? 401 : 200})),
  },
  ...["330", "-480"].map(dayOffset => ({
    label: `usage-offset-${dayOffset}`, dayOffset,
    db: () => db(`usage-offset-${dayOffset}`, [`INSERT INTO usage_daily(day,resolved_model,requests) VALUES (${1794528000000-Number(dayOffset)*60000},'offset',7)`]),
    steps: () => [0,1,-1,86399999,86400000].flatMap(delta => everyone("GET", `/api/usage?grain=daily&groupBy=day&since=${1794528000000-Number(dayOffset)*60000+delta}&until=1e20`).map(s => ({...s, expectedStatus: s.who === "anon" ? 401 : 200}))),
  })),
  {
    label: "usage",
    db: () => db("usage", [
      ...Array.from({length: 20}, (_, i) => `INSERT INTO request_logs(id,at,requested_model,resolved_model,resolved_provider,credential_id,api_key_id,status,duration_ms,input_tokens,output_tokens,cost_usd,rtk_applied,rtk_estimated_tokens_saved) VALUES ('u${i}',${Date.UTC(2026,10,13) + i*3600000},'requested-${i%3}',${i%4 === 0 ? "NULL" : `'m${i%2}'`},'custom','cred-${i%2}','key-${i%3}',${i%3===0?500:200},${i*13},${i},${i*2},0.125,${i%2},${i*3})`),
      ...Array.from({length: 8}, (_, i) => `INSERT INTO usage_daily(day,provider,credential_id,requested_model,resolved_model,api_key_id,requests,errors,input_tokens,duration_ms_sum) VALUES (${Date.UTC(2026,10,13) + i*86400000},'custom','cred-${i%2}','requested-${i%3}','m${i%2}','key-${i%3}',${i+1},1,${i*17},${i*101})`),
      "UPDATE request_logs SET resolved_model=x'0102', input_tokens='nonnumeric', duration_ms=1.25 WHERE id='u1'",
      "UPDATE request_logs SET resolved_model='', input_tokens=1e100 WHERE id='u2'",
    ]),
    steps: () => {
      const queries = ["", "grain=raw", "grain=daily", "grain=bad", "groupBy=bad", "splitBy=bad", "groupBy=day", "grain=daily&groupBy=hour", "credentialId=", "apiKeyId=!", "since=bad", "since=0x10&until=1e20", "since=&until=", "grain=raw&grain=daily"];
      for (const grain of ["raw", "daily"])
        for (const groupBy of ["credential", "model", "requestedModel", "apiKey", "provider", grain === "raw" ? "hour" : "day"])
          for (const splitBy of ["", "model", "provider", "apiKey"])
            queries.push(`grain=${grain}&groupBy=${groupBy}${splitBy ? `&splitBy=${splitBy}` : ""}`);
      queries.push("credentialId=cred-1", "apiKeyId=key-1", "credentialId=cred-0&apiKeyId=key-2", "since=1794528000000&until=1794614400000", "grain=daily&since=1794528000001&until=1e20", "until=0");
      queries.push("since=%FF", "since=%C0%AF", "since=%ED%A0%80", "since=%E2%82", "since=%zz");
      return [
        ...queries.flatMap((q, i) => everyone("GET", `/api/usage?${q}`).map(s => ({...s, name: `usage ${i} ${s.who}`, expectedStatus: s.who === "anon" ? 401 : i >= 3 && i <= 9 ? 400 : 200 }))),
        {kind: "sql", name: "live usage raw cells", sql: ["INSERT INTO request_logs(id,at,requested_model,resolved_model,status,duration_ms,input_tokens,degradations) VALUES ('live-usage',1794000000000,'live',CAST(x'ff' AS TEXT),500,'text-duration',x'1234','not-json')", "UPDATE request_logs SET state='pending' WHERE id='u3'"]},
        ...everyone("GET", "/api/usage?until=1e20").map(s => ({...s, name: `live malformed ${s.who}`, expectedStatus: s.who === "anon" ? 401 : 200})),
      ];
    },
  },
  {
    label: "credential-identity",
    db: () => db("credential-identity", ["UPDATE api_keys SET limits='{}'"]),
    steps: () => {
      const steps: Step[] = [];
      for (const [i, endpoint] of ["\ud800", "\udc00", "�"].entries()) {
        steps.push(
          as(
            "admin",
            "POST",
            "/api/credentials",
            JSON.stringify({
              provider: "custom",
              apiKey: "secret-a6-2",
              endpointId: endpoint,
              endpointLabel: `endpoint-${i}`,
              origin: "http://127.0.0.1:18444",
              protocol: "chat_completions",
            }),
          ),
        );
        steps.push(
          as(
            "admin",
            "PUT",
            `/api/models/identity-${i}`,
            model(`identity-${i}`, {}, [
              { ...TARGET, provider: "custom", endpointId: endpoint, model: "m" },
            ]),
          ),
        );
      }
      for (let i = 0; i < 3; i++)
        steps.push({
          kind: "credential-routing",
          name: `identity ${i} routes`,
          model: `identity-${i}`,
          enabled: true,
        });
      steps.push({
        kind: "sql",
        name: "replacement pin identity",
        sql: [
          "INSERT INTO credentials(id,provider,label,auth_type,provider_data,api_key,created_at,updated_at) SELECT '�',provider,label,auth_type,provider_data,api_key,created_at,updated_at FROM credentials WHERE provider_data LIKE '%endpoint-2%'",
        ],
      });
      for (const [name, pin] of [
        ["lone-pin", "\ud800"],
        ["replacement-pin", "�"],
      ]) {
        steps.push({
          kind: "sql",
          name: `seed ${name}`,
          sql: [
            `INSERT INTO virtual_models VALUES('${name}','${JSON.stringify([{ ...TARGET, provider: "custom", endpointId: "�", model: "m", credentialId: pin }])}','score',1)`,
          ],
        });
        steps.push({
          kind: "credential-routing",
          name: `${name} identity`,
          model: name,
          enabled: pin === "�",
        });
      }
      steps.push({
        kind: "sql",
        name: "matching replacement provider",
        sql: [
          "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('replacement-provider','�','replacement','apiKey','{}',1,1)",
        ],
      });
      for (const [name, provider] of [
        ["lone-provider", "\ud800"],
        ["replacement-provider", "�"],
      ])
        steps.push({
          kind: "sql",
          name: `seed ${name}`,
          sql: [
            `INSERT INTO virtual_models VALUES('${name}','${JSON.stringify([{ ...TARGET, provider, model: "m" }])}','score',1)`,
          ],
        });
      steps.push(as("admin", "GET", "/api/models"));
      for (const name of ["lone-provider", "replacement-provider"])
        steps.push(
          { kind: "listed", name: `${name} published`, id: name, present: true },
          {
            kind: "v1",
            name: `${name} frozen exclusion`,
            key: SEED_KEY,
            target: "/v1/chat/completions",
            body: JSON.stringify({ model: name, messages: [{ role: "user", content: "hello" }] }),
          },
        );
      steps.push({
        kind: "sql",
        name: "remove pin fixture",
        sql: ["DELETE FROM credentials WHERE id='�'"],
      });
      for (let i = 0; i < 3; i++) {
        steps.push(as("admin", "PATCH", `/api/credentials/{{id:${i}}}`, '{"enabled":false}'));
        for (let j = 0; j < 3; j++)
          steps.push({
            kind: "credential-routing",
            name: `disable ${i} identity ${j}`,
            model: `identity-${j}`,
            enabled: i !== j,
          });
        steps.push(as("admin", "PATCH", `/api/credentials/{{id:${i}}}`, '{"enabled":true}'));
      }
      steps.push({ kind: "restart-other", name: "identity restart" });
      for (let i = 0; i < 3; i++)
        steps.push({
          kind: "credential-routing",
          name: `restarted identity ${i}`,
          model: `identity-${i}`,
          enabled: true,
        });
      return steps;
    },
  },
  {
    label: "credential-health",
    db: () => {
      if (healthSeed) return healthSeed;
      const now = Date.now();
      const sql = [...CREDS_SQL];
      sql.push("INSERT INTO credential_health VALUES('cred-custom','m','unknown',1.5,2.25,3.5)");
      for (const [i, used, limit, reset, observed, window] of [
        [0, 25, 100, now + 3600000, now, 7200000],
        [1, 100, 100, now + 3600000, now, 7200000],
        [2, 0, 100, now + 3600000, now, 7200000],
        [3, 25, -1, now + 3600000, now, 7200000],
        [4, 25, null, null, now, null],
        [5, 25, 100, now - 10000, now, 7200000],
        [6, 25, 100, now + 3600000, now - 3600000, 7200000],
        [7, 0.25, 1.5, now + 3600000, now + 0.5, 7200000],
      ])
        sql.push(
          `INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms) VALUES('cred-custom','w${i}',0,${used},${limit ?? "NULL"},${reset ?? "NULL"},${observed},${window ?? "NULL"})`,
        );
      healthSeed = db("credential-health", sql);
      return healthSeed;
    },
    steps: () => [
      {
        kind: "sql",
        name: "fractional health after boot",
        sql: ["UPDATE credential_health SET consecutive_failures=1.5"],
      },
      as("admin", "GET", "/api/credentials/health"),
      as("viewer", "GET", "/api/credentials/health"),
      {
        kind: "sql",
        name: "text health scalar",
        sql: [
          "UPDATE credential_health SET consecutive_failures='not-a-number',opened_at='unknown',rate_limited_until=NULL",
        ],
      },
      {
        ...as("admin", "GET", "/api/credentials/health"),
        name: "health preserves text and null scalars",
      },
      {
        kind: "sql",
        name: "quota text scalar",
        sql: [
          "UPDATE quota_windows SET used='unknown',limit_value='unknown' WHERE window_type='w0'",
        ],
      },
      { ...as("admin", "GET", "/api/credentials/health"), name: "quota preserves text scalars" },
      {
        kind: "sql",
        name: "quota text timestamps",
        sql: [
          "UPDATE quota_windows SET used=25,limit_value=100,observed_at='unknown',resets_at='future' WHERE window_type='w0'",
        ],
      },
      {
        ...as("admin", "GET", "/api/credentials/health"),
        name: "quota timestamp JS concatenation",
      },
    ],
  },
  {
    label: "credentials",
    db: () =>
      db("credentials", [
        ...CREDS_SQL,
        `UPDATE api_keys SET limits='{}'`,
        `INSERT INTO credential_health VALUES('cred-custom','m','open',3,100,200)`,
        `INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms) VALUES('cred-custom','daily',0,25,100,2000000000000,0,NULL)`,
        `INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms) VALUES('cred-custom','preboot',0,'unknown',100,4102444800000,0,NULL)`,
        `INSERT INTO virtual_models VALUES('pinned','[{"provider":"custom","model":"m","credentialId":"cred-custom","tier":1,"weight":1,"costPerMTok":{"input":0,"output":0}}]','ordered',1)`,
      ]),
    steps: () => {
      const steps: Step[] = [];
      for (const who of ["anon", "viewer", "admin"] as const) {
        for (const path of ["/api/credentials", "/api/credentials/health"])
          steps.push(as(who, "GET", path));
        steps.push(as(who, "POST", "/api/credentials", "{}"));
        steps.push(as(who, "PATCH", "/api/credentials/cred-custom", '{"enabled":false}'));
        steps.push(as(who, "DELETE", "/api/credentials/missing"));
      }
      for (const body of [
        "null",
        "[]",
        "{}",
        '{"label":""}',
        '{"tier":0}',
        '{"tier":1.5}',
        '{"weight":0}',
        '{"weight":1e400}',
        '{"enabled":1}',
        '{"label":"\\ud800","tier":2}',
        '{"label":" ","weight":0.25}',
        '{"tier":-1}',
        '{"tier":9007199254740992}',
        '{"extra":1}',
        '{"label":" x ","tier":2,"weight":0.5}',
        '{"enabled":true}',
      ]) {
        steps.push(as("admin", "PATCH", "/api/credentials/cred-custom", body));
      }
      steps.push(as("admin", "PATCH", "/api/credentials/missing", "{}"));
      for (const [body, timestamps] of [
        ["{}", "unchanged"],
        ['{"enabled":false}', "disable"],
        ['{"enabled":false}', "disable"],
        ['{"enabled":true}', "enable"],
        ['{"enabled":true}', "enable"],
      ] as const)
        steps.push({ ...as("admin", "PATCH", "/api/credentials/cred-custom", body), timestamps });
      steps.push({
        kind: "sql",
        name: "refuse credential update",
        sql: [
          "CREATE TRIGGER a6_refuse BEFORE UPDATE ON credentials BEGIN SELECT RAISE(ABORT,'test refusal'); END",
        ],
      });
      steps.push({
        ...as("admin", "PATCH", "/api/credentials/cred-custom", '{"enabled":false}'),
        name: "credential update refused by SQL trigger",
      });
      steps.push({ kind: "sql", name: "allow credential update", sql: ["DROP TRIGGER a6_refuse"] });
      for (const body of [
        "null",
        "[]",
        '{"provider":1}',
        '{"provider":"CUSTOM"}',
        '{"provider":"abcdefghijklmnopqrstuvwxyzabcdefg","apiKey":"secret-a6-1"}',
        '{"provider":"gemini","apiKey":"secret-a6-1"}',
        '{"provider":"kimi","apiKey":"secret-a6-1","label":"kimi"}',
        '{"provider":"missing"}',
        '{"provider":"openai","apiKey":" "}',
        '{"provider":"openai","apiKey":"secret-a6-1","label":null}',
        '{"provider":"openai","apiKey":"secret-a6-1","label":" first "}',
        '{"provider":"custom","apiKey":"secret-a6-2","endpointId":"ep2","endpointLabel":"Local 2","origin":"https://example.com/api///","protocol":"chat_completions"}',
        '{"provider":"custom","apiKey":"secret-a6-3","endpointId":"ep2","endpointLabel":"Conflict","origin":"https://example.com/api","protocol":"chat_completions"}',
      ])
        steps.push(as("admin", "POST", "/api/credentials", body));
      for (const origin of [
        "not a URL",
        "ftp://example.com",
        "https://user:pass@example.com",
        "https://example.com/?q=1",
        "https://example.com/#fragment",
        "https://EXAMPLE.com:443/a/../b///",
        "https://example.com/?#",
      ]) {
        steps.push(
          as(
            "admin",
            "POST",
            "/api/credentials",
            JSON.stringify({
              provider: "custom",
              apiKey: "secret-a6-2",
              endpointId: origin,
              endpointLabel: "URL",
              origin,
              protocol: "responses",
            }),
          ),
        );
      }
      steps.push(
        as(
          "admin",
          "POST",
          "/api/credentials",
          '{"provider":"custom","apiKey":"secret-a6-2","label":"\\ud800","endpointId":"\\ud800","endpointLabel":"\\udc00","origin":"http://localhost","protocol":"responses"}',
        ),
      );
      steps.push(
        as(
          "admin",
          "POST",
          "/api/credentials",
          '{"provider":"custom","apiKey":"secret-a6-2","endpointId":"�","endpointLabel":"Different","origin":"http://localhost","protocol":"responses"}',
        ),
      );
      steps.push(as("admin", "GET", "/api/credentials"));
      steps.push({
        kind: "sql",
        name: "precreate routing model",
        sql: [
          `INSERT INTO virtual_models VALUES('routing-a6','[{"provider":"custom","endpointId":"routing-a6","model":"m","tier":1,"weight":1,"capabilities":{"tools":false,"images":false,"reasoning":false},"costPerMTok":{"input":0,"output":0}}]','score',1)`,
        ],
      });
      steps.push(
        as(
          "admin",
          "POST",
          "/api/credentials",
          '{"provider":"custom","apiKey":"secret-a6-2","endpointId":"routing-a6","endpointLabel":"Routing","origin":"http://127.0.0.1:18444","protocol":"chat_completions"}',
        ),
      );
      steps.push({ kind: "credential-routing", name: "created credential routes", enabled: true });
      steps.push({
        kind: "sql",
        name: "blob quota comparison",
        sql: [
          "INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms) SELECT id,'blob-review',0,x'09',x'0a',4102444800000,0,NULL FROM credentials WHERE provider_data LIKE '%routing-a6%'",
        ],
      });
      steps.push({
        kind: "credential-routing",
        name: "blob lexical ceiling blocks",
        enabled: false,
      });
      steps.push({
        kind: "sql",
        name: "clear blob ceiling",
        sql: ["DELETE FROM quota_windows WHERE window_type='blob-review'"],
      });
      steps.push({ kind: "credential-routing", name: "blob ceiling removed", enabled: true });
      for (const [name, state, failures, opened, until] of [
        ["fractional counter preserves active deadline", "closed", "1.5", "NULL", "4102444800000"],
        ["fractional counter preserves open breaker", "open", "1.5", "4102444800000", "NULL"],
        ["text counter preserves active deadline", "closed", "'unknown'", "NULL", "4102444800000"],
        ["huge counter preserves open breaker", "open", "1e100", "4102444800000", "NULL"],
        ["text deadline preserves open breaker", "open", "3", "4102444800000", "'unknown'"],
      ] as const) {
        steps.push({
          kind: "sql",
          name: `seed ${name}`,
          sql: [
            `INSERT INTO credential_health SELECT id,'m','${state}',${failures},${opened},${until} FROM credentials WHERE provider_data LIKE '%routing-a6%'`,
          ],
        });
        steps.push({ kind: "credential-routing", name, enabled: false });
        steps.push({
          kind: "sql",
          name: `clear ${name}`,
          sql: [
            "DELETE FROM credential_health WHERE credential_id IN (SELECT id FROM credentials WHERE provider_data LIKE '%routing-a6%')",
          ],
        });
        steps.push({ kind: "credential-routing", name: `recovered after ${name}`, enabled: true });
      }
      steps.push({
        kind: "sql",
        name: "live malformed unrelated quota",
        sql: [
          "INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms) VALUES('cred-custom','live',0,'unknown',100,4102444800000,0,NULL)",
        ],
      });
      steps.push(as("admin", "PATCH", "/api/credentials/{{last}}", '{"enabled":false}'));
      steps.push({
        kind: "credential-routing",
        name: "disabled credential stops routing",
        enabled: false,
      });
      steps.push(as("admin", "PATCH", "/api/credentials/{{last}}", '{"enabled":true}'));
      steps.push({ kind: "credential-routing", name: "enabled credential routes", enabled: true });
      steps.push(as("admin", "DELETE", "/api/credentials/{{last}}"));
      steps.push({
        kind: "credential-routing",
        name: "deleted credential stops routing",
        enabled: false,
      });
      steps.push({
        kind: "concurrent",
        name: "concurrent disjoint credential edits",
        steps: [
          as("admin", "PATCH", "/api/credentials/cred-custom", '{"label":"concurrent"}'),
          as("admin", "PATCH", "/api/credentials/cred-custom", '{"weight":3}'),
          as("admin", "PATCH", "/api/credentials/cred-custom", '{"tier":4}'),
        ],
      });
      steps.push(as("admin", "GET", "/api/credentials/health"));
      steps.push(as("admin", "DELETE", "/api/credentials/cred-custom"));
      steps.push(as("admin", "DELETE", "/api/credentials/cred-custom"));
      steps.push(as("admin", "GET", "/api/credentials"));
      steps.push(as("admin", "GET", "/api/credentials/health"));
      return steps;
    },
  },
  { label: "reads", db: () => db("reads", CREDS_SQL), steps: readSteps },
  {
    label: "reads-empty",
    db: () => db("reads-empty", ["DELETE FROM api_keys"]),
    steps: () => [
      as("admin", "GET", "/api/keys"),
      as("admin", "GET", "/api/models"),
      as("admin", "GET", "/api/catalog"),
      as("admin", "GET", "/api/settings"),
    ],
  },
  { label: "models", db: () => db("models", CREDS_SQL), steps: modelSteps },
  { label: "keys", db: () => db("keys"), steps: keySteps },
  { label: "settings", db: () => db("settings", CREDS_SQL), steps: settingsSteps },
  { label: "passwords", db: () => db("passwords"), steps: passwordSteps },
  { label: "odd-rows", db: () => db("odd-rows", ODD_SQL), steps: oddRowSteps },
  { label: "key-identity", db: () => db("key-identity", IDENTITY_SQL), steps: identitySteps },
  { label: "boot-bad-keys", db: () => db("boot-bad-keys", BAD_KEY_SQL), steps: badKeySteps },
  { label: "live-poison", db: () => db("live-poison", CREDS_SQL), steps: livePoisonSteps },
  {
    label: "broken-rows",
    // The bad key row is there at boot (review A5-I2: once a Rust boot
    // failure). The `null` provider_data is written after boot: a routing
    // snapshot refuses it in both builds (the credential is read whole).
    db: () =>
      db("broken-rows", [
        `INSERT INTO virtual_models VALUES ('bad','{bad','score',0)`,
        `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,model_allowlist) VALUES ('bad','l','p','h','{}',1,'{bad')`,
      ]),
    steps: () => [
      {
        kind: "sql",
        name: "hand-edited rows",
        sql: [
          `INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('nul','qoder','N','oauth','null',1,1)`,
        ],
      },
      as("admin", "GET", "/api/keys"),
      as("admin", "GET", "/api/models"),
      as("admin", "GET", "/api/catalog"),
      as("admin", "GET", "/api/settings"),
      as("admin", "PUT", "/api/keys/bad/smart-routing", '{"enabled":true}'),
      as("admin", "PUT", `/api/keys/${SEED_ID}/smart-routing`, '{"enabled":true}'),
      as("admin", "PUT", "/api/models/m-new", model("m-new")),
      as("admin", "DELETE", "/api/models/bad"),
      as("admin", "DELETE", "/api/keys/bad"),
    ],
  },
];

// ------------------------------------------------------------ running
const credentialConfig = configs.find((c) => c.label === "credentials");
if (!credentialConfig) throw new Error("credential config missing");
configs.push({
  label: "credential-crossread",
  db: credentialConfig.db,
  steps: () => {
    const all = credentialConfig.steps();
    const end = all.findIndex((s) => s.name === "created credential routes");
    return [
      ...all.slice(0, end + 1),
      { kind: "restart-other", name: "restart other implementation" },
      as("admin", "GET", "/api/credentials"),
      {
        kind: "credential-routing",
        name: "other implementation decrypts and routes",
        enabled: true,
      },
    ];
  },
});

const TRANSPORT_ERROR = "TRANSPORT-ERROR";

// Materialize once: sequence identity is independent of repeated request text,
// and both implementations plus expected-divergence lookup use the same keys.
const logsConfig=configs.find(c=>c.label==="logs")!;
const cellsConfig=configs.find(c=>c.label==="logs-cells")!;
cellsConfig.steps=()=>[
  ...everyone("GET","/api/logs").map(s=>({...s,name:`blob invalid ${s.who}`,expectedStatus:s.who==="anon"?401:500})),
  {kind:"sql",name:"single byte blob parses as number",sql:["UPDATE request_logs SET degradations=x'31'"]},
  ...everyone("GET","/api/logs").map(s=>({...s,name:`blob valid ${s.who}`,expectedStatus:s.who==="anon"?401:200})),
];
const logsSteps=logsConfig.steps;
logsConfig.steps=()=>[...logsSteps(),{kind:"logs-walk",name:"all pages with insertion"}];
const materializedSteps = configs.map((cfg) => cfg.steps());
for (const [configIndex, cfg] of configs.entries()) {
  const steps = (materializedSteps[configIndex] ?? []).map((step, index) => ({
    ...step,
    name: `${String(index).padStart(4, "0")}: ${step.name}`,
  }));
  if (new Set(steps.map((step) => step.name)).size !== steps.length)
    throw new Error(`duplicate step identity in ${cfg.label}`);
  cfg.steps = () => steps;
}

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

function cookieOf(x: Ex): string | null {
  const c = x.head.find(([k]) => k === "set-cookie")?.[1];
  const m = c === undefined ? null : /^omni_admin=([^;]+);/.exec(c);
  return m?.[1] ?? null;
}

async function login(
  password: string,
  mode: string | undefined,
  seen: (name: string, method: string, x: Ex) => void,
): Promise<string | null> {
  const x = await exchange({
    method: "POST",
    target: "/api/login",
    headers: [J],
    body: JSON.stringify(mode === undefined ? { password } : { password, mode }),
  });
  seen(`login ${mode ?? "admin"}`, "POST", x);
  return x.status === 200 ? cookieOf(x) : null;
}

type Result = { text: string; db: string };

async function runOne(label: "ts" | "rust", binary: string, cfg: Config) {
  const root = join(work, `${cfg.label}-${label}`);
  mkdirSync(root, { recursive: true });
  const file = join(root, "omni.db");
  copyFileSync(cfg.db(), file);
  const e: Record<string, string | undefined> = {
    ...env,
    OMNI_DB_PATH: file,
    OMNI_ROOT: root,
    OMNI_STATIC_DIR: join(root, "no-dashboard"),
    OMNI_DAY_OFFSET_MINUTES: cfg.dayOffset ?? "0",
    ...(cfg.label === "export-volume-1" ? { OMNI_LOG_LEVEL: "debug", RUST_LOG: "debug" } : {}),
  };
  const logFile = join(out, `${cfg.label}-${label}.log`);
  let proc = Bun.spawn([binary], {
    cwd: root,
    env: e,
    stdout: Bun.file(logFile),
    stderr: Bun.file(`${logFile}.err`),
  });
  children.push(proc);
  const m = new Masker();
  const results = new Map<string, Result>();
  const notes: string[] = [];
  const deadlineFailures: string[] = [];
  const lengthFailures: string[] = [];
  const secretProblems: string[] = [];
  /** Every answer this binary gave: its framing, and any raw key in it. */
  const seen = (name: string, method: string, x: Ex) => {
    if (x.status === 0) return;
    const problem = lengthProblem(method, x);
    if (problem !== null) lengthFailures.push(`${name}: ${problem}`);
    const head = Buffer.from(x.head.map(([k, v]) => `${k}: ${v}`).join("\n"), "latin1");
    for (const raw of ["secret-a6-1", "secret-a6-2", "secret-a6-3"]) {
      if (head.includes(raw) || x.body.includes(raw))
        secretProblems.push(`${name}: credential secret exposed`);
    }
    for (const raw of allRawKeys.keys()) {
      for (let n = occurrences(head, raw); n > 0; n--)
        m.sightings.push(`${name} (head)\u0000${raw}`);
      for (let n = occurrences(x.body, raw); n > 0; n--) m.sightings.push(`${name}\u0000${raw}`);
    }
  };
  try {
    // A binary that exits instead of serving (a boot refusal) answers every
    // step with that, so the config fails step by step rather than the run.
    const booted = await Promise.race([
      waitHealthy().then(() => true),
      proc.exited.then(() => false),
    ]);
    if (!booted) {
      const reason = readFileSync(logFile, "utf8").trim().split("\n").at(-1) ?? "";
      for (const step of cfg.steps())
        if (step.kind !== "sql" && step.kind !== "wait")
          results.set(step.name, { text: `${TRANSPORT_ERROR} did not boot: ${reason}`, db: "" });
      return {
        results,
        lines: [],
        secretProblems,
        minted: 0,
        notes,
        deadlineFailures,
        lengthFailures,
      };
    }
    const cookies: Record<Who, string | null> = {
      admin: await login(PASSWORD, undefined, seen),
      viewer: await login(VIEWER, "viewer", seen),
      anon: null,
    };
    if (cookies.admin === null || cookies.viewer === null) throw new Error("seed login failed");
    if (cfg.label === "usage-large") {
      const latencies = [];
      for (const target of ["/api/usage?since=0&until=9999999999999&groupBy=apiKey&splitBy=model", "/api/logs?limit=500"]) {
        const headers: [string,string][] = [["cookie",`omni_admin=${cookies.admin}`]];
        const started = performance.now();
        const heavy = exchange({method:"GET",target,headers});
        await sleep(10);
        const start = performance.now();
        const light = await exchange({method:"GET",target:"/api/logs?limit=1",headers});
        const latency = performance.now()-start;
        const result = await heavy;
        if (result.status !== 200 || light.status !== 200) throw new Error(`report concurrency status ${result.status}/${light.status}`);
        latencies.push({target,latency,totalMs:performance.now()-started});
      }
      writeFileSync(join(out, `report-contention-${label}.json`), JSON.stringify(latencies));
      if (label === "rust" && latencies.some(x=>x.latency>10)) throw new Error(`report contention ${JSON.stringify(latencies)}`);
    }
    if (cfg.label === "export-volume-1") {
      const pages = () => (readFileSync(logFile, "utf8") + readFileSync(`${logFile}.err`, "utf8")).split("export_page_read").length - 1;
      let atClose = 0;
      await new Promise<void>((resolve, reject) => {
        const socket = connect(PORT, "127.0.0.1");
        const timeout = setTimeout(() => { socket.destroy(); reject(new Error("disconnect export timeout")); }, 10000);
        socket.on("error", reject);
        socket.on("connect", () => socket.write(`GET /api/logs/export?since=0&until=40000&format=jsonl HTTP/1.1\r\nHost: localhost\r\nCookie: omni_admin=${cookies.admin}\r\n\r\n`));
        let received = Buffer.alloc(0);
        socket.on("data", chunk => {
          received = Buffer.concat([received, chunk]);
          const end = received.indexOf("\r\n\r\n");
          if (end < 0 || received.length <= end + 4) return;
          if (!received.subarray(0, end).toString().startsWith("HTTP/1.1 200")) reject(new Error("disconnect export status"));
          socket.destroy();
        });
        socket.on("close", () => { atClose = pages(); clearTimeout(timeout); resolve(); });
      });
      await sleep(500);
      const after = pages();
      if (label === "rust" && (atClose < 1 || after > atClose + 1)) throw new Error(`export disconnect page reads: close=${atClose} after=${after}`);
      const followup = await exchange({ method: "GET", target: "/api/logs?limit=1", headers: [["cookie", `omni_admin=${cookies.admin}`]] });
      if (followup.status !== 200) throw new Error(`post-disconnect admin status ${followup.status}`);
      writeFileSync(join(out, `disconnect-${label}.json`), JSON.stringify({ atClose, after, status: followup.status }));
      const fixture = new Database(file);
      fixture.run("PRAGMA busy_timeout=5000");
      fixture.run(`INSERT INTO virtual_models VALUES('routing-a6','[{"provider":"custom","endpointId":"routing-a6","model":"m","tier":1,"weight":1,"capabilities":{"tools":false,"images":false,"reasoning":false},"costPerMTok":{"input":0,"output":0}}]','score',1)`);
      const credential = await exchange({method:"POST",target:"/api/credentials",headers:[["cookie",`omni_admin=${cookies.admin}`],J],body:JSON.stringify({provider:"custom",apiKey:"secret-a6-2",endpointId:"routing-a6",endpointLabel:"Routing",origin:`http://127.0.0.1:${PORT+1}`,protocol:"chat_completions"})});
      if (credential.status !== 200) throw new Error(`slow-reader credential status ${credential.status}`);
      await sleep(1100);
      let ended = false;
      const idle: number[] = [];
      for (let i=0;i<5;i++) {
        const start = performance.now();
        const response = await exchange({method:"GET",target:"/api/logs?limit=1",headers:[["cookie",`omni_admin=${cookies.admin}`]]});
        if (response.status !== 200) throw new Error("idle admin status");
        idle.push(performance.now()-start);
      }
      const boundMs = 10;
      const socket = connect(PORT, "127.0.0.1");
      socket.on("error", () => { ended = true; });
      socket.on("end", () => { ended = true; });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", () => socket.write(`GET /api/logs/export?since=0&until=40000&format=jsonl HTTP/1.1\r\nHost: localhost\r\nCookie: omni_admin=${cookies.admin}\r\n\r\n`));
        socket.once("data", chunk => {
          socket.pause();
          if (!chunk.toString().startsWith("HTTP/1.1 200")) reject(new Error("slow export status"));
          else resolve();
        });
      });
      socket.on("data", () => socket.pause());
      const timer = setInterval(() => socket.resume(), 200);
      try {
        const latencies: number[] = [];
        for (let i = 0; i < 3; i++) {
          const traffic = await exchange({method:"POST",target:"/v1/chat/completions",headers:[["authorization",`Bearer ${SEED_KEY}`],J],body:JSON.stringify({model:"routing-a6",messages:[{role:"user",content:"hello"}]})});
          if (traffic.status !== 200) throw new Error(`slow-reader traffic status ${traffic.status}`);
          const started = performance.now();
          const admin = await exchange({method:"GET",target:"/api/logs?limit=1",headers:[["cookie",`omni_admin=${cookies.admin}`]]});
          const elapsed = performance.now() - started;
          latencies.push(elapsed);
          if (admin.status !== 200 || elapsed > boundMs) throw new Error(`slow-reader admin status=${admin.status} latency=${elapsed} bound=${boundMs} idle=${idle}`);
        }
        const deadline = Date.now() + 5000;
        let rows = 0;
        while (Date.now() < deadline) {
          rows = (fixture.query("SELECT count(*) AS n FROM request_logs WHERE requested_model='routing-a6'").get() as {n:number}).n;
          if (rows >= 3) break;
          await sleep(50);
        }
        if (ended || rows < 3) throw new Error(`slow-reader progress: ended=${ended} rows=${rows}`);
        const checkpoint = fixture.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {busy:number};
        if (checkpoint.busy !== 0) throw new Error("slow export pins WAL checkpoint");
        writeFileSync(join(out, `slow-reader-${label}.json`), JSON.stringify({latencies, idle, rows, exportOpen:!ended, boundMs}));
      } finally {
        clearInterval(timer);
        socket.destroy();
        fixture.run("DELETE FROM credentials");
        fixture.run("DELETE FROM virtual_models WHERE id='routing-a6'");
        fixture.close();
      }
    }
    if (cfg.label === "nodes") {
      const health = await exchange({method:"GET",target:"/health",headers:[]});
      const own = JSON.parse(health.body.toString()).nodeId;
      if (health.status !== 200 || typeof own !== "string") throw new Error("node identity health response");
      const fixture = new Database(file);
      fixture.run("PRAGMA busy_timeout=5000");
      fixture.run("DELETE FROM nodes");
      fixture.run("INSERT INTO nodes VALUES (?, ?)", [own, nodesNow + 600000]);
      const response = await exchange({method:"GET",target:"/api/nodes",headers:[["cookie",`omni_admin=${cookies.admin}`]]});
      const nodes = JSON.parse(response.body.toString()).nodes;
      if (response.status !== 200 || nodes.length !== 1 || nodes[0].id !== own || nodes[0].self !== true) throw new Error("self-node assertion");
      fixture.run("DELETE FROM nodes");
      fixture.close();
    }
    const fill = (s: string) =>
      s
        .replaceAll("{{seed}}", SEED_ID)
        .replaceAll("{{last}}", m.ids.at(-1) ?? "missing")
        .replace(/\{\{id:(\d+)\}\}/g, (_, n: string) => m.ids[Number(n)] ?? `missing-${n}`);
    const send = async (step: HttpStep): Promise<Ex> => {
      const cookie = cookies[step.who];
      const headers: [string, string][] = [
        ...(step.headers ?? []),
        ...(cookie === null ? [] : ([["cookie", `omni_admin=${cookie}`]] as [string, string][])),
      ];
      return exchange({
        method: step.method ?? "GET",
        target: fill(step.target),
        headers,
        ...(step.body === undefined ? {} : { body: fill(step.body) }),
      });
    };
    const record = (name: string, method: string, x: Ex) => {
      if (
        x.status === 200 &&
        (x.head.find(([k]) => k === "content-type")?.[1] ?? "").startsWith("application/json")
      ) {
        // A body that is not JSON mints nothing; a mint the masker refuses
        // (an id or a raw key issued twice) is this binary's failure.
        let body: unknown;
        try {
          body = JSON.parse(x.body.toString("utf8"));
        } catch {}
        try {
          m.mint(body, name, label);
        } catch (err) {
          secretProblems.push(`${name}: ${(err as Error).message}`);
        }
      }
      seen(name, method, x);
    };
    let mutationAck: number | undefined;
    for (const step of cfg.steps()) {
      if(step.kind === "logs-walk") {
        const ids:string[]=[];
        const pages:unknown[]=[];
        let cursor:string|null=null;
        for(let page=0;page<100;page++) {
          const x=await exchange({target:`/api/logs?limit=17${cursor?`&cursor=${cursor}`:""}`,headers:[["cookie",`omni_admin=${cookies.admin}`]]});
          if(x.status!==200){deadlineFailures.push(`${step.name}: status ${x.status}`);break;}
          const body=JSON.parse(x.body.toString());pages.push(body);
          ids.push(...body.logs.map((l:{id:string})=>l.id));cursor=body.nextCursor;
          if(page===0){const d=new Database(file);d.run("PRAGMA busy_timeout=5000");d.run("INSERT INTO request_logs(id,at,requested_model,status,duration_ms) VALUES('newer-between-pages',1795000000000,'new',200,1)");d.close();}
          if(!cursor)break;
        }
        if(ids.length!==503||new Set(ids).size!==503||ids.some(id=>!/^log-\d{4}$/.test(id))||cursor!==null)deadlineFailures.push(`${step.name}: incomplete traversal ${ids.length}`);
        results.set(step.name,{text:JSON.stringify(pages),db:""});continue;
      }
      if (step.kind === "usage-traffic") {
        await sleep(650);
        const traffic = await exchange({method:"POST",target:"/v1/chat/completions",headers:[["authorization",`Bearer ${SEED_KEY}`],J],body:JSON.stringify({model:"routing-a6",messages:[{role:"user",content:"hello"}]})});
        if (traffic.status !== 200) deadlineFailures.push(`${step.name}: traffic status ${traffic.status}`);
        let answer: Ex | undefined;
        for(let attempt=0;attempt<100;attempt++) {
          answer = await exchange({target:"/api/usage?groupBy=requestedModel",headers:[["cookie",`omni_admin=${cookies.admin}`]]});
          if(answer.status!==200) break;
          const rows=JSON.parse(answer.body.toString()).rows;
          if(rows.length) break;
          await sleep(20);
        }
        if (!answer || answer.status!==200) deadlineFailures.push(`${step.name}: usage status ${answer?.status}`);
        else {
          const parsed=JSON.parse(answer.body.toString());
          const row=parsed.rows[0];
          if(parsed.rows.length!==1 || row.key!=="routing-a6" || row.requests!==1 || row.inputTokens!==1 || row.outputTokens!==1 || row.errors!==0 || !Number.isFinite(row.durationMsSum) || row.durationMsSum<0 || row.durationMsSum>10000) deadlineFailures.push(`${step.name}: invalid usage ${JSON.stringify(parsed)}`);
          if(row) row.durationMsSum="<validated-duration>";
          results.set(step.name,{text:JSON.stringify(parsed),db:""});
        }
        continue;
      }
      if (step.kind === "restart-other") {
        proc.kill("SIGTERM");
        await proc.exited;
        const other = label === "ts" ? flags.rust : flags.ts;
        const restartLog = join(out, `${cfg.label}-${label}-restart.log`);
        proc = Bun.spawn([other as string], {
          cwd: root,
          env: e,
          stdout: Bun.file(restartLog),
          stderr: Bun.file(`${restartLog}.err`),
        });
        children.push(proc);
        await waitHealthy();
        mutationAck = Date.now();
        cookies.admin = await login(PASSWORD, undefined, seen);
        cookies.viewer = await login(VIEWER, "viewer", seen);
        results.set(step.name, {
          text: cookies.admin ? "restarted and authenticated" : "restart login failed",
          db: dump(file, m),
        });
        continue;
      }
      if (step.kind === "credential-routing") {
        const started = mutationAck ?? Date.now();
        let ok = false;
        while (Date.now() - started < 1000) {
          const x = await exchange({
            method: "POST",
            target: "/v1/chat/completions",
            headers: [["authorization", `Bearer ${SEED_KEY}`], J],
            body: JSON.stringify({
              model: step.model ?? "routing-a6",
              messages: [{ role: "user", content: "hello" }],
            }),
          });
          seen(step.name, "POST", x);
          if (
            (step.enabled ? x.status === 200 : x.status === 503) &&
            Date.now() - started <= 1000
          ) {
            ok = true;
            break;
          }
          await sleep(20);
        }
        if (!ok) deadlineFailures.push(`${step.name}: routing not visible within 1s`);
        results.set(step.name, { text: ok ? "within 1s" : "missed", db: "" });
        continue;
      }
      if (step.kind === "sql") {
        const d = new Database(file);
        d.run("PRAGMA busy_timeout=5000");
        for (const q of step.sql) d.run(q);
        mutationAck = Date.now();
        d.close();
        continue;
      }
      if (step.kind === "counter-barrier") {
        const started = Date.now();
        let done = false;
        while (Date.now() - started < 5_000) {
          const x = await exchange({
            method: "POST",
            target: "/v1/messages/count_tokens",
            headers: [
              ["authorization", `Bearer ${rawOf(step.id)}`],
              ["content-type", "application/json"],
            ],
            body: '{"model":"plain","messages":[{"role":"user","content":"hi"}]}',
          });
          const db = new Database(file, { readonly: true });
          db.run("PRAGMA busy_timeout=5000");
          const committed = db
            .query(
              "SELECT count(*) AS n FROM request_logs WHERE api_key_id=? AND status IS NOT NULL",
            )
            .get(step.id) as { n: number };
          db.close();
          if (x.status === step.status && committed.n > 0) {
            done = true;
            break;
          }
          await sleep(10);
        }
        if (!done) deadlineFailures.push(`${step.name}: committed/delivered barrier timed out`);
        results.set(step.name, { text: done ? "barrier reached" : "barrier timed out", db: "" });
        continue;
      }
      if (step.kind === "relogin") {
        const c = await login(step.password, step.mode, seen);
        if (c !== null) cookies[step.who] = c;
        results.set(step.name, { text: c === null ? "refused" : "logged in", db: dump(file, m) });
        continue;
      }
      if (step.kind === "listed" || step.kind === "admitted") {
        const raw =
          step.kind === "listed"
            ? SEED_KEY
            : typeof step.keyIndex === "number"
              ? m.keys[step.keyIndex]
              : step.keyIndex;
        const started = Date.now();
        let last = "";
        let okAt: number | null = null;
        for (;;) {
          const sent = Date.now();
          if (sent - started >= 1_000) break;
          const x = await exchange({
            target: "/v1/models",
            headers: [["authorization", `Bearer ${raw}`]],
          });
          const done = Date.now();
          seen(step.name, "GET", x);
          let hit: boolean;
          if (step.kind === "listed") {
            const ids =
              (JSON.parse(x.body.toString("utf8")) as { data?: { id: string }[] }).data?.map(
                (d) => d.id,
              ) ?? [];
            hit = x.status === 200 && ids.includes(step.id) === step.present;
            last = `${x.status} ${ids.length} ids`;
          } else {
            hit = x.status === step.expect;
            last = String(x.status);
          }
          // Counted only for an answer that also *finished* inside the bound.
          if (hit && done - started <= 1_000) {
            okAt = done - started;
            break;
          }
          await sleep(20);
        }
        const verdict = okAt === null ? `MISSED (last ${last})` : "ok";
        notes.push(`${step.name}: ${verdict}${okAt === null ? "" : ` after ${okAt} ms`}`);
        if (okAt === null) deadlineFailures.push(`${step.name}: last answer ${last}`);
        results.set(step.name, {
          text: okAt === null ? "not within 1 s" : "ok within 1 s",
          db: "",
        });
        continue;
      }
      if (step.kind === "v1") {
        const raw = typeof step.key === "number" ? m.keys[step.key] : step.key;
        let x: Ex;
        try {
          x = await exchange({
            method: step.method ?? "POST",
            target: step.target,
            headers: [
              ["authorization", `Bearer ${raw}`],
              ["content-type", "application/json"],
            ],
            ...(step.body === undefined ? {} : { body: step.body }),
          });
        } catch (err) {
          results.set(step.name, { text: `${TRANSPORT_ERROR} ${String(err)}`, db: "" });
          continue;
        }
        record(step.name, step.method ?? "POST", x);
        results.set(step.name, { text: normalizeV1(x, m), db: dump(file, m) });
        continue;
      }
      if (step.kind === "concurrent") {
        const answers = await Promise.all(step.steps.map((st) => send(st)));
        for (const [i, x] of answers.entries())
          record(`${step.name} #${i}`, step.steps[i]?.method ?? "GET", x);
        const statuses = answers.map((x) => x.status).sort();
        results.set(step.name, {
          text: `statuses ${statuses.join(",")}`,
          db: step.settle === undefined ? dump(file, m) : step.settle(file),
        });
        continue;
      }
      let x: Ex;
      const readTimes = () => {
        const d = new Database(file, { readonly: true });
        d.run("PRAGMA busy_timeout=5000");
        const row = d
          .query("SELECT updated_at,disabled_at FROM credentials WHERE id='cred-custom'")
          .get() as { updated_at: number; disabled_at: number | null };
        d.close();
        return row;
      };
      const before = step.timestamps ? readTimes() : undefined;
      if (before) await sleep(5);
      const sentAt = Date.now();
      try {
        x = await send(step);
        if (["POST", "PUT", "PATCH", "DELETE"].includes(step.method ?? "GET"))
          mutationAck = Date.now();
      } catch (err) {
        results.set(step.name, { text: `${TRANSPORT_ERROR} ${String(err)}`, db: "" });
        continue;
      }
      if (x.status === 0) {
        results.set(step.name, { text: `${TRANSPORT_ERROR} no response`, db: "" });
        continue;
      }
      record(step.name, step.method ?? "GET", x);
      if (step.expectedStatus !== undefined && x.status !== step.expectedStatus)
        deadlineFailures.push(`${step.name}: expected status ${step.expectedStatus}, got ${x.status}`);
      if (before) {
        const after = readTimes();
        const ok =
          step.timestamps === "unchanged"
            ? after.updated_at === before.updated_at && after.disabled_at === before.disabled_at
            : after.updated_at > before.updated_at &&
              after.updated_at >= sentAt &&
              after.updated_at <= Date.now() &&
              (step.timestamps === "enable"
                ? after.disabled_at === null
                : after.disabled_at !== null &&
                  after.disabled_at >= sentAt &&
                  after.disabled_at <= Date.now());
        if (!ok)
          deadlineFailures.push(
            `${step.name}: timestamp invariant failed ${JSON.stringify({ before, after })}`,
          );
      }
      results.set(step.name, { text: normalize(x, m), db: dump(file, m) });
      // Keys list newest first, and two mints in one millisecond tie: give
      // each sequential mint its own instant so both builds order alike.
      if (step.method === "POST" && fill(step.target) === "/api/keys") await sleep(3);
    }
  } finally {
    try {
      const status = readFileSync(`/proc/${proc.pid}/status`, "utf8");
      writeFileSync(join(out, `${cfg.label}-${label}-rss.txt`), status.split("\n").filter(l => /^Vm(HWM|RSS):/.test(l)).join("\n")+"\n");
    } catch {}
    proc.kill("SIGTERM");
    await proc.exited;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !readFileSync(logFile, "utf8").includes("shutdown requested"))
    await sleep(25);
  const lines = readFileSync(logFile, "utf8")
    .split("\n")
    .map((l) => l.replace(/^\S+ /, ""))
    .filter((l) =>
      /^\w+ +(admin password|viewer|provider catalog|api key limits|credential enabled|credential disabled)/.test(
        l,
      ),
    )
    .map((l) => m.text(l));
  // What the process wrote to stdout and stderr counts as sent too.
  for (const [stream, f] of [
    ["stdout", logFile],
    ["stderr", `${logFile}.err`],
    ...(["credential-crossread", "credential-identity"].includes(cfg.label)
      ? ([
          ["restart stdout", join(out, `${cfg.label}-${label}-restart.log`)],
          ["restart stderr", join(out, `${cfg.label}-${label}-restart.log.err`)],
        ] as const)
      : []),
  ] as const) {
    const text = readFileSync(f);
    for (const raw of ["secret-a6-1", "secret-a6-2", "secret-a6-3"]) {
      if (text.includes(raw)) secretProblems.push(`${stream}: credential secret exposed`);
    }
    for (const raw of allRawKeys.keys())
      for (let n = occurrences(text, raw); n > 0; n--) m.sightings.push(`${stream}\u0000${raw}`);
  }
  // Each raw key this binary minted occurs exactly once in all of that: in
  // the body of the answer that minted it. No other raw key occurs at all.
  for (const raw of m.keys) {
    const seen = m.sightings
      .filter((s) => s.endsWith(`\u0000${raw}`))
      .map((s) => s.split("\u0000")[0]);
    if (seen.length !== 1 || seen[0] !== m.mintedIn.get(raw))
      secretProblems.push(
        `${raw.slice(0, 12)} minted in ${m.mintedIn.get(raw)}, seen in ${JSON.stringify(seen)}`,
      );
  }
  for (const s of m.sightings) {
    const raw = s.split("\u0000")[1] as string;
    if (!m.keys.includes(raw))
      secretProblems.push(`foreign key ${raw.slice(0, 12)} seen in ${s.split("\u0000")[0]}`);
  }
  return {
    results,
    lines,
    secretProblems,
    minted: m.keys.length,
    notes,
    deadlineFailures,
    lengthFailures,
  };
}

let failures = 0;
let equal = 0;
let expected = 0;
const report: string[] = [];
for (const cfg of configs) {
  if (flags.only !== undefined && cfg.label !== flags.only) continue;
  const ts = await runOne("ts", resolve(REPO, flags.ts as string), cfg);
  const rs = await runOne("rust", resolve(REPO, flags.rust as string), cfg);
  const names = new Set([...ts.results.keys(), ...rs.results.keys()]);
  const pinned = new Map<string, ExpectDiff>();
  for (const step of cfg.steps())
    if (step.kind === "v1" && step.expectDiff !== undefined) pinned.set(step.name, step.expectDiff);
  for (const name of names) {
    const a = ts.results.get(name);
    const b = rs.results.get(name);
    if (
      a === undefined ||
      b === undefined ||
      a.text.startsWith(TRANSPORT_ERROR) ||
      b.text.startsWith(TRANSPORT_ERROR)
    ) {
      failures++;
      report.push(`TRANSPORT ${cfg.label}: ${name}\n--- ts\n${a?.text}\n--- rust\n${b?.text}\n`);
      continue;
    }
    const pin = pinned.get(name);
    if (pin !== undefined) {
      // Both sides exactly as pinned, and different: nothing else passes.
      if (a.text === b.text || a.text !== pin.ts || b.text !== pin.rust) {
        failures++;
        report.push(
          `${a.text === b.text ? "UNEXPECTED-EQUAL" : "WRONG-DIVERGENCE"} ${cfg.label}: ${name} (${pin.why})\n--- want ts\n${pin.ts}\n--- want rust\n${pin.rust}\n--- ts\n${a.text.slice(0, 3000)}\n--- rust\n${b.text.slice(0, 3000)}\n`,
        );
      } else {
        expected++;
        report.push(`expected-diff ${cfg.label}: ${name} (${pin.why})`);
      }
    } else if (a.text === b.text) equal++;
    else {
      failures++;
      report.push(
        `DIFF ${cfg.label}: ${name}\n--- ts\n${a.text.slice(0, 3000)}\n--- rust\n${b.text.slice(0, 3000)}\n`,
      );
    }
    if (a.db === b.db) equal++;
    else {
      failures++;
      report.push(
        `DB ${cfg.label}: after ${name}\n--- ts\n${a.db.slice(0, 4000)}\n--- rust\n${b.db.slice(0, 4000)}\n`,
      );
    }
  }
  if (JSON.stringify(ts.lines) === JSON.stringify(rs.lines)) equal++;
  else {
    failures++;
    report.push(
      `LOGS ${cfg.label}:\n--- ts\n${ts.lines.join("\n")}\n--- rust\n${rs.lines.join("\n")}\n`,
    );
  }
  // A raw key occurs once in what the driver reads back: in its own
  // creation's answer.
  for (const [side, run] of [
    ["ts", ts],
    ["rust", rs],
  ] as const) {
    if (run.secretProblems.length > 0) {
      failures++;
      report.push(`SECRET ${cfg.label} ${side}:\n${run.secretProblems.join("\n")}`);
    } else equal++;
    // Deadlines are the spec's, per binary: equal misses are still misses.
    for (const d of run.deadlineFailures) {
      failures++;
      report.push(`DEADLINE ${cfg.label} ${side}: ${d}`);
    }
    // Framing is each binary's own: equal wrong lengths are still wrong.
    if (run.lengthFailures.length > 0) {
      failures++;
      report.push(`LENGTH ${cfg.label} ${side}:\n${run.lengthFailures.join("\n")}`);
    } else equal++;
  }
  report.push(
    ...ts.notes.map((n) => `note ${cfg.label} ts: ${n}`),
    ...rs.notes.map((n) => `note ${cfg.label} rust: ${n}`),
  );
  writeFileSync(
    join(out, `${cfg.label}-ts.json`),
    JSON.stringify(Object.fromEntries(ts.results), null, 1),
  );
  writeFileSync(
    join(out, `${cfg.label}-rust.json`),
    JSON.stringify(Object.fromEntries(rs.results), null, 1),
  );
}
const summary = `admin-routes: ${equal} equal, ${expected} expected divergences, ${failures} failures, ${allRawKeys.size} raw keys minted`;
writeFileSync(join(out, "report.txt"), `${report.join("\n")}\n${summary}\n`);
console.log(report.join("\n"));
console.log(summary);
credentialUpstream.stop(true);
rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
