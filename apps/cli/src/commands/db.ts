import { existsSync } from "node:fs";
import {
  createSnapshot,
  type DatabaseDeps,
  getDatabaseOverview,
  listSnapshots,
  nodeDatabaseFs,
  restoreSnapshot,
  snapshotsDir,
  vacuum,
} from "@omni/control";
import { requirePositional } from "../args.ts";
import type { Command, CommandEnv } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, formatBytes, formatTime, note, table } from "../output.ts";
import { status as serviceStatus } from "../service.ts";

/**
 * The database operations, pointed at the installation this invocation resolved.
 *
 * `ctx.store()` rather than a path the command works out for itself: the store
 * carries the path it was opened at, and it is the object the swap in a restore
 * closes and reopens. Everything filesystem-shaped comes from `@omni/control`'s
 * own adapter, which is the same one the gateway hands these operations.
 */
async function database(env: CommandEnv): Promise<DatabaseDeps> {
  return { store: await env.ctx.store(), fs: nodeDatabaseFs(), now: env.ctx.now };
}

export const dbMigrate: Command = {
  usage: "db migrate",
  summary: "Create or upgrade the database schema",
  async run(_args, { ctx, writer }) {
    const existed = existsSync(ctx.databasePath);
    // Opening the store runs every pending migration; there is no second code
    // path for it, which is what keeps the CLI and the gateway in step.
    const store = await ctx.store();
    await store.config.getSettings();

    emit(ctx, writer, { path: ctx.databasePath, created: !existed }, () =>
      fields([
        ["database", ctx.databasePath],
        ["schema", existed ? "up to date" : "created"],
      ]),
    );
  },
};

export const dbStats: Command = {
  usage: "db stats",
  summary: "Show database size, free pages, and what snapshots are held",
  async run(_args, env) {
    const { ctx, writer } = env;
    const overview = await getDatabaseOverview(await database(env));

    emit(ctx, writer, overview, () =>
      fields([
        ["database", ctx.databasePath],
        ["size", formatBytes(overview.fileBytes)],
        ["write-ahead log", formatBytes(overview.walBytes)],
        // Named as excluded here rather than only in the docs: this figure is
        // part of what the installation occupies, and none of it is in a
        // snapshot.
        ["captured bodies", `${formatBytes(overview.bodiesBytes)} (never snapshotted)`],
        ["free pages", `${formatBytes(overview.freePageBytes)} — reclaimed by omni db vacuum`],
        ["schema version", String(overview.stats.schemaVersion)],
        [
          "snapshots",
          `${overview.snapshots.count} (${formatBytes(overview.snapshots.totalBytes)}), latest ${formatTime(overview.snapshots.latestAt)}`,
        ],
        [
          "retention",
          `keep ${overview.retention.keepLatest}, up to ${overview.retention.maxAgeDays} days`,
        ],
        [
          "free disk",
          overview.freeDiskBytes === null ? "unknown" : formatBytes(overview.freeDiskBytes),
        ],
      ]),
    );
  },
};

export const dbSnapshots: Command = {
  usage: "db snapshots",
  summary: "List the snapshots held for this installation",
  async run(_args, env) {
    const { ctx, writer } = env;
    const deps = await database(env);
    const snapshots = listSnapshots(deps);

    emit(ctx, writer, { snapshots }, () => {
      if (snapshots.length === 0) {
        return `no snapshots in ${snapshotsDir(deps)}; take one with omni db backup`;
      }
      return table(
        [
          { header: "ID" },
          { header: "TAKEN" },
          { header: "SIZE", align: "right" },
          { header: "REASON" },
        ],
        snapshots.map((snapshot) => [
          snapshot.id,
          formatTime(snapshot.createdAt),
          formatBytes(snapshot.sizeBytes),
          snapshot.reason,
        ]),
      );
    });
  },
};

