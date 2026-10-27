import { expect, test } from "bun:test";
import {
  artifactPlaintextLength,
  openArtifactText,
  sealArtifactWithGzip,
} from "../../src/bodies/artifact.ts";
import { deriveKey, encrypt } from "../../src/encryption.ts";

test("export probes expanded length and authenticates it without building a JSON tree", async () => {
  const key = await deriveKey("export-text-test");
  const text = JSON.stringify({ client: { request: "a".repeat(1_000_000), response: null } });
  const sealed = await sealArtifactWithGzip(key, text);
  expect(sealed.bytes.length).toBeLessThan(10000);
  expect(artifactPlaintextLength(sealed.bytes.subarray(0, 10), sealed.bytes.length)).toBe(
    text.length,
  );
  expect(await openArtifactText(key, sealed.bytes, sealed.sha256)).toBe(text);
  const bad = sealed.bytes.slice();
  new DataView(bad.buffer).setUint32(6, 20);
  expect(await openArtifactText(key, bad, null)).toBeNull();
  const legacy = new TextEncoder().encode(await encrypt(key, text));
  expect(artifactPlaintextLength(legacy.subarray(0, 10), legacy.length)).toBe(text.length);
  expect(await openArtifactText(key, legacy, null)).toBe(text);
});
