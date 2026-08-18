# Database Panel and Lifecycle Control — Design

Date: 2026-08-18
Status: Approved

## Problem

An operator running OmniGateway has no way to answer "how big has this got, and what happens if it
breaks" without a shell on the host. The database grows through request logs, daily rollups, quota
samples, and captured bodies; `apps/gateway/src/maintenance.ts` prunes all of them on one hourly
sweep, but nothing reports the resulting size, nothing reclaims the free pages that deletion leaves
behind, and nothing takes a copy before a migration or a bad edit. There is no backup code anywhere
in the repository.

Restarting is likewise shell-only. `omni restart` exists (`apps/cli/src/commands/service.ts:83`) but
requires a terminal on the machine; the dashboard, which already administers credentials, keys, and
models, cannot bounce the process after a settings change that needs one.

This design adds a Database page to the dashboard covering size, compaction, and snapshots, and a
lifecycle control covering restart and shutdown.

OmniRoute (`github.com/diegosouzapw/OmniRoute` v3.8.50) implements comparable features and is the
reference for this work. It is cited throughout, including where we deliberately diverge.

## Scope

In scope:

- Database size and health readout: page count, free pages, on-disk bytes, WAL bytes, captured-body
  footprint, schema version, last vacuum.
- Manual compaction (`VACUUM`).
- Snapshots: create, list, download, delete, restore, and import, bounded by retention.
- Restart and shutdown from the dashboard, gated on whether a supervisor would actually respawn.
- CLI parity for the non-interactive operations.

Out of scope:

- Scheduled automatic backups. Deferred deliberately: it needs a new scheduler loop beside
  `startMaintenance`, plus cadence settings, and the manual path has to prove itself first.
- Snapshotting captured request bodies. See "What a snapshot contains".
- Cloud or off-host backup targets. OmniRoute's CLI posts to a `/api/db-backups/cloud` route that
  does not exist in its own tree; we are not starting there.
- Per-table size breakdown. OmniRoute reads the `dbstat` virtual table
  (`src/lib/db/stats.ts:53`) and swallows `no such module` when it is absent. The whole-database
  numbers answer the operator's question; a per-table view can come later if it is asked for.

## What a snapshot contains

A snapshot is one self-contained SQLite file produced by `VACUUM INTO`. The write-ahead log is
folded in by definition, so `-wal` and `-shm` need no special handling on the way out.

The sibling `request_bodies/` tree is **excluded**. Captured bodies are raw prompts and responses;
including them would make every downloaded snapshot a prompt corpus and would make snapshot size
track prompt volume rather than database size. The cost is that after a restore some `bodies` rows
may reference files that no longer exist, and some files may have no row. Both are already handled:
`store.bodies.sweepOrphans()` reconciles the tree against the table on the existing maintenance
sweep, and it exists precisely because a file and its row are not written transactionally together.

A snapshot does carry encrypted provider credentials and API-key hashes. See "Security".

## Architecture

Four layers, following the existing boundaries.

### 1. `packages/store` — snapshot and swap primitives

Two additions to the `Store` object built at `packages/store/src/sqlite/store.ts:11`.

**`databasePath` exposed on `Store`.** Control needs the path to locate the snapshots directory and
to stat the database; today only `apps/gateway/src/index.ts:108` knows it. `bodiesDirFor` already
derives the sibling artifact tree from the same value (`packages/store/src/bodies/artifact.ts:54`,
"One installation is one directory"), so this makes an existing dependency explicit rather than
introducing one.

**A `maintenance` repo** alongside the existing five:

- `stats()` → `{ pageSize, pageCount, freelistCount, schemaVersion }`. PRAGMA reads plus
  `SELECT MAX(...) FROM` the migrations table. The precedent for a raw PRAGMA through the query API
  is the `data_version` read at `store.ts:43`.
- `vacuum()` — reclaims free pages. Blocking, holds a write lock.
- `snapshotTo(path)` — `VACUUM INTO`. The path is escaped by doubling single quotes.
- `inspect(path)` → opens the file read-only and returns `{ ok, quickCheck, tables, counts }` without
  touching the live database.

**`createStore` returns a swappable store.** The repos become a stable outer object delegating to a
replaceable inner handle, with `reopen()` closing the inner handle and re-opening at the same path.

This indirection is what makes a live swap survivable. `store` is captured by value into five
long-lived holders during boot — `createApp`, `createRefresher`, `startMaintenance`,
`startRefreshScheduler`, and `startQuotaPoller` (`apps/gateway/src/index.ts:108-162`) — and 24 files
are typed against `Store`. Closing and re-opening the handle underneath them would leave all five
pointing at a dead one. The indirection is confined to `packages/store`; no consumer signature
changes.

