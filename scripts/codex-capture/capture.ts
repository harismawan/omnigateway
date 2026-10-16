#!/usr/bin/env bun
/**
 * Raw-socket capture server for the real Codex client.
 *
 * Records every HTTP request byte for byte — header order and casing intact,
 * the body exactly as sent (zstd when Codex compresses it) — and answers just
 * enough for Codex to complete a turn: `/accounts/check` naming this server as
 * the workspace backend, and `/responses` with a minimal SSE stream. A raw
 * socket rather than an HTTP framework, because a framework normalises the very
 * header order and casing this exists to read.
 *
 * Never point a real credential at it: `mkauth.ts` writes a synthetic login,
 * and nothing here forwards anywhere. Procedure: `README.md`.
 *
 *   bun scripts/codex-capture/capture.ts <port> <out-dir>
 *
 * `CAPTURE_TLS=<dir>` serves HTTPS with `<dir>/srv.key` and `<dir>/srv.pem` —
 * Codex refuses a non-HTTPS workspace backend origin. `CAPTURE_TOOL=1` makes the
 * first `/responses` answer a reasoning item, a message and a tool call, so the
 * next request shows how Codex replays history.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";

const PORT = Number(process.argv[2] ?? 18765);
const OUT = process.argv[3];
if (OUT === undefined) {
  console.error("usage: capture.ts <port> <out-dir>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

/** The account the synthetic login names; see `mkauth.ts`. */
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const MODEL = process.env.CAPTURE_MODEL ?? "gpt-6-astra";

let captured = 0;
let responsesSeen = 0;

const event = (type: string, data: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 1,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 11,
};

/** A one-message answer: enough for Codex to finish the turn. */
function textStream(): string {
  const response = { id: "resp_cap", object: "response", status: "in_progress", model: MODEL };
  const item = {
    id: "msg_cap",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hi", annotations: [] }],
  };
  return (
    event("response.created", { sequence_number: 0, response: { ...response, output: [] } }) +
    event("response.output_item.added", {
      sequence_number: 1,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }) +
    event("response.output_text.delta", {
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      delta: "hi",
    }) +
    event("response.output_item.done", { sequence_number: 3, output_index: 0, item }) +
    event("response.completed", {
      sequence_number: 4,
      response: { ...response, status: "completed", output: [item], usage: USAGE },
    })
  );
}

/**
 * A reasoning item, a short text, then a call to Codex's harmless built-in
 * `clock.sleep`, so the follow-up request replays all three plus the output.
 */
function toolStream(): string {
  const response = { id: "resp_tool", object: "response", status: "in_progress", model: MODEL };
  const items = [
    { id: "rs_cap1", type: "reasoning", summary: [], encrypted_content: "opaque-capture-blob" },
    {
      id: "msg_cap1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Waiting briefly.", annotations: [] }],
    },
    {
      id: "fc_cap1",
      type: "function_call",
      status: "completed",
      name: "sleep",
      namespace: "clock",
      call_id: "call_cap1",
      arguments: '{"duration_ms":1}',
    },
  ];
  let out = event("response.created", {
    sequence_number: 0,
    response: { ...response, output: [] },
  });
  items.forEach((item, i) => {
    out += event("response.output_item.added", {
      sequence_number: 1 + i * 2,
      output_index: i,
      item,
    });
    out += event("response.output_item.done", {
      sequence_number: 2 + i * 2,
      output_index: i,
      item,
    });
  });
  return (
    out +
    event("response.completed", {
      sequence_number: 10,
      response: { ...response, status: "completed", output: items, usage: USAGE },
    })
  );
}

function reply(socket: Socket, status: string, type: string, body: string): void {
  socket.write(
    `HTTP/1.1 ${status}\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/** One request's body, or `undefined` while it has not fully arrived. */
function readBody(
  buffer: Buffer,
  headEnd: number,
  headers: string[],
): { body: Buffer; end: number } | undefined {
  const chunked = headers.some((l) => l.startsWith("transfer-encoding:") && l.includes("chunked"));
  if (!chunked) {
    const length = Number(headers.find((l) => l.startsWith("content-length:"))?.split(":")[1] ?? 0);
    if (buffer.length < headEnd + 4 + length) return undefined;
    return { body: buffer.subarray(headEnd + 4, headEnd + 4 + length), end: headEnd + 4 + length };
  }
  const parts: Buffer[] = [];
  let at = headEnd + 4;
  while (true) {
    const lineEnd = buffer.indexOf("\r\n", at);
    if (lineEnd < 0) return undefined;
    const size = Number.parseInt(buffer.subarray(at, lineEnd).toString("latin1"), 16);
    if (buffer.length < lineEnd + 2 + size + 2) return undefined;
    if (size === 0) return { body: Buffer.concat(parts), end: lineEnd + 4 };
    parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
}

function handle(socket: Socket): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = buffer.subarray(0, headEnd).toString("latin1");
      const lines = head.split("\r\n");
      const [method, path] = (lines[0] ?? "").split(" ");
      const lower = lines.slice(1).map((l) => l.toLowerCase());
      const read = readBody(buffer, headEnd, lower);
      if (read === undefined) return;
      buffer = buffer.subarray(read.end);

      const k = String(++captured).padStart(3, "0");
      writeFileSync(`${OUT}/${k}.head.txt`, head);
      writeFileSync(`${OUT}/${k}.body.bin`, read.body);
      appendFileSync(`${OUT}/index.txt`, `${k} ${method} ${path} body=${read.body.length}\n`);

      // Codex tries a WebSocket first; refusing it makes it fall back to HTTPS.
      if (lower.some((l) => l.startsWith("upgrade:"))) {
        socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
      }
      if (method === "POST" && path?.includes("/responses")) {
        responsesSeen++;
        const tool = process.env.CAPTURE_TOOL !== undefined && responsesSeen === 1;
        reply(socket, "200 OK", "text/event-stream", tool ? toolStream() : textStream());
      } else if (path?.includes("/accounts/check")) {
        reply(
          socket,
          "200 OK",
          "application/json",
          JSON.stringify({
            accounts: [
              {
                id: ACCOUNT_ID,
                plan_type: "pro",
                workspace_backend_origin: `https://localhost:${PORT}`,
                account_routing_override: "NO_CONSTRAINT",
                structure: "personal",
              },
            ],
            account_ordering: [ACCOUNT_ID],
            default_account_id: ACCOUNT_ID,
          }),
        );
      } else {
        reply(socket, "404 Not Found", "application/json", "{}");
      }
    }
  });
  socket.on("error", () => {});
}

const tls = process.env.CAPTURE_TLS;
if (tls !== undefined) {
  createTlsServer(
    { key: readFileSync(`${tls}/srv.key`), cert: readFileSync(`${tls}/srv.pem`) },
    handle,
  ).listen(PORT, "127.0.0.1", () => console.log(`capture (tls) listening on ${PORT}`));
} else {
  createServer(handle).listen(PORT, "127.0.0.1", () => console.log(`capture listening on ${PORT}`));
}
