import { expect, test } from "bun:test";
import { deriveKey } from "../src/encryption.ts";
import { createCredentialRepo } from "../src/sqlite/credentials.ts";
import { openDb } from "../src/sqlite/db.ts";
import {
  type CredentialHealth,
  type RoutingChange,
  SAME_WINDOW_TOLERANCE_MS,
  WINDOW_DURATION_MS,
} from "../src/types.ts";

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

const blank: CredentialHealth = {
  credentialId: "c1",
  model: "m",
  breakerState: "closed",
  consecutiveFailures: 0,
  openedAt: null,
  rateLimitedUntil: null,
  ewmaTtftMs: null,
  lastUsedAt: null,
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

test("purpose-specific opening ignores unrelated malformed ciphertext", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  db.run("UPDATE credentials SET api_key = 'malformed', id_token = 'malformed' WHERE id = 'c1'");
  const oauth = await repo.get("c1");
  expect(await oauth?.openForInference()).toEqual({ accessToken: "test-token-1", apiKey: null });
  expect(await oauth?.openForRefresh()).toEqual({ refreshToken: "test-token-2" });
  expect(await oauth?.openForUsage()).toEqual({ accessToken: "test-token-1" });

  await repo.create({
    ...input,
    id: "c2",
    authType: "apiKey",
    accessToken: null,
    refreshToken: null,
    apiKey: "test-key-1",
  });
  db.run(
    "UPDATE credentials SET access_token = 'malformed', refresh_token = 'malformed', id_token = 'malformed' WHERE id = 'c2'",
  );
  const apiKey = await repo.get("c2");
  expect(await apiKey?.openForInference()).toEqual({ accessToken: null, apiKey: "test-key-1" });
  db.close();
});

test("purpose-specific opening rejects malformed required ciphertext", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  db.run("UPDATE credentials SET access_token = 'malformed' WHERE id = 'c1'");
  const malformedAccess = await repo.get("c1");
  expect(malformedAccess?.openForInference()).rejects.toThrow("malformed ciphertext");
  expect(malformedAccess?.openForUsage()).rejects.toThrow("malformed ciphertext");

  db.run("UPDATE credentials SET refresh_token = 'malformed' WHERE id = 'c1'");
  const malformedRefresh = await repo.get("c1");
  expect(malformedRefresh?.openForRefresh()).rejects.toThrow("malformed ciphertext");
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
      windowMs: null,
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
      windowMs: null,
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
      windowMs: null,
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
      windowMs: null,
    },
    {
      credentialId: "c1",
      windowType: "weekly",
      startsAt: 0,
      used: 20,
      limit: 100,
      resetsAt: 99,
      observedAt: 1,
      windowMs: null,
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
      windowMs: null,
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
      windowMs: null,
    },
    {
      credentialId: "c2",
      windowType: "weekly",
      startsAt: 0,
      used: 2,
      limit: 100,
      resetsAt: 9,
      observedAt: 1,
      windowMs: null,
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
      windowMs: null,
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

// A transition reads the row as it is on disk, inside the write transaction, so
// two of them cannot lose each other's increment the way two whole-row upserts
// computed from one snapshot do.
test("updateHealth increments compose rather than overwrite", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  const bump = (current: CredentialHealth | null): CredentialHealth => ({
    ...(current ?? blank),
    consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
  });

  await repo.updateHealth("c1", "m", bump);
  await repo.updateHealth("c1", "m", bump);

  const health = await repo.listHealth();
  expect(health).toHaveLength(1);
  expect(health[0]?.consecutiveFailures).toBe(2);
  db.close();
});

test("updateHealth hands apply a null row when none exists yet", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  let seen: CredentialHealth | null | undefined;

  const written = await repo.updateHealth("c1", "m", (current) => {
    seen = current;
    return { ...blank, breakerState: "open", openedAt: 42 };
  });

  expect(seen).toBeNull();
  expect(written.breakerState).toBe("open");
  expect(await repo.listHealth()).toEqual([written]);
  db.close();
});

