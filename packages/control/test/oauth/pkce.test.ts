import { expect, test } from "bun:test";
import { createPkce, randomState } from "../../src/oauth/pkce.ts";

test("produces a verifier in the rfc 7636 length range", () => {
  const { verifier } = createPkce();
  expect(verifier.length).toBeGreaterThanOrEqual(43);
  expect(verifier.length).toBeLessThanOrEqual(128);
});

test("produces url-safe base64 with no padding", () => {
  const { verifier, challenge } = createPkce();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("challenge is the base64url sha-256 of the verifier", async () => {
  const { verifier, challenge } = createPkce();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  expect(challenge).toBe(Buffer.from(digest).toString("base64url"));
});

test("successive calls differ", () => {
  expect(createPkce().verifier).not.toBe(createPkce().verifier);
});

test("state is a 32-byte url-safe token", () => {
  const state = randomState();
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(state).not.toBe(randomState());
});
