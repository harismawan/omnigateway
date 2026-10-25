import type { MainMessage, WorkerInit, WorkerMessage } from "./protocol.ts";

/**
 * Starts the export worker. The main thread's one way in: it imports this and
 * `protocol.ts`, never the worker's modules (`boundary.test.ts` pins that).
 *
 * `workerData` is how the init reaches the worker (Bun's `WorkerOptions` type
 * does not declare it, though Bun honours it). The worker answers on
 * `message` with {@link WorkerMessage}s, dies on `error`/`close`, and exits by
 * itself after `stop`.
 */
export type ExportWorker = {
  post(message: MainMessage): void;
  onMessage(listener: (message: WorkerMessage) => void): void;
  /** Fires once when the worker is gone, whether it exited, crashed or was terminated. */
  onExit(listener: () => void): void;
  terminate(): void;
};

/**
 * Where the worker entry is in a build, relative to the bundled gateway:
 * substituted by `scripts/build-npm.ts` (a sibling `export-worker.js`) and
 * `scripts/build-binary.ts` (the entry's path inside the compiled
 * executable, which lists it as a second entrypoint). Undefined when running
 * from source, where the entry sits beside this file.
 */
declare const OMNI_EXPORT_WORKER: string | undefined;

/** The worker entry's URL, for this build. */
function exportWorkerUrl(): string {
  const entry = typeof OMNI_EXPORT_WORKER === "string" ? OMNI_EXPORT_WORKER : "./worker.ts";
  return new URL(entry, import.meta.url).href;
}

export function spawnExportWorker(init: WorkerInit): ExportWorker {
  const options: Bun.WorkerOptions & { workerData: WorkerInit } = {
    name: "omni-export",
    workerData: init,
  };
  const worker = new Worker(exportWorkerUrl(), options);
  return {
    post: (message) => worker.postMessage(message),
    onMessage(listener) {
      worker.addEventListener("message", (event) => listener(event.data as WorkerMessage));
    },
    onExit(listener) {
      let fired = false;
      const once = (): void => {
        if (fired) return;
        fired = true;
        listener();
      };
      worker.addEventListener("close", once);
      worker.addEventListener("error", once);
    },
    terminate: () => worker.terminate(),
  };
}
