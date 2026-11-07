#!/usr/bin/env bun
/**
 * Exports pure-function vectors from the TypeScript build at the freeze commit.
 *
 * The Rust gateway's unit tests consume `vectors.json` and must reproduce every
 * output exactly. Each vector is computed by calling the real TS function, never
 * by restating its algorithm here, so the file is evidence of what TS does
 * rather than of what someone believed it does.
 *
 *   bun conformance/vectors/export.ts > conformance/vectors/vectors.json
 *
 * Re-run only on purpose: a diff to `vectors.json` is a behaviour change in the
 * frozen build, which the freeze allows for bug fixes alone.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import {
  ccVersionSuffix,
  computeCch,
  orderFields,
  signAnthropicBody,
} from "../../packages/providers/src/body.ts";
import {
  keyed,
  prefixNamespace,
  threadIdFrom,
  threadInstant,
  uuidV4From,
  uuidV5,
  uuidV7From,
} from "../../packages/providers/src/openai/codexIdentity.ts";
import { signAnonymous, signAuth } from "../../packages/providers/src/qoder/crypto.ts";
import { decodeBody, encodeBody } from "../../packages/providers/src/qoder/protocol.ts";
import { decrypt, deriveKey, encrypt } from "../../packages/store/src/encryption.ts";
import { hashApiKey } from "../../packages/store/src/sqlite/keys.ts";

/** Strings chosen to break naive ports: empty, astral, lone surrogates, JSON metacharacters. */
const AWKWARD = [
  "",
  "a",
  "hello world",
  "read_file",
  "ReadFile",
  "mcp__server__tool",
  "日本語のテキスト",
  "emoji 😀 and 👨‍👩‍👧",
  'quote " backslash \\ slash / newline \n tab \t',
  "\u2028\u2029 line separators",
  "nul \u0000 and del \u007f",
  "lone high \ud800 surrogate",
  "lone low \udc00 surrogate",
  "x".repeat(1000),
];

/** Values whose JSON.stringify output differs from naive serializers. */
const JSON_VALUES: unknown[] = [
  0,
  -0,
  1,
  -1,
  1.5,
  0.1,
  0.30000000000000004,
  1e21,
  1e-7,
  123456789012345680000,
  2 ** 53,
  2 ** 53 + 2,
  -1e-300,
  5e-324,
  1.7976931348623157e308,
  100,
  1e20,
  1.0000000000000002,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  null,
  true,
  false,
  ...AWKWARD,
  [],
  {},
  { b: 1, a: 2 },
  { "10": "ten", "2": "two", b: "b", a: "a", "-1": "neg", "01": "lead" },
  { nested: { "1": 1, z: [1, { "0": 0, y: -0 }] } },
  [1, "two", null, [3], { k: 4.25 }],
  { u: undefined, keep: 1 },
  [undefined, () => 0],
];

function utf16Units(s: string): number[] {
  return Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
}

