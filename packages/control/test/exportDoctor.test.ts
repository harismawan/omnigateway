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
    available: true,
    warnings: [],
  });
});

test("a healthy destination with the gateway running is ok", () => {
  expect(exportDoctor([dest()], [row()], { now: NOW, gatewayRunning: true })).toEqual({
    destinations: 1,
    status: "ok",
    available: true,
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

test("failing: an error more than 15 min after the destination was last known healthy", () => {
  const ok = { now: NOW, gatewayRunning: true };
  // Delivering until 16 min ago; erroring since.
  const failing = row({
    lastSuccessAt: NOW - 17 * MIN,
    caughtUpThrough: 0,
    lastError: "HTTP 401",
    lastErrorAt: NOW - MIN,
  });
  expect(exportDoctor([dest()], [failing], ok).warnings).toEqual([
    "hook: failing (HTTP 401): no successful delivery in the 16 min up to its last error",
  ]);
  // Never succeeded and never caught up: healthy only as of its creation (or last edit).
  const never = row({
    lastSuccessAt: null,
    caughtUpThrough: 0,
    lastError: "timeout",
    lastErrorAt: NOW - MIN,
  });
  expect(exportDoctor([dest()], [never], ok).warnings).toEqual([
    "hook: failing (timeout): no successful delivery in the 119 min up to its last error",
  ]);
  // Recovered: the success is newer than the error.
  const recovered = row({
    lastSuccessAt: NOW - MIN,
    lastError: "timeout",
    lastErrorAt: NOW - 30 * MIN,
  });
  expect(exportDoctor([dest()], [recovered], ok).warnings).toEqual([]);
  // Erroring for ten minutes is not yet worth a line.
  const fresh = row({
    lastSuccessAt: NOW - 11 * MIN,
    caughtUpThrough: 0,
    lastError: "timeout",
    lastErrorAt: NOW - MIN,
  });
  expect(exportDoctor([dest()], [fresh], ok).warnings).toEqual([]);
});

test("idle for hours, then one fresh failure, is not 'failing for hours'", () => {
  // Last delivery five hours ago, but idle passes kept committing caught-up
  // until a moment before the first error.
  const idleThenOne = row({
    cursorAt: NOW - 300 * MIN,
    lastSuccessAt: NOW - 300 * MIN,
    caughtUpThrough: NOW - 20_000,
    lastError: "HTTP 503",
    lastErrorAt: NOW - 5_000,
  });
  expect(
    exportDoctor([dest()], [idleThenOne], { now: NOW, gatewayRunning: true }).warnings,
  ).toEqual([]);
  // An edit (enabling it again, fixing its URL) is a fresh start too.
  const reEnabled = row({
    lastSuccessAt: NOW - 3000 * MIN,
    caughtUpThrough: NOW - 3000 * MIN,
    cursorAt: NOW - MIN,
    lastError: "HTTP 503",
    lastErrorAt: NOW - 5_000,
  });
  expect(
    exportDoctor([dest({ updatedAt: NOW - 2 * MIN })], [reEnabled], {
      now: NOW,
      gatewayRunning: true,
    }).warnings,
  ).toEqual([]);
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
    available: false,
    warnings: [],
  });
  expect(exportDoctor([dest()], [], { now: NOW, gatewayRunning: true }).status).toBe("ok");
});

test("unavailable state is reported beside the worker-down warning, not hidden by it", () => {
  expect(exportDoctor([dest()], null, { now: NOW, gatewayRunning: false })).toEqual({
    destinations: 1,
    status: "warnings",
    available: false,
    warnings: ["export worker down: the gateway is not running"],
  });
});

test("unreadable destinations (Postgres unreachable) are unavailable, with nothing claimed", () => {
  expect(exportDoctor(null, null, { now: NOW, gatewayRunning: null })).toEqual({
    destinations: null,
    status: "unavailable",
    available: false,
    warnings: [],
  });
});

test("where the gateway's state is unknowable (a cluster), no worker-down claim is made", () => {
  expect(exportDoctor([dest()], [row()], { now: NOW, gatewayRunning: null }).warnings).toEqual([]);
});
