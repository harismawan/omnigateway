#!/usr/bin/env bun
/**
 * Puts the TS `nodeHttpClient` and the Rust client on the same raw listener
 * and requires their request bytes to be identical, case by case.
 *
 *   cargo build -p omni-providers --example send_wire_cases
 *   bun conformance/http/compare-wire.ts
 *
 * The cases are `httpWire` in `vectors.json` (written by `export.ts`); this is
 * the live counterpart of the Rust test that replays those recorded bytes.
 */
import { nodeHttpClient } from "../../packages/providers/src/http-client.ts";

type Case = { method: string; path: string; headers: [string, string][]; body: string };

const vectors = JSON.parse(
  await Bun.file(new URL("../vectors/vectors.json", import.meta.url)).text(),
) as { httpWire: Case[] };
const binary = new URL("../../target/debug/examples/send_wire_cases", import.meta.url).pathname;

const captured: string[] = [];
const server = Bun.listen<{ buf: Buffer }>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(s) {
      s.data = { buf: Buffer.alloc(0) };
    },
    data(s, data) {
      s.data.buf = Buffer.concat([s.data.buf, Buffer.from(data)]);
      for (;;) {
        const end = s.data.buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = s.data.buf.subarray(0, end).toString("latin1");
        const rest = s.data.buf.subarray(end + 4);
        let total: number;
        if (/\r\ntransfer-encoding:[^\r]*\bchunked\b/i.test(head)) {
          const at = rest.indexOf("0\r\n\r\n");
          if (at === -1) return;
          total = end + 4 + at + 5;
        } else {
          const length = Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? "0");
          if (rest.byteLength < length) return;
          total = end + 4 + length;
        }
        captured.push(s.data.buf.subarray(0, total).toString("latin1"));
        s.data.buf = s.data.buf.subarray(total);
        s.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
      }
    },
    close() {},
    error() {},
  },
});
const base = `http://127.0.0.1:${server.port}`;

const ts: string[] = [];
const http = nodeHttpClient();
for (const c of vectors.httpWire) {
  const before = captured.length;
  const res = await http({
    provider: "custom",
    url: `${base}${c.path}`,
    method: c.method,
    headers: c.headers,
    body: c.body,
    signal: AbortSignal.timeout(5000),
  });
  await res.text();
  while (captured.length === before) await Bun.sleep(5);
  ts.push(captured[before] as string);
}

const start = captured.length;
const child = Bun.spawn([binary], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
for (const c of vectors.httpWire) {
  child.stdin.write(
    `${JSON.stringify({ url: `${base}${c.path}`, method: c.method, headers: c.headers, body: c.body })}\n`,
  );
}
await child.stdin.end();
const statuses = (await new Response(child.stdout).text()).trim().split("\n");
await child.exited;
const rust = captured.slice(start);
server.stop(true);

let failed = 0;
vectors.httpWire.forEach((c, i) => {
  if (ts[i] !== rust[i]) {
    failed++;
    console.error(
      `MISMATCH ${c.method} ${c.path}\n  ts:   ${JSON.stringify(ts[i])}\n  rust: ${JSON.stringify(rust[i])}`,
    );
  }
  if (statuses[i] !== "200") {
    failed++;
    console.error(`rust status for ${c.method} ${c.path}: ${statuses[i]}`);
  }
});
console.log(`${vectors.httpWire.length - failed}/${vectors.httpWire.length} cases byte-identical`);
process.exit(failed === 0 ? 0 : 1);
