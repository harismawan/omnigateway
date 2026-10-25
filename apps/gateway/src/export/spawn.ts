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

export function spawnExportWorker(init: WorkerInit): ExportWorker {
  const options: Bun.WorkerOptions & { workerData: WorkerInit } = {
    name: "omni-export",
    workerData: init,
  };
  const worker = new Worker(new URL("./worker.ts", import.meta.url).href, options);
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
