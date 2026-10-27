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
  enqueue(parts: CapturedParts, generation?: number): void;
  isPending(relPath: string): boolean;
  pause(): Promise<void>;
  resume(swapped: boolean): Promise<void>;
  halt(): Promise<void>;
  stop(): void;
  /** Five-second writer grace; main database operations settle before return. */
  drain(): Promise<void>;
  generation(): number;
};
type DropReason = "budget" | "backlog" | "writer_crash" | "restore";
type Entry = {
  parts: CapturedParts;
  generation: number;
  slices: number;
  path: string | null;
  publishing: boolean;
};
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
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let changed = () => {};
  let pumping = false;
  let failing = false;
  let dropping: DropReason = "writer_crash";
  const yieldTurn = deps.yield ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  function discard(parts: CapturedParts): void {
    deps.budget.release(parts.reservedBytes);
    parts.reservedBytes = 0;
    parts.client.request = null;
    parts.client.response = null;
    parts.attempts.length = 0;
    parts.error = null;
  }
  function release(entry: Entry): void {
    deps.budget.release(entry.slices);
    discard(entry.parts);
    entry.slices = 0;
    entries.delete(entry.parts.requestId);
    changed();
  }
  /** One failure write, no waiting ids: a blocked store must not become a queue. */
  function failPending(requestId: string): void {
    if (failing) return;
    failing = true;
    const failure = Promise.resolve()
      .then(() => deps.bodies.fail(requestId))
      .catch(() => {});
    publications.add(failure);
    void failure.finally(() => {
      failing = false;
      publications.delete(failure);
      changed();
    });
  }
  function fail(entry: Entry, reason: DropReason, record = true): void {
    if (entries.get(entry.parts.requestId) !== entry) return;
    if (entry.path !== null) pending.delete(entry.path);
    release(entry);
    deps.onDropped?.(reason);
    if (record) failPending(entry.parts.requestId);
  }
  const clear = (reason: DropReason, record = true): void => {
    for (const entry of entries.values()) {
      // Unknown publication decisions are not refusals: preserve owner bytes
      // and sweep protection until actual thread close, without failing its row.
      if (entry.publishing) {
        deps.onDropped?.(reason);
        release(entry);
      } else fail(entry, reason, record);
    }
    queue.length = 0;
  };
  const worker = createWorkerHost<MainMessage, WorkerMessage>({
    ...deps,
    name: "body writer",
    lifecycle: { pause: { type: "pause" }, resume: { type: "resume" }, stop: { type: "stop" } },
    onUnavailable: () => clear(dropping),
    onExit: () => pending.clear(),
    onMessage(message) {
      if (message.type === "paused") return;
      const entry = entries.get(message.requestId);
      if (
        entry === undefined ||
        message.generation !== generation ||
        entry.generation !== generation
      )
        return;
      // Closing admission must not suppress confirmed disposal from the live
      // worker while pause settles publications. Retired-instance replies are
      // fenced by the generic host, so unknown owners still wait for close.
      if (
        !accepting &&
        message.type !== "slice-ack" &&
        message.type !== "cleaned" &&
        message.type !== "discarded" &&
        message.type !== "unowned"
      )
        return;
      if (message.type === "slice-ack") {
        const bytes = Math.min(entry.slices, message.bytes);
        entry.slices -= bytes;
        deps.budget.release(bytes);
      } else if (message.type === "publishing") {
        entry.path = message.relPath;
        pending.add(message.relPath);
        worker.post({ type: "publish-ok", requestId: message.requestId, relPath: message.relPath });
      } else if (message.type === "written") {
        entry.publishing = true;
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
            // A rejection is not proof that the transaction did not commit.
            // Keep the final file; only a definite false authorizes unlink.
            failPending(message.requestId);
            worker.stop();
          }
        })();
        publications.add(publication);
        void publication.finally(() => {
          publications.delete(publication);
          changed();
        });
      } else if (message.type === "discarded") {
        deps.budget.release(entry.parts.reservedBytes);
        entry.parts.reservedBytes = 0;
      } else if (message.type === "unowned") {
        release(entry);
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
    enqueue(parts, capturedGeneration = parts.generation ?? generation) {
      // A background collector may settle after reopen. Never fail or publish
      // its id in the new database, even if the restored snapshot reused it.
      if (capturedGeneration !== generation) {
        discard(parts);
        deps.onDropped?.("restore");
        return;
      }
      if (entries.has(parts.requestId)) {
        discard(parts);
        return;
      }
      const reason =
        !accepting || draining
          ? dropping
          : worker.state() !== "running"
            ? "writer_crash"
            : entries.size >= BODY_QUEUE_LIMIT
              ? "backlog"
              : null;
      if (reason !== null) {
        discard(parts);
        deps.onDropped?.(reason);
        // Hard admission bound wins over an omission artifact per rejected id.
        // If this slot is busy, sweepPending eventually fails the stale row.
        if (accepting) failPending(parts.requestId);
        return;
      }
      const entry: Entry = { parts, generation, slices: 0, path: null, publishing: false };
      entries.set(parts.requestId, entry);
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
      // At most 1000 admitted entries; serialize their failure writes without
      // creating an overflow-id queue. All finish against the original DB.
      for (const entry of entries.values()) {
        if (!entry.publishing) await deps.bodies.fail(entry.parts.requestId).catch(() => {});
      }
      await worker.pause((m) => m.type === "paused");
      clear("restore", false);
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
    drain() {
      if (drainPromise !== undefined) return drainPromise;
      draining = true;
      dropping = "writer_crash";
      drainPromise = (async () => {
        let timer: unknown;
        await new Promise<void>((resolve) => {
          changed = () => {
            if (entries.size === 0 && publications.size === 0) resolve();
          };
          timer = deps.timers.setTimeout(() => {
            accepting = false;
            worker.stop(true);
            resolve();
          }, 5000);
          changed();
        });
        deps.timers.clearTimeout(timer);
        accepting = false;
        worker.stop();
        // The worker budget does not authorize closing the main connection
        // underneath a commit (including an ambiguous post-commit rejection).
        while (publications.size > 0) await Promise.all(publications);
        changed = () => {};
      })();
      return drainPromise;
    },
    generation: () => generation,
  };
}
