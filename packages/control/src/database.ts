import { basename, dirname, join, resolve } from "node:path";
import { describeError, GatewayError, type Logger, noopLogger } from "@omni/ir";
import {
  bodiesDirFor,
  type DatabaseInspection,
  type DatabaseStats,
  type MaintenanceRepo,
  type Settings,
  type Store,
  type TableStats,
} from "@omni/store";
import { parseOrThrow, retentionSchema } from "./schemas.ts";

/**
 * The one whole-database operation allowed at a time, or null.
 *
 * Vacuum, snapshot, restore and import each hold SQLite's write lock or replace
 * the file underneath it, so running two is at best a stall and at worst a
 * restore racing the snapshot meant to undo it. Process-local, like the rate
 * limits and quota cooldowns: an installation is one process, and a lock that
 * outlived a crash would need releasing by hand.
 */
let exclusive: string | null = null;

async function withExclusive<T>(label: string, operation: () => Promise<T>): Promise<T> {
  if (exclusive !== null) {
    throw new GatewayError("CONFLICT", `${exclusive} is already running on this database`);
  }
  exclusive = label;
  try {
    return await operation();
  } finally {
    exclusive = null;
  }
}

/**
 * The same lock, for a caller that would rather step aside than fail.
 *
 * The maintenance sweep is the one: it runs hourly, it has nothing to say about
 * a restore in progress, and an error every time the two coincided would be an
 * error about a condition that resolves itself before the next tick. Returns
 * null when the lock was busy, which is distinguishable from any result an
 * operation here returns.
 */
async function withExclusiveOrSkip<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T | null> {
  if (exclusive !== null) return null;
  exclusive = label;
  try {
    return await operation();
  } finally {
    exclusive = null;
  }
}

/** Where snapshots live: one directory beside the database, as bodies do. */
export const SNAPSHOTS_DIRNAME = "snapshots";

/**
 * Why a snapshot exists, and the last segment of its name.
 *
 * A closed set because it is part of the filename, which is parsed back: an
 * arbitrary caller-supplied reason would be a caller-supplied path segment.
 */
export type SnapshotReason = "manual" | "preRestore";

/**
 * Only the parts of `Store` this module uses.
 *
 * A structural subset rather than `Store` itself so a test can build one out of
 * closures; a real store satisfies it without being told to.
 */
export type DatabaseStore = {
  engine: Store["engine"];
  databasePath: string;
  config: {
    getSettings(): Promise<Settings>;
    putSettings(patch: Partial<Settings>): Promise<Settings>;
    getAdminPasswordHash(): Promise<string | null>;
    getViewerPasswordHash(): Promise<string | null>;
  };
  /** The one derived table a swap has to put back in step with its rows. */
  usage: { rebuildRollup(): Promise<void> };
  maintenance: MaintenanceRepo;
  reopen(): Promise<void>;
  close(): void;
};

export type DatabaseDeps = {
  store: DatabaseStore;
  fs: {
    /** Entry names, not paths. An absent directory reads as empty, not as an error. */
    readdir: (dir: string) => readonly string[];
    stat: (path: string) => { size: number; mtimeMs: number } | null;
    /** Removing a path that is not there is a no-op, not a failure. */
    unlink: (path: string) => void;
    rename: (from: string, to: string) => void;
    copyFile: (from: string, to: string) => void;
    /** Creates a directory and its parents; an existing one is fine. */
    mkdir: (dir: string) => void;
    /** Every symlink resolved, or null when the path is not there. */
    realpath: (path: string) => string | null;
    /** Free space on the filesystem holding `dir`, or null when unknowable. */
    freeBytes: (dir: string) => number | null;
    /** Recursive size of a directory tree. Zero when it does not exist. */
    dirBytes: (dir: string) => number;
  };
  now: () => number;
  /**
   * Re-applies the schema of whatever plugins the caller currently has loaded.
   *
   * Optional, and injected rather than reached for, because `@omni/control`
   * knows nothing about callers: a CLI restore has no loaded plugins and passes
   * nothing, while a gateway does and passes a closure over them.
   *
   * A restored database is any database. One taken before a plugin was installed
   * does not carry that plugin's tables, and the plugin is still loaded and still
   * holding a context whose every query would throw "no such table" until someone
   * restarted the process. Re-applying is cheap — each plugin's ledger is
   * consulted and already-applied versions are skipped — and it is the same
   * decision the rollup rebuild makes: recompute rather than trust the
   * provenance of a file an operator handed over.
   */
  reapplyPluginSchema?: () => Promise<void>;
  /**
   * Where a degraded step reports itself. Optional, and `noopLogger` when a
   * caller has nothing to log to — a CLI restore is still a restore.
   */
  logger?: Logger;
};

