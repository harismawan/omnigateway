import type { ExportDestinationType } from "@omni/store/types";

/**
 * The messages between the gateway's main thread and the export worker, both
 * directions. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Asynchrony* → Worker protocol).
 *
 * The one module under `export/` the main thread may import: types and two
 * constants, nothing that reads a row, builds a record or opens a handle
 * (`apps/gateway/test/export/boundary.test.ts` pins that). **No row data
 * crosses the boundary** except the single record a `preview` asks for:
 * status carries counters, instants and fixed summaries, never a request id,
 * a URL or a receiver's words.
 *
 * Replies to `test`, `preview`, `skip` and `ackGap` echo the caller's `ref`,
 * so several can be in flight at once. While the worker is paused (or never
 * got its handles) each is answered `{ ok: false, error: "export worker
 * paused" }` at once.
 */

/** What the worker is started with: `new Worker(url, { workerData: init })`. */
export type WorkerInit = {
  bodyBudgetBytes?: number;
  /** SQLite main file. Exactly one of `databasePath` and `databaseUrl` is set. */
  databasePath: string | null;
  /** Postgres URL (cluster mode). */
  databaseUrl: string | null;
  /** `OMNI_ENCRYPTION_KEY` as configured; the worker derives the key itself. */
  encryptionKey: string;
  /** Cluster mode only: leases `export:<generation>` are taken through it. */
  redisUrl: string | null;
  /** This process's identity: the lease holder, and `nodeId` on every record. */
  nodeId: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Boot-only `OMNI_EXPORT_BODIES_ALLOWED` opt-in. */
  exportBodiesAllowed: boolean;
  gates: BodyGates;
};

/** Environment gate and settings-change cancellation notification. Settings are also read at send. */
export type BodyGates = { bodyLoggingAllowed: boolean; bodyLoggingEnabled?: boolean };

// --- main → worker -------------------------------------------------------

export type MainMessage =
  /** Wake now and re-read configuration (it is also re-read every tick). */
  | { type: "destinationsChanged" }
  /** Update privacy gates and cancel active body passes before further sends. */
  | { type: "gatesChanged"; gates: BodyGates }
  /** *Send test*: one synthetic record to destination `id`; answered by `testResult`. */
  | { type: "test"; ref: string; id: string }
  /** *Preview record* for request-log row `requestId`; answered by `previewResult`. */
  | { type: "preview"; ref: string; requestId: string }
  /** *Skip to now* for destination `id`; answered by `skipResult`. */
  | { type: "skip"; ref: string; id: string }
  /**
   * The operator acknowledges destination `id`'s gap warning, as shown: clears
   * `gap_possible_at` when it is at or before `seenAt`, so a warning raised
   * after the operator looked survives. Answered by `ackGapResult`.
   */
  | { type: "ackGap"; ref: string; id: string; seenAt: number }
  /** Cancel in-flight passes, close every handle, answer `paused`. */
  | { type: "pause" }
  /** Reopen fresh handles and continue. */
  | { type: "resume" }
  /** Abandon in-flight batches uncommitted, close every handle, exit. */
  | { type: "stop" };

/** Every main → worker type, for exhaustiveness tests and a receiver's guard. */
export const MAIN_MESSAGE_TYPES = [
  "destinationsChanged",
  "gatesChanged",
  "test",
  "preview",
  "skip",
  "ackGap",
  "pause",
  "resume",
  "stop",
] as const satisfies ReadonlyArray<MainMessage["type"]>;

// --- worker → main -------------------------------------------------------

/**
 * Counters this **worker instance** has added since it was spawned, per
 * destination: what the main thread folds into `omni_export_*_total`. They
 * only grow while the instance lives — pause and resume keep them — and a
 * newly spawned worker (restart after a crash, or after a stop) starts them
 * at zero. So the main thread tracks a baseline per instance: add each
 * status's increase over the last one from the same instance, never the raw
 * value. Persisted totals, all senders together, are on
 * {@link DestinationStatus} itself.
 */
export type DestinationCounters = {
  recordsSent: number;
  recordsDropped: number;
  batchesOk: number;
  batchesRetry: number;
  batchesFailed: number;
  gapWarnings: number;
  bodiesLate?: number;
  bodiesBudget?: number;
};

export type DestinationStatus = {
  id: string;
  generation: string;
  type: ExportDestinationType;
  enabled: boolean;
  /**
   * Database-clock now minus the effective position `max(cursor_at,
   * caught_up_through)`, ms; null before the destination has a state row. An
   * idle destination that is caught up reads about the settle lag, not the
   * age of its last row.
   */
  lagMs: number | null;
  lastSuccessAt: number | null;
  /** A fixed gateway-authored summary ("HTTP 401", "timeout"), never a receiver body. */
  lastError: string | null;
  lastErrorAt: number | null;
  /** Persisted, all senders together. */
  exportedTotal: number;
  droppedTotal: number;
  gapPossibleAt: number | null;
  skipRequestedAt: number | null;
  /** When this worker will next try a destination it is backing off; null when it is not. */
  retryAt: number | null;
  /** The last attempt ended in a hard failure (or a refusal); cleared by a success or a config change. */
  failing: boolean;
  counters: DestinationCounters;
};

export type TestResult =
  | { type: "testResult"; ref: string; ok: true; status: number; latencyMs: number }
  | { type: "testResult"; ref: string; ok: false; error: string; status: number | null };

export type WorkerMessage =
  /** At most one per second, coalesced; every destination, ≤ 10. */
  | { type: "status"; at: number; destinations: DestinationStatus[] }
  | TestResult
  /** `record` is the `RequestRecord` (`export/record.ts`) as it would be sent; null when no such row. */
  | { type: "previewResult"; ref: string; ok: true; record: unknown }
  | { type: "previewResult"; ref: string; ok: false; error: string }
  | { type: "skipResult"; ref: string; ok: true; at: number }
  | { type: "skipResult"; ref: string; ok: false; error: string }
  /** `cleared` is false when there was no warning at or before `seenAt` to clear. */
  | { type: "ackGapResult"; ref: string; ok: true; cleared: boolean }
  | { type: "ackGapResult"; ref: string; ok: false; error: string }
  /** Sent after every in-flight pass stopped and every handle closed. */
  | { type: "paused" };

/** The fixed errors a reply may carry besides a delivery summary. */
export const REPLY_ERRORS = {
  paused: "export worker paused",
  noDestination: "no such export destination",
  noRequest: "no such request",
  internal: "internal error",
} as const;
