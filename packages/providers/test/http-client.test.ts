import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { createLogger } from "@omni/ir";
import { CONNECT_ATTEMPT_TIMEOUT_MS, nodeHttpClient } from "../src/http-client.ts";

/** Captures the literal request head, byte for byte, off the socket. */
function rawServer(): {
  url: string;
  head: () => Promise<string>;
  stop: () => void;
} {
  let resolveHead: (v: string) => void;
  const headPromise = new Promise<string>((r) => {
    resolveHead = r;
  });
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        resolveHead(new TextDecoder().decode(data));
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
            "Content-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        socket.end();
      },
      open() {},
      close() {},
      error() {},
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1/messages`,
    head: () => headPromise,
    stop: () => server.stop(true),
  };
}

test("writes headers in the given order with the given casing", async () => {
  const s = rawServer();
  const http = nodeHttpClient();
  const res = await http({
    provider: "anthropic",
    url: s.url,
    method: "POST",
    headers: [
      ["User-Agent", "claude-cli/2.1.296 (external, cli)"],
      ["x-app", "cli"],
      ["X-Stainless-Lang", "js"],
      ["anthropic-version", "2023-06-01"],
    ],
    body: '{"a":1}',
    signal: AbortSignal.timeout(5000),
  });
  expect(res.status).toBe(200);
  const head = await s.head();
  const names = head
    .split("\r\n")
    .slice(1)
    .filter((l) => l.includes(":"))
    .map((l) => l.slice(0, l.indexOf(":")));
  // Exact casing survives.
  expect(names).toContain("User-Agent");
  expect(names).toContain("x-app");
  expect(names).toContain("X-Stainless-Lang");
  expect(names).toContain("anthropic-version");
  // Relative order survives. Alphabetical sorting would put
  // anthropic-version first; insertion order puts it last.
  const at = (n: string) => names.indexOf(n);
  expect(at("User-Agent")).toBeLessThan(at("x-app"));
  expect(at("x-app")).toBeLessThan(at("X-Stainless-Lang"));
  expect(at("X-Stainless-Lang")).toBeLessThan(at("anthropic-version"));
  s.stop();
});

test("sends the body verbatim", async () => {
  const s = rawServer();
  const http = nodeHttpClient();
  // Field order here is deliberately not alphabetical.
  const body = '{"model":"m","messages":[],"system":"s"}';
  await http({
    provider: "anthropic",
    url: s.url,
    method: "POST",
    headers: [["Content-Type", "application/json"]],
    body,
    signal: AbortSignal.timeout(5000),
  });
  const head = await s.head();
  expect(head.endsWith(body)).toBe(true);
  s.stop();
});

test("reports response-head timing without changing outbound headers", async () => {
  const s = rawServer();
  const heads: unknown[] = [];
  let time = 1_000;
  const http = nodeHttpClient({
    now: () => time,
    onResponseHead: (head) => heads.push(head),
  });
  time = 1_025;
  await http({
    provider: "anthropic",
    requestId: "req_1",
    url: s.url,
    method: "POST",
    headers: [["X-Only", "one"]],
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  });

  expect(heads).toEqual([
    {
      provider: "anthropic",
      requestId: "req_1",
      host: expect.any(String),
      path: "/v1/messages",
      status: 200,
      durationMs: 0,
    },
  ]);
  const head = await s.head();
  expect(head).not.toContain("traceparent");
  expect(head).not.toContain("req_1");
  s.stop();
});

test("logs safe upstream metadata without query or body", async () => {
  const s = rawServer();
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
  const http = nodeHttpClient({ logger, now: () => 1_000 });
  const querySentinel = "QUERY_SECRET_SENTINEL";
  const bodySentinel = "BODY_SECRET_SENTINEL";

  await http({
    provider: "anthropic",
    url: `${s.url}?key=${querySentinel}`,
    method: "POST",
    headers: [["Authorization", "Bearer HEADER_SECRET_SENTINEL"]],
    body: bodySentinel,
    signal: AbortSignal.timeout(5000),
  });

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("DEBUG upstream http");
  expect(lines[0]).toContain("provider=anthropic");
  expect(lines[0]).toContain("status=200");
  expect(lines[0]).toContain("path=/v1/messages");
  const output = lines.join("\n");
  expect(output).not.toContain(querySentinel);
  expect(output).not.toContain(bodySentinel);
  expect(output).not.toContain("HEADER_SECRET_SENTINEL");
  s.stop();
});

test("rejects an already-aborted request without an uncaught error", async () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
  const http = nodeHttpClient({ logger });
  const ac = new AbortController();
  ac.abort();

  await expect(
    http({
      provider: "anthropic",
      url: "http://127.0.0.1:1/",
      method: "POST",
      headers: [],
      body: "{}",
      signal: ac.signal,
    }),
  ).rejects.toThrow("aborted");

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("provider=anthropic");
  expect(lines[0]).toContain('reason="transport error"');
});

test("aborts an in-flight request", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
  const http = nodeHttpClient({ logger });
  const ac = new AbortController();
  const pending = http({
    provider: "anthropic",
    url: `http://127.0.0.1:${server.port}/`,
    method: "POST",
    headers: [],
    body: "{}",
    signal: ac.signal,
  });
  ac.abort();
  await expect(pending).rejects.toThrow();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("provider=anthropic");
  expect(lines[0]).toContain('reason="transport error"');
  server.stop(true);
});

