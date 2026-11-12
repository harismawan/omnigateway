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
 * Beyond equality, asserted on both binaries:
 * - a raw key appears in exactly one response, its creation's;
 * - a key minted over the API authenticates on `/v1/models` within 1 s, and
 *   one revoked over the API is refused within 1 s (the spec's snapshot
 *   invalidation bound);
 * - a password change ends every session (the caller's included), a viewer
 *   password change ends viewer sessions only.
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
  },
});
if (flags.ts === undefined || flags.rust === undefined) {
  console.error("usage: admin-routes.ts --ts <binary> --rust <binary> [--out dir] [--only config]");
  process.exit(2);
}

const REPO = resolve(import.meta.dir, "../..");
const KEY = "conformance-admin-routes-encryption-key-01";
const PORT = 18443;
mkdirSync("/tmp/opencode", { recursive: true });
const work = mkdtempSync("/tmp/opencode/omni-admin-routes-");
const out = flags.out ?? join(work, "out");
mkdirSync(out, { recursive: true });
const children: Subprocess[] = [];
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

/** Per-binary state: the ids, keys, prefixes and hashes it minted. */
class Masker {
  ids: string[] = [];
  keys: string[] = [];
  /** Every raw key this binary returned, with the step that returned it. */
  sightings: string[] = [];

  /** Records a creation answer (validated) and returns its body masked. */
  mint(body: unknown, step: string, side: string): void {
    if (typeof body !== "object" || body === null) return;
    const b = body as Record<string, unknown>;
    if (typeof b.id !== "string" || !UUID.test(b.id)) return;
    if (typeof b.key !== "string" || !RAW.test(b.key)) return;
    if (b.prefix !== b.key.slice(0, 12)) return;
    if (this.ids.includes(b.id)) throw new Error(`${side}: id minted twice`);
    if (allRawKeys.has(b.key)) throw new Error(`raw key minted twice (${side}, ${step})`);
    allRawKeys.set(b.key, side);
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
  return json.replace(/"(createdAt|revokedAt|created_at|revoked_at)":(\d{13})/g, (m, k, v) =>
    nearNow(Number(v)) ? `"${k}":"<now>"` : m,
  );
}

function normalize(x: Ex, m: Masker): string {
  const now = Date.now() / 1000;
  const head = x.head
    .filter(([k, v]) => !(k === "connection" && v === "close"))
    .map(([k, v]) => {
      if (k === "date") {
        const t = Date.parse(v);
        if (!Number.isNaN(t) && Math.abs(t / 1000 - now) < 120) return "date: <date>";
      }
      if (k === "content-length") return "content-length: <n>";
      return `${k}: ${v}`;
    })
    .sort();
  return `${x.status}\n${head.join("\n")}\n\n${maskTimes(m.text(x.body.toString("latin1")))}`;
}

/** Every table but the ones the gateway writes on its own clock, sorted. */
function dump(file: string, m: Masker): string {
  const d = new Database(file, { readonly: true });
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
  kind?: "http";
  name: string;
  who: Who;
  method?: string;
  target: string;
  body?: string;
  headers?: [string, string][];
};
type Step =
  | HttpStep
  /** `n` copies of `step` at once; statuses compared as a multiset, DB after. */
  | {
      kind: "concurrent";
      name: string;
      steps: HttpStep[];
      /** For an outcome the scheduler picks: a verdict instead of a DB dump. */
      settle?: (file: string) => string;
    }
  /** Mint over the API, then poll `/v1/models` with the raw key: 200 within 1 s. */
  | { kind: "admitted"; name: string; keyIndex: number; expect: 200 | 401 }
  /** Poll `/v1/models` with the seeded key until `id` is (or is not) listed, ≤ 1 s. */
  | { kind: "listed"; name: string; id: string; present: boolean }
  /** Log in again (after a session-ending change). */
  | { kind: "relogin"; name: string; who: "admin" | "viewer"; password: string; mode?: string }
  /**
   * A hand edit while the gateway runs: the Rust snapshot refuses to *boot*
   * on some rows TS reads lazily (pre-existing; see the A5 report), so rows
   * only the admin routes are meant to trip on are written after boot.
   */
  | { kind: "sql"; name: string; sql: string[] };

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
    as("admin", "PUT", "/api/models/m-new", model("m-new")),
  ];
}
const ODD_SQL = [
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,model_allowlist) VALUES ('odd-limits','l','p1','h1','{"requests":{"1m":0}}',1600000000000,'["a",5,null,{"x":1}]')`,
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,model_allowlist) VALUES ('odd-allow','l','p2','h2','{"models":{"\\ud800":{"concurrency":1}}}',1600000000001,'"str"')`,
  // Integer dates only: a REAL \`created_at\` stops the Rust gateway at boot
  // (snapshot reader, pre-existing; recorded in the A5 report).
  `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,expires_at,revoked_at) VALUES ('odd-dates','l','p3','h3','{}',1500000000000,2500,3)`,
  `INSERT INTO virtual_models VALUES ('odd-m','[{"provider":"anthropic","model":"\\ud800","x":[1,{"y":1e400}]}]','weird',2)`,
  `INSERT INTO settings(key,value) VALUES('settings','{"maxAttempts":"x","extra":[1,{"a":"\\udc00"}],"guardrailModel":"  g ","smartRouterLocalModel":"odd-m"}')`,
];

