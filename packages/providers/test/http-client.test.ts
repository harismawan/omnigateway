import { expect, test } from "bun:test";
import { nodeHttpClient } from "../src/http-client.ts";

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
    url: s.url,
    method: "POST",
    headers: [
      ["User-Agent", "claude-cli/2.1.219 (external, cli)"],
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

test("aborts an in-flight request", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const http = nodeHttpClient();
  const ac = new AbortController();
  const pending = http({
    url: `http://127.0.0.1:${server.port}/`,
    method: "POST",
    headers: [],
    body: "{}",
    signal: ac.signal,
  });
  ac.abort();
  await expect(pending).rejects.toThrow();
  server.stop(true);
});
