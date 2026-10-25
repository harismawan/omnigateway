import { expect, test } from "bun:test";
import type { ExportDestination } from "@omni/store";
import type { ExportStatusRow } from "@omni/store/exportStatus";
import { exportDoctor } from "../src/exportDoctor.ts";

/**
 * What `omni doctor` says about log export. Design: *Observability* (lag over
 * an hour, failing over 15 minutes), *Failure isolation* (worker down) and
 * *Cursor* (the gap warning until acknowledged).
 */

const NOW = Date.UTC(2026, 9, 25, 12);
const MIN = 60_000;

function dest(over: Partial<ExportDestination> = {}): ExportDestination {
  return {
    id: "hook",
    generation: "gen-hook",
    type: "webhook",
    enabled: true,
    config: {},
    filter: {},
    filterMalformed: false,
    includeBodies: false,
    maxRequestBytes: null,
    startAt: NOW - 120 * MIN,
    hasSecret: false,
    createdAt: NOW - 120 * MIN,
    updatedAt: NOW - 120 * MIN,
    ...over,
  };
}

function row(over: Partial<ExportStatusRow> = {}): ExportStatusRow {
  return {
    generation: "gen-hook",
    cursorAt: NOW - MIN,
    caughtUpThrough: NOW - 10_000,
    lastSuccessAt: NOW - MIN,
    lastError: null,
    lastErrorAt: null,
    gapPossibleAt: null,
    ...over,
  };
}

test("no destinations: nothing to say", () => {
  expect(exportDoctor([], null, { now: NOW, gatewayRunning: false })).toEqual({
    destinations: 0,
    status: "none",
    warnings: [],
  });
});

test("a healthy destination with the gateway running is ok", () => {
  expect(exportDoctor([dest()], [row()], { now: NOW, gatewayRunning: true })).toEqual({
    destinations: 1,
    status: "ok",
    warnings: [],
  });
});

test("lag over an hour warns", () => {
  const r = exportDoctor([dest()], [row({ cursorAt: NOW - 61 * MIN, caughtUpThrough: 0 })], {
    now: NOW,
    gatewayRunning: true,
  });
  expect(r.warnings).toEqual(["hook: 61 min behind"]);
  // Fifty-nine minutes is not.
  expect(
    exportDoctor([dest()], [row({ cursorAt: NOW - 59 * MIN, caughtUpThrough: 0 })], {
      now: NOW,
      gatewayRunning: true,
    }).warnings,
  ).toEqual([]);
});

test("failing for more than 15 minutes warns, with the gateway's own summary", () => {
  const failing = row({
    lastSuccessAt: NOW - 16 * MIN,
    lastError: "HTTP 401",
    lastErrorAt: NOW - MIN,
  });
  expect(exportDoctor([dest()], [failing], { now: NOW, gatewayRunning: true }).warnings).toEqual([
    "hook: failing for 16 min (HTTP 401)",
  ]);
  // Never succeeded: failing since it was created.
  const never = row({ lastSuccessAt: null, lastError: "timeout", lastErrorAt: NOW - MIN });
  expect(exportDoctor([dest()], [never], { now: NOW, gatewayRunning: true }).warnings).toEqual([
    "hook: failing for 120 min (timeout)",
  ]);
  // Recovered: the success is newer than the error.
  const recovered = row({
    lastSuccessAt: NOW - MIN,
    lastError: "timeout",
    lastErrorAt: NOW - 30 * MIN,
  });
  expect(exportDoctor([dest()], [recovered], { now: NOW, gatewayRunning: true }).warnings).toEqual(
    [],
  );
  // Failing for ten minutes is not yet worth a line.
  const fresh = row({
    lastSuccessAt: NOW - 10 * MIN,
    lastError: "timeout",
    lastErrorAt: NOW - MIN,
  });
  expect(exportDoctor([dest()], [fresh], { now: NOW, gatewayRunning: true }).warnings).toEqual([]);
});

test("the gap warning shows until acknowledged; a disabled destination warns of nothing else", () => {
  const r = exportDoctor(
    [dest({ enabled: false })],
    [row({ cursorAt: NOW - 600 * MIN, caughtUpThrough: 0, gapPossibleAt: NOW - MIN })],
    { now: NOW, gatewayRunning: true },
  );
  expect(r.warnings).toEqual([
    "hook: export is within a day of log retention or past it; rows may have been pruned before export",
  ]);
});

test("with enabled destinations and no gateway, the worker is down", () => {
  const r = exportDoctor([dest()], [row()], { now: NOW, gatewayRunning: false });
  expect(r.status).toBe("warnings");
  expect(r.warnings).toEqual(["export worker down: the gateway is not running"]);
  // All disabled: nothing should be running.
  expect(
    exportDoctor([dest({ enabled: false })], [row()], { now: NOW, gatewayRunning: false }).warnings,
  ).toEqual([]);
});

test("unreadable state is unavailable, never a failure; a destination with no row yet is fine", () => {
  expect(exportDoctor([dest()], null, { now: NOW, gatewayRunning: true })).toEqual({
    destinations: 1,
    status: "unavailable",
    warnings: [],
  });
  expect(exportDoctor([dest()], [], { now: NOW, gatewayRunning: true }).status).toBe("ok");
});