### 2. `packages/control` — `database.ts` and `lifecycle.ts`

Both caller-agnostic per boundary rule 6: no Elysia, cookies, argv, terminal, or timers.

**`database.ts`** uses the deps-object style established by `ConsoleDeps`
(`packages/control/src/console.ts:47`), so every filesystem effect is injected and tests never touch
a real directory:

```ts
export type DatabaseDeps = {
  store: Store;
  fs: {
    readdir: (dir: string) => readonly string[];
    stat: (path: string) => { size: number; mtimeMs: number } | null;
    unlink: (path: string) => void;
    rename: (from: string, to: string) => void;
    mkdir: (dir: string) => void;
    freeBytes: (dir: string) => number | null;
  };
  now: () => number;
};
```

Operations: `getDatabaseOverview`, `listSnapshots`, `createSnapshot`, `deleteSnapshot`,
`resolveSnapshotForDownload`, `importSnapshot`, `restoreSnapshot`, `vacuum`, `putRetention`.

Snapshots live in `snapshots/` beside the database, named
`db_<ISO-8601 with : and . replaced by ->_<reason>.sqlite`. Retention is `keepLatest` plus
`maxAgeDays`, held in `Settings`, applied after every create and on the existing maintenance sweep.

Retention is not optional. OmniRoute's `src/lib/db/backupRetention.ts:13` records the incident that
forced it to add one: "48.999 files / 204 GB against a 5,3 MB live database".

**`lifecycle.ts`**:

```ts
export type Supervisor = "systemd" | "container" | "none";
export type LifecycleCapability = {
  supervisor: Supervisor;
  canRestart: boolean;
  canShutdown: boolean;
  note?: string;
};
export function describeLifecycle(env: Record<string, string | undefined>): LifecycleCapability;
```

`describeLifecycle` is pure. Detection reuses the signals the codebase already trusts:
`JOURNAL_STREAM` means systemd is capturing this process (`apps/gateway/src/index.ts:51` documents
why this beats looking for an installed unit file), and `MANAGERPID` distinguishes the user manager
from the system one (`index.ts:58`). A container is detected from `/.dockerenv`.

`requestRestart` and `requestShutdown` take an injected `run: CommandRunner` and an injected stop
effect, so `process` never appears in this package.

`UNIT_NAME` is already duplicated into control at `console.ts:10` rather than imported from the CLI,
because a package may not depend on an app. This module reuses that constant.

### 3. `apps/gateway`

**`lifecycle.ts`** supplies the injected stop effect over `main()`'s locals. The existing signal
handler (`apps/gateway/src/index.ts:173-202`) is refactored into one `shutdown(reason, mode)` used by
both signals and the route; today `app`, `store`, and the three stop functions are locals inside
`main()` and are unreachable from a handler.

**`routes/database.ts`** carries the database and lifecycle routes. They do not go into
`routes/admin.ts`, which is already 380 lines.

**The quiesce latch** in `app.ts`: an admission gate that rejects new `/v1/*` work with a retryable
status and awaits in-flight requests to a bounded deadline.

The latch gates `/v1/*` only. `/api/*` stays live throughout a swap — if the latch covered
everything, the dashboard would go dark exactly when the operator most needs to watch it, and could
not report the outcome.

### 4. `apps/dashboard` and `apps/cli`

Dashboard: `features/database/`, route `_app.database.tsx`, a `RailNav` entry. CLI:
`omni db stats|snapshots|backup|restore|vacuum`, joining the existing `db migrate` group, through
`@omni/control` and never `/api/*` (boundary rule 11).

## How restart works

A restart only restarts if something respawns the process. The three installation shapes differ, so
the capability is reported rather than assumed, and the dashboard disables the control with a reason
when it is not real.

**systemd.** The gateway asks the supervisor to restart it:

```
systemctl [--user] --no-block restart omnigateway.service
```

`--no-block` is load-bearing. systemd tears down the whole unit cgroup, which includes the
`systemctl` client just spawned; a blocking call would be killed mid-wait. The queued job survives,
the client does not.

Self-SIGTERM — what OmniRoute does — does not work here. Its `/api/restart` and `/api/shutdown` are
byte-for-byte the same operation (`src/app/api/restart/route.ts`, `src/app/api/shutdown/route.ts`):
both self-SIGTERM after 500 ms and let a supervisor decide the difference. The unit file the CLI
writes sets `Restart=on-failure` (`apps/cli/src/service.ts:128`), and a handled SIGTERM exits 0,
which systemd reads as success. The gateway would stop and stay stopped.

