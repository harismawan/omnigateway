import { expect, test } from "bun:test";
import type { ExportReader } from "@omni/store/exportReader";
import { createBodyAttacher } from "../../../src/export/body/attach.ts";
import { pipelineReservation } from "../../../src/export/body/budget.ts";
import { prepare } from "../../../src/export/deliver.ts";
import { buildRecord } from "../../../src/export/record.ts";
import { destination, row, T0 } from "../harness.ts";

test("conservative estimate derives from known payload size rather than enormous receiver cap", () => {
  const small = pipelineReservation(1000, 1000, 90 * 1024 * 1024, 1000);
  expect(small).toBeLessThan(2 * 1024 * 1024);
  expect(pipelineReservation(1000, 40 * 1024 * 1024, 4 * 1024 * 1024, 1000)).toBeGreaterThan(
    192 * 1024 * 1024,
  );
});

test("three destinations admit only one body through final release and cancel safely", async () => {
  const attacher = createBodyAttacher(192 * 1024 * 1024);
  const prepared = prepare(destination(), null);
  if (!prepared.ok) throw new Error(prepared.error);
  const log = row("r", T0);
  log.bodyState = "ready";
  const text = JSON.stringify({
    schemaVersion: 1,
    requestId: "r",
    client: { request: "hello", response: null, truncated: false },
  });
  let reads = 0;
  const reader = {
    bodyProbe: async () => ({ encryptedBytes: text.length, plaintextBytes: text.length }),
    bodyEnvelope: async () => {
      reads++;
      return { bytes: new TextEncoder().encode(text), sha256: null, truncated: false };
    },
    bodyText: async () => text,
  } as unknown as ExportReader;
  const one = await attacher.attach(
    reader,
    log,
    buildRecord(log, { keyLabel: null }),
    prepared.sender,
    new AbortController().signal,
  );
  const controller = new AbortController();
  const two = attacher.attach(
    reader,
    log,
    buildRecord(log, { keyLabel: null }),
    prepared.sender,
    controller.signal,
  );
  const three = attacher.attach(
    reader,
    log,
    buildRecord(log, { keyLabel: null }),
    prepared.sender,
    new AbortController().signal,
  );
  await Promise.resolve();
  expect(reads).toBe(1);
  expect(attacher.held()).toBeLessThanOrEqual(192 * 1024 * 1024);
  controller.abort(new Error("cancelled"));
  await expect(two).rejects.toThrow("cancelled");
  one.release();
  expect(one.client).toBeUndefined();
  const last = await three;
  expect(reads).toBe(2);
  last.release();
  expect(attacher.held()).toBe(0);
});

test("budget refusal never allocates whole envelope or invokes decoder", async () => {
  const attacher = createBodyAttacher(100);
  const p = prepare(destination(), null);
  if (!p.ok) throw new Error(p.error);
  let reads = 0;
  const reader = {
    bodyProbe: async () => ({ encryptedBytes: 1000, plaintextBytes: 1000000 }),
    bodyEnvelope: async () => {
      reads++;
      throw new Error("must not read");
    },
  } as unknown as ExportReader;
  const log = row("r", T0);
  log.bodyState = "ready";
  const result = await attacher.attach(
    reader,
    log,
    buildRecord(log, { keyLabel: null }),
    p.sender,
    new AbortController().signal,
  );
  expect(result.record.body).toEqual({ state: "omitted", reason: "export budget" });
  expect(reads).toBe(0);
  result.release();
  expect(attacher.held()).toBe(0);
});

test("artifact decoder failure exports unavailable and releases its reservation", async () => {
  const attacher = createBodyAttacher(192 * 1024 * 1024);
  const p = prepare(destination(), null);
  if (!p.ok) throw new Error(p.error);
  const reader = {
    bodyProbe: async () => ({ encryptedBytes: 100, plaintextBytes: 100 }),
    bodyEnvelope: async () => {
      throw new Error("missing file");
    },
  } as unknown as ExportReader;
  const log = row("r", T0);
  log.bodyState = "ready";
  const result = await attacher.attach(
    reader,
    log,
    buildRecord(log, { keyLabel: null }),
    p.sender,
    new AbortController().signal,
  );
  expect(result.record.body).toEqual({ state: "unavailable" });
  result.release();
  expect(attacher.held()).toBe(0);
});
