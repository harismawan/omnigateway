import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  type ExportDestinationInput,
  type ExportFilter,
  ExportLimitError,
  MAX_EXPORT_DESTINATIONS,
} from "../../src/types.ts";
import { exec, forEachStore, logRow } from "./harness.ts";

const input = (overrides: Partial<ExportDestinationInput> = {}): ExportDestinationInput => ({
  id: "es-main",
  type: "elasticsearch",
  config: { url: "https://es.internal:9200", index: "omni-logs-{yyyy.MM.dd}" },
  filter: { apiKeyIds: ["k1"], failedOnly: true },
  startFrom: "oldest",
  ...overrides,
});

/** The stored secret column, read past the repo: what a snapshot or a dump would carry. */
async function rawSecret(
  backend: { name: "sqlite" | "postgres" },
  path: string,
  id: string,
): Promise<string | null> {
  if (backend.name === "sqlite") {
    const db = new Database(path, { readonly: true });
    try {
      return (
        db
          .query<{ secret: string | null }, [string]>(
            "SELECT secret FROM export_destinations WHERE id = ?",
          )
          .get(id)?.secret ?? null
      );
    } finally {
      db.close();
    }
  }
  const sql = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
  try {
    const rows = await sql.unsafe<Array<{ secret: string | null }>>(
      "SELECT secret FROM export_destinations WHERE id = $1",
      [id],
    );
    return rows[0]?.secret ?? null;
  } finally {
    await sql.close();
  }
}