Exiting nonzero to trip `Restart=on-failure` was rejected: it records a deliberate restart as a
failure in `systemctl status` and the journal, and `RestartSec=2` with systemd's start-limit burst
would refuse rapid restarts. Rewriting the unit to `Restart=always` was rejected because it only
affects newly installed units, leaving existing installs silently broken.

Asking the supervisor also gives a better failure mode: we never kill ourselves and hope. A
`systemctl` failure is an ordinary error response from a gateway that is still running and still
serving.

**Container.** Exit 0 and let the restart policy decide. The policy is not readable from inside the
container, so this is the one case where `canRestart` is a statement we cannot verify; the note field
says so.

**Neither.** `canRestart` is false. `omni start` without an installed unit is a detached spawn with a
pidfile and nothing watching it (`apps/cli/src/service.ts:226-250`). Shutdown remains available —
stopping is the point of shutdown.

## How restore works

Restore and import are one operation with two sources. The swap happens in the live process.

The alternative — stage the file, mark it, and swap at next boot before `createStore` — was
considered and rejected. It would have made restore inherit `canRestart`, so every install without a
supervisor could take snapshots it could never restore.

1. **Validate before touching anything.** Open the incoming file read-only; require
   `PRAGMA quick_check` to return `ok`; require the migrations table and a required-tables set. A
   snapshot id is matched against a strict pattern and its resolved path asserted to be inside the
   snapshots directory.
2. **Forced pre-restore snapshot**, retention throttle bypassed. This is the only undo.
3. **Quiesce.** Close the latch, drain in-flight `/v1` work to a bounded deadline, pause background
   loops.
4. **Swap.** Close the inner handle, replace the database file, unlink stale `-wal` and `-shm`,
   `reopen()`.
5. **Invalidate derived state, then release.** `dispatch/snapshotCache.ts` and the sessions held by
   `adminAuth` are both computed from store contents and are stale the moment the file changes.

Failure before step 4 aborts with the live database untouched. Failure during step 4 is the one
genuinely bad window: the gateway holds the latch closed, logs, and refuses `/v1/*` rather than
serving from a half-swapped file. The pre-restore snapshot is the recovery path, and `/api/*` stays
up to reach it.

OmniRoute's live swap (`src/lib/db/backup.ts:365-485`) needs a `resetAllDbModuleState()` and a
`sleep(500)` to work. The swappable inner handle is what lets us avoid both.

## API

All routes require an admin session via `requireAdmin` (`apps/gateway/src/routes/http.ts:28`).
Errors use the existing `GatewayError` codes and `apiErrorHandler`.

| Route | Returns |
| --- | --- |
| `GET /api/database` | sizes, pragma stats, schema version, retention, snapshot summary |
| `POST /api/database/vacuum` | `{ ok, reclaimedBytes, durationMs }`; `CONFLICT` if one is running |
| `GET /api/database/snapshots` | `{ snapshots: [{ id, filename, createdAt, sizeBytes, reason }] }` |
| `POST /api/database/snapshots` | `{ id, filename, sizeBytes, createdAt }` |
| `GET /api/database/snapshots/:id/download` | binary, `Content-Disposition`, `Cache-Control: no-store` |
| `DELETE /api/database/snapshots/:id` | `{ ok: true }` |
| `POST /api/database/snapshots/:id/restore` | `{ ok: true, counts }` |
| `POST /api/database/import` | `{ ok: true, counts }` |
| `PUT /api/database/retention` | `{ keepLatest, maxAgeDays }` |
| `GET /api/lifecycle` | `{ supervisor, canRestart, canShutdown, note? }` |
| `POST /api/lifecycle/restart` | `{ ok: true }`; `CONFLICT` when `canRestart` is false |
| `POST /api/lifecycle/shutdown` | `{ ok: true }` |

Single-flight guards on vacuum and restore both return `CONFLICT`. A failed `VACUUM INTO` removes its
partial file before reporting.

## Dashboard

A `Database` page built from existing primitives: `Readout` tiles for the size figures, a `Meter` for
the free-page fraction, a `Table` of snapshots under the house state ladder (`Failure` →
`SkeletonRows` → `Empty`), and lifecycle controls in their own `Module`.

Every destructive action goes through `Confirm` (`apps/dashboard/src/components/Confirm.tsx:22`),
described in its own source as "the one gate in front of an action that cannot be undone".

There is no toast system — the `toast: 60` z-index token at `theme/tokens.ts:65` is unused — so
feedback stays in busy states and inline text.

Restart and shutdown need different endings, because one of them comes back:

