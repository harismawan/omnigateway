import {
  type AdminAuth,
  createDestination,
  type DestinationSummary,
  getDestination,
  listDestinations,
  removeDestination,
  setDestinationBodies,
  updateDestination,
} from "@omni/control";
import { GatewayError, type Logger, noopLogger } from "@omni/ir";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import { z } from "zod";
import { type DestinationStatus, REPLY_ERRORS } from "../export/protocol.ts";
import {
  type ExportRequest,
  type ExportSupervisor,
  NOT_RUNNING,
  type SupervisorState,
} from "../exportHost/supervisor.ts";
import type { Invalidator } from "../stream/broadcaster.ts";
import { apiErrorHandler, readJson, readJsonRecord, requireAdmin, requireReader } from "./http.ts";

/**
 * The export admin surface. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Surfaces → Admin API and control*). Thin like every route here:
 * configuration goes through `@omni/control`, and test, preview, skip and the
 * gap acknowledgement are relayed to the export worker — the main thread runs
 * none of them. Reads are `requireReader` and never carry a secret; every
 * mutation is `requireAdmin` and announces `res:export`.
 */

/** What the routes need of the supervisor. */
export type ExportWorkerHandle = Pick<
  ExportSupervisor,
  "destinationsChanged" | "request" | "state" | "statuses" | "restarts"
>;

export type ExportRouteDeps = {
  exportBodiesAllowed?: boolean;
  store: Store;
  admin: AdminAuth;
  worker: ExportWorkerHandle;
  broadcaster?: Invalidator;
  logger?: Logger;
};

/** The worker's view of one destination, as the API shows it. Counters are the worker's own and stay off the wire. */
export type DestinationStatusView = Omit<
  DestinationStatus,
  "id" | "generation" | "type" | "enabled" | "counters"
>;

export type DestinationView = DestinationSummary & {
  /** Null before the worker has reported this destination (or while it is down). */
  status: DestinationStatusView | null;
};

export type ExportWorkerView = { state: SupervisorState; restarts: number };

export const EXPORT_TOPIC = "res:export";

/** The one stand-in for an installation that runs no export worker (tests, mostly). */
export const absentExportWorker: ExportWorkerHandle = {
  destinationsChanged: async () => {},
  request: () => Promise.reject(new GatewayError("OVERLOADED", NOT_RUNNING)),
  state: () => "idle",
  statuses: () => [],
  restarts: () => 0,
};

const previewQuery = z.object({ requestId: z.string().min(1).max(200) });
const ackBody = z.object({ seenAt: z.number().int().nonnegative() }).strict();

function statusView(s: DestinationStatus): DestinationStatusView {
  return {
    lagMs: s.lagMs,
    lastSuccessAt: s.lastSuccessAt,
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt,
    exportedTotal: s.exportedTotal,
    droppedTotal: s.droppedTotal,
    gapPossibleAt: s.gapPossibleAt,
    skipRequestedAt: s.skipRequestedAt,
    retryAt: s.retryAt,
    failing: s.failing,
  };
}

/** Replies that refuse the request itself, as opposed to a test's delivery outcome. */
const WORKER_REFUSALS: ReadonlySet<string> = new Set(Object.values(REPLY_ERRORS));

/**
 * A worker refusal, as the HTTP error it means. Matched against the fixed
 * `REPLY_ERRORS` and answered with literals, so nothing the worker sent is
 * ever quoted. A paused worker is one a restore is holding: to the caller,
 * not running.
 */
function refusal(error: string): GatewayError {
  switch (error) {
    case REPLY_ERRORS.paused:
      return new GatewayError("OVERLOADED", NOT_RUNNING);
    case REPLY_ERRORS.noDestination:
      return new GatewayError("BAD_REQUEST", "no such export destination");
    case REPLY_ERRORS.noRequest:
      return new GatewayError("BAD_REQUEST", "no such request");
    default:
      return new GatewayError("INTERNAL", "export worker failed");
  }
}