export type SnapshotInfo = {
  /** The filename. A snapshot has no identity apart from the file it is. */
  id: string;
  filename: string;
  createdAt: number;
  sizeBytes: number;
  reason: string;
};

export function snapshotsDir(deps: DatabaseDeps): string {
  return join(dirname(deps.store.databasePath), SNAPSHOTS_DIRNAME);
}

/**
 * `db_<instant>_<reason>.sqlite`, with the instant's `:` and `.` replaced.
 *
 * Both characters are legal in a POSIX filename and neither is on Windows, and a
 * colon in a downloaded filename is exactly the kind of thing an operator's
 * browser mangles silently. The instant stays sortable and stays parseable.
 */
function snapshotName(at: number, reason: SnapshotReason): string {
  const stamp = new Date(at).toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `db_${stamp}_${reason}.sqlite`;
}

/**
 * The only names this module will treat as a snapshot.
 *
 * Anchored, exact, and with no separator anywhere in it, because the id arrives
 * from a caller and becomes a path. Everything else in the directory — an
 * operator's own copy, a half-written temp file — is not ours to list or delete.
 */
const SNAPSHOT_ID = /^db_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([A-Za-z]+)\.sqlite$/;

/** The name back into the pieces it was made of, or null when it is not one. */
function parseSnapshotName(name: string): { at: number; reason: string } | null {
  const match = SNAPSHOT_ID.exec(name);
  if (match === null) return null;
  const [, date, hh, mm, ss, ms, reason] = match;
  const at = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  if (Number.isNaN(at) || reason === undefined) return null;
  return { at, reason };
}

/**
 * The path a snapshot id names, or a refusal.
 *
 * Two checks, and both are load-bearing. The pattern rejects the id itself,
 * which is where `..`, a separator, and an absolute path die. The containment
 * assertion then re-derives the answer from the resolved path, so a future
 * loosening of the pattern — a reason with a dot in it, say — cannot quietly
 * become a way to name the live database, which is one `..` away from here.
 *
 * Neither is enough on its own, and neither sees a symlink: `resolve` collapses
 * `..` textually and stops there, so a link inside the snapshots directory
 * names a path that is contained on paper and is not on disk. The third check
 * asks the filesystem where both really are — the same `realpathSync`
 * containment the static file route uses in `app.ts`, for the same reason.
 * A directory that is itself a link is fine; a file that leaves it is not.
 */
function snapshotPath(deps: DatabaseDeps, id: string): string {
  const dir = resolve(snapshotsDir(deps));
  const path = resolve(dir, id);
  if (parseSnapshotName(id) === null || dirname(path) !== dir) {
    throw new GatewayError("BAD_REQUEST", "invalid snapshot id");
  }

  // A path that does not resolve does not exist yet, and the callers that care
  // report that themselves. Nothing to contain until there is.
  const real = deps.fs.realpath(path);
  if (real !== null && dirname(real) !== (deps.fs.realpath(dir) ?? dir)) {
    throw new GatewayError("BAD_REQUEST", "invalid snapshot id");
  }
  return path;
}

/**
 * Where a snapshot is, for a caller that will stream it.
 *
 * Returns the path rather than the bytes: control does not know whether the
 * caller is an HTTP response or a CLI copy, and neither should hold a whole
 * database in memory to find out.
 */
export function resolveSnapshotForDownload(
  deps: DatabaseDeps,
  id: string,
): { path: string; filename: string; sizeBytes: number } {
  const path = snapshotPath(deps, id);
  const stat = deps.fs.stat(path);
  if (stat === null) throw new GatewayError("BAD_REQUEST", "no such snapshot");
  return { path, filename: id, sizeBytes: stat.size };
}

export function deleteSnapshot(deps: DatabaseDeps, id: string): void {
  const path = snapshotPath(deps, id);
  if (deps.fs.stat(path) === null) throw new GatewayError("BAD_REQUEST", "no such snapshot");
  deps.fs.unlink(path);
}

