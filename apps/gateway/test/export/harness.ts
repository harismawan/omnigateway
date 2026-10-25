import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Coord, memoryCoord } from "@omni/coord";
import type { ExportReader } from "@omni/store/exportReader";
import {
  DEFAULT_SETTINGS,
  type ExportDestination,
  type ExportPageQuery,
  type RequestLog,
  type Settings,
} from "@omni/store/types";
import { type CaptureLogger, captureLogger, requestLog } from "@omni/testkit";
import type { Transport, TransportInit, TransportResponse } from "../../src/export/deliver.ts";
import { createExportLoop, type ExportLoop, type LeaseClient } from "../../src/export/loop.ts";
import type { WorkerMessage } from "../../src/export/protocol.ts";
import { openSqliteExportState } from "../../src/export/state/sqlite.ts";
import type { ExportStateStore } from "../../src/export/state.ts";

/**
 * A fake world for the export loop: a clock and timers the test advances, an
 * in-memory main database behind the `ExportReader` interface, a real
 * `export.db` in a temp directory, and a receiver that records what it is
 * sent and answers what the test says.
 */

export const T0 = Date.UTC(2026, 9, 25, 12);
export const DAY = 24 * 60 * 60 * 1000;

export type FakeClock = {
  now: number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  pending(): number;
};

function fakeClock(start: number): FakeClock & {
  due(end: number): { at: number; fn: () => void } | null;
} {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    now: start,
    setTimeout(fn: () => void, ms: number): unknown {
      seq += 1;
      timers.set(seq, { at: clock.now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === "number") timers.delete(handle);
    },
    pending: () => timers.size,
    due(end: number) {
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) {
        if (entry[1].at <= end && (best === null || entry[1].at < best[1].at)) best = entry;
      }
      if (best === null) return null;
      timers.delete(best[0]);
      return best[1];
    },
  };
  return clock;
}

export type Sent = {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Webhook record ids, in order. */
  ids: string[];
};

type Answer = Response | Promise<Response>;

export function destination(over: Partial<ExportDestination> = {}): ExportDestination {
  return {
    id: "hook",
    generation: "11111111-1111-4111-8111-111111111111",
    type: "webhook",
    enabled: true,
    config: { url: "https://hooks.test/in" },
    filter: {},
    filterMalformed: false,
    includeBodies: false,
    maxRequestBytes: null,
    startAt: T0 - 60_000,
    hasSecret: false,
    createdAt: T0 - 60_000,
    updatedAt: T0 - 60_000,
    ...over,
  };
}

/** A done row completed at `completedAt`. */
export function row(id: string, completedAt: number, over: Partial<RequestLog> = {}): RequestLog {
  return requestLog({ id, at: completedAt - 100, completedAt, ...over });
}

export type World = {
  clock: FakeClock;
  rows: RequestLog[];
  destinations: ExportDestination[];
  settings: Settings;
  secrets: Map<string, string>;
  labels: Map<string, string>;
  sent: Sent[];
  posted: WorkerMessage[];
  logger: CaptureLogger;
  /** Runs before every configuration read; a test holds a tick with it. */
  beforeDestinations: () => Promise<void>;
  /** Runs before every cursor read; a test makes it hang to reach the batch deadline. */
  beforePage: (signal: AbortSignal | undefined) => Promise<void>;
  /** What the receiver answers next; default 200. */
  answer: (req: Sent) => Answer;
  loop: ExportLoop;
  /** The state store the loop's current handles use; a second one opened on the same file. */
  state(): ExportStateStore;
  opens: number;
  closes: number;
  /** Lets timers due within `ms` fire, in order, settling the loop after each. */
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
  dispose(): void;
};

