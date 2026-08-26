import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConsoleDeps,
  type ConsoleSource,
  MAX_CONSOLE_LINES,
  readConsole,
  tailFile,
} from "@omni/control";
import { formatLine, type LogLevel } from "@omni/ir";
import type { Broadcaster } from "../../src/stream/broadcaster.ts";
import type { Schedule } from "../../src/stream/coalescer.ts";
import {
  CONSOLE_FLOOR_MS,
  CONSOLE_TOPIC,
  type ConsoleWatcher,
  JOURNAL_POLL_MS,
  startConsoleStream,
  type WatchFile,
} from "../../src/stream/console.ts";
import { createRing, type Ring } from "../../src/stream/ring.ts";
import { streamHarness } from "./harness.ts";

const AT = Date.parse("2026-08-22T09:00:00.000Z");
const CLOCK = 1_000_000;

function line(level: LogLevel, msg: string, at = AT): string {
  return `${formatLine(level, at, msg, undefined, false)}\n`;
}

function scratch(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "omni-console-stream-")), "gateway.log");
  writeFileSync(path, contents);
  return path;
}

/** The real `tailFile`, and a `journalctl` that a test supplies output for. */
function consoleDeps(journal: () => string): ConsoleDeps & { argv: string[][] } {
  const argv: string[][] = [];
  return {
    argv,
    readFile: (path, lines) => tailFile(path, lines),
    run: async (args) => {
      argv.push([...args]);
      return { code: 0, stdout: journal(), stderr: "" };
    },
  };
}

type Timer = { at: number; run: () => void; fired: boolean; cancelled: boolean };

/**
 * A console stream whose clock, timers and watcher a test drives by hand.
 *
 * Real temp files, because a forward read from a byte offset is exactly the
 * part worth exercising against a real filesystem. Nothing else is real: an
 * `fs.watch` event and a 250ms floor are the kernel's schedule and the wall
 * clock's, and a suite that waited on either would be asserting their latency
 * rather than this file's behaviour.
 */