/**
 * Every snapshot on disk, newest first.
 *
 * The name is authoritative for the instant rather than the file's mtime: a
 * snapshot that was copied, restored from a tarball, or synced to another host
 * keeps the instant it was taken, and mtime does not.
 */
export function listSnapshots(deps: DatabaseDeps): SnapshotInfo[] {
  const dir = snapshotsDir(deps);
  const snapshots: SnapshotInfo[] = [];
  for (const name of deps.fs.readdir(dir)) {
    const parsed = parseSnapshotName(name);
    if (parsed === null) continue;
    snapshots.push({
      id: name,
      filename: name,
      createdAt: parsed.at,
      sizeBytes: deps.fs.stat(join(dir, name))?.size ?? 0,
      reason: parsed.reason,
    });
  }
  return snapshots.sort((a, b) => b.createdAt - a.createdAt);
}

export type RetentionPolicy = {
  /** How many snapshots survive regardless of age. Never zero. */
  keepLatest: number;
  maxAgeDays: number;
};

const DAY_MS = 86_400_000;

/**
 * Room to demand before writing a copy of the database.
 *
 * `VACUUM INTO` writes a compacted copy, so the live file is an upper bound and
 * a little over it is honest headroom. Filling the filesystem an installation is
 * running on is a worse outcome than a refused backup, and it is the failure a
 * scheduled snapshot would keep repeating.
 *
 * Exported because a caller staging an import has to reserve the same room for
 * the undo snapshot that import is about to take, and two spellings of one
 * headroom is a budget that does not add up.
 */
export const SNAPSHOT_HEADROOM = 1.1;

function retentionOf(settings: Settings): RetentionPolicy {
  return { keepLatest: settings.snapshotKeepLatest, maxAgeDays: settings.snapshotMaxAgeDays };
}

/**
 * Deletes what the policy no longer covers.
 *
 * Both bounds are enforced, not either: a count bound alone leaves a year of
 * stale copies on a quiet installation, and an age bound alone leaves however
 * many an operator can click in a day. The newest is always kept whatever the
 * numbers say, because an installation with no snapshot at all is the state
 * retention exists to prevent rather than to cause.
 */
function applyRetention(deps: DatabaseDeps, policy: RetentionPolicy, now: number): number {
  const dir = snapshotsDir(deps);
  const cutoff = now - policy.maxAgeDays * DAY_MS;
  const snapshots = listSnapshots(deps);
  // The only undo there is for the restore it preceded, and `force` only kept
  // it alive while it was being written. Ordinary housekeeping running an hour
  // or five manual snapshots later must not be what deletes it.
  const undo = snapshots.find((snapshot) => snapshot.reason === "preRestore")?.id;

  let removed = 0;
  snapshots.forEach((snapshot, index) => {
    if (index === 0) return;
    if (snapshot.id === undo) return;
    if (index < policy.keepLatest && snapshot.createdAt >= cutoff) return;
    deps.fs.unlink(join(dir, snapshot.id));
    removed++;
  });
  return removed;
}

/**
 * Retention on a schedule, rather than only on the way out of a create.
 *
 * Called from the create path *and* from the maintenance sweep, because
 * otherwise neither bound is real: `maxAgeDays` expires nothing on an
 * installation that has stopped taking snapshots, and a lowered `keepLatest`
 * prunes nothing until somebody happens to take another one. The policy an
 * operator saved has to run whether or not they come back.
 */
export async function pruneSnapshots(deps: DatabaseDeps): Promise<number> {
  const removed = await withExclusiveOrSkip("a snapshot sweep", async () =>
    applyRetention(deps, retentionOf(await deps.store.config.getSettings()), deps.now()),
  );
  return removed ?? 0;
}

/** The prefix a streamed import is staged under, before it is anything else. */
const IMPORT_STAGING_PREFIX = "omni-import-";
/** And the suffix, which is what says it is not a database anyone may open. */
const IMPORT_STAGING_SUFFIX = ".sqlite.part";
/** What a candidate is called for the instant between the close and the rename. */
const INCOMING_SUFFIX = ".incoming";

