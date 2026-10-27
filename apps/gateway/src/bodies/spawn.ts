import type { HostedWorker } from "../workerHost/instance.ts";
import type { BodyWriterInit, MainMessage, WorkerMessage } from "./protocol.ts";

declare const OMNI_BODY_WORKER: string | undefined;

export function spawnBodyWriter(init: BodyWriterInit): HostedWorker<MainMessage, WorkerMessage> {
  const entry = typeof OMNI_BODY_WORKER === "string" ? OMNI_BODY_WORKER : "./writer.ts";
  const options: Bun.WorkerOptions & { workerData: BodyWriterInit } = {
    name: "omni-bodies",
    workerData: init,
  };
  const worker = new Worker(new URL(entry, import.meta.url).href, options);
  return {
    post: (message) => worker.postMessage(message, message.type === "part" ? [message.bytes] : []),
    onMessage: (listener) =>
      worker.addEventListener("message", (event) => listener(event.data as WorkerMessage)),
    // Only actual thread close confirms the writer is no longer touching files.
    onExit: (listener) => worker.addEventListener("close", listener, { once: true }),
    terminate: () => worker.terminate(),
  };
}
