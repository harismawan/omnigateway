import { expect, test } from "bun:test";
import { deriveKey } from "../src/encryption.ts";
import { createCredentialRepo } from "../src/sqlite/credentials.ts";
import { openDb } from "../src/sqlite/db.ts";

async function setup() {
  const db = openDb(":memory:");
  const repo = createCredentialRepo(db, await deriveKey("test-secret-value-for-unit-tests"));
  return { db, repo };
}

const input = {
  id: "c1",
  provider: "anthropic" as const,
  label: "personal",
  authType: "oauth" as const,
  enabled: true,
  tier: 1,
  weight: 1,
  expiresAt: 1000,
  accountEmail: "a@example.com",
  providerData: { deviceId: "d1" },
  disabledReason: null,
  disabledAt: null,
  accessToken: "test-token-1",
  refreshToken: "test-token-2",
  apiKey: null,
  idToken: null,
};

test("create then get round-trips metadata", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  const got = await repo.get("c1");
  expect(got?.label).toBe("personal");
  expect(got?.provider).toBe("anthropic");
  expect(got?.providerData).toEqual({ deviceId: "d1" });
  expect(got?.enabled).toBe(true);
  db.close();
});

test("tokens are encrypted at rest but decrypt through the thunk", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  const raw = db
    .query<{ access_token: string }, []>("SELECT access_token FROM credentials WHERE id='c1'")
    .get();
  expect(raw?.access_token.startsWith("enc:v1:")).toBe(true);
  expect(raw?.access_token).not.toContain("test-token-1");

  const secrets = await (await repo.get("c1"))?.secrets();
  expect(secrets?.accessToken).toBe("test-token-1");
  expect(secrets?.refreshToken).toBe("test-token-2");
  expect(secrets?.apiKey).toBeNull();
  db.close();
});

test("list returns metadata without decrypting", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.create({ ...input, id: "c2", label: "work" });
  const all = await repo.list();
  expect(all).toHaveLength(2);
  expect(all.map((c) => c.label).sort()).toEqual(["personal", "work"]);
  db.close();
});

test("update patches only the given fields", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.update("c1", { tier: 2, enabled: false });
  const got = await repo.get("c1");
  expect(got?.tier).toBe(2);
  expect(got?.enabled).toBe(false);
  expect(got?.label).toBe("personal");
  db.close();
});

test("updateSecrets replaces tokens and expiry", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.updateSecrets("c1", { accessToken: "test-token-9" }, 5000);
  const got = await repo.get("c1");
  expect(got?.expiresAt).toBe(5000);
  const secrets = await got?.secrets();
  expect(secrets?.accessToken).toBe("test-token-9");
  expect(secrets?.refreshToken).toBe("test-token-2");
  db.close();
});

test("updateSecrets encrypts refreshToken, apiKey, and idToken at rest", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.updateSecrets(
    "c1",
    { refreshToken: "test-token-10", apiKey: "test-token-11", idToken: "test-token-12" },
    5000,
  );

  const raw = db
    .query<{ refresh_token: string; api_key: string; id_token: string }, []>(
      "SELECT refresh_token, api_key, id_token FROM credentials WHERE id='c1'",
    )
    .get();
  expect(raw?.refresh_token.startsWith("enc:v1:")).toBe(true);
  expect(raw?.refresh_token).not.toContain("test-token-10");
  expect(raw?.api_key.startsWith("enc:v1:")).toBe(true);
  expect(raw?.api_key).not.toContain("test-token-11");
  expect(raw?.id_token.startsWith("enc:v1:")).toBe(true);
  expect(raw?.id_token).not.toContain("test-token-12");

  const secrets = await (await repo.get("c1"))?.secrets();
  expect(secrets?.refreshToken).toBe("test-token-10");
  expect(secrets?.apiKey).toBe("test-token-11");
  expect(secrets?.idToken).toBe("test-token-12");
  db.close();
});

test("hasRefreshToken reflects presence of a refresh token on create and get", async () => {
  const { repo, db } = await setup();
  const created = await repo.create(input);
  expect(created.hasRefreshToken).toBe(true);
  const got = await repo.get("c1");
  expect(got?.hasRefreshToken).toBe(true);

  const createdNoRefresh = await repo.create({ ...input, id: "c2", refreshToken: null });
  expect(createdNoRefresh.hasRefreshToken).toBe(false);
  const gotNoRefresh = await repo.get("c2");
  expect(gotNoRefresh?.hasRefreshToken).toBe(false);
  db.close();
});

test("hasRefreshToken treats a JSON-boundary undefined the same as null", async () => {
  const { repo, db } = await setup();
  // A real deserialization boundary (e.g. an admin API JSON body) can omit the key
  // entirely rather than sending an explicit null. JSON.stringify drops `undefined`
  // properties, so round-tripping through it reproduces that shape without an
  // unsafe cast.
  const withOmittedRefresh = JSON.parse(
    JSON.stringify({ ...input, id: "c3", refreshToken: undefined }),
  );
  const created = await repo.create(withOmittedRefresh);
  expect(created.hasRefreshToken).toBe(false);
  const got = await repo.get("c3");
  expect(got?.hasRefreshToken).toBe(false);
  db.close();
});

test("null refresh token round-trips as null", async () => {
  const { repo, db } = await setup();
  await repo.create({ ...input, refreshToken: null });
  const secrets = await (await repo.get("c1"))?.secrets();
  expect(secrets?.refreshToken).toBeNull();
  db.close();
});

