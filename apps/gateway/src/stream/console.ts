import { watch } from "node:fs";
import {
  type ConsoleDeps,
  type ConsoleLine,
  type ConsoleSource,
  type ForwardRead,
  fileSize,
  MAX_CONSOLE_LINES,
  parseConsoleLines,
  readConsole,
  readFrom,
} from "@omni/control";
import { describeError, type Logger, noopLogger } from "@omni/ir";
import type { Broadcaster } from "./broadcaster.ts";
import type { Clock, Schedule } from "./coalescer.ts";
import { createCoalescer } from "./coalescer.ts";

/**
 * The console's log topic. One per process; there is one stdout.
 *
 * A `stream:*` topic rather than a `res:*` one because a log has no resource to
 * re-read: the frame carries the lines themselves, which is why this is the one
 * push path that has to say what it means by a lost line.
 */
export const CONSOLE_TOPIC = "stream:console";

/**
 * The floor on how often a file source publishes.
 *
 * `fs.watch` fires per write, and a gateway under load writes a line per
 * request — so an uncoalesced watcher is a frame per request, against a surface
 * that polls at two seconds today. That is the failure `INVALIDATION_FLOORS`
 * exists to prevent, arrived at from the other direction, and it is why this
 * goes through the same coalescer rather than a debounce of its own.
 *
 * Lower than any `res:*` floor because a console is read as it scrolls: a
 * second of latency on a log line is visible in a way a second of latency on a
 * usage total is not.
 */
export const CONSOLE_FLOOR_MS = 250;

/**
 * How often a journal source is asked what is new.
 *
 * A poll rather than a watch because journald has no file to watch: the source
 * is a `journalctl` invocation through the injected runner. Server-side
 * polling, client-side push — the socket still saves every connected console
 * its own poll, which is the part that scales with operators rather than with
 * the interval.
 */
export const JOURNAL_POLL_MS = 1_000;

/** Something that can be closed. `FSWatcher` satisfies it structurally. */
export type ConsoleWatcher = { close(): void };

/**
 * Starts watching a path for changes. Injected for the same reason the
 * scheduler is: a test that waited on a real inotify event would be asserting
 * the kernel's delivery latency, not this file's behaviour.
 */
export type WatchFile = (path: string, onChange: () => void) => ConsoleWatcher;

export type ConsoleStreamDeps = {
  /** Where stdout ended up, and how to read it back. Built once, in `index.ts`. */
  console: { source: ConsoleSource; deps: ConsoleDeps };
  broadcaster: Broadcaster;
  logger?: Logger;
  now?: Clock;
  schedule?: Schedule;
  watch?: WatchFile;
  /** The forward reader. Injected only so a test can drive one that never existed. */
  read?: (path: string, offset: number) => ForwardRead | null;
  /** The starting offset for a file source. Defaults to its current size. */
  size?: (path: string) => number | null;
  floorMs?: number;
  pollMs?: number;
};

/** What a `stream:console` frame carries: the lines that appeared since the last one. */
export type ConsoleFrame = { lines: ConsoleLine[] };

const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * Publishes deltas of this gateway's own log on `stream:console`.
 *
 * Three sources, three shapes, one topic. The arm is chosen once at boot
 * because `ConsoleSource` is resolved once at boot: an operator who changes
 * `OMNI_LOG_FILE` restarts, like every other startup-time knob.
 *
 * `none` declares nothing at all. A subscribe to an undeclared `stream:*` topic
 * already answers `error` in `routes/stream.ts`, so a console whose output
 * nothing captured is told there is no source rather than being left watching a
 * topic that will never speak. No special case is needed there and none is
 * added — a second rule saying the same thing is a rule that ends up true in
 * one place.
 */
export function startConsoleStream(deps: ConsoleStreamDeps): () => void {
  const logger = deps.logger ?? noopLogger;
  const { source } = deps.console;

  if (source.kind === "none") return () => {};
  if (source.kind === "journal") return startJournalPoll(deps, source, logger);
  return startFileWatch(deps, source, logger);
}

