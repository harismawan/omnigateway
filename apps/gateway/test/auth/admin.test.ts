import { expect, test } from "bun:test";
import { createAdminAuth } from "../../src/auth/admin.ts";
import { memoryStore } from "../helpers/fixtures.ts";

let clock = 1_000_000;
const opts = { now: () => clock, sessionTtlMs: 60_000 };

test("reports unconfigured until a password is set", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  expect(await auth.isConfigured()).toBe(false);
  await auth.setPassword("hunter2hunter2");
  expect(await auth.isConfigured()).toBe(true);
});

test("initial password creation reports whether it won", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  expect(await auth.setInitialPassword("hunter2hunter2")).toBe(true);
  expect(await auth.setInitialPassword("another-password")).toBe(false);
  expect(await auth.login("hunter2hunter2")).not.toBeNull();
  expect(await auth.login("another-password")).toBeNull();
});

test("issues a session token for the right password", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  const token = await auth.login("hunter2hunter2");
  expect(token).not.toBeNull();
  expect(await auth.verify(token as string)).toBe(true);
});

test("returns null for the wrong password", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  expect(await auth.login("wrong-password-x")).toBeNull();
});

test("returns null when no password is configured", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  expect(await auth.login("anything")).toBeNull();
});

test("rejects a short password", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  expect(auth.setPassword("short")).rejects.toThrow();
});

test("expires a session after its ttl", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  const token = (await auth.login("hunter2hunter2")) as string;
  clock += 60_001;
  expect(await auth.verify(token)).toBe(false);
});

test("logout invalidates a session immediately", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  const token = (await auth.login("hunter2hunter2")) as string;
  auth.logout(token);
  expect(await auth.verify(token)).toBe(false);
});

test("changing the password invalidates existing sessions", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  const token = (await auth.login("hunter2hunter2")) as string;
  await auth.setPassword("correct-horse-battery");
  expect(await auth.verify(token)).toBe(false);
});

test("verify rejects an unknown token", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  expect(await auth.verify("not-a-token")).toBe(false);
});
