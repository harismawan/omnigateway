import { expect, test } from "bun:test";
import {
  type CredentialHealth,
  type RoutingChange,
  SAME_WINDOW_TOLERANCE_MS,
  WINDOW_DURATION_MS,
} from "../../src/types.ts";
import { forEachStore } from "./harness.ts";

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

forEachStore((backend) => {
  test("create then get round-trips metadata and secrets", async () => {
    const s = await backend.fresh();
    const created = await s.credentials.create(input);
    expect(created.tokenVersion).toBe(0);
    expect(created.hasRefreshToken).toBe(true);
    const got = await s.credentials.get("c1");
    expect(got?.label).toBe("personal");
    expect(got?.provider).toBe("anthropic");
    expect(got?.providerData).toEqual({ deviceId: "d1" });
    expect(got?.enabled).toBe(true);
    expect(got?.expiresAt).toBe(1000);
    expect(got?.tier).toBe(1);
    expect(got?.weight).toBe(1);
    expect(got?.createdAt).toBe(created.createdAt);
    expect(typeof got?.createdAt).toBe("number");
    expect(await got?.secrets()).toEqual({
      accessToken: "test-token-1",
      refreshToken: "test-token-2",
      apiKey: null,
      idToken: null,
    });
    expect(await got?.openForInference()).toEqual({ accessToken: "test-token-1", apiKey: null });
    expect(await got?.openForRefresh()).toEqual({ refreshToken: "test-token-2" });
    expect(await s.credentials.get("nope")).toBeNull();
  });

  test("list orders by tier then label and reports refresh-token presence", async () => {
    const s = await backend.fresh();
    await s.credentials.create({ ...input, id: "b", label: "b", tier: 2 });
    await s.credentials.create({ ...input, id: "a", label: "a", tier: 2, refreshToken: null });
    await s.credentials.create({ ...input, id: "z", label: "z", tier: 1 });
    const ids = (await s.credentials.list()).map((c) => [c.id, c.hasRefreshToken]);
    expect(ids).toEqual([
      ["z", true],
      ["a", false],
      ["b", true],
    ]);
  });

  test("update patches only the given fields and moves updatedAt", async () => {
    const s = await backend.fresh();
    const created = await s.credentials.create(input);
    await new Promise((r) => setTimeout(r, 2));
    await s.credentials.update("c1", { label: "work", enabled: false, disabledReason: "manual" });
    const got = await s.credentials.get("c1");
    expect(got?.label).toBe("work");
    expect(got?.enabled).toBe(false);
    expect(got?.disabledReason).toBe("manual");
    expect(got?.tier).toBe(1);
    expect(got?.updatedAt).toBeGreaterThan(created.updatedAt);
    await s.credentials.update("c1", { disabledReason: null, enabled: true });
    expect((await s.credentials.get("c1"))?.disabledReason).toBeNull();
  });

  test("updateSecrets replaces tokens, moves expiry, and compares-and-swaps on version", async () => {
    const s = await backend.fresh();
    await s.credentials.create(input);
    const before = (await s.credentials.get("c1"))?.tokenVersion ?? -1;

    expect(
      await s.credentials.updateSecrets("c1", { accessToken: "test-token-b" }, 5000, before),
    ).toBe(true);
    expect(
      await s.credentials.updateSecrets("c1", { accessToken: "test-token-c" }, 6000, before),
    ).toBe(false);
    const row = await s.credentials.get("c1");
    expect(row?.tokenVersion).toBe(before + 1);
    expect(row?.expiresAt).toBe(5000);
    expect((await row?.secrets())?.accessToken).toBe("test-token-b");
    expect((await row?.secrets())?.refreshToken).toBe("test-token-2");
    // Unconditional writes still land, and still move the version.
    expect(
      await s.credentials.updateSecrets("c1", { accessToken: "test-token-d", apiKey: "k" }, null),
    ).toBe(true);
    const after = await s.credentials.get("c1");
    expect(after?.tokenVersion).toBe(before + 2);
    expect(after?.expiresAt).toBeNull();
    expect((await after?.secrets())?.apiKey).toBe("k");
    expect(await s.credentials.updateSecrets("nope", { accessToken: "x" }, null)).toBe(false);
  });

  test("routing views decrypt lazily and reject a removed credential", async () => {
    const s = await backend.fresh();
    await s.credentials.create(input);
    const [view] = await s.credentials.listRouting();
    expect(view?.hasRefreshToken).toBe(true);
    expect(await view?.openForInference()).toEqual({ accessToken: "test-token-1", apiKey: null });
    await s.credentials.remove("c1");
    await expect(view?.openForInference()).rejects.toThrow("no longer exists");
    await expect(view?.openForRefresh()).rejects.toThrow("no longer exists");
    await expect(view?.secrets()).rejects.toThrow("no longer exists");
  });

  test("remove cascades to health, quota and samples", async () => {
    const s = await backend.fresh();
    await s.credentials.create(input);
    await s.credentials.saveHealth([blank]);
    await s.credentials.saveQuota([
      {
        credentialId: "c1",
        windowType: "fiveHour",
        startsAt: 0,
        used: 1,
        limit: 10,
        resetsAt: 100,
        observedAt: 50,
        windowMs: null,
      },
    ]);
    expect(await s.credentials.listHealth()).toHaveLength(1);
    expect(await s.credentials.listQuota()).toHaveLength(1);
    await s.credentials.remove("c1");
    expect(await s.credentials.get("c1")).toBeNull();
    expect(await s.credentials.listHealth()).toEqual([]);
    expect(await s.credentials.listQuota()).toEqual([]);
    expect(await s.credentials.listQuotaSamples({ since: 0, until: 1e15 })).toEqual([]);
  });

  test("saveHealth upserts and updateHealth composes atomically from the stored row", async () => {
    const s = await backend.fresh();
    await s.credentials.create(input);
    await s.credentials.saveHealth([blank]);
    await s.credentials.saveHealth([{ ...blank, consecutiveFailures: 2, ewmaTtftMs: 12.5 }]);
    const rows = await s.credentials.listHealth();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consecutiveFailures).toBe(2);
    expect(rows[0]?.ewmaTtftMs).toBe(12.5);

    const changes: RoutingChange[] = [];
    s.routing.subscribe((change) => changes.push(change));
    const written = await s.credentials.updateHealth("c1", "m", (current) => ({
      ...(current ?? blank),
      consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
      openedAt: 99,
    }));
    expect(written.consecutiveFailures).toBe(3);
    expect((await s.credentials.listHealth())[0]?.openedAt).toBe(99);
    expect(changes).toEqual([{ type: "healthSaved", rows: [written] }]);

    // A row that does not exist yet hands `apply` null.
    let seen: CredentialHealth | null | undefined;
    await s.credentials.updateHealth("c1", "other", (current) => {
      seen = current;
      return { ...blank, model: "other" };
    });
    expect(seen).toBeNull();
    expect(await s.credentials.listHealth()).toHaveLength(2);
  });

  test("saveQuota replaces a credential's window set and leaves another's alone", async () => {
    const s = await backend.fresh();
    await s.credentials.create(input);
    await s.credentials.create({ ...input, id: "c2", label: "other" });
    const w = (credentialId: string, windowType: "fiveHour" | "weekly", used: number) => ({
      credentialId,
      windowType,
      startsAt: 0,
      used,
      limit: 100,
      resetsAt: 1_000_000,
      observedAt: 500,
      windowMs: 3_600_000,
    });
    await s.credentials.saveQuota([
      w("c1", "fiveHour", 1),
      w("c1", "weekly", 2),
      w("c2", "weekly", 3),
    ]);
    await s.credentials.saveQuota([w("c1", "fiveHour", 4)]);
    const quota = (await s.credentials.listQuota()).sort((a, b) =>
      `${a.credentialId}${a.windowType}`.localeCompare(`${b.credentialId}${b.windowType}`),
    );
    expect(quota).toEqual([{ ...w("c1", "fiveHour", 4) }, { ...w("c2", "weekly", 3) }]);
    expect(typeof quota[0]?.resetsAt).toBe("number");
  });

  test("quota samples are written only when a reading moved, within the shared tolerance", async () => {
    const s = await backend.fresh();
    await s.credentials.create(input);
    const reading = (observedAt: number, used: number, resetsAt: number, limit = 100) => ({
      credentialId: "c1",
      windowType: "fiveHour" as const,
      startsAt: 0,
      used,
      limit,
      resetsAt,
      observedAt,
      windowMs: null,
    });
    const samples = () => s.credentials.listQuotaSamples({ since: 0, until: 1e15 });
    await s.credentials.saveQuota([reading(1, 10, 1_000_000)]);
    // Identical reading: no sample. Jittered reset: no sample.
    await s.credentials.saveQuota([reading(2, 10, 1_000_000)]);
    await s.credentials.saveQuota([reading(3, 10, 1_000_000 + SAME_WINDOW_TOLERANCE_MS - 1)]);
    expect(await samples()).toHaveLength(1);
    // Moved `used`: sample. Rollover onto same `used`: sample. Raised ceiling: sample.
    await s.credentials.saveQuota([reading(4, 11, 1_000_000)]);
    await s.credentials.saveQuota([reading(5, 11, 1_000_000 + WINDOW_DURATION_MS.fiveHour)]);
    await s.credentials.saveQuota([reading(6, 11, 1_000_000 + WINDOW_DURATION_MS.fiveHour, 200)]);
    expect((await samples()).map((r) => r.observedAt)).toEqual([1, 4, 5, 6]);

    // Range and credential filters, and a limit that keeps the newest.
    expect((await samples()).map((r) => r.used)).toEqual([10, 11, 11, 11]);
    expect(
      (await s.credentials.listQuotaSamples({ since: 4, until: 5, credentialId: "c1" })).map(
        (r) => r.observedAt,
      ),
    ).toEqual([4, 5]);
    expect(
      (await s.credentials.listQuotaSamples({ since: 0, until: 1e15, limit: 2 })).map(
        (r) => r.observedAt,
      ),
    ).toEqual([5, 6]);
    expect(await s.credentials.pruneQuotaSamples(5)).toBe(2);
    expect((await samples()).map((r) => r.observedAt)).toEqual([5, 6]);
  });

  test("routing subscribers receive every committed local change and survive a throw", async () => {
    const s = await backend.fresh();
    const types: string[] = [];
    s.routing.subscribe(() => {
      throw new Error("observer");
    });
    s.routing.subscribe((change) => types.push(change.type));
    await s.credentials.create(input);
    await s.credentials.update("c1", { label: "x" });
    await s.credentials.updateSecrets("c1", { accessToken: "y" }, null);
    await s.credentials.saveHealth([blank]);
    await s.credentials.saveQuota([]);
    await s.credentials.remove("c1");
    await s.config.putModel({ id: "m", targets: [], strategy: "score", isAlias: false });
    await s.config.removeModel("m");
    await s.config.putSettings({ maxAttempts: 2 });
    expect(types).toEqual([
      "credentialsChanged",
      "credentialsChanged",
      "credentialsChanged",
      "healthSaved",
      "quotaSaved",
      "credentialsChanged",
      "modelsChanged",
      "modelsChanged",
      "settingsChanged",
    ]);
  });

  test("routing version moves when a sibling store commits configuration", async () => {
    const a = await backend.fresh();
    const b = await backend.sibling();
    const before = a.routing.version();
    await b.credentials.create(input);
    // Read-behind on Postgres: the call after the change sees it. Poll briefly
    // rather than assert the first read, so the contract is "moves", not "when".
    let after = before;
    for (let i = 0; i < 50 && after === before; i++) {
      after = a.routing.version();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(after).not.toBe(before);
  });
});