test("updateHealth returns the row it persisted", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.saveHealth([{ ...blank, consecutiveFailures: 4, ewmaTtftMs: 250 }]);

  const written = await repo.updateHealth("c1", "m", (current) => ({
    ...(current ?? blank),
    consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
  }));

  expect(written.consecutiveFailures).toBe(5);
  expect(written.ewmaTtftMs).toBe(250);
  expect(await repo.listHealth()).toEqual([written]);
  db.close();
});

// The snapshot cache patches its map in place from this payload without
// rebuilding, so the emitted row has to be the post-transition one. It comes
// from the same binding that was written, so what this pins is that one change
// fires and that it carries the result of the fresh read rather than a count
// derived from whatever the caller last saw.
test("updateHealth emits one healthSaved carrying the transition's result", async () => {
  const db = openDb(":memory:");
  const changes: RoutingChange[] = [];
  const repo = createCredentialRepo(db, await deriveKey("test-secret-value-for-unit-tests"), (c) =>
    changes.push(c),
  );
  await repo.create(input);
  await repo.saveHealth([{ ...blank, consecutiveFailures: 7 }]);
  changes.length = 0;

  const written = await repo.updateHealth("c1", "m", (current) => ({
    ...(current ?? blank),
    consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
  }));

  expect(changes).toHaveLength(1);
  const change = changes[0];
  if (change?.type !== "healthSaved") throw new Error("expected a healthSaved change");
  expect(change.rows).toEqual([written]);
  expect(change.rows[0]?.consecutiveFailures).toBe(8);
  db.close();
});

test("routing views load current secrets only when selected", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  const [routing] = await repo.listRouting();
  expect(routing?.label).toBe("personal");

  await repo.updateSecrets("c1", { accessToken: "test-token-current" }, 5000);
  expect((await routing?.secrets())?.accessToken).toBe("test-token-current");
  expect(await routing?.openForInference()).toEqual({
    accessToken: "test-token-current",
    apiKey: null,
  });
  expect(await routing?.openForUsage()).toEqual({ accessToken: "test-token-current" });
  db.close();
});

test("routing purpose-specific loaders reject a removed credential", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  const [routing] = await repo.listRouting();

  await repo.remove("c1");
  expect(routing?.openForInference()).rejects.toThrow("credential c1 no longer exists");
  expect(routing?.openForRefresh()).rejects.toThrow("credential c1 no longer exists");
  expect(routing?.openForUsage()).rejects.toThrow("credential c1 no longer exists");
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
      windowMs: null,
    },
  ]);

  await repo.remove("c1");

  expect(await repo.listHealth()).toHaveLength(0);
  expect(await repo.listQuota()).toHaveLength(0);
  db.close();
});

const reading = {
  credentialId: "c1",
  windowType: "fiveHour" as const,
  startsAt: 0,
  used: 5,
  limit: 100,
  resetsAt: 900,
  observedAt: 100,
  windowMs: null,
};

/** Every sample ever written, whatever the clock said. */
const allSamples = { since: 0, until: Number.MAX_SAFE_INTEGER };

test("an identical reading writes no sample", async () => {
  // At a 300s poll an idle account is re-read hundreds of times a day. Storing
  // each one would fill the table with rows that describe nothing happening.
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([reading]);
  await repo.saveQuota([{ ...reading, observedAt: 400 }]);
  await repo.saveQuota([{ ...reading, observedAt: 700, startsAt: 42 }]);

  const samples = await repo.listQuotaSamples(allSamples);
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ observedAt: 100, used: 5 });
  db.close();
});

test("a changed reading writes a sample", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([reading]);
  await repo.saveQuota([{ ...reading, observedAt: 400, used: 6 }]);

  const samples = await repo.listQuotaSamples(allSamples);
  expect(samples.map((s) => s.used)).toEqual([5, 6]);
  expect(samples.map((s) => s.observedAt)).toEqual([100, 400]);
  db.close();
});

