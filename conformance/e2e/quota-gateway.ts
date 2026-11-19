// Supported B10 mainflows, private provider TLS stub; invoked by quota-gateway-ns.sh.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deriveKey, encrypt } from "../../packages/store/src/encryption.ts";
import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
const [ts, rust, out] = process.argv.slice(2).map((p) => resolve(p));
const key = await deriveKey("b10-private-secret");
let requests: string[] = [];
let mode = "ok";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: Bun.file(join(out!, "cert.pem")), key: Bun.file(join(out!, "key.pem")) },
  fetch(req) {
    const u = new URL(req.url);
    requests.push(u.pathname);
    if (mode === "limited") return Response.json({}, { status: 429 });
    if (mode === "empty") return Response.json({}, { status: 401 });
    const data = u.pathname.includes("/oauth/token")
      ? { access_token: "renewed", refresh_token: "rotated", expires_in: 3600 }
      : u.pathname.includes("/profile")
        ? { organization: { uuid: "fixture-org" } }
        : u.pathname.includes("reset_rate_limits")
          ? { result: "reset", cleared: ["five_hour"] }
          : u.search.includes("cedar_ember")
            ? { cedar_ember: { grants: [{ id: "grant", resets_left: 1, usable_now: true }] } }
            : u.pathname.includes("consume")
              ? { windows_reset: 2 }
              : u.pathname.includes("reset-credits")
                ? { credits: [{ id: "credit", status: "available", expires_at: null }] }
                : u.pathname.includes("QuotaSummary")
                  ? {
                      groups: [
                        {
                          displayName: "Gemini",
                          buckets: [
                            {
                              bucketId: "weekly",
                              remainingFraction: 0.75,
                              resetTime: "2030-01-01T00:00:00Z",
                            },
                          ],
                        },
                      ],
                    }
                  : u.host === "chatgpt.com"
                    ? {
                        rate_limit: {
                          primary_window: {
                            used_percent: 25,
                            reset_at: 1893456000,
                            limit_window_seconds: 18000,
                          },
                        },
                      }
                    : { five_hour: { utilization: 25, resets_at: "2030-01-01T00:00:00Z" } };
    return Response.json(data);
  },
});
const all: unknown[] = [];
let failed = 0;
for (const [index, binary] of [ts!, rust!].entries()) {
  const root = join(out!, `side-${index}`);
  mkdirSync(root);
  const env = {
    PATH: process.env.PATH!,
    HOME: root,
    TMPDIR: root,
    OMNI_ROOT: root,
    OMNI_DB_PATH: join(root, "db"),
    OMNI_ENCRYPTION_KEY: "b10-private-secret",
    OMNI_HOST: "127.0.0.1",
    OMNI_PORT: "18510",
    OMNI_LOG_LEVEL: "warn",
    NODE_EXTRA_CA_CERTS: join(out!, "cert.pem"),
    SSL_CERT_FILE: join(out!, "cert.pem"),
  };
  const launch = () =>
    Bun.spawn([binary], {
      cwd: root,
      env,
      stdout: Bun.file(join(root, "stdout")),
      stderr: Bun.file(join(root, "stderr")),
    });
  let child = launch();
  const wait = async () => {
    for (let n = 0; n < 200; n++) {
      try {
        if ((await fetch("http://127.0.0.1:18510/health")).ok) return;
      } catch {}
      await Bun.sleep(25);
    }
    throw Error("boot");
  };
  await wait();
  const call = async (path: string, body?: unknown, cookie?: string) => {
    const r = await fetch(`http://127.0.0.1:18510${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      body: await r.text().then((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return { text: s };
        }
      }),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  };
  await call("/api/setup", { password: "b10-private-password" });
  const login = await call("/api/login", { password: "b10-private-password" });
  const cookie = login.cookie!;
  const pushed: { type: string; topic?: string }[] = [];
  const socket = new WebSocket("ws://127.0.0.1:18510/api/stream", { headers: { cookie } });
  socket.onmessage = (e) => pushed.push(JSON.parse(String(e.data)));
  await new Promise<void>((ok, no) => {
    socket.onopen = () => ok();
    socket.onerror = no;
  });
  socket.send(JSON.stringify({ type: "subscribe", topic: "res:quota" }));
  for (let n = 0; n < 100 && !pushed.some((p) => p.type === "ack"); n++) await Bun.sleep(10);
  assert.ok(pushed.some((p) => p.type === "ack"));
  const db = new Database(join(root, "db"));
  db.run(
    "INSERT INTO settings(key,value) VALUES('settings','{\"quotaPollIntervalMs\":0}') ON CONFLICT(key) DO UPDATE SET value=json_set(value,'$.quotaPollIntervalMs',0)",
  );
  for (const p of ["openai", "anthropic", "antigravity"]) {
    db.run(
      "INSERT INTO credentials(id,provider,label,auth_type,access_token,expires_at,provider_data,created_at,updated_at) VALUES(?,?,?,'oauth',?,1893456000000,?,1,1)",
      [
        p,
        p,
        p,
        await encrypt(key, "access"),
        JSON.stringify({ accountId: "workspace", projectId: "project" }),
      ],
    );
  }
  db.run(
    "INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('custom','custom','custom','apiKey',1,1)",
  );
  const results: unknown[] = [];
  for (const [label, path, body, auth] of [
    ["auth", "/api/credentials/quota/refresh", { kind: "all" }, false],
    ["all", "/api/credentials/quota/refresh", { kind: "all" }, true],
    ["list", "/api/credentials/openai/resets", undefined, true],
    ["redeem", "/api/credentials/openai/resets/redeem", { creditId: "credit" }, true],
    ["anthropic-list", "/api/credentials/anthropic/resets", undefined, true],
    ["anthropic-redeem", "/api/credentials/anthropic/resets/redeem", {}, true],
    ["refusal", "/api/credentials/custom/resets", undefined, true],
    ["missing", "/api/credentials/missing/resets", undefined, true],
  ] as const) {
    const r = await call(path, body, auth ? cookie : undefined);
    results.push({ label, status: r.status, body: r.body });
  }
  db.run("UPDATE credentials SET refresh_token=?,expires_at=1 WHERE id='anthropic'", [
    await encrypt(key, "refresh"),
  ]);
  const expired = await call(
    "/api/credentials/quota/refresh",
    { kind: "one", credentialId: "anthropic" },
    cookie,
  );
  results.push({
    label: "refresh-reuse",
    status: expired.status,
    body: expired.body,
    version: db.query("SELECT token_version FROM credentials WHERE id='anthropic'").get(),
  });
  for (const m of ["empty", "limited", "ok"]) {
    mode = m;
    const r = await call(
      "/api/credentials/quota/refresh",
      { kind: "one", credentialId: "openai" },
      cookie,
    );
    results.push({ label: m, status: r.status, body: r.body });
  }
  mode = "ok";
  const history = await call("/api/credentials/quota/history", undefined, cookie);
  for (
    let n = 0;
    n < 700 && !pushed.some((p) => p.type === "event" && p.topic === "res:quota");
    n++
  )
    await Bun.sleep(10);
  results.push({
    label: "invalidation",
    pushed: pushed.some((p) => p.type === "event" && p.topic === "res:quota"),
  });
  if (index === 0) assert.ok(pushed.some((p) => p.type === "event" && p.topic === "res:quota"));
  socket.close();
  if (index === 0) {
    assert.equal(history.status, 200);
    assert.equal(history.body.samples.length, 3);
    assert.equal(history.body.gatewayRates.length, 3);
    assert.equal(expired.body.outcomes[0].kind, "refreshed");
    assert.ok(requests.some((p) => p.includes("/oauth/token")));
  }
  results.push({
    label: "history",
    status: history.status,
    samples: history.body.samples?.length,
    rates: history.body.gatewayRates?.length,
    truncated: history.body.truncated,
  });
  results.push({
    label: "persist",
    windows: db
      .query(
        "SELECT credential_id,window_type,used,limit_value FROM quota_windows ORDER BY credential_id,window_type",
      )
      .all(),
    disabled: db.query("SELECT count(*) n FROM credentials WHERE enabled=0").get(),
  });
  child.kill("SIGTERM");
  await child.exited;
  db.run(
    "UPDATE settings SET value=json_set(value,'$.quotaPollIntervalMs',1000) WHERE key='settings'",
  );
  requests = [];
  child = launch();
  await wait();
  await Bun.sleep(1300);
  child.kill("SIGTERM");
  await child.exited;
  results.push({ label: "scheduler", probed: requests.length >= 3 });
  db.close();
  all.push(results);
}
server.stop(true);
failed = Number(!isDeepStrictEqual(all[0], all[1]));
writeFileSync(join(out!, "results.json"), JSON.stringify({ failed, all }, null, 2));
console.log({ failed });
process.exit(failed);