- **Restart** polls `/health` until it stops answering, then until it answers again, then reloads.
  This is OmniRoute's `FeatureFlagsGrid.tsx:207-243` behaviour, not its `Sidebar.tsx:364-375`, which
  swallows the error and reloads on a fixed 3-second timer.
- **Shutdown** ends in a terminal panel. Nothing is coming back to reload into.

When `canRestart` is false the control is disabled and shows the reason.

## Security

- **Every route requires an admin session, unconditionally.** OmniRoute's `requireManagementAuth`
  short-circuits on `if (!options.alwaysRequireAuth && !(await isAuthRequired(request)))`
  (`src/lib/api/requireManagementAuth.ts:43`), and neither `/api/restart` nor
  `/api/db-backups/import` passes `alwaysRequireAuth`, so on an install with no password or OIDC both
  are callable unauthenticated; its `/api/storage/health` has no check in the handler at all. We take
  the feature and not that.
- **A snapshot is a secret-bearing artifact.** It carries encrypted provider credentials and
  API-key hashes. Both are inert without `OMNI_ENCRYPTION_KEY` — changing that key already
  invalidates stored credentials — but downloads are `Cache-Control: no-store` and the action is
  logged. Captured bodies are excluded, so a snapshot is never a prompt corpus.
- **Import** streams to a temp file under a byte cap rather than buffering the request body, and is
  validated before it goes near the live database.
- **`LogFields` is a closed allowlist and a redaction boundary.** The new fields — `snapshotId`,
  `sizeBytes`, `durationMs`, `supervisor`, `reason` — are added explicitly. No index signature; the
  repository treats that as a security change and it is one. No path, prompt, or credential content
  is logged.
- **Disk-space precheck** before `VACUUM INTO`, alongside the retention bound. OmniRoute has no
  free-space check anywhere in its tree.
- **Shutdown in a container is a one-way door.** Stopping the only process takes the dashboard that
  would have restarted it. The confirm dialog says so when `supervisor === "container"`.

Restart and shutdown are gated by the admin session plus a confirm dialog, with no password
re-entry. The same session already authorizes credential and key changes, which are more dangerous.

## Testing

Behaviour tests at the narrowest stable boundary, per repository convention.

- **store** — a real temp-file database; `VACUUM INTO` needs a file, so the in-memory store will not
  do. Stats arithmetic, vacuum reclaiming free pages, a snapshot that reopens clean, `inspect`
  rejecting both a corrupt file and a foreign one.
- **swappable store** — the load-bearing test: take a repo reference *before* `reopen()`, use it
  *after*, assert it reads the new file. That test is what stands between this design and five dead
  handles.
- **control** — hermetic through injected fs, mirroring `packages/control/test/console.test.ts:19`.
  Traversal rejection, retention pruning across `keepLatest` and `maxAgeDays`, integrity rejection,
  oversize import.
- **lifecycle** — a table over `describeLifecycle` covering systemd user scope, systemd system
  scope, container, and none; plus an argv assertion that the spawn is exactly
  `systemctl --user --no-block restart omnigateway.service`.
- **routes** — the `harness()` pattern at `apps/gateway/test/routes/admin.test.ts:33`, driving the
  Elysia app with real `Request` objects. Every new route gets an explicit unauthenticated-request
  test, because that is precisely the defect in the reference implementation.
- **latch** — tested independently of restore, since it is new machinery on the hot request path: an
  in-flight `/v1` request completes, a new `/v1` request is rejected, `/api` stays live.
- **dashboard** — happy-dom with `test/helpers/fetchStub.ts` and `renderWithProviders`, asserting
  visible text and roles: restart disabled with its reason when `canRestart` is false, and `Confirm`
  in front of every destructive action.
- **CLI** — every side effect injected; no spawned processes, no writes outside temp directories.

A green suite is not evidence of coverage, so these anchors are mutation-tested — each must be
verified to fail when its behaviour is broken:

1. `--no-block` removed from the systemctl argv.
2. systemd scope inverted (user ↔ system).
3. The latch blocking `/api/*` as well as `/v1/*`.
4. The outer store not rebound after `reopen()`.
5. The snapshot-path traversal guard removed.
6. The `quick_check` integrity gate bypassed.
7. The forced pre-restore snapshot skipped.

## Documentation

`README.md` gains an operator section on snapshots, retention, and what restart requires per
installation shape. `ARCHITECTURE.md` gains the latch and the swappable store. `CLAUDE.md` gains the
snapshot-excludes-bodies rule and the note that `Restart=on-failure` is why restart asks systemd
rather than signalling itself.