test("a rollover onto the same used value still writes a sample", async () => {
  // The load-bearing case for including `resets_at` in the comparison. A window
  // that rolled over and happens to read the same `used` is a *different*
  // window; dropping it merges two windows into one continuous line. A real
  // rollover moves the reset by a whole window, which is what tells it apart
  // from the arithmetic jitter below.
  const { repo, db } = await setup();
  await repo.create(input);

  const rolled = 900 + WINDOW_DURATION_MS.fiveHour;
  await repo.saveQuota([reading]);
  await repo.saveQuota([{ ...reading, observedAt: 400, resetsAt: rolled }]);

  const samples = await repo.listQuotaSamples(allSamples);
  expect(samples).toHaveLength(2);
  expect(samples.map((s) => s.resetsAt)).toEqual([900, rolled]);
  db.close();
});

test("a reset time that only jittered writes no sample", async () => {
  // The OpenAI/Codex shape. Its payload states a whole-second countdown, so the
  // absolute reset is derived as `now + seconds * 1000` and moves a few hundred
  // milliseconds on every poll even when the window never rolled over. Compared
  // exactly, dedup never fires and an idle account writes a row per poll for as
  // long as it is connected.
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([reading]);
  await repo.saveQuota([{ ...reading, observedAt: 400, resetsAt: 900 + 137 }]);
  await repo.saveQuota([{ ...reading, observedAt: 700, resetsAt: 900 - 402 }]);
  await repo.saveQuota([{ ...reading, observedAt: 1_000, resetsAt: 900 + 1_985 }]);

  const samples = await repo.listQuotaSamples(allSamples);
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ observedAt: 100, resetsAt: 900 });
  db.close();
});

test("dedup splits windows exactly where the shared tolerance does", async () => {
  // Pins this site to `SAME_WINDOW_TOLERANCE_MS` rather than to a number that
  // happens to match it today. Storage and chart must agree about what a window
  // is; a local copy here would be free to drift from the one the console
  // splits its line on.
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([reading]);
  await repo.saveQuota([{ ...reading, observedAt: 400, resetsAt: 900 + SAME_WINDOW_TOLERANCE_MS }]);
  expect(await repo.listQuotaSamples(allSamples)).toHaveLength(1);

  await repo.saveQuota([
    { ...reading, observedAt: 700, resetsAt: 900 + SAME_WINDOW_TOLERANCE_MS + 1 },
  ]);
  expect(await repo.listQuotaSamples(allSamples)).toHaveLength(2);
  db.close();
});

test("a raised ceiling on an unmoved reading writes a sample", async () => {
  // A plan change lifts `limit` while `used` sits still. Without `limit_value`
  // in the comparison nothing is written, and every percentage the chart draws
  // stays on the old denominator until traffic happens to move `used`.
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([reading]);
  await repo.saveQuota([{ ...reading, observedAt: 400, limit: 200 }]);

  const samples = await repo.listQuotaSamples(allSamples);
  expect(samples.map((s) => s.limit)).toEqual([100, 200]);
  db.close();
});

test("a reported window duration round-trips on the snapshot and the sample", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([{ ...reading, windowMs: 10_800_000 }]);
  expect((await repo.listQuota())[0]?.windowMs).toBe(10_800_000);
  expect((await repo.listQuotaSamples(allSamples))[0]?.windowMs).toBe(10_800_000);

  // A provider that stops stating the duration is back to unknown, not to the
  // last duration it happened to mention.
  await repo.saveQuota([{ ...reading, observedAt: 400, windowMs: null }]);
  expect((await repo.listQuota())[0]?.windowMs).toBeNull();
  const samples = await repo.listQuotaSamples(allSamples);
  expect(samples.map((s) => s.windowMs)).toEqual([10_800_000, null]);
  db.close();
});

