#!/usr/bin/env bun
/**
 * The frozen body-envelope reader corpus, as data: every legacy, binary and
 * gzip case `packages/store/test/bodies.test.ts` puts to `decodeArtifact`,
 * sealed here the way that test seals them (the credential helper, WebCrypto
 * from the published layout, zlib), each with the frozen reader's own
 * verdict, so a second reader can be held to the same answers.
 *
 *   bun conformance/store/body-corpus.ts > corpus.json
 *
 * Output: `{ secret, cases: [{ name, bytes (hex), digest (hex|null), ok,
 * artifact? }] }`. Every case is decoded twice by the frozen reader, with no
 * digest and with the digest of exactly its bytes, and both verdicts emitted.
 */
import { gzipSync } from "node:zlib";
import { decodeArtifact, MAX_ARTIFACT_BYTES } from "../../packages/store/src/bodies/artifact.ts";
import { deriveKey, encrypt } from "../../packages/store/src/encryption.ts";

const SECRET = "test-secret-value-for-unit-tests";
const key = await deriveKey(SECRET);
const other = await deriveKey("another-secret-value-for-unit-tests");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (b: Uint8Array) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b))));
const gz = (d: Uint8Array | string) => new Uint8Array(gzipSync(d));

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function header(magic: string, version: number, codec: number, claimed: number) {
  const h = new Uint8Array(10);
  h.set(encoder.encode(magic).subarray(0, 4));
  h[4] = version;
  h[5] = codec;
  new DataView(h.buffer).setUint32(6, claimed, false);
  return h;
}

type Fields = {
  magic?: string;
  version?: number;
  codec?: number;
  claimed?: number;
  aad?: Uint8Array<ArrayBuffer>;
  key?: CryptoKey;
};

async function binarySeal(payload: Uint8Array, f: Fields = {}): Promise<Uint8Array> {
  const h = header(f.magic ?? "OGBA", f.version ?? 1, f.codec ?? 0, f.claimed ?? payload.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: f.aad ?? h, tagLength: 128 },
    f.key ?? key,
    new Uint8Array(payload),
  );
  return concat(h, iv, new Uint8Array(sealed));
}

const legacySeal = async (json: string, k: CryptoKey = key) =>
  encoder.encode(await encrypt(k, json));

async function sealWith(json: string, ivBytes: number, tagBits: number) {
  const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: tagBits },
      key,
      encoder.encode(json),
    ),
  );
  const split = sealed.length - tagBits / 8;
  return encoder.encode(
    `enc:v1:${hex(iv)}:${hex(sealed.subarray(0, split))}:${hex(sealed.subarray(split))}`,
  );
}

const paddedJson = (n: number) => `{"pad":"${"x".repeat(n - 10)}"}`;

const artifact = JSON.stringify({
  schemaVersion: 1,
  requestId: "req_corpus",
  at: 1_700_000_000_000,
  client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
  attempts: [
    {
      attempt: 1,
      provider: "anthropic",
      request: { model: "claude-opus-4-1-20250805" },
      response: { stop_reason: "end_turn" },
      streamChunks: ["event: message_start", "event: message_stop"],
      truncated: false,
    },
  ],
  error: null,
});
const compressible = JSON.stringify({
  frames: Array.from(
    { length: 200 },
    (_, i) => `event: content_block_delta\ndata: {"index":0,"delta":{"text":"word ${i}"}}`,
  ),
});

const cases: Array<[string, Uint8Array]> = [];
const add = (name: string, bytes: Uint8Array) => cases.push([name, bytes]);

// --- legacy -----------------------------------------------------------------
const legacy = await legacySeal(artifact);
const legacyText = decoder.decode(legacy);
const [, , iv = "", body = "", tag = ""] = legacyText.split(":");
const lt = (p: { iv: string; body: string; tag: string }) =>
  encoder.encode(`enc:v1:${p.iv}:${p.body}:${p.tag}`);
