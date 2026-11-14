#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
/** TLS-only fixture. The namespace wrapper maps the real provider origins here. */
import { parseArgs } from "node:util";
import { faultResponse } from "./bench-fault";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "443" },
    cert: { type: "string" },
    key: { type: "string" },
  },
});
if (!values.cert || !values.key) throw Error("--cert and --key required");
const encoder = new TextEncoder();
const frame = (type: string, data: object) =>
  encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(values.port),
  reusePort: true,
  tls: { cert: Bun.file(values.cert), key: Bun.file(values.key) },
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return new Response("ok");
    const fault = faultResponse();
    if (fault) return fault;
    if (process.env.OMNI_BENCH_FAULT === "500")
      return Response.json({ error: { message: "injected upstream 500" } }, { status: 500 });
    if (path === "/api/oauth/usage")
      return Response.json({
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
      });
    if (path === "/v1/oauth/token") {
      if (process.env.OMNI_BENCH_REFRESH_LOG)
        appendFileSync(process.env.OMNI_BENCH_REFRESH_LOG, "refresh\n");
      return Response.json({
        access_token: "bench-access",
        refresh_token: "bench-refresh",
        expires_in: 86400,
      });
    }
    if (path !== "/v1/messages" || req.method !== "POST")
      return Response.json({ error: { type: "not_found", message: path } }, { status: 404 });
    const body = (await req.json()) as { model?: string; stream?: boolean };
    const match = /^mock-c(\d+)-d0$/.exec(body.model ?? "");
    if (!match || body.stream !== true)
      return Response.json(
        { error: { message: "expected mock-c<chunks>-d0 and stream:true" } },
        { status: 400 },
      );
    const chunks = Number(match[1]);
    const delta = frame("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "lorem ipsum " },
    });
    return new Response(
      Buffer.concat([
        frame("message_start", {
          message: {
            id: "msg_bench",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 64, output_tokens: 0 },
          },
        }),
        frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        ...Array.from({ length: chunks }, () => delta),
        frame("content_block_stop", { index: 0 }),
        frame("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: chunks * 2 },
        }),
        frame("message_stop", {}),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
