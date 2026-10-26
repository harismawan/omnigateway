import { afterEach, expect, test } from "bun:test";
import { spawnExportWorker } from "../../src/export/spawn.ts";

/**
 * `onExit` means the thread has exited. Bun reports an uncaught exception on
 * `error` before the thread unwinds, and `terminate()` returns while a native
 * call runs on; only `close` is the exit. A restore swaps the file once this
 * fires, so an early notification would swap under a live handle.
 */

const RealWorker = globalThis.Worker;
afterEach(() => {
  globalThis.Worker = RealWorker;
});

class FakeThread extends EventTarget {
  static last: FakeThread | null = null;
  terminated = false;
  constructor() {
    super();
    FakeThread.last = this;
  }
  postMessage(): void {}
  terminate(): void {
    // Returns at once; the thread exits later.
    this.terminated = true;
  }
}

test("onExit fires once on close, never on error or on terminate returning", () => {
  globalThis.Worker = FakeThread as unknown as typeof Worker;
  const worker = spawnExportWorker({
    databasePath: "/nowhere.db",
    databaseUrl: null,
    encryptionKey: "k".repeat(32),
    redisUrl: null,
    nodeId: "n",
    logLevel: "error",
    exportBodiesAllowed: false,
    gates: { bodyLoggingAllowed: false },
  });
  let exits = 0;
  worker.onExit(() => {
    exits += 1;
  });
  const thread = FakeThread.last as FakeThread;
  thread.dispatchEvent(new Event("error"));
  worker.terminate();
  expect(thread.terminated).toBe(true);
  expect(exits).toBe(0);
  thread.dispatchEvent(new Event("close"));
  thread.dispatchEvent(new Event("close"));
  expect(exits).toBe(1);
});
