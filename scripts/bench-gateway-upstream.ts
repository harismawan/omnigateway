#!/usr/bin/env bun
/**
 * The scripted upstream `bench-gateway.ts` points a `custom` credential at.
 *
 * A separate process on purpose: the gateway under test must be the only thing
 * in its own address space, so its RSS and CPU time are its own, and the same
 * upstream serves a gateway written in any language.
 *
 * Behaviour is read from the upstream model name, because that is the one
 * per-request value the gateway forwards untouched — no side channel, no
 * gateway-specific hook. `mock-c<chunks>-d<delayMs>` streams `<chunks>` content
 * deltas `<delayMs>` apart, then a usage chunk and `[DONE]`. Every reply is
 * chat-completions SSE, which is all the custom codec ever asks for.
 *
 *   bun scripts/bench-gateway-upstream.ts --port 18100
 *
 * Several copies may share a port (`reusePort`), which is how the harness keeps
 * the upstream from being the bottleneck it is measuring through.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { port: { type: "string" }, host: { type: "string", default: "127.0.0.1" } },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("--port must be a TCP port");
  process.exit(2);
}

const MODEL = /^mock-c(\d+)-d(\d+)$/;
const encoder = new TextEncoder();
const DONE = encoder.encode("data: [DONE]\n\n");

type Script = { chunks: number; delayMs: number; model: string };

function scriptOf(body: unknown): Script | null {
  if (body === null || typeof body !== "object") return null;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string") return null;
  const match = MODEL.exec(model);
  if (match === null) return null;
  return { chunks: Number(match[1]), delayMs: Number(match[2]), model };
}

function frame(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

function stream(script: Script): ReadableStream<Uint8Array> {
  const id = `chatcmpl-bench-${crypto.randomUUID()}`;
  const base = { id, object: "chat.completion.chunk", created: 0, model: script.model };
  // One delta frame, encoded once and replayed: the upstream's own per-chunk
  // cost must stay far below the gateway's, or the run measures this file.
  const delta = frame({ ...base, choices: [{ index: 0, delta: { content: "lorem ipsum " } }] });
  const first = frame({
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
  });
  const finish = frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  const usage = frame({
    ...base,
    choices: [],
    usage: {
      prompt_tokens: 64,
      completion_tokens: script.chunks * 2,
      total_tokens: 64 + script.chunks * 2,
    },
  });

  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      if (script.delayMs === 0) {
        // Instant replies go out as one write: what is being measured is the
        // gateway's decode/translate loop, not this process's scheduler.
        const parts: Uint8Array[] = [];
        for (let i = 0; i < script.chunks; i += 1) parts.push(delta);
        parts.push(finish, usage, DONE);
        controller.enqueue(Buffer.concat(parts));
        controller.close();
        return;
      }
      const tick = (): void => {
        if (sent < script.chunks) {
          controller.enqueue(delta);
          sent += 1;
          timer = setTimeout(tick, script.delayMs);
          return;
        }
        controller.enqueue(finish);
        controller.enqueue(usage);
        controller.enqueue(DONE);
        controller.close();
      };
      timer = setTimeout(tick, script.delayMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  });
}

Bun.serve({
  port,
  hostname: values.host,
  reusePort: true,
  idleTimeout: 255,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: { message: "bad json" } }, { status: 400 });
    }
    const script = scriptOf(body);
    if (script === null) {
      return Response.json(
        { error: { message: "model must be mock-c<chunks>-d<delayMs>" } },
        { status: 400 },
      );
    }
    return new Response(stream(script), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
