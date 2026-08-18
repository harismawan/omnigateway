import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseOverview, SnapshotInfo } from "@omni/control";
import { requestLog } from "@omni/testkit";
import type { Prompt } from "../src/prompt.ts";
import { pidFile } from "../src/service.ts";
import { cli, type FakeService, fakeService, makeRoot, openStore } from "./helpers/harness.ts";

/** Every test starts from a migrated, empty installation. */
async function installation(): Promise<string> {
  const root = makeRoot();
  expect((await cli(["db", "migrate"], { root })).code).toBe(0);
  return root;
}

test("db stats reports the database the CLI resolved, not a guess at one", async () => {
  const root = await installation();

  const result = await cli(["db", "stats", "--json"], { root });
  expect(result.code).toBe(0);

  const body = JSON.parse(result.out) as DatabaseOverview;
  expect(body.fileBytes).toBeGreaterThan(0);
  expect(body.logicalBytes).toBe(body.stats.pageSize * body.stats.pageCount);
  // A migrated installation has a schema, and no snapshots until one is taken.
  expect(body.stats.schemaVersion).toBeGreaterThan(0);
  expect(body.snapshots.count).toBe(0);
});

/**
 * A backup is only a backup once it is a file, so both halves are asserted: the
 * command's own report, and the snapshot listing an independent invocation
 * reads back off the disk.
 */
test("db backup writes a snapshot beside the database, and db snapshots lists it", async () => {
  const root = await installation();

  const created = await cli(["db", "backup", "--json"], { root });
  expect(created.code).toBe(0);
  const snapshot = JSON.parse(created.out) as SnapshotInfo;
  expect(snapshot.reason).toBe("manual");
  expect(snapshot.sizeBytes).toBeGreaterThan(0);
  expect(existsSync(join(root, "snapshots", snapshot.filename))).toBe(true);

  const listed = await cli(["db", "snapshots", "--json"], { root });
  expect(listed.code).toBe(0);
  const body = JSON.parse(listed.out) as { snapshots: SnapshotInfo[] };
  expect(body.snapshots).toHaveLength(1);
  expect(body.snapshots[0]?.id).toBe(snapshot.id);

  const human = await cli(["db", "snapshots"], { root });
  expect(human.out).toContain(snapshot.id);
});

/**
 * A vacuum that reports a number nobody can check is indistinguishable from one
 * that did nothing, so this arranges pages to reclaim: rows written, then
 * pruned, which is exactly what the hourly maintenance sweep leaves behind.
 */
test("db vacuum reclaims the free pages that pruning left behind", async () => {
  const root = await installation();

  const store = await openStore(root);
  try {
    for (let index = 0; index < 400; index++) {
      await store.usage.append(requestLog({ id: `req_${index}`, at: 1_000 }));
    }
    expect(await store.usage.prune(2_000)).toBe(400);
  } finally {
    store.close();
  }

  const before = JSON.parse(
    (await cli(["db", "stats", "--json"], { root })).out,
  ) as DatabaseOverview;
  expect(before.freePageBytes).toBeGreaterThan(0);

  const result = await cli(["db", "vacuum", "--json"], { root });
  expect(result.code).toBe(0);
  const vacuumed = JSON.parse(result.out) as { reclaimedBytes: number; durationMs: number };
  expect(vacuumed).toHaveProperty("reclaimedBytes");

  // Asserted on the file and on SQLite's own count rather than on the figure
  // the command reported: `reclaimedBytes` is measured while the handle is
  // still open, and in WAL mode the rewritten file does not shrink until the
  // log is checkpointed, so it reads 0 here while 48 KB really did come back.
  const after = JSON.parse(
    (await cli(["db", "stats", "--json"], { root })).out,
  ) as DatabaseOverview;
  expect(after.freePageBytes).toBe(0);
  expect(after.fileBytes).toBeLessThan(before.fileBytes);
});

/** The label of every key in the installation, which is what a restore moves. */
async function keyLabels(root: string, service: FakeService): Promise<string[]> {
  const listed = await cli(["keys", "list", "--json"], { root, service });
  expect(listed.code).toBe(0);
  const body = JSON.parse(listed.out) as { keys: Array<{ label: string }> };
  return body.keys.map((key) => key.label);
}

/**
 * The whole point of the command, asserted on content rather than on a message.
 *
 * A key created after the snapshot has to be gone afterwards, and one created
 * before it has to be back: either half alone passes against a restore that did
 * nothing at all.
 */
test("db restore puts the snapshot's contents back", async () => {
  const root = await installation();
  const service = fakeService({ root });

  await cli(["keys", "create", "--label", "before", "--json"], { root, service });
  const created = await cli(["db", "backup", "--json"], { root, service });
  const snapshot = JSON.parse(created.out) as SnapshotInfo;
  await cli(["keys", "create", "--label", "after", "--json"], { root, service });
  expect(await keyLabels(root, service)).toEqual(["after", "before"]);

  const restored = await cli(["db", "restore", snapshot.id, "--yes", "--json"], { root, service });
  expect(restored.code).toBe(0);
  expect(await keyLabels(root, service)).toEqual(["before"]);

  // The undo for the restore itself, and the restored snapshot both.
  const listed = await cli(["db", "snapshots", "--json"], { root, service });
  const body = JSON.parse(listed.out) as { snapshots: SnapshotInfo[] };
  expect(body.snapshots.map((s) => s.reason).sort()).toEqual(["manual", "preRestore"]);
});