export const dbBackup: Command = {
  usage: "db backup",
  summary: "Take a snapshot of the database, pruning by the retention policy",
  /**
   * Safe against a running gateway, unlike `db restore`.
   *
   * `VACUUM INTO` reads through SQLite rather than copying the file, so a
   * gateway writing to the same database produces a consistent snapshot rather
   * than a torn one, and the write-ahead log is folded in by definition.
   */
  async run(_args, env) {
    const { ctx, writer } = env;
    const snapshot = await createSnapshot(await database(env), { reason: "manual" });

    emit(ctx, writer, snapshot, () => {
      // Said every time, because the operator most likely to read it is the one
      // about to copy this file somewhere else.
      note(
        ctx,
        writer,
        "a snapshot carries encrypted credentials and key hashes; captured bodies are not in it",
      );
      return fields([
        ["snapshot", snapshot.id],
        ["size", formatBytes(snapshot.sizeBytes)],
        ["taken", formatTime(snapshot.createdAt)],
      ]);
    });
  },
};

export const dbVacuum: Command = {
  usage: "db vacuum",
  summary: "Rewrite the database, reclaiming the pages deletion left free",
  /**
   * Blocking, and deliberately not gated on the gateway being stopped.
   *
   * A vacuum holds SQLite's write lock for as long as it takes to rewrite the
   * file, so a busy gateway will stall on its writes — but it is an ordinary
   * transaction, not a file swap, and nothing is lost by running it live. The
   * warning goes to stderr so `--json` stays a clean parse.
   */
  async run(_args, env) {
    const { ctx, writer } = env;
    note(ctx, writer, "compacting; the gateway's writes will block until this finishes…");
    const result = await vacuum(await database(env));

    emit(ctx, writer, result, () =>
      fields([
        ["reclaimed", formatBytes(result.reclaimedBytes)],
        ["took", `${result.durationMs} ms`],
      ]),
    );
  },
};

export const dbRestore: Command = {
  usage: "db restore <id>",
  summary: "Replace the database with a snapshot, keeping a copy of what was there",
  /**
   * Refuses while a gateway is running, and asks even when it is not.
   *
   * The dashboard can restore a live installation because the swap happens
   * inside the process that owns the handle: it closes a latch over `/v1`,
   * drains what is in flight, replaces the file, and reopens the same store
   * object every holder is pointing at. This is a second process. It can close
   * and reopen its own handle, but it cannot quiesce the gateway's, and moving
   * the file out from under a running SQLite connection is how a restore turns
   * into corruption — of the database the operator was trying to rescue.
   *
   * So it is a refusal rather than a warning, and there is no flag to override
   * it: the two ways through are stopping the gateway, which the message names,
   * and the dashboard, which is built for the live case.
   */
  async run(args, env) {
    const { ctx, writer, prompt } = env;
    const id = requirePositional(args, 0, "snapshot id");

    const running = await serviceStatus(env.service());
    if (running.running) {
      const who =
        running.pid === null ? running.supervisor : `${running.supervisor}, pid ${running.pid}`;
      throw new CliError(
        `a gateway is running (${who}) against this installation; run omni stop first, ` +
          "or restore from the dashboard, which swaps the file behind its own quiesce latch",
      );
    }

    // Asked before anything is opened, validated, or copied. Everything this
    // command does after the question is irreversible from where the operator
    // stands: the rows that are there now are gone, and the only way back is a
    // second restore of the copy it takes on the way in. `--yes` answers it,
    // which is also what makes the command usable from a script.
    if (!(await prompt.confirm(`replace ${ctx.databasePath} with ${id}?`))) {
      throw new CliError("cancelled");
    }

    const result = await restoreSnapshot(await database(env), id);

    emit(ctx, writer, result, () =>
      fields([
        ["restored", id],
        ["undo", result.preRestoreSnapshot.id],
        ...Object.entries(result.counts).map(
          ([table, count]) => [table, String(count)] as [string, string],
        ),
      ]),
    );
  },
};