function harness(
  source: ConsoleSource,
  over: { journal?: () => string; size?: (path: string) => number | null } = {},
) {
  let clock = CLOCK;
  const timers: Timer[] = [];
  const frames: { topic: string; payload: unknown }[] = [];
  const declared = new Set<string>();
  const watchers: { path: string; closed: boolean; change: () => void }[] = [];
  const ring: Ring = createRing({ frames: 100, bytes: 1024 * 1024 });

  const schedule: Schedule = (run, ms) => {
    const timer: Timer = { at: clock + ms, run, fired: false, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  const watch: WatchFile = (path, onChange): ConsoleWatcher => {
    const entry = { path, closed: false, change: onChange };
    watchers.push(entry);
    return {
      close() {
        entry.closed = true;
      },
    };
  };

  const broadcaster: Broadcaster = {
    invalidate() {},
    invalidateAll() {},
    declareStream: (topic) => {
      declared.add(topic);
    },
    declared: (topic) => declared.has(topic),
    stream: (topic, payload) => {
      ring.push(topic, payload);
      frames.push({ topic, payload });
    },
    resetStream: (topic) => ring.reset(topic),
    stop() {},
  };

  const deps = consoleDeps(over.journal ?? (() => ""));
  const stop = startConsoleStream({
    console: { source, deps },
    broadcaster,
    now: () => clock,
    schedule,
    watch,
    ...(over.size === undefined ? {} : { size: over.size }),
  });

  return {
    ring,
    frames,
    declared,
    watchers,
    argv: deps.argv,
    stop,

    /** One `fs.watch` event on the watched path. */
    fire() {
      const watcher = watchers[0];
      if (watcher === undefined) throw new Error("nothing is watching");
      watcher.change();
    },

    /** Moves the clock and runs whatever became due, then lets async work settle. */
    async advance(ms: number) {
      clock += ms;
      for (const timer of [...timers]) {
        if (!timer.fired && !timer.cancelled && timer.at <= clock) {
          timer.fired = true;
          timer.run();
        }
      }
      await Bun.sleep(5);
    },

    /** Timers armed and neither fired nor cancelled. A leak shows up here. */
    pending: () => timers.filter((timer) => !timer.fired && !timer.cancelled),

    /** The messages each frame carried, frame by frame. */
    published: () =>
      frames.map(({ payload }) => {
        const frame = payload as { lines: { msg: string | null }[] };
        return frame.lines.map((entry) => entry.msg);
      }),
  };
}

test("a file source publishes only the bytes appended since the last offset", async () => {
  const path = scratch(line("info", "written before the gateway started"));
  const h = harness({ kind: "file", path });

  appendFileSync(path, line("info", "first"));
  h.fire();
  expect(h.published()).toEqual([["first"]]);

  appendFileSync(path, line("info", "second"));
  // Past the floor, so this is a leading send rather than a folded one.
  await h.advance(CONSOLE_FLOOR_MS * 4);
  h.fire();

  // The second frame is the second line and nothing else. A reader that took
  // the tail of the file instead of the delta would repeat "first" here, and a
  // reader that started at offset 0 would have opened with the line written
  // before the process did.
  expect(h.published()).toEqual([["first"], ["second"]]);
  h.stop();
});

test("a truncated file resets the offset and produces a gap rather than replaying", async () => {
  const path = scratch(line("info", "a") + line("info", "b"));
  const h = harness({ kind: "file", path });

  appendFileSync(path, line("info", "c"));
  h.fire();
  const seen = h.ring.head(CONSOLE_TOPIC);
  expect(h.published()).toEqual([["c"]]);

  // Rotated away and replaced: shorter than the offset held, so the bytes there
  // are not the bytes that were there.
  writeFileSync(path, line("info", "fresh"));
  await h.advance(CONSOLE_FLOOR_MS * 4);
  h.fire();

  expect(h.published()).toEqual([["c"], ["fresh"]]);

  // A subscriber that last saw the pre-truncation frame is told `gap`, not
  // handed frames describing a file that no longer exists. Resetting the offset
  // without resetting the ring leaves it stitching the new file onto the old
  // one with nothing marking the seam.
  expect(h.ring.since(CONSOLE_TOPIC, seen).kind).toBe("gap");
  h.stop();
});

test("a burst of writes inside the floor produces one trailing frame, not one per write", async () => {
  const path = scratch("");
  const h = harness({ kind: "file", path });

  // A write and its watch event, five times over, all inside one floor. This is
  // a gateway logging a line per request, which is the load the floor exists for.
  for (let i = 0; i < 5; i++) {
    appendFileSync(path, line("info", `n${i}`));
    h.fire();
  }
  await h.advance(CONSOLE_FLOOR_MS);

  // Two frames: the leading one, and one trailing frame carrying everything
  // that arrived during the floor. Uncoalesced this is five.
  expect(h.frames).toHaveLength(2);
  expect(h.published()).toEqual([["n0"], ["n1", "n2", "n3", "n4"]]);
  h.stop();
});

test("a journal source polls with the since cursor and advances it", async () => {
  const source: ConsoleSource = { kind: "journal", unit: "omnigateway.service", scope: "system" };
  // Both lines are newer than the cursor the poll starts at, which is boot.
  const entries = line("info", "one", CLOCK + 10) + line("warn", "two", CLOCK + 20);
  const h = harness(source, { journal: () => entries });

  expect(h.declared.has(CONSOLE_TOPIC)).toBe(true);
  await h.advance(JOURNAL_POLL_MS);
  expect(h.published()).toEqual([["one", "two"]]);
  expect(h.argv[0]?.slice(0, 2)).toEqual(["journalctl", "-u"]);

  // The same journal a second later. The cursor advanced to the newest line, so
  // there is nothing new and no frame — a cursor that stayed at boot would
  // republish both lines on every poll forever.
  await h.advance(JOURNAL_POLL_MS);
  expect(h.argv).toHaveLength(2);
  expect(h.frames).toHaveLength(1);
  h.stop();
});

test("stopping a journal source cancels its next poll", async () => {
  const source: ConsoleSource = { kind: "journal", unit: "omnigateway.service", scope: "user" };
  const h = harness(source, { journal: () => "" });

  expect(h.pending()).toHaveLength(1);
  h.stop();
  expect(h.pending()).toHaveLength(0);

  // And nothing re-arms behind the stop: a pass that re-armed in its `finally`
  // regardless would keep the loop alive through teardown.
  await h.advance(JOURNAL_POLL_MS * 4);
  expect(h.pending()).toHaveLength(0);
  expect(h.argv).toHaveLength(0);
});

test("the stopper closes the watcher and cancels the timer", async () => {
  const path = scratch("");
  const h = harness({ kind: "file", path });

  appendFileSync(path, line("info", "one"));
  h.fire();
  appendFileSync(path, line("info", "two"));
  // Inside the floor, so this one arms a trailing read rather than performing it.
  h.fire();
  expect(h.pending()).toHaveLength(1);

  h.stop();
  expect(h.watchers[0]?.closed).toBe(true);
  // `getActiveResourcesInfo()` reports nothing for timers, so the injected
  // cancel is the only thing this assertion can watch.
  expect(h.pending()).toHaveLength(0);

  await h.advance(CONSOLE_FLOOR_MS * 4);
  expect(h.frames).toHaveLength(1);
});

test("the stream and the REST read select the same lines from the same bytes", async () => {
  // A level mix plus a line the gateway did not write, which is the shape that
  // separates a filter that keeps unparsable lines from one that drops them.
  const path = scratch(
    line("debug", "d") +
      line("info", "i") +
      "systemd[1]: omnigateway.service: Main process exited\n" +
      line("error", "e"),
  );
  // From the start of the file, so the delta covers exactly what the REST read
  // will page over.
  const h = harness({ kind: "file", path }, { size: () => 0 });
  h.fire();

  const rest = await readConsole(
    { readFile: (p, n) => tailFile(p, n), run: async () => ({ code: 1, stdout: "", stderr: "" }) },
    { kind: "file", path },
    { lines: MAX_CONSOLE_LINES },
  );

  const frame = h.frames[0]?.payload as { lines: unknown[] };
  // Deep equality, not just the messages: both paths run the one extracted
  // selector, so a level the stream kept and the REST read dropped would mean
  // the console showed different output depending on how a line reached it.
  expect(frame.lines).toEqual(rest.lines);
  expect(rest.lines).toHaveLength(4);
  h.stop();
});

test("a none source declares no stream, so subscribing answers error", async () => {
  const h = await streamHarness();
  try {
    const deps = consoleDeps(() => "");
    const stop = startConsoleStream({
      console: { source: { kind: "none" }, deps },
      broadcaster: h.broadcaster,
    });

    expect(h.broadcaster.declared(CONSOLE_TOPIC)).toBe(false);

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ type: "subscribe", topic: CONSOLE_TOPIC, id: "1" });

    // Through the generic undeclared-topic rule in `routes/stream.ts`. No arm of
    // that route knows what a console is, and none should.
    const frame = await socket.waitFor(
      (item) => (item as { type?: string; id?: string }).id === "1",
      "an answer to the subscribe",
    );
    expect(frame).toMatchObject({ type: "error", topic: CONSOLE_TOPIC, message: "no source" });

    stop();
  } finally {
    await h.close();
  }
});
