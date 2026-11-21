#!/usr/bin/env bun
// Caller supplies netns, explicit environment/private HOME. No normalization:
// performance experiment only, not a semantic conformance test.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [base, final, work] = process.argv.slice(2);
if (!base || !final || !work) throw Error("base final private-work required");
mkdirSync(work, { recursive: true });
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 18796,
  async fetch(req) {
    const body = (await req.json()) as { messages?: { content: unknown }[]; stream?: boolean };
    if (body.messages?.[0]?.content === "large-sse") {
      const chunk = JSON.stringify({
        id: "burst",
        object: "chat.completion.chunk",
        model: "burst",
        choices: [{ index: 0, delta: { content: "x".repeat(8192) }, finish_reason: null }],
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 768; i++)
              controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`));
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"id":"burst","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1024}}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (body.stream)
      return new Response(
        'data: {"id":"burst","object":"chat.completion.chunk","model":"burst","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"burst","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    return Response.json({
      id: "burst",
      object: "chat.completion",
      model: "burst",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    });
  },
});
const rows: unknown[] = [];
async function run(binary: string, label: string, round: number, subscribed: boolean) {
  const root = `${work}/${round}-${label}-${subscribed}`;
  mkdirSync(root);
  const child = Bun.spawn([binary], {
    cwd: root,
    env: {
      ...process.env,
      OMNI_ROOT: root,
      OMNI_DB_PATH: `${root}/omni.db`,
      OMNI_ENCRYPTION_KEY: "stream-test-encryption-key-0123456789",
      OMNI_HOST: "127.0.0.1",
      OMNI_PORT: "18795",
      OMNI_LOG_LEVEL: "warn",
      OMNI_BODY_LOGGING_ALLOWED: "false",
    },
    stdout: Bun.file(`${root}/stdout`),
    stderr: Bun.file(`${root}/stderr`),
  });
  let ws: WebSocket | undefined;
  try {
    const url = "http://127.0.0.1:18795";
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(url + "/health")).ok) break;
      } catch {}
      await Bun.sleep(25);
    }
    let cookie = "";
    async function api(path: string, body: unknown, method = "POST") {
      const res = await fetch(url + path, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { id?: string; key?: string };
      if (!res.ok) throw Error(`${path}: ${res.status} ${JSON.stringify(data)}`);
      cookie = res.headers.get("set-cookie")?.split(";")[0] ?? cookie;
      return data;
    }
    await api("/api/setup", { password: "stream-test-password" });
    await api("/api/login", { password: "stream-test-password" });
    const key = await api("/api/keys", { label: "burst" });
    await api("/api/credentials", {
      provider: "custom",
      apiKey: "probe",
      endpointId: "burst",
      endpointLabel: "Burst",
      origin: "http://127.0.0.1:18796",
      protocol: "chat_completions",
    });
    await api(
      "/api/models/burst",
      {
        id: "burst",
        strategy: "priority",
        isAlias: false,
        targets: [
          {
            provider: "custom",
            endpointId: "burst",
            model: "burst",
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
    if (subscribed) {
      ws = new WebSocket("ws://127.0.0.1:18795/api/stream", { headers: { cookie } });
      let acks = 0;
      ws.onmessage = (e) => {
        if (JSON.parse(String(e.data)).type === "ack") acks++;
      };
      try {
        await new Promise<void>((yes, no) => {
          ws!.onopen = () => yes();
          ws!.onerror = no;
        });
      } catch (error) {
        // The pre-A9 baseline does not implement /api/stream. Do not silently
        // label an unsubscribed baseline run as a subscribed comparison.
        const response = await fetch(url + "/api/stream", { headers: { cookie } });
        await response.text();
        if (label !== "base" || response.status !== 404) throw error;
        const row = {
          round,
          label,
          subscribed,
          unavailable: "pre-A9 baseline /api/stream returns 404",
        };
        rows.push(row);
        console.log(JSON.stringify(row));
        writeFileSync(`${work}/rows.json`, JSON.stringify(rows, null, 2) + "\n");
        return;
      }
      for (const topic of ["res:usage", "res:logs"])
        ws.send(JSON.stringify({ type: "subscribe", topic }));
      for (let i = 0; acks < 2 && i < 100; i++) await Bun.sleep(10);
      if (acks !== 2) throw Error("missing acknowledgments");
    }
    async function inference(stream = false) {
      const res = await fetch(url + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "burst",
          stream,
          messages: [{ role: "user", content: stream ? "large-sse" : "burst" }],
          max_tokens: 2048,
        }),
      });
      const bytes = (await res.arrayBuffer()).byteLength;
      if (!res.ok) throw Error(`inference: ${res.status}`);
      return bytes;
    }
    await inference();
    let next = 0;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        while (next++ < 2000) await inference();
      }),
    );
    const ms = performance.now() - start;
    const sseStart = performance.now();
    const sseBytes = await inference(true);
    const sseMs = performance.now() - sseStart;
    if (sseBytes < 6 * 1024 * 1024) throw Error("short SSE");
    const hwmKiB = Number(
      readFileSync(`/proc/${child.pid}/status`, "utf8").match(/^VmHWM:\s+(\d+)/m)![1],
    );
    const row = {
      round,
      label,
      subscribed,
      requests: 2000,
      concurrency: 20,
      ms,
      rps: 2000000 / ms,
      sseMs,
      sseBytes,
      hwmKiB,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    writeFileSync(`${work}/rows.json`, JSON.stringify(rows, null, 2) + "\n");
  } finally {
    ws?.close();
    child.kill();
    await child.exited;
  }
}
try {
  for (let round = 0; round < 7; round++) {
    const variants = [
      [base, "base", false],
      [final, "final", false],
      [base, "base", true],
      [final, "final", true],
    ] as const;
    for (let i = 0; i < 4; i++) {
      const [binary, label, subscribed] = variants[(i + round) % 4]!;
      await run(binary, label, round, subscribed);
    }
  }
} finally {
  upstream.stop(true);
}
