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
 * chat-completions SSE by default. `/v1/responses` serves Responses SSE;
 * both custom codecs always ask upstream for a stream. `--matrix` combines
 * instant chat frames into one write while preserving the legacy default.
 *
 *   bun scripts/bench-gateway-upstream.ts --port 18100
 *
 * Several copies may share a port (`reusePort`), which is how the harness keeps
 * the upstream from being the bottleneck it is measuring through.
 */
import { parseArgs } from "node:util";
import { faultResponse } from "./bench-fault";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    matrix: { type: "boolean", default: false },
  },
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
      if (!values.matrix || script.delayMs !== 0) controller.enqueue(first);
      if (script.delayMs === 0) {
        // Instant replies go out as one write: what is being measured is the
        // gateway's decode/translate loop, not this process's scheduler.
        const parts: Uint8Array[] = values.matrix ? [first] : [];
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

function responses(script: Script): Uint8Array {
  const id = "resp_bench";
  const item = {
    id: "msg_bench",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "lorem ipsum ".repeat(script.chunks), annotations: [] }],
  };
  const response = {
    id,
    object: "response",
    model: script.model,
    status: "completed",
    output: [item],
    usage: {
      input_tokens: 64,
      output_tokens: script.chunks * 2,
      total_tokens: 64 + script.chunks * 2,
    },
  };
  let sequence = 0;
  const event = (type: string, rest: object) =>
    encoder.encode(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...rest })}\n\n`,
    );
  const delta = {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: "lorem ipsum ",
  };
  const { usage: _usage, ...pending } = response;
  return Buffer.concat([
    event("response.created", { response: { ...pending, status: "in_progress", output: [] } }),
    event("response.in_progress", { response: { ...pending, status: "in_progress", output: [] } }),
    event("response.output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }),
    event("response.content_part.added", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    ...Array.from({ length: script.chunks }, () => event("response.output_text.delta", delta)),
    event("response.output_text.done", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: item.content[0]?.text,
    }),
    event("response.content_part.done", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    }),
    event("response.output_item.done", { output_index: 0, item }),
    event("response.completed", { response }),
  ]);
}

Bun.serve({
  port,
  hostname: values.host,
  reusePort: true,
  idleTimeout: 255,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    const fault = faultResponse();
    if (fault) return fault;
    if (process.env.OMNI_BENCH_FAULT === "500")
      return Response.json({ error: { message: "injected upstream 500" } }, { status: 500 });
    if (
      request.method !== "POST" ||
      !(path.endsWith("/chat/completions") || path.endsWith("/responses"))
    ) {
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
    return new Response(path.endsWith("/responses") ? responses(script) : stream(script), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