/** A prompt that says no, and remembers what it was asked. */
function refuses(asked: string[]): Prompt {
  return {
    isTty: true,
    input: async () => "",
    secret: async () => "",
    confirm: async (question) => {
      asked.push(question);
      return false;
    },
  };
}

/**
 * The gate, asserted on what did not happen.
 *
 * A refusal that still wrote the pre-restore snapshot would mean the question
 * was asked after the operation had begun, so the snapshots directory is
 * checked as well as the rows: this command is the one thing in the CLI that
 * cannot be undone by re-running it.
 */
test("db restore asks before replacing anything, and a no leaves the database alone", async () => {
  const root = await installation();
  const service = fakeService({ root });

  await cli(["keys", "create", "--label", "before", "--json"], { root, service });
  const created = await cli(["db", "backup", "--json"], { root, service });
  const snapshot = JSON.parse(created.out) as SnapshotInfo;
  await cli(["keys", "create", "--label", "after", "--json"], { root, service });

  const asked: string[] = [];
  const result = await cli(["db", "restore", snapshot.id], {
    root,
    service,
    prompt: refuses(asked),
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain("cancelled");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(snapshot.id);
  expect(await keyLabels(root, service)).toEqual(["after", "before"]);

  const listed = await cli(["db", "snapshots", "--json"], { root, service });
  const body = JSON.parse(listed.out) as { snapshots: SnapshotInfo[] };
  expect(body.snapshots.map((s) => s.reason)).toEqual(["manual"]);
});

/**
 * The dashboard restores under a latch that holds `/v1` off and swaps inside the
 * process that owns the handle. The CLI is a second process and has neither, so
 * a restore here would move the file out from under a gateway that is still
 * writing to it. It refuses, with `--yes` given, before it asks anything.
 */
test("db restore refuses while a gateway is running against that database", async () => {
  const root = await installation();
  const stopped = fakeService({ root });

  await cli(["keys", "create", "--label", "before", "--json"], { root, service: stopped });
  const created = await cli(["db", "backup", "--json"], { root, service: stopped });
  const snapshot = JSON.parse(created.out) as SnapshotInfo;
  await cli(["keys", "create", "--label", "after", "--json"], { root, service: stopped });

  const running = fakeService({ root, pid: 99, alivePids: new Set([99]) });
  writeFileSync(pidFile(running.deps.stateDir), "99\n");

  const asked: string[] = [];
  const result = await cli(["db", "restore", snapshot.id, "--yes"], {
    root,
    service: running,
    prompt: refuses(asked),
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain("running");
  expect(result.err).toContain("omni stop");
  // Not even asked: there is no answer that would make this safe.
  expect(asked).toEqual([]);
  expect(await keyLabels(root, stopped)).toEqual(["after", "before"]);

  const listed = await cli(["db", "snapshots", "--json"], { root, service: stopped });
  const body = JSON.parse(listed.out) as { snapshots: SnapshotInfo[] };
  expect(body.snapshots.map((s) => s.reason)).toEqual(["manual"]);
});

/**
 * The id is a filename the caller supplies and the control package turns into a
 * path, so the CLI is one of the two doors in front of that check. Both refusals
 * have to arrive as errors an operator can read, not as a stack.
 */
test("db restore refuses an id that is not a snapshot of this installation", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const traversal = await cli(["db", "restore", "../omnigateway.db", "--yes"], { root, service });
  expect(traversal.code).toBe(1);
  expect(traversal.err).toContain("invalid snapshot id");

  const absent = await cli(
    ["db", "restore", "db_2026-08-18T04-12-03-114Z_manual.sqlite", "--yes"],
    { root, service },
  );
  expect(absent.code).toBe(1);
  expect(absent.err).toContain("no such snapshot");

  const missing = await cli(["db", "restore"], { root, service });
  expect(missing.code).toBe(2);
  expect(missing.err).toContain("usage: omni db restore <id>");
});

/**
 * The rendering an operator actually sees.
 *
 * `--json` and the human form are two separate code paths through `emit`, and
 * every assertion above reads the first one; a `fields` call that threw would
 * leave all of them green and every real invocation broken.
 */
test("each command renders for a terminal as well as for a script", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const stats = await cli(["db", "stats"], { root, service });
  expect(stats.code).toBe(0);
  expect(stats.out).toContain("free pages");
  expect(stats.out).toContain("never snapshotted");

  const empty = await cli(["db", "snapshots"], { root, service });
  expect(empty.out).toContain("no snapshots in");

  const backup = await cli(["db", "backup"], { root, service });
  expect(backup.code).toBe(0);
  expect(backup.out).toContain("snapshot");
  // The one warning that has to reach a human before they copy the file.
  expect(backup.err).toContain("encrypted credentials");

  const vacuumed = await cli(["db", "vacuum"], { root, service });
  expect(vacuumed.code).toBe(0);
  expect(vacuumed.out).toContain("reclaimed");

  const id = (
    JSON.parse((await cli(["db", "snapshots", "--json"], { root, service })).out) as {
      snapshots: SnapshotInfo[];
    }
  ).snapshots[0]?.id;
  const restored = await cli(["db", "restore", id ?? "", "--yes"], { root, service });
  expect(restored.code).toBe(0);
  expect(restored.out).toContain("undo");
  expect(restored.out).toContain("api_keys");
});
