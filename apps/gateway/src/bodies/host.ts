import type { Logger } from "@omni/ir";
import type { BodyRepo } from "@omni/store/types";
import type { CapturedParts } from "../bodyCapture.ts";
import { createWorkerHost, type HostedWorker, type Timers } from "../workerHost/instance.ts";
import type { CaptureBudget } from "./budget.ts";
import {
  BODY_QUEUE_LIMIT,
  BODY_SLICE_BYTES,
  type BodyMeta,
  type MainMessage,
  type WorkerMessage,
} from "./protocol.ts";

export type BodyWriterHost = {
  start(): Promise<void>;
  enqueue(parts: CapturedParts): void;
  isPending(relPath: string): boolean;
  pause(): Promise<void>;
  resume(swapped: boolean): Promise<void>;
  halt(): Promise<void>;
  stop(): void;
  generation(): number;
};
type DropReason = "budget" | "backlog" | "writer_crash" | "restore";
type Entry = { parts: CapturedParts; generation: number; slices: number; path: string | null };
type Deps = {
  spawn(): HostedWorker<MainMessage, WorkerMessage>;
  bodies: Pick<BodyRepo, "publish" | "fail">;
  budget: CaptureBudget;
  logger: Logger;
  now(): number;
  timers: Timers;
  yield?: () => Promise<void>;
  onDropped?: (reason: DropReason) => void;
};

function meta(parts: CapturedParts, generation: number, abandoned = parts.abandoned): BodyMeta {
  return {
    type: "meta",
    requestId: parts.requestId,
    generation,
    at: parts.at,
    error: parts.error,
    client: {
      truncated: parts.client.truncated,
      responseFrames: Array.isArray(parts.client.response),
    },
    attempts: parts.attempts.map((a) => ({
      attempt: a.attempt,
      provider: a.provider,
      truncated: a.truncated,
      streamChunks: a.streamChunks !== null || a.captureStreamChunks === true,
    })),
    abandoned,
  };
}

/** Raw text only; frames are separate parts, never serialized on the request thread. */
function* texts(parts: CapturedParts): Generator<[string, string]> {
  if (parts.client.request !== null) yield ["client.request", parts.client.request];
  if (Array.isArray(parts.client.response)) {
    for (const [i, frame] of parts.client.response.entries()) yield [`client.frame.${i}`, frame];
  } else if (parts.client.response !== null) yield ["client.response", parts.client.response];
  for (const [i, a] of parts.attempts.entries()) {
    if (a.request !== null) yield [`attempt.${i}.request`, a.request];
    if (Array.isArray(a.response)) {
      for (const [j, chunk] of a.response.entries()) yield [`attempt.${i}.chunk.${j}`, chunk];
    } else if (a.response !== null) yield [`attempt.${i}.response`, a.response];
    for (const [j, frame] of (a.streamChunks ?? []).entries())
      yield [`attempt.${i}.frame.${j}`, frame];
  }
}