add("legacy: valid", legacy);
add("legacy: wrong key", await legacySeal(artifact, other));
for (const [name, bytes] of [
  ["extra component", encoder.encode(`${legacyText}:00`)],
  ["extra empty component", encoder.encode(`${legacyText}:`)],
  ["missing tag component", encoder.encode(`enc:v1:${iv}:${body}`)],
  ["trailing newline", encoder.encode(`${legacyText}\n`)],
  ["unknown version", encoder.encode(legacyText.replace("enc:v1:", "enc:v2:"))],
  ["wrong scheme", encoder.encode(legacyText.replace("enc:v1:", "ENC:v1:"))],
  ["odd-length body hex", lt({ iv, body: `${body}0`, tag })],
  ["odd-length iv hex", lt({ iv: `${iv}0`, body, tag })],
  ["odd-length tag hex", lt({ iv, body, tag: `${tag}0` })],
  ["uppercase hex", lt({ iv, body: body.toUpperCase(), tag })],
  ["non-hex character", lt({ iv, body: `g${body.slice(1)}`, tag })],
  ["empty iv", lt({ iv: "", body, tag })],
  ["empty tag", lt({ iv, body, tag: "" })],
  ["empty body", lt({ iv, body: "", tag })],
  ["short iv", lt({ iv: iv.slice(0, -2), body, tag })],
  ["long iv", lt({ iv: `${iv}00`, body, tag })],
  ["short tag", lt({ iv, body, tag: tag.slice(0, -2) })],
  ["long tag", lt({ iv, body, tag: `${tag}00` })],
  ["authenticating 16-byte iv", await sealWith(artifact, 16, 128)],
  ["authenticating 8-byte iv", await sealWith(artifact, 8, 128)],
  ["authenticating 12-byte tag", await sealWith(artifact, 12, 96)],
  ["not an envelope at all", encoder.encode("hello")],
  ["empty input", new Uint8Array(0)],
  ["non-UTF-8 bytes", new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28])],
] as const) {
  add(`legacy: ${name}`, bytes);
}
for (const plaintext of ["not json {", "", "[]", "null", "42", '"text"', "true", '{"a":']) {
  add(`legacy: authenticated non-object ${JSON.stringify(plaintext)}`, await legacySeal(plaintext));
}
add("legacy: exactly at the read ceiling", await legacySeal(paddedJson(MAX_ARTIFACT_BYTES)));
add("legacy: one size past the read ceiling", await legacySeal(paddedJson(MAX_ARTIFACT_BYTES + 1)));

// --- binary -----------------------------------------------------------------
const json = encoder.encode(artifact);
const n = json.length;
const valid = await binarySeal(json);
const flip = (b: Uint8Array, at: number) => {
  const out = b.slice();
  out[at] = (out[at] ?? 0) ^ 1;
  return out;
};
add("binary: valid", valid);
add(
  "binary: exactly at its ceiling",
  await binarySeal(encoder.encode(paddedJson(MAX_ARTIFACT_BYTES))),
);
add("binary: iv byte flipped", flip(valid, 10));
add("binary: ciphertext byte flipped", flip(valid, 22));
add("binary: tag byte flipped", flip(valid, valid.length - 1));
add("binary: sealed under another key", await binarySeal(json, { key: other }));
add("binary: sealed without additional data", await binarySeal(json, { aad: new Uint8Array(0) }));
add(
  "binary: sealed over a different claimed length",
  await binarySeal(json, { aad: header("OGBA", 1, 0, n + 1) }),
);
add(
  "binary: sealed over a different codec",
  await binarySeal(json, { aad: header("OGBA", 1, 1, n) }),
);
add(
  "binary: sealed over a different magic",
  await binarySeal(json, { aad: header("OGBX", 1, 0, n) }),
);
add(
  "binary: gzip sealed over a raw header",
  await binarySeal(gz(json), { codec: 1, claimed: n, aad: header("OGBA", 1, 0, n) }),
);
const gzipped = gz(json);
for (const [name, bytes] of [
  ["version 0", await binarySeal(json, { version: 0 })],
  ["version 2", await binarySeal(json, { version: 2 })],
  ["version 255", await binarySeal(json, { version: 255 })],
  ["codec 2", await binarySeal(json, { codec: 2 })],
  ["codec 255", await binarySeal(json, { codec: 255 })],
  ["claimed length zero, empty payload", await binarySeal(new Uint8Array(0))],
  ["claimed length one short", await binarySeal(json, { claimed: n - 1 })],
  ["claimed length one long", await binarySeal(json, { claimed: n + 1 })],
  ["claimed length 2^32 - 1", await binarySeal(json, { claimed: 2 ** 32 - 1 })],
  [
    "one byte past the binary ceiling",
    await binarySeal(encoder.encode(paddedJson(MAX_ARTIFACT_BYTES + 1))),
  ],
  ["tag truncated by a byte", valid.subarray(0, valid.length - 1)],
  ["trailing byte after the tag", concat(valid, new Uint8Array([0]))],
  ["header only", valid.subarray(0, 10)],
  ["header and iv only", valid.subarray(0, 22)],
  ["one byte short of the minimum", valid.subarray(0, 37)],
  ["magic alone", encoder.encode("OGBA")],
  ["magic in lower case", await binarySeal(json, { magic: "ogba" })],
  ["magic with a wrong last byte", await binarySeal(json, { magic: "OGBX" })],
  ["legacy prefix without its colon", encoder.encode("enc:v1")],
  ["binary magic ahead of a legacy envelope", concat(encoder.encode("OGBA"), legacy)],
  ["legacy prefix ahead of a binary envelope", concat(encoder.encode("enc:v1:"), valid)],
  ["gzip claiming zero bytes", await binarySeal(gzipped, { codec: 1, claimed: 0 })],
  [
    "gzip claiming one byte past the budget",
    await binarySeal(gzipped, { codec: 1, claimed: MAX_ARTIFACT_BYTES + 1 }),
  ],
  [
    "gzip payload one byte past the binary ceiling",
    await binarySeal(new Uint8Array(MAX_ARTIFACT_BYTES + 1), { codec: 1, claimed: n }),
  ],
  [
    "gzip payload too short for a gzip header and footer",
    await binarySeal(gzipped.slice(0, 17), { codec: 1, claimed: n }),
  ],
] as const) {
  add(`binary header: ${name}`, bytes);
}
const text = (s: string) => encoder.encode(s);
for (const [name, payload] of [
  ["invalid byte in a string", concat(text('{"a":"'), new Uint8Array([0xff]), text('"}'))],
  ["overlong encoding", concat(text('{"a":"'), new Uint8Array([0xc0, 0xaf]), text('"}'))],
  ["lone continuation byte", concat(text('{"a":"'), new Uint8Array([0x80]), text('"}'))],
  ["not json", text("not json {")],
  ["array", text("[]")],
  ["null", text("null")],
  ["number", text("42")],
  ["truncated object", text('{"a":')],
] as const) {
  add(`binary plaintext: ${name}`, await binarySeal(payload));
}

