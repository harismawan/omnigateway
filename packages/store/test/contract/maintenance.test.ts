import { expect, test } from "bun:test";
import { NODE_GRACE_MS } from "../../src/types.ts";
import { forEachStore } from "./harness.ts";

forEachStore((backend) => {
  test("heartbeat upserts this node, nodes lists the live ones newest first, a day forgets", async () => {
    const a = await backend.fresh("node-a");
    const b = await backend.sibling("node-b");
    const t = 1_700_000_000_000;
    await a.maintenance.heartbeat(t);
    await b.maintenance.heartbeat(t + 1);
    await a.maintenance.heartbeat(t + 2);
    expect(await a.maintenance.nodes(t + 2)).toEqual([
      { id: "node-a", seenAt: t + 2 },
      { id: "node-b", seenAt: t + 1 },
    ]);
    expect((await a.maintenance.nodes(t + 1 + NODE_GRACE_MS)).map((n) => n.id)).toEqual(["node-a"]);
    // Past the grace period a node is dead, but its row is kept: absence and
    // staleness are both death, and the row is only ever evidence of life.
    await b.maintenance.heartbeat(t + NODE_GRACE_MS + 5);
    expect((await a.maintenance.nodes(t + 2)).map((n) => n.id)).toContain("node-a");
    // A heartbeat a day later forgets the rows that are stale beyond question.
    await b.maintenance.heartbeat(t + 86_400_001 + 2);
    expect((await a.maintenance.nodes(t + 86_400_001 + 2)).map((n) => n.id)).toEqual(["node-b"]);
  });

  test("stats reports the applied schema version and a non-negative geometry", async () => {
    const s = await backend.fresh();
    const stats = await s.maintenance.stats();
    expect(stats.schemaVersion).toBeGreaterThan(0);
    expect(stats.pageSize).toBeGreaterThan(0);
    expect(stats.pageCount).toBeGreaterThan(0);
    expect(stats.freelistCount).toBeGreaterThanOrEqual(0);
  });

  test("tables accounts for every schema table with its rows, largest first", async () => {
    const s = await backend.fresh();
    await s.config.setAdminPasswordHash("h");
    const tables = await s.maintenance.tables();
    const names = tables.map((t) => t.name);
    expect(names).toContain("migrations");
    expect(names).toContain("request_logs");
    expect(names.some((n) => n.startsWith("sqlite_"))).toBe(false);
    for (const t of tables) expect(t.bytes).toBeGreaterThan(0);
    expect(tables.map((t) => t.bytes)).toEqual(
      [...tables].map((t) => t.bytes).sort((a, b) => b - a),
    );
    // Row counts are exact on SQLite and planner estimates on Postgres, which
    // only ANALYZE refreshes — so the exact figure is pinned on one backend
    // and the shape on the other.
    const migrations = tables.find((t) => t.name === "migrations");
    expect(migrations?.rows).toBeGreaterThanOrEqual(0);
    if (backend.name === "sqlite") {
      expect(migrations?.deadRows).toBeNull();
      // Ten heartbeats of one node is one row, and an estimate could say otherwise.
      for (let i = 0; i < 10; i++) await s.maintenance.heartbeat(i);
      expect((await s.maintenance.tables()).find((t) => t.name === "nodes")?.rows).toBe(1);
    } else {
      expect(migrations?.deadRows).toBeGreaterThanOrEqual(0);
    }
  });

  test("databasePath names the store without its password, and reopen keeps it serving", async () => {
    const s = await backend.fresh();
    expect(s.databasePath).not.toContain(":omni@");
    if (backend.name === "postgres") expect(s.databasePath).toContain("***");
    await s.config.setAdminPasswordHash("h");
    await s.reopen();
    expect(await s.config.getAdminPasswordHash()).toBe("h");
    if (backend.name === "postgres") {
      await expect(s.maintenance.vacuum()).rejects.toThrow("use pg_dump");
      await expect(s.maintenance.snapshotTo("/tmp/x")).rejects.toThrow("use pg_dump");
      await expect(s.maintenance.inspect("/tmp/x")).rejects.toThrow("use pg_dump");
    }
  });
});