export function createBodyWriterHost(deps: Deps): BodyWriterHost {
  const entries = new Map<string, Entry>();
  const pending = new Set<string>();
  const queue: Entry[] = [];
  const publications = new Set<Promise<void>>();
  let generation = 0;
  let accepting = true;
  let pumping = false;
  let dropping: DropReason = "writer_crash";
  const yieldTurn = deps.yield ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  function release(entry: Entry): void {
    deps.budget.release(entry.parts.reservedBytes + entry.slices);
    entry.parts.reservedBytes = 0;
    entry.slices = 0;
    entries.delete(entry.parts.requestId);
    entry.parts.client.request = null;
    entry.parts.client.response = null;
    entry.parts.attempts.length = 0;
  }
  function fail(entry: Entry, reason: DropReason): void {
    if (entries.get(entry.parts.requestId) !== entry) return;
    if (entry.path !== null) pending.delete(entry.path);
    release(entry);
    deps.onDropped?.(reason);
    const failure = deps.bodies.fail(entry.parts.requestId).catch(() => {});
    publications.add(failure);
    void failure.finally(() => publications.delete(failure));
  }
  const clear = (reason: DropReason): void => {
    for (const entry of entries.values()) fail(entry, reason);
    queue.length = 0;
  };
  const worker = createWorkerHost<MainMessage, WorkerMessage>({
    ...deps,
    name: "body writer",
    lifecycle: { pause: { type: "pause" }, resume: { type: "resume" }, stop: { type: "stop" } },
    onUnavailable: () => clear(dropping),
    onMessage(message) {
      if (message.type === "paused") return;
      const entry = entries.get(message.requestId);
      if (
        entry === undefined ||
        message.generation !== generation ||
        entry.generation !== generation
      )
        return;
      if (!accepting && message.type !== "slice-ack") return;
      if (message.type === "slice-ack") {
        const bytes = Math.min(entry.slices, message.bytes);
        entry.slices -= bytes;
        deps.budget.release(bytes);
      } else if (message.type === "publishing") {
        entry.path = message.relPath;
        pending.add(message.relPath);
        worker.post({ type: "publish-ok", requestId: message.requestId, relPath: message.relPath });
      } else if (message.type === "written") {
        const publication = (async () => {
          try {
            const accepted = await deps.bodies.publish(message);
            if (entries.get(message.requestId) !== entry || generation !== message.generation)
              return;
            // Refused files remain protected until the worker confirms deletion.
            worker.post({ type: "publish-result", requestId: message.requestId, accepted });
            if (accepted) {
              if (entry.path !== null) pending.delete(entry.path);
              release(entry);
            }
          } catch {
            deps.onDropped?.("writer_crash");
            void deps.bodies.fail(message.requestId).catch(() => {});
            try {
              worker.post({
                type: "publish-result",
                requestId: message.requestId,
                accepted: false,
              });
            } catch {
              fail(entry, "writer_crash");
            }
          }
        })();
        publications.add(publication);
        void publication.finally(() => publications.delete(publication));
      } else if (message.type === "cleaned") {
        if (entry.path !== null) pending.delete(entry.path);
        release(entry);
      } else if (message.type === "write-failed") fail(entry, "writer_crash");
    },
  });

  async function send(entry: Entry): Promise<void> {
    const p = entry.parts;
    if (p.abandoned === null) {
      const encoder = new TextEncoder();
      for (const [part, text] of texts(p)) {
        let offset = 0;
        let seq = 0;
        do {
          if (entries.get(p.requestId) !== entry || !accepting) return;
          // At most 1 MiB of characters inspected/encoded in any one turn.
          let end = Math.min(text.length, offset + BODY_SLICE_BYTES);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
          let chunk = text.slice(offset, end);
          while (Buffer.byteLength(chunk) > BODY_SLICE_BYTES) {
            end = offset + Math.max(1, Math.floor((end - offset) / 2));
            if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
            chunk = text.slice(offset, end);
          }
          const size = Buffer.byteLength(chunk);
          if (!deps.budget.reserve(size)) {
            deps.budget.release(p.reservedBytes);
            p.reservedBytes = 0;
            p.abandoned = "budget";
            p.client.request = null;
            p.client.response = null;
            for (const a of p.attempts) {
              a.request = null;
              a.response = null;
              a.streamChunks = null;
            }
            deps.onDropped?.("budget");
            worker.post(meta(p, entry.generation));
            return;
          }
          entry.slices += size;
          const bytes = encoder.encode(chunk).buffer;
          worker.post({
            type: "part",
            requestId: p.requestId,
            generation: entry.generation,
            part,
            seq: seq++,
            last: end === text.length,
            bytes,
          });
          offset = end;
          await yieldTurn();
        } while (offset < text.length);
      }
    }
    if (entries.get(p.requestId) === entry && accepting) worker.post(meta(p, entry.generation));
  }
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && accepting) {
        const entry = queue.shift();
        if (entry === undefined || entries.get(entry.parts.requestId) !== entry) continue;
        try {
          await send(entry);
        } catch {
          fail(entry, "writer_crash");
        }
      }
    } finally {
      pumping = false;
    }
  }
  return {
    start: () => worker.start(),
    enqueue(parts) {
      if (entries.has(parts.requestId)) {
        deps.budget.release(parts.reservedBytes);
        return;
      }
      const entry: Entry = { parts, generation, slices: 0, path: null };
      entries.set(parts.requestId, entry);
      if (!accepting) {
        fail(entry, "restore");
        return;
      }
      if (worker.state() !== "running") {
        fail(entry, "writer_crash");
        return;
      }
      if (entries.size > BODY_QUEUE_LIMIT) {
        deps.budget.release(parts.reservedBytes);
        parts.reservedBytes = 0;
        parts.client.request = null;
        parts.client.response = null;
        for (const a of parts.attempts) {
          a.request = null;
          a.response = null;
          a.streamChunks = null;
        }
        deps.onDropped?.("backlog");
        void Promise.resolve().then(() => {
          if (entries.get(parts.requestId) !== entry) return;
          try {
            worker.post({ ...meta(parts, entry.generation), abandoned: "backlog" });
          } catch {
            fail(entry, "writer_crash");
          }
        });
        return;
      }
      queue.push(entry);
      // No encoding, parsing, or worker messaging on the request's stack.
      void Promise.resolve().then(pump);
    },
    isPending: (path) => pending.has(path),
    async pause() {
      accepting = false;
      dropping = "restore";
      // Finish any main-connection publication before pause can delete a file
      // whose accepted result is still travelling back to the worker.
      await Promise.all(publications);
      await worker.pause((m) => m.type === "paused");
      clear("restore");
      await Promise.all(publications);
    },
    async resume(swapped) {
      if (swapped) generation++;
      await worker.resume(swapped);
      accepting = true;
      dropping = "writer_crash";
    },
    async halt() {
      accepting = false;
      clear("restore");
      await worker.halt();
    },
    stop() {
      accepting = false;
      worker.stop();
    },
    generation: () => generation,
  };
}