// --- gzip -------------------------------------------------------------------
const cjson = encoder.encode(compressible);
const cn = cjson.length;
const cgz = gz(cjson);
const half = Math.floor(cn / 2);
const first = gz(cjson.subarray(0, half));
const second = gz(cjson.subarray(half));
add("gzip: valid", await binarySeal(cgz, { codec: 1, claimed: cn }));
add(
  "gzip: concatenated members",
  await binarySeal(concat(first, second), { codec: 1, claimed: cn }),
);
const gflip = (at: number) => flip(cgz, at);
for (const [name, payload, claimed] of [
  ["claimed one short", cgz, cn - 1],
  ["claimed one long", cgz, cn + 1],
  ["truncated by a byte", cgz.slice(0, -1), cn],
  ["footer missing", cgz.slice(0, -8), cn],
  ["deflate stream cut in half", cgz.slice(0, Math.floor(cgz.length / 2)), cn],
  ["crc flipped", gflip(cgz.length - 8), cn],
  ["length field flipped", gflip(cgz.length - 1), cn],
  ["trailing garbage", concat(cgz, new Uint8Array([1, 2, 3])), cn],
  ["a partial second member", concat(cgz, new Uint8Array([0x1f, 0x8b])), cn],
  ["one trailing zero byte", concat(cgz, new Uint8Array(1)), cn],
  ["eight trailing zero bytes", concat(cgz, new Uint8Array(8)), cn],
  ["valid members then a zero byte", concat(first, second, new Uint8Array(1)), cn],
  ["a second member past the claimed length", concat(first, second), half],
  ["plain JSON stored as gzip", cjson, cn],
  ["gzip of nothing", gz(""), 1],
  ["gzip of an array", gz("[1]"), 3],
] as const) {
  add(`gzip expansion: ${name}`, await binarySeal(payload, { codec: 1, claimed }));
}
// The codec comes from the authenticated header, never from the payload.
{
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let length = 1; length < 1000; length++) {
    let state = length;
    const next = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state >>> 16;
    };
    const j = JSON.stringify({ k: Array.from({ length }, () => alphabet[next() % 64]).join("") });
    const p = gz(j);
    if (p.length === encoder.encode(j).length) {
      add(
        "gzip codec: gzip stream stored raw",
        await binarySeal(p, { codec: 0, claimed: p.length }),
      );
      add(
        "gzip codec: same stream under a gzip header",
        await binarySeal(p, { codec: 1, claimed: p.length }),
      );
      break;
    }
  }
}
// Bombs: thirty 16 MiB members of zeros under the ceiling.
const member = gz(new Uint8Array(16 * 1024 * 1024));
const bomb = concat(...Array.from({ length: 30 }, () => member));
for (const [name, p] of [
  ["single member", member],
  ["thirty members", bomb],
] as const) {
  for (const claimed of [1000, MAX_ARTIFACT_BYTES]) {
    add(`gzip bomb: ${name} claiming ${claimed}`, await binarySeal(p, { codec: 1, claimed }));
  }
}
const atBudget = encoder.encode(paddedJson(MAX_ARTIFACT_BYTES));
add(
  "gzip: expanding to exactly the budget",
  await binarySeal(gz(atBudget), { codec: 1, claimed: MAX_ARTIFACT_BYTES }),
);
add(
  "gzip: expanding one byte past the budget",
  await binarySeal(gz(paddedJson(MAX_ARTIFACT_BYTES + 1)), {
    codec: 1,
    claimed: MAX_ARTIFACT_BYTES,
  }),
);

const out = [];
for (const [name, bytes] of cases) {
  const digest = await sha(bytes);
  for (const expected of [null, digest, "0".repeat(64)]) {
    const read = await decodeArtifact(key, bytes, expected);
    out.push({
      name,
      bytes: hex(bytes),
      digest: expected,
      ok: read.ok,
      artifact: read.ok ? read.artifact : undefined,
    });
  }
}
console.log(JSON.stringify({ secret: SECRET, cases: out }));
