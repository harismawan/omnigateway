/**
 * The console's export wire types, pinned to the routes'.
 *
 * `apps/dashboard/src/api/types.ts` hand-mirrors `DestinationStatusView` and
 * the worker's `SupervisorState`: boundary rule 12 keeps the gateway out of
 * the console. Here because this is the one place that may import both, the
 * same shape as `passwordPolicyMirror.test.ts`. The route is the source of
 * truth, so a failure means the console's copy is stale.
 *
 * Type-level, checked by `bun run typecheck`: a state added to the supervisor
 * and not to the console would otherwise reach the banner as a value nothing
 * names. The runtime assertions only keep the file a test.
 */

import { expect, test } from "bun:test";
import type {
  ExportWorkerView as ConsoleWorkerView,
  ExportDestinationResponse,
  ExportDestinationStatus,
  ExportDestinationStatusResponse,
  ExportWorkerState,
} from "../../../dashboard/src/api/types.ts";
import type { DestinationStatusView, ExportWorkerView } from "../../src/routes/export.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const STATUS_SAME: Same<ExportDestinationStatus, DestinationStatusView> = true;
const STATE_SAME: Same<ExportWorkerState, ExportWorkerView["state"]> = true;
const WORKER_SAME: Same<ConsoleWorkerView, ExportWorkerView> = true;
const GET_KEYS: Record<keyof ExportDestinationStatusResponse, true> = {
  destination: true,
  worker: true,
  exportBodiesAllowed: true,
};
const MUTATION_KEYS: Record<keyof ExportDestinationResponse, true> = { destination: true };

/** Key for key, so an optional field cannot hide inside mutual assignability. */
const STATUS_KEYS: Record<keyof DestinationStatusView, true> &
  Record<keyof ExportDestinationStatus, true> = {
  lagMs: true,
  lastSuccessAt: true,
  lastError: true,
  lastErrorAt: true,
  exportedTotal: true,
  droppedTotal: true,
  gapPossibleAt: true,
  skipRequestedAt: true,
  retryAt: true,
  failing: true,
};

test("the console mirrors the export routes' status and worker shapes", () => {
  expect([STATUS_SAME, STATE_SAME, WORKER_SAME]).toEqual([true, true, true]);
  expect(Object.keys(STATUS_KEYS)).toHaveLength(10);
  expect(Object.keys(GET_KEYS)).toEqual(["destination", "worker", "exportBodiesAllowed"]);
  expect(Object.keys(MUTATION_KEYS)).toEqual(["destination"]);
});
