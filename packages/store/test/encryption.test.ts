import { expect, test } from "bun:test";
import { decrypt, deriveKey, encrypt, isEncrypted } from "../src/encryption.ts";

const SECRET = "test-secret-not-a-real-key-0123456789";

test("round-trips a value", async () => {
  const key = await deriveKey(SECRET);
  expect(await decrypt(key, await encrypt(key, "test-token-1"))).toBe("test-token-1");
});

test("ciphertext carries the versioned prefix and hides the plaintext", async () => {
  const key = await deriveKey(SECRET);
  const ct = await encrypt(key, "test-token-2");
  expect(ct.startsWith("enc:v1:")).toBe(true);
  expect(ct).not.toContain("test-token-2");
  expect(ct.split(":")).toHaveLength(5);
});

test("encrypting the same plaintext twice yields different ciphertext", async () => {
  const key = await deriveKey(SECRET);
  expect(await encrypt(key, "same")).not.toBe(await encrypt(key, "same"));
});

test("decrypting with the wrong key throws", async () => {
  const a = await deriveKey(SECRET);
  const b = await deriveKey("a-completely-different-secret-value");
  const ct = await encrypt(a, "value");
  expect(decrypt(b, ct)).rejects.toThrow();
});

test("a tampered auth tag is rejected", async () => {
  const key = await deriveKey(SECRET);
  const parts = (await encrypt(key, "value")).split(":");
  parts[4] = parts[4] === "00".repeat(16) ? "11".repeat(16) : "00".repeat(16);
  expect(decrypt(key, parts.join(":"))).rejects.toThrow();
});

test("malformed ciphertext is rejected", async () => {
  const key = await deriveKey(SECRET);
  expect(decrypt(key, "not-ciphertext")).rejects.toThrow("malformed ciphertext");
});

test("isEncrypted distinguishes ciphertext from plaintext", async () => {
  const key = await deriveKey(SECRET);
  expect(isEncrypted(await encrypt(key, "x"))).toBe(true);
  expect(isEncrypted("sk-plain-value")).toBe(false);
  expect(isEncrypted("")).toBe(false);
});

test("round-trips empty and multi-byte values", async () => {
  const key = await deriveKey(SECRET);
  expect(await decrypt(key, await encrypt(key, ""))).toBe("");
  expect(await decrypt(key, await encrypt(key, "日本語 🎉"))).toBe("日本語 🎉");
});