export function world(
  opts: {
    destinations?: ExportDestination[];
    rows?: RequestLog[];
    lease?: LeaseClient | null;
    nodeId?: string;
    /** Share another world's `export.db` (two workers, one state). */
    statePath?: string;
    reader?: Pick<World, "rows" | "destinations" | "settings" | "secrets" | "labels">;
    clock?: FakeClock;
  } = {},
): World & { statePath: string } {
  const clock = (opts.clock as ReturnType<typeof fakeClock> | undefined) ?? fakeClock(T0);
  const dir = mkdtempSync(join(tmpdir(), "omni-export-loop-"));
  const statePath = opts.statePath ?? join(dir, "export.db");
  const shared = opts.reader;
  const w = {
    clock,
    rows: shared?.rows ?? [...(opts.rows ?? [])],
    destinations: shared?.destinations ?? [...(opts.destinations ?? [destination()])],
    settings: shared?.settings ?? { ...DEFAULT_SETTINGS, logRetentionDays: 30 },
    secrets: shared?.secrets ?? new Map<string, string>(),
    labels: shared?.labels ?? new Map<string, string>(),
    sent: [] as Sent[],
    posted: [] as WorkerMessage[],
    logger: captureLogger("debug"),
    answer: (_req: Sent): Answer => new Response(null, { status: 200 }),
    beforePage: async () => {},
    beforeDestinations: async () => {},
    opens: 0,
    closes: 0,
  } as unknown as World & { statePath: string };
  w.statePath = statePath;

  const reader: ExportReader = {
    destinations: async () => {
      await w.beforeDestinations();
      return w.destinations.map((d) => ({ ...d }));
    },
    openSecret: async (id) => w.secrets.get(id) ?? null,
    settings: async () => ({ ...w.settings }),
    keyLabels: async () => new Map(w.labels),
    exportPage: async (q: ExportPageQuery) => {
      await w.beforePage(q.signal);
      q.signal?.throwIfAborted();
      const keys = q.filter?.apiKeyIds;
      return w.rows
        .filter((r) => r.state === "done" && r.completedAt !== null)
        .filter((r) => (r.completedAt as number) <= q.settledBefore)
        .filter(
          (r) =>
            (r.completedAt as number) > q.after.completedAt ||
            ((r.completedAt as number) === q.after.completedAt && r.id > q.after.id),
        )
        .filter((r) => keys === undefined || (r.apiKeyId !== null && keys.includes(r.apiKeyId)))
        .sort((a, b) =>
          a.completedAt === b.completedAt
            ? a.id < b.id
              ? -1
              : 1
            : (a.completedAt as number) - (b.completedAt as number),
        )
        .slice(0, q.limit);
    },
    getLog: async (id) => w.rows.find((r) => r.id === id) ?? null,
    now: async () => clock.now,
    close() {},
  };

  let current: ExportStateStore | null = null;
  const transport: Transport = async (url: string, init: TransportInit) => {
    init.signal.throwIfAborted();
    const raw = new Uint8Array(
      typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body,
    );
    const gzip = init.headers["content-encoding"] === "gzip";
    const body = new TextDecoder().decode(gzip ? Bun.gunzipSync(raw) : raw);
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(body) as { records?: Array<{ id: string }> };
      ids = (parsed.records ?? []).map((r) => r.id);
    } catch {
      ids = [];
    }
    const sent = { url, headers: init.headers, body, ids };
    w.sent.push(sent);
    const answered = await Promise.race([
      Promise.resolve(w.answer(sent)),
      new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    ]);
    return answered as TransportResponse;
  };

  w.state = () => {
    if (current === null) throw new Error("loop has no open state");
    return current;
  };
  // Bounded, so a test holding a receiver's answer can still move the clock.
  w.settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.race([w.loop.idle(), Bun.sleep(5)]);
      await Bun.sleep(0);
    }
  };
  w.advance = async (ms: number) => {
    const end = clock.now + ms;
    for (;;) {
      const next = clock.due(end);
      if (next === null) break;
      clock.now = Math.max(clock.now, next.at);
      next.fn();
      await w.settle();
    }
    clock.now = end;
    await w.settle();
  };
  w.loop = createExportLoop({
    open: async () => {
      w.opens += 1;
      const state = openSqliteExportState(statePath);
      current = state;
      return {
        reader,
        state,
        lease: opts.lease ?? null,
        close() {
          w.closes += 1;
          state.close();
        },
      };
    },
    transport,
    now: () => clock.now,
    timers: clock,
    random: () => 0.5,
    post: (m) => w.posted.push(m),
    logger: w.logger,
    nodeId: opts.nodeId ?? "node-a",
  });
  w.dispose = () => {
    try {
      current?.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return w;
}

/** A lease client over one shared in-memory coordinator, as two cluster nodes would see Redis. */
export function sharedLease(now: () => number): { coord: Coord; lease: LeaseClient } {
  const coord = memoryCoord({ now });
  return { coord, lease: coord.lease };
}

/** The persisted state of the one destination. */
export async function stateOf(w: World, generation = destination().generation) {
  const all = await w.state().list();
  const found = all.find((s) => s.generation === generation);
  if (found === undefined) throw new Error("no state row");
  return found;
}