type Config = { label: string; db: () => string; steps: () => Step[] };
const configs: Config[] = [
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
  {
    label: "broken-rows",
    db: () => db("broken-rows", [`INSERT INTO virtual_models VALUES ('bad','{bad','score',0)`]),
    steps: () => [
      {
        kind: "sql",
        name: "hand-edited rows",
        sql: [
          `INSERT INTO api_keys (id,label,prefix,hash,limits,created_at,model_allowlist) VALUES ('bad','l','p','h','{}',1,'{bad')`,
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

function cookieOf(x: Ex): string | null {
  const c = x.head.find(([k]) => k === "set-cookie")?.[1];
  const m = c === undefined ? null : /^omni_admin=([^;]+);/.exec(c);
  return m?.[1] ?? null;
}

async function login(password: string, mode?: string): Promise<string | null> {
  const x = await exchange({
    method: "POST",
    target: "/api/login",
    headers: [J],
    body: JSON.stringify(mode === undefined ? { password } : { password, mode }),
  });
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
  };
  const logFile = join(out, `${cfg.label}-${label}.log`);
  const proc = Bun.spawn([binary], {
    cwd: root,
    env: e,
    stdout: Bun.file(logFile),
    stderr: Bun.file(`${logFile}.err`),
  });
  children.push(proc);
  const m = new Masker();
  const results = new Map<string, Result>();
  const notes: string[] = [];
  try {
    await waitHealthy();
    const cookies: Record<Who, string | null> = {
      admin: await login(PASSWORD),
      viewer: await login(VIEWER, "viewer"),
      anon: null,
    };
    if (cookies.admin === null || cookies.viewer === null) throw new Error("seed login failed");
    const fill = (s: string) =>
      s
        .replaceAll("{{seed}}", SEED_ID)
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
    const record = (name: string, x: Ex) => {
      if (
        x.status === 200 &&
        (x.head.find(([k]) => k === "content-type")?.[1] ?? "").startsWith("application/json")
      ) {
        try {
          m.mint(JSON.parse(x.body.toString("utf8")), name, label);
        } catch {}
      }
      for (const raw of allRawKeys.keys())
        if (x.body.includes(raw)) m.sightings.push(`${name}: ${raw.slice(0, 12)}`);
    };
    for (const step of cfg.steps()) {
      if (step.kind === "sql") {
        const d = new Database(file);
        for (const q of step.sql) d.run(q);
        d.close();
        continue;
      }
      if (step.kind === "relogin") {
        const c = await login(step.password, step.mode);
        if (c !== null) cookies[step.who] = c;
        results.set(step.name, { text: c === null ? "refused" : "logged in", db: dump(file, m) });
        continue;
      }
      if (step.kind === "listed") {
        const started = Date.now();
        let ok = false;
        while (Date.now() - started < 1_000) {
          const x = await exchange({
            target: "/v1/models",
            headers: [["authorization", `Bearer ${SEED_KEY}`]],
          });
          const ids =
            (JSON.parse(x.body.toString("utf8")) as { data?: { id: string }[] }).data?.map(
              (d) => d.id,
            ) ?? [];
          if (ids.includes(step.id) === step.present) {
            ok = true;
            break;
          }
          await sleep(20);
        }
        notes.push(`${step.name}: ${ok ? "ok" : "MISSED"} after ${Date.now() - started} ms`);
        results.set(step.name, { text: ok ? "ok within 1 s" : "not within 1 s", db: "" });
        continue;
      }
      if (step.kind === "admitted") {
        const raw = m.keys[step.keyIndex];
        const started = Date.now();
        let status = 0;
        while (Date.now() - started < 1_000) {
          const x = await exchange({
            target: "/v1/models",
            headers: [["authorization", `Bearer ${raw}`]],
          });
          status = x.status;
          if (status === step.expect) break;
          await sleep(20);
        }
        const ms = Date.now() - started;
        notes.push(`${step.name}: ${status} after ${ms} ms`);
        results.set(step.name, {
          text: status === step.expect ? `ok within 1 s` : `status ${status} after ${ms} ms`,
          db: "",
        });
        continue;
      }
      if (step.kind === "concurrent") {
        const answers = await Promise.all(step.steps.map((st) => send(st)));
        for (const [i, x] of answers.entries()) record(`${step.name} #${i}`, x);
        const statuses = answers.map((x) => x.status).sort();
        results.set(step.name, {
          text: `statuses ${statuses.join(",")}`,
          db: step.settle === undefined ? dump(file, m) : step.settle(file),
        });
        continue;
      }
      let x: Ex;
      try {
        x = await send(step);
      } catch (err) {
        results.set(step.name, { text: `${TRANSPORT_ERROR} ${String(err)}`, db: "" });
        continue;
      }
      if (x.status === 0) {
        results.set(step.name, { text: `${TRANSPORT_ERROR} no response`, db: "" });
        continue;
      }
      record(step.name, x);
      results.set(step.name, { text: normalize(x, m), db: dump(file, m) });
    }
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !readFileSync(logFile, "utf8").includes("shutdown requested"))
    await sleep(25);
  const lines = readFileSync(logFile, "utf8")
    .split("\n")
    .map((l) => l.replace(/^\S+ /, ""))
    .filter((l) => /^\w+ +(admin password|viewer|provider catalog|api key limits)/.test(l))
    .map((l) => m.text(l));
  return { results, lines, sightings: m.sightings, minted: m.keys.length, notes };
}

let failures = 0;
let equal = 0;
const report: string[] = [];
for (const cfg of configs) {
  if (flags.only !== undefined && cfg.label !== flags.only) continue;
  const ts = await runOne("ts", resolve(REPO, flags.ts as string), cfg);
  const rs = await runOne("rust", resolve(REPO, flags.rust as string), cfg);
  const names = new Set([...ts.results.keys(), ...rs.results.keys()]);
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
    if (a.text === b.text) equal++;
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
  // A raw key leaves the gateway once: in its own creation's answer.
  for (const [side, run] of [
    ["ts", ts],
    ["rust", rs],
  ] as const) {
    if (run.sightings.length !== run.minted) {
      failures++;
      report.push(
        `SECRET ${cfg.label} ${side}: ${run.minted} keys minted, raw keys seen ${run.sightings.length} times:\n${run.sightings.join("\n")}`,
      );
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
const summary = `admin-routes: ${equal} equal, ${failures} failures, ${allRawKeys.size} raw keys minted`;
writeFileSync(join(out, "report.txt"), `${report.join("\n")}\n${summary}\n`);
console.log(report.join("\n"));
console.log(summary);
rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