async function main(): Promise<void> {
  const secret = "vector-only-encryption-key-0123456789";
  const key = await deriveKey(secret);
  const encryption = [];
  for (const plaintext of ["", "sk-ant-abc", "日本語", "x".repeat(300)]) {
    encryption.push({ plaintext, ciphertext: await encrypt(key, plaintext) });
  }
  // Every ciphertext must round-trip through TS itself before it is a vector.
  for (const v of encryption) {
    if ((await decrypt(key, v.ciphertext)) !== v.plaintext) throw new Error("TS round-trip failed");
  }

  const apiKeys = [];
  for (const raw of [
    "sk-omni-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "sk-omni-UPRhR9mOT4PxCkNr0CMFcRvNXZ5In5QdgOq_JLPB9dw",
    "",
  ]) {
    apiKeys.push({ raw, hash: await hashApiKey(raw), prefix: raw.slice(0, 12) });
  }

  const anthropicBodies = [
    `{"model":"m","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=cli; cch=00000;"}],"messages":[]}`,
    // A tool result quoting the placeholder before `system` must not be the one replaced.
    `{"messages":[{"role":"user","content":"cch=00000;"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=cli; cch=00000;"}]}`,
    `{"no":"billing block","cch":"cch=00000;"}`,
    `{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=1; cch=00000;"}],"t":"日本語 😀"}`,
  ];

  const salt = "a".repeat(64);
  const qoderAuth = {
    authBase64: "eyJ2ZXJzaW9uIjoidjEifQ==",
    key: "0123456789abcdef",
    date: "1794026194",
    body: '{"a":1}',
    path: "/api/v2/service/pro/sse/agent_chat_generation",
  };

  // Qoder's Cosy-Key wrapping is randomised (PKCS#1 v1.5 padding), so the vector
  // is the AES half, which is deterministic, plus a self-check that RSA is v1.5.
  const aesKey = "0123456789abcdef";
  const userJson = '{"uid":"u1","name":"日本"}';
  const keyBytes = Buffer.from(aesKey, "ascii");
  const cipher = createCipheriv("aes-128-cbc", keyBytes, keyBytes);
  const encryptUserInfo = Buffer.concat([cipher.update(userJson, "utf8"), cipher.final()]).toString(
    "base64",
  );
  const back = createDecipheriv("aes-128-cbc", keyBytes, keyBytes);
  if (
    Buffer.concat([
      back.update(Buffer.from(encryptUserInfo, "base64")),
      back.final(),
    ]).toString() !== userJson
  ) {
    throw new Error("qoder AES self-check failed");
  }

  const vectors = {
    generatedBy: "conformance/vectors/export.ts",
    bunVersion: Bun.version,
    jsonStringify: JSON_VALUES.map((value, i) => ({
      // The input is carried as a tagged form a Rust test can rebuild, since
      // JSON itself cannot carry -0, NaN, Infinity or lone surrogates.
      index: i,
      input: describe(value),
      output: JSON.stringify(value) ?? null,
      pretty: JSON.stringify(value, null, 2) ?? null,
    })),
    orderFields: [
      {
        obj: { stream: true, model: "m", messages: [], extra: 1 },
        order: ["model", "messages", "stream"],
        output: JSON.stringify(
          orderFields({ stream: true, model: "m", messages: [], extra: 1 }, [
            "model",
            "messages",
            "stream",
          ]),
        ),
      },
    ],
    xxhash: AWKWARD.map((s) => ({
      utf16: utf16Units(s),
      seed0: Bun.hash.xxHash64(Buffer.from(s, "utf8")).toString(),
      seedCch: Bun.hash.xxHash64(Buffer.from(s, "utf8"), 0x6e52736ac806831en).toString(),
    })),
    cch: anthropicBodies.map((body) => ({
      body,
      computeCch: computeCch(body),
      signed: signAnthropicBody(body),
    })),
    ccVersionSuffix: AWKWARD.map((s) => ({ utf16: utf16Units(s), suffix: ccVersionSuffix(s) })),
    encryption: { secret, vectors: encryption },
    apiKeys,
    codexIdentity: {
      uuidV5: AWKWARD.slice(0, 8).map((name) => ({
        namespace: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
        utf16: utf16Units(name),
        output: uuidV5("6ba7b812-9dad-11d1-80b4-00c04fd430c8", name),
      })),
      uuidV4From: AWKWARD.slice(0, 8).map((seed) => ({
        utf16: utf16Units(seed),
        output: uuidV4From(seed),
      })),
      uuidV7From: [0, 1, 1794026194000, 2 ** 47].map((ts) => ({
        seed: "seed",
        timestampMs: ts,
        output: uuidV7From("seed", ts),
      })),
      threadIdFrom: AWKWARD.slice(0, 8).map((seed) => ({
        utf16: utf16Units(seed),
        output: threadIdFrom(seed),
      })),
      threadInstant: [
        { threadId: threadIdFrom("abc"), now: 1794026194000 },
        { threadId: "01890a5d-ac96-774b-bcce-b302099a8057", now: 1794026194000 },
        { threadId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", now: 1794026194000 },
      ].map((v) => ({ ...v, output: threadInstant(v.threadId, v.now) })),
      keyed: [
        { salt: null, seed: "s", output: keyed(undefined, "s") },
        { salt, seed: "s", output: keyed(salt, "s") },
        { salt, seed: "日本語", output: keyed(salt, "日本語") },
      ],
      prefixNamespace: [
        { threadId: threadIdFrom("abc"), output: prefixNamespace(threadIdFrom("abc")) },
      ],
    },
    qoder: {
      encodeBody: AWKWARD.filter(
        (s) => !/[\ud800-\udfff]/.test(s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")),
      ).map((plain) => ({ plain, encoded: encodeBody(plain) })),
      decodeBodyErrors: ["abc", "!!!!", "____"].map((encoded) => {
        try {
          return { encoded, decoded: decodeBody(encoded), error: false };
        } catch {
          return { encoded, decoded: null, error: true };
        }
      }),
      signAuth: { input: qoderAuth, output: signAuth(qoderAuth) },
      signAnonymous: [
        {
          date: "Sat, 07 Nov 2026 04:36:32 GMT",
          output: signAnonymous("Sat, 07 Nov 2026 04:36:32 GMT"),
        },
      ],
      aes: { key: aesKey, userJson, encryptUserInfo },
    },
  };
  process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
}

/** A JSON-safe description of any vector input, rebuildable on the Rust side. */
function describe(value: unknown): unknown {
  if (value === undefined) return { undefined: true };
  if (typeof value === "function") return { function: true };
  if (typeof value === "number") {
    if (Object.is(value, -0)) return { number: "-0" };
    if (Number.isNaN(value)) return { number: "NaN" };
    if (!Number.isFinite(value)) return { number: value > 0 ? "Infinity" : "-Infinity" };
    // The f64 bit pattern, so the Rust side rebuilds exactly this double.
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    return { number: view.getBigUint64(0).toString(16).padStart(16, "0") };
  }
  if (typeof value === "string") return { string: utf16Units(value) };
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) return { array: value.map(describe) };
  // Object.keys reports the order JSON.stringify will use, which is the point.
  return {
    object: Object.keys(value as object).map((k) => [
      utf16Units(k),
      describe((value as Record<string, unknown>)[k]),
    ]),
  };
}

await main();