/**
 * Measured, not chosen: connecting to `api.anthropic.com` from a host with no
 * IPv6 route failed 3 times in 99 attempts at the 500ms default, always as an
 * `AggregateError` of `ETIMEDOUT` on the A record and `ECONNREFUSED` on the
 * AAAA. Raising the timeout gave 212 successes in 212 attempts, and the connects
 * that had been failing completed at 1007–1061ms — the discrete signature of a
 * lost SYN recovering on Linux's one-second initial RTO, not gradual latency.
 *
 * So the invariant is the RTO, and that is what this guards: an attempt budget
 * under one second abandons the connection before TCP can retransmit, turning a
 * routine dropped packet into a failed request. Happy Eyeballs is left on; only
 * the deadline it gives each family moves.
 */
test("gives a connect attempt longer than one TCP retransmit before abandoning it", () => {
  const LINUX_INITIAL_RTO_MS = 1000;
  expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(LINUX_INITIAL_RTO_MS);
});

/** Collects the whole request — head and every body byte — off the socket. */
function wholeRequestServer(): {
  url: string;
  request: () => Promise<{ head: string; body: Buffer }>;
  stop: () => void;
} {
  let resolveRequest: (v: { head: string; body: Buffer }) => void;
  const done = new Promise<{ head: string; body: Buffer }>((r) => {
    resolveRequest = r;
  });
  let received = Buffer.alloc(0);
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        received = Buffer.concat([received, Buffer.from(data)]);
        const end = received.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = received.subarray(0, end).toString("latin1");
        const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? "0");
        const body = received.subarray(end + 4);
        if (body.byteLength < length) return;
        resolveRequest({ head, body });
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
            "Content-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        socket.end();
      },
      open() {},
      close() {},
      error() {},
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/backend-api/codex/responses`,
    request: () => done,
    stop: () => server.stop(true),
  };
}

const contentLength = (head: string): number =>
  Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1]);

test("a zstd-marked request goes out compressed, counted in compressed bytes", async () => {
  // The codec hands the transport JSON and a marker; compression happens here,
  // below body capture, so the artifact stays readable JSON while the wire
  // carries what Codex sends. `content-length` must count the compressed bytes:
  // the JSON's own length would have the server wait for bytes never sent.
  const s = wholeRequestServer();
  const http = nodeHttpClient();
  const body = JSON.stringify({ model: "m", input: "x".repeat(5000), stream: true });
  await http({
    provider: "openai",
    url: s.url,
    method: "POST",
    headers: [
      ["content-encoding", "zstd"],
      ["content-type", "application/json"],
    ],
    body,
    bodyEncoding: "zstd",
    signal: AbortSignal.timeout(5000),
  });
  const { head, body: sent } = await s.request();
  expect(contentLength(head)).toBe(sent.byteLength);
  expect(sent.byteLength).toBeLessThan(Buffer.byteLength(body));
  expect(Buffer.from(zstdDecompressSync(sent)).toString("utf8")).toBe(body);
  // The transport adds no header of its own; the codec placed this one.
  expect(head.match(/content-encoding/gi)).toHaveLength(1);
  s.stop();
});

/**
 * A deterministic, varied body: varied enough that zstd levels 3 and 4 produce
 * different bytes, which a repetitive body does not.
 */
function syntheticBody(): string {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const more = ["golf", "hotel", "india", "juliet", "kilo", "lima"];
  const all = [...words, ...more];
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  return JSON.stringify({
    model: "gpt-6-astra",
    input: Array.from({ length: 400 }, (_, i) => ({
      type: "message",
      role: i % 2 ? "assistant" : "user",
      text: Array.from({ length: 12 }, () => `${all[next() % all.length]}${next() % 97}`).join(" "),
    })),
  });
}

test("the zstd frame is the one Codex writes: streamed, no content size, 2 MiB window, level 3", async () => {
  // Codex compresses with `zstd::stream::encode_all(…, 3)`, which never pledges a
  // size: no frame content size, not single-segment, and the level's own 2^21
  // window. A one-shot compress knows the size and writes a different header.
  // Recompressing four real Codex 0.163.0 bodies this way reproduced them byte
  // for byte (spec History); those captures carry machine-specific data, so the
  // pin here is the header plus a golden over a synthetic body.
  const s = wholeRequestServer();
  const http = nodeHttpClient();
  const body = syntheticBody();
  await http({
    provider: "openai",
    url: s.url,
    method: "POST",
    headers: [["content-encoding", "zstd"]],
    body,
    bodyEncoding: "zstd",
    signal: AbortSignal.timeout(5000),
  });
  const { body: sent } = await s.request();
  expect(sent.subarray(0, 4).toString("hex")).toBe("28b52ffd");
  // Frame header descriptor: no content size, not single-segment, no checksum.
  expect(sent[4]).toBe(0x00);
  // Window descriptor: exponent 11, mantissa 0 — windowLog 21.
  expect(sent[5]).toBe(0x58);
  // Level 3, and only level 3: levels 2 and 4 produce 10979 and 10683 bytes.
  expect(Buffer.byteLength(body)).toBe(54_168);
  expect(sent.byteLength).toBe(10_676);
  expect(createHash("sha256").update(sent).digest("hex").slice(0, 16)).toBe("125037a51a82d95b");
  s.stop();
});

test("an unmarked request goes out as the bytes it was given", async () => {
  const s = wholeRequestServer();
  const http = nodeHttpClient();
  const body = JSON.stringify({ model: "m", input: "x".repeat(5000) });
  await http({
    provider: "openai",
    url: s.url,
    method: "POST",
    headers: [["content-type", "application/json"]],
    body,
    signal: AbortSignal.timeout(5000),
  });
  const { head, body: sent } = await s.request();
  expect(sent.toString("utf8")).toBe(body);
  expect(contentLength(head)).toBe(Buffer.byteLength(body));
  s.stop();
});
