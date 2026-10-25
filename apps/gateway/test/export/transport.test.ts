import { afterAll, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import {
  ConnectTimeoutError,
  IncompleteResponseError,
  ResponseTooLargeError,
} from "../../src/export/deliver.ts";
import { httpTransport, MAX_RESPONSE_BYTES } from "../../src/export/transport.ts";

/** The production transport against real local sockets. */

const seen: Array<{ path: string; headers: Headers; body: string }> = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ path: url.pathname, headers: req.headers, body: await req.text() });
    if (url.pathname === "/redirect") {
      return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
    }
    if (url.pathname === "/big") return new Response("x".repeat(MAX_RESPONSE_BYTES * 2));
    if (url.pathname === "/slow") await Bun.sleep(2_000);
    return Response.json({ ok: true }, { headers: { "retry-after": "7" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;

// A listener that accepts TCP but never answers TLS: the connect step of an
// https request never completes.
const sockets: Socket[] = [];
const silent = createServer((socket) => sockets.push(socket)).listen(0, "127.0.0.1");
afterAll(() => {
  server.stop(true);
  for (const s of sockets) s.destroy();
  silent.close();
});

const init = (over: Partial<Parameters<typeof httpTransport>[1]> = {}) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json", "x-k": "v" },
  body: '{"a":1}',
  signal: new AbortController().signal,
  connectTimeoutMs: 5_000,
  ...over,
});

test("posts the body and headers, and reads status, headers and body", async () => {
  const res = await httpTransport(`${base}/in`, init());
  expect(res.status).toBe(200);
  expect(res.headers.get("retry-after")).toBe("7");
  expect(JSON.parse(await res.text())).toEqual({ ok: true });
  const last = seen.at(-1);
  expect(last?.path).toBe("/in");
  expect(last?.body).toBe('{"a":1}');
  expect(last?.headers.get("x-k")).toBe("v");
});

test("never follows a redirect: the 3xx comes back as itself", async () => {
  const before = seen.length;
  const res = await httpTransport(`${base}/redirect`, init());
  expect(res.status).toBe(302);
  expect(seen.slice(before).map((s) => s.path)).toEqual(["/redirect"]);
});

test("a body past the bound rejects as too large, never as a shorter reply", async () => {
  const res = await httpTransport(`${base}/big`, init());
  expect(res.status).toBe(200);
  await expect(res.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
});

/**
 * A raw HTTP server that answers 200 and then breaks the body: a declared
 * length it never finishes, or a chunked body it never terminates.
 */
const raw = createServer((socket) => {
  sockets.push(socket);
  socket.once("data", (chunk) => {
    const head = chunk.toString("latin1");
    if (head.includes("/short-length")) {
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 100\r\nconnection: close\r\n\r\n{"errors":fa');
    } else {
      socket.write('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\n{"err\r\n');
      setTimeout(() => socket.destroy(), 20);
    }
  });
}).listen(0, "127.0.0.1");
const rawBase = () => `http://127.0.0.1:${(raw.address() as { port: number }).port}`;
afterAll(() => raw.close());

test("a body cut short by the receiver rejects as incomplete, never resolves partial text", async () => {
  for (const path of ["/short-length", "/broken-chunked"]) {
    const res = await httpTransport(`${rawBase()}${path}`, init());
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toBeInstanceOf(IncompleteResponseError);
  }
});

test("a body can be discarded without reading it", async () => {
  const res = await httpTransport(`${base}/big`, init());
  await res.discard();
});

test("an IPv6 literal destination connects, with a correct Host header", async () => {
  let v6: ReturnType<typeof Bun.serve> | null = null;
  try {
    v6 = Bun.serve({
      hostname: "::1",
      port: 0,
      fetch: (req) => new Response(req.headers.get("host")),
    });
  } catch {
    // No IPv6 loopback on this host: nothing to test.
    return;
  }
  try {
    const res = await httpTransport(`http://[::1]:${v6.port}/in`, init());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`[::1]:${v6.port}`);
  } finally {
    v6.stop(true);
  }
});

test("no connection within the connect timeout rejects as ConnectTimeoutError", async () => {
  const port = (silent.address() as { port: number }).port;
  const started = performance.now();
  await expect(
    httpTransport(`https://127.0.0.1:${port}/`, init({ connectTimeoutMs: 200 })),
  ).rejects.toBeInstanceOf(ConnectTimeoutError);
  expect(performance.now() - started).toBeLessThan(2_000);
});

test("an abort rejects with the signal's reason", async () => {
  const controller = new AbortController();
  const sent = httpTransport(`${base}/slow`, init({ signal: controller.signal }));
  setTimeout(() => controller.abort(new Error("deadline")), 50);
  await expect(sent).rejects.toThrow("deadline");
});

test("consecutive requests to one host each connect afresh and all succeed", async () => {
  for (let i = 0; i < 3; i++) {
    const res = await httpTransport(`${base}/in`, init({ connectTimeoutMs: 1_000 }));
    expect(res.status).toBe(200);
    await res.text();
  }
});
