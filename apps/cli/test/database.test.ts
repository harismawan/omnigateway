import { expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseOverview, SnapshotInfo } from "@omni/control";
import { requestLog } from "@omni/testkit";
import { previewTable } from "../src/commands/db.ts";
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

  // The per-table listing is what the whole-file walk behind it pays for.
  const human = await cli(["db", "stats"], { root });
  expect(human.code).toBe(0);
  expect(human.out).toContain("write-ahead log");
  expect(human.out).toMatch(/^request_logs\s+[\d.]+ KB\s+0$/m);
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
 * The confirmation has to be informed in the default flow, not only under a flag.
 *
 * The operator judging blast radius from an id and an mtime is the gap this
 * closes, so the counts have to be in front of them *before* the question — and
 * on stderr, beside the prompt, so `--json` on stdout stays parseable.
 */
test("db restore shows what each side holds before it asks", async () => {
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
  // One key in the snapshot against two live: the two columns must not be the
  // same column, which a fixture with equal counts could not tell.
  expect(result.err).toContain("api_keys");
  expect(result.err).toContain("SNAPSHOT");
  expect(result.err).toContain("LIVE");
  const table = result.err.split("\n").find((line) => line.startsWith("api_keys")) ?? "";
  expect(table.split(/\s+/).slice(1, 3)).toEqual(["1", "2"]);
  // That the table is here at all is the ordering proof for *this* path: the
  // operator said no, so nothing after the prompt ran. It is only half the
  // property, though — printing the table inside the refusal branch alone would
  // satisfy it while leaving every `--yes` run uninformed, which is the case the
  // feature exists for. The test below is the other half.
  expect(asked).toHaveLength(1);
});

test("db restore shows the same table when the operator says yes", async () => {
  const root = await installation();
  const service = fakeService({ root });

  await cli(["keys", "create", "--label", "before", "--json"], { root, service });
  const created = await cli(["db", "backup", "--json"], { root, service });
  const snapshot = JSON.parse(created.out) as SnapshotInfo;
  await cli(["keys", "create", "--label", "after", "--json"], { root, service });

  // `--json` as well, because the counts used to go through `note` — which is
  // `if (!ctx.json)` — so under `--json` they did not move to stderr, they
  // vanished, and the scripted path asked nothing and reported nothing.
  const result = await cli(["db", "restore", snapshot.id, "--yes", "--json"], { root, service });

  expect(result.code).toBe(0);
  expect(result.err).toContain("api_keys");
  expect(result.err).toContain("SNAPSHOT");
  // stdout stays a single parseable value.
  expect(() => JSON.parse(result.out)).not.toThrow();
});

test("db restore --dry-run prints the same table, asks nothing, and changes nothing", async () => {
  const root = await installation();
  const service = fakeService({ root });

  await cli(["keys", "create", "--label", "before", "--json"], { root, service });
  const created = await cli(["db", "backup", "--json"], { root, service });
  const snapshot = JSON.parse(created.out) as SnapshotInfo;
  await cli(["keys", "create", "--label", "after", "--json"], { root, service });

  const asked: string[] = [];
  const result = await cli(["db", "restore", snapshot.id, "--dry-run"], {
    root,
    service,
    prompt: refuses(asked),
  });

  expect(result.code).toBe(0);
  expect(result.out).toContain("api_keys");
  expect(asked).toEqual([]);
  expect(await keyLabels(root, service)).toEqual(["after", "before"]);

  // No undo snapshot, and no working copy: a dry run that leaves a
  // database-sized file beside the live one is a dry run only in name.
  const listed = await cli(["db", "snapshots", "--json"], { root, service });
  const body = JSON.parse(listed.out) as { snapshots: SnapshotInfo[] };
  expect(body.snapshots.map((s) => s.reason)).toEqual(["manual"]);
  // The listing, not one guessed filename: a preview that left a working copy
  // under any other name would satisfy a check for `.incoming` alone.
  expect(readdirSync(root).filter((name) => name.startsWith("omnigateway.db"))).toEqual([
    "omnigateway.db",
  ]);
});

test("db restore --dry-run --json carries both sides", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const created = await cli(["db", "backup", "--json"], { root, service });
  const snapshot = JSON.parse(created.out) as SnapshotInfo;

  const result = await cli(["db", "restore", snapshot.id, "--dry-run", "--json"], {
    root,
    service,
  });

  expect(result.code).toBe(0);
  const body = JSON.parse(result.out) as {
    snapshot: Record<string, number>;
    live: Record<string, number> | null;
  };
  // Both sides answered, and the live one is a reading rather than a silence.
  expect(Object.keys(body.snapshot)).toContain("api_keys");
  expect(body.live).not.toBeNull();
  expect(Object.keys(body.live ?? {})).toContain("api_keys");
  // The id rides the payload: a script capturing this has nothing else to
  // correlate the two columns with.
  expect((body as { id?: string }).id).toBe(snapshot.id);
});

/**
 * The refusal is about who may open the file, not about what happens after, so
 * it covers the preview too: a dry run that sometimes lies about openability is
 * worse than one that makes the operator stop the gateway first.
 */
test("db restore --dry-run refuses while a gateway is running, like the real thing", async () => {
  const root = await installation();
  const stopped = fakeService({ root });

  const created = await cli(["db", "backup", "--json"], { root, service: stopped });
  const snapshot = JSON.parse(created.out) as SnapshotInfo;

  const running = fakeService({ root, pid: 99, alivePids: new Set([99]) });
  writeFileSync(pidFile(running.deps.stateDir), "99\n");

  const result = await cli(["db", "restore", snapshot.id, "--dry-run"], {
    root,
    service: running,
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain("omni stop");
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

/**
 * The two rendering branches no CLI fixture can reach.
 *
 * Every snapshot a test takes is a `db backup` of the live database, so both
 * sides always hold the same tables and the live side is always readable. Both
 * branches are operator-facing all the same: `—` is a stated requirement of the
 * preview, and the null sentence is the entire reason the control layer models
 * an unreadable live database as `null` instead of `{}`.
 */
test("previewTable renders a table only one side has as absent, not as zero", () => {
  const rendered = previewTable({
    snapshot: { api_keys: 3, request_logs: 12 },
    live: { api_keys: 3, credentials: 2 },
  });

  const row = (name: string) =>
    (rendered.split("\n").find((line) => line.startsWith(name)) ?? "").split(/\s+/).slice(1, 3);

  // Absent is not empty: "the snapshot has no credentials table at all" and
  // "the snapshot has an empty one" are different facts, and 0 reads as the
  // second.
  expect(row("request_logs")).toEqual(["12", "—"]);
  expect(row("credentials")).toEqual(["—", "2"]);
  expect(rendered).not.toContain("could not be read");
});

test("previewTable says the live side is unknown rather than drawing it empty", () => {
  const rendered = previewTable({ snapshot: { api_keys: 3 }, live: null });

  // A column of dashes alone would read as "the restore adds all of this",
  // which is a claim about the live side that nothing knows to be true.
  expect(rendered).toContain("the live database could not be read");
  expect((rendered.split("\n").find((l) => l.startsWith("api_keys")) ?? "").split(/\s+/)[1]).toBe(
    "3",
  );
});
