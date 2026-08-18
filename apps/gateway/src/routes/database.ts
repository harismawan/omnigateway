import { dirname, join } from "node:path";
import {
  type AdminAuth,
  createSnapshot,
  type DatabaseDeps,
  type DatabaseStore,
  deleteSnapshot,
  describeLifecycle,
  getDatabaseOverview,
  importSnapshot,
  type LifecycleDeps,
  listSnapshots,
  MAX_IMPORT_BYTES,
  putRetention,
  type RestoreResult,
  requestRestart,
  requestShutdown,
  resolveSnapshotForDownload,
  restoreSnapshot,
  SwapFailedError,
  vacuum,
} from "@omni/control";
import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import { Elysia } from "elysia";
import type { QuiesceLatch } from "../quiesce.ts";
import { apiErrorHandler, readJson, requireAdmin } from "./http.ts";

export type DatabaseRouteDeps = {
  store: DatabaseStore;
  admin: AdminAuth;
  /** Shared with `createApp`, which is what applies it to `/v1/*`. */
  latch: QuiesceLatch;
  fs: DatabaseDeps["fs"];
  now: () => number;
  /** The environment, the container probe, the command runner, and the stop effect. */
  lifecycle: LifecycleDeps;
  logger?: Logger;
  /** How long a quiesce waits for in-flight client work before the swap begins. */
  quiesceDeadlineMs?: number;
  /** Overridden only by tests, which cannot upload two gibibytes to prove a cap. */
  maxImportBytes?: number;
  /**
   * Derived state to drop once the file underneath it has been replaced.
   *
   * The routing snapshot is built from credentials, models, and settings, and
   * its staleness check is SQLite's `data_version` — which a freshly opened
   * handle restarts, so a restore is exactly the change it cannot notice.
   */
  snapshots?: { invalidate(): void };
};

/**
 * How long in-flight client work has to finish before the database moves.
 *
 * Bounded because the alternative is a restore that never starts: a stream can
 * run for minutes, and an operator who asked for a restore is not asking to
 * wait for one. Requests still running when it expires keep whatever handle
 * they hold and fail against a closed one, which is why the latch stays shut
 * for the whole operation rather than only for this wait.
 */
const QUIESCE_DEADLINE_MS = 10_000;

/**
 * The gateway's half of a restore: the latch, and what a failed swap means.
 *
 * `@omni/control` does the validating, the undo snapshot, the close, the swap
 * and the reopen, and knows nothing about a latch. This is the wrapper that
 * decides who gets served while it runs, and it turns on the one distinction
 * the control package draws: a `SwapFailedError` is the only failure where the
 * database on disk is in an unknown state, so it is the only one that leaves
 * `/v1/*` refused. Everything else failed before anything was touched and the
 * gateway goes straight back to serving.
 */
async function swap(
  deps: DatabaseRouteDeps,
  logger: Logger,
  label: string,
  operation: () => Promise<RestoreResult>,
): Promise<RestoreResult> {
  const startedAt = deps.now();
  const quiesce = await deps.latch.close(deps.quiesceDeadlineMs ?? QUIESCE_DEADLINE_MS);
  if (!quiesce.drained) {
    logger.warn("client requests still in flight at the quiesce deadline", {
      reason: label,
      count: quiesce.inFlight,
    });
  }

  try {
    const result = await operation();
    deps.snapshots?.invalidate();
    deps.latch.open();
    logger.warn("database replaced", {
      snapshotId: result.preRestoreSnapshot.id,
      durationMs: deps.now() - startedAt,
      reason: label,
    });

    /**
     * The admin sessions, when the file brought a different password with it.
     *
     * `setPassword` clears sessions because a changed password is a "log
     * everyone out" event, and a restore changes it without going through
     * `setPassword` — so this is that same event arriving by the other door.
     * Conditional because the ordinary restore is of this installation's own
     * snapshot, where the password is the one the operator is holding a session
     * for and ending it would be a self-inflicted logout.
     *
     * After the result exists rather than before the operation: the caller is
     * about to be handed `adminPasswordChanged` and has to receive it. Their
     * own request was authorised at the top of the handler, so nothing here can
     * retract it.
     */
    if (result.adminPasswordChanged) {
      deps.admin.invalidateSessions();
      logger.warn("admin sessions ended: the restored database carries a different password", {
        reason: label,
      });
    }
    return result;
  } catch (error) {
    if (error instanceof SwapFailedError) {
      // Deliberately not reopened. The file this gateway would serve from is
      // half-swapped, and answering client traffic out of it is worse than
      // answering none. `/api/*` is still up, which is how an operator reaches
      // the snapshot named here.
      logger.error("database swap failed; client requests stay refused", {
        snapshotId: error.preRestoreSnapshotId,
        reason: label,
      });
      throw new GatewayError("INTERNAL", error.message);
    }
    deps.latch.open();
    throw error;
  }
}

/**
 * Writes the request body to a file beside the database, up to a cap.
 *
 * Streamed rather than buffered: the body is a whole database, and reading one
 * into memory to find out how big it is defeats the point of having a cap. The
 * cap is enforced on bytes as they land, so an oversize upload stops at the
 * limit instead of after it.
 *
 * Staged beside the live database rather than in `/tmp` because the import path
 * renames it into place, and a rename across filesystems fails — which would
 * turn an ordinary import into a failed swap.
 */
