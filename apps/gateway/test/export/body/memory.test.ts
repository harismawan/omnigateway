import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { noopLogger } from "@omni/ir";
import { openSqliteExportReader } from "@omni/store/exportReader";
import {
  bodiesDirFor,
  relPathFor,
  sealArtifactWithGzip,
} from "../../../../../packages/store/src/bodies/artifact.ts";
import { deriveKey } from "../../../../../packages/store/src/encryption.ts";
import { createStore } from "../../../../../packages/store/src/sqlite/store.ts";
import { pipelineReservation } from "../../../src/export/body/budget.ts";
import { createExportLoop } from "../../../src/export/loop.ts";
import { openSqliteExportState } from "../../../src/export/state/sqlite.ts";
import { httpTransport } from "../../../src/export/transport.ts";
import { row } from "../harness.ts";

test.each(["escaping", "incompressible"])(
  "three real large %s pipelines serialize decoding and release on segment and waiter cancellation",
  async (corpus) => {
    // Heap/external counters are process-wide. Isolate the empirical probe from
    // earlier suites' pending GC/native finalizers rather than charging their
    // allocations to this artifact.
    if (process.env.OMNI_EXPORT_MEMORY_PROBE !== corpus) {
      const child = Bun.spawn(
        [process.execPath, "test", import.meta.path, "-t", `${corpus} pipelines`],
        {
          env: { ...process.env, OMNI_EXPORT_MEMORY_PROBE: corpus },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      console.log(stdout);
      if (exit !== 0) console.error(stderr);
      expect(stdout).toContain("EXPORT_MEMORY_EVIDENCE");
      expect(exit).toBe(0);
      return;
    }
    const dir = await mkdtemp("/tmp/opencode/export-memory-");
    const key = await deriveKey("real-memory-pipeline");
    const path = join(dir, "main.db");
    const store = await createStore({ path, encryptionKey: key });
    let reader: ReturnType<typeof openSqliteExportReader> | undefined;
    let loop: ReturnType<typeof createExportLoop> | undefined;
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        await request.arrayBuffer();
        return request.url.includes("otlp")
          ? Response.json({})
          : Response.json({ errors: false, items: [{ index: { status: 201 } }] });
      },
    });
    try {
      const keyId = "key";
      await store.keys.create({
        id: keyId,
        label: "memory",
        prefix: "omni_test",
        hash: "test",
        modelAllowlist: null,
        limits: {},
        bodyLoggingOptOut: false,
        expiresAt: null,
        guardrailPolicy: null,
        smartRouting: false,
      });
      await store.config.putSettings({ bodyLoggingEnabled: true });
      const log = row("large", Date.now() - 20000, { apiKeyId: keyId });
      await store.usage.begin({ ...log, state: "pending", bodyState: "pending" });
      await store.usage.append({ ...log, bodyState: "pending" });
      // >1MiB of hostile escaped/multibyte JSON, with a real compressible gzip
      // envelope. No parsed client object is built by any export operation.
      let json = JSON.stringify({
        schemaVersion: 1,
        requestId: "large",
        client: {
          request: corpus === "escaping" ? '\u0000"\\😀漢'.repeat(100000) : randomText(),
          response: null,
          truncated: false,
        },
        attempts: [],
        error: null,
      });
      const plain = Buffer.byteLength(json);
      const sealed = await sealArtifactWithGzip(key, json);
      json = "";
      const relPath = relPathFor(log.id, log.at);
      const file = join(bodiesDirFor(path), relPath);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, sealed.bytes);
      expect(
        await store.bodies.publish({
          requestId: log.id,
          at: log.at,
          relPath,
          sizeBytes: sealed.bytes.length,
          sha256: sealed.sha256,
          truncated: false,
          omitted: false,
        }),
      ).toBe(true);
      for (const [id, type] of [
        ["a", "elasticsearch"],
        ["b", "otlp"],
        ["c", "elasticsearch"],
      ] as const)
        await store.exportDestinations.create({
          id,
          type,
          includeBodies: true,
          maxRequestBytes: 32768,
          startFrom: "oldest",
          config:
            type === "otlp"
              ? { endpoint: `${receiver.url}otlp`, signal: "logs" }
              : { url: `${receiver.url}es`, auth: "none" },
        });
      const now = () => Date.now() + 20000;
      reader = openSqliteExportReader(path, key, now);
      const real = reader;
      let envelopeReads = 0;
      let decoding = 0;
      let peakDecoding = 0;
      const originalEnvelope = real.bodyEnvelope;
      real.bodyEnvelope = async (...args) => {
        envelopeReads++;
        return originalEnvelope(...args);
      };
      const originalText = real.bodyText;
      real.bodyText = async (...args) => {
        decoding++;
        peakDecoding = Math.max(peakDecoding, decoding);
        sample("before-decrypt");
        try {
          return await originalText(...args);
        } finally {
          sample("after-decrypt");
          decoding--;
        }
      };
      Bun.gc(true);
      const baseline = process.memoryUsage();
      let peakHeap = baseline.heapUsed;
      let peakExternal = baseline.external;
      let peakLiveWire = 0;
      let sends = 0;
      const samples: Array<{ stage: string; heap: number; external: number; wire: number }> = [];
      const sample = (stage: string, wire = 0) => {
        const m = process.memoryUsage();
        peakHeap = Math.max(peakHeap, m.heapUsed);
        peakExternal = Math.max(peakExternal, m.external);
        peakLiveWire = Math.max(peakLiveWire, wire);
        samples.push({ stage, heap: m.heapUsed, external: m.external, wire });
      };
      const state = openSqliteExportState(join(dir, "export.db"));
      let cancelSent = false;
      loop = createExportLoop({
        open: async () => ({
          reader: real,
          state,
          lease: null,
          close() {
            real.close();
            state.close();
          },
        }),
        transport: async (url, init) => {
          const wire =
            typeof init.body === "string" ? Buffer.byteLength(init.body) : init.body.byteLength;
          sample("transport", wire);
          sends++;
          expect(wire).toBeLessThanOrEqual(32768);
          // Metadata then first body segment. Cancel with two destinations waiting
          // on the same real semaphore; none may acquire/decode after cancellation.
          const response = await httpTransport(url, init);
          if (sends === 2 && !cancelSent) {
            cancelSent = true;
            void loop?.handle({
              type: "gatesChanged",
              gates: { bodyLoggingAllowed: false, bodyLoggingEnabled: false },
            });
          }
          return response;
        },
        now,
        timers: { setTimeout, clearTimeout },
        random: () => 0.5,
        post() {},
        logger: noopLogger,
        nodeId: "probe",
        exportBodiesAllowed: true,
        gates: { bodyLoggingAllowed: true, bodyLoggingEnabled: true },
        bodyBudgetBytes: 192 * 1024 * 1024,
      });
      await loop.start();
      await loop.idle();
      sample("cancelled");
      expect(cancelSent).toBe(true);
      expect(peakDecoding).toBe(1);
      expect(envelopeReads).toBe(1);
      expect((await state.list()).every((s) => s.cursorId === "")).toBe(true);
      const reserved = pipelineReservation(sealed.bytes.length, plain, 32768, 4096);
      expect(reserved).toBeLessThan(192 * 1024 * 1024);
      // This independent runtime measurement can falsify, not prove, the estimate.
      // Resume normal exporting, exercising all three encoders with real gzip and
      // transport buffers, including OTLP's additional JSON quoting.
      await loop.handle({
        type: "gatesChanged",
        gates: { bodyLoggingAllowed: true, bodyLoggingEnabled: true },
      });
      await loop.handle({ type: "destinationsChanged" });
      await loop.idle();
      sample("complete");
      expect(envelopeReads).toBe(4);
      expect((await state.list()).every((s) => s.cursorId === "large")).toBe(true);
      expect(peakDecoding).toBe(1);
      const observedGrowth =
        Math.max(0, peakHeap - baseline.heapUsed) + Math.max(0, peakExternal - baseline.external);
      expect(observedGrowth).toBeLessThan(reserved);
      const evidence = {
        corpus,
        plain,
        envelope: sealed.bytes.length,
        reserved,
        baseline,
        peakHeap,
        peakExternal,
        peakLiveWire,
        observedGrowth,
        sends,
        samples: samples.filter((_, i) => i < 4 || i === samples.length - 1),
      };
      console.log("EXPORT_MEMORY_EVIDENCE", JSON.stringify(evidence));
    } finally {
      await loop?.handle({ type: "stop" });
      reader?.close();
      store.close();
      receiver.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

function randomText(): string {
  const bytes = new Uint8Array(1200000);
  let value = 123456789;
  for (let i = 0; i < bytes.length; i++) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    bytes[i] = value & 255;
  }
  return Buffer.from(bytes).toString("base64");
}