/**
 * How long a staging file must have sat untouched before the sweep takes it.
 *
 * The mtime is the signal and not the name, because the file that must survive
 * this is the one an upload is still writing into — a couple of gibibytes over
 * a slow link can outlast any wall-clock bound worth setting, and its mtime
 * moves with every chunk. An hour is comfortably longer than a swap, which is a
 * rename, and comfortably shorter than leaving a database-sized file on an
 * operator's disk until they notice it.
 */
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

/** Where the caller of `importSnapshot` should put the bytes it is given. */
export function stagedImportPath(deps: DatabaseDeps, token: string): string {
  return join(
    dirname(deps.store.databasePath),
    `${IMPORT_STAGING_PREFIX}${token}${IMPORT_STAGING_SUFFIX}`,
  );
}

/**
 * Removes staging files no operation is holding any more.
 *
 * Two of them exist and both are the size of a database: the upload a refused
 * import wrote, and the `${db}.incoming` a swap that failed after its rename
 * left behind. Nothing else looks at the installation directory, so without
 * this they accumulate silently on exactly the disk the gateway runs from.
 *
 * Unguarded by the exclusive lock, deliberately: the age bound already excludes
 * everything an operation could be holding, and a sweep that had to wait for
 * one would be a sweep that skips the tick after a long restore.
 */
export function sweepStaging(deps: DatabaseDeps): number {
  const live = deps.store.databasePath;
  const dir = dirname(live);
  const incoming = `${basename(live)}${INCOMING_SUFFIX}`;
  const staleBefore = deps.now() - STAGING_MAX_AGE_MS;

  let removed = 0;
  for (const entry of deps.fs.readdir(dir)) {
    const staged =
      entry === incoming ||
      (entry.startsWith(IMPORT_STAGING_PREFIX) && entry.endsWith(IMPORT_STAGING_SUFFIX));
    if (!staged) continue;

    const path = join(dir, entry);
    const stat = deps.fs.stat(path);
    if (stat === null || stat.mtimeMs >= staleBefore) continue;
    deps.fs.unlink(path);
    removed++;
  }
  return removed;
}

/**
 * Writes one snapshot, then prunes.
 *
 * `force` is for the copy taken on the way into a restore: it skips the prune,
 * because the undo for an operation must not be deletable by the very policy
 * that operation is about to run under. Every other caller leaves it alone.
 */
async function writeSnapshot(
  deps: DatabaseDeps,
  input: { reason: SnapshotReason; force?: boolean },
): Promise<SnapshotInfo> {
  const dir = snapshotsDir(deps);
  const at = deps.now();
  const filename = snapshotName(at, input.reason);
  const path = join(dir, filename);

  deps.fs.mkdir(dir);
  if (deps.fs.stat(path) !== null) {
    throw new GatewayError("CONFLICT", "a snapshot for this instant already exists");
  }

  const free = deps.fs.freeBytes(dir);
  const needed = Math.ceil((deps.fs.stat(deps.store.databasePath)?.size ?? 0) * SNAPSHOT_HEADROOM);
  // Null is "this filesystem will not say", which is not the same as "no room".
  if (free !== null && free < needed) {
    throw new GatewayError("CONFLICT", "not enough free disk space to write a snapshot");
  }

  try {
    await deps.store.maintenance.snapshotTo(path);
  } catch (error) {
    // A half-written file is a database an operator could later choose to
    // restore. It goes before the failure is reported, not after.
    deps.fs.unlink(path);
    throw error;
  }

  const info: SnapshotInfo = {
    id: filename,
    filename,
    createdAt: at,
    sizeBytes: deps.fs.stat(path)?.size ?? 0,
    reason: input.reason,
  };

  if (input.force !== true) {
    applyRetention(deps, retentionOf(await deps.store.config.getSettings()), at);
  }
  return info;
}

export async function createSnapshot(
  deps: DatabaseDeps,
  input: { reason: SnapshotReason; force?: boolean },
): Promise<SnapshotInfo> {
  return withExclusive("a snapshot", () => writeSnapshot(deps, input));
}

/**
 * Raised when the file swap itself failed, leaving the database in an unknown
 * state.
 *
 * Its own type rather than a `GatewayError`, because a caller must be able to
 * tell this apart mechanically: every other failure here leaves the live
 * database untouched and is ordinary, while this one means the gateway should
 * stay quiesced and an operator should reach for `preRestoreSnapshotId`.
 */
