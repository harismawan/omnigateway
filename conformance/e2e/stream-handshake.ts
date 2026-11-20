#!/usr/bin/env bun
// Run inside an isolated loopback network namespace with a private HOME.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";

const [binary, workArg, reference, mode] = process.argv.slice(2);
if (!binary || !workArg) throw Error("binary work required");
const work = resolve(workArg);
mkdirSync(work, { recursive: true });
const p = Bun.spawn([binary], {
  cwd: work,
  env: {
    ...process.env,
    OMNI_ROOT: work,
    OMNI_DB_PATH: `${work}/omni.db`,
    OMNI_ENCRYPTION_KEY: "stream-test-encryption-key-0123456789",
    OMNI_HOST: "127.0.0.1",
    OMNI_PORT: "18771",
    OMNI_LOG_LEVEL: "warn",
  },
  stdout: Bun.file(`${work}/stdout`),
  stderr: Bun.file(`${work}/stderr`),
});
try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch("http://127.0.0.1:18771/health")).ok) break;
    } catch {}
    await Bun.sleep(25);
  }
  const setup = await fetch("http://127.0.0.1:18771/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "stream-test-password" }),
  });
  const login = await fetch("http://127.0.0.1:18771/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "stream-test-password" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw Error(`setup ${setup.status} login ${login.status} ${await login.text()}`);
  const api = async (path: string, body: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:18771${path}`, {
      method,
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  const vp = await api(
    "/api/settings/viewer-password",
    { password: "stream-viewer-password" },
    "PUT",
  );
  if (!vp.ok) throw Error(`viewer password ${vp.status} ${await vp.text()}`);
  const viewer = await api("/api/login", { password: "stream-viewer-password", mode: "viewer" });
  const viewerCookie = viewer.headers.get("set-cookie")?.split(";")[0];
  const keyResponse = await api("/api/keys", { label: "stream-test" });
  const keyData = (await keyResponse.json()) as { key: string; id: string };
  writeFileSync(`${work}/key-shape.json`, JSON.stringify(Object.keys(keyData)));
  const client = await api("/api/client/login", { key: keyData.key });
  const clientCookie = client.headers.get("set-cookie")?.split(";")[0];
  if (!viewerCookie || !clientCookie)
    throw Error(
      `role sessions ${viewer.status} ${client.status} key ${keyResponse.status} ${JSON.stringify(keyData)}`,
    );
  const upgrade =
    "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
  const text = (s: string) => {
    const b = Buffer.from(s);
    return Buffer.concat([
      b.length < 126
        ? Buffer.from([0x81, 0x80 | b.length, 1, 2, 3, 4])
        : Buffer.from([0x81, 0xfe, b.length >> 8, b.length & 255, 1, 2, 3, 4]),
      Buffer.from(b.map((v, i) => v ^ [1, 2, 3, 4][i % 4])),
    ]);
  };
  const mask = (op: number, p: number[]) =>
    Buffer.concat([
      Buffer.from([op, 128 | p.length, 1, 2, 3, 4]),
      Buffer.from(p.map((v, i) => v ^ [1, 2, 3, 4][i % 4])),
    ]);
  const names: string[] = [];
  for (const [name, headers, extra] of [
    ["plain", "", Buffer.alloc(0)],
    ["none", upgrade, Buffer.alloc(0)],
    ["bearer", upgrade + "Authorization: Bearer x\r\n", Buffer.alloc(0)],
    ["both", upgrade + `Authorization: Bearer x\r\nCookie: ${cookie}\r\n`, Buffer.alloc(0)],
    ["invalid", upgrade + "Cookie: omni_admin=invalid\r\n", Buffer.alloc(0)],
    [
      "success",
      upgrade + `Cookie: ${cookie}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n`,
      Buffer.alloc(0),
    ],
    ["viewer", upgrade + `Cookie: ${viewerCookie}\r\n`, Buffer.alloc(0)],
    ["client", upgrade + `Cookie: ${clientCookie}\r\n`, Buffer.alloc(0)],
    [
      "bad-version",
      upgrade.replace("Version: 13", "Version: 12") + `Cookie: ${cookie}\r\n`,
      Buffer.alloc(0),
    ],
    [
      "missing-key",
      upgrade.replace("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n", "") +
        `Cookie: ${cookie}\r\n`,
      Buffer.alloc(0),
    ],
    ...["x", "!!!!!!!!!!!!!!!!!!!!!!!!", "", "dGhlIHNhbXBsZSBub25jZQ="].map(
      (key, i) =>
        [
          `bad-key-${i}`,
          upgrade.replace("dGhlIHNhbXBsZSBub25jZQ==", key) + `Cookie: ${cookie}\r\n`,
          Buffer.alloc(0),
        ] as const,
    ),
    [
      "no-connection",
      upgrade.replace("Connection: Upgrade\r\n", "") + `Cookie: ${cookie}\r\n`,
      Buffer.alloc(0),
    ],
    [
      "subprotocol",
      upgrade + `Cookie: ${cookie}\r\nSec-WebSocket-Protocol: chat, other\r\n`,
      Buffer.alloc(0),
    ],
    ["head", upgrade + `Cookie: ${cookie}\r\n`, Buffer.alloc(0)],
    ["unmasked", upgrade + `Cookie: ${cookie}\r\n`, Buffer.from([0x81, 1, 0x78])],
    ["reserved-opcode", upgrade + `Cookie: ${cookie}\r\n`, mask(0x83, [])],
    [
      "oversize-control",
      upgrade + `Cookie: ${cookie}\r\n`,
      Buffer.from([0x89, 0xfe, 0, 126, 1, 2, 3, 4, ...Array(126).fill(0)]),
    ],
    ["invalid-utf8", upgrade + `Cookie: ${cookie}\r\n`, mask(0x81, [0xff])],
    ["invalid-close", upgrade + `Cookie: ${cookie}\r\n`, mask(0x88, [3, 237])],
    ["fragmented-control", upgrade + `Cookie: ${cookie}\r\n`, mask(0x09, [])],
    ...[
      ["rsv1", 0xc1],
      ["rsv2", 0xa1],
      ["rsv3", 0x91],
      ["orphan-continuation", 0x80],
    ].map(([n, op]) => [n, upgrade + `Cookie: ${cookie}\r\n`, mask(op as number, [])] as const),
    ...[16, 64].map((width) => {
      const data = Buffer.from('{"type":"subscribe","topic":"res:logs"}');
      const header =
        width === 16
          ? Buffer.from([0x81, 254, 0, data.length, 0, 0, 0, 0])
          : Buffer.from([0x81, 255, 0, 0, 0, 0, 0, 0, 0, data.length, 0, 0, 0, 0]);
      return [
        `nonminimal-${width}`,
        upgrade + `Cookie: ${cookie}\r\n`,
        Buffer.concat([header, data]),
      ] as const;
    }),
    [
      "length-high",
      upgrade + `Cookie: ${cookie}\r\n`,
      Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]),
    ],
    ["short-close", upgrade + `Cookie: ${cookie}\r\n`, mask(0x88, [1])],
    [
      "nested-fragment",
      upgrade + `Cookie: ${cookie}\r\n`,
      Buffer.concat([mask(1, []), mask(0x81, [])]),
    ],
    ["close-invalid-utf8", upgrade + `Cookie: ${cookie}\r\n`, mask(0x88, [3, 232, 255])],
    [
      "oversize",
      upgrade + `Cookie: ${cookie}\r\n`,
      Buffer.from([0x81, 0xff, 0, 0, 0, 0, 1, 0, 0, 1, 1, 2, 3, 4]),
    ],
    ...[
      ["surrogate-id", '{"type":"subscribe","topic":"res:logs","id":"\\ud800"}', cookie],
      [
        "deep-extra",
        '{"type":"subscribe","topic":"res:logs","extra":' +
          "[".repeat(150) +
          "0" +
          "]".repeat(150) +
          "}",
        cookie,
      ],
      ["overflow-extra", '{"type":"subscribe","topic":"res:logs","extra":1e999}', cookie],
      ["malformed", "wat", cookie],
      ["no-source", JSON.stringify({ type: "subscribe", topic: "stream:absent", id: "s" }), cookie],
      ["denied", JSON.stringify({ type: "subscribe", topic: "res:settings" }), clientCookie],
      ["subscribe", JSON.stringify({ type: "subscribe", topic: "res:logs", id: "s" }), cookie],
      ["unsubscribe", JSON.stringify({ type: "unsubscribe", topic: "res:logs", id: "u" }), cookie],
      ["read-only", JSON.stringify({ type: "send", topic: "res:logs", payload: {} }), cookie],
    ].map(([n, s, c]) => [n, upgrade + `Cookie: ${c}\r\n`, text(s)] as const),
  ] as const) {
    names.push(name);
    const result = await new Promise<Buffer>((yes, no) => {
      const chunks: Buffer[] = [];
      let sent = false;
      const s = connect(18771, "127.0.0.1", () =>
        s.write(
          `${name === "head" ? "HEAD" : "GET"} /api/stream HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`,
        ),
      );
      s.on("data", (b) => {
        chunks.push(b);
        const all = Buffer.concat(chunks);
        if (all.includes(Buffer.from("\r\n\r\n"))) {
          if (extra.length && !sent) {
            sent = true;
            s.write(extra);
            return;
          }
          if (!extra.length || all.indexOf(Buffer.from("\r\n\r\n")) + 4 < all.length) {
            s.destroy();
            yes(all);
          }
        }
      });
      s.on("error", no);
      s.on("end", () => yes(Buffer.concat(chunks)));
      s.setTimeout(3000, () => {
        s.destroy();
        yes(Buffer.concat(chunks));
      });
    });
    writeFileSync(`${work}/${name}.raw`, result);
    console.log(
      name,
      JSON.stringify(
        result.toString("latin1").replace(/omni_admin=[^;\r]+/g, "omni_admin=<token>"),
      ),
    );
  }
  await api("/api/logout", {});
  const revoked = await new Promise<Buffer>((yes, no) => {
    const chunks: Buffer[] = [];
    const s = connect(18771, "127.0.0.1", () =>
      s.write(`GET /api/stream HTTP/1.1\r\nHost: localhost\r\n${upgrade}Cookie: ${cookie}\r\n\r\n`),
    );
    s.on("data", (b) => {
      chunks.push(b);
      s.destroy();
      yes(Buffer.concat(chunks));
    });
    s.on("error", no);
  });
  writeFileSync(`${work}/revoked.raw`, revoked);
  if (!revoked.toString().startsWith("HTTP/1.1 401")) throw Error("revoked session upgraded");
  if (reference) {
    for (const name of [...names, "revoked"]) {
      const canonical = (b: Buffer) => {
        const at = b.indexOf("\r\n\r\n");
        if (at < 0) throw Error("missing response head");
        const lines = b.subarray(0, at).toString("latin1").split("\r\n");
        // HTTP header names are case insensitive. Keep and disclose raw evidence.
        // Sole framing exclusion: Hyper synthesizes CL:0 on the empty,
        // close-delimited bad-version 426 (see stream-step2.md).
        const head = lines
          .slice(1)
          .map((s) => s.replace(/^([^:]+):/, (a, n) => n.toLowerCase() + ":"))
          .filter((s) => !(name === "bad-version" && s === "content-length: 0"))
          .map((s) => (s.startsWith("date:") ? "date: <date>" : s))
          .sort();
        return [lines[0], head, b.subarray(at + 4).toString("hex")];
      };
      const a = canonical(readFileSync(`${reference}/${name}.raw`)),
        b = canonical(readFileSync(`${work}/${name}.raw`));
      if (JSON.stringify(a) !== JSON.stringify(b))
        throw Error(`${name}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    }
    console.log(
      `${names.length + 1} paired exact status/header-multiset/body/frame comparisons pass (header names lowercase; Date value masked)`,
    );
  }
} finally {
  p.kill("SIGTERM");
  await p.exited;
}
