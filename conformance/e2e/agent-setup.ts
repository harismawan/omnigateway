/** Compare the frozen TS and Rust reader contracts inside a loopback-only netns. */
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey, hashApiKey } from "../../packages/store/src/index.ts";

const [ts, rust, out] = process.argv.slice(2);
assert(ts && rust && out, "usage: agent-setup.ts <ts-binary> <rust-binary> <out-dir>");
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(resolve(out), "agent-setup-"));
const key = "conformance-agent-setup-encryption-key";
const raw = `sk-omni-${"a".repeat(43)}`;
const admin = "agent-setup-admin-password";
const viewer = "agent-setup-viewer-password";
const origin = "http://127.0.0.1:18494";
const base = "https://public.example/gateway/v1/V1";

const seed = join(work, "seed.db");
const store = await createStore({ path: seed, encryptionKey: await deriveKey(key) });
store.close();
{
  const db = new Database(seed);
  const argon2 = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;
  for (const [name, password] of [
    ["adminPasswordHash", admin],
    ["viewerPasswordHash", viewer],
  ] as const)
    db.run("INSERT INTO settings(key,value) VALUES (?,?)", [
      name,
      await Bun.password.hash(password, argon2),
    ]);
  db.run("INSERT INTO api_keys(id,label,prefix,hash,limits,created_at) VALUES (?,?,?,?,?,?)", [
    "reader-key",
    "Reader",
    raw.slice(0, 12),
    await hashApiKey(raw),
    "{}",
    1,
  ]);
  const target = {
    provider: "openai",
    model: "gpt-6-astra",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 0, output: 0 },
    capabilities: { tools: true, images: true, reasoning: true },
  };
  for (const [id, targets] of [
    ["opus", [target]],
    ["haiku", [{ ...target, contextWindow: 1000 }]],
  ]) {
    db.run("INSERT INTO virtual_models(id,targets) VALUES (?,?)", [
      String(id),
      JSON.stringify(targets),
    ]);
  }
  db.close();
}

const route = "/api/agent-setup";
const claude = `${route}?client=anything&defaultModel=opus&fableModel=opus&opusModel=opus`;
const opencode = `${route}?client=opencode&defaultModel=opus&sonnetModel=opus&haikuModel=haiku`;
const rows = [
  ["admin", claude, 200],
  ["viewer", opencode, 200],
  ["client", claude, 401],
  ["anon", route, 401],
  ["viewer", `${route}?client=opencode`, 400],
  ["admin", `${route}?defaultModel=opus&haikuModel=missing`, 400],
] as const;

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(origin + path, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) });
}

async function login(path: string, payload: object): Promise<string> {
  const response = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200, `${path} ${await response.text()}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, `${path} did not set a session cookie`);
  return cookie;
}

async function run(label: string, binary: string) {
  const root = join(work, label);
  mkdirSync(root);
  const db = join(root, "agent.db");
  copyFileSync(seed, db);
  const p = Bun.spawn([resolve(binary)], {
    cwd: root,
    env: {
      ...process.env,
      OMNI_ROOT: root,
      OMNI_DB_PATH: db,
      OMNI_ENCRYPTION_KEY: key,
      OMNI_HOST: "127.0.0.1",
      OMNI_PORT: "18494",
      OMNI_BASE_URL: base,
      OMNI_STATIC_DIR: join(root, "no-dashboard"),
    },
    stdout: Bun.file(join(root, "gateway.stdout")),
    stderr: Bun.file(join(root, "gateway.stderr")),
  });
  try {
    const deadline = Date.now() + 10_000;
    let healthy = false;
    while (Date.now() < deadline && p.exitCode === null) {
      const response = await request("/health").catch(() => null);
      if (response?.ok) {
        await response.text();
        healthy = true;
        break;
      }
      await Bun.sleep(50);
    }
    assert(healthy, `${label} did not become healthy; logs: ${root}`);
    const cookies = {
      admin: await login("/api/login", { password: admin }),
      viewer: await login("/api/login", { password: viewer, mode: "viewer" }),
      client: await login("/api/client/login", { key: raw }),
      anon: "",
    };
    const results = [];
    for (const [role, path] of rows) {
      const res = await request(path, { headers: { cookie: cookies[role] } });
      results.push({ status: res.status, body: await res.text() });
    }
    await Bun.write(join(root, "results.json"), JSON.stringify(results, null, 2));
    return results;
  } finally {
    if (p.exitCode === null) p.kill("SIGTERM");
    await p.exited;
  }
}

const reference = await run("ts", ts);
const actual = await run("rust", rust);
for (const [i, [role, path, status]] of rows.entries()) {
  const expected = reference[i];
  assert(expected);
  assert.equal(expected.status, status, `frozen ${role} ${path} (${work})`);
  assert.deepEqual(actual[i], expected, `Rust ${role} ${path} (${work})`);
}
for (const [i, client, path] of [
  [0, "claude", "settings.json"],
  [1, "opencode", "opencode.json"],
] as const) {
  const result = reference[i];
  assert(result);
  const snippet = JSON.parse(result.body);
  assert.equal(snippet.client, client);
  assert.deepEqual(
    snippet.files.map((file: { path: string }) => file.path),
    [path],
  );
  const contents = snippet.files[0].contents;
  assert(contents.includes("<your OmniGateway key>") && !contents.includes(raw));
  const file = JSON.parse(contents);
  if (client === "claude") {
    assert.equal(file.env.ANTHROPIC_BASE_URL, base);
    assert.equal(file.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "opus");
  } else {
    const provider = file.provider.omnigateway;
    assert.equal(provider.options.baseURL, "https://public.example/gateway/v1");
    assert.deepEqual(Object.keys(provider.models), ["opus", "haiku"]);
    assert.equal(provider.models.haiku.limit.context, 1000);
  }
}
for (const [i, mapping] of [
  [4, "defaultModel"],
  [5, "haikuModel"],
] as const) {
  assert(reference[i]?.body.includes("BAD_REQUEST"));
  assert(reference[i]?.body.includes(mapping));
}
console.log(`PASS ${rows.length} frozen agent-setup HTTP pairs (${work})`);