export class SwapFailedError extends Error {
  constructor(
    readonly preRestoreSnapshotId: string,
    override readonly cause: unknown,
    /**
     * Whether the handle was opened again before this was raised.
     *
     * The swap closes the database and a failure between there and the reopen
     * leaves nothing holding it open, so the recovery this error points at —
     * read the panel, restore `preRestoreSnapshotId` — would run against a dead
     * handle. The reopen is attempted on the way out and can itself fail, and a
     * caller that has to decide what to keep serving needs to know which
     * happened rather than assume the better one.
     */
    readonly reopened: boolean,
  ) {
    super("the database swap failed and the database may be incomplete");
    this.name = "SwapFailedError";
  }
}

export type RestoreResult = {
  ok: true;
  /** Row counts `inspect` read from the file that was restored. */
  counts: Record<string, number>;
  preRestoreSnapshot: SnapshotInfo;
  /**
   * Whether the file that arrived carries a different admin password.
   *
   * Admin sessions are held in memory and validated against the hash on disk,
   * so a restore that brings a different one leaves live sessions authorising a
   * password that no longer exists — the same state `setPassword` clears its
   * sessions to avoid. A caller that holds sessions acts on this; one that does
   * not can ignore it. Deliberately a boolean: the hashes are compared here so
   * that neither of them has to travel.
   */
  adminPasswordChanged: boolean;
  /**
   * The same question for the read-only password, answered separately.
   *
   * Separate because the two invalidations are different sizes: an admin
   * password that changed ends every session, while a viewer password that
   * changed ends only the viewer ones — the operator's own window has nothing
   * to do with who else may look. Folding them into one boolean would force the
   * caller to pick one of those, and either choice is wrong half the time.
   *
   * Gaining or losing the password is a change, same `!==` on `string | null`.
   * Restoring a backup taken before read-only access existed must withdraw it.
   */
  viewerPasswordChanged: boolean;
};

/** How many table names a refusal will name before it starts counting. */
const NAMED_TABLES = 5;

/**
 * What a candidate database actually holds, for a refusal an operator can act on.
 *
 * "Not one of ours" alone does not say which file they picked, and the likely
 * mistake is the wrong database from the right host. `inspect` already reads
 * this list to decide whether the file is ours, so naming it costs nothing and
 * answers the only question the refusal raises. Schema identifiers and never
 * row contents, and bounded, because a foreign database can have any number of
 * tables and an error message cannot.
 */
