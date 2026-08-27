import { expect, test } from "bun:test";
import { memoryStore } from "@omni/testkit";
import { createAdminAuth } from "../src/adminAuth.ts";

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
  expect(await auth.verify(token as string)).toEqual({ kind: "admin" });
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
  expect(await auth.verify(token)).toBeNull();
});

test("logout invalidates a session immediately", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  const token = (await auth.login("hunter2hunter2")) as string;
  auth.logout(token);
  expect(await auth.verify(token)).toBeNull();
});

test("changing the password invalidates existing sessions", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  const token = (await auth.login("hunter2hunter2")) as string;
  await auth.setPassword("correct-horse-battery");
  expect(await auth.verify(token)).toBeNull();
});

test("invalidating sessions ends them without touching the stored password", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  const token = (await auth.login("hunter2hunter2")) as string;

  auth.invalidateSessions();

  expect(await auth.verify(token)).toBeNull();
  // The password itself is untouched: this is for the caller that replaced the
  // database underneath, not for one that changed the credential.
  expect(await auth.login("hunter2hunter2")).not.toBeNull();
});

test("verify rejects an unknown token", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  expect(await auth.verify("not-a-token")).toBeNull();
});

test("verify names the principal rather than answering yes", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  await auth.setViewerPassword("read-only-pass-1");

  const admin = (await auth.login("hunter2hunter2")) as string;
  const viewer = (await auth.loginViewer("read-only-pass-1")) as string;

  expect(await auth.verify(admin)).toEqual({ kind: "admin" });
  expect(await auth.verify(viewer)).toEqual({ kind: "viewer" });
});

test("a viewer password is unset until the operator sets one", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");

  expect(await auth.isViewerConfigured()).toBe(false);
  // Not merely wrong — there is nothing to be wrong against. An implementation
  // comparing against an absent hash must refuse rather than throw or pass.
  expect(await auth.loginViewer("anything-at-all")).toBeNull();

  await auth.setViewerPassword("read-only-pass-1");
  expect(await auth.isViewerConfigured()).toBe(true);
});

test("the two passwords are independent credentials", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  await auth.setViewerPassword("read-only-pass-1");

  // Neither password opens the other's session.
  expect(await auth.loginViewer("hunter2hunter2")).toBeNull();
  expect(await auth.login("read-only-pass-1")).toBeNull();
});

test("changing the viewer password ends viewer sessions and spares admin ones", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  await auth.setViewerPassword("read-only-pass-1");

  const admin = (await auth.login("hunter2hunter2")) as string;
  const viewer = (await auth.loginViewer("read-only-pass-1")) as string;

  await auth.setViewerPassword("read-only-pass-2");

  expect(await auth.verify(viewer)).toBeNull();
  // The operator did not change their own credential, so their window stays open.
  expect(await auth.verify(admin)).toEqual({ kind: "admin" });
});

test("clearing the viewer password revokes the access entirely", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  await auth.setViewerPassword("read-only-pass-1");
  const viewer = (await auth.loginViewer("read-only-pass-1")) as string;

  await auth.setViewerPassword(null);

  expect(await auth.verify(viewer)).toBeNull();
  expect(await auth.isViewerConfigured()).toBe(false);
  expect(await auth.loginViewer("read-only-pass-1")).toBeNull();
});

test("changing the admin password ends every kind of session", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  await auth.setPassword("hunter2hunter2");
  await auth.setViewerPassword("read-only-pass-1");
  const viewer = (await auth.loginViewer("read-only-pass-1")) as string;

  await auth.setPassword("correct-horse-battery");

  // Wider than the viewer case on purpose: the operator rotating their own
  // password is the action that should leave nobody logged in anywhere.
  expect(await auth.verify(viewer)).toBeNull();
});

test("a short viewer password is refused, and null is not a short password", async () => {
  const auth = createAdminAuth(await memoryStore(), opts);
  expect(auth.setViewerPassword("short")).rejects.toThrow();
  expect(auth.setViewerPassword(null)).resolves.toBeUndefined();
});
