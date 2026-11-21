#!/usr/bin/env bun
/** A15 review5 held-poll witness; run only via oauth-race-ns.sh with a local TLS stub. */
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { decrypt, deriveKey } from "../../packages/store/src/encryption.ts";
import { createStore } from "../../packages/store/src/sqlite/store.ts";
import {
  type Leg,
  oauthRaceVerdict,
  type RaceObservation,
  type Reply,
} from "./oauth-race-accepted.ts";

const [frozen, rust, work] = Bun.argv.slice(2);
assert(frozen && rust && work && dirname(work) === "/tmp/opencode/f3/race-witness");
assert.equal(process.env.OMNI_RACE_NETNS, readlinkSync("/proc/self/ns/net"));
const path = process.env.PATH;
assert(path);
const cert = join(work, "cert.pem");
const secret = "oauth-race-fixture-key-01234567890123456789";
const password = "oauth-race-fixture-password";
const fieldKey = await deriveKey(secret);
const seedPath = join(work, "seed.db");
const seed = await createStore({ path: seedPath, encryptionKey: fieldKey });
await seed.close();
const db = new Database(seedPath);
db.run("INSERT INTO settings (key,value) VALUES ('adminPasswordHash',?)", [
  await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 }),
]);
db.close();

const providers = {
  anthropic: { host: "api.anthropic.com", path: "/v1/oauth/token" },
  openai: { host: "auth.openai.com", path: "/oauth/token" },
} as const;
type Provider = keyof typeof providers;
const legs = ["poll", "finish"] as const;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nonce = /^[\w-]{43}$/;
const secrets = ["access_token", "refresh_token", "id_token", "api_key"] as const;
const tokenBody = '{"access_token":"review-access","refresh_token":"review-refresh"}';
type Wire = { line: string; headers: string[]; body: string };
let wires: Wire[] = [];
const held: (() => void)[] = [];
let racing = false;
const release = () => {
  for (const reply of held.splice(0)) reply();
};
const stub = Bun.listen<{ buffer: Buffer; seen: boolean }>({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: Bun.file(cert), key: Bun.file(join(work, "key.pem")) },
  socket: {
    open(s) {
      s.data = { buffer: Buffer.alloc(0), seen: false };
    },
    data(s, chunk) {
      if (s.data.seen) return;
      const bytes = Buffer.concat([s.data.buffer, chunk]);
      s.data.buffer = bytes;
      const end = bytes.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [line = "", ...headers] = bytes.subarray(0, end).toString().split("\r\n");
      const length = Number(headers.find((h) => /^content-length:/i.test(h))?.split(":")[1] ?? 0);
      if (bytes.length < end + 4 + length) return;
      s.data.seen = true;
      const body = bytes.subarray(end + 4).toString();
      wires.push({ line, headers, body });
      const reply = () =>
        s.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(tokenBody)}\r\nConnection: close\r\n\r\n${tokenBody}`,
        );
      if (racing && wires.length <= 2) {
        held.push(reply);
        if (held.length === 2) release();
      } else reply();
    },
  },
});

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function checkedWire(
  wire: Wire,
  provider: Provider,
  state: string,
  challenge: string,
): { leg: Leg; request: Wire } {
  const { host, path } = providers[provider];
  assert.equal(wire.line, `POST ${path} HTTP/1.1`);
  const header = (key: string) => wire.headers.filter((h) => h.toLowerCase().startsWith(`${key}:`));
  assert.deepEqual(header("host"), [`Host: ${host}`]);
  assert.deepEqual(header("content-length"), [`Content-Length: ${Buffer.byteLength(wire.body)}`]);
  const form = provider === "openai";
  const fields = record(
    form ? Object.fromEntries(new URLSearchParams(wire.body)) : JSON.parse(wire.body),
  );
  assert(fields.code === "" || fields.code === "code");
  const verifier = fields.code_verifier;
  assert(typeof verifier === "string" && nonce.test(verifier));
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
  assert.equal(fields.state, form ? undefined : state);
  const body = form
    ? wire.body.replace(`code_verifier=${verifier}&`, "code_verifier=<verifier>&")
    : wire.body
        .replace(`"code_verifier":"${verifier}"`, '"code_verifier":"<verifier>"')
        .replace(`"state":"${state}"`, '"state":"<state>"');
  return {
    leg: fields.code === "" ? "poll" : "finish",
    request: {
      ...wire,
      headers: wire.headers.map((h) =>
        /^content-length:/i.test(h) ? "Content-Length: <validated>" : h,
      ),
      body,
    },
  };
}

async function credentials(
  file: string,
  provider: Provider,
  ids: Map<string, Leg>,
  since: number,
  until: number,
) {
  const reader = new Database(file, { readonly: true });
  const rows = reader.query<Record<string, unknown>, []>("SELECT * FROM credentials").all();
  reader.close();
  assert.equal(rows.length, ids.size, "saved rows must match successful response IDs exactly");
  const saved = await Promise.all(
    rows.map(async (row) => {
      assert(typeof row.id === "string" && uuid4.test(row.id));
      const leg = ids.get(row.id);
      assert(leg);
      assert.equal(row.provider, provider);
      assert.equal(row.label, "race");
      for (const field of secrets) {
        const value = row[field];
        assert(value === null || typeof value === "string");
        row[field] = value === null ? null : await decrypt(fieldKey, value);
      }
      assert.equal(row.access_token, "review-access");
      assert.equal(row.refresh_token, "review-refresh");
      for (const field of ["created_at", "updated_at"] as const) {
        const time = row[field];
        assert(
          typeof time === "number" && Number.isSafeInteger(time) && time >= since && time <= until,
        );
      }
      assert.equal(row.created_at, row.updated_at);
      row.created_at = row.updated_at = "<request-time>";
      if (provider === "openai") {
        assert(typeof row.provider_data === "string");
        const data = record(JSON.parse(row.provider_data));
        const { installationId, idSalt } = data;
        assert(typeof installationId === "string" && uuid4.test(installationId));
        assert(typeof idSalt === "string" && /^[0-9a-f]{64}$/.test(idSalt));
        row.provider_data = row.provider_data
          .replace(`"installationId":"${installationId}"`, '"installationId":"<installation>"')
          .replace(`"idSalt":"${idSalt}"`, '"idSalt":"<salt>"');
      }
      row.id = "<credential-id>";
      return { leg, row };
    }),
  );
  return saved.sort((a, b) => legs.indexOf(a.leg) - legs.indexOf(b.leg));
}

async function run(
  label: string,
  binary: string,
  provider: Provider,
  work: string,
): Promise<RaceObservation> {
  const root = join(work, `${label}-${provider}`);
  mkdirSync(root);
  const file = join(root, "omni.db");
  copyFileSync(seedPath, file);
  const proc = Bun.spawn([binary], {
    cwd: root,
    env: {
      PATH: path,
      HOME: root,
      TMPDIR: root,
      OMNI_ROOT: root,
      OMNI_DB_PATH: file,
      OMNI_STATIC_DIR: join(root, "absent"),
      OMNI_ENCRYPTION_KEY: secret,
      OMNI_HOST: "127.0.0.1",
      OMNI_PORT: "18515",
      OMNI_DAY_OFFSET_MINUTES: "0",
      OMNI_CLUSTER_MODE: "false",
      NODE_EXTRA_CA_CERTS: cert,
      SSL_CERT_FILE: cert,
    },
    stdout: Bun.file(join(root, "gateway.log")),
    stderr: Bun.file(join(root, "gateway.err")),
  });
  let cookie = "";
  async function request(path: string, body?: object): Promise<Reply> {
    const response = await fetch(`http://127.0.0.1:18515${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(10_000),
    });
    return {
      status: response.status,
      body: await response.json(),
      type: response.headers.get("content-type"),
      cookie: response.headers.get("set-cookie"),
    };
  }
  wires = [];
  try {
    const readyBy = Date.now() + 10_000;
    for (;;) {
      const health = await request("/health").catch(() => null);
      if (health?.status === 200) break;
      assert(proc.exitCode === null && Date.now() < readyBy, `${label}/${provider} failed to boot`);
      await Bun.sleep(25);
    }
    const login = await request("/api/login", { password });
    assert(login.status === 200 && login.cookie);
    cookie = login.cookie.split(";", 1)[0] ?? "";
    assert(cookie);
    const start = await request("/api/connect/start", { provider, label: "race" });
    assert.equal(start.status, 200);
    const started = record(start.body);
    const { flowId, authorizeUrl } = started;
    assert(typeof flowId === "string" && nonce.test(flowId) && typeof authorizeUrl === "string");
    const url = new URL(authorizeUrl);
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    assert(state && challenge && nonce.test(state) && nonce.test(challenge));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(wires.length, 0, "unexpected exchange before race");

    const body = { flowId, code: `code#${state}` };
    racing = true;
    const since = Date.now();
    // Do not start finish until poll is held upstream. Release on a second
    // upstream call or when finish rejects without making a call (D4).
    let pollEnded = false;
    const first = request("/api/connect/poll", body).finally(() => {
      pollEnded = true;
    });
    // Attach a handler before waiting for arrival; Promise.all still sees the error.
    void first.catch(() => {});
    const arrival = Date.now() + 5_000;
    while (wires.length === 0) {
      assert(
        !pollEnded && Date.now() < arrival,
        `${label}/${provider}: poll did not reach the stub`,
      );
      await Bun.sleep(5);
    }
    const firstWire = wires[0];
    assert(firstWire && checkedWire(firstWire, provider, state, challenge).leg === "poll");
    const second = request("/api/connect/finish", body).finally(release);
    const [poll, finish] = await Promise.all([first, second]);
    const until = Date.now();
    racing = false;
    const followUp = await request("/api/connect/poll", body);
    const ids = new Map<string, Leg>();
    for (const [leg, reply] of [
      ["poll", poll],
      ["finish", finish],
    ] as const) {
      if (reply.status !== 200) continue;
      const payload = record(reply.body);
      const id = payload.id;
      assert(typeof id === "string" && uuid4.test(id) && !ids.has(id));
      ids.set(id, leg);
      reply.body = { ...payload, id: "<credential-id>" };
    }
    await Bun.write(join(root, "wire.json"), JSON.stringify(wires, null, 2));
    return {
      start: {
        ...start,
        body: {
          ...started,
          flowId: "<flow>",
          authorizeUrl: authorizeUrl
            .replace(`state=${state}`, "state=<state>")
            .replace(`code_challenge=${challenge}`, "code_challenge=<challenge>"),
        },
      },
      poll,
      finish,
      followUp,
      exchanges: wires.map((wire) => checkedWire(wire, provider, state, challenge)),
      credentials: await credentials(file, provider, ids, since, until),
    };
  } finally {
    racing = false;
    release();
    proc.kill();
    await proc.exited;
  }
}

let failures = 0;
let expectedDivergences = 0;
try {
  for (const provider of ["anthropic", "openai"] as const) {
    const name = `${provider}/mixed-poll-finish`;
    try {
      const ts = await run("frozen", frozen, provider, work);
      const rs = await run("rust", rust, provider, work);
      await Bun.write(
        join(work, `${provider}.json`),
        JSON.stringify({ frozen: ts, rust: rs }, null, 2),
      );
      const verdict = oauthRaceVerdict(name, ts, rs);
      if (verdict) {
        expectedDivergences++;
        console.log(`expected-diff ${name} (${verdict})`);
      } else {
        failures++;
        console.error(`FAILED ${name}: see ${provider}.json`);
      }
    } catch (error) {
      failures++;
      console.error(`FAILED ${name}:`, error);
    }
  }
} finally {
  stub.stop(true);
}
console.log(JSON.stringify({ expectedDivergences, failures }));
process.exitCode = expectedDivergences === 2 && failures === 0 ? 0 : 1;