function describeTables(tables: readonly string[]): string {
  if (tables.length === 0) return "it has no tables at all";
  const named = tables.slice(0, NAMED_TABLES);
  const rest = tables.length - named.length;
  return `it has ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/**
 * Reads a candidate database and refuses it if it could not replace the live one.
 *
 * One function rather than a check at each caller, because `previewRestore`
 * exists to answer the question `restoreSnapshot` is about to ask, and a
 * preview that accepted a file the restore then refused would be worse than no
 * preview at all — the operator would have judged the blast radius of an
 * operation that never runs.
 */
async function judgeCandidate(deps: DatabaseDeps, path: string): Promise<DatabaseInspection> {
  const inspection = await deps.store.maintenance.inspect(path);
  if (!inspection.ok) {
    throw new GatewayError(
      "BAD_REQUEST",
      inspection.quickCheck === "ok"
        ? `that file is a database, but not one of ours: ${describeTables(inspection.tables)}`
        : `that file failed its integrity check: ${inspection.quickCheck}`,
    );
  }
  return inspection;
}

/**
 * Puts `candidate` in place of the live database.
 *
 * Ordered so that the two things which make this survivable cannot be skipped:
 * nothing is closed until the candidate has been judged, and nothing is swapped
 * until the undo exists. The staging copy is made before the close so the window
 * with no database open is a rename rather than a file copy.
 *
 * The stale `-wal` and `-shm` go while the handle is shut. They belong to the
 * file being replaced, and SQLite reopening a new database beside another
 * database's write-ahead log is how a restore turns into corruption.
 */
async function swapIn(
  deps: DatabaseDeps,
  candidate: { path: string; consume: boolean },
): Promise<RestoreResult> {
  const inspection = await judgeCandidate(deps, candidate.path);

  // Unguarded on purpose: the caller already holds the exclusive lock, and this
  // snapshot is a step inside their operation rather than one of its own.
  const preRestoreSnapshot = await writeSnapshot(deps, { reason: "preRestore", force: true });

  // Read to be compared and nothing else. A password hash is a credential, so
  // it is never logged, never returned, and never named in an error; the two
  // values meet here and only the boolean leaves.
  const adminHashBefore = await deps.store.config.getAdminPasswordHash();
  // Both credentials, because there are two. The viewer password is a second
  // way into a read of this whole installation, and a restore can bring a
  // different one — or none — without going through `setViewerPassword`.
  const viewerHashBefore = await deps.store.config.getViewerPasswordHash();

  const live = deps.store.databasePath;
  const staged = `${live}.incoming`;

  // Outside the try below, and that placement is the whole point of it.
  // Copying a snapshot beside the live database is where a full disk actually
  // shows up, and it happens with nothing closed and nothing moved — the live
  // file is byte for byte what it was. Inside the try it would be reported as a
  // failed swap, which is the one failure a caller answers by refusing client
  // traffic until the process is restarted.
  try {
    if (candidate.consume) deps.fs.rename(candidate.path, staged);
    else deps.fs.copyFile(candidate.path, staged);
  } catch (error) {
    // A partial copy is a database-shaped file nobody asked for.
    deps.fs.unlink(staged);
    throw error;
  }

  try {
    deps.store.close();
    deps.fs.unlink(`${live}-wal`);
    deps.fs.unlink(`${live}-shm`);
    deps.fs.rename(staged, live);
    await deps.store.reopen();
  } catch (error) {
    // Best effort, and unconditional: whatever file is at `live` now, a closed
    // handle serves nothing and hides everything. The panel that reports this
    // failure and the second attempt an operator makes from it both read
    // through this store, so leaving it shut turns one bad window into an
    // outage that only a process restart ends.
    let reopened = true;
    try {
      await deps.store.reopen();
    } catch {
      reopened = false;
    }
    throw new SwapFailedError(preRestoreSnapshot.id, error, reopened);
  }

  // After the reopen rather than inside the try: the swap is over and succeeded,
  // and a read that fails here is not a half-swapped database.
  const adminHashAfter = await deps.store.config.getAdminPasswordHash();
  const viewerHashAfter = await deps.store.config.getViewerPasswordHash();

  // The hourly usage rollup is rebuilt rather than trusted.
  //
  // A snapshot carries the table, and one this installation took carries it
  // consistently — but an import is any database file an operator handed over,
  // and the rollup is what a rate limiter enforces long windows from. Nothing
  // in the file says whether its counters agree with its rows, and the table is
  // derived, so recomputing it costs one grouped scan on a path that has just
  // copied the whole database anyway. Trusting it would mean believing a
  // provenance the gateway cannot check.
  //
  // Last, and swallowed, and both for the same reason. By here the new database
  // is live and its password is the one this installation has; a throw from
  // this line would be a restore that succeeded reported as one that failed,
  // and the caller's failure path never reads `adminPasswordChanged` — so
  // sessions minted under the old password would keep working against the new
  // one. The rollup is derived and `omni doctor` audits it, so a stale one is a
  // complaint an operator is told and can repair; a skipped invalidation is
  // silent and cannot be.
  try {
    await deps.store.usage.rebuildRollup();
  } catch (error) {
    (deps.logger ?? noopLogger).warn("usage rollup not rebuilt after the swap; run omni doctor", {
      // The message only, as every other store failure logs: a fault must not
      // drag a row's contents into stdout.
      reason: describeError(error, "unknown"),
    });
  }

  // Last, and swallowed, for exactly the reasons the rollup rebuild above is.
  // By here the new database is live and `adminPasswordChanged` has been decided;
  // a throw from this line would report a successful restore as a failed one and
  // skip the session invalidation the caller performs from that flag. A plugin
  // whose schema did not come back reports it on its own next query, which is a
  // complaint an operator can act on; a skipped invalidation is silent.
  try {
    await deps.reapplyPluginSchema?.();
  } catch (error) {
    (deps.logger ?? noopLogger).warn("plugin schema not reapplied after the swap; restart", {
      reason: describeError(error, "unknown"),
    });
  }

  return {
    ok: true,
    counts: inspection.counts,
    preRestoreSnapshot,
    // `!==` on `string | null` is the whole rule, and it is why the null
    // transitions fall out: gaining or losing a password is a change.
    adminPasswordChanged: adminHashAfter !== adminHashBefore,
    viewerPasswordChanged: viewerHashAfter !== viewerHashBefore,
  };
}

/**
 * What a restore would replace, and what with.
 *
 * Row counts per table on each side, which is the coarsest description of blast
 * radius that is still specific enough to act on: 12 request logs replacing 900
 * is a different decision from 900 replacing 900, and the snapshot's id and
 * mtime say neither.
 *
 * It covers the tables `inspect` counts — the schema-001 set it uses to decide
 * whether a file is one of ours — and no others. `usage_daily`, `usage_rollup`
 * and every `plugin_*` table are replaced by a restore and are absent from this
 * table, so it is a floor on the blast radius rather than the whole of it.
 * Widening it means widening what `inspect` counts, which is also what decides
 * whether a candidate is refused.
 */
export type RestorePreview = {
  /** The candidate's counts. Present always — an unreadable one is a refusal. */
  snapshot: Record<string, number>;
  /**
   * The live database's counts, or null when it could not be inspected.
   *
   * Null rather than `{}`, and rather than a refusal. A live database that
   * cannot be read is exactly the state a restore repairs, so refusing here
   * would withhold the table at the moment it is most worth reading; and `{}`
   * renders every live cell as absent, which reads as "the restore adds all of
   * this" — a claim about the live side that nothing here knows to be true.
   */
  live: Record<string, number> | null;
};

/**
 * What `restoreSnapshot` would do, without doing any of it.
 *
 * The same candidate validation, the same refusals, stopping where the swap
 * would begin. It takes the same single-flight guard: a preview racing a real
 * restore is the two-writers hazard that guard exists for, and holding it
 * briefly is cheaper than reading a file mid-swap and reporting counts from
 * neither side.
 *
 * Nothing is copied, closed, or renamed, so there is no working copy to clean
 * up — `inspect` opens each file read-only on its own handle.
 *
 * A clean preview is not a promise the restore will succeed. `swapIn` validates
 * the same way and then copies the candidate beside the live database, and that
 * copy is where a full disk shows up. The preview answers "would this file be
 * refused", which is the question an operator is about to be asked.
 */
export async function previewRestore(deps: DatabaseDeps, id: string): Promise<RestorePreview> {
  const path = snapshotPath(deps, id);
  if (deps.fs.stat(path) === null) throw new GatewayError("BAD_REQUEST", "no such snapshot");

  return withExclusive("a restore preview", async () => {
    const snapshot = await judgeCandidate(deps, path);
    const live = await deps.store.maintenance.inspect(deps.store.databasePath);
    return { snapshot: snapshot.counts, live: live.ok ? live.counts : null };
  });
}

/**
 * Restores a snapshot this installation took.
 *
 * The snapshot is copied rather than moved: an operator who restores the wrong
 * one needs the right one to still be there.
 */
export async function restoreSnapshot(deps: DatabaseDeps, id: string): Promise<RestoreResult> {
  const path = snapshotPath(deps, id);
  if (deps.fs.stat(path) === null) throw new GatewayError("BAD_REQUEST", "no such snapshot");
  return withExclusive("a restore", () => swapIn(deps, { path, consume: false }));
}

/**
 * The largest file this gateway will accept as a database.
 *
 * A cap rather than trust: an import is an unauthenticated-by-nature stream of
 * bytes onto the disk the installation runs from, and the caller has to be told
 * where to stop before it starts writing. Two gibibytes is far above any
 * plausible gateway database and far below a disk-full incident.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Restores a database file the operator supplied.
 *
 * `path` is a file the caller has already staged — a request body streamed to a
 * temp file, or a path the CLI was given. Control does not read request bodies,
 * so the cap is enforced here on what actually landed rather than on what a
 * header claimed, and the staged file is removed either way: it is a temporary
 * that was handed over, and a rejected upload left in `/tmp` is the copy nobody
 * remembers to delete.
 */
export async function importSnapshot(
  deps: DatabaseDeps,
  input: { path: string },
): Promise<RestoreResult> {
  return withExclusive("an import", async () => {
    const stat = deps.fs.stat(input.path);
    if (stat === null) throw new GatewayError("BAD_REQUEST", "the uploaded file is not there");
    if (stat.size > MAX_IMPORT_BYTES) {
      deps.fs.unlink(input.path);
      throw new GatewayError(
        "BAD_REQUEST",
        `a database import may not exceed ${MAX_IMPORT_BYTES} bytes`,
      );
    }

    try {
      return await swapIn(deps, { path: input.path, consume: true });
    } catch (error) {
      deps.fs.unlink(input.path);
      throw error;
    }
  });
}

/** Reclaims free pages, and says how much that was worth. */
export async function vacuum(
  deps: DatabaseDeps,
): Promise<{ reclaimedBytes: number; durationMs: number }> {
  return withExclusive("a vacuum", async () => {
    const before = deps.fs.stat(deps.store.databasePath)?.size ?? 0;
    const startedAt = deps.now();
    await deps.store.maintenance.vacuum();
    const after = deps.fs.stat(deps.store.databasePath)?.size ?? 0;
    return {
      // A vacuum can end larger than it started, and a negative reclaim is not
      // something an operator can act on.
      reclaimedBytes: Math.max(0, before - after),
      durationMs: Math.max(0, deps.now() - startedAt),
    };
  });
}

export type DatabaseOverview = {
  engine: Store["engine"];
  /** The file path, or the server URL with its password masked. */
  location: string;
  stats: DatabaseStats;
  /** The database file itself, as the filesystem sees it. */
  fileBytes: number;
  /** The write-ahead log, which is zero for a freshly checkpointed database. */
  walBytes: number;
  /** The captured-body tree beside a SQLite file, or the `request_bodies` table on Postgres. */
  bodiesBytes: number;
  /** What SQLite believes it is using: `pageSize * pageCount`. */
  logicalBytes: number;
  /** The part of that a vacuum would give back. */
  freePageBytes: number;
  freeDiskBytes: number | null;
  retention: RetentionPolicy;
  snapshots: { count: number; totalBytes: number; latestAt: number | null };
  /** Every table, largest first, as the engine accounts for it. */
  tables: TableStats[];
};

export async function getDatabaseOverview(deps: DatabaseDeps): Promise<DatabaseOverview> {
  const live = deps.store.databasePath;
  // Independent reads, and three round-trips on Postgres if run in sequence.
  const [stats, tables, settings] = await Promise.all([
    deps.store.maintenance.stats(),
    deps.store.maintenance.tables(),
    deps.store.config.getSettings(),
  ]);
  const shared = {
    engine: deps.store.engine,
    location: live,
    stats,
    logicalBytes: stats.pageSize * stats.pageCount,
    freePageBytes: stats.pageSize * stats.freelistCount,
    retention: retentionOf(settings),
    tables,
  };

  // A Postgres `location` is a server URL, not a path: nothing on the
  // filesystem answers to it, and probing it anyway returns zeros that read
  // as measurements. Bodies there are rows of `request_bodies`.
  if (deps.store.engine === "postgres") {
    return {
      ...shared,
      fileBytes: 0,
      walBytes: 0,
      bodiesBytes: tables.find((table) => table.name === "request_bodies")?.bytes ?? 0,
      freeDiskBytes: null,
      snapshots: { count: 0, totalBytes: 0, latestAt: null },
    };
  }

  const snapshots = listSnapshots(deps);
  return {
    ...shared,
    fileBytes: deps.fs.stat(live)?.size ?? 0,
    walBytes: deps.fs.stat(`${live}-wal`)?.size ?? 0,
    bodiesBytes: deps.fs.dirBytes(bodiesDirFor(live)),
    freeDiskBytes: deps.fs.freeBytes(dirname(live)),
    snapshots: {
      count: snapshots.length,
      totalBytes: snapshots.reduce((sum, snapshot) => sum + snapshot.sizeBytes, 0),
      latestAt: snapshots[0]?.createdAt ?? null,
    },
  };
}

export async function putRetention(deps: DatabaseDeps, input: unknown): Promise<RetentionPolicy> {
  const policy: RetentionPolicy = parseOrThrow(retentionSchema, input);
  await deps.store.config.putSettings({
    snapshotKeepLatest: policy.keepLatest,
    snapshotMaxAgeDays: policy.maxAgeDays,
  });
  return policy;
}