test("samples are filtered by range and by credential", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.create({ ...input, id: "c2", label: "second" });

  await repo.saveQuota([reading, { ...reading, credentialId: "c2", used: 11 }]);
  await repo.saveQuota([
    { ...reading, observedAt: 500, used: 6 },
    { ...reading, credentialId: "c2", observedAt: 500, used: 12 },
  ]);

  expect((await repo.listQuotaSamples({ since: 200, until: 600 })).map((s) => s.used)).toEqual([
    6, 12,
  ]);
  expect(
    (await repo.listQuotaSamples({ ...allSamples, credentialId: "c2" })).map((s) => s.used),
  ).toEqual([11, 12]);
  db.close();
});

test("remove cascades to quota samples", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.saveQuota([reading]);
  expect(await repo.listQuotaSamples(allSamples)).toHaveLength(1);

  await repo.remove("c1");
  expect(await repo.listQuotaSamples(allSamples)).toHaveLength(0);
  db.close();
});

test("a window the provider stops reporting keeps its samples", async () => {
  // Unlike `quota_windows`, history is not replaced by the newest window set: a
  // window that is gone still happened, and its shape stays readable until it
  // ages out.
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([reading, { ...reading, windowType: "weekly", used: 20 }]);
  await repo.saveQuota([{ ...reading, observedAt: 400, used: 6 }]);

  expect(await repo.listQuota()).toHaveLength(1);
  expect(
    (await repo.listQuotaSamples(allSamples)).filter((s) => s.windowType === "weekly"),
  ).toHaveLength(1);
  db.close();
});

test("pruning drops samples older than the cutoff and leaves the rest", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  await repo.saveQuota([reading]);
  await repo.saveQuota([{ ...reading, observedAt: 400, used: 6 }]);
  await repo.saveQuota([{ ...reading, observedAt: 700, used: 7 }]);

  expect(await repo.pruneQuotaSamples(500)).toBe(2);
  expect((await repo.listQuotaSamples(allSamples)).map((s) => s.observedAt)).toEqual([700]);
  db.close();
});

test("saveQuota writes neither snapshot nor sample when it fails", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  // The second row names a credential that does not exist, so the foreign key
  // fails partway through and the whole call must leave nothing behind.
  await expect(repo.saveQuota([reading, { ...reading, credentialId: "ghost" }])).rejects.toThrow();

  expect(await repo.listQuota()).toHaveLength(0);
  expect(await repo.listQuotaSamples(allSamples)).toHaveLength(0);
  db.close();
});

test("get returns null for an unknown id", async () => {
  const { repo, db } = await setup();
  expect(await repo.get("nope")).toBeNull();
  db.close();
});

/**
 * A limited read keeps the newest readings and still answers in span order.
 *
 * The limit exists for the unscoped reader — the client surface reads every
 * credential at once — where the span bounds how far back the scan reaches and
 * nothing bounds how many rows come back from it. Truncating the default
 * ordering would cut the alphabetical tail, so whole accounts would vanish
 * rather than every account's history getting shorter.
 */
test("listQuotaSamples honours a limit by dropping the oldest readings", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.create({ ...input, id: "c2", label: "second" });

  // Six retained readings, alternating accounts, each one a change.
  for (const [index, credentialId] of ["c1", "c2", "c1", "c2", "c1", "c2"].entries()) {
    await repo.saveQuota([
      { ...reading, credentialId, used: 5 + index, observedAt: 100 + index * 100 },
    ]);
  }
  expect(await repo.listQuotaSamples(allSamples)).toHaveLength(6);

  const limited = await repo.listQuotaSamples({ ...allSamples, limit: 3 });
  expect(limited).toHaveLength(3);
  // The three newest instants, whichever accounts they belong to.
  expect(limited.map((row) => row.observedAt).sort((a, b) => a - b)).toEqual([400, 500, 600]);
  // Both accounts survive, which cutting the default ordering would not have
  // preserved: `c2` sorts last and would have gone first.
  expect(new Set(limited.map((row) => row.credentialId))).toEqual(new Set(["c1", "c2"]));
  // And the rows come back in the order an unlimited read uses.
  const keys = limited.map((row) => `${row.credentialId}:${row.windowType}:${row.observedAt}`);
  expect([...keys].sort()).toEqual(keys);
  db.close();
});
