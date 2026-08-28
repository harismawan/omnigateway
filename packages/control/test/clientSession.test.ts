import { expect, test } from "bun:test";
import { memoryStore, seedApiKey } from "@omni/testkit";
import { createAdminAuth } from "../src/adminAuth.ts";

let clock = 2_000_000;
const opts = { now: () => clock, sessionTtlMs: 60_000 };

test("a raw api key opens a session naming that key and no other", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  const mine = await seedApiKey(store, { label: "mine" });
  const theirs = await seedApiKey(store, { label: "theirs" });

  const token = (await auth.loginClient(mine.raw)) as string;
  expect(token).not.toBeNull();
  expect(await auth.verify(token)).toEqual({ kind: "client", apiKeyId: mine.key.id });
  expect(await auth.verify(token)).not.toEqual({ kind: "client", apiKeyId: theirs.key.id });
});

test("an unknown key opens nothing", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  await seedApiKey(store);
  expect(await auth.loginClient("omni_sk_not_a_real_key_at_all")).toBeNull();
});

test("an api key is not a password and a password is not an api key", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  await auth.setPassword("hunter2hunter2");
  await auth.setViewerPassword("read-only-pass-1");
  const { raw } = await seedApiKey(store);

  // Three credentials, three doors. A key must not open the console, and a
  // password must not open a client session under some coincidental hash.
  expect(await auth.login(raw)).toBeNull();
  expect(await auth.loginViewer(raw)).toBeNull();
  expect(await auth.loginClient("hunter2hunter2")).toBeNull();
  expect(await auth.loginClient("read-only-pass-1")).toBeNull();
});

test("a key revoked before login opens nothing", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  const { raw, key } = await seedApiKey(store);
  await store.keys.revoke(key.id);

  expect(await auth.loginClient(raw)).toBeNull();
});

/**
 * The rule the whole client surface rests on.
 *
 * Sessions are held in memory and checked against that map, so a session that
 * validated its key only at login would keep working for up to the full TTL
 * after the operator revoked it — and an operator revokes a key precisely
 * because they want it to stop working now, not within the hour.
 */
test("revoking a key ends its live session on the next request, without a restart", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  const { raw, key } = await seedApiKey(store);

  const token = (await auth.loginClient(raw)) as string;
  expect(await auth.verify(token)).toEqual({ kind: "client", apiKeyId: key.id });

  await store.keys.revoke(key.id);

  // No clock movement, no re-login, no restart: the very next verify refuses.
  expect(await auth.verify(token)).toBeNull();
});

test("revoking one key leaves another key's session alone", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  const mine = await seedApiKey(store, { label: "mine" });
  const theirs = await seedApiKey(store, { label: "theirs" });

  const mineToken = (await auth.loginClient(mine.raw)) as string;
  const theirsToken = (await auth.loginClient(theirs.raw)) as string;

  await store.keys.revoke(theirs.key.id);

  expect(await auth.verify(mineToken)).toEqual({ kind: "client", apiKeyId: mine.key.id });
  expect(await auth.verify(theirsToken)).toBeNull();
});

test("a client session expires on its ttl like any other", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  const { raw } = await seedApiKey(store);
  const token = (await auth.loginClient(raw)) as string;

  clock += 60_001;
  expect(await auth.verify(token)).toBeNull();
});

test("changing the admin password ends client sessions too", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  await auth.setPassword("hunter2hunter2");
  const { raw } = await seedApiKey(store);
  const token = (await auth.loginClient(raw)) as string;

  await auth.setPassword("correct-horse-battery");
  expect(await auth.verify(token)).toBeNull();
});

test("changing the viewer password does not end client sessions", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, opts);
  await auth.setViewerPassword("read-only-pass-1");
  const { raw, key } = await seedApiKey(store);
  const token = (await auth.loginClient(raw)) as string;

  // `invalidateKind` is per-kind for this reason: a client's access has nothing
  // to do with who else may read the console.
  await auth.setViewerPassword("read-only-pass-2");
  expect(await auth.verify(token)).toEqual({ kind: "client", apiKeyId: key.id });
});
