import { dirname, join, resolve } from "node:path";
import { GatewayError } from "@omni/ir";
import { bodiesDirFor, type DatabaseStats, type MaintenanceRepo, type Settings } from "@omni/store";
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
  databasePath: string;
  config: {
    getSettings(): Promise<Settings>;
    putSettings(patch: Partial<Settings>): Promise<Settings>;
    getAdminPasswordHash(): Promise<string | null>;
  };
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
    /** Free space on the filesystem holding `dir`, or null when unknowable. */
    freeBytes: (dir: string) => number | null;
    /** Recursive size of a directory tree. Zero when it does not exist. */
    dirBytes: (dir: string) => number;
  };
  now: () => number;
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
 */
function snapshotPath(deps: DatabaseDeps, id: string): string {
  const dir = resolve(snapshotsDir(deps));
  const path = resolve(dir, id);
  if (parseSnapshotName(id) === null || dirname(path) !== dir) {
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
 */
const SNAPSHOT_HEADROOM = 1.1;

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
function applyRetention(deps: DatabaseDeps, policy: RetentionPolicy, now: number): void {
  const dir = snapshotsDir(deps);
  const cutoff = now - policy.maxAgeDays * DAY_MS;
  listSnapshots(deps).forEach((snapshot, index) => {
    if (index === 0) return;
    if (index < policy.keepLatest && snapshot.createdAt >= cutoff) return;
    deps.fs.unlink(join(dir, snapshot.id));
  });
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
};

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
  const inspection = await deps.store.maintenance.inspect(candidate.path);
  if (!inspection.ok) {
    throw new GatewayError(
      "BAD_REQUEST",
      inspection.quickCheck === "ok"
        ? "that file is a database, but not one of ours"
        : `that file failed its integrity check: ${inspection.quickCheck}`,
    );
  }

  // Unguarded on purpose: the caller already holds the exclusive lock, and this
  // snapshot is a step inside their operation rather than one of its own.
  const preRestoreSnapshot = await writeSnapshot(deps, { reason: "preRestore", force: true });

  // Read to be compared and nothing else. A password hash is a credential, so
  // it is never logged, never returned, and never named in an error; the two
  // values meet here and only the boolean leaves.
  const adminHashBefore = await deps.store.config.getAdminPasswordHash();

  const live = deps.store.databasePath;
  const staged = `${live}.incoming`;
  try {
    if (candidate.consume) deps.fs.rename(candidate.path, staged);
    else deps.fs.copyFile(candidate.path, staged);

    deps.store.close();
    deps.fs.unlink(`${live}-wal`);
    deps.fs.unlink(`${live}-shm`);
    deps.fs.rename(staged, live);
    await deps.store.reopen();
  } catch (error) {
    throw new SwapFailedError(preRestoreSnapshot.id, error);
  }

  // After the reopen rather than inside the try: the swap is over and succeeded,
  // and a read that fails here is not a half-swapped database.
  const adminHashAfter = await deps.store.config.getAdminPasswordHash();

  return {
    ok: true,
    counts: inspection.counts,
    preRestoreSnapshot,
    // `!==` on `string | null` is the whole rule, and it is why the null
    // transitions fall out: gaining or losing a password is a change.
    adminPasswordChanged: adminHashAfter !== adminHashBefore,
  };
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
  stats: DatabaseStats;
  /** The database file itself, as the filesystem sees it. */
  fileBytes: number;
  /** The write-ahead log, which is zero for a freshly checkpointed database. */
  walBytes: number;
  /** The captured-body tree, which snapshots deliberately exclude. */
  bodiesBytes: number;
  /** What SQLite believes it is using: `pageSize * pageCount`. */
  logicalBytes: number;
  /** The part of that a vacuum would give back. */
  freePageBytes: number;
  freeDiskBytes: number | null;
  retention: RetentionPolicy;
  snapshots: { count: number; totalBytes: number; latestAt: number | null };
};

export async function getDatabaseOverview(deps: DatabaseDeps): Promise<DatabaseOverview> {
  const live = deps.store.databasePath;
  const stats = await deps.store.maintenance.stats();
  const settings = await deps.store.config.getSettings();
  const snapshots = listSnapshots(deps);

  return {
    stats,
    fileBytes: deps.fs.stat(live)?.size ?? 0,
    walBytes: deps.fs.stat(`${live}-wal`)?.size ?? 0,
    bodiesBytes: deps.fs.dirBytes(bodiesDirFor(live)),
    logicalBytes: stats.pageSize * stats.pageCount,
    freePageBytes: stats.pageSize * stats.freelistCount,
    freeDiskBytes: deps.fs.freeBytes(dirname(live)),
    retention: retentionOf(settings),
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
