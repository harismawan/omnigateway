import { expect, test } from "bun:test";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { encryptAuth, QODER_PUBLIC_KEY, signAnonymous, signAuth } from "../src/qoder/crypto.ts";
import { trustedInferenceOrigin } from "../src/qoder/endpoint.ts";
import { decodeBody, decodeServerJson, encodeBody } from "../src/qoder/protocol.ts";
import catalog from "./fixtures/qoder/catalog.json";

test("Qoder encoding matches independent CLI WASM vectors, including UTF8 and padding", () => {
  for (const [plain, encoded] of [
    ["", ""],
    ["a", "$p$#"],
    ["abc", "MSK#"],
    ["{}", "$kwm"],
    ["こんにちは 👋", "bBvoez#r$IHUIIHiIIHIIH@IIc@I"],
    [catalog.plain, catalog.encoded],
  ] as const) {
    expect(encodeBody(plain)).toBe(encoded);
    expect(decodeBody(encoded)).toBe(plain);
  }
});

test("Qoder model responses decode encoded and plaintext JSON, never corrupt data", () => {
  const want = { assistant: [{ key: "synthetic", display_name: "Synthetic" }] };
  expect(decodeServerJson(catalog.encoded)).toEqual(want);
  expect(decodeServerJson(catalog.plain)).toEqual(want);
  for (const bad of ["?", "____!", "$", "####", "not JSON", " "]) {
    expect(() => decodeServerJson(bad)).toThrow();
  }
  for (const bad of ["?", "$", "__$_", "____!", "dd$$"]) {
    expect(() => decodeBody(bad)).toThrow();
  }
});

test("Qoder signing uses newline-separated auth fields and the caller's canonical path", () => {
  const input = {
    authBase64: "AUTH",
    key: "WRAPPED",
    date: "1700000000",
    body: "$kwm",
    path: "/api/v2/service/pro/sse/agent_chat_generation",
  };
  expect(signAuth(input)).toBe("aa21f94d650f341ef2a16398f177bac7");
  expect(signAuth({ ...input, path: `/algo${input.path}` })).not.toBe(signAuth(input));
  expect(signAuth({ ...input, body: "{}" })).not.toBe(signAuth(input));
  expect(signAnonymous("Wed, 04 Nov 2026 09:22:34 GMT")).toBe("262acb17c8b21474294be0f4248d2895");
});

test("Qoder encrypts UTF8 auth with AES128 CBC IV=key and wraps 16 key bytes with PKCS1", () => {
  const key = "0123456789abcdef";
  const result = encryptAuth('{"uid":"synthetic"}', key);
  expect(result.encryptUserInfo).toBe("vO6rh9vE6tQPG+ndo73xUDgTsZ672flhfoBQBFyFIWU=");
  const pub = createPublicKey(QODER_PUBLIC_KEY);
  expect(pub.asymmetricKeyDetails?.modulusLength).toBe(1024);
  expect(Buffer.from(result.key, "base64").length).toBe(128);
  // The random PKCS1 padding must differ, while the deterministic AES output stays fixed.
  const again = encryptAuth('{"uid":"synthetic"}', key);
  expect(again.encryptUserInfo).toBe(result.encryptUserInfo);
  expect(again.key).not.toBe(result.key);
  expect(() =>
    publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key)),
  ).not.toThrow();
  for (const bad of ["", "short", "0123456789abcdeg", "界".repeat(16)]) {
    expect(() => encryptAuth("secret", bad)).toThrow();
  }
});

test("Qoder RSA wrapping decrypts to the actual AES key with PKCS1 v1.5 padding", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 1024 });
  // Inject a temporary test key only at the node:crypto boundary; execute the real helper.
  const source = readFileSync(new URL("../src/qoder/crypto.ts", import.meta.url), "utf8");
  const js = new Bun.Transpiler({ loader: "ts", target: "node" })
    .transformSync(source)
    .replace(/^import .*?;\s*/m, "")
    .replaceAll("export ", "");
  const encrypt = runInNewContext(`${js}\nencryptAuth`, {
    Buffer,
    constants,
    createCipheriv,
    createHash,
    publicEncrypt: (options: { key: string; padding: number }, bytes: Buffer) => {
      expect(options.key).toBe(QODER_PUBLIC_KEY);
      expect(options.padding).toBe(constants.RSA_PKCS1_PADDING);
      return publicEncrypt({ ...options, key: pair.publicKey }, bytes);
    },
  }) as typeof encryptAuth;
  const encrypted = encrypt("synthetic 雪", "0123456789abcdef");
  const padded = privateDecrypt(
    { key: pair.privateKey, padding: constants.RSA_NO_PADDING },
    Buffer.from(encrypted.key, "base64"),
  );
  expect(padded.subarray(0, 2)).toEqual(Buffer.from([0, 2]));
  const separator = padded.indexOf(0, 2);
  expect(separator).toBeGreaterThanOrEqual(10);
  const key = padded.subarray(separator + 1);
  expect(key.toString()).toBe("0123456789abcdef");
  const decipher = createDecipheriv("aes-128-cbc", key, key);
  expect(
    Buffer.concat([
      decipher.update(Buffer.from(encrypted.encryptUserInfo, "base64")),
      decipher.final(),
    ]).toString(),
  ).toBe("synthetic 雪");
});

test("Qoder inference origins reject credentials, ports, paths and hostile suffixes", () => {
  for (const host of ["api1", "api2", "api3"]) {
    expect(trustedInferenceOrigin(`https://${host}.qoder.sh/`)).toBe(`https://${host}.qoder.sh`);
  }
  for (const bad of [
    null,
    1,
    "http://api1.qoder.sh",
    "https://api1.qoder.sh.evil.test",
    "https://evil.test/api1.qoder.sh",
    "https://user@api1.qoder.sh",
    "https://api1.qoder.sh:444",
    "https://api1.qoder.sh/path",
    "https://api1.qoder.sh?x",
    "https://api1.qoder.sh#x",
    "https://api1.qoder.sh\n",
    "https://api1.qoder.sh/../",
    "https://api1.qoder.sh?",
  ])
    expect(trustedInferenceOrigin(bad)).toBeNull();
});
