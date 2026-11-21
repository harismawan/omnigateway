#!/usr/bin/env bun
import { Database } from "bun:sqlite";
// Isolated namespace only. Admin, writer-commit and OAuth tick publishers.
// No normalization: resource frames contain no generated IDs or timestamps.
import { mkdirSync, writeFileSync } from "node:fs";
import { deriveKey, encrypt } from "../../packages/store/src/encryption.ts";

const [ts, rust, work] = process.argv.slice(2);
if (!ts || !rust || !work) throw Error("frozen rust work required");
mkdirSync(work, { recursive: true });
const children: ReturnType<typeof Bun.spawn>[] = [];
const sockets: WebSocket[] = [];
type Frame = { type: string; topic?: string };
async function run(binary: string, port: number, name: string) {
  const root = `${work}/${name}`;
  mkdirSync(root, { recursive: true });
  const child = Bun.spawn([binary], {
    cwd: root,
    env: {
      ...process.env,
      OMNI_ROOT: root,
      OMNI_DB_PATH: `${root}/omni.db`,
      OMNI_ENCRYPTION_KEY: "stream-test-encryption-key-0123456789",
      OMNI_HOST: "127.0.0.1",
      OMNI_PORT: String(port),
      OMNI_LOG_LEVEL: "warn",
    },
    stdout: Bun.file(`${root}/stdout`),
    stderr: Bun.file(`${root}/stderr`),
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await Bun.sleep(25);
  }
  let cookie = "";
  const api = async (path: string, body: unknown, method = "POST") => {
    const res = await fetch(base + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw Error(`${name} ${method} ${path}: ${res.status} ${text}`);
    return { data: JSON.parse(text), cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  await api("/api/setup", { password: "stream-test-password" });
  cookie = (await api("/api/login", { password: "stream-test-password" })).cookie;
  await api("/api/settings/viewer-password", { password: "stream-viewer-password" }, "PUT");
  const viewer = (await api("/api/login", { password: "stream-viewer-password", mode: "viewer" }))
    .cookie;
  const key = (await api("/api/keys", { label: "stream-session" })).data;
  const client = (await api("/api/client/login", { key: key.key })).cookie;
  // Let setup invalidations leave the coalescer before opening subscribers.
  await Bun.sleep(1100);
  const frames: Record<string, { at: number; frame: Frame }[]> = {};
  const topics = ["res:credentials", "res:models", "res:keys", "res:settings"];
  for (const [role, token] of [
    ["admin", cookie],
    ["viewer", viewer],
    ["client", client],
  ]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, { headers: { cookie: token } });
    sockets.push(ws);
    frames[role] = [];
    ws.onmessage = (e) =>
      frames[role].push({ at: performance.now(), frame: JSON.parse(String(e.data)) });
    await new Promise<void>((yes, no) => {
      ws.onopen = () => yes();
      ws.onerror = no;
    });
    for (const topic of topics) ws.send(JSON.stringify({ type: "subscribe", topic }));
    for (let i = 0; frames[role].length < 4 && i < 100; i++) await Bun.sleep(10);
    if (frames[role].length !== 4) throw Error(`${name} ${role} missing acknowledgments`);
    for (const item of frames[role])
      if (item.frame.type !== (role === "client" ? "error" : "ack")) throw Error("grant mismatch");
    frames[role] = [];
  }
  return { api, frames, key, base, root, cookie };
}
try {
  const a = await run(ts, 18781, "ts"),
    b = await run(rust, 18782, "rust");
  const transcript: unknown[] = [];
  // Only topic frames are compared: they contain no generated fields.
  // Inference response IDs/timestamps are not compared or normalized.
  const inference = async (x: typeof a) => {
    const ws = new WebSocket(x.base.replace("http", "ws") + "/api/stream", {
      headers: { cookie: x.cookie },
    });
    sockets.push(ws);
    const got: Frame[] = [];
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    await new Promise<void>((yes, no) => {
      ws.onopen = () => yes();
      ws.onerror = no;
    });
    for (const topic of ["res:logs", "res:usage"])
      ws.send(JSON.stringify({ type: "subscribe", topic }));
    while (got.length < 2) await Bun.sleep(10);
    await x.api("/api/credentials", {
      provider: "custom",
      apiKey: "probe",
      endpointId: "writer",
      endpointLabel: "Writer",
      origin: "http://127.0.0.1:18789",
      protocol: "chat_completions",
    });
    await x.api(
      "/api/models/writer",
      {
        id: "writer",
        strategy: "priority",
        isAlias: false,
        targets: [
          {
            provider: "custom",
            endpointId: "writer",
            model: "writer",
            tier: 1,
            weight: 1,
            costPerMTok: { input: 1, output: 2 },
            capabilities: { tools: true, images: false, reasoning: false },
          },
        ],
      },
      "PUT",
    );
    const results: { mode: string; events: Frame[] }[] = [];
    for (const mode of ["buffered", "stream", "error", "failover", "append-failure"]) {
      await Bun.sleep(1250);
      got.length = 0;
      if (mode === "failover") {
        await x.api("/api/credentials", {
          provider: "custom",
          apiKey: "probe-second",
          endpointId: "writer2",
          endpointLabel: "Writer2",
          origin: "http://127.0.0.1:18789",
          protocol: "chat_completions",
        });
        await x.api(
          "/api/models/writer",
          {
            id: "writer",
            strategy: "priority",
            isAlias: false,
            targets: ["fail-first", "writer"].map((model, index) => ({
              provider: "custom",
              endpointId: index ? "writer2" : "writer",
              model,
              tier: index + 1,
              weight: 1,
              costPerMTok: { input: 1, output: 2 },
              capabilities: { tools: true, images: false, reasoning: false },
            })),
          },
          "PUT",
        );
      }
      if (mode === "append-failure") {
        await x.api(
          "/api/models/writer",
          {
            id: "writer",
            strategy: "priority",
            isAlias: false,
            targets: [
              {
                provider: "custom",
                endpointId: "writer2",
                model: "writer",
                tier: 1,
                weight: 1,
                costPerMTok: { input: 1, output: 2 },
                capabilities: { tools: true, images: false, reasoning: false },
              },
            ],
          },
          "PUT",
        );
        await Bun.sleep(1500);
        const db = new Database(`${x.root}/omni.db`);
        db.run(
          "CREATE TRIGGER refuse BEFORE INSERT ON request_logs BEGIN SELECT RAISE(FAIL, 'probe'); END",
        );
        db.close();
      }
      if (mode === "failover") await Bun.sleep(1500); // routing snapshot reload
      const res = await fetch(x.base + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${x.key.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "writer",
          stream: mode === "stream",
          messages: [{ role: "user", content: mode }],
          max_tokens: 16,
        }),
      });
      await res.text();
      await Bun.sleep(1450);
      const events = got.filter((v) => v.type === "event");
      const expected =
        mode === "append-failure"
          ? []
          : mode === "failover"
            ? ["res:logs", "res:logs", "res:usage", "res:logs"]
            : ["res:logs", "res:usage", "res:logs"];
      if (JSON.stringify(events.map((v) => v.topic)) !== JSON.stringify(expected))
        throw Error(`${x.root} ${mode}: ${JSON.stringify(events)}`);
      results.push({ mode, events });
    }
    return results;
  };
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 18789,
    async fetch(req) {
      const body = (await req.json()) as {
        model: string;
        messages?: { content: unknown }[];
        stream?: boolean;
      };
      await Bun.sleep(1300);
      if (body.model === "fail-first")
        return Response.json({ error: { message: "failover" } }, { status: 503 });
      if (body.messages?.[0]?.content === "error")
        return Response.json({ error: { message: "probe" } }, { status: 400 });
      if (body.stream)
        return new Response(
          'data: {"id":"fixed","object":"chat.completion.chunk","model":"writer","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixed","object":"chat.completion.chunk","model":"writer","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      return Response.json({
        id: "fixed",
        object: "chat.completion",
        model: "writer",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });
  try {
    if (!process.env.S9_TICK_ONLY)
      transcript.push({ inference: await Promise.all([inference(a), inference(b)]) });
  } finally {
    upstream.stop(true);
  }
  // The frozen transport closes even compliant clients after ~60 seconds.
  // Give the subsequent admin corpus fresh sockets after the inference probes.
  for (const ws of sockets) ws.close();
  for (const x of [a, b]) {
    for (const [role, token] of [
      ["admin", x.cookie],
      [
        "viewer",
        (await x.api("/api/login", { password: "stream-viewer-password", mode: "viewer" })).cookie,
      ],
    ]) {
      const ws = new WebSocket(x.base.replace("http", "ws") + "/api/stream", {
        headers: { cookie: token },
      });
      sockets.push(ws);
      ws.onmessage = (e) =>
        x.frames[role].push({ at: performance.now(), frame: JSON.parse(String(e.data)) });
      await new Promise<void>((yes, no) => {
        ws.onopen = () => yes();
        ws.onerror = no;
      });
      for (const topic of ["res:credentials", "res:models", "res:keys", "res:settings"])
        ws.send(JSON.stringify({ type: "subscribe", topic }));
    }
    await Bun.sleep(100);
  }
  // Namespace binds auth.openai.com to this TLS loopback endpoint. No provider
  // payload or database fields are normalized; only exact resource frames.
  async function tickProbes() {
    if (!process.env.S9_CERT || !process.env.S9_KEY)
      throw Error("S9_CERT/S9_KEY required for tick probes");
    let tokenMode = "success";
    const tokenServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 443,
      tls: { cert: Bun.file(process.env.S9_CERT), key: Bun.file(process.env.S9_KEY) },
      fetch() {
        return tokenMode === "success"
          ? Response.json({
              access_token: "new-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
              token_type: "Bearer",
            })
          : Response.json(
              { error: tokenMode === "auth" ? "invalid_grant" : "temporarily_unavailable" },
              { status: tokenMode === "auth" ? 401 : 503 },
            );
      },
    });
    try {
      const encryption = await deriveKey("stream-test-encryption-key-0123456789");
      for (const mode of ["success", "auth", "transient", "expired"]) {
        tokenMode = mode;
        const tickFrames = new Map<typeof a, Frame[]>();
        for (const x of [a, b]) {
          const ws = new WebSocket(x.base.replace("http", "ws") + "/api/stream", {
            headers: { cookie: x.cookie },
          });
          sockets.push(ws);
          const events: Frame[] = [];
          tickFrames.set(x, events);
          ws.onmessage = (e) => {
            const frame = JSON.parse(String(e.data));
            if (frame.type === "event") events.push(frame);
          };
          await new Promise<void>((yes, no) => {
            ws.onopen = () => yes();
            ws.onerror = no;
          });
          ws.send(JSON.stringify({ type: "subscribe", topic: "res:credentials" }));
          await Bun.sleep(50);
          const db = new Database(`${x.root}/omni.db`);
          db.run("DELETE FROM credentials WHERE id LIKE 'tick-%'");
          db.run(
            "INSERT INTO credentials (id,provider,label,auth_type,enabled,tier,weight,expires_at,provider_data,access_token,refresh_token,created_at,updated_at,token_version) VALUES (?,'openai','tick','oauth',1,1,1,1,'{}',?,?,1,1,0)",
            [
              `tick-${mode}`,
              await encrypt(encryption, "old-access"),
              mode === "expired" ? null : await encrypt(encryption, "old-refresh"),
            ],
          );
          db.close();
          for (const role in x.frames) x.frames[role] = [];
        }
        // Observe a real scheduler tick, not an inference-triggered refresh.
        await Bun.sleep(62000);
        for (const x of [a, b]) {
          const events = tickFrames.get(x)!;
          const expected =
            mode === "transient" ? [] : [{ type: "event", topic: "res:credentials" }];
          if (JSON.stringify(events) !== JSON.stringify(expected))
            throw Error(`${x.root} tick ${mode}: ${JSON.stringify(events)}`);
          transcript.push({ tick: mode, events });
        }
      }
    } finally {
      tokenServer.stop(true);
    }
  }
  const check = async (
    name: string,
    topic: string,
    mutate: (x: typeof a) => Promise<unknown>,
    floor: number,
  ) => {
    for (const x of [a, b]) for (const role in x.frames) x.frames[role] = [];
    await Promise.all([mutate(a), mutate(b)]);
    await Bun.sleep(150);
    for (const x of [a, b]) {
      for (const role of ["admin", "viewer", "client"]) {
        const got = x.frames[role].map((v) => v.frame);
        const expected = role === "client" ? [] : [{ type: "event", topic }];
        if (JSON.stringify(got) !== JSON.stringify(expected))
          throw Error(`${name} ${x === a ? "ts" : "rust"} ${role}: ${JSON.stringify(got)}`);
      }
    }
    transcript.push({ name, topic, frames: a.frames.admin.map((v) => v.frame) });
    await Bun.sleep(floor + 30);
  };
  if (!process.env.S9_TICK_ONLY) {
    const ids = new Map<typeof a, string>();
    await check(
      "credential create",
      "res:credentials",
      async (x) => {
        const r = await x.api("/api/credentials", {
          provider: "custom",
          apiKey: "test-secret",
          endpointId: "stream",
          endpointLabel: "Stream",
          origin: "http://127.0.0.1:18789",
          protocol: "chat_completions",
        });
        ids.set(x, r.data.credential.id);
      },
      5000,
    );
    await check(
      "credential patch",
      "res:credentials",
      (x) => x.api(`/api/credentials/${ids.get(x)}`, { enabled: false }, "PATCH"),
      5000,
    );
    await check(
      "credential delete",
      "res:credentials",
      (x) => x.api(`/api/credentials/${ids.get(x)}`, {}, "DELETE"),
      5000,
    );
    await check(
      "model put",
      "res:models",
      (x) =>
        x.api(
          "/api/models/stream",
          {
            id: "stream",
            strategy: "score",
            isAlias: false,
            targets: [
              {
                provider: "anthropic",
                model: "claude-x",
                tier: 1,
                weight: 1,
                costPerMTok: { input: 1, output: 2 },
                capabilities: { tools: true, images: false, reasoning: true },
              },
            ],
          },
          "PUT",
        ),
      1000,
    );
    await check(
      "model delete",
      "res:models",
      (x) => x.api("/api/models/stream", {}, "DELETE"),
      1000,
    );
    await check(
      "key create",
      "res:keys",
      async (x) => {
        x.key = (await x.api("/api/keys", { label: "mutation" })).data;
      },
      1000,
    );
    for (const [edit, body] of [
      ["limits", { limits: {} }],
      ["models", { modelAllowlist: null }],
      ["expiry", { expiresAt: null }],
      ["guardrail", { policy: null }],
      ["smart-routing", { enabled: false }],
    ] as const) {
      await check(
        `key ${edit}`,
        "res:keys",
        (x) => x.api(`/api/keys/${x.key.id}/${edit}`, body, "PUT"),
        1000,
      );
    }
    await check(
      "key delete",
      "res:keys",
      (x) => x.api(`/api/keys/${x.key.id}`, {}, "DELETE"),
      1000,
    );
    // Removing viewers would close their session on the next heartbeat; keep it last.
    await check(
      "settings put",
      "res:settings",
      (x) =>
        x.api(
          "/api/settings",
          {
            weights: { tier: 1, health: 2, quota: 3, cost: 4, latency: 5, load: 6 },
            maxAttempts: 3,
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
          },
          "PUT",
        ),
      1000,
    );
    for (const x of [a, b]) for (const role in x.frames) x.frames[role] = [];
    // Two quick writes: leading immediately, exactly one trailing at the floor.
    await Promise.all(
      [a, b].map(async (x) => {
        await x.api("/api/keys", { label: "coalesce-leading" });
        await x.api("/api/keys", { label: "coalesce-trailing" });
      }),
    );
    await Bun.sleep(1250);
    for (const x of [a, b]) {
      for (const role of ["admin", "viewer"]) {
        const got = x.frames[role];
        if (
          got.length !== 2 ||
          got.some(
            (v) => JSON.stringify(v.frame) !== JSON.stringify({ type: "event", topic: "res:keys" }),
          )
        )
          throw Error("coalescing frames");
        const delta = got[1].at - got[0].at;
        if (delta < 900 || delta > 1200) throw Error(`coalescing timing ${delta}`);
      }
      if (x.frames.client.length) throw Error("client received keys");
    }
    transcript.push({
      name: "keys leading/trailing",
      tsMs: a.frames.admin[1].at - a.frames.admin[0].at,
      rustMs: b.frames.admin[1].at - b.frames.admin[0].at,
    });
    await check(
      "viewer password",
      "res:settings",
      (x) =>
        x.api("/api/settings/viewer-password", { password: "stream-viewer-new-password" }, "PUT"),
      1000,
    );
  }
  await tickProbes();
  writeFileSync(`${work}/frames.json`, JSON.stringify(transcript, null, 2));
  console.log(
    process.env.S9_TICK_ONLY
      ? "4 paired OAuth tick cases"
      : "14 paired admin publishers; 5 inference and 4 OAuth tick cases; no generated-field normalization",
  );
} finally {
  for (const ws of sockets) ws.close();
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((p) => p.exited));
}