test("health and quota rows round-trip", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.saveHealth([
    {
      credentialId: "c1",
      model: "claude-opus-4",
      breakerState: "open",
      consecutiveFailures: 3,
      openedAt: 111,
      rateLimitedUntil: 222,
      ewmaTtftMs: 350,
      lastUsedAt: 333,
    },
  ]);
  const health = await repo.listHealth();
  expect(health[0]?.breakerState).toBe("open");
  expect(health[0]?.ewmaTtftMs).toBe(350);

  await repo.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: 10,
      used: 5,
      limit: 100,
      resetsAt: 20,
      observedAt: 15,
    },
  ]);
  const quota = await repo.listQuota();
  expect(quota[0]?.used).toBe(5);
  expect(quota[0]?.limit).toBe(100);
  db.close();
});

test("a quota snapshot round-trips its reset and observation times", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.saveQuota([
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 100,
      used: 62,
      limit: 100,
      resetsAt: 900,
      observedAt: 500,
    },
  ]);
  // A second reading of the same window replaces the first rather than adding
  // a row: the table holds the latest snapshot, not a history.
  await repo.saveQuota([
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 200,
      used: 71,
      limit: 100,
      resetsAt: 900,
      observedAt: 600,
    },
  ]);

  const rows = await repo.listQuota();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ used: 71, resetsAt: 900, observedAt: 600 });
  db.close();
});

test("a window the provider stops reporting is dropped, not left behind", async () => {
  // A probe reports the credential's whole window set, so a window missing from
  // it is a window the provider no longer has — Codex dropping a five-hour cap,
  // for one. Leaving the old row draws a bar for a limit that does not exist,
  // and the router keeps pricing against it.
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: 0,
      used: 5,
      limit: 100,
      resetsAt: 10,
      observedAt: 1,
    },
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 0,
      used: 20,
      limit: 100,
      resetsAt: 99,
      observedAt: 1,
    },
  ]);
  expect(await repo.listQuota()).toHaveLength(2);

  await repo.saveQuota([
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 0,
      used: 24,
      limit: 100,
      resetsAt: 99,
      observedAt: 2,
    },
  ]);

  const rows = await repo.listQuota();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ windowType: "weekly", used: 24 });
  db.close();
});

test("saving one credential's windows leaves another credential's alone", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.create({ ...input, id: "c2", label: "second" });

  await repo.saveQuota([
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 0,
      used: 1,
      limit: 100,
      resetsAt: 9,
      observedAt: 1,
    },
    {
      credentialId: "c2",
      windowType: "weekly",
      startsAt: 0,
      used: 2,
      limit: 100,
      resetsAt: 9,
      observedAt: 1,
    },
  ]);

  await repo.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: 0,
      used: 3,
      limit: 100,
      resetsAt: 9,
      observedAt: 2,
    },
  ]);

  const rows = await repo.listQuota();
  expect(rows.filter((r) => r.credentialId === "c1").map((r) => r.windowType)).toEqual([
    "fiveHour",
  ]);
  expect(rows.filter((r) => r.credentialId === "c2").map((r) => r.windowType)).toEqual(["weekly"]);
  db.close();
});

test("a disabled reason round-trips and clears", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.update("c1", { enabled: false, disabledReason: "tokenRejected", disabledAt: 4_242 });

  const disabled = await repo.get("c1");
  expect(disabled?.disabledReason).toBe("tokenRejected");
  expect(disabled?.disabledAt).toBe(4_242);

  await repo.update("c1", { enabled: true, disabledReason: null, disabledAt: null });
  const enabled = await repo.get("c1");
  expect(enabled?.disabledReason).toBeNull();
  expect(enabled?.disabledAt).toBeNull();
  db.close();
});

test("saveHealth upserts rather than duplicating", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  const row = {
    credentialId: "c1",
    model: "m",
    breakerState: "closed" as const,
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: null,
    lastUsedAt: null,
  };
  await repo.saveHealth([row]);
  await repo.saveHealth([{ ...row, consecutiveFailures: 2 }]);
  const health = await repo.listHealth();
  expect(health).toHaveLength(1);
  expect(health[0]?.consecutiveFailures).toBe(2);
  db.close();
});

test("routing views load current secrets only when selected", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  const [routing] = await repo.listRouting();
  expect(routing?.label).toBe("personal");

  await repo.updateSecrets("c1", { accessToken: "test-token-current" }, 5000);
  expect((await routing?.secrets())?.accessToken).toBe("test-token-current");
  db.close();
});

test("remove deletes the credential", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.remove("c1");
  expect(await repo.get("c1")).toBeNull();
  db.close();
});

test("remove cascades to health and quota rows", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.saveHealth([
    {
      credentialId: "c1",
      model: "claude-opus-4",
      breakerState: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      rateLimitedUntil: null,
      ewmaTtftMs: null,
      lastUsedAt: null,
    },
  ]);
  await repo.saveQuota([
    {
      credentialId: "c1",
      windowType: "fiveHour",
      startsAt: 10,
      used: 5,
      limit: 100,
      resetsAt: 20,
      observedAt: 15,
    },
  ]);

  await repo.remove("c1");

  expect(await repo.listHealth()).toHaveLength(0);
  expect(await repo.listQuota()).toHaveLength(0);
  db.close();
});

test("get returns null for an unknown id", async () => {
  const { repo, db } = await setup();
  expect(await repo.get("nope")).toBeNull();
  db.close();
});