export function exportRoutes(deps: ExportRouteDeps) {
  const logger = deps.logger ?? noopLogger;

  const view = (d: DestinationSummary): DestinationView => {
    // Matched by generation, not id: a status from before a delete-and-recreate is not this one's.
    const s = deps.worker.statuses().find((x) => x.generation === d.generation);
    return { ...d, status: s === undefined ? null : statusView(s) };
  };
  const worker = (): ExportWorkerView => ({
    state: deps.worker.state(),
    restarts: deps.worker.restarts(),
  });

  /** After the write: the console refetches, and the worker wakes (or starts, or stops). */
  const changed = async (): Promise<void> => {
    deps.broadcaster?.invalidate(EXPORT_TOPIC);
    try {
      await deps.worker.destinationsChanged();
    } catch {
      // The write landed; the worker re-reads configuration on its next tick anyway.
      logger.warn("export worker not told of a destination change", { reason: "relay failed" });
    }
  };

  const ask = <R extends ExportRequest>(request: R) => deps.worker.request(request);

  return (
    new Elysia()
      .onError(apiErrorHandler)

      .get("/api/export/destinations", async ({ request }) => {
        await requireReader(request, deps.admin);
        return {
          destinations: (await listDestinations(deps.store)).map(view),
          exportBodiesAllowed: deps.exportBodiesAllowed === true,
          worker: worker(),
        };
      })

      .get("/api/export/destinations/:id", async ({ request, params }) => {
        await requireReader(request, deps.admin);
        return {
          destination: view(await getDestination(deps.store, params.id)),
          worker: worker(),
          exportBodiesAllowed: deps.exportBodiesAllowed === true,
        };
      })

      .post("/api/export/destinations", async ({ request }) => {
        await requireAdmin(request, deps.admin);
        const created = await createDestination(deps.store, await readJson(request));
        logger.info("export destination created", { reason: created.type });
        await changed();
        return { destination: view(created) };
      })

      .put("/api/export/destinations/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        const updated = await updateDestination(deps.store, params.id, await readJson(request));
        await changed();
        return { destination: view(updated) };
      })

      .put("/api/export/destinations/:id/bodies", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        const updated = await setDestinationBodies(deps.store, params.id, await readJson(request));
        await changed();
        return { destination: view(updated) };
      })

      .delete("/api/export/destinations/:id", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        await removeDestination(deps.store, params.id);
        logger.info("export destination removed");
        await changed();
        return { ok: true };
      })

      // An outbound request to the operator's receiver: a mutation in effect, admin alone.
      .post("/api/export/destinations/:id/test", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        const reply = await ask({ type: "test", id: params.id });
        if (reply.ok) return { ok: true, status: reply.status, latencyMs: reply.latencyMs };
        if (WORKER_REFUSALS.has(reply.error)) throw refusal(reply.error);
        // A delivery failure is the answer to "does it work", not an error of this route.
        return { ok: false, status: reply.status, error: reply.error };
      })

      .post("/api/export/destinations/:id/skip", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        const reply = await ask({ type: "skip", id: params.id });
        if (!reply.ok) throw refusal(reply.error);
        logger.warn("export skipped to now", { reason: "operator" });
        deps.broadcaster?.invalidate(EXPORT_TOPIC);
        return { ok: true, at: reply.at };
      })

      .post("/api/export/destinations/:id/gap/acknowledge", async ({ request, params }) => {
        await requireAdmin(request, deps.admin);
        const body = ackBody.safeParse(await readJsonRecord(request));
        if (!body.success) throw new GatewayError("BAD_REQUEST", "invalid acknowledgement");
        const { seenAt } = body.data;
        const reply = await ask({ type: "ackGap", id: params.id, seenAt });
        if (!reply.ok) throw refusal(reply.error);
        deps.broadcaster?.invalidate(EXPORT_TOPIC);
        return { ok: true, cleared: reply.cleared };
      })

      .get("/api/export/preview", async ({ request, query }) => {
        await requireReader(request, deps.admin);
        const parsed = previewQuery.safeParse(query);
        if (!parsed.success) throw new GatewayError("BAD_REQUEST", "invalid requestId");
        const { requestId } = parsed.data;
        const reply = await ask({ type: "preview", requestId });
        if (!reply.ok) throw refusal(reply.error);
        return { record: reply.record };
      })
  );
}