function startFileWatch(
  deps: ConsoleStreamDeps,
  source: { kind: "file"; path: string },
  logger: Logger,
): () => void {
  const { broadcaster } = deps;
  const read = deps.read ?? readFrom;
  const size = deps.size ?? fileSize;
  const floorMs = deps.floorMs ?? CONSOLE_FLOOR_MS;

  // The end of the file, not its beginning. A gateway that started at offset 0
  // would publish its whole existing log as if it had just been written, which
  // is both the wrong content and, on a log documented as growing without
  // bound, the allocation `tailFile` was written to avoid.
  let offset = size(source.path) ?? 0;

  const pump = (): void => {
    const delta = read(source.path, offset);
    if (delta === null) {
      // Gone or unreadable — rotated away a moment ago, most likely. The offset
      // is kept: if the same path comes back shorter, the next read reports the
      // gap, and if it comes back longer the bytes in between were never ours.
      return;
    }

    offset = delta.offset;
    const lines = parseConsoleLines(delta.text, { lines: MAX_CONSOLE_LINES });
    if (lines.length > 0) broadcaster.stream(CONSOLE_TOPIC, { lines } satisfies ConsoleFrame);

    if (delta.gap) {
      // After the frame, not before, and everything goes — including the frame
      // just published. Every retained frame describes a file that no longer
      // exists, so a reconnecting subscriber that was handed the survivors
      // would stitch the new file onto the old one with nothing to mark the
      // seam. Dropping them all leaves its `sinceSeq` behind the oldest frame
      // held, so the ring answers `gap` and the console does a full REST read —
      // which is exactly what happened, stated in the vocabulary that already
      // exists. Sequence numbers keep climbing, so a subscriber that received
      // this frame live is still current and is told so.
      broadcaster.resetStream(CONSOLE_TOPIC);
    }
  };

  const coalescer = createCoalescer({
    floors: { [CONSOLE_TOPIC]: floorMs },
    defaultFloorMs: floorMs,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
    // The topic is ignored: this coalescer serves one. What it supplies is the
    // leading-plus-trailing behaviour, which is the part worth not writing
    // twice — a leading-only floor loses the last line of a burst, and that is
    // the line an operator watching a log is waiting for.
    sink: () => pump(),
  });

  const watcher = startWatcher(deps, source.path, () => coalescer.emit(CONSOLE_TOPIC), logger);
  if (watcher === null) {
    coalescer.stop();
    // Undeclared, like `none`. A topic nobody can feed must not look to a
    // client like a topic that is merely quiet.
    return () => {};
  }

  broadcaster.declareStream(CONSOLE_TOPIC);
  logger.info("console stream watching", { path: source.path });

  return () => {
    watcher.close();
    // Both, and in this order. Closing the watcher stops new emits; stopping
    // the coalescer cancels the trailing timer that a final emit already armed,
    // which would otherwise read a file the process is done with.
    coalescer.stop();
  };
}

function startWatcher(
  deps: ConsoleStreamDeps,
  path: string,
  onChange: () => void,
  logger: Logger,
): ConsoleWatcher | null {
  const create =
    deps.watch ??
    ((target: string, changed: () => void) => {
      const watcher = watch(target, () => changed());
      watcher.on("error", (error: unknown) => {
        // A watch that dies takes the stream with it, and the topic stays
        // declared: the console keeps its subscription and sees nothing. Said
        // out loud here because there is no frame that can carry it.
        logger.error("console watch failed", { reason: describeError(error, "unknown") });
      });
      return watcher;
    });

  try {
    return create(path, onChange);
  } catch (error) {
    logger.warn("console stream unavailable", {
      path,
      reason: describeError(error, "unknown"),
    });
    return null;
  }
}

function startJournalPoll(
  deps: ConsoleStreamDeps,
  source: Extract<ConsoleSource, { kind: "journal" }>,
  logger: Logger,
): () => void {
  const { broadcaster } = deps;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const pollMs = deps.pollMs ?? JOURNAL_POLL_MS;

  // From boot, not from the beginning of the journal. The console's own REST
  // read supplies the first page; this supplies what happens next.
  //
  // A line the gateway did not write — systemd's own notices, a runtime stack
  // trace — has no instant and so cannot be newer than a cursor. Those reach
  // the REST read, which asks for a page rather than for a delta, and not this
  // topic. Claiming them here would mean re-sending them on every poll.
  let cursor = now();
  let stopped = false;
  let cancel: (() => void) | null = null;

  const arm = (): void => {
    if (stopped) return;
    cancel = schedule(() => void tick(), pollMs);
  };

  const tick = async (): Promise<void> => {
    try {
      // `MAX_CONSOLE_LINES` rather than a page-sized window: a delta must carry
      // everything written since the cursor, and a smaller request would drop
      // the oldest lines of a busy second with nothing to mark the loss. The
      // interval is a second and not less for the same reason — this costs one
      // `journalctl` per tick.
      const read = await readConsole(deps.console.deps, source, {
        lines: MAX_CONSOLE_LINES,
        since: cursor,
      });

      if (read.lines.length > 0) {
        for (const line of read.lines) {
          if (line.at !== null && line.at > cursor) cursor = line.at;
        }
        broadcaster.stream(CONSOLE_TOPIC, { lines: read.lines } satisfies ConsoleFrame);
      }
    } catch (error) {
      logger.error("console poll failed", { reason: describeError(error, "unknown") });
    } finally {
      // Re-armed after the read rather than on an interval, so a `journalctl`
      // slower than the interval cannot stack passes on top of each other.
      arm();
    }
  };

  broadcaster.declareStream(CONSOLE_TOPIC);
  arm();

  return () => {
    stopped = true;
    cancel?.();
  };
}