forEachStore((backend) => {
  test("create mints a generation, round-trips config and filter, and lists by id", async () => {
    const s = await backend.fresh();
    expect(await s.exportDestinations.list()).toEqual([]);
    const created = await s.exportDestinations.create(input());
    expect(created).toMatchObject({
      id: "es-main",
      type: "elasticsearch",
      enabled: true,
      config: { url: "https://es.internal:9200", index: "omni-logs-{yyyy.MM.dd}" },
      filter: { apiKeyIds: ["k1"], failedOnly: true },
      includeBodies: false,
      maxRequestBytes: null,
      startAt: 0,
      hasSecret: false,
    });
    expect(created.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof created.createdAt).toBe("number");
    expect(created.updatedAt).toBe(created.createdAt);

    await s.exportDestinations.create(
      input({ id: "a-hook", type: "webhook", config: { url: "https://hook" }, enabled: false }),
    );
    const listed = await s.exportDestinations.list();
    expect(listed.map((d) => d.id)).toEqual(["a-hook", "es-main"]);
    expect(listed[0]?.enabled).toBe(false);
    expect(listed[1]).toEqual(created);
    expect(await s.exportDestinations.get("es-main")).toEqual(created);
    expect(await s.exportDestinations.get("nope")).toBeNull();
  });

  test("startFrom now fixes start_at from the database clock; oldest is zero", async () => {
    const s = await backend.fresh();
    const before = Date.now();
    const now = await s.exportDestinations.create(input({ id: "from-now", startFrom: "now" }));
    const after = Date.now();
    // The database clock on Postgres, so a container's clock may sit a little
    // off the test's own; the bound is loose on purpose.
    expect(now.startAt).toBeGreaterThan(before - 60_000);
    expect(now.startAt).toBeLessThan(after + 60_000);
    const oldest = await s.exportDestinations.create(input({ id: "from-zero" }));
    expect(oldest.startAt).toBe(0);
    // Two creations, two generations: state is keyed by generation, never by slug.
    expect(now.generation).not.toBe(oldest.generation);
  });

  /**
   * For a copy into a new backend: the destination must start strictly after
   * every row the store already holds, even one stamped in the creation's own
   * millisecond or ahead of the clock, or the initial cursor `(startAt, '')`
   * would re-send it.
   */
  test("startFrom afterExisting starts strictly after every completed row", async () => {
    const s = await backend.fresh();
    expect(
      (await s.exportDestinations.create(input({ id: "empty", startFrom: "afterExisting" })))
        .startAt,
    ).toBeGreaterThan(Date.now() - 60_000);

    await s.usage.append(logRow({ id: "r1", at: 1 }));
    await s.usage.append(logRow({ id: "r2", at: 2 }));
    const ahead = Date.now() + 3_600_000;
    await exec(backend, s, `UPDATE request_logs SET completed_at = ${ahead} WHERE id = 'r2'`);
    await s.usage.begin(logRow({ id: "p", at: 3, state: "pending", status: 0 }));

    const d = await s.exportDestinations.create(input({ id: "copy", startFrom: "afterExisting" }));
    expect(d.startAt).toBe(ahead + 1);
    const page = await s.usage.exportPage({
      after: { completedAt: d.startAt, id: "" },
      settledBefore: Number.MAX_SAFE_INTEGER,
      limit: 10,
    });
    expect(page).toEqual([]);
  });

  /**
   * A filter is the scope of what leaves the installation, so a stored one
   * nothing can read must narrow to nothing — never fall open to everything —
   * and must say so, so the worker can refuse rather than silently skip.
   */
  test("a malformed stored filter reads as match-nothing and is flagged", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "r1", at: 1, apiKeyId: "k1", status: 500 }));
    await s.usage.append(logRow({ id: "r2", at: 2, apiKeyId: "k2", status: 200 }));
    await s.exportDestinations.create(input({ id: "d", filter: {} }));
    const fine = await s.exportDestinations.get("d");
    expect(fine).toMatchObject({ filter: {}, filterMalformed: false });

    const malformed = [
      "not json",
      "[]",
      "null",
      '"k1"',
      '{"apiKeyIds":"k1"}',
      '{"apiKeyIds":null}',
      '{"apiKeyIds":["k1",7]}',
      '{"models":{"0":"opus"}}',
      '{"models":["opus",null]}',
      '{"failedOnly":"true"}',
      '{"failedOnly":1}',
      '{"failedOnly":null}',
      '{"states":["done"]}',
    ];
    for (const raw of malformed) {
      await exec(
        backend,
        s,
        `UPDATE export_destinations SET filter = '${raw.replaceAll("'", "''")}' WHERE id = 'd'`,
      );
      const read = await s.exportDestinations.get("d");
      expect({ raw, malformed: read?.filterMalformed }).toEqual({ raw, malformed: true });
      expect((await s.exportDestinations.list())[0]?.filterMalformed).toBe(true);
      // Even a reader that ignores the flag selects nothing with what it got.
      const rows = await s.usage.exportPage({
        after: { completedAt: 0, id: "" },
        settledBefore: Number.MAX_SAFE_INTEGER,
        limit: 10,
        filter: read?.filter as ExportFilter,
      });
      expect({ raw, rows: rows.map((r) => r.id) }).toEqual({ raw, rows: [] });
    }

    // Well-formed shapes are not flagged, an explicit `false` included.
    for (const raw of [
      "{}",
      '{"apiKeyIds":[]}',
      '{"apiKeyIds":["k1"],"models":["opus"],"failedOnly":true}',
      '{"failedOnly":false}',
    ]) {
      await exec(backend, s, `UPDATE export_destinations SET filter = '${raw}' WHERE id = 'd'`);
      expect({ raw, malformed: (await s.exportDestinations.get("d"))?.filterMalformed }).toEqual({
        raw,
        malformed: false,
      });
    }
    expect((await s.exportDestinations.get("d"))?.filter).toEqual({ failedOnly: false });

    // A repaired filter written through the repo clears the flag.
    await s.exportDestinations.update("d", { filter: { apiKeyIds: ["k1"] } });
    expect(await s.exportDestinations.get("d")).toMatchObject({
      filter: { apiKeyIds: ["k1"] },
      filterMalformed: false,
    });
  });

  /** Each read's match-nothing filter is its own: mutating one widens no other. */
  test("a malformed filter read cannot be mutated into another destination's scope", async () => {
    const s = await backend.fresh();
    await s.usage.append(logRow({ id: "r1", at: 1, apiKeyId: "k1" }));
    await s.exportDestinations.create(input({ id: "a" }));
    await s.exportDestinations.create(input({ id: "b" }));
    await exec(backend, s, "UPDATE export_destinations SET filter = 'not json'");

    const first = await s.exportDestinations.get("a");
    first?.filter.apiKeyIds?.push("k1");

    for (const later of [
      await s.exportDestinations.get("b"),
      await s.exportDestinations.get("a"),
      ...(await s.exportDestinations.list()),
    ]) {
      expect(later?.filter).toEqual({ apiKeyIds: [] });
      const rows = await s.usage.exportPage({
        after: { completedAt: 0, id: "" },
        settledBefore: Number.MAX_SAFE_INTEGER,
        limit: 10,
        filter: later?.filter as ExportFilter,
      });
      expect(rows).toEqual([]);
    }
  });

  test("a recreated slug gets a fresh generation", async () => {
    const s = await backend.fresh();
    const first = await s.exportDestinations.create(input());
    expect(await s.exportDestinations.remove("es-main")).toBe(true);
    expect(await s.exportDestinations.remove("es-main")).toBe(false);
    expect(await s.exportDestinations.get("es-main")).toBeNull();
    const second = await s.exportDestinations.create(input());
    expect(second.generation).not.toBe(first.generation);
  });

  test("the secret is encrypted at rest, never read back, and opened only by openSecret", async () => {
    const s = await backend.fresh();
    const created = await s.exportDestinations.create(input({ secret: "ApiKey c2VjcmV0" }));
    expect(created.hasSecret).toBe(true);
    expect(JSON.stringify(created)).not.toContain("c2VjcmV0");
    expect(JSON.stringify(await s.exportDestinations.list())).not.toContain("c2VjcmV0");
    const stored = await rawSecret(backend, s.databasePath, "es-main");
    expect(stored).toStartWith("enc:v1:");
    expect(stored).not.toContain("c2VjcmV0");
    expect(await s.exportDestinations.openSecret("es-main")).toBe("ApiKey c2VjcmV0");
    expect(await s.exportDestinations.openSecret("nope")).toBeNull();

    const bare = await s.exportDestinations.create(input({ id: "bare" }));
    expect(bare.hasSecret).toBe(false);
    expect(await s.exportDestinations.openSecret("bare")).toBeNull();
  });

  test("update patches the named fields; secret sets, null clears, absent keeps", async () => {
    const s = await backend.fresh();
    const created = await s.exportDestinations.create(input({ secret: "one" }));

    const toggled = await s.exportDestinations.update("es-main", {
      enabled: false,
      maxRequestBytes: 1_048_576,
    });
    expect(toggled).toMatchObject({
      enabled: false,
      maxRequestBytes: 1_048_576,
      config: created.config,
      filter: created.filter,
      hasSecret: true,
      generation: created.generation,
      startAt: created.startAt,
      createdAt: created.createdAt,
    });
    expect(await s.exportDestinations.openSecret("es-main")).toBe("one");

    await s.exportDestinations.update("es-main", {
      config: { url: "https://other:9200" },
      filter: { models: ["opus"] },
      includeBodies: true,
      secret: "two",
    });
    const changed = await s.exportDestinations.get("es-main");
    expect(changed).toMatchObject({
      config: { url: "https://other:9200" },
      filter: { models: ["opus"] },
      includeBodies: true,
      enabled: false,
      hasSecret: true,
    });
    expect(await s.exportDestinations.openSecret("es-main")).toBe("two");

    const cleared = await s.exportDestinations.update("es-main", {
      secret: null,
      maxRequestBytes: null,
    });
    expect(cleared?.hasSecret).toBe(false);
    expect(cleared?.maxRequestBytes).toBeNull();
    expect(await s.exportDestinations.openSecret("es-main")).toBeNull();
    expect(cleared?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    expect(await s.exportDestinations.update("nope", { enabled: true })).toBeNull();
  });

  test(`at most ${MAX_EXPORT_DESTINATIONS} destinations, refused with a typed error`, async () => {
    const s = await backend.fresh();
    for (let i = 0; i < MAX_EXPORT_DESTINATIONS; i++) {
      await s.exportDestinations.create(input({ id: `d-${i}` }));
    }
    const refused = s.exportDestinations.create(input({ id: "one-too-many" }));
    await expect(refused).rejects.toBeInstanceOf(ExportLimitError);
    expect(await s.exportDestinations.list()).toHaveLength(MAX_EXPORT_DESTINATIONS);
    // Room again once one goes.
    await s.exportDestinations.remove("d-0");
    await s.exportDestinations.create(input({ id: "one-too-many" }));
  });

  test("concurrent creations cannot pass the cap together", async () => {
    const s = await backend.fresh();
    for (let i = 0; i < MAX_EXPORT_DESTINATIONS - 1; i++) {
      await s.exportDestinations.create(input({ id: `d-${i}` }));
    }
    const results = await Promise.allSettled([
      s.exportDestinations.create(input({ id: "race-a" })),
      s.exportDestinations.create(input({ id: "race-b" })),
      s.exportDestinations.create(input({ id: "race-c" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ExportLimitError);
    }
    expect(await s.exportDestinations.list()).toHaveLength(MAX_EXPORT_DESTINATIONS);
  });

  // Postgres alone has `config_version`. Destinations are not routing
  // configuration: a create, edit or delete must not make every replica
  // rebuild its routing snapshot (migration 010 adds no trigger on purpose).
  if (backend.name === "postgres") {
    test("destination writes never move config_version", async () => {
      const s = await backend.fresh();
      const admin = new SQL({ url: process.env.OMNI_TEST_DATABASE_URL as string, max: 1 });
      const version = async () =>
        (await admin.unsafe<Array<{ version: string }>>("SELECT version FROM config_version"))[0]
          ?.version;
      try {
        const before = await version();
        await s.exportDestinations.create(input({ secret: '{"apiKey":"k"}' }));
        await s.exportDestinations.update("es-main", { enabled: false, secret: null });
        await s.exportDestinations.remove("es-main");
        expect(await version()).toBe(before);
      } finally {
        await admin.close();
      }
    });
  }
});