async function stageUpload(deps: DatabaseRouteDeps, request: Request): Promise<string> {
  const cap = deps.maxImportBytes ?? MAX_IMPORT_BYTES;
  const path = join(
    dirname(deps.store.databasePath),
    `omni-import-${crypto.randomUUID()}.sqlite.part`,
  );
  const body = request.body;
  if (body === null) throw new GatewayError("BAD_REQUEST", "a database import needs a body");

  const sink = Bun.file(path).writer();
  const reader = body.getReader();
  let written = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done === true) break;
      written += chunk.value.byteLength;
      if (written > cap) {
        await reader.cancel();
        throw new GatewayError("BAD_REQUEST", `a database import may not exceed ${cap} bytes`);
      }
      sink.write(chunk.value);
    }
    await sink.flush();
    return path;
  } catch (error) {
    deps.fs.unlink(path);
    throw error;
  } finally {
    await sink.end();
  }
}

/**
 * The database panel and the lifecycle controls.
 *
 * Separate from `admin.ts` because these are the routes that stop the process
 * and replace the file every other route reads from, and because that file is
 * long enough. The division of labour is the same as everywhere else: prove
 * there is an admin session, call one operation in `@omni/control`, shape the
 * result. What is extra here is the latch, which is a property of this process
 * rather than of the operation, and is therefore the gateway's to hold.
 */
export function databaseRoutes(deps: DatabaseRouteDeps) {
  const logger = deps.logger ?? noopLogger;
  const database: DatabaseDeps = { store: deps.store, fs: deps.fs, now: deps.now };

  return (
    new Elysia()
      .onError(apiErrorHandler)

      .get("/api/database", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return getDatabaseOverview(database);
      })

      .post("/api/database/vacuum", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const result = await vacuum(database);
        logger.info("database vacuumed", {
          sizeBytes: result.reclaimedBytes,
          durationMs: result.durationMs,
        });
        return { ok: true, ...result };
      })

      .get("/api/database/snapshots", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return { snapshots: listSnapshots(database) };
      })

      .post("/api/database/snapshots", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const snapshot = await createSnapshot(database, { reason: "manual" });
        logger.info("database snapshot created", {
          snapshotId: snapshot.id,
          sizeBytes: snapshot.sizeBytes,
        });
        return snapshot;
      })

      /**
       * The snapshot itself.
       *
       * A secret-bearing artifact — encrypted provider credentials and API-key
       * hashes, inert without `OMNI_ENCRYPTION_KEY` but not nothing — so it is
       * never cached and the download is recorded. Captured request bodies are
       * not in it by construction, so this is never a prompt corpus.
       *
       * Handed to `Bun.file` rather than read: a database is as large as it is,
       * and the path came from the control package's own containment check.
       */
      .get("/api/database/snapshots/:id/download", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        const snapshot = resolveSnapshotForDownload(database, params.id);
        logger.info("database snapshot downloaded", {
          snapshotId: snapshot.filename,
          sizeBytes: snapshot.sizeBytes,
        });
        return new Response(Bun.file(snapshot.path), {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(snapshot.sizeBytes),
            "content-disposition": `attachment; filename="${snapshot.filename}"`,
            "cache-control": "no-store",
          },
        });
      })

      .delete("/api/database/snapshots/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        deleteSnapshot(database, params.id);
        logger.info("database snapshot deleted", { snapshotId: params.id });
        return { ok: true };
      })

      .post("/api/database/snapshots/:id/restore", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        return swap(deps, logger, "restore", () => restoreSnapshot(database, params.id));
      })

      /**
       * A database the operator brought with them.
       *
       * Staged first and quiesced second, so an upload over a slow link does
       * not hold client traffic off for its whole duration. `@omni/control`
       * owns the staged file from the moment it is handed over: it validates
       * it, moves it, and removes it whichever way the operation ends.
       */
      .post("/api/database/import", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const path = await stageUpload(deps, request);
        return swap(deps, logger, "import", () => importSnapshot(database, { path }));
      })

      .put("/api/database/retention", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return putRetention(database, await readJson(request));
      })

      .get("/api/lifecycle", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        return describeLifecycle(deps.lifecycle.env, deps.lifecycle.fileExists);
      })

      /**
       * Restart and shutdown.
       *
       * Both return before the process goes anywhere. The stop effect this is
       * handed defers its own teardown by a beat precisely so the response is
       * flushed first — a dashboard that cannot tell a successful shutdown from
       * a dropped connection would report every one of them as a failure.
       */
      .post("/api/lifecycle/restart", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const capability = describeLifecycle(deps.lifecycle.env, deps.lifecycle.fileExists);
        logger.warn("restart requested", { supervisor: capability.supervisor });
        await requestRestart(deps.lifecycle);
        return { ok: true };
      })

      .post("/api/lifecycle/shutdown", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const capability = describeLifecycle(deps.lifecycle.env, deps.lifecycle.fileExists);
        logger.warn("shutdown requested", { supervisor: capability.supervisor, reason: "api" });
        await requestShutdown(deps.lifecycle);
        return { ok: true };
      })
  );
}
